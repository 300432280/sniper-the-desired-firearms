// backend/scripts/verify-site-profile.ts
/**
 * verify-site-profile — live parameter verifier for MonitoredSite.siteProfile.
 *
 * Tests every load-bearing siteProfile parameter against the live site:
 *  - catalogUrls    (HEAD probe + GET page 1 + production extract → ≥1 product per URL)
 *  - paginationPattern (page 1 vs page 2: first product slugs MUST differ)
 *  - sortParam      (with-sort vs without-sort: first product slug MUST differ)
 *  - expectedProductCount (re-derive via best API/sitemap method; expect ±10%)
 *  - wafType        (curl-equivalent HEAD; vendor-header match)
 *
 * CLI:
 *   npx tsx backend/scripts/verify-site-profile.ts <domain>
 *   npx tsx backend/scripts/verify-site-profile.ts --all
 *
 * Output:
 *   docs/site-verification/<domain>-<timestamp>.json
 *   Console: per-parameter PASS / WARN / FAIL table
 *
 * Library use (Task 4 — health-monitor watchdog):
 *   import { verifySiteProfile } from './verify-site-profile';
 *   const result = await verifySiteProfile(site);
 */

import { prisma } from '../src/lib/prisma';
import { fetchUrl } from './probe/shared/fetch';
import type { FetchResult } from './probe/shared/fetch';
import { GenericRetailAdapter } from '../src/services/scraper/adapters/generic-retail';
import { buildPaginatedUrl } from '../src/services/catalog-crawler';
import type { PaginationPattern } from '../src/services/catalog-crawler';
import * as cheerio from 'cheerio';
import * as fs from 'fs/promises';
import * as path from 'path';

// ─── Types ──────────────────────────────────────────────────────────────────

export type Verdict = 'PASS' | 'WARN' | 'FAIL';

export interface ParameterCheck {
  name: 'catalogUrls' | 'paginationPattern' | 'sortParam' | 'expectedProductCount' | 'wafType';
  verdict: Verdict;
  expected: unknown;
  actual: unknown;
  evidence: Record<string, unknown>;
  reason?: string;
}

export interface VerificationResult {
  siteId: string;
  domain: string;
  timestamp: string;
  durationMs: number;
  overallVerdict: Verdict;       // worst of all checks
  checks: ParameterCheck[];
  rawSiteProfile: unknown;        // snapshot for diffing
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const DELAY_MS = 2500; // anti-ban delay between fetches

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function worstVerdict(checks: ParameterCheck[]): Verdict {
  if (checks.some(c => c.verdict === 'FAIL')) return 'FAIL';
  if (checks.some(c => c.verdict === 'WARN')) return 'WARN';
  return 'PASS';
}

export function resolveUrl(base: string, relative: string): string {
  if (relative.startsWith('http')) return relative;
  try {
    return new URL(relative, base).toString();
  } catch {
    return base.replace(/\/$/, '') + (relative.startsWith('/') ? relative : '/' + relative);
  }
}

export function extractSlug(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.replace(/\/$/, '').split('/').pop() || url;
  } catch {
    return url;
  }
}

// Production adapter instance for HTML extraction
const genericRetailAdapter = new GenericRetailAdapter();

export function extractProducts(html: string, baseUrl: string) {
  const $ = cheerio.load(html);
  return genericRetailAdapter.extractCatalogProducts($, baseUrl);
}

// ─── Check 1: catalogUrls ──────────────────────────────────────────────────

export interface CatalogUrlResult {
  url: string;
  status: number | null;
  productCount: number;
  sampleSlugs: string[];
  error?: string;
}

async function checkCatalogUrls(
  siteUrl: string,
  profile: any,
): Promise<{ check: ParameterCheck; urlResults: CatalogUrlResult[] }> {
  const catalogUrls: string[] = profile.catalogUrls || [];
  const urlResults: CatalogUrlResult[] = [];

  if (catalogUrls.length === 0) {
    return {
      check: {
        name: 'catalogUrls',
        verdict: 'FAIL',
        expected: 'at least 1 catalogUrl',
        actual: 0,
        evidence: { perUrl: [] },
        reason: 'No catalogUrls defined in siteProfile',
      },
      urlResults,
    };
  }

  for (const catUrl of catalogUrls) {
    const fullUrl = resolveUrl(siteUrl, catUrl);
    const result: CatalogUrlResult = { url: catUrl, status: null, productCount: 0, sampleSlugs: [] };

    try {
      // GET page to extract products (HEAD alone can't tell us about content)
      await delay(DELAY_MS);
      const fetchResult = await fetchUrl(fullUrl, { timeoutMs: 30000 });
      result.status = fetchResult.status;

      if (fetchResult.status >= 400) {
        result.error = `HTTP ${fetchResult.status}`;
      } else {
        const products = extractProducts(fetchResult.body, fullUrl);
        result.productCount = products.length;
        result.sampleSlugs = products.slice(0, 3).map(p => extractSlug(p.url));
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    }

    urlResults.push(result);
  }

  // Aggregate verdict
  const anyFail = urlResults.some(r => r.status !== null && r.status >= 400 || r.error);
  const anyWarn = urlResults.some(r => r.status !== null && r.status < 400 && r.productCount === 0 && !r.error);
  const verdict: Verdict = anyFail ? 'FAIL' : anyWarn ? 'WARN' : 'PASS';

  const reasons: string[] = [];
  if (anyFail) {
    const failUrls = urlResults.filter(r => (r.status !== null && r.status >= 400) || r.error);
    reasons.push(`${failUrls.length}/${urlResults.length} URLs failed: ${failUrls.map(r => r.url).join(', ')}`);
  }
  if (anyWarn) {
    const warnUrls = urlResults.filter(r => r.status !== null && r.status < 400 && r.productCount === 0 && !r.error);
    reasons.push(`${warnUrls.length}/${urlResults.length} URLs returned 0 products (possible sub-cat tile page)`);
  }

  return {
    check: {
      name: 'catalogUrls',
      verdict,
      expected: `${catalogUrls.length} URLs, each returning ≥1 product`,
      actual: `${urlResults.filter(r => r.productCount > 0).length}/${urlResults.length} returned products`,
      evidence: { perUrl: urlResults },
      reason: reasons.join('; ') || undefined,
    },
    urlResults,
  };
}

// ─── Check 2: paginationPattern ─────────────────────────────────────────────

export async function checkPaginationPattern(
  siteUrl: string,
  profile: any,
  urlResults: CatalogUrlResult[],
): Promise<ParameterCheck> {
  const pattern: PaginationPattern | undefined = profile.paginationPattern;
  const workingUrl = urlResults.find(r => r.productCount > 0);

  if (!workingUrl) {
    return {
      name: 'paginationPattern',
      verdict: 'WARN',
      expected: 'page1 vs page2 differ',
      actual: null,
      evidence: {},
      reason: 'No catalogUrl returned products in check 1; cannot test pagination',
    };
  }

  const baseUrl = resolveUrl(siteUrl, workingUrl.url);
  const page2Url = buildPaginatedUrl(baseUrl, 2, pattern);

  try {
    await delay(DELAY_MS);
    const page2Result = await fetchUrl(page2Url, { timeoutMs: 30000 });

    if (page2Result.status >= 400) {
      return {
        name: 'paginationPattern',
        verdict: 'FAIL',
        expected: 'page2 returns 200',
        actual: `HTTP ${page2Result.status}`,
        evidence: { page1Url: baseUrl, page2Url, page1First3: workingUrl.sampleSlugs, page2First3: [], overlapCount: 0 },
        reason: `Page 2 returned HTTP ${page2Result.status}`,
      };
    }

    const page2Products = extractProducts(page2Result.body, page2Url);
    const page2First3 = page2Products.slice(0, 3).map(p => extractSlug(p.url));
    const page1First3 = workingUrl.sampleSlugs;

    // Count overlap
    const overlapCount = page2First3.filter(s => page1First3.includes(s)).length;

    let verdict: Verdict;
    let reason: string | undefined;
    if (overlapCount === 0) {
      verdict = 'PASS';
    } else if (overlapCount < 3 || page2First3.length < 3) {
      verdict = 'WARN';
      reason = `${overlapCount}/${Math.min(page1First3.length, page2First3.length)} slugs overlap (small category possible)`;
    } else {
      verdict = 'FAIL';
      reason = 'All page2 first-3 slugs match page1 — pagination silently ignored (Mistake 26)';
    }

    return {
      name: 'paginationPattern',
      verdict,
      expected: 'page1 vs page2 first-3 slugs differ',
      actual: `${overlapCount} overlap`,
      evidence: { page1Url: baseUrl, page2Url, page1First3, page2First3, overlapCount },
      reason,
    };
  } catch (err) {
    return {
      name: 'paginationPattern',
      verdict: 'FAIL',
      expected: 'page2 fetchable',
      actual: err instanceof Error ? err.message : String(err),
      evidence: { page1Url: baseUrl, page2Url },
      reason: `Fetch error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── Check 3: sortParam ────────────────────────────────────────────────────

function stripSortFromUrl(url: string, sortParam: unknown): string {
  // Guard: Ecwid stores sortParam as object { field, value }; other platforms use string
  if (!sortParam || typeof sortParam !== 'string') return url;
  // sortParam might be "?orderby=date" or "sort=newest" or "?sort_by=date_pub&sort_order=DESC"
  const cleanSort = sortParam.replace(/^\?/, '');
  const pairs = cleanSort.split('&').filter(p => p.length > 0);

  try {
    const u = new URL(url);
    for (const pair of pairs) {
      const [key] = pair.split('=');
      if (key) u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    // Fallback: string manipulation
    let result = url;
    for (const pair of pairs) {
      const [key] = pair.split('=');
      if (key) {
        result = result.replace(new RegExp(`[?&]${key}=[^&]*`, 'g'), '');
      }
    }
    return result;
  }
}

/** Pick the best counter-control sort param for 3-outcome test */
function getCounterControlSort(platform: string): string {
  // Platform-family counter-controls that almost always exist and produce
  // a visibly different ordering from both default and newest.
  if (/woocommerce/i.test(platform)) return 'orderby=price';
  if (/shopify/i.test(platform)) return 'sort_by=price-ascending';
  if (/bigcommerce/i.test(platform)) return 'sort=alphaasc';
  if (/magento/i.test(platform)) return 'product_list_order=price&product_list_dir=asc';
  if (/opencart/i.test(platform)) return 'sort=p.price&order=ASC';
  if (/lightspeed/i.test(platform)) return 'sort=price_asc';
  // Generic fallback — price sort exists on most platforms
  return 'sort=price';
}

async function checkSortParam(
  siteUrl: string,
  profile: any,
  urlResults: CatalogUrlResult[],
): Promise<ParameterCheck> {
  const watermarkMethod = profile.crawlers?.watermark?.method;

  // Method C: sort not applicable
  if (watermarkMethod === 'full-catalog-sweep') {
    return {
      name: 'sortParam',
      verdict: 'PASS',
      expected: 'n/a (method C)',
      actual: 'full-catalog-sweep',
      evidence: {},
      reason: 'not-applicable-method-c',
    };
  }

  const sortParam: string = profile.sortParam || '';
  if (!sortParam) {
    return {
      name: 'sortParam',
      verdict: 'WARN',
      expected: 'sortParam defined',
      actual: 'empty/missing',
      evidence: {},
      reason: 'No sortParam in siteProfile',
    };
  }

  const workingUrl = urlResults.find(r => r.productCount >= 3);
  if (!workingUrl) {
    return {
      name: 'sortParam',
      verdict: 'WARN',
      expected: 'catalogUrl with ≥3 products to test sort',
      actual: null,
      evidence: {},
      reason: 'No catalogUrl returned ≥3 products; cannot test sort',
    };
  }

  const baseUrl = resolveUrl(siteUrl, workingUrl.url);
  const withoutSortUrl = stripSortFromUrl(baseUrl, sortParam);

  // Build with-sort URL
  const cleanSort = sortParam.replace(/^\?/, '');
  let withSortUrl: string;
  try {
    const u = new URL(withoutSortUrl);
    for (const pair of cleanSort.split('&')) {
      const [key, val] = pair.split('=');
      if (key) u.searchParams.set(key, val || '');
    }
    withSortUrl = u.toString();
  } catch {
    const sep = withoutSortUrl.includes('?') ? '&' : '?';
    withSortUrl = `${withoutSortUrl}${sep}${cleanSort}`;
  }

  try {
    // Fetch without-sort
    await delay(DELAY_MS);
    const withoutSortResult = await fetchUrl(withoutSortUrl, { timeoutMs: 30000 });
    const withoutSortProducts = extractProducts(withoutSortResult.body, withoutSortUrl);
    const withoutSortFirst = withoutSortProducts.length > 0 ? extractSlug(withoutSortProducts[0].url) : null;

    // Fetch with-sort
    await delay(DELAY_MS);
    const withSortResult = await fetchUrl(withSortUrl, { timeoutMs: 30000 });
    const withSortProducts = extractProducts(withSortResult.body, withSortUrl);
    const withSortFirst = withSortProducts.length > 0 ? extractSlug(withSortProducts[0].url) : null;

    if (withSortFirst !== withoutSortFirst) {
      // Slugs differ — sort is definitely honored
      return {
        name: 'sortParam',
        verdict: 'PASS',
        expected: 'first product slug differs with sort',
        actual: 'differs',
        evidence: {
          withSortUrl, withoutSortUrl,
          withSortFirst, withoutSortFirst,
          counterControlUrl: null, counterControlFirst: null,
        },
      };
    }

    // Slugs identical — need counter-control (3-outcome test per Mistake 29)
    const platform = profile.platform || '';
    const counterSort = getCounterControlSort(platform);
    let counterControlUrl: string;
    try {
      const u = new URL(withoutSortUrl);
      for (const pair of counterSort.split('&')) {
        const [key, val] = pair.split('=');
        if (key) u.searchParams.set(key, val || '');
      }
      counterControlUrl = u.toString();
    } catch {
      const sep = withoutSortUrl.includes('?') ? '&' : '?';
      counterControlUrl = `${withoutSortUrl}${sep}${counterSort}`;
    }

    await delay(DELAY_MS);
    const counterResult = await fetchUrl(counterControlUrl, { timeoutMs: 30000 });
    const counterProducts = extractProducts(counterResult.body, counterControlUrl);
    const counterControlFirst = counterProducts.length > 0 ? extractSlug(counterProducts[0].url) : null;

    if (counterControlFirst !== withSortFirst && counterControlFirst !== null) {
      // Counter-control gives different slug → proves site CAN sort, and default
      // already equals newest. This is the Mistake 29 "honored-default-is-newest"
      // false-negative trap. Sort IS honored; default just happens to be newest.
      return {
        name: 'sortParam',
        verdict: 'WARN',
        expected: 'first product slug differs with sort',
        actual: 'same (honored-default-is-newest)',
        evidence: {
          withSortUrl, withoutSortUrl,
          withSortFirst, withoutSortFirst,
          counterControlUrl, counterControlFirst,
        },
        reason: 'Sort honored — default ordering already equals newest (Mistake 29 honored-default-is-newest)',
      };
    }

    // Counter-control also returns the same slug → sort truly has no effect
    // (small category, or sort silently ignored on all params)
    return {
      name: 'sortParam',
      verdict: 'FAIL',
      expected: 'first product slug differs with sort',
      actual: 'same (sort has no effect)',
      evidence: {
        withSortUrl, withoutSortUrl,
        withSortFirst, withoutSortFirst,
        counterControlUrl, counterControlFirst,
      },
      reason: 'Sort parameter and counter-control both return same first product — sort may be silently ignored',
    };
  } catch (err) {
    return {
      name: 'sortParam',
      verdict: 'FAIL',
      expected: 'sort testable',
      actual: err instanceof Error ? err.message : String(err),
      evidence: {},
      reason: `Fetch error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── Check 4: expectedProductCount ──────────────────────────────────────────

async function checkExpectedProductCount(
  siteUrl: string,
  profile: any,
): Promise<ParameterCheck> {
  const storedCount: number | null = profile.expectedProductCount ?? null;
  if (storedCount === null || storedCount === 0) {
    return {
      name: 'expectedProductCount',
      verdict: 'WARN',
      expected: 'expectedProductCount defined',
      actual: storedCount,
      evidence: { storedCount, actualCount: null, methodUsed: null, driftPct: null },
      reason: 'No expectedProductCount in siteProfile',
    };
  }

  const platform = (profile.platform || '').toLowerCase();
  const adapter = (profile.adapter || '').toLowerCase();
  let actualCount: number | null = null;
  let methodUsed = 'unknown';

  try {
    // Priority 1: WP REST x-wp-total (WooCommerce)
    if (/woocommerce/.test(adapter) || /woocommerce/.test(platform)) {
      const apiUrl = resolveUrl(siteUrl, '/wp-json/wp/v2/product?per_page=1');
      await delay(DELAY_MS);
      const result = await fetchUrl(apiUrl, { timeoutMs: 30000 });
      const wpTotal = result.headers['x-wp-total'];
      if (wpTotal && result.status === 200) {
        actualCount = parseInt(wpTotal, 10);
        methodUsed = 'wp-rest-header';
      }
    }

    // Priority 2: WC Store API x-wp-total
    if (actualCount === null && (/woocommerce/.test(adapter) || /woocommerce/.test(platform))) {
      const storeApiUrl = resolveUrl(siteUrl, '/wp-json/wc/store/v1/products?per_page=1');
      await delay(DELAY_MS);
      const result = await fetchUrl(storeApiUrl, { timeoutMs: 30000 });
      const wpTotal = result.headers['x-wp-total'];
      if (wpTotal && result.status === 200) {
        actualCount = parseInt(wpTotal, 10);
        methodUsed = 'wc-store-api-header';
      }
    }

    // Priority 3: Shopify /products.json walk (most reliable for Shopify public API)
    if (actualCount === null && /shopify/.test(platform)) {
      const productsUrl = resolveUrl(siteUrl, '/products.json?limit=250');
      await delay(DELAY_MS);
      const result = await fetchUrl(productsUrl, { timeoutMs: 30000 });
      if (result.status === 200) {
        try {
          const firstPage = JSON.parse(result.body);
          if (Array.isArray(firstPage.products)) {
            let total = firstPage.products.length;
            let page = 2;
            let lastBatchSize = firstPage.products.length;
            while (lastBatchSize === 250 && page <= 100) {
              await delay(DELAY_MS);
              const nextResult = await fetchUrl(
                resolveUrl(siteUrl, `/products.json?limit=250&page=${page}`),
                { timeoutMs: 30000 },
              );
              if (nextResult.status !== 200) break;
              const nextData = JSON.parse(nextResult.body);
              if (!Array.isArray(nextData.products) || nextData.products.length === 0) break;
              total += nextData.products.length;
              lastBatchSize = nextData.products.length;
              page++;
            }
            actualCount = total;
            methodUsed = 'shopify-products-json-walk';
          }
        } catch { /* not JSON */ }
      }
    }

    // Priority 4: Ecwid storefront API
    if (actualCount === null && /ecwid/.test(platform)) {
      const storeId = profile.ecwidStoreId;
      if (storeId) {
        const ecwidUrl = `https://us-vir2-storefront-api.ecwid.com/storefront/api/v1/${storeId}/catalog/search`;
        await delay(DELAY_MS);
        const result = await fetchUrl(ecwidUrl, {
          method: 'POST',
          body: JSON.stringify({ lang: 'en', pagination: { offset: 0, limit: 1 } }),
          headers: { 'Content-Type': 'application/json' },
          timeoutMs: 30000,
        });
        if (result.status === 200) {
          try {
            const data = JSON.parse(result.body);
            if (typeof data.totalProductsCount === 'number') {
              actualCount = data.totalProductsCount;
              methodUsed = 'ecwid-storefront-api';
            }
          } catch { /* not JSON */ }
        }
      }
    }

    // Priority 5: Sitemap-derived count
    if (actualCount === null) {
      const sitemapCount = await countProductsFromSitemap(siteUrl);
      if (sitemapCount > 0) {
        actualCount = sitemapCount;
        methodUsed = 'sitemap';
      }
    }

    // (Shopify walk already handled at Priority 3 — no fallback needed)
  } catch (err) {
    return {
      name: 'expectedProductCount',
      verdict: 'FAIL',
      expected: storedCount,
      actual: null,
      evidence: { storedCount, actualCount: null, methodUsed, driftPct: null, error: String(err) },
      reason: `Error re-deriving count: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (actualCount === null) {
    return {
      name: 'expectedProductCount',
      verdict: 'WARN',
      expected: storedCount,
      actual: null,
      evidence: { storedCount, actualCount: null, methodUsed: 'none-succeeded', driftPct: null },
      reason: 'Could not re-derive product count via any method',
    };
  }

  const driftPct = Math.round(Math.abs(storedCount - actualCount) / storedCount * 100);
  let verdict: Verdict;
  if (driftPct <= 10) verdict = 'PASS';
  else if (driftPct <= 25) verdict = 'WARN';
  else verdict = 'FAIL';

  return {
    name: 'expectedProductCount',
    verdict,
    expected: storedCount,
    actual: actualCount,
    evidence: { storedCount, actualCount, methodUsed, driftPct },
    reason: driftPct > 10 ? `Count drifted ${driftPct}% (stored=${storedCount}, actual=${actualCount})` : undefined,
  };
}

/** Extract product count from sitemap by filtering <loc> entries to product URLs */
export async function countProductsFromSitemap(siteUrl: string): Promise<number> {
  // Try multiple sitemap paths — BC Stencil uses /xmlsitemap.php, WP uses /sitemap.xml
  const sitemapUrls = ['/sitemap.xml', '/sitemap_index.xml', '/xmlsitemap.php', '/sitemap-index.xml'];
  const productLocs = new Set<string>();

  // Product URL patterns (positive match)
  const PRODUCT_PATTERNS = [
    /\/product\//i, /\/products\//i, /\/shop\//i,
    /\/item\//i, /\/lot\//i, /\/listing\//i,
    /-p\d{3,}/, /\/p\/\d+/,
    /\/catalog\/product\/view\//i,
    /\.html$/i,   // Magento / OpenCart product pages
    /\/ProductDetails\.asp/i,  // Volusion
  ];

  // Negative patterns (definitely NOT product pages)
  const NAV_PATTERNS = [
    /\/product-category\//i, /\/collections\//i, /\/category\//i,
    /\/categories\//i, /\/brand\//i, /\/tag\//i,
    /\/page\/\d+/i, /\/cart/i, /\/login/i, /\/register/i,
    /\/account/i, /\/contact/i, /\/about/i, /\/faq/i,
    /\/privacy/i, /\/terms/i, /\/blog/i, /\/news/i,
    /\/sitemap/i, /\/feed/i,
  ];

  for (const sitemapPath of sitemapUrls) {
    try {
      await delay(DELAY_MS);
      const result = await fetchUrl(resolveUrl(siteUrl, sitemapPath), { timeoutMs: 30000 });
      if (result.status !== 200 || !result.body.includes('<')) continue;

      // Check if this is a sitemap index
      if (result.body.includes('<sitemapindex')) {
        const subSitemapMatches = result.body.match(/<loc>(.*?)<\/loc>/g) || [];
        for (const match of subSitemapMatches.slice(0, 40)) {
          const loc = decodeXmlEntities(match.replace(/<\/?loc>/g, '').trim());
          // Follow product-looking sub-sitemaps:
          // - WP: /product-sitemap.xml, /post-sitemap.xml
          // - BC Stencil: /xmlsitemap.php?type=products
          // - Generic: sitemap paths with "product" or numbered pages
          const isProductSitemap = /product|shop|item|post-sitemap/i.test(loc)
            || /type=products/i.test(loc)
            || /sitemap.*\d+\.xml/i.test(loc);
          if (!isProductSitemap) continue;

          // For BC Stencil product sitemaps (type=products), ALL entries are products
          const isBcProductSitemap = /type=products/i.test(loc);
          try {
            await delay(DELAY_MS);
            const subResult = await fetchUrl(loc, { timeoutMs: 30000 });
            if (subResult.status === 200) {
              if (isBcProductSitemap) {
                // BC Stencil product sitemap: count ALL <loc> entries (no pattern filter needed)
                const allLocs = subResult.body.match(/<loc>(.*?)<\/loc>/g) || [];
                for (const m of allLocs) {
                  productLocs.add(decodeXmlEntities(m.replace(/<\/?loc>/g, '').trim()));
                }
              } else {
                extractProductLocsFromSitemap(subResult.body, productLocs, PRODUCT_PATTERNS, NAV_PATTERNS);
              }
            }
          } catch { /* skip sub-sitemap errors */ }
        }
        if (productLocs.size > 0) break; // Found products via sitemap index
        continue; // Try next sitemap path
      }

      extractProductLocsFromSitemap(result.body, productLocs, PRODUCT_PATTERNS, NAV_PATTERNS);
      if (productLocs.size > 0) break;
    } catch { /* try next sitemap path */ }
  }

  return productLocs.size;
}

function decodeXmlEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function extractProductLocsFromSitemap(
  xml: string,
  productLocs: Set<string>,
  positivePatterns: RegExp[],
  negativePatterns: RegExp[],
): void {
  const locMatches = xml.match(/<loc>(.*?)<\/loc>/g) || [];
  for (const match of locMatches) {
    const loc = decodeXmlEntities(match.replace(/<\/?loc>/g, '').trim());
    if (negativePatterns.some(p => p.test(loc))) continue;
    if (positivePatterns.some(p => p.test(loc))) {
      productLocs.add(loc);
    }
  }
}

// ─── Check 5: wafType ──────────────────────────────────────────────────────

function detectWafFromHeaders(
  headers: Record<string, string>,
  status: number,
  body: string,
): string | null {
  // Check for Cloudflare
  if (headers['cf-ray'] || (headers['server'] || '').toLowerCase() === 'cloudflare') {
    if (status === 403 && headers['cf-mitigated'] === 'challenge') {
      return 'cloudflare-active';
    }
    return 'cloudflare-passive';
  }

  // Check for Sucuri
  if (headers['x-sucuri-id'] || (headers['server'] || '').toLowerCase().includes('sucuri')) {
    return 'sucuri';
  }

  // Check for sgcaptcha
  if (headers['sg-captcha'] === 'challenge') {
    return 'sgcaptcha';
  }

  // Check for Incapsula
  const setCookie = headers['set-cookie'] || '';
  if (/visid_incap_|incap_ses_/i.test(setCookie)) {
    return 'incapsula';
  }

  // Check for Akamai
  if ((headers['server'] || '').toLowerCase().includes('akamaighost')) {
    return 'akamai';
  }

  // Check for MalCare markers in body
  if (body && (body.includes('MalCare') || body.includes('malcare'))) {
    return 'malcare';
  }

  return null;
}

async function checkWafType(
  siteUrl: string,
  profile: any,
): Promise<ParameterCheck> {
  const storedWafType: string | null = profile.wafType || null;

  try {
    await delay(DELAY_MS);
    const result = await fetchUrl(siteUrl, { method: 'HEAD', timeoutMs: 15000 });
    const detectedWafType = detectWafFromHeaders(result.headers, result.status, result.body || '');

    // Normalize for comparison — both null means both agree on "no WAF"
    const storedNorm = storedWafType || null;
    const detectedNorm = detectedWafType || null;

    let verdict: Verdict;
    let reason: string | undefined;

    if (storedNorm === detectedNorm) {
      verdict = 'PASS';
    } else if (
      // cloudflare-passive also matches cloudflare-passive-with-owasp
      storedNorm && detectedNorm &&
      storedNorm.replace(/-with-owasp$/, '') === detectedNorm.replace(/-with-owasp$/, '')
    ) {
      verdict = 'PASS';
      reason = 'WAF sub-type variant match';
    } else if (detectedNorm === null && storedNorm !== null) {
      verdict = 'WARN';
      reason = `Stored wafType='${storedNorm}' but HEAD probe detected no WAF vendor headers`;
    } else if (detectedNorm !== null && storedNorm === null) {
      verdict = 'WARN';
      reason = `No wafType stored but detected '${detectedNorm}'`;
    } else {
      verdict = 'FAIL';
      reason = `WAF vendor mismatch: stored='${storedNorm}', detected='${detectedNorm}' (Mistake 35)`;
    }

    // Capture relevant headers for evidence
    const relevantHeaders: Record<string, string> = {};
    const headerKeys = ['server', 'cf-ray', 'cf-mitigated', 'x-sucuri-id', 'sg-captcha', 'set-cookie', 'x-iinfo'];
    for (const key of headerKeys) {
      if (result.headers[key]) {
        relevantHeaders[key] = result.headers[key];
      }
    }

    return {
      name: 'wafType',
      verdict,
      expected: storedWafType,
      actual: detectedWafType,
      evidence: { storedWafType, detectedWafType, headers: relevantHeaders, httpStatus: result.status },
      reason,
    };
  } catch (err) {
    return {
      name: 'wafType',
      verdict: 'WARN',
      expected: storedWafType,
      actual: null,
      evidence: { storedWafType, detectedWafType: null, error: String(err) },
      reason: `HEAD probe failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── Library Entry ──────────────────────────────────────────────────────────

export async function verifySiteProfile(
  site: { id: string; domain: string; url: string; siteProfile: unknown },
): Promise<VerificationResult> {
  const startMs = Date.now();
  const profile = (site.siteProfile || {}) as any;
  const siteUrl = site.url.replace(/\/$/, '');

  // Run checks sequentially (anti-ban: each check has internal delays)
  const { check: catalogCheck, urlResults } = await checkCatalogUrls(siteUrl, profile);
  const paginationCheck = await checkPaginationPattern(siteUrl, profile, urlResults);
  const sortCheck = await checkSortParam(siteUrl, profile, urlResults);
  const countCheck = await checkExpectedProductCount(siteUrl, profile);
  const wafCheck = await checkWafType(siteUrl, profile);

  const checks = [catalogCheck, paginationCheck, sortCheck, countCheck, wafCheck];

  return {
    siteId: site.id,
    domain: site.domain,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startMs,
    overallVerdict: worstVerdict(checks),
    checks,
    rawSiteProfile: site.siteProfile,
  };
}

// ─── CLI Entry ──────────────────────────────────────────────────────────────

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: npx tsx backend/scripts/verify-site-profile.ts <domain>');
    console.error('       npx tsx backend/scripts/verify-site-profile.ts --all');
    process.exit(2);
  }

  const OUTPUT_DIR = path.resolve(__dirname, '..', '..', 'docs', 'site-verification');
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  let sites: Array<{ id: string; domain: string; url: string; siteProfile: any }>;

  if (arg === '--all') {
    sites = await prisma.monitoredSite.findMany({
      where: { isEnabled: true },
      select: { id: true, domain: true, url: true, siteProfile: true },
      orderBy: { domain: 'asc' },
    });
    console.log(`\n=== Verifying ${sites.length} enabled sites ===\n`);
  } else {
    // Treat arg as domain
    const domain = arg.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
    const site = await prisma.monitoredSite.findFirst({
      where: { domain },
      select: { id: true, domain: true, url: true, siteProfile: true },
    });
    if (!site) {
      console.error(`Site not found: ${domain}`);
      process.exit(1);
    }
    sites = [site];
  }

  const results: VerificationResult[] = [];

  for (let i = 0; i < sites.length; i++) {
    const site = sites[i];
    console.log(`\n[${i + 1}/${sites.length}] Verifying ${site.domain}...`);

    const result = await verifySiteProfile(site);
    results.push(result);

    // Print console table
    console.log(`  Overall: ${result.overallVerdict} (${result.durationMs}ms)`);
    for (const check of result.checks) {
      const icon = check.verdict === 'PASS' ? '[PASS]' : check.verdict === 'WARN' ? '[WARN]' : '[FAIL]';
      const reasonStr = check.reason ? ` — ${check.reason}` : '';
      console.log(`  ${icon} ${check.name}${reasonStr}`);
    }

    // Write JSON
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const jsonPath = path.join(OUTPUT_DIR, `${site.domain}-${ts}.json`);
    await fs.writeFile(jsonPath, JSON.stringify(result, null, 2));
    console.log(`  Written: ${jsonPath}`);

    // Anti-ban delay between sites
    if (i < sites.length - 1) {
      await delay(2000);
    }
  }

  // Summary table
  if (results.length > 1) {
    console.log('\n=== Summary ===');
    console.log('Domain'.padEnd(35) + 'Verdict'.padEnd(10) + 'Failing Checks');
    console.log('-'.repeat(70));
    for (const r of results) {
      const failing = r.checks.filter(c => c.verdict !== 'PASS').map(c => `${c.name}(${c.verdict})`).join(', ');
      console.log(`${r.domain.padEnd(35)}${r.overallVerdict.padEnd(10)}${failing || 'none'}`);
    }
  }
}

// Only run CLI when this file is the entry point (not when imported as library)
if (require.main === module) {
  main().catch(console.error).finally(() => prisma.$disconnect());
}
