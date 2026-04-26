// backend/scripts/probe/room3-geography-count/global-count.ts
// Per spec §4.3 step 2. API-first, sitemap-fallback.
// Cherry-pick: x-wp-total, /products/count.json, ecwid totalProductsCount.

import { fetchUrl } from '../shared/fetch';
import { discoverProductSitemap } from './sitemap-parse';
import * as cheerio from 'cheerio';
import type { AccessIdentityState, GeographyCountState, CountMethod } from '../shared/types';

type CountResult = {
  count: number;
  method: CountMethod;
  evidence: GeographyCountState['globalProductCountEvidence'];
};

export async function getGlobalCount(state: AccessIdentityState): Promise<CountResult | null> {
  const origin = state.canonicalOrigin;
  const ua = state.userAgentOverride ?? undefined;
  const ctx = { hasWaf: state.hasWaf, wafType: state.wafType, ua };

  // 1. WP REST x-wp-total
  if (/woocommerce|wp-rest/.test(state.platform) || (state.platformMarker.signals as any).wpRestReachable) {
    const r = await safeFetch(`${origin}/wp-json/wp/v2/product?per_page=1`, ctx);
    if (r && r.headers['x-wp-total']) {
      return { count: parseInt(r.headers['x-wp-total'], 10), method: 'wp-rest-header',
        evidence: { endpoint: 'wp/v2/product', headerValue: r.headers['x-wp-total'] }};
    }
  }
  // 2. WC Store API x-wp-total
  if (/woocommerce/.test(state.platform)) {
    const r = await safeFetch(`${origin}/wp-json/wc/store/v1/products?per_page=1`, ctx);
    if (r && r.headers['x-wp-total']) {
      return { count: parseInt(r.headers['x-wp-total'], 10), method: 'wc-store-api-header',
        evidence: { endpoint: 'wc/store/v1/products', headerValue: r.headers['x-wp-total'] }};
    }
  }
  // 3. Shopify /products/count.json
  if (/shopify/.test(state.platform)) {
    const r = await safeFetch(`${origin}/products/count.json`, ctx);
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
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Origin': origin, 'Referer': origin }, body });
        const json = await r.json();
        if (typeof json.totalProductsCount === 'number') {
          return { count: json.totalProductsCount, method: 'ecwid-storefront-search',
            evidence: { endpoint: url, responseSample: JSON.stringify(json).slice(0, 200) }};
        }
      } catch { /* skip */ }
    }
  }
  // 5. BigCommerce sitemap (/xmlsitemap.php?type=products)
  if (/bigcommerce/.test(state.platform)) {
    const sitemap = await discoverProductSitemap(origin);
    if (sitemap.productUrls.length > 0) {
      return { count: sitemap.productUrls.length, method: 'bc-xmlsitemap',
        evidence: { sitemapShards: sitemap.shardsCounted, sitemapTotalLocs: sitemap.totalLocs, sitemapProductLocs: sitemap.productUrls.length }};
    }
  }
  // 6. Magento toolbar amount on /new-products.html
  if (/magento/.test(state.platform)) {
    const r = await safeFetch(`${origin}/new-products.html`, ctx);
    if (r && r.status === 200) {
      const $ = cheerio.load(r.body);
      const nums = $('.toolbar-number').map((_, el) => parseInt($(el).text().trim(), 10)).get().filter(Number.isFinite);
      if (nums.length >= 3) return { count: nums[2], method: 'magento-toolbar',
        evidence: { endpoint: '/new-products.html', responseSample: nums.join(',') }};
    }
  }
  // 7. Generic product sitemap (last sitemap-based attempt)
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
