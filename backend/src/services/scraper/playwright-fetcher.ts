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

let browser: Browser | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // Close browser after 5 min idle

async function getBrowser(): Promise<Browser> {
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
 * Fetch a page using a headless browser.
 * Waits for network idle (no requests for 500ms) then returns the rendered HTML.
 */
export async function fetchWithPlaywright(
  url: string,
  options: { timeout?: number; waitForSelector?: string } = {}
): Promise<PlaywrightFetchResult> {
  const timeout = options.timeout ?? 30000;
  const startTime = Date.now();

  const b = await getBrowser();
  const context = await b.newContext({
    // Use a recent, realistic Chrome user agent
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-CA',
    viewport: { width: 1366, height: 768 },
    // Stealth: set common browser properties
    extraHTTPHeaders: {
      'Accept-Language': 'en-CA,en;q=0.9',
      'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    },
  });

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
    const isCfChallenge =
      initialContent.includes('cf-browser-verification') ||
      initialContent.includes('Just a moment...') ||
      initialContent.includes('challenge-platform') ||
      initialContent.includes('Checking your browser') ||
      initialContent.includes('cf-challenge') ||
      initialContent.includes('_cf_chl') ||
      initialContent.includes('Attention Required') ||
      initialContent.includes('Verifying you are human') ||
      // Detect minimal CF challenge pages (tiny HTML with cloudflare references)
      (initialContent.length < 5000 && initialContent.includes('cloudflare'));

    if (isCfChallenge) {
      console.log(`[Playwright] Detected Cloudflare challenge (${initialContent.length}b), waiting for resolution...`);

      // Strategy 1: Wait for the challenge to auto-resolve via JS
      // Cloudflare JS challenges resolve in 3-8s; turnstile can take 15-20s
      const resolved = await page.waitForFunction(
        `(() => {
          const text = document.body?.innerText || '';
          const html = document.documentElement?.innerHTML || '';
          // Challenge is resolved when these indicators disappear
          return !text.includes('Just a moment') &&
                 !text.includes('Checking your browser') &&
                 !text.includes('Verifying you are human') &&
                 !text.includes('Attention Required') &&
                 !document.querySelector('#cf-browser-verification') &&
                 !document.querySelector('#challenge-running') &&
                 !document.querySelector('#challenge-form') &&
                 !html.includes('challenge-platform') &&
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

    return { html, responseTimeMs };
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
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
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
