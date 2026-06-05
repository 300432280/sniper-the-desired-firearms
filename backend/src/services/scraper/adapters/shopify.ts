import type * as cheerio from 'cheerio';
import type { ScrapedMatch, ExtractionOptions, ScrapeOptions, CatalogProduct, CatalogPage } from '../types';
import { AbstractAdapter } from './base';
import { pickUserAgent } from '../http-client';
import axios from 'axios';

/**
 * Shopify adapter — covers ~60% of Canadian firearms retail sites.
 *
 * Search: {origin}/search?q={keyword}&type=product
 * Optional API: /search/suggest.json?q={keyword}&resources[type]=product
 * Selectors: [data-product-id], product-card variants, grid items
 * Pagination: ?page=N
 */
export class ShopifyAdapter extends AbstractAdapter {
  name = 'Shopify';
  siteType = 'retailer' as const;
  supportsDateFilter = false; // Public /products.json ignores updated_at_min/max (only Admin API supports it)

  getSearchUrl(origin: string, keyword: string): string {
    return `${origin}/search?q=${encodeURIComponent(keyword)}&type=product`;
  }

  async searchViaApi(origin: string, keyword: string, options: ScrapeOptions): Promise<ScrapedMatch[]> {
    try {
      // `origin` may include a locale prefix (e.g. "...ca/en") so /search/suggest.json
      // hits the right locale and returns English titles on bilingual stores.
      // Shopify's response payload, however, already encodes the locale into
      // each product.url ("/en/products/<handle>"), so joining product.url
      // with the locale-prefixed origin would produce "/en/en/products/<handle>"
      // -- a double prefix that doesn't exist. Use the BARE origin (protocol +
      // host only) when constructing the product URL.
      const bareOrigin = new URL(origin).origin;
      const url = `${origin}/search/suggest.json`;
      const response = await axios.get(url, {
        params: {
          q: keyword,
          'resources[type]': 'product',
          'resources[limit]': options.fast ? 10 : 25,
        },
        headers: {
          'User-Agent': pickUserAgent(new URL(origin).hostname),
          Accept: 'application/json',
        },
        timeout: 15000,
      });

      const products = response.data?.resources?.results?.products || [];
      if (!Array.isArray(products) || products.length === 0) return [];

      const keywordLower = keyword.toLowerCase();
      const matches: ScrapedMatch[] = [];

      for (const product of products) {
        const title = (product.title || '').trim();
        if (!title) continue;
        // Don't re-filter by `title.includes(keyword)` -- /search/suggest.json already
        // matched server-side; re-filtering drops foreign-language hits
        // (e.g. "Carabine" never matches "rifle") and synonym/model-name hits.

        let productUrl = product.url
          ? (product.url.startsWith('http') ? product.url : `${bareOrigin}${product.url}`)
          : bareOrigin;
        // Strip Shopify search tracking params to avoid duplicate ProductIndex entries
        try {
          const u = new URL(productUrl);
          ['_pos', '_psq', '_ss', '_v', '_fid'].forEach(p => u.searchParams.delete(p));
          productUrl = u.toString().replace(/\?$/, '');
        } catch { /* keep original URL if parse fails */ }

        // Shopify suggest API returns price as dollars (e.g. "999.00"), NOT cents
        const price = product.price ? parseFloat(product.price) : undefined;
        const thumbnail = product.image || product.featured_image?.url || undefined;

        if (options.maxPrice && price && price > options.maxPrice) continue;

        matches.push({
          title: title.slice(0, 160),
          price: price && price > 0 ? price : undefined,
          url: productUrl,
          sourceId: product.id != null ? String(product.id) : undefined,
          thumbnail,
          inStock: product.available !== false,
          seller: undefined,
        });
      }

      return matches;
    } catch {
      return []; // API not available, fall back to HTML
    }
  }

  extractMatches(
    $: cheerio.CheerioAPI,
    keyword: string,
    baseUrl: string,
    options: ExtractionOptions
  ): ScrapedMatch[] {
    const keywordLower = keyword.toLowerCase();
    const matches: ScrapedMatch[] = [];
    const seen = new Set<string>();

    const SELECTORS = [
      '[data-product-id]',
      '[class*="product-card"]',
      '[class*="product-item"]',
      '[class*="product-tile"]',
      '[class*="ProductItem"]',
      '.grid__item [class*="product"]',
      'li[class*="product"]',
      'article[class*="product"]',
      '[class*="grid-item"]',
    ];

    for (const selector of SELECTORS) {
      $(selector).each((_, el) => {
        const element = $(el);
        const text = element.text();
        if (!options.isSearchPage && !text.toLowerCase().includes(keywordLower)) return;

        const rawTitle = this.extractTitle(element, text);
        if (!rawTitle || rawTitle.length < 3) return;
        if (/^\$?\d[\d,.]*$/.test(rawTitle)) return;
        if (this.isNavTitle(rawTitle)) return;

        const titleKey = rawTitle.toLowerCase().slice(0, 60);
        if (seen.has(titleKey)) return;

        const productUrl = this.extractLink(element, baseUrl);
        if (this.isNavUrl(productUrl)) return;
        const price = this.extractPriceFromElement(element);
        const inStock = this.isInStock(element);
        const thumbnail = this.extractThumbnail($, element, baseUrl);

        if (options.inStockOnly && !inStock) return;
        if (options.maxPrice && price && price > options.maxPrice) return;

        const sourceId = element.attr('data-product-id') || element.closest('[data-product-id]').attr('data-product-id') || undefined;

        seen.add(titleKey);
        matches.push({ title: rawTitle, price, url: productUrl, inStock, thumbnail, sourceId });
      });
    }

    return matches;
  }

  getNextPageUrl($: cheerio.CheerioAPI, currentUrl: string): string | null {
    // Shopify pagination: ?page=N
    const nextLink = $('a[rel="next"], [class*="pagination"] a:contains("Next"), [class*="pagination"] a:contains("›")').first();
    if (nextLink.length) {
      const href = nextLink.attr('href');
      if (href) {
        return this.resolveUrl(href, currentUrl);
      }
    }
    return null;
  }

  // ── Catalog Crawl Methods (Phase 3) ───────────────────────────────────────

  getNewArrivalsUrl(origin: string): string {
    return `${origin}/collections/all?sort_by=created-descending`;
  }

  /**
   * Build a resolvable product URL from a Shopify handle.
   *
   * Most handles are ASCII-only (Shopify slugifies titles), but a merchant can
   * create handles containing raw non-ASCII characters (e.g. CJK). The public
   * /products.json API returns those handles UNENCODED, so naively interpolating
   * them yields a URL with raw CJK in the path — which Shopify's storefront 404s.
   * The on-site hrefs and the only resolvable form are PERCENT-ENCODED.
   *
   * encodeURI() encodes non-ASCII bytes while leaving "/", "-", etc. intact, and
   * is a no-op for already-ASCII handles. We guard against double-encoding (which
   * would turn "%E9" into "%25E9") by skipping handles that already contain a
   * valid percent-escape — products.json always returns raw handles, but the
   * guard keeps this safe if an already-encoded handle ever reaches here.
   *
   * Root cause repro: aagcanada.ca 2026-05-29. Previously this line ran
   * decodeURIComponent(), which for a raw-CJK handle was a no-op (left the 404ing
   * form) and for an encoded handle actively broke it.
   */
  private buildProductUrl(origin: string, handle: string): string {
    const raw = `${origin}/products/${handle}`;
    if (/%[0-9A-Fa-f]{2}/.test(handle)) return raw; // already encoded — don't double-encode
    return encodeURI(raw);
  }

  async fetchCatalogPage(
    origin: string,
    page: number,
    options?: { sortBy?: 'newest' | 'oldest'; perPage?: number; dateAfter?: string; dateBefore?: string },
  ): Promise<CatalogPage> {
    // Always use 250 (Shopify max) regardless of caller's perPage —
    // Shopify's API handles it efficiently and this minimizes pages needed.
    const perPage = 250;
    const ua = pickUserAgent(new URL(origin).hostname);

    // Shopify public /products.json API — returns structured JSON.
    // NOTE: updated_at_min/max are IGNORED by the public (storefront) API.
    // They only work on the authenticated Admin API. We intentionally skip
    // sending them to avoid false confidence in date-range filtering.
    // All tiers will crawl the full catalog, which is fine — Shopify catalogs
    // are typically small enough (≤10 pages at 250/page) to cover quickly.
    const apiParams: Record<string, any> = { limit: perPage, page };

    const resp = await axios.get(`${origin}/products.json`, {
      params: apiParams,
      headers: { 'User-Agent': ua, Accept: 'application/json' },
      timeout: 15000,
      validateStatus: (s) => s === 200,
    });

    const products: any[] = resp.data?.products || [];
    if (!Array.isArray(products) || products.length === 0) {
      return { products: [] };
    }

    const catalogProducts: CatalogProduct[] = products.map(p => {
      const tags = Array.isArray(p.tags) && p.tags.length > 0
        ? p.tags.join(',')
        : (typeof p.tags === 'string' && p.tags ? p.tags : undefined);

      return {
        url: this.buildProductUrl(origin, p.handle),
        sourceId: String(p.id),
        title: (p.title || '').trim().slice(0, 160),
        price: p.variants?.[0]?.price ? parseFloat(p.variants[0].price) : undefined,
        stockStatus: p.variants?.some((v: any) => v.available)
          ? 'in_stock' as const
          : 'out_of_stock' as const,
        thumbnail: p.images?.[0]?.src || undefined,
        tags,
        sourceCategory: p.product_type || undefined,
        postDate: p.published_at || undefined, // Shopify API sorts by published_at desc (strictly monotonic across all sites — verified 2026-04-11 on all 4 Shopify fleet sites)
      };
    });

    // Sort if requested (Shopify API doesn't support sort param on products.json)
    if (options?.sortBy === 'oldest') {
      catalogProducts.reverse();
    }

    const isLastPage = products.length < perPage;
    return {
      products: catalogProducts,
      nextPageUrl: isLastPage ? undefined : `${origin}/products.json?limit=${perPage}&page=${page + 1}`,
      totalPages: isLastPage ? page : undefined, // Report totalPages when we reach the end
    };
  }

  extractCatalogProducts($: cheerio.CheerioAPI, baseUrl: string): CatalogProduct[] {
    const products: CatalogProduct[] = [];
    const seen = new Set<string>();

    const SELECTORS = [
      '[data-product-id]',
      '[class*="product-card"]',
      '[class*="product-item"]',
      '[class*="product-tile"]',
      '[class*="product-block"]',       // Custom Shopify themes (Jo Brook, etc.)
      '.grid__item [class*="product"]',
      'li[class*="product"]',
      'article[class*="product"]',
      'div.product',                    // Generic product div
    ];

    for (const selector of SELECTORS) {
      $(selector).each((_, el) => {
        const element = $(el);
        const title = this.extractTitle(element, element.text());
        if (!title || title.length < 3) return;
        if (/^\$?\d[\d,.]*$/.test(title)) return;
        // Reject nav/category/URL-shaped titles (e.g. "www.aagcanada.ca") that a
        // non-product card or footer/share link can produce. The API path
        // (fetchCatalogPage) is the source of truth; HTML extraction is a fallback
        // and must not inject junk rows. aagcanada.ca repro 2026-05-29.
        if (this.isNavTitle(title)) return;

        const url = this.extractLink(element, baseUrl);
        if (!url || seen.has(url)) return;
        // Shopify product pages are ALWAYS /products/<handle> (optionally locale-prefixed).
        // Anything else (collection, page, footer link, homepage) is not a product.
        if (!/\/products\/[^/?#]+/.test(url)) return;
        seen.add(url);

        const price = this.extractPriceFromElement(element);
        const inStock = this.isInStock(element);
        const thumbnail = this.extractThumbnail($, element, baseUrl);

        const sourceId = element.attr('data-product-id') || element.closest('[data-product-id]').attr('data-product-id') || undefined;

        products.push({
          url,
          sourceId,
          title,
          price,
          stockStatus: inStock ? 'in_stock' : 'out_of_stock',
          thumbnail,
        });
      });
    }

    return products;
  }
}
