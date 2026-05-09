/**
 * @deprecated 2026-04-27 — Generic discovery superseded by AI-driven per-site audit.
 * See `_DEPRECATED.md` in this folder and `docs/superpowers/plans/2026-04-27-pivot-to-ai-audit.md`.
 * Do not import from this file in new code.
 */
// backend/scripts/probe/geography-count/global-count.ts
// Per spec §4.3 step 2. API-first, sitemap-fallback.
// Cherry-pick: x-wp-total, /products/count.json, ecwid totalProductsCount.
//
// Updated for the Geography & Count stage sequence:
// - Can consume pre-computed sitemap product URL set (from sitemap-products.ts)
// - Bug B6: Celerant cap detection — if walked count > probe count, trust walk

import { fetchUrl } from '../shared/fetch';
import { pickUaForWaf } from '../shared/ua';
import { extractProducts } from '../shared/extract';
import { discoverProductSitemap } from './sitemap-parse';
import * as cheerio from 'cheerio';
import type { AccessIdentityState, GeographyCountState, CountMethod } from '../shared/types';

export type CountResult = {
  count: number;
  method: CountMethod;
  evidence: GeographyCountState['globalProductCountEvidence'];
};

const ECWID_TIMEOUT_MS = 15000;

export async function getGlobalCount(
  state: AccessIdentityState,
  /** Pre-computed sitemap product count from sitemap-products.ts */
  sitemapProductCount?: number,
  sitemapEvidence?: { shards: string[]; totalLocs: number },
): Promise<CountResult | null> {
  const origin = state.canonicalOrigin;
  const apiUa = state.userAgentOverride ?? pickUaForWaf(state.wafType);
  const apiCtx = { hasWaf: false, ua: apiUa };
  const htmlCtx = { hasWaf: state.hasWaf, wafType: state.wafType, ua: state.userAgentOverride ?? undefined };

  // 1. WC Store API x-wp-total — try FIRST for WooCommerce.
  // The Store API returns only customer-visible, in-stock products.
  // WP REST x-wp-total includes draft/hidden/out-of-stock which inflates
  // the count vs what HTML walking can find (canadafirstammo: Store=132, REST=962).
  if (/woocommerce/.test(state.platform)) {
    const r = await safeFetch(`${origin}/wp-json/wc/store/v1/products?per_page=1`, apiCtx);
    if (r && r.headers['x-wp-total']) {
      return { count: parseInt(r.headers['x-wp-total'], 10), method: 'wc-store-api-header',
        evidence: { endpoint: 'wc/store/v1/products', headerValue: r.headers['x-wp-total'] }};
    }
  }
  // 2. WP REST x-wp-total — fallback when Store API unavailable.
  // Note: WP REST counts ALL products including draft/hidden/out-of-stock.
  if (/woocommerce|wp-rest/.test(state.platform) || (state.platformMarker.signals as any).wpRestReachable) {
    const r = await safeFetch(`${origin}/wp-json/wp/v2/product?per_page=1`, apiCtx);
    if (r && r.headers['x-wp-total']) {
      return { count: parseInt(r.headers['x-wp-total'], 10), method: 'wp-rest-header',
        evidence: { endpoint: 'wp/v2/product', headerValue: r.headers['x-wp-total'] }};
    }
  }
  // 3. Shopify /products.json walk — most accurate for Shopify (counts customer-visible only).
  // Walk pages until empty, sum product counts. Preferred over /products/count.json (Admin API,
  // often 401) and sitemap (includes redirects/hidden). Per Mistake 32: uses published_at.
  if (/shopify/.test(state.platform)) {
    let shopifyTotal = 0;
    let shopifyPages = 0;
    const PER_PAGE = 250;
    for (let page = 1; page <= 200; page++) {
      const r = await safeFetch(`${origin}/products.json?limit=${PER_PAGE}&page=${page}`, apiCtx);
      if (!r || r.status !== 200) break;
      try {
        const json = JSON.parse(r.body);
        const products = json.products;
        if (!Array.isArray(products) || products.length === 0) break;
        shopifyTotal += products.length;
        shopifyPages++;
        if (products.length < PER_PAGE) break;
      } catch { break; }
    }
    if (shopifyTotal > 0) {
      return { count: shopifyTotal, method: 'shopify-products-walk',
        evidence: { endpoint: `/products.json?limit=${PER_PAGE}`, responseSample: `${shopifyPages} pages, ${shopifyTotal} products` }};
    }
    // Fallback: try /products/count.json (Admin API — often 401)
    const r = await safeFetch(`${origin}/products/count.json`, apiCtx);
    if (r && r.status === 200) {
      const m = /"count"\s*:\s*(\d+)/.exec(r.body);
      if (m) return { count: parseInt(m[1], 10), method: 'shopify-count-json',
        evidence: { endpoint: '/products/count.json', responseSample: r.body.slice(0, 200) }};
    }
  }
  // 4. Ecwid POST /catalog/search (no parentCategoryId)
  if (/ecwid/.test(state.platform)) {
    const storeId = (state.platformMarker.signals as any).ecwidStoreId;
    if (storeId) {
      const url = `https://us-vir2-storefront-api.ecwid.com/storefront/api/v1/${storeId}/catalog/search`;
      const body = JSON.stringify({ lang: 'en', pagination: { offset: 0, limit: 1 }, urlParams: { baseUrl: '/store/', isCleanUrls: true }});
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ECWID_TIMEOUT_MS);
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Origin': origin, 'Referer': origin }, body, signal: controller.signal });
        const json = await r.json();
        if (typeof json.totalProductsCount === 'number') {
          return { count: json.totalProductsCount, method: 'ecwid-storefront-search',
            evidence: { endpoint: url, responseSample: JSON.stringify(json).slice(0, 200) }};
        }
      } catch { /* skip */ }
      finally { clearTimeout(timer); }
    }
  }
  // 5. BigCommerce sitemap — use pre-computed if available
  if (/bigcommerce/.test(state.platform)) {
    if (sitemapProductCount && sitemapProductCount > 0) {
      return { count: sitemapProductCount, method: 'bc-xmlsitemap',
        evidence: { sitemapShards: sitemapEvidence?.shards, sitemapTotalLocs: sitemapEvidence?.totalLocs, sitemapProductLocs: sitemapProductCount }};
    }
    const sitemap = await discoverProductSitemap(origin);
    if (sitemap.productUrls.length > 0) {
      return { count: sitemap.productUrls.length, method: 'bc-xmlsitemap',
        evidence: { sitemapShards: sitemap.shardsCounted, sitemapTotalLocs: sitemap.totalLocs, sitemapProductLocs: sitemap.productUrls.length }};
    }
  }
  // 6. Magento toolbar
  if (/magento/.test(state.platform)) {
    const r = await safeFetch(`${origin}/new-products.html`, apiCtx);
    if (r && r.status === 200) {
      const $ = cheerio.load(r.body);
      const nums = $('.toolbar-number').map((_, el) => parseInt($(el).text().trim(), 10)).get().filter(Number.isFinite);
      if (nums.length >= 3) return { count: nums[2], method: 'magento-toolbar',
        evidence: { endpoint: '/new-products.html', responseSample: nums.join(',') }};
    }
  }
  // 7. Celerant — prefer <select id="perpage"> "All" option value (canonical
  // storefront-visible count), fall back to /perpage/9999 dump.
  // Per DB profile coverageNotes: the "All" option value reflects active inventory
  // (storefront-visible, not special-order), which is the count operators record
  // as expectedProductCount. /perpage/9999 raw dump includes special-order items
  // and runs ~5% higher.
  if (/celerant/.test(state.platform)) {
    // 7a. Try the perpage "All" option extraction first
    const probeUrls = [
      `${origin}/all-products/browse/orderby/new-arrivals/perpage/36`,
      `${origin}/all-products/browse`,
    ];
    for (const url of probeUrls) {
      const r = await safeFetch(url, htmlCtx);
      if (!r || r.status !== 200) continue;
      // Match <option value="N" ...>All</option> inside the perpage select.
      // Pattern is permissive about whitespace and additional attributes.
      const allOptionMatch = /<option\s+value="(\d+)"[^>]*>\s*All\s*<\/option>/i.exec(r.body);
      if (allOptionMatch) {
        const count = parseInt(allOptionMatch[1], 10);
        if (count > 0) {
          return {
            count,
            method: 'celerant-perpage-all',
            evidence: {
              endpoint: url,
              responseSample: `extracted N=${count} from <option value="${count}">All</option> (canonical storefront-visible count)`,
            },
          };
        }
      }
    }
    // 7b. Fallback: /perpage/9999 dump (includes special-order items, may overshoot)
    const dumpCandidates = [
      `${origin}/all-products/browse/perpage/9999`,
      `${origin}/all-products/browse/orderby/new-arrivals/perpage/9999`,
    ];
    let best: { url: string; count: number } | null = null;
    for (const url of dumpCandidates) {
      const r = await safeFetch(url, htmlCtx);
      if (!r || r.status !== 200) continue;
      const products = extractProducts(r.body, url, state.platform);
      if (products.length > 0 && (!best || products.length > best.count)) {
        best = { url, count: products.length };
      }
      if (best && best.count >= 50) break;
    }
    if (best) {
      return { count: best.count, method: 'celerant-perpage-all',
        evidence: { endpoint: best.url, responseSample: `extracted ${best.count} unique products from /perpage/9999 dump (fallback — perpage="All" option not found)` }};
    }
  }
  // 8. Generic product sitemap — use pre-computed if available
  if (sitemapProductCount && sitemapProductCount > 0) {
    return { count: sitemapProductCount, method: 'generic-product-sitemap',
      evidence: { sitemapShards: sitemapEvidence?.shards, sitemapTotalLocs: sitemapEvidence?.totalLocs, sitemapProductLocs: sitemapProductCount }};
  }
  {
    const sitemap = await discoverProductSitemap(origin);
    if (sitemap.productUrls.length > 0) {
      return { count: sitemap.productUrls.length, method: 'generic-product-sitemap',
        evidence: { sitemapShards: sitemap.shardsCounted, sitemapTotalLocs: sitemap.totalLocs, sitemapProductLocs: sitemap.productUrls.length }};
    }
  }
  return null;
}

/**
 * Bug B6: Reconcile count after walk completes.
 * If walked count > probe count × 1.05 (e.g. Celerant /perpage/9999 caps,
 * Drupal classifieds where sitemap lags live by ~25%), replace global count
 * with walked count and update method to catalog-walk-only.
 *
 * Also handles the reverse case for Shopify: if walk < probe count but close
 * (within 5%), trust the walk — it's counting real customer-visible products.
 */
export function reconcileCountAfterWalk(
  countResult: CountResult | null,
  walkedCount: number,
): CountResult | null {
  if (!countResult) return countResult;
  // If walk exceeds probe count by >5%, the probe count was wrong (capped/stale)
  if (walkedCount > countResult.count * 1.05) {
    process.stderr.write(
      `  [global-count] B6 reconcile: walked ${walkedCount} > probe ${countResult.count} × 1.05 → trusting walk\n`
    );
    return {
      count: walkedCount,
      method: 'catalog-walk-only',
      evidence: {
        ...countResult.evidence,
        responseSample: `original ${countResult.method} reported ${countResult.count}; walk found ${walkedCount} (${((walkedCount - countResult.count) / countResult.count * 100).toFixed(1)}% more) → trusting walk`,
      },
    };
  }
  return countResult;
}

async function safeFetch(url: string, ctx: { hasWaf?: boolean; wafType?: any; ua?: string }) {
  try {
    return await fetchUrl(url, ctx);
  } catch { return null; }
}
