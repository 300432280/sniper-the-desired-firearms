// backend/scripts/probe/room5-bootstrap/walk-strategies.ts
// Platform-specific walk implementations for index-products.ts.
// Each function paginates through a catalog source and returns CatalogProduct[].

import { safeFetch } from '../shared/fetch';
import { extractProducts } from '../shared/extract';
import { canRequest, consumeToken } from '../../../src/services/token-budget';
import type { NavigationState } from '../shared/types';
import type { CatalogProduct } from '../../../src/services/scraper/types';

const BASE_BUDGET = 60;
const CAPACITY = 1.0;

// ── URL builder (mirrors catalog-crawler.ts:118-166) ────────────────────────

function buildPageUrl(baseUrl: string, page: number, state: NavigationState): string {
  const pat = state.paginationPattern;
  if (page === pat.startPage && !pat.firstPageHasParam) return baseUrl;

  switch (pat.type) {
    case 'query': {
      const u = new URL(baseUrl);
      u.searchParams.set(pat.template ?? 'page', String(page));
      return u.toString();
    }
    case 'path': {
      const suffix = (pat.template ?? '/page/{N}').replace('{N}', String(page));
      const u = new URL(baseUrl);
      u.pathname = u.pathname.replace(/\/$/, '') + suffix;
      return u.toString();
    }
    case 'offset-query': {
      const u = new URL(baseUrl);
      const offset = (page - pat.startPage) * pat.perPage;
      u.searchParams.set(pat.template ?? 'offset', String(offset));
      return u.toString();
    }
    case 'suffix-replace': {
      if (pat.match && pat.template) {
        const replacement = pat.template.replace('{N}', String(page));
        if (baseUrl.includes(pat.match)) return baseUrl.replace(pat.match, replacement);
        return baseUrl.replace(/\/?$/, '/') + replacement;
      }
      return baseUrl;
    }
    default:
      return baseUrl;
  }
}

// ── Token-budget-gated wait helper ──────────────────────────────────────────

async function waitForBudget(siteId: string): Promise<boolean> {
  if (canRequest(siteId, BASE_BUDGET, CAPACITY)) return true;
  await new Promise(r => setTimeout(r, 3000));
  return canRequest(siteId, BASE_BUDGET, CAPACITY);
}

// ── HTML walk: paginate each catalogUrl ─────────────────────────────────────

export async function htmlWalk(state: NavigationState, siteId: string): Promise<CatalogProduct[]> {
  const allProducts: CatalogProduct[] = [];
  const seenUrls = new Set<string>();

  for (const catalogUrl of state.catalogUrls) {
    let page = state.paginationPattern.startPage;
    let consecutiveEmpty = 0;
    const maxPages = Math.ceil(state.globalProductCount / Math.max(state.paginationPattern.perPage, 1)) + 5;

    while (consecutiveEmpty < 2 && page <= maxPages + state.paginationPattern.startPage) {
      if (!await waitForBudget(siteId)) break;
      consumeToken(siteId, 1);

      const pageUrl = buildPageUrl(catalogUrl, page, state);
      try {
        const res = await safeFetch(pageUrl, {
          timeoutMs: 25000,
          hasWaf: state.hasWaf,
          wafType: state.wafType ?? undefined,
        });

        if (res.status !== 200 || res.bodyBytes < 500) { consecutiveEmpty++; page++; continue; }

        const products = extractProducts(res.body, pageUrl, state.platform);
        if (products.length === 0) { consecutiveEmpty++; page++; continue; }

        consecutiveEmpty = 0;
        for (const p of products) {
          if (!seenUrls.has(p.url)) {
            seenUrls.add(p.url);
            (p as any).catalogUrl = catalogUrl;
            allProducts.push(p);
          }
        }
      } catch {
        consecutiveEmpty++;
      }
      page++;
    }
  }
  return allProducts;
}

// ── API walk: Shopify /products.json (published_at per Mistake 32) ──────────

export async function shopifyApiWalk(state: NavigationState, siteId: string): Promise<CatalogProduct[]> {
  const allProducts: CatalogProduct[] = [];
  const seenUrls = new Set<string>();
  const origin = state.canonicalOrigin;
  let page = 1;

  while (true) {
    if (!await waitForBudget(siteId)) break;
    consumeToken(siteId, 1);

    const url = `${origin}/products.json?limit=250&page=${page}`;
    try {
      const res = await safeFetch(url, { timeoutMs: 30000 });
      if (res.status !== 200) break;

      const data = JSON.parse(res.body);
      const products: any[] = data.products;
      if (!products || products.length === 0) break;

      for (const p of products) {
        const productUrl = `${origin}/products/${p.handle}`;
        if (seenUrls.has(productUrl)) continue;
        seenUrls.add(productUrl);
        allProducts.push({
          url: productUrl,
          title: p.title,
          sourceId: String(p.id),
          price: p.variants?.[0]?.price ? parseFloat(p.variants[0].price) : undefined,
          stockStatus: p.variants?.some((v: any) => v.available) ? 'in_stock' : 'out_of_stock',
          thumbnail: p.images?.[0]?.src,
          postDate: p.published_at ?? undefined, // Mistake 32: NOT created_at
          sourceCategory: p.product_type ?? undefined,
          tags: Array.isArray(p.tags) ? p.tags.join(', ') : p.tags ?? undefined,
        });
      }
      if (products.length < 250) break;
      page++;
    } catch { break; }
  }
  return allProducts;
}

// ── API walk: WooCommerce WP REST (Store API v1) ────────────────────────────

export async function woocommerceApiWalk(state: NavigationState, siteId: string): Promise<CatalogProduct[]> {
  const allProducts: CatalogProduct[] = [];
  const seenUrls = new Set<string>();
  const origin = state.canonicalOrigin;
  let page = 1;

  while (true) {
    if (!await waitForBudget(siteId)) break;
    consumeToken(siteId, 1);

    const url = `${origin}/wp-json/wc/store/v1/products?per_page=100&page=${page}&orderby=date&order=desc`;
    try {
      const res = await safeFetch(url, {
        timeoutMs: 30000,
        hasWaf: state.hasWaf,
        wafType: state.wafType ?? undefined,
      });
      if (res.status !== 200) break;

      const products: any[] = JSON.parse(res.body);
      if (!products || products.length === 0) break;

      for (const p of products) {
        const productUrl = p.permalink ?? (p.slug ? `${origin}/product/${p.slug}` : null);
        if (!productUrl || seenUrls.has(productUrl)) continue;
        seenUrls.add(productUrl);
        allProducts.push({
          url: productUrl,
          title: p.name,
          sourceId: String(p.id),
          price: p.prices?.price ? parseFloat(p.prices.price) / 100 : undefined,
          regularPrice: p.prices?.regular_price ? parseFloat(p.prices.regular_price) / 100 : undefined,
          stockStatus: p.is_in_stock ? 'in_stock' : 'out_of_stock',
          thumbnail: p.images?.[0]?.src,
          postDate: p.date_created ?? p.date_modified ?? undefined,
          sourceCategory: p.categories?.map((c: any) => c.name).join(', ') ?? undefined,
        });
      }
      if (products.length < 100) break;
      page++;
    } catch { break; }
  }
  return allProducts;
}
