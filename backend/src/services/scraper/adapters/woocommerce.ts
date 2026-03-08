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
    const limit = options.fast ? 10 : 100;
    const apiTimeout = options.fast ? 5000 : 10000;

    const seen = new Map<string, ScrapedMatch>(); // URL → match (Store API data preferred)

    // Try WooCommerce Store API (rich data: prices, thumbnails, stock)
    try {
      const resp = await axios.get(`${origin}/wp-json/wc/store/v1/products`, {
        params: { search: keyword, per_page: limit },
        headers,
        timeout: apiTimeout,
        validateStatus: (s) => s === 200,
      });
      if (Array.isArray(resp.data)) {
        for (const m of this.parseStoreApiProducts(resp.data, keyword, origin, options)) {
          if (!this.isCategoryPageUrl(m.url)) seen.set(m.url, m);
        }
      }
    } catch { /* fall through */ }

    // Also try WordPress REST API (finds out-of-stock products Store API hides)
    try {
      const resp = await axios.get(`${origin}/wp-json/wp/v2/product`, {
        params: { search: keyword, per_page: limit, _embed: 'wp:featuredmedia' },
        headers,
        timeout: apiTimeout,
        validateStatus: (s) => s === 200,
      });
      if (Array.isArray(resp.data)) {
        for (const m of this.parseWpApiProducts(resp.data, keyword, origin, options)) {
          if (!this.isCategoryPageUrl(m.url) && !seen.has(m.url)) seen.set(m.url, m);
        }
      }
    } catch { /* fall through */ }

    return [...seen.values()];
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

      // Extract thumbnail from _embedded featured media (if _embed was requested)
      const embedded = p._embedded?.['wp:featuredmedia']?.[0];
      const thumbnail = embedded?.media_details?.sizes?.thumbnail?.source_url
        || embedded?.media_details?.sizes?.medium?.source_url
        || embedded?.source_url
        || undefined;

      matches.push({
        title: name.slice(0, 160),
        url,
        thumbnail,
        inStock: undefined, // WP REST API doesn't provide stock status
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
        if (this.isNavTitle(rawTitle)) return;

        const titleKey = rawTitle.toLowerCase().slice(0, 60);
        if (seen.has(titleKey)) return;

        const productUrl = this.extractLink(element, baseUrl);
        if (this.isNavUrl(productUrl)) return;
        if (this.isCategoryPageUrl(productUrl)) return;

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

  getNewArrivalsUrls(origin: string): string[] {
    const urls: string[] = [];

    // Site-specific category pages for WAF-blocked WooCommerce sites
    // whose /shop/ page shows category grids instead of products
    if (origin.includes('doctordeals.ca')) {
      urls.push(
        `${origin}/product-category/gun-shop/firearms/rifles/`,
        `${origin}/product-category/gun-shop/firearms/shotguns/`,
        `${origin}/product-category/gun-shop/firearms/non-restricted/`,
        `${origin}/product-category/gun-shop/firearms/used-and-war/`,
        `${origin}/product-category/gun-shop/ammunition/`,
        `${origin}/product-category/gun-shop/optics-sights/`,
      );
    }
    if (origin.includes('g4cgunstore.com')) {
      urls.push(
        `${origin}/product-category/firearms/rifles/non-restricted-rifles/`,
        `${origin}/product-category/firearms/handguns/pistols/`,
        `${origin}/product-category/firearms/shotguns/`,
        `${origin}/product-category/firearms/rifles/restricted-rifles/`,
        `${origin}/product-category/new-arrivals/`,
        `${origin}/product-category/ammunition/`,
      );
    }
    if (origin.includes('corwin-arms.com')) {
      // WooCommerce — /shop redirects to homepage, add category pages
      urls.push(
        `${origin}/product-category/firearms/`,
        `${origin}/product-category/clearance/`,
      );
    }

    urls.push(
      `${origin}/shop/?orderby=date`,
      `${origin}/?post_type=product&orderby=date&order=desc`,
      `${origin}/product/`,
      `${origin}/products/`,
      `${origin}/`,                     // Homepage fallback (some themes only show products here)
    );

    return urls;
  }

  /** Returns true for WooCommerce category-page URLs that aren't real products */
  private isCategoryPageUrl(url: string): boolean {
    return /\/product-category\//i.test(url);
  }

  async fetchCatalogPage(
    origin: string,
    page: number,
    options?: { sortBy?: 'newest' | 'oldest'; perPage?: number; dateAfter?: string; dateBefore?: string },
  ): Promise<CatalogPage> {
    const perPage = Math.min(options?.perPage ?? 100, 100);
    const ua = pickUserAgent(new URL(origin).hostname);
    const headers = { 'User-Agent': ua, Accept: 'application/json' };
    const order = options?.sortBy === 'oldest' ? 'asc' : 'desc';
    const hasDateFilter = !!(options?.dateAfter || options?.dateBefore);

    const seen = new Map<string, CatalogProduct>(); // URL → product (Store API data preferred)
    let totalPages: number | undefined;

    // 1. WP REST API first — returns ALL published products (including out-of-stock)
    //    Supports `after`/`before` ISO 8601 date params for tier date filtering
    try {
      const params: Record<string, any> = {
        per_page: perPage, page, orderby: 'date', order,
        _embed: 'wp:featuredmedia',
      };
      if (options?.dateAfter) params.after = options.dateAfter;
      if (options?.dateBefore) params.before = options.dateBefore;

      const resp = await axios.get(`${origin}/wp-json/wp/v2/product`, {
        params,
        headers,
        timeout: 15000,
        validateStatus: (s) => s === 200,
      });

      if (Array.isArray(resp.data)) {
        totalPages = parseInt(resp.headers['x-wp-totalpages'] || '0', 10) || undefined;
        for (const p of resp.data) {
          const url = p.link || `${origin}/?p=${p.id}`;
          if (this.isCategoryPageUrl(url)) continue;
          const embedded = p._embedded?.['wp:featuredmedia']?.[0];
          const thumb = embedded?.media_details?.sizes?.thumbnail?.source_url
            || embedded?.media_details?.sizes?.medium?.source_url
            || embedded?.source_url
            || undefined;
          seen.set(url, {
            url,
            title: this.decodeHtml(p.title?.rendered || p.name || '').slice(0, 160),
            price: undefined,
            stockStatus: 'unknown' as const,
            thumbnail: thumb,
          });
        }
      }
    } catch { /* fall through */ }

    // 2. Store API — enrich with prices, thumbnails, stock for in-stock products
    //    Skip when date filtering is active: Store API doesn't support before/after,
    //    so its pagination won't align with the WP REST date-filtered results.
    if (!hasDateFilter) {
      try {
        const resp = await axios.get(`${origin}/wp-json/wc/store/v1/products`, {
          params: { per_page: perPage, page, orderby: 'date', order },
          headers,
          timeout: 15000,
          validateStatus: (s) => s === 200,
        });

        if (Array.isArray(resp.data)) {
          if (!totalPages) {
            totalPages = parseInt(resp.headers['x-wp-totalpages'] || '0', 10) || undefined;
          }
          for (const p of resp.data) {
            const url = p.permalink || `${origin}/?p=${p.id}`;
            if (this.isCategoryPageUrl(url)) continue;
            // Store API has richer data — merge over WP REST entry
            const existing = seen.get(url);
            const storeThumb = p.images?.[0]?.src || p.images?.[0]?.thumbnail || undefined;
            const storeCats = Array.isArray(p.categories)
              ? p.categories.map((c: any) => c.name || c.slug).filter(Boolean).join(',')
              : undefined;
            seen.set(url, {
              url,
              title: this.decodeHtml(p.name || '').slice(0, 160),
              price: p.prices?.price ? parseInt(p.prices.price, 10) / 100 : undefined,
              stockStatus: p.is_purchasable !== false ? 'in_stock' as const : 'out_of_stock' as const,
              thumbnail: storeThumb || existing?.thumbnail,
              sourceCategory: storeCats || existing?.sourceCategory,
            });
          }
        }
      } catch { /* Store API unavailable — WP REST results still usable */ }
    }

    return {
      products: [...seen.values()],
      totalPages,
    };
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
      '.product-small',                // Flatsome theme (doctordeals, etc.)
      'div[class*="product"][class*="type-product"]', // Generic div-based WooCommerce products
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
        if (this.isNavTitle(title)) return;

        const url = this.extractLink(element, baseUrl);
        if (!url || seen.has(url)) return;
        if (this.isNavUrl(url)) return;
        if (this.isCategoryPageUrl(url)) return;
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
