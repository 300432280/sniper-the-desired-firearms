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
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-blink-features=AutomationControlled',
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
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'en-CA',
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  try {
    // Block unnecessary resources to speed up page load
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
        return route.abort();
      }
      return route.continue();
    });

    // Use 'domcontentloaded' instead of 'networkidle' to avoid timeouts
    // on sites with persistent connections (Klevu, analytics, etc.)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });

    // Handle Incapsula/Imperva WAF challenges — they serve an iframe that runs JS,
    // sets cookies, then redirects. Wait for the challenge to resolve.
    let initialContent = await page.content();
    if (initialContent.includes('_Incapsula_Resource') || initialContent.includes('Incapsula incident')) {
      console.log('[Playwright] Detected Incapsula challenge, waiting for resolution...');
      // Wait for the challenge JS to run, set cookies, and reload the page with actual content
      await page.waitForFunction(
        `!document.documentElement.innerHTML.includes('_Incapsula_Resource')`,
        { timeout: 20000 }
      ).catch(() => {});
      // After challenge resolves, wait for the actual page to fully load
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }

    // Wait for JS to render search results — either a specific selector or a general timeout
    if (options.waitForSelector) {
      await page.waitForSelector(options.waitForSelector, { timeout: 10000 }).catch(() => {});
    } else {
      // Wait for network to settle (at most 5 seconds of no new requests)
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    }

    // Extra wait for JS rendering to fully settle
    await page.waitForTimeout(3000);

    const html = await page.content();
    const responseTimeMs = Date.now() - startTime;

    return { html, responseTimeMs };
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
