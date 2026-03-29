import type * as cheerio from 'cheerio';
import type { ScrapedMatch, ExtractionOptions, ScrapeOptions, CatalogProduct, CatalogPage } from '../types';
import { AbstractAdapter } from './base';
import axios from 'axios';
import { pickUserAgent } from '../http-client';
import { ensureCookies, reportFailure, solveCookies } from '../waf-cookie-manager';

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
  supportsDateFilter = true; // WP REST API supports modified_after/modified_before

  getSearchUrl(origin: string, keyword: string): string {
    return `${origin}/?s=${encodeURIComponent(keyword)}&post_type=product`;
  }

  async searchViaApi(origin: string, keyword: string, options: ScrapeOptions): Promise<ScrapedMatch[]> {
    let ua = pickUserAgent(new URL(origin).hostname);
    let headers: Record<string, string> = { 'User-Agent': ua, Accept: 'application/json' };
    const limit = options.fast ? 10 : 100;
    const apiTimeout = options.fast ? 8000 : 15000;

    // For WAF-protected sites, get cookies first so API calls aren't blocked
    if (options.hasWaf) {
      try {
        const { ensureCookies } = await import('../waf-cookie-manager');
        const domain = new URL(origin).hostname;
        const creds = await ensureCookies(domain, origin);
        headers = { 'User-Agent': creds.userAgent, Accept: 'application/json', Cookie: creds.cookies };
        ua = creds.userAgent;
      } catch { /* fall through without cookies */ }
    }

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
      const inStock = p.is_in_stock !== false;

      matches.push({
        title: name.slice(0, 160),
        price: price && price > 0 ? price : undefined,
        url,
        thumbnail,
        inStock,
        sourceId: p.id ? String(p.id) : undefined,
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
        sourceId: p.id ? String(p.id) : undefined,
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

        // Extract WooCommerce product ID from HTML attributes or CSS classes
        const sourceId = element.attr('data-product_id')
          || element.attr('data-product-id')
          || element.closest('[data-product_id]').attr('data-product_id')
          || element.closest('[data-product-id]').attr('data-product-id')
          || element.attr('class')?.match(/post-(\d+)/)?.[1]
          || undefined;

        seen.add(titleKey);
        matches.push({ title: rawTitle, price, url: productUrl, inStock, thumbnail, sourceId });
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

    // Read catalog URLs from site profile (replaces hardcoded domain checks)
    try {
      const domain = new URL(origin).hostname.replace(/^www\./, '');
      const { _getSiteCacheEntry } = require('../adapter-registry');
      const entry = _getSiteCacheEntry?.(domain);
      if (entry?.siteProfile?.catalogUrls?.length) {
        for (const u of entry.siteProfile.catalogUrls) {
          urls.push(u.startsWith('http') ? u : `${origin}${u}`);
        }
      }
    } catch { /* profile lookup failed — use defaults below */ }

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
    options?: { sortBy?: 'newest' | 'oldest'; perPage?: number; dateAfter?: string; dateBefore?: string; hasWaf?: boolean },
  ): Promise<CatalogPage> {
    const perPage = Math.min(options?.perPage ?? 100, 100);
    const order = options?.sortBy === 'oldest' ? 'asc' : 'desc';
    const hasDateFilter = !!(options?.dateAfter || options?.dateBefore);

    // For Sucuri WAF sites: use Playwright-obtained cookies for fast API access
    let ua = pickUserAgent(new URL(origin).hostname);
    let headers: Record<string, string> = { 'User-Agent': ua, Accept: 'application/json' };
    if (options?.hasWaf) {
      try {
        const domain = new URL(origin).hostname;
        const { cookies, userAgent } = await ensureCookies(domain, origin);
        ua = userAgent; // Must match the UA used during Playwright solve
        headers = { 'User-Agent': ua, Accept: 'application/json', Cookie: cookies };
      } catch (err) {
        // Cookie acquisition failed — throw to trigger HTML fallback in catalog-crawler
        throw new Error(`WAF_COOKIE_FAILED: ${err instanceof Error ? err.message : err}`);
      }
    }

    const seen = new Map<string, CatalogProduct>(); // URL → product (Store API data preferred)
    const wpIdToUrl = new Map<number, string>();     // WP product ID → URL (for Store API enrichment)
    let totalPages: number | undefined;

    // 1. WP REST API first — returns ALL published products (including out-of-stock)
    //    Uses `modified_after`/`modified_before` + `orderby=modified` to catch restocks,
    //    price changes, and any product modification — not just newly published products.
    //    Falls back to `after`/`before` + `orderby=date` when no date filter (page-aligned with Store API).
    try {
      const params: Record<string, any> = {
        per_page: perPage, page,
        orderby: hasDateFilter ? 'modified' : 'date',
        order,
        _embed: 'wp:featuredmedia,wp:term',
      };
      if (options?.dateAfter) params.modified_after = options.dateAfter;
      if (options?.dateBefore) params.modified_before = options.dateBefore;

      let resp = await axios.get(`${origin}/wp-json/wp/v2/product`, {
        params,
        headers,
        timeout: options?.hasWaf ? 30000 : 15000, // WAF sites need more time
        validateStatus: (s) => s === 200 || s === 307 || s === 403,
      });

      // Sucuri WAF blocked — cookie expired or invalid
      if (resp.status === 307 || resp.status === 403) {
        if (options?.hasWaf) {
          const domain = new URL(origin).hostname;
          await reportFailure(domain);
          // Retry once with fresh cookies
          const fresh = await solveCookies(domain, origin);
          headers = { 'User-Agent': fresh.userAgent, Accept: 'application/json', Cookie: fresh.cookies };
          resp = await axios.get(`${origin}/wp-json/wp/v2/product`, {
            params, headers, timeout: 30000, validateStatus: (s) => s === 200,
          });
        } else {
          throw new Error(`WP REST API returned ${resp.status}`);
        }
      }

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

          // Extract category names from embedded wp:term taxonomy groups
          const wpTermCats = this.extractWpTermCategories(p._embedded?.['wp:term']);

          seen.set(url, {
            url,
            sourceId: p.id ? String(p.id) : undefined,
            title: this.decodeHtml(p.title?.rendered || p.name || '').slice(0, 160),
            price: undefined,
            stockStatus: 'unknown' as const,
            thumbnail: thumb,
            tags: wpTermCats,
            sourceCategory: wpTermCats,
          });
          if (p.id) wpIdToUrl.set(p.id, url);
        }
      }
    } catch (err) {
      // Rethrow timeouts and network errors — let the caller (crawlStreamTier) handle retry.
      // Only swallow parse/data errors where we can fall through to Store API.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('timeout') || msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('WAF_COOKIE_FAILED')) {
        throw err;
      }
      // Other errors (parse, malformed response) — fall through to Store API
    }

    // 2. Store API — enrich with prices, thumbnails, stock, categories
    //    Uses `include` param with WP REST product IDs + two stock_status passes
    //    (default=in-stock, then outofstock) to cover all products.
    //    When no date filter, also fetches the aligned page for totalPages header.
    if (!hasDateFilter && !totalPages) {
      // Quick probe for totalPages (needed for pagination upstream)
      try {
        const resp = await axios.get(`${origin}/wp-json/wc/store/v1/products`, {
          params: { per_page: 1, page: 1 },
          headers,
          timeout: options?.hasWaf ? 30000 : 10000,
          validateStatus: (s) => s === 200,
        });
        totalPages = parseInt(resp.headers['x-wp-totalpages'] || '0', 10) || totalPages;
      } catch { /* ignore */ }
    }

    if (wpIdToUrl.size > 0) {
      // Enrich WP REST products via Store API `include` param.
      // Two passes: in-stock (default) then out-of-stock, since Store API
      // only returns in-stock products unless stock_status=outofstock is set.
      const ids = [...wpIdToUrl.keys()];
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        for (const stockFilter of [undefined, 'outofstock'] as const) {
          try {
            const params: Record<string, any> = { include: chunk.join(','), per_page: chunk.length };
            if (stockFilter) params.stock_status = stockFilter;
            const resp = await axios.get(`${origin}/wp-json/wc/store/v1/products`, {
              params,
              headers,
              timeout: options?.hasWaf ? 30000 : 15000,
              validateStatus: (s) => s === 200,
            });
            if (Array.isArray(resp.data)) {
              this.mergeStoreApiProducts(resp.data, seen, origin);
            }
          } catch (enrichErr) {
            // Log enrichment failures — this is why products have no prices
            const msg = enrichErr instanceof Error ? enrichErr.message : String(enrichErr);
            console.log(`[WooCommerce] Store API enrichment failed for ${origin} (chunk ${i}-${i + chunk.length}): ${msg.substring(0, 80)}`);
          }
        }
      }
    }

    return {
      products: [...seen.values()],
      totalPages,
    };
  }

  /** Extract product_cat names from WP REST API embedded wp:term groups */
  private extractWpTermCategories(termGroups: any[] | undefined): string | undefined {
    if (!Array.isArray(termGroups)) return undefined;
    const names: string[] = [];
    for (const group of termGroups) {
      if (!Array.isArray(group)) continue;
      for (const term of group) {
        if (term.taxonomy === 'product_cat' && term.name) {
          names.push(this.decodeHtml(term.name));
        }
      }
    }
    return names.length > 0 ? names.join(',') : undefined;
  }

  /** Merge Store API product data into the seen map (prices, stock, categories, thumbnails) */
  private mergeStoreApiProducts(
    products: any[],
    seen: Map<string, CatalogProduct>,
    origin: string,
  ): void {
    for (const p of products) {
      const url = p.permalink || `${origin}/?p=${p.id}`;
      if (this.isCategoryPageUrl(url)) continue;
      const existing = seen.get(url);
      const storeThumb = p.images?.[0]?.src || p.images?.[0]?.thumbnail || undefined;
      const storeCats = Array.isArray(p.categories)
        ? p.categories.map((c: any) => c.name || c.slug).filter(Boolean).join(',')
        : undefined;
      const rawP = p.prices?.price ? parseInt(p.prices.price, 10) / 100 : undefined;
      seen.set(url, {
        url,
        sourceId: existing?.sourceId || (p.id ? String(p.id) : undefined),
        title: this.decodeHtml(p.name || '').slice(0, 160),
        price: rawP && rawP > 0 ? rawP : undefined,
        stockStatus: p.is_in_stock === true ? 'in_stock' as const : 'out_of_stock' as const,
        thumbnail: storeThumb || existing?.thumbnail,
        tags: storeCats || existing?.tags,
        sourceCategory: storeCats || existing?.sourceCategory,
      });
    }
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

        // Extract WooCommerce product ID from HTML attributes or CSS classes
        const sourceId = element.attr('data-product_id')
          || element.attr('data-product-id')
          || element.closest('[data-product_id]').attr('data-product_id')
          || element.closest('[data-product-id]').attr('data-product-id')
          || element.attr('class')?.match(/post-(\d+)/)?.[1]
          || undefined;

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
