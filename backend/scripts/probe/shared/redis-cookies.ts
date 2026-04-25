// backend/scripts/probe/shared/redis-cookies.ts
// Thin wrapper around production waf-cookie-manager Redis cache.
// Probe shares the same cookie cache as production crawlers — solving once benefits both.
//
// Production getCookies signature (verified by reading waf-cookie-manager.ts:59):
//   getCookies(domain: string): Promise<{ cookies: string; userAgent: string } | null>
//
// It internally try/catches Redis errors and returns null on failure, so the wrapper
// does not need a separate Redis availability probe.

import { getCookies as prodGetCookies } from '../../../src/services/scraper/waf-cookie-manager';

export type CachedWafCookies = { cookies: string; userAgent: string };

export async function getCachedCookies(domain: string): Promise<CachedWafCookies | null> {
  // Normalize: strip www. to match the canonical key form used by production
  // waf-cookie-manager.ts:27 (resolveWafUa). Without this, www-prefixed lookups
  // miss cookies stored under the apex domain.
  const bare = domain.replace(/^www\./, '');
  try {
    return await prodGetCookies(bare);
  } catch (err) {
    console.warn(`[probe/redis-cookies] getCookies(${bare}) failed:`, (err as Error).message);
    return null;
  }
}
