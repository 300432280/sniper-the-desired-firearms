// backend/scripts/probe/room3-geography-count/global-count.ts
// Per spec §4.3 step 2. API-first, sitemap-fallback.
// Cherry-pick: x-wp-total, /products/count.json, ecwid totalProductsCount.

import { fetchUrl } from '../shared/fetch';
import { pickUaForWaf } from '../shared/ua';
import { extractProducts } from '../shared/extract';
import { discoverProductSitemap } from './sitemap-parse';
import * as cheerio from 'cheerio';
import type { AccessIdentityState, GeographyCountState, CountMethod } from '../shared/types';

type CountResult = {
  count: number;
  method: CountMethod;
  evidence: GeographyCountState['globalProductCountEvidence'];
};

const ECWID_TIMEOUT_MS = 15000;

export async function getGlobalCount(state: AccessIdentityState): Promise<CountResult | null> {
  const origin = state.canonicalOrigin;
  // API endpoints (/wp-json, /products/count.json, /new-products.html toolbar) are
  // JSON or page-fragment endpoints that WAFs typically don't challenge — they
  // protect HTML. Forcing axios (hasWaf:false) preserves response headers
  // (x-wp-total) which Playwright's `page.content()` strips. The state's WAF UA
  // override is still applied for vendor-specific rules (Sucuri/sgcaptcha/iPhone).
  // Per audit history Site 4 doctordeals: plain axios with iPhone UA gets
  // x-wp-total: 965 cleanly on a Sucuri-WAF site — same pattern applies here.
  const apiUa = state.userAgentOverride ?? pickUaForWaf(state.wafType);
  const apiCtx = { hasWaf: false, ua: apiUa };
  // HTML-page-fragment endpoints (Celerant ?perpage=All catalog dump) need
  // the WAF-aware ctx so CF/Sucuri/Incapsula sites route through Playwright
  // — the page can be ~2MB of products, not a JSON header response.
  const htmlCtx = { hasWaf: state.hasWaf, wafType: state.wafType, ua: state.userAgentOverride ?? undefined };

  // 1. WP REST x-wp-total
  if (/woocommerce|wp-rest/.test(state.platform) || (state.platformMarker.signals as any).wpRestReachable) {
    const r = await safeFetch(`${origin}/wp-json/wp/v2/product?per_page=1`, apiCtx);
    if (r && r.headers['x-wp-total']) {
      return { count: parseInt(r.headers['x-wp-total'], 10), method: 'wp-rest-header',
        evidence: { endpoint: 'wp/v2/product', headerValue: r.headers['x-wp-total'] }};
    }
  }
  // 2. WC Store API x-wp-total
  if (/woocommerce/.test(state.platform)) {
    const r = await safeFetch(`${origin}/wp-json/wc/store/v1/products?per_page=1`, apiCtx);
    if (r && r.headers['x-wp-total']) {
      return { count: parseInt(r.headers['x-wp-total'], 10), method: 'wc-store-api-header',
        evidence: { endpoint: 'wc/store/v1/products', headerValue: r.headers['x-wp-total'] }};
    }
  }
  // 3. Shopify /products/count.json
  if (/shopify/.test(state.platform)) {
    const r = await safeFetch(`${origin}/products/count.json`, apiCtx);
    if (r && r.status === 200) {
      const m = /"count"\s*:\s*(\d+)/.exec(r.body);
      if (m) return { count: parseInt(m[1], 10), method: 'shopify-count-json',
        evidence: { endpoint: '/products/count.json', responseSample: r.body.slice(0, 200) }};
    }
  }
  // 4. Ecwid POST /catalog/search (no parentCategoryId).
  // Ecwid API is a 3rd-party endpoint (us-vir2-storefront-api.ecwid.com) that
  // doesn't share the merchant's WAF, so raw fetch is correct here — but it
  // needs an explicit timeout (raw fetch has none, would hang forever on
  // network issues). Project standard fetchUrl uses 30s; 15s here matches
  // sitemap-parse (XML/JSON endpoints should be fast).
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
      } catch { /* skip — timeout, network, or parse error */ }
      finally { clearTimeout(timer); }
    }
  }
  // 5. BigCommerce sitemap (Task 4.1 discoverProductSitemap discovers and dedupes shards).
  if (/bigcommerce/.test(state.platform)) {
    const sitemap = await discoverProductSitemap(origin);
    if (sitemap.productUrls.length > 0) {
      return { count: sitemap.productUrls.length, method: 'bc-xmlsitemap',
        evidence: { sitemapShards: sitemap.shardsCounted, sitemapTotalLocs: sitemap.totalLocs, sitemapProductLocs: sitemap.productUrls.length }};
    }
  }
  // 6. Magento toolbar amount on /new-products.html.
  // Page-fragment endpoint — Magento renders .toolbar-number 3× per page (top
  // header, top pagination, bottom pagination); the 3rd occurrence is the total.
  // Per audit history Site 23 rdsc.ca: this method gives 9,089 vs sitemap 9,020.
  if (/magento/.test(state.platform)) {
    const r = await safeFetch(`${origin}/new-products.html`, apiCtx);
    if (r && r.status === 200) {
      const $ = cheerio.load(r.body);
      const nums = $('.toolbar-number').map((_, el) => parseInt($(el).text().trim(), 10)).get().filter(Number.isFinite);
      if (nums.length >= 3) return { count: nums[2], method: 'magento-toolbar',
        evidence: { endpoint: '/new-products.html', responseSample: nums.join(',') }};
    }
  }
  // 7. Celerant path-style /perpage/N (per spec §4.3 priority 8).
  // Celerant's stock catalog browser at /all-products/browse/ uses PATH-style
  // params, not query-style: `/orderby/<value>/perpage/<n>`. The spec's
  // `?perpage=All` description is misleading — Celerant ignores query params
  // here. Per audit Site 2 bullseyenorth: canonical catalog URL is
  // `/all-products/browse/orderby/new-arrivals/perpage/36` walked across
  // 85 pages = ~3,059 products. For COUNT (one fetch), try `/perpage/9999`
  // (path-style) which returns the entire inventory if the site allows it,
  // OR walk-to-empty if perpage caps. Run production extractor via
  // shared/extract.ts (a.product selector matches Celerant cards).
  // Generic — /all-products/browse/ is the stock Celerant catalog URL.
  // Note: Celerant servers send malformed headers (X-Frame-Options trailing
  // space — Mistake 36); shared/fetch.ts's HPE_INVALID_HEADER_TOKEN catch
  // falls back to native fetch which is lenient.
  if (/celerant/.test(state.platform)) {
    // Try path-style with a very large perpage first — works on most Celerant
    // installs that don't cap perpage. Falls back to /orderby/new-arrivals/perpage/9999.
    const candidates = [
      `${origin}/all-products/browse/perpage/9999`,
      `${origin}/all-products/browse/orderby/new-arrivals/perpage/9999`,
    ];
    let best: { url: string; count: number } | null = null;
    for (const url of candidates) {
      const r = await safeFetch(url, htmlCtx);
      if (!r || r.status !== 200) continue;
      const products = extractProducts(r.body, url, state.platform);
      if (products.length > 0 && (!best || products.length > best.count)) {
        best = { url, count: products.length };
      }
      // Early-exit if we got a substantial inventory dump (>50 products
      // strongly suggests perpage worked — featured-only pages return ~10).
      if (best && best.count >= 50) break;
    }
    if (best) {
      return { count: best.count, method: 'celerant-perpage-all',
        evidence: { endpoint: best.url, responseSample: `extracted ${best.count} unique products from /perpage/9999 dump` }};
    }
  }
  // 8. Generic product sitemap (last sitemap-based attempt — covers Drupal,
  // Wix, custom platforms; Klevu sites currently fall here too — Phase 8 task).
  {
    const sitemap = await discoverProductSitemap(origin);
    if (sitemap.productUrls.length > 0) {
      return { count: sitemap.productUrls.length, method: 'generic-product-sitemap',
        evidence: { sitemapShards: sitemap.shardsCounted, sitemapTotalLocs: sitemap.totalLocs, sitemapProductLocs: sitemap.productUrls.length }};
    }
  }
  return null;
}

async function safeFetch(url: string, ctx: { hasWaf?: boolean; wafType?: any; ua?: string }) {
  try {
    return await fetchUrl(url, ctx);
  } catch { return null; }
}
