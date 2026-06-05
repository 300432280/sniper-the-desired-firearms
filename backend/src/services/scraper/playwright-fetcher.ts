/**
 * Playwright-based fetcher for JavaScript-rendered sites.
 *
 * Uses a shared browser instance (lazy-launched, auto-closed after idle timeout)
 * to render pages that can't be scraped with static HTTP requests.
 *
 * Sites are flagged as needing JS rendering via MonitoredSite.siteType = 'js-rendered'
 * or when the HTML response is suspiciously small (< 2KB).
 */

import type { Browser, Page } from 'playwright-core';
import { isCfInterstitial } from './cf-interstitial';

export const PLAYWRIGHT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Resolve the UA to use for a given URL, honoring siteProfile.userAgentOverride.
 * Dynamic require avoids circular deps with adapter-registry.
 */
function resolvePlaywrightUa(url: string): string {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { _getSiteCacheEntry } = require('./adapter-registry');
    const entry = _getSiteCacheEntry?.(hostname);
    const override = entry?.siteProfile?.userAgentOverride;
    if (override && typeof override === 'string' && override.length > 0) return override;
  } catch { /* fall through */ }
  return PLAYWRIGHT_UA;
}

// ── Playwright concurrency semaphore ─────────────────────────────────────────
// Caps the number of concurrent Playwright fetches to prevent memory exhaustion
// when many BullMQ jobs hit the Playwright fallback path simultaneously.
const PLAYWRIGHT_MAX_CONCURRENCY = 3;
let _semRunning = 0;
const _semQueue: Array<() => void> = [];

function _semAcquire(url: string): Promise<void> {
  if (_semRunning < PLAYWRIGHT_MAX_CONCURRENCY) {
    _semRunning++;
    return Promise.resolve();
  }
  console.log(`[Playwright] concurrency cap reached (${_semRunning} running), queuing ${url}`);
  return new Promise<void>((resolve) => {
    _semQueue.push(resolve);
  });
}

function _semRelease(): void {
  const next = _semQueue.shift();
  if (next) {
    // Hand the slot directly to the next waiter (running count unchanged)
    next();
  } else {
    _semRunning--;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

let browser: Browser | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // Close browser after 5 min idle

export async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) {
    resetIdleTimer();
    return browser;
  }

  try {
    // Use playwright (full) which includes browser binaries
    const pw = await import('playwright');
    browser = await pw.chromium.launch({
      headless: true,
      channel: 'chromium',  // Use regular Chromium headless (no visible window on Windows)
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-blink-features=AutomationControlled',
        // Additional stealth flags
        '--disable-features=IsolateOrigins,site-per-process',
        '--flag-switches-begin',
        '--flag-switches-end',
        // Prevent window from appearing on Windows
        '--window-position=-32000,-32000',
      ],
    });
    console.log('[Playwright] Browser launched');
    resetIdleTimer();
    return browser;
  } catch (err) {
    console.error('[Playwright] Failed to launch browser:', err instanceof Error ? err.message : err);
    throw new Error('Playwright browser launch failed');
  }
}

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (browser?.isConnected()) {
      await browser.close().catch(() => {});
      browser = null;
      console.log('[Playwright] Browser closed (idle timeout)');
    }
  }, IDLE_TIMEOUT_MS);
}

export interface PlaywrightFetchResult {
  html: string;
  responseTimeMs: number;
  /** Solved WAF cookies as a Cookie header string, if any were captured. */
  cookies?: string;
  /**
   * Final URL after browser-following of 301/302/JS redirects. Differs from the
   * requested URL when the site redirected (e.g. Shopify delisted product →
   * storefront homepage). Used by product-verifier to detect "302 → home"
   * zombies that look like successful page loads.
   */
  resolvedUrl?: string;
}

/** Safely get page content, retrying if the page is mid-navigation */
async function safeGetContent(page: Page, maxRetries = 3): Promise<string> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await page.content();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('navigating') || msg.includes('changing the content')) {
        // Page is mid-redirect — wait for navigation to finish and retry
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(2000);
        continue;
      }
      throw err; // Re-throw non-navigation errors
    }
  }
  // Final attempt without catching
  return await page.content();
}

/**
 * Parse a cookie header string ("name=val; name2=val2") into Playwright's
 * cookie format, scoped to the URL's domain + path. Used to inject pre-solved
 * WAF cookies from Redis cache.
 */
function parseCookieHeader(cookieHeader: string, url: string): Array<{
  name: string; value: string; domain: string; path: string;
}> {
  let host: string;
  try { host = new URL(url).hostname; } catch { return []; }
  const out: Array<{ name: string; value: string; domain: string; path: string }> = [];
  for (const pair of cookieHeader.split(/;\s*/)) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) continue;
    out.push({ name, value, domain: host, path: '/' });
  }
  return out;
}

/**
 * Fetch a page using a headless browser.
 * Waits for network idle (no requests for 500ms) then returns the rendered HTML.
 *
 * At most PLAYWRIGHT_MAX_CONCURRENCY fetches run simultaneously; excess calls
 * queue and are admitted as slots free (semaphore above).
 */
export async function fetchWithPlaywright(
  url: string,
  options: { timeout?: number; waitForSelector?: string; userAgent?: string; cookies?: string } = {}
): Promise<PlaywrightFetchResult> {
  await _semAcquire(url);
  try {
    return await _fetchWithPlaywrightInner(url, options);
  } finally {
    _semRelease();
  }
}

async function _fetchWithPlaywrightInner(
  url: string,
  options: { timeout?: number; waitForSelector?: string; userAgent?: string; cookies?: string } = {}
): Promise<PlaywrightFetchResult> {
  const timeout = options.timeout ?? 30000;
  const startTime = Date.now();
  const ua = options.userAgent || resolvePlaywrightUa(url);
  const isIphone = /iPhone/i.test(ua);

  const b = await getBrowser();
  const context = await b.newContext({
    userAgent: ua,
    locale: 'en-CA',
    viewport: isIphone ? { width: 390, height: 844 } : { width: 1366, height: 768 },
    // Stealth: set common browser properties
    extraHTTPHeaders: {
      'Accept-Language': 'en-CA,en;q=0.9',
      ...(isIphone ? {} : {
        'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
      }),
    },
  });

  // Inject pre-solved WAF cookies if provided (skips re-solving sgcaptcha/Sucuri/Incapsula PoW)
  if (options.cookies) {
    const parsed = parseCookieHeader(options.cookies, url);
    if (parsed.length > 0) await context.addCookies(parsed);
  }

  const page = await context.newPage();

  try {
    // Stealth: override navigator.webdriver and other automation indicators
    // Passed as string to execute in browser context (avoids TS DOM type errors)
    await page.addInitScript(`
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-CA', 'en'] });
      window.chrome = { runtime: {} };
    `);

    // Block heavy resources but NOT stylesheets (needed for Cloudflare challenge)
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'font', 'media'].includes(type)) {
        return route.abort();
      }
      return route.continue();
    });

    // Navigate — use 'commit' to not wait for full load (handles CF redirect loops)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout }).catch(async (err) => {
      // If navigation times out, the page might still have loaded partially
      const msg = err instanceof Error ? err.message : '';
      if (!msg.includes('Timeout')) throw err;
      console.log(`[Playwright] Navigation timeout for ${url}, continuing with partial content`);
    });

    // Get initial content safely (handles mid-navigation state)
    let initialContent = await safeGetContent(page);

    // ── Incapsula/Imperva WAF ──────────────────────────────────────────────
    if (initialContent.includes('_Incapsula_Resource') || initialContent.includes('Incapsula incident')) {
      console.log('[Playwright] Detected Incapsula challenge, waiting for resolution...');
      await page.waitForFunction(
        `!document.documentElement.innerHTML.includes('_Incapsula_Resource')`,
        { timeout: 20000 }
      ).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);
      initialContent = await safeGetContent(page);
    }

    // ── Cloudflare challenge (IUAM / turnstile / managed challenge) ────────
    // NOTE: the `challenge-platform` beacon (cdn-cgi/challenge-platform/...) is
    // embedded on EVERY page of a passive-CF site, not just interstitials, so it
    // is NOT a challenge signal. isCfInterstitial keys only on true block-page
    // markers.
    const isCfChallenge = isCfInterstitial(initialContent);

    if (isCfChallenge) {
      console.log(`[Playwright] Detected Cloudflare challenge (${initialContent.length}b), waiting for resolution...`);

      // Strategy 1: Wait for the challenge to auto-resolve via JS
      // Cloudflare JS challenges resolve in 3-8s; turnstile can take 15-20s
      const resolved = await page.waitForFunction(
        `(() => {
          const text = document.body?.innerText || '';
          const html = document.documentElement?.innerHTML || '';
          // Resolved when the true INTERSTITIAL markers are gone. We deliberately
          // do NOT key off 'challenge-platform' — that beacon is present on every
          // page of a passive-CF site, so requiring its absence would mean the
          // challenge never reports as resolved (returns empty/challenge HTML → 0
          // products). Interstitial markers below ONLY appear on the block page.
          return !text.includes('Just a moment') &&
                 !text.includes('Checking your browser') &&
                 !text.includes('Verifying you are human') &&
                 !text.includes('Attention Required') &&
                 !html.includes('_cf_chl_opt') &&
                 !html.includes('challenges.cloudflare.com/turnstile') &&
                 !document.querySelector('#cf-browser-verification') &&
                 !document.querySelector('#challenge-running') &&
                 !document.querySelector('#challenge-form') &&
                 // Also check that we have real content (not an empty shell)
                 html.length > 5000;
        })()`,
        { timeout: 35000 }
      ).catch(() => null);

      if (resolved) {
        console.log('[Playwright] Cloudflare challenge resolved');
      } else {
        console.log('[Playwright] Cloudflare challenge did not auto-resolve within 35s');
        // Strategy 2: Wait for any navigation that happens after challenge
        await page.waitForNavigation({ timeout: 10000, waitUntil: 'domcontentloaded' }).catch(() => {});
      }

      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(2000);
      initialContent = await safeGetContent(page);

      // If still on a challenge page, try one more wait
      if (initialContent.length < 5000 &&
          (initialContent.includes('cloudflare') || initialContent.includes('challenge'))) {
        console.log('[Playwright] Still on challenge page, waiting longer...');
        await page.waitForTimeout(10000);
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        initialContent = await safeGetContent(page);
      }
    }

    // ── SiteGround sgcaptcha PoW ─────────────────────────────────────────
    // sgcaptcha does a meta-refresh to /.well-known/sgcaptcha/ which runs
    // SHA1 PoW in web workers (~3s), then POSTs solution and redirects back.
    // The page URL stays on /.well-known/sgcaptcha/ during PoW; we poll
    // page.url() until it leaves that path (same pattern as production
    // waf-cookie-manager.ts:120-126, Mistake 30).
    if (initialContent.includes('sgcaptcha') || initialContent.includes('.well-known/sgcaptcha')) {
      console.log('[Playwright] Detected sgcaptcha challenge, waiting for PoW resolution...');
      const sgStart = Date.now();
      while (Date.now() - sgStart < 20000) {
        const curUrl = page.url();
        if (!curUrl.includes('/.well-known/sgcaptcha/')) break;
        await page.waitForTimeout(500);
      }
      await page.waitForTimeout(2000);
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      initialContent = await safeGetContent(page);
    }

    // ── Sucuri WAF ──────────────────────────────────────────────────────────
    if (initialContent.includes('sucuri.net') || initialContent.includes('Access Denied - Sucuri')) {
      console.log('[Playwright] Detected Sucuri WAF, waiting for resolution...');
      await page.waitForFunction(
        `!document.documentElement.innerHTML.includes('sucuri.net')`,
        { timeout: 20000 }
      ).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }

    // ── Wait for JS to render content ────────────────────────────────────────
    if (options.waitForSelector) {
      await page.waitForSelector(options.waitForSelector, { timeout: 10000 }).catch(() => {});
    } else {
      // Wait for network to settle (at most 5 seconds of no new requests)
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    }

    // Extra wait for JS rendering to fully settle
    await page.waitForTimeout(3000);

    const html = await safeGetContent(page);
    const responseTimeMs = Date.now() - startTime;

    // Capture the post-redirect URL while the page is still open. After all
    // 301/302/JS redirects resolve, `page.url()` reflects whatever location
    // the browser actually landed on (e.g. Shopify storefront homepage when
    // a delisted product 302s). Best-effort: fall back to the request URL.
    let resolvedUrl: string | undefined;
    try { resolvedUrl = page.url() || url; } catch { resolvedUrl = url; }

    // Capture cookies from the browser context before closing. These are the
    // WAF-solved session cookies (Sucuri, sgcaptcha, CF clearance, etc.) that
    // can be replayed in subsequent axios calls to the same domain.
    let cookies: string | undefined;
    try {
      const origin = new URL(url).origin;
      const browserCookies = await context.cookies(origin);
      if (browserCookies.length > 0) {
        cookies = browserCookies.map(c => `${c.name}=${c.value}`).join('; ');
      }
    } catch { /* cookie extraction is best-effort */ }

    return { html, responseTimeMs, cookies, resolvedUrl };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

/**
 * Fetch a page and paginate through JS-based pagination (e.g. Klevu overlay).
 * Returns an array of HTML snapshots — one per page.
 * Unlike fetchWithPlaywright (which closes the page immediately), this keeps
 * the page open to click pagination links that update content via AJAX.
 */
export async function fetchWithPlaywrightPaginated(
  url: string,
  options: {
    timeout?: number;
    maxPages?: number;
    /** CSS selector for the "next page" clickable element */
    nextPageSelector?: string;
  } = {}
): Promise<{ pages: string[]; responseTimeMs: number }> {
  const timeout = options.timeout ?? 30000;
  const maxPages = options.maxPages ?? 3;
  const startTime = Date.now();

  const b = await getBrowser();
  const context = await b.newContext({
    userAgent: resolvePlaywrightUa(url),
    locale: 'en-CA',
    viewport: { width: 1366, height: 768 },
    extraHTTPHeaders: {
      'Accept-Language': 'en-CA,en;q=0.9',
      'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    },
  });

  const page = await context.newPage();
  const pages: string[] = [];

  try {
    await page.addInitScript(`
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-CA', 'en'] });
      window.chrome = { runtime: {} };
    `);

    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'font', 'media'].includes(type)) return route.abort();
      return route.continue();
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout }).catch(async (err) => {
      const msg = err instanceof Error ? err.message : '';
      if (!msg.includes('Timeout')) throw err;
    });

    // Handle WAF challenges (same as fetchWithPlaywright)
    let content = await safeGetContent(page);
    if (content.includes('_Incapsula_Resource') || content.includes('Incapsula incident')) {
      await page.waitForFunction(
        `!document.documentElement.innerHTML.includes('_Incapsula_Resource')`,
        { timeout: 20000 }
      ).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }

    // Wait for JS rendering
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // Capture page 1
    pages.push(await safeGetContent(page));

    // Paginate through subsequent pages
    // Try Klevu pagination first, then generic next-page selectors
    const paginationSelectors = [
      options.nextPageSelector,
      'a.klevuPaginate[data-offset]',         // Klevu JS overlay
      '.kuPagination a:not(.kuCurrent)',       // Klevu alternative
    ].filter(Boolean) as string[];

    // Track visited Klevu offsets to avoid cycling back to page 1
    const visitedOffsets = new Set<string>(['0']); // page 1 = offset 0

    for (let pageNum = 2; pageNum <= maxPages; pageNum++) {
      let clicked = false;

      for (const selector of paginationSelectors) {
        // Find all matching pagination links
        const links = await page.$$(selector);
        if (links.length === 0) continue;

        // Find the first unvisited link (by data-offset for Klevu, or any for generic)
        for (const link of links) {
          const offset = await link.getAttribute('data-offset');
          // Skip if we've already visited this offset (prevents cycling)
          if (offset !== null && visitedOffsets.has(offset)) continue;

          try {
            if (offset !== null) visitedOffsets.add(offset);
            await link.click();
            clicked = true;

            // Wait for AJAX content update
            await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
            await page.waitForTimeout(2000);

            pages.push(await safeGetContent(page));
            console.log(`[Playwright] Paginated to page ${pageNum}${offset ? ` (offset ${offset})` : ''}`);
            break;
          } catch {
            // Click failed, try next link
          }
        }

        if (clicked) break;
      }

      if (!clicked) break;
    }

    const responseTimeMs = Date.now() - startTime;
    return { pages, responseTimeMs };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

/**
 * Close the shared browser instance (call on server shutdown).
 */
export async function closeBrowser(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  if (browser?.isConnected()) {
    await browser.close().catch(() => {});
    browser = null;
    console.log('[Playwright] Browser closed (shutdown)');
  }
}
