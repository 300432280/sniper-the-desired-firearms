import type * as cheerio from 'cheerio';
import type { ScrapedMatch, ExtractionOptions, ScrapeOptions, CatalogProduct, CatalogPage } from '../types';
import { AbstractAdapter } from './base';
import axios from 'axios';
import { pickUserAgent } from '../http-client';

/**
 * WooCommerce adapter — covers ~40% of retail sites.
 *
 * API search (tried first):
 *   1. WooCommerce Store API: /wp-json/wc/store/v1/products?search={keyword}
 *   2. WordPress REST API:    /wp-json/wp/v2/product?search={keyword}
 *
 * HTML fallback:
 *   Search URL: {origin}/?s={keyword}&post_type=product
 *   Selectors: li.product, .wd-product, [data-product-id], etc.
 */
export class WooCommerceAdapter extends AbstractAdapter {
  name = 'WooCommerce';
  siteType = 'retailer' as const;

  getSearchUrl(origin: string, keyword: string): string {
    return `${origin}/?s=${encodeURIComponent(keyword)}&post_type=product`;
  }

  async searchViaApi(origin: string, keyword: string, options: ScrapeOptions): Promise<ScrapedMatch[]> {
    const ua = pickUserAgent(new URL(origin).hostname);
    const headers = { 'User-Agent': ua, Accept: 'application/json' };
    const limit = options.fast ? 10 : 25;
    const apiTimeout = options.fast ? 5000 : 10000;

    // Try WooCommerce Store API first (public, no auth)
    try {
      const resp = await axios.get(`${origin}/wp-json/wc/store/v1/products`, {
        params: { search: keyword, per_page: limit },
        headers,
        timeout: apiTimeout,
        validateStatus: (s) => s === 200,
      });
      if (Array.isArray(resp.data) && resp.data.length > 0) {
        return this.parseStoreApiProducts(resp.data, keyword, origin, options);
      }
    } catch { /* fall through */ }

    // Try WordPress REST API
    try {
      const resp = await axios.get(`${origin}/wp-json/wp/v2/product`, {
        params: { search: keyword, per_page: limit },
        headers,
        timeout: apiTimeout,
        validateStatus: (s) => s === 200,
      });
      if (Array.isArray(resp.data) && resp.data.length > 0) {
        return this.parseWpApiProducts(resp.data, keyword, origin, options);
      }
    } catch { /* fall through */ }

    return []; // API not available, will fall back to HTML
  }

  private parseStoreApiProducts(
    products: any[],
    keyword: string,
    origin: string,
    options: ScrapeOptions
  ): ScrapedMatch[] {
    const kw = keyword.toLowerCase();
    const matches: ScrapedMatch[] = [];

    for (const p of products) {
      const name = this.decodeHtml(p.name || '');
      if (!name.toLowerCase().includes(kw)) continue;

      // Store API prices are in minor units (cents)
      const rawPrice = p.prices?.price || p.prices?.regular_price;
      const price = rawPrice ? parseInt(rawPrice, 10) / 100 : undefined;

      if (options.maxPrice && price && price > options.maxPrice) continue;

      const url = p.permalink || `${origin}/?p=${p.id}`;
      const thumbnail = p.images?.[0]?.src || p.images?.[0]?.thumbnail || undefined;
      const inStock = p.is_purchasable !== false;

      matches.push({
        title: name.slice(0, 160),
        price: price && price > 0 ? price : undefined,
        url,
        thumbnail,
        inStock,
      });
    }

    return matches;
  }

  private parseWpApiProducts(
    products: any[],
    keyword: string,
    origin: string,
    options: ScrapeOptions
  ): ScrapedMatch[] {
    const kw = keyword.toLowerCase();
    const matches: ScrapedMatch[] = [];

    for (const p of products) {
      const name = this.decodeHtml(p.title?.rendered || p.name || '');
      if (!name.toLowerCase().includes(kw)) continue;

      const url = p.link || `${origin}/?p=${p.id}`;

      matches.push({
        title: name.slice(0, 160),
        url,
        inStock: true,
      });
    }

    return matches;
  }

  private decodeHtml(str: string): string {
    return str
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#8243;/g, '"')
      .replace(/&#8220;/g, '\u201C')
      .replace(/&#8221;/g, '\u201D')
      .replace(/&rsquo;/g, '\u2019')
      .replace(/&lsquo;/g, '\u2018')
      .replace(/&ndash;/g, '\u2013')
      .replace(/&mdash;/g, '\u2014');
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
      'li.product',
      '.woocommerce-loop-product',
      'li[class*="product"]',
      '[class*="product-card"]',
      '[class*="product-item"]',
      '[data-product-id]',
      '.wd-product',             // Woodmart theme (rangeviewsports, etc.)
      'div[class*="product"]',   // Generic div-based product cards
    ];

    for (const selector of SELECTORS) {
      $(selector).each((_, el) => {
        const element = $(el);
        const text = element.text();
        if (!text.toLowerCase().includes(keywordLower)) return;

        // WooCommerce title structure
        let titleEl = element.find('.woocommerce-loop-product__title, h2.wc-block-grid__product-title').first();
        if (!titleEl.length) titleEl = element.find('.wd-entities-title').first(); // Woodmart
        if (!titleEl.length) titleEl = element.find('h2, h3, h4').first();
        if (!titleEl.length) titleEl = element.find('[class*="title"], [class*="name"]').first();

        const rawTitle = (titleEl.length ? titleEl.text() : text).trim().replace(/\s+/g, ' ').slice(0, 160);
        if (!rawTitle || rawTitle.length < 3) return;
        if (/^\$?\d[\d,.]*$/.test(rawTitle)) return;

        const titleKey = rawTitle.toLowerCase().slice(0, 60);
        if (seen.has(titleKey)) return;

        const productUrl = this.extractLink(element, baseUrl);

        // WooCommerce price structure
        const priceEl = element.find('.price, .woocommerce-Price-amount, [class*="price"]').first();
        const price = this.extractPrice(priceEl.text() || '');

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
    const nextLink = $('.woocommerce-pagination a.next, a.next.page-numbers').first();
    if (nextLink.length) {
      const href = nextLink.attr('href');
      if (href) return this.resolveUrl(href, currentUrl);
    }
    return null;
  }

  // ── Catalog Crawl Methods (Phase 3) ───────────────────────────────────────

  getNewArrivalsUrl(origin: string): string {
    return `${origin}/shop/?orderby=date`;
  }

  async fetchCatalogPage(
    origin: string,
    page: number,
    options?: { sortBy?: 'newest' | 'oldest'; perPage?: number },
  ): Promise<CatalogPage> {
    const perPage = Math.min(options?.perPage ?? 100, 100);
    const ua = pickUserAgent(new URL(origin).hostname);
    const headers = { 'User-Agent': ua, Accept: 'application/json' };
    const orderby = options?.sortBy === 'oldest' ? 'date' : 'date';
    const order = options?.sortBy === 'oldest' ? 'asc' : 'desc';

    // Try WooCommerce Store API (public, no auth needed)
    try {
      const resp = await axios.get(`${origin}/wp-json/wc/store/v1/products`, {
        params: { per_page: perPage, page, orderby, order },
        headers,
        timeout: 15000,
        validateStatus: (s) => s === 200,
      });

      if (Array.isArray(resp.data) && resp.data.length > 0) {
        const totalPages = parseInt(resp.headers['x-wp-totalpages'] || '0', 10);
        const products: CatalogProduct[] = resp.data.map((p: any) => ({
          url: p.permalink || `${origin}/?p=${p.id}`,
          title: this.decodeHtml(p.name || '').slice(0, 160),
          price: p.prices?.price ? parseInt(p.prices.price, 10) / 100 : undefined,
          stockStatus: p.is_purchasable !== false ? 'in_stock' as const : 'out_of_stock' as const,
          thumbnail: p.images?.[0]?.src || p.images?.[0]?.thumbnail || undefined,
        }));

        return {
          products,
          nextPageUrl: resp.data.length >= perPage ? undefined : undefined, // Let caller handle pagination via page param
          totalPages: totalPages || undefined,
        };
      }
    } catch { /* fall through to WP REST API */ }

    // Try WordPress REST API
    try {
      const resp = await axios.get(`${origin}/wp-json/wp/v2/product`, {
        params: { per_page: perPage, page, orderby: 'date', order },
        headers,
        timeout: 15000,
        validateStatus: (s) => s === 200,
      });

      if (Array.isArray(resp.data) && resp.data.length > 0) {
        const totalPages = parseInt(resp.headers['x-wp-totalpages'] || '0', 10);
        const products: CatalogProduct[] = resp.data.map((p: any) => ({
          url: p.link || `${origin}/?p=${p.id}`,
          title: this.decodeHtml(p.title?.rendered || p.name || '').slice(0, 160),
          price: undefined, // WP REST API doesn't reliably include prices
          stockStatus: 'unknown' as const,
          thumbnail: undefined,
        }));

        return {
          products,
          totalPages: totalPages || undefined,
        };
      }
    } catch { /* no API available */ }

    return { products: [] };
  }

  extractCatalogProducts($: cheerio.CheerioAPI, baseUrl: string): CatalogProduct[] {
    const products: CatalogProduct[] = [];
    const seen = new Set<string>();

    const SELECTORS = [
      'li.product',
      '.woocommerce-loop-product',
      'li[class*="product"]',
      '[class*="product-card"]',
      '[data-product-id]',
      '.wd-product',
    ];

    for (const selector of SELECTORS) {
      $(selector).each((_, el) => {
        const element = $(el);

        let titleEl = element.find('.woocommerce-loop-product__title, h2.wc-block-grid__product-title').first();
        if (!titleEl.length) titleEl = element.find('.wd-entities-title').first();
        if (!titleEl.length) titleEl = element.find('h2, h3, h4').first();
        if (!titleEl.length) titleEl = element.find('[class*="title"], [class*="name"]').first();

        const title = (titleEl.length ? titleEl.text() : element.text()).trim().replace(/\s+/g, ' ').slice(0, 160);
        if (!title || title.length < 3) return;
        if (/^\$?\d[\d,.]*$/.test(title)) return;

        const url = this.extractLink(element, baseUrl);
        if (!url || seen.has(url)) return;
        seen.add(url);

        const priceEl = element.find('.price, .woocommerce-Price-amount, [class*="price"]').first();
        const price = this.extractPrice(priceEl.text() || '');
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
