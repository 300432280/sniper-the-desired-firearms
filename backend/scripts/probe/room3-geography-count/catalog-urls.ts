// backend/scripts/probe/room3-geography-count/catalog-urls.ts
// Discover minimum catalogUrls covering 100% of products with minimum overlap.
// Per spec §4.3 step 1 + playbook Phase 3.

import * as cheerio from 'cheerio';
import { fetchUrl } from '../shared/fetch';
import { isLikelyNavUrl } from '../shared/url-utils';
import { extractProducts } from '../shared/extract';
import type { AccessIdentityState } from '../shared/types';

export type CatalogUrlsResult = {
  catalogUrls: string[];
  source: 'nav' | 'taxonomy-api' | 'category-tree-walk' | 'manual';
};

export async function discoverCatalogUrls(state: AccessIdentityState): Promise<CatalogUrlsResult> {
  const origin = state.canonicalOrigin;
  const ctx = { hasWaf: state.hasWaf, wafType: state.wafType, ua: state.userAgentOverride ?? undefined };
  // API calls need to bypass Playwright (which wraps JSON in HTML and strips headers).
  // Same pattern as Task 4.2: hasWaf: false + pick UA for WAF type.
  const apiCtx = { hasWaf: false as const, ua: state.userAgentOverride ?? undefined };

  // 1. Try platform-specific taxonomy APIs first (most reliable)
  if (/woocommerce/.test(state.platform)) {
    const r = await fetchUrl(`${origin}/wp-json/wp/v2/product_cat?per_page=100&hide_empty=false`, apiCtx);
    if (r.status === 200) {
      try {
        const cats = JSON.parse(r.body) as Array<{ slug: string; count: number; parent: number }>;
        // Top-level non-empty categories
        const tops = cats.filter(c => c.parent === 0 && c.count > 0);
        return {
          catalogUrls: tops.map(c => `${origin}/product-category/${c.slug}/`),
          source: 'taxonomy-api',
        };
      } catch { /* fall through */ }
    }
  }
  if (/shopify/.test(state.platform)) {
    const r = await fetchUrl(`${origin}/collections.json?limit=250`, apiCtx);
    if (r.status === 200) {
      try {
        const json = JSON.parse(r.body) as { collections: Array<{ handle: string; published_at?: string; products_count?: number }> };
        const visible = json.collections.filter(c => (c.products_count ?? 1) > 0);
        return {
          catalogUrls: visible.map(c => `${origin}/collections/${c.handle}`),
          source: 'taxonomy-api',
        };
      } catch { /* fall through */ }
    }
  }

  // 2. Nav-link discovery from homepage HTML
  const home = await fetchUrl(`${origin}/`, ctx);
  const $ = cheerio.load(home.body);
  const navAnchors = $('nav a, header a, .menu a, [class*="nav"] a').map((_, el) => $(el).attr('href')).get();
  const candidates = navAnchors
    .filter((h): h is string => Boolean(h))
    .map(h => {
      try { return new URL(h, origin).toString(); } catch { return null; }
    })
    .filter((u): u is string => Boolean(u))
    .filter(u => new URL(u).hostname === new URL(origin).hostname)
    .filter(u => !isLikelyNavUrl(u));

  const unique = [...new Set(candidates)];

  // 3. Empirical filter: keep candidates that actually return products via production extractor
  const probed: Array<{ url: string; productCount: number }> = [];
  for (const url of unique.slice(0, 30)) {
    try {
      const r = await fetchUrl(url, { ...ctx, timeoutMs: 12000 });
      const products = extractProducts(r.body, url);
      probed.push({ url, productCount: products.length });
    } catch { /* skip */ }
  }
  probed.sort((a, b) => b.productCount - a.productCount);
  const productive = probed.filter(p => p.productCount >= 3).map(p => p.url);

  return {
    catalogUrls: productive,
    source: productive.length > 0 ? 'nav' : 'manual',
  };
}
