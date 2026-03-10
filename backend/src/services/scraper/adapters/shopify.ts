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

  getSearchUrl(origin: string, keyword: string): string {
    return `${origin}/search?q=${encodeURIComponent(keyword)}&type=product`;
  }

  async searchViaApi(origin: string, keyword: string, options: ScrapeOptions): Promise<ScrapedMatch[]> {
    try {
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
        if (!title || !title.toLowerCase().includes(keywordLower)) continue;

        let productUrl = product.url
          ? (product.url.startsWith('http') ? product.url : `${origin}${product.url}`)
          : origin;
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
        if (!text.toLowerCase().includes(keywordLower)) return;

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

        seen.add(titleKey);
        matches.push({ title: rawTitle, price, url: productUrl, inStock, thumbnail });
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

  async fetchCatalogPage(
    origin: string,
    page: number,
    options?: { sortBy?: 'newest' | 'oldest'; perPage?: number; dateAfter?: string; dateBefore?: string },
  ): Promise<CatalogPage> {
    const perPage = Math.min(options?.perPage ?? 250, 250);
    const ua = pickUserAgent(new URL(origin).hostname);

    // Shopify products.json API — returns structured JSON
    // Uses `updated_at_min`/`updated_at_max` to filter by modification date,
    // catching restocks (inventory changes update updated_at) and price changes.
    const apiParams: Record<string, any> = { limit: perPage, page };
    if (options?.dateAfter) apiParams.updated_at_min = options.dateAfter;
    if (options?.dateBefore) apiParams.updated_at_max = options.dateBefore;

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
        url: (() => { try { return decodeURIComponent(`${origin}/products/${p.handle}`); } catch { return `${origin}/products/${p.handle}`; } })(),
        title: (p.title || '').trim().slice(0, 160),
        price: p.variants?.[0]?.price ? parseFloat(p.variants[0].price) : undefined,
        stockStatus: p.variants?.some((v: any) => v.available)
          ? 'in_stock' as const
          : 'out_of_stock' as const,
        thumbnail: p.images?.[0]?.src || undefined,
        tags,
        sourceCategory: p.product_type || undefined,
      };
    });

    // Sort if requested (Shopify API doesn't support sort param on products.json)
    if (options?.sortBy === 'oldest') {
      catalogProducts.reverse();
    }

    return {
      products: catalogProducts,
      nextPageUrl: products.length >= perPage ? `${origin}/products.json?limit=${perPage}&page=${page + 1}` : undefined,
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

        const url = this.extractLink(element, baseUrl);
        if (!url || seen.has(url)) return;
        seen.add(url);

        const price = this.extractPriceFromElement(element);
        const inStock = this.isInStock(element);
        const thumbnail = this.extractThumbnail($, element, baseUrl);

        products.push({
          url,
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
