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
  selector: string;   // CSS selector for last-page link/button
  perPage: number;    // products per page (e.g. 24)
}
interface SitemapMethod {
  method: 'sitemap';
  url: string;        // e.g. '/sitemap_products.xml'
}
interface SitemapIndexMethod {
  method: 'sitemap-index';
  urls: string[];     // e.g. ['/media/sitemaps/sitemap_product_001.xml', ...]
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
  | KlevuApiCountMethod
  | StreamPageCountMethod;

export const COVERAGE_THRESHOLD = 0.95; // 95% — matches verify-maintain-ready.js

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
  const headers: Record<string, string> = { 'User-Agent': UA };

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
        const url = origin;
        const r = await axios.get(url, { headers, timeout: TIMEOUT, validateStatus: () => true });
        const html = typeof r.data === 'string' ? r.data : '';
        const $ = cheerio.load(html);
        const lastPageEl = $(m.selector).last();
        const text = lastPageEl.text().trim() || lastPageEl.attr('href') || '';
        const pageNum = parseInt(text.match(/(\d+)/)?.[1] || '0', 10);
        if (pageNum > 0) return pageNum * m.perPage;
        return null;
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

      case 'klevu-api-count': {
        // Query the Klevu search API for total product count
        const r = await axios.post(m.endpoint, {
          context: { apiKeys: [m.apiKey] },
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
        // Crawl ALL catalog pages, extract product URLs, deduplicate via Set.
        // A product may appear in multiple categories — the Set ensures each URL is counted once.
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

        const allProductUrls = new Set<string>();

        for (const rawUrl of catalogUrls) {
          const catalogUrl = rawUrl.startsWith('http') ? rawUrl : `${origin}${rawUrl}`;
          let currentUrl: string | null = catalogUrl;
          let pageNum = 1;
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
              if (html.length < 500) break;

              const $ = cheerio.load(html);
              const products = adapter.extractCatalogProducts($, currentUrl);
              if (products.length === 0) break;

              for (const p of products) {
                if (p.url) allProductUrls.add(p.url);
              }

              // Find next page
              const nextPageUrl: string | null = adapter.getNextPageUrl?.($, currentUrl) ?? null;
              if (nextPageUrl && nextPageUrl !== currentUrl) {
                currentUrl = nextPageUrl.startsWith('http') ? nextPageUrl : `${origin}${nextPageUrl}`;
                pageNum++;
              } else {
                break;
              }
            } catch {
              break;
            }

            await new Promise(r => setTimeout(r, 500)); // rate limit between pages
          }

          await new Promise(r => setTimeout(r, 1000)); // rate limit between catalog URLs
        }

        const count = allProductUrls.size;

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

      default:
        return null;
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
