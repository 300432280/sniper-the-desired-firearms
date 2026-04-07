/**
 * WAF Cookie Manager — Playwright-based cookie acquisition for Sucuri WAF bypass.
 *
 * Sucuri WAF blocks direct HTTP to WooCommerce APIs (307 redirect).
 * Playwright solves the JS challenge once, and the session cookies are cached
 * in Redis for fast API access. Cookies are shared across all tiers/workers.
 *
 * Key behaviors:
 * - One Playwright solve per domain per ~90 minutes (actual TTL is 24h, we refresh conservatively)
 * - Redis mutex prevents concurrent solves for the same domain
 * - UA fingerprint stored alongside cookies (Sucuri validates UA match)
 * - Fallback: if cookies fail after retries, caller falls back to Playwright HTML
 */

import axios from 'axios';
import { redisConnection } from '../queue';
import { PLAYWRIGHT_UA } from './playwright-fetcher';

/**
 * Resolve the UA to use for a domain, honoring siteProfile.userAgentOverride.
 * Dynamic require avoids circular deps with adapter-registry.
 */
function resolveWafUa(domain: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { _getSiteCacheEntry } = require('./adapter-registry');
    const bare = domain.replace(/^www\./, '');
    const entry = _getSiteCacheEntry?.(bare);
    const override = entry?.siteProfile?.userAgentOverride;
    if (override && typeof override === 'string' && override.length > 0) return override;
  } catch { /* fall through */ }
  return PLAYWRIGHT_UA;
}

const COOKIE_TTL_MS = 90 * 60 * 1000;        // 90 minutes (conservative; real Sucuri TTL is 24h)
const MUTEX_TTL_SECONDS = 45;                  // Max time to hold the solve lock
const MUTEX_WAIT_MS = 2000;                    // Poll interval while waiting for another solver
const MUTEX_WAIT_MAX_MS = 45000;               // Max wait for another solver
const MAX_FAILURES_BEFORE_REFRESH = 2;         // Refresh cookies after this many consecutive failures

interface CookieEntry {
  cookies: string;
  userAgent: string;
  acquiredAt: number;
  failureCount: number;
}

function redisKey(domain: string): string {
  return `waf-cookie:${domain}`;
}

function mutexKey(domain: string): string {
  return `waf-cookie-lock:${domain}`;
}

/**
 * Get cached cookies for a domain. Returns null if expired or not cached.
 */
export async function getCookies(domain: string): Promise<{ cookies: string; userAgent: string } | null> {
  try {
    const raw = await redisConnection.get(redisKey(domain));
    if (!raw) return null;

    const entry: CookieEntry = JSON.parse(raw);
    const age = Date.now() - entry.acquiredAt;
    if (age > COOKIE_TTL_MS) return null;
    if (entry.failureCount >= MAX_FAILURES_BEFORE_REFRESH) return null;

    return { cookies: entry.cookies, userAgent: entry.userAgent };
  } catch {
    return null;
  }
}

/**
 * Solve the Sucuri challenge via Playwright and cache cookies in Redis.
 * Uses a mutex to prevent concurrent solves for the same domain.
 */
export async function solveCookies(domain: string, url: string): Promise<{ cookies: string; userAgent: string }> {
  const lockKey = mutexKey(domain);

  // Try to acquire mutex
  const acquired = await redisConnection.set(lockKey, process.pid.toString(), 'EX', MUTEX_TTL_SECONDS, 'NX');

  if (!acquired) {
    // Another worker is solving — wait for result
    const startWait = Date.now();
    while (Date.now() - startWait < MUTEX_WAIT_MAX_MS) {
      await new Promise(r => setTimeout(r, MUTEX_WAIT_MS));
      const cached = await getCookies(domain);
      if (cached) return cached;
    }
    // Timed out waiting — try solving ourselves
  }

  try {
    // Double-check cache (another worker may have solved while we acquired the lock)
    const cached = await getCookies(domain);
    if (cached) return cached;

    console.log(`[WafCookieManager] Solving Sucuri challenge for ${domain}...`);

    // Reuse the shared Playwright browser singleton (managed by playwright-fetcher)
    const { getBrowser } = await import('./playwright-fetcher');
    const browser = await getBrowser();
    const ua = resolveWafUa(domain);
    const context = await browser.newContext({ userAgent: ua });

    try {
      const page = await context.newPage();

      // Navigate and wait for Sucuri challenge to resolve
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

      // Wait a bit for any secondary challenges
      await page.waitForTimeout(2000);

      // Extract all cookies
      const origin = new URL(url).origin;
      const browserCookies = await context.cookies(origin);
      const cookieString = browserCookies.map(c => `${c.name}=${c.value}`).join('; ');

      if (!cookieString) {
        throw new Error('No cookies obtained from Playwright');
      }

      // Verify the cookies work by making a test request
      const testResp = await axios.get(`${origin}/wp-json/wc/store/v1/products`, {
        params: { per_page: 1 },
        headers: { 'User-Agent': ua, 'Cookie': cookieString },
        timeout: 15000,
        validateStatus: () => true,
      });

      if (testResp.status !== 200) {
        throw new Error(`Cookie verification failed: API returned ${testResp.status}`);
      }

      // Cache in Redis
      const entry: CookieEntry = {
        cookies: cookieString,
        userAgent: ua,
        acquiredAt: Date.now(),
        failureCount: 0,
      };

      const ttlSeconds = Math.ceil(COOKIE_TTL_MS / 1000);
      await redisConnection.set(redisKey(domain), JSON.stringify(entry), 'EX', ttlSeconds);

      console.log(`[WafCookieManager] ${domain}: cookies cached (${browserCookies.length} cookies, verified via API)`);

      return { cookies: cookieString, userAgent: ua };
    } finally {
      await context.close(); // Close context but NOT the shared browser
    }
  } finally {
    // Release mutex
    await redisConnection.del(lockKey).catch(() => {});
  }
}

/**
 * Report a cookie failure (API returned 307/403 with these cookies).
 * After MAX_FAILURES_BEFORE_REFRESH, the cookies are evicted.
 */
export async function reportFailure(domain: string): Promise<void> {
  try {
    const raw = await redisConnection.get(redisKey(domain));
    if (!raw) return;

    const entry: CookieEntry = JSON.parse(raw);
    entry.failureCount++;

    if (entry.failureCount >= MAX_FAILURES_BEFORE_REFRESH) {
      await redisConnection.del(redisKey(domain));
      console.log(`[WafCookieManager] ${domain}: cookies evicted after ${entry.failureCount} failures`);
    } else {
      const remainingTtl = await redisConnection.ttl(redisKey(domain));
      if (remainingTtl > 0) {
        await redisConnection.set(redisKey(domain), JSON.stringify(entry), 'EX', remainingTtl);
      }
    }
  } catch {
    // Non-critical — next request will re-solve if needed
  }
}

/**
 * Get valid cookies or solve if needed. Main entry point for callers.
 */
export async function ensureCookies(domain: string, url: string): Promise<{ cookies: string; userAgent: string }> {
  const cached = await getCookies(domain);
  if (cached) return cached;
  return solveCookies(domain, url);
}
