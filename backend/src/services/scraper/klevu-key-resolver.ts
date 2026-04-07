/**
 * Klevu API key self-healing resolver.
 *
 * Klevu search keys are public client-side keys embedded in merchant homepages.
 * They don't expire on a timer, but merchants can regenerate them silently,
 * which would break catalog crawling. This resolver:
 *   1. Tests the currently-stored key with a tiny SEARCH call.
 *   2. On failure (or when forced), re-extracts the key from the homepage HTML
 *      (via Playwright if the site has a WAF, else plain axios).
 *   3. Verifies the new key works, then persists it back to siteProfile.apiConfig.
 *
 * The resolver is defensive: all network failures return null instead of throwing,
 * and the DB is only mutated when a new key has been proven to work.
 */
import axios from 'axios';
import { prisma } from '../../lib/prisma';

const TIMEOUT = 15_000;
const CACHE_TTL_MS = 60 * 1000; // 1 minute
const KLEVU_KEY_REGEX = /klevu-\d{15,20}/g;
const DEFAULT_KLEVU_ENDPOINT = 'https://uscs33v2.ksearchnet.com/cs/v2/search';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface CacheEntry {
  key: string;
  ts: number;
}
const cache = new Map<string, CacheEntry>();

/**
 * Test a Klevu key by issuing a 1-result wildcard SEARCH. Returns true if
 * the API returns meta.totalResultsFound > 0.
 */
async function testKlevuKey(endpoint: string, apiKey: string): Promise<boolean> {
  try {
    const r = await axios.post(
      endpoint,
      {
        context: { apiKeys: [apiKey] },
        recordQueries: [
          {
            id: 'probe',
            typeOfRequest: 'SEARCH',
            settings: {
              query: { term: '*' },
              limit: 1,
              offset: 0,
              sort: 'RELEVANCE',
              typeOfRecords: ['KLEVU_PRODUCT'],
            },
          },
        ],
      },
      {
        timeout: TIMEOUT,
        headers: { 'Content-Type': 'application/json' },
        validateStatus: () => true,
      },
    );
    if (r.status === 401 || r.status === 403) return false;
    const total = r.data?.queryResults?.[0]?.meta?.totalResultsFound;
    return typeof total === 'number' && total > 0;
  } catch {
    return false;
  }
}

/**
 * Fetch the site homepage HTML, via Playwright if hasWaf is true.
 * Returns empty string on any failure.
 */
async function fetchHomepageHtml(siteUrl: string, hasWaf: boolean): Promise<string> {
  try {
    if (hasWaf) {
      const { fetchWithPlaywright } = await import('./playwright-fetcher');
      const result = await fetchWithPlaywright(siteUrl, { timeout: 30_000 });
      return result?.html || '';
    }
    const r = await axios.get(siteUrl, {
      timeout: TIMEOUT,
      headers: { 'User-Agent': UA },
      validateStatus: () => true,
    });
    return typeof r.data === 'string' ? r.data : '';
  } catch {
    return '';
  }
}

/** Extract the first unique klevu-xxxxxxxxxxxx key from HTML. */
function extractKlevuKey(html: string): string | null {
  if (!html) return null;
  const matches = html.match(KLEVU_KEY_REGEX);
  if (!matches || matches.length === 0) return null;
  // Return first unique
  const seen = new Set<string>();
  for (const m of matches) {
    if (!seen.has(m)) return m;
    seen.add(m);
  }
  return matches[0];
}

/**
 * Resolve the working Klevu API key for a site, rotating to a fresh key
 * scraped from the homepage if the stored one no longer works.
 *
 * @param siteIdOrDomain Either a MonitoredSite.id (cuid) or a hostname/domain.
 * @param siteUrl URL to fetch for homepage scraping (origin is fine).
 * @param options.hasWaf Use Playwright with Sucuri cookie solve for homepage fetch.
 * @param options.force Skip the stored-key test and always re-scrape.
 * @returns The working Klevu key, or null on any failure.
 */
export async function resolveKlevuKey(
  siteIdOrDomain: string,
  siteUrl: string,
  options: { hasWaf: boolean; force?: boolean },
): Promise<string | null> {
  // Look up the MonitoredSite row. Accept either id or domain.
  let site: { id: string; siteProfile: any } | null = null;
  try {
    // Try as id first (cuids contain no dots)
    if (!siteIdOrDomain.includes('.')) {
      site = await prisma.monitoredSite.findUnique({
        where: { id: siteIdOrDomain },
        select: { id: true, siteProfile: true },
      });
    }
    if (!site) {
      const domain = siteIdOrDomain.includes('.')
        ? siteIdOrDomain.replace(/^www\./, '')
        : siteIdOrDomain;
      site = await prisma.monitoredSite.findFirst({
        where: { domain },
        select: { id: true, siteProfile: true },
      });
    }
  } catch {
    return null;
  }

  if (!site) return null;

  const siteProfile = (site.siteProfile as any) || {};
  const apiConfig = siteProfile.apiConfig || {};
  const storedKey: string | null = apiConfig.klevuApiKey || null;
  const endpoint: string = apiConfig.klevuEndpoint || DEFAULT_KLEVU_ENDPOINT;

  // Check cache (unless forced)
  if (!options.force) {
    const hit = cache.get(site.id);
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
      return hit.key;
    }
  }

  // Step 1: test stored key (unless forced)
  if (storedKey && !options.force) {
    const ok = await testKlevuKey(endpoint, storedKey);
    if (ok) {
      cache.set(site.id, { key: storedKey, ts: Date.now() });
      return storedKey;
    }
  }

  // Step 2: re-scrape homepage
  const origin = (() => {
    try {
      return new URL(siteUrl).origin;
    } catch {
      return siteUrl;
    }
  })();
  const html = await fetchHomepageHtml(origin, options.hasWaf);
  const scrapedKey = extractKlevuKey(html);

  if (!scrapedKey) {
    console.log(
      `[KlevuKeyResolver] No klevu key found in homepage HTML for ${origin} (html length: ${html.length})`,
    );
    return null;
  }

  // If force=true and scraped key matches stored, still verify and return.
  if (scrapedKey === storedKey) {
    const ok = await testKlevuKey(endpoint, scrapedKey);
    if (ok) {
      cache.set(site.id, { key: scrapedKey, ts: Date.now() });
      return scrapedKey;
    }
    return null;
  }

  // New key — verify before persisting
  const newKeyOk = await testKlevuKey(endpoint, scrapedKey);
  if (!newKeyOk) {
    console.log(
      `[KlevuKeyResolver] Scraped key ${scrapedKey} for ${origin} failed verification — NOT persisting`,
    );
    return null;
  }

  // Persist new key + bump lastVerified
  try {
    const today = new Date().toISOString().slice(0, 10);
    const updatedProfile = {
      ...siteProfile,
      apiConfig: { ...apiConfig, klevuApiKey: scrapedKey },
      lastVerified: today,
    };
    await prisma.monitoredSite.update({
      where: { id: site.id },
      data: { siteProfile: updatedProfile },
    });
    console.log(
      `[KlevuKeyResolver] ROTATED key for ${origin}: ${storedKey} -> ${scrapedKey}`,
    );
  } catch (err) {
    console.log(
      `[KlevuKeyResolver] Failed to persist rotated key for ${origin}: ${err instanceof Error ? err.message : err}`,
    );
    // Still return the working key even if DB write failed
  }

  cache.set(site.id, { key: scrapedKey, ts: Date.now() });
  return scrapedKey;
}
