/**
 * Generic, profile-driven product count probe and bootstrap coverage verification.
 * Zero hardcoded platform checks — the site profile tells us HOW to count.
 */
import axios from 'axios';
import * as cheerio from 'cheerio';
import { prisma } from '../lib/prisma';

// ── Types ────────────────────────────────────────────────────────────────────

interface WpRestHeaderMethod {
  method: 'wp-rest-header';
  endpoint: string;   // e.g. '/wp-json/wp/v2/product'
  header: string;     // e.g. 'x-wp-total'
}
interface JsonApiCountMethod {
  method: 'json-api-count';
  endpoint: string;   // e.g. '/products/count.json'
  field: string;      // e.g. 'count'
}
interface JsonApiLengthMethod {
  method: 'json-api-length';
  endpoint: string;   // e.g. '/products.json?limit=250'
  field: string;      // e.g. 'products'
  perPage: number;    // e.g. 250
}
interface HtmlPaginationMethod {
  method: 'html-pagination';
  selector: string;   // CSS selector for last-page link/button OR a text container holding the total ("Results 1 - 40 of 2452")
  perPage: number;    // products per page (e.g. 24). Set to 1 when `regex` extracts the TOTAL directly.
  url?: string;       // path to fetch (e.g. '/firearms/'). Default: origin (homepage).
  regex?: string;     // regex source applied to the selector's text to capture a number. Default '(\\d+)' (first integer).
                      // Use 'of\\s+(\\d+)' to extract from "Results 1 - 40 of 2452" patterns.
}
interface SitemapMethod {
  method: 'sitemap';
  url: string;        // e.g. '/sitemap_products.xml'
}
interface SitemapIndexMethod {
  method: 'sitemap-index';
  urls: string[];     // e.g. ['/media/sitemaps/sitemap_product_001.xml', ...]
}
interface GenericProductSitemapMethod {
  // Filtered sitemap count — only <loc> entries whose URL matches `pattern` count as products.
  // Used on Magento 1 (ellwoodepps), Lightspeed eCom (fulcrum), and other platforms whose
  // single /sitemap.xml mixes category and product URLs. Without a filter the raw <loc> count
  // over-reports (each category page becomes a "product"). Default pattern strips most
  // category URLs by requiring a .html / .htm leaf suffix.
  method: 'generic-product-sitemap';
  url: string;        // e.g. '/sitemap.xml'
  pattern?: string;   // regex source; default '\\.html?(?:$|[?#])'
}
interface EcwidStorefrontSearchMethod {
  // POST to Ecwid's storefront search API. Body is the Ecwid-standard
  // {lang,pagination:{offset,limit}} shape; we read `totalProductsCount` (or whatever
  // `field` is set to) off the JSON response. See generic-retail.ts:588 for the analogous
  // catalog-page fetcher, which discovered the exact request shape via Mistake-31 harness.
  method: 'ecwid-storefront-search';
  endpoint: string;   // e.g. 'https://us-vir2-storefront-api.ecwid.com/storefront/api/v1/<storeId>/catalog/search'
  field?: string;     // default 'totalProductsCount'; dotted path supported
  lang?: string;      // default 'en'
}
interface ShopifyProductsWalkMethod {
  // Walks /products.json?limit=250&page=N until an empty page, deduping by product id
  // across pages. The existing json-api-length method caps at 10 pages and stops on the
  // first short page — neither is correct for Shopify stores with hundreds of pages
  // (e.g. groupepronature, intersurplus). Walk-until-empty + dedupe-by-id is the only
  // safe shape; product positions can shift across requests on a busy store, hence dedupe.
  method: 'shopify-products-walk';
  endpoint?: string;  // default '/products.json'
  perPage?: number;   // default 250 (Shopify max)
  maxPages?: number;  // safety cap; default 500
}
interface KlevuApiCountMethod {
  method: 'klevu-api-count';
  endpoint: string;   // e.g. 'https://uscs33v2.ksearchnet.com/cs/v2/search'
  apiKey: string;     // Klevu API key
}

interface StreamPageCountMethod {
  method: 'stream-page-count';
  // No extra config needed — reads streams from DB streamState,
  // fetches page 1 of each stream to count products, multiplies by totalPages.
  // Last page may have fewer — fetches last page too for exact count.
}

export type ProductCountMethod =
  | WpRestHeaderMethod
  | JsonApiCountMethod
  | JsonApiLengthMethod
  | HtmlPaginationMethod
  | SitemapMethod
  | SitemapIndexMethod
  | GenericProductSitemapMethod
  | EcwidStorefrontSearchMethod
  | ShopifyProductsWalkMethod
  | KlevuApiCountMethod
  | StreamPageCountMethod;

export const COVERAGE_THRESHOLD = 0.95; // 95% — matches verify-maintain-ready.js

// ── Method-name allowlist ────────────────────────────────────────────────────

/**
 * The 11 canonical product-count method names. Any value outside this set
 * usually indicates a drifted site profile (typo, renamed method, stale
 * onboarding doc, etc.). Adding a new method? Add it here AND add a `case`
 * to the switch in `probeExpectedProductCount`.
 */
export const VALID_METHOD_NAMES = [
  'wp-rest-header',
  'json-api-count',
  'json-api-length',
  'html-pagination',
  'sitemap',
  'sitemap-index',
  'generic-product-sitemap',
  'ecwid-storefront-search',
  'shopify-products-walk',
  'klevu-api-count',
  'stream-page-count',
] as const;

/**
 * Throw if `m.method` is not one of the 11 canonical names, or if a sitemap-shape
 * `url` / `urls[]` is absolute instead of path-only. Called at the top of
 * `probeExpectedProductCount` so drifted profiles surface loudly instead of
 * falling into the default branch and silently returning null.
 *
 * Batch-5 R4 additions (2026-05-22):
 *   - C1: sitemap.url and sitemap-index.urls[] MUST start with '/' (path-only).
 *         Absolute URLs collide with `${origin}${m.url}` → double-prefix → fetch
 *         fails silently. Live caught on frontierfirearms.ca R3.
 *   - C2: when an unknown method name is close to a canonical name (substring
 *         match either direction), include "did you mean …?" in the error.
 *         Operators keep writing `wc-store-api-header` for `wp-rest-header`.
 */
export function validateMethod(m: any): void {
  const name = m?.method;
  if (typeof name !== 'string' || !(VALID_METHOD_NAMES as readonly string[]).includes(name)) {
    const valid = VALID_METHOD_NAMES as readonly string[];
    // C2: substring-based close-match suggestion. Cheap, no Levenshtein dep.
    // Underscore-normalize ('wp_rest_header' → 'wp-rest-header'), then look for
    // either-direction substring overlap or a shared trailing token of >=6 chars
    // (e.g. 'wc-store-api-header' ↔ 'wp-rest-header' share 'header').
    let suggestion: string | null = null;
    if (typeof name === 'string' && name.length > 0) {
      const normalized = name.toLowerCase().replace(/_/g, '-');
      for (const canonical of valid) {
        if (normalized === canonical) { suggestion = canonical; break; }
      }
      if (!suggestion) {
        for (const canonical of valid) {
          if (normalized.includes(canonical) || canonical.includes(normalized)) {
            suggestion = canonical;
            break;
          }
          const tail = canonical.split('-').slice(-1)[0];
          if (tail && tail.length >= 6 && normalized.endsWith(tail)) {
            suggestion = canonical;
            break;
          }
        }
      }
    }
    const hint = suggestion ? ` — did you mean "${suggestion}"?` : '';
    throw new Error(
      `[productCountProbe] unknown product-count method: ${JSON.stringify(name)}${hint} ` +
      `(valid: ${VALID_METHOD_NAMES.join(', ')})`
    );
  }

  // C1: sitemap-shape URLs must be path-only so `${origin}${url}` produces a
  // valid absolute URL. Absolute inputs cause double-prefix → silent null.
  if (name === 'sitemap') {
    const url = (m as SitemapMethod).url;
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      throw new Error(
        `[productCountProbe] productCountMethod.url must be path-only (start with /), ` +
        `got absolute URL ${JSON.stringify(url)}`
      );
    }
  } else if (name === 'sitemap-index') {
    const urls = (m as SitemapIndexMethod).urls;
    if (Array.isArray(urls)) {
      for (const u of urls) {
        if (typeof u === 'string' && /^https?:\/\//i.test(u)) {
          throw new Error(
            `[productCountProbe] productCountMethod.urls[] entries must be path-only (start with /), ` +
            `got absolute URL ${JSON.stringify(u)}`
          );
        }
      }
    }
  }
}

export interface CoverageResult {
  dbCount: number;
  expectedCount: number | null;
  ratio: number | null;       // dbCount / expectedCount
  isAcceptable: boolean;      // ratio >= 0.95 OR expectedCount is null
}

// ── Probe ────────────────────────────────────────────────────────────────────

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT = 15_000;

/**
 * Query a site for its total product count using the method specified in the site profile.
 * Returns null if method is null or on any failure.
 */
export async function probeExpectedProductCount(
  siteUrl: string,
  productCountMethod: ProductCountMethod | null,
  options?: { hasWaf?: boolean; siteId?: string },
): Promise<number | null> {
  if (!productCountMethod) return null;

  const origin = new URL(siteUrl).origin;
  // Honor siteProfile.userAgentOverride via resolveUserAgent (falls back to default UA)
  let resolvedUa = UA;
  try {
    const { resolveUserAgent } = await import('./scraper/http-client');
    resolvedUa = resolveUserAgent(new URL(siteUrl).hostname) || UA;
  } catch { /* use fallback */ }
  const headers: Record<string, string> = { 'User-Agent': resolvedUa };

  // WAF cookie support
  if (options?.hasWaf) {
    try {
      const domain = new URL(siteUrl).hostname;
      const { ensureCookies } = await import('./scraper/waf-cookie-manager');
      const creds = await ensureCookies(domain, siteUrl);
      if (creds?.cookies) headers['Cookie'] = creds.cookies;
      if (creds?.userAgent) headers['User-Agent'] = creds.userAgent;
    } catch { /* proceed without cookies */ }
  }

  try {
    const m = productCountMethod;
    // Validate up-front so drifted profiles surface as a clear error instead
    // of silently returning null from the switch's default branch.
    validateMethod(m);

    switch (m.method) {
      case 'wp-rest-header': {
        const url = `${origin}${m.endpoint}?per_page=1`;
        const r = await axios.get(url, { headers, timeout: TIMEOUT, validateStatus: () => true });
        const total = parseInt(r.headers[m.header.toLowerCase()] || '0', 10);
        return total > 0 ? total : null;
      }

      case 'json-api-count': {
        const url = `${origin}${m.endpoint}`;
        const r = await axios.get(url, { headers, timeout: TIMEOUT });
        const val = drillField(r.data, m.field);
        return typeof val === 'number' && val > 0 ? val : null;
      }

      case 'json-api-length': {
        let total = 0;
        let page = 1;
        const maxPages = 10; // safety cap
        while (page <= maxPages) {
          const sep = m.endpoint.includes('?') ? '&' : '?';
          const url = page === 1
            ? `${origin}${m.endpoint}`
            : `${origin}${m.endpoint}${sep}page=${page}`;
          const r = await axios.get(url, { headers, timeout: TIMEOUT });
          const arr = drillField(r.data, m.field);
          if (!Array.isArray(arr) || arr.length === 0) break;
          total += arr.length;
          if (arr.length < m.perPage) break; // last page
          page++;
        }
        return total > 0 ? total : null;
      }

      case 'html-pagination': {
        const url = m.url ? `${origin}${m.url}` : origin;
        const r = await axios.get(url, { headers, timeout: TIMEOUT, validateStatus: () => true });
        const html = typeof r.data === 'string' ? r.data : '';
        const $ = cheerio.load(html);
        const lastPageEl = $(m.selector).last();
        const text = lastPageEl.text().trim() || lastPageEl.attr('href') || '';
        return parseHtmlPaginationCount(text, m.regex, m.perPage);
      }

      case 'sitemap': {
        const url = `${origin}${m.url}`;
        const r = await axios.get(url, { headers, timeout: TIMEOUT, validateStatus: () => true });
        const xml = typeof r.data === 'string' ? r.data : '';
        const count = (xml.match(/<loc>/g) || []).length;
        return count > 0 ? count : null;
      }

      case 'sitemap-index': {
        // Fetch multiple sitemap files and sum <loc> entries across all of them
        let total = 0;
        for (const sitemapUrl of m.urls) {
          const url = sitemapUrl.startsWith('http') ? sitemapUrl : `${origin}${sitemapUrl}`;
          try {
            const r = await axios.get(url, { headers, timeout: 30_000, validateStatus: () => true });
            const xml = typeof r.data === 'string' ? r.data : '';
            total += (xml.match(/<loc>/g) || []).length;
          } catch { /* skip failed sitemap files */ }
        }
        return total > 0 ? total : null;
      }

      case 'generic-product-sitemap': {
        // Filtered sitemap: extract every <loc>...</loc> then keep only entries whose URL
        // matches the supplied (or default) regex. Default targets .html / .htm leaf URLs,
        // which on Magento 1 and Lightspeed eCom reliably excludes category pages.
        const url = `${origin}${m.url}`;
        const r = await axios.get(url, { headers, timeout: 30_000, validateStatus: () => true });
        const xml = typeof r.data === 'string' ? r.data : '';
        const patternSrc = m.pattern || '\\.html?(?:$|[?#])';
        let rx: RegExp;
        try {
          rx = new RegExp(patternSrc, 'i');
        } catch {
          console.warn(`[productCountProbe] generic-product-sitemap: bad pattern '${patternSrc}' — returning null`);
          return null;
        }
        const locRx = /<loc>([^<]+)<\/loc>/g;
        let count = 0;
        let match: RegExpExecArray | null;
        while ((match = locRx.exec(xml)) !== null) {
          if (rx.test(match[1])) count++;
        }
        return count > 0 ? count : null;
      }

      case 'ecwid-storefront-search': {
        // POST the standard Ecwid storefront search body with limit:1 — the response
        // carries the total in `totalProductsCount` (override via `field`). Request shape
        // matches what generic-retail.ts:_fetchEcwidStorefrontPage builds at runtime.
        const body = {
          lang: m.lang || 'en',
          pagination: { offset: 0, limit: 1 },
        };
        const r = await axios.post(m.endpoint, body, {
          timeout: TIMEOUT,
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/json',
            ...headers,
          },
          validateStatus: () => true,
        });
        const field = m.field || 'totalProductsCount';
        const val = drillField(r.data, field);
        return typeof val === 'number' && val > 0 ? val : null;
      }

      case 'shopify-products-walk': {
        // Walk /products.json?limit=N&page=K, deduping product IDs across pages.
        // Stop conditions: empty page, max-pages cap, or HTTP error.
        const endpointPath = m.endpoint || '/products.json';
        const perPage = m.perPage || 250;
        const maxPages = m.maxPages || 500;
        const seen = new Set<number | string>();
        let page = 1;
        while (page <= maxPages) {
          const sep = endpointPath.includes('?') ? '&' : '?';
          const url = `${origin}${endpointPath}${sep}limit=${perPage}&page=${page}`;
          let r;
          try {
            r = await axios.get(url, { headers, timeout: TIMEOUT, validateStatus: () => true });
          } catch {
            break;
          }
          if (r.status !== 200) break;
          const arr = Array.isArray(r.data?.products) ? r.data.products : null;
          if (!arr || arr.length === 0) break;
          for (const p of arr) {
            const id = p?.id;
            if (id !== undefined && id !== null) seen.add(id);
          }
          if (arr.length < perPage) break; // last page
          page++;
        }
        return seen.size > 0 ? seen.size : null;
      }

      case 'klevu-api-count': {
        // Self-heal the Klevu key before probing (key may have rotated upstream)
        if (!options?.siteId) return null;
        const { resolveKlevuKey } = await import('./scraper/klevu-key-resolver');
        const resolvedKey = await resolveKlevuKey(options.siteId, siteUrl, {
          hasWaf: options.hasWaf || false,
        });
        if (!resolvedKey) {
          console.log(`[ProductCountProbe] klevu-api-count: no working key for ${origin}`);
          return null;
        }
        // Query the Klevu search API for total product count
        const r = await axios.post(m.endpoint, {
          context: { apiKeys: [resolvedKey] },
          recordQueries: [{
            id: 'count',
            typeOfRequest: 'SEARCH',
            settings: {
              query: { term: '*' },
              limit: 1,
              offset: 0,
              sort: 'RELEVANCE',
              typeOfRecords: ['KLEVU_PRODUCT'],
            },
          }],
        }, { timeout: TIMEOUT, headers: { 'Content-Type': 'application/json' } });
        const qr = r.data?.queryResults?.[0];
        const total = qr?.meta?.totalResultsFound;
        return typeof total === 'number' && total > 0 ? total : null;
      }

      case 'stream-page-count': {
        // Crawl ALL catalog pages, extract product URLs, deduplicate by a stable per-product KEY.
        // A product may appear in multiple categories with different URL strings (e.g. OpenCart
        // appends a category path: `?product_id=12511&path=28` vs `?product_id=12511&path=425`).
        // URL-string dedup over-counts; we extract `?product_id=N` when present and use that as
        // the key, otherwise fall back to the URL itself.
        if (!options?.siteId) return null;
        const site = await prisma.monitoredSite.findUnique({
          where: { id: options.siteId },
          select: { siteProfile: true },
        });
        const siteProfile = site?.siteProfile as any;
        const catalogUrls: string[] = siteProfile?.catalogUrls || [];
        if (catalogUrls.length === 0) return null;

        const { getAdapterForUrl } = await import('./scraper/adapter-registry');
        const { adapter } = await getAdapterForUrl(siteUrl);
        if (!adapter.extractCatalogProducts) return null;

        const allProductKeys = new Set<string>();
        let abortedCatalogs = 0; // track catalogs that didn't finish their walk cleanly

        // Stable product-key extractor. OpenCart-style `?product_id=N` is the most common
        // cross-cat collision case; for other platforms the URL itself is stable.
        const productKey = (url: string): string => {
          const pidMatch = url.match(/[?&]product_id=(\d+)/);
          if (pidMatch) return `pid:${pidMatch[1]}`;
          return url;
        };

        for (const rawUrl of catalogUrls) {
          const catalogUrl = rawUrl.startsWith('http') ? rawUrl : `${origin}${rawUrl}`;
          let currentUrl: string | null = catalogUrl;
          let pageNum = 1;
          let catalogClean = false; // true when the walk terminated at a natural end (no next page / empty page)
          const MAX_PAGES_PER_CATALOG = 200; // safety cap (liangjian has 127 pages)

          while (currentUrl && pageNum <= MAX_PAGES_PER_CATALOG) {
            try {
              let html = '';
              if (options?.hasWaf) {
                const { fetchWithPlaywright } = await import('./scraper/playwright-fetcher');
                const result = await fetchWithPlaywright(currentUrl, { timeout: 30000 });
                html = result.html;
              } else {
                const r = await axios.get(currentUrl, { headers, timeout: TIMEOUT, validateStatus: () => true });
                html = typeof r.data === 'string' ? r.data : '';
              }
              if (html.length < 500) { catalogClean = true; break; }

              const $ = cheerio.load(html);
              const products = adapter.extractCatalogProducts($, currentUrl);
              if (products.length === 0) { catalogClean = true; break; }

              for (const p of products) {
                if (p.url) allProductKeys.add(productKey(p.url));
              }

              // Find next page
              const nextPageUrl: string | null = adapter.getNextPageUrl?.($, currentUrl) ?? null;
              if (nextPageUrl && nextPageUrl !== currentUrl) {
                currentUrl = nextPageUrl.startsWith('http') ? nextPageUrl : `${origin}${nextPageUrl}`;
                pageNum++;
              } else {
                catalogClean = true;
                break;
              }
            } catch (e) {
              // Mid-walk error (rate-limit, timeout, parse failure). DO NOT mark clean — the
              // count is partial. Warn so operators don't trust the number.
              const msg = e instanceof Error ? e.message : String(e);
              console.warn(`[ProductCountProbe] stream-page-count: walk of ${catalogUrl} aborted at page ${pageNum} — ${msg.substring(0, 100)}`);
              break;
            }

            await new Promise(r => setTimeout(r, 500)); // rate limit between pages
          }

          if (pageNum > MAX_PAGES_PER_CATALOG) {
            console.warn(`[ProductCountProbe] stream-page-count: walk of ${catalogUrl} hit MAX_PAGES_PER_CATALOG=${MAX_PAGES_PER_CATALOG} — count is partial`);
          } else if (!catalogClean) {
            abortedCatalogs++;
          }

          await new Promise(r => setTimeout(r, 1000)); // rate limit between catalog URLs
        }

        const count = allProductKeys.size;

        // Partial-result warning: if any catalog walks aborted mid-walk, the count is unreliable.
        if (abortedCatalogs > 0) {
          console.warn(
            `[ProductCountProbe] WARNING: stream-page-count returned PARTIAL count ${count} for ${siteUrl} — ` +
            `${abortedCatalogs}/${catalogUrls.length} catalog walks aborted before reaching last page. ` +
            `Coverage gate should not trust this number as ground truth.`
          );
        }

        // Sanity check: if we found very few products but the site is expected to have many,
        // something is likely wrong (missing selectors, WAF blocking, pagination broken)
        if (count > 0 && count < 30) {
          const expected = siteProfile?.expectedProductCount;
          if (expected && expected > 500) {
            console.warn(
              `[ProductCountProbe] WARNING: stream-page-count found only ${count} products ` +
              `for ${siteUrl} (expected ~${expected}). Possible selector/pagination bug.`
            );
          }
        }

        return count > 0 ? count : null;
      }

      default: {
        // Cast to any — unknown method names from siteProfile drift land here. Surface them.
        const unknownMethod = (m as any)?.method;
        console.warn(`[productCountProbe] unknown method '${unknownMethod}' — returning null`);
        return null;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ProductCountProbe] ${siteUrl}: probe failed — ${msg.substring(0, 80)}`);
    return null;
  }
}

// ── Coverage Verification ────────────────────────────────────────────────────

/**
 * Compare DB product count against expected count.
 * Used by the bootstrap worker to decide if a cycle truly completed.
 */
export async function verifyBootstrapCoverage(
  siteId: string,
  siteUrl: string,
  productCountMethod: ProductCountMethod | null,
  expectedProductCount: number | null,
  options?: { hasWaf?: boolean },
): Promise<CoverageResult> {
  const dbCount = await prisma.productIndex.count({ where: { siteId, isActive: true } });

  // Use stored count or probe fresh
  let expectedCount = expectedProductCount;
  if (expectedCount === null && productCountMethod) {
    expectedCount = await probeExpectedProductCount(siteUrl, productCountMethod, options);
  }

  const ratio = expectedCount !== null && expectedCount > 0
    ? dbCount / expectedCount
    : null;

  const isAcceptable = expectedCount === null || ratio === null || ratio >= COVERAGE_THRESHOLD;

  return { dbCount, expectedCount, ratio, isAcceptable };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse a captured integer (page-count OR product-total) out of a selector's text,
 * then multiply by `perPage`. Set `perPage=1` when the captured number IS the total
 * (e.g. regex `of\\s+(\\d[\\d,]*)` against "Results 1 - 40 of 2,452").
 *
 * Strips commas BEFORE parseInt — `parseInt("2,384", 10)` returns 2, which silently
 * broke canadasgunstore for ~6 weeks (real total 2384, recorded 2). The default
 * regex `(\\d+)` only matches contiguous digits and would itself drop the comma,
 * so commas only matter when callers use a comma-tolerant capture like
 * `(\\d[\\d,]*)` — supporting it here makes both shapes correct.
 *
 * Returns null on bad regex, no match, or a zero/negative value.
 */
export function parseHtmlPaginationCount(
  text: string,
  regexSrc: string | undefined,
  perPage: number,
): number | null {
  let rx: RegExp;
  try {
    rx = new RegExp(regexSrc || '(\\d+)');
  } catch {
    console.warn(`[productCountProbe] html-pagination: bad regex '${regexSrc}' — returning null`);
    return null;
  }
  const matched = text.match(rx);
  const raw = matched?.[1] || '0';
  const n = parseInt(raw.replace(/,/g, ''), 10);
  if (n > 0) return n * perPage;
  return null;
}

/** Drill into a nested object by dot-separated path (e.g. "data.products" → obj.data.products) */
function drillField(obj: any, path: string): any {
  const parts = path.split('.');
  let val = obj;
  for (const part of parts) {
    if (val == null) return undefined;
    val = val[part];
  }
  return val;
}
