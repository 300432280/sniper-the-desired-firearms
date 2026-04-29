/**
 * @deprecated 2026-04-27 — Generic discovery superseded by AI-driven per-site audit.
 * See `_DEPRECATED.md` in this folder and `docs/superpowers/plans/2026-04-27-pivot-to-ai-audit.md`.
 * Do not import from this file in new code.
 */
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

// ── Date normalization (Fix #13) ───────────────────────────────────────────

/**
 * Normalize date input to ISO 8601 string.
 * - null/undefined/empty → null
 * - ISO with TZ → as-is
 * - ISO without TZ (no Z and no +/- offset) → appends Z (treat as UTC)
 * - Date object → .toISOString()
 * - Non-parseable → null
 */
export function normalizeToIso(input: string | Date | null | undefined): string | null {
  if (input == null) return null;
  if (input instanceof Date) return isNaN(input.getTime()) ? null : input.toISOString();
  const s = String(input).trim();
  if (!s) return null;
  // Check if it parses at all
  const parsed = new Date(s);
  if (isNaN(parsed.getTime())) return null;
  // If already has timezone info (Z, +HH:MM, -HH:MM), return as-is
  if (/Z$|[+-]\d{2}:\d{2}$|[+-]\d{4}$/.test(s)) return s;
  // ISO-like without TZ (e.g. "2024-03-15T10:23:45") — append Z
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) return s.replace(/ /, 'T') + 'Z';
  // Parseable but non-standard format — use Date output
  return parsed.toISOString();
}

// ── Sort param applicator (Fix #11) ────────────────────────────────────────

function applySortParam(url: string, sortParam: string | null): string {
  if (!sortParam) return url;
  const u = new URL(url);
  const cleaned = sortParam.replace(/^\?/, '');
  for (const pair of cleaned.split('&')) {
    const [k, v] = pair.split('=');
    if (k) u.searchParams.set(k, v ?? '');
  }
  return u.toString();
}

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
    // Apply sortParam to the base URL (Fix #11)
    const sortedBaseUrl = applySortParam(catalogUrl, state.sortParam);
    let page = state.paginationPattern.startPage;
    let consecutiveEmpty = 0;
    const maxPages = Math.ceil(state.globalProductCount / Math.max(state.paginationPattern.perPage, 1)) + 5;

    while (consecutiveEmpty < 2 && page <= maxPages + state.paginationPattern.startPage) {
      if (!await waitForBudget(siteId)) break;
      // Bootstrap consumes against Tier 2 (catalog-equivalent), not Tier 1
      consumeToken(siteId, 2);

      const pageUrl = buildPageUrl(sortedBaseUrl, page, state);
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
            if (p.postDate) p.postDate = normalizeToIso(p.postDate) ?? undefined;
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

// ── API walk: Shopify /products.json (cursor-based, published_at per Mistake 32) ──

export async function shopifyApiWalk(state: NavigationState, siteId: string): Promise<CatalogProduct[]> {
  const allProducts: CatalogProduct[] = [];
  const seenUrls = new Set<string>();
  const origin = state.canonicalOrigin;
  const catalogUrlTag = origin + '/collections/all'; // Fix #15

  // Fix #9: Use cursor-based pagination via Link header (numeric ?page=N is deprecated, capped at 50)
  let nextUrl: string | null = `${origin}/products.json?limit=250`;

  while (nextUrl) {
    if (!await waitForBudget(siteId)) break;
    consumeToken(siteId, 2);

    try {
      const res = await safeFetch(nextUrl, { timeoutMs: 30000 });
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
          postDate: normalizeToIso(p.published_at) ?? undefined, // Mistake 32: NOT created_at
          sourceCategory: p.product_type ?? undefined,
          tags: Array.isArray(p.tags) ? p.tags.join(', ') : p.tags ?? undefined,
        });
      }

      // Parse Link header for cursor-based pagination
      nextUrl = parseLinkHeaderNext(res.headers);
    } catch { break; }
  }

  // Tag all products with catalogUrl (Fix #15)
  for (const p of allProducts) (p as any).catalogUrl = catalogUrlTag;

  // Sort by published_at desc client-side (Shopify API doesn't guarantee sort order)
  allProducts.sort((a, b) => {
    if (!a.postDate && !b.postDate) return 0;
    if (!a.postDate) return 1;
    if (!b.postDate) return -1;
    return new Date(b.postDate).getTime() - new Date(a.postDate).getTime();
  });

  return allProducts;
}

/**
 * Parse Link header for rel="next" URL.
 * Pattern: <https://store/products.json?page_info=XYZ&limit=250>; rel="next"
 */
function parseLinkHeaderNext(headers: Record<string, string> | undefined): string | null {
  if (!headers) return null;
  const link = headers['link'] || headers['Link'];
  if (!link) return null;
  const match = link.match(/<([^>]+)>;\s*rel=["']next["']/);
  return match ? match[1] : null;
}

// ── API walk: WooCommerce WP REST (Store API v1) ────────────────────────────

export async function woocommerceApiWalk(state: NavigationState, siteId: string): Promise<CatalogProduct[]> {
  const allProducts: CatalogProduct[] = [];
  const seenUrls = new Set<string>();
  const origin = state.canonicalOrigin;
  const catalogUrlTag = origin + '/shop'; // Fix #15
  let page = 1;

  while (true) {
    if (!await waitForBudget(siteId)) break;
    consumeToken(siteId, 2);

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
          postDate: normalizeToIso(p.date_created ?? p.date_modified) ?? undefined,
          sourceCategory: p.categories?.map((c: any) => c.name).join(', ') ?? undefined,
        });
      }
      if (products.length < 100) break;
      page++;
    } catch { break; }
  }

  // Tag all products with catalogUrl (Fix #15)
  for (const p of allProducts) (p as any).catalogUrl = catalogUrlTag;

  return allProducts;
}

// ── API walk: Ecwid storefront API (Mistake 31) ────────────────────────────

export async function ecwidApiWalk(state: NavigationState, siteId: string): Promise<CatalogProduct[]> {
  const origin = state.canonicalOrigin;
  const catalogUrlTag = origin + '/store'; // Fix #15

  // Extract storeId from state evidence or from homepage HTML
  let storeId = extractEcwidStoreId(state);
  if (!storeId) {
    // Fallback: fetch homepage and extract storeId from script tag
    try {
      const homeRes = await safeFetch(origin, { timeoutMs: 20000 });
      if (homeRes.status === 200) {
        const match = homeRes.body.match(/app\.ecwid\.com\/script\.js\?(\d{7,8})/);
        if (match) storeId = match[1];
      }
    } catch { /* fall through to null check */ }
  }

  if (!storeId) {
    // Cannot proceed without storeId — signal to caller to fall back to html-walk
    process.stderr.write(`  [Room 5] Ecwid storeId not found — falling back to html-walk\n`);
    return htmlWalk(state, siteId);
  }

  const allProducts: CatalogProduct[] = [];
  const seenUrls = new Set<string>();
  const endpoint = `https://us-vir2-storefront-api.ecwid.com/storefront/api/v1/${storeId}/catalog/search`;
  const limit = 200;
  let offset = 0;

  while (true) {
    if (!await waitForBudget(siteId)) break;
    consumeToken(siteId, 2);

    const body = JSON.stringify({
      lang: 'en',
      pagination: { offset, limit },
      sortBy: 'addedTimeDesc',
      urlParams: {
        baseUrl: '/store/',
        canonicalBaseUrl: origin,
        isCleanUrls: true,
        isCanonicalUrlsEnabled: true,
        isSlugsWithoutIds: false,
      },
    });

    try {
      const res = await safeFetch(endpoint, {
        timeoutMs: 30000,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Origin': origin,
          'Referer': origin + '/',
        },
        body,
      });

      if (res.status !== 200) break;

      const data = JSON.parse(res.body);
      const products: any[] = data.products;
      const totalCount: number = data.totalProductsCount ?? 0;
      if (!products || products.length === 0) break;

      for (const p of products) {
        const productUrl = p.seo?.canonicalUrl ?? (p.url ? origin + p.url : null);
        if (!productUrl || seenUrls.has(productUrl)) continue;
        seenUrls.add(productUrl);
        allProducts.push({
          url: productUrl,
          title: p.name,
          sourceId: String(p.id),
          price: typeof p.price === 'number' ? p.price : (p.defaultDisplayedPrice ?? undefined),
          stockStatus: p.inStock === false ? 'out_of_stock' : 'in_stock',
          thumbnail: p.thumbnailUrl ?? p.imageUrl ?? undefined,
          // Ecwid has no date field on products (Mistake 31) — postDate stays undefined
          postDate: undefined,
        });
      }

      offset += limit;
      if (offset >= totalCount || products.length < limit) break;
    } catch { break; }
  }

  // Tag all products with catalogUrl (Fix #15)
  for (const p of allProducts) (p as any).catalogUrl = catalogUrlTag;

  return allProducts;
}

/**
 * Extract Ecwid storeId from state evidence (populated by Room 2 platform detection).
 */
function extractEcwidStoreId(state: NavigationState): string | null {
  // Platform marker evidence may contain storeId from the script.js detection
  const signals = state.platformMarker?.signals as Record<string, unknown> | undefined;
  if (signals?.ecwidStoreId) return String(signals.ecwidStoreId);
  if (signals?.storeId) return String(signals.storeId);
  return null;
}
