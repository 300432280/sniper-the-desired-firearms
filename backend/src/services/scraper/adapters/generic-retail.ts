import type * as cheerio from 'cheerio';
import type { ScrapedMatch, ExtractionOptions, CatalogProduct, CatalogPage } from '../types';
import { AbstractAdapter } from './base';
import axios from 'axios';
import { fetchPageWithMeta } from '../http-client';

/**
 * Generic retail adapter — fallback for non-Shopify, non-WooCommerce retailers.
 * Tries common product card patterns, then falls back to link-based extraction.
 */
export class GenericRetailAdapter extends AbstractAdapter {
  name = 'GenericRetail';
  siteType = 'retailer' as const;
  supportsDateFilter = false;

  /**
   * Get search URL — reads from site profile first, falls back to generic pattern.
   */
  getSearchUrl(origin: string, keyword: string): string {
    const profile = GenericRetailAdapter._getProfileSync(origin);
    if (profile?.searchUrl) {
      return `${origin}${profile.searchUrl.replace('{keyword}', encodeURIComponent(keyword))}`;
    }
    // Default: /search?q= (works for most generic sites)
    return `${origin}/search?q=${encodeURIComponent(keyword)}`;
  }

  /**
   * Synchronous profile lookup from adapter registry cache.
   * Returns null if no profile exists.
   */
  private static _getProfileSync(origin: string): any | null {
    try {
      const domain = new URL(origin).hostname.replace(/^www\./, '');
      // Access the adapter registry's site cache directly
      // This is populated during refreshCache() which runs every 5 minutes
      const { _getSiteCacheEntry } = require('../adapter-registry');
      return _getSiteCacheEntry?.(domain)?.siteProfile ?? null;
    } catch {
      return null;
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

    // Phase 1: Try structured product card selectors
    const SELECTORS = [
      '[data-product-id]',
      'li.product',
      'li[class*="product"]',
      '[class*="product-card"]',
      '[class*="product-item"]',
      '[class*="product-tile"]',
      '[class*="ProductItem"]',
      '[class*="item-card"]',
      '[class*="grid-item"]',
      '[data-product]',
      'article[class*="product"]',
      '.card',                       // BigCommerce
      '.products-list .item',        // Magento
      '.products-grid .item',        // Magento
      'li.product-item',             // Magento
      '.product-items > .product-item', // Magento
      '.productborder',              // LightSpeed Classic theme (gagnonsports, etc.)
      '.product-grid[class*="col-"]', // LightSpeed Nova theme (solelyoutdoors, etc.)
      '[class*="product-thumb"]',    // OpenCart (including product-thumb_ variants)
      '[class*="product-layout"]',   // OpenCart grid/list (including product-layout_ variants)
      'div.product',                 // Generic product div
      'a.product',                   // Anchor-based product card (bullseyenorth ColdFusion)
      '[class*="klevuProduct"]',     // Klevu JS search overlay (BigCommerce, etc.)
      '.kuResultsListing li',        // Klevu search results list
      '[class*="hikashop_product"]', // HikaShop (Joomla — e.g. lockharttactical.com)
      '.category_products .product', // 3dcart/Shift4Shop
      '[class*="product-index"]',   // 3dcart/Shift4Shop grid
      '.listing-item',              // GoDaddy OLS / generic classifieds
      '[class*="ols-product"]',     // GoDaddy Online Store
      '.store_product_list_wrapper', // Activant/Epicor iNet (canadasgunstore)
      '.grid-product',               // Ecwid (triggersandbows)
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
        // Skip category/nav URLs that aren't actual product pages
        if (this.isNavUrl(productUrl)) return;

        const { price, regularPrice } = this.extractPricesFromElement(element);
        const inStock = this.isInStock(element);
        const thumbnail = this.extractThumbnail($, element, baseUrl);
        let sourceId = element.attr('data-product-id')
          || element.closest('[data-product-id]').attr('data-product-id')
          || undefined;
        if (!sourceId && productUrl) {
          const urlIdMatch = productUrl.match(/-(\d{4,})(?:[?#]|$)/);
          if (urlIdMatch) sourceId = urlIdMatch[1];
        }

        if (options.inStockOnly && !inStock) return;
        if (options.maxPrice && price && price > options.maxPrice) return;

        seen.add(titleKey);
        matches.push({ title: rawTitle, price, regularPrice, url: productUrl, inStock, thumbnail, sourceId });
      });
    }

    // Phase 2: If no card-based matches, fall back to link-based extraction
    // Finds <a> tags whose text contains the keyword and whose href looks like a product URL
    if (matches.length === 0) {
      const origin = (() => { try { return new URL(baseUrl).origin; } catch { return ''; } })();

      $('a[href]').each((_, el) => {

        const a = $(el);
        const text = a.text().trim().replace(/\s+/g, ' ');
        const href = a.attr('href') || '';

        // Must contain keyword and be a real product link
        if (!text.toLowerCase().includes(keywordLower)) return;
        if (text.length < 8 || text.length > 500) return;
        if (/^\$?\d[\d,.]*$/.test(text)) return; // Just a price
        if (this.isNavTitle(text)) return;

        // Skip navigation/breadcrumb/pagination/category links
        if (href === '#' || href === baseUrl) return;
        // Skip navigation links — but check path only, not query params
        const hrefPath = href.split('?')[0];
        if (/\/(cart|login|register|account|page\/\d|search)\b/i.test(hrefPath)) return;
        if (this.isNavUrl(href)) return;

        // Resolve URL
        let fullUrl: string;
        try {
          fullUrl = href.startsWith('http') ? href : new URL(href, baseUrl).toString();
        } catch { return; }

        // Must be same-origin
        if (origin && !fullUrl.startsWith(origin)) return;

        const titleKey = text.toLowerCase().slice(0, 60);
        if (seen.has(titleKey)) return;

        // Walk up to find the product container — go higher than just the immediate parent
        const parent = this.findProductContainer($, a);
        let price: number | undefined;
        let regularPrice: number | undefined;
        let thumbnail: string | undefined;

        if (parent && parent.length) {
          const prices = this.extractPricesFromElement(parent);
          price = prices.price;
          regularPrice = prices.regularPrice;
          thumbnail = this.extractThumbnail($, parent, baseUrl);
        }

        if (options.maxPrice && price && price > options.maxPrice) return;

        seen.add(titleKey);
        matches.push({ title: text.slice(0, 160), price, regularPrice, url: fullUrl, inStock: true, thumbnail });
      });
    }

    return matches;
  }

  // ── Catalog Crawl Methods (Phase 3) ───────────────────────────────────────

  /**
   * Site-specific product listing URLs — reads from site profile.
   * Falls back to empty array if no profile (generic URLs added by callers).
   */
  private _getSiteSpecificUrls(origin: string): string[] {
    const profile = GenericRetailAdapter._getProfileSync(origin);
    if (profile?.catalogUrls?.length) {
      return profile.catalogUrls.map((u: string) => u.startsWith('http') ? u : `${origin}${u}`);
    }

    // No profile — return empty (generic URLs added by callers)
    return [];
  }

  // Platform detection domain lists REMOVED — sort params now in siteProfile.sortParam

  /**
   * URLs for Tier 1 watermark crawl (new product discovery).
   * Sort parameters come from site profile.
   * so T1 reliably catches ALL new listings on every platform.
   */
  getNewArrivalsUrls(origin: string): string[] {
    const profile = GenericRetailAdapter._getProfileSync(origin);
    const siteUrls = this._getSiteSpecificUrls(origin);
    const sortParam = profile?.sortParam || '';

    // Apply sort param from profile to each site-specific URL
    const sortedUrls = sortParam
      ? siteUrls.map(url => {
          if (/[?&](sort=|orderby=|product_list_order=)/.test(url)) return url; // Already has sort
          return url + (url.includes('?') ? '&' : '') + sortParam.replace(/^\?/, '');
        })
      : [];

    const urls = [...sortedUrls, ...siteUrls];

    // Generic fallback URLs with platform-aware sort params from profile
    const platform = profile?.platform || '';
    const platformSort = sortParam || ({
      bigcommerce: 'sort=newest',
      magento: 'product_list_order=created_at&product_list_dir=desc',
      lightspeed: 'sort=newest',
      coldfusion: 'sort=new-arrivals',
    } as Record<string, string>)[platform] || '';

    urls.push(
      `${origin}/new-arrivals`,
      `${origin}/whats-new`,
      ...(platformSort ? [`${origin}/?${platformSort}`] : []),
      `${origin}/shop/?orderby=date`,
      `${origin}/`,
    );

    return [...new Set(urls)];
  }

  getNewArrivalsUrl(origin: string): string {
    return `${origin}/new-arrivals`;
  }

  /**
   * URLs for Tiers 2-4 full catalog refresh.
   * Site-specific category/listing URLs + generic catalog fallback patterns.
   * These cover the full product catalog for updating prices, stock, thumbnails.
   */
  getCatalogUrls(origin: string): string[] {
    const urls = this._getSiteSpecificUrls(origin);

    // Generic catalog URL patterns (full product listing pages)
    urls.push(
      `${origin}/categories.php`,         // BigCommerce all-categories page
      `${origin}/shop/`,                  // WooCommerce/generic shop page
      `${origin}/products`,               // Common pattern
      `${origin}/`,                       // Homepage (last resort)
    );

    return [...new Set(urls)]; // Deduplicate (site-specific may overlap with generic)
  }

  // ── Klevu API integration (alflahertys.com) ──────────────────────────────
  // Products are rendered entirely by Klevu JS overlay — no server-side HTML.
  // The Klevu search API is public (key embedded in page source) and returns
  // structured product data with prices, stock status, images, and URLs.

  // Klevu config defaults (overridden by siteProfile.apiConfig)
  private static KLEVU_DEFAULTS = { perPage: 36 };

  /** Discover the Klevu categoryPath for a page using profile or HTML fallback. */
  private async _resolveKlevuCategoryPath(pageUrl: string): Promise<string | null> {
    // Check profile's klevuCategoryPaths first
    const profile = GenericRetailAdapter._getProfileSync(new URL(pageUrl).origin);
    const paths = profile?.apiConfig?.klevuCategoryPaths || [];
    const urlLower = pageUrl.toLowerCase();
    for (const { slug, path } of paths) {
      if (urlLower.includes(slug)) return path;
    }
    // Fallback: fetch the page and extract klevu_pageCategory
    try {
      const result = await fetchPageWithMeta(pageUrl);
      const match = result.html.match(/var\s+klevu_pageCategory\s*=\s*["']([^"']+)/);
      if (match) return match[1].replace(/&amp;/g, '&');
    } catch { /* ignore — will fall through to HTML extraction */ }
    return null;
  }

  /**
   * Fetch a catalog page for alflahertys.com via the Klevu search API.
   * Returns null for non-alflahertys sites (falls through to HTML-based extraction).
   */
  async fetchCatalogPage(
    origin: string,
    page: number,
    options?: { sortBy?: 'newest' | 'oldest'; perPage?: number; dateAfter?: string; dateBefore?: string },
  ): Promise<CatalogPage> {
    // Only use Klevu API for sites with klevuApiKey in profile
    const profile = GenericRetailAdapter._getProfileSync(origin);
    if (!profile?.apiConfig?.klevuApiKey) {
      return { products: [] };
    }

    const klevuKey = profile.apiConfig.klevuApiKey;
    const klevuEndpoint = profile.apiConfig.klevuEndpoint || 'https://uscs33v2.ksearchnet.com/cs/v2/search';
    const perPage = options?.perPage || GenericRetailAdapter.KLEVU_DEFAULTS.perPage;
    const offset = (page - 1) * perPage;
    const allProducts: CatalogProduct[] = [];
    let maxTotalPages = 0;

    // Fetch ALL products via wildcard SEARCH (not per-category CATNAV).
    try {
      const response = await axios.post(klevuEndpoint, {
        context: { apiKeys: [klevuKey] },
        recordQueries: [{
          id: 'catalog',
          typeOfRequest: 'SEARCH',
          settings: {
            query: { term: '*' },
            limit: perPage,
            offset,
            sort: 'RELEVANCE',
            fields: ['name', 'url', 'price', 'salePrice', 'image', 'sku', 'inStock', 'id', 'category'],
            typeOfRecords: ['KLEVU_PRODUCT'],
          },
        }],
      }, {
        timeout: 15000,
        headers: { 'Content-Type': 'application/json' },
      });

      const qr = response.data?.queryResults?.[0];
      if (qr?.records?.length) {
        const total = qr.meta?.totalResultsFound || 0;
        maxTotalPages = Math.ceil(total / perPage);

        for (const r of qr.records) {
          if (!r.name || !r.url) continue;
          // Derive tags from Klevu category field (e.g. "Optics;Scopes" → "scopes")
          const categoryParts = (r.category || '').split(';');
          const tag = categoryParts.length > 0 ? categoryParts[categoryParts.length - 1].trim().toLowerCase() : undefined;

          allProducts.push({
            url: r.url,
            sourceId: r.id || undefined,
            title: (r.name || '').trim().slice(0, 160),
            price: r.salePrice ? parseFloat(r.salePrice) : (r.price ? parseFloat(r.price) : undefined),
            regularPrice: r.salePrice && r.price && parseFloat(r.price) > parseFloat(r.salePrice)
              ? parseFloat(r.price) : undefined,
            stockStatus: r.inStock === 'yes' ? 'in_stock' : 'out_of_stock',
            thumbnail: r.image || undefined,
            tags: tag || undefined,
            sourceCategory: categoryParts.length > 1 ? categoryParts.slice(0, 2).join(' > ') : undefined,
          });
        }
      }
    } catch (err) {
      console.log(`[GenericRetail] Klevu API error: ${err instanceof Error ? err.message : err}`);
    }

    // Deduplicate by URL (products may appear in multiple categories)
    const seen = new Set<string>();
    const deduped = allProducts.filter(p => {
      if (seen.has(p.url)) return false;
      seen.add(p.url);
      return true;
    });

    return {
      products: deduped,
      totalPages: maxTotalPages > 0 ? maxTotalPages : undefined,
      nextPageUrl: deduped.length >= perPage ? `klevu://page/${page + 1}` : undefined,
    };
  }

  extractCatalogProducts($: cheerio.CheerioAPI, baseUrl: string): CatalogProduct[] {
    const products: CatalogProduct[] = [];
    const seen = new Set<string>();

    // Derive category tag from the catalog page URL path
    // e.g., "/ammunition" → "ammunition", "/firearms/rifles" → "firearms,rifles"
    // Also check breadcrumbs on the page for richer category info
    const categoryTag = this._deriveCategoryTag($, baseUrl);

    // Same selectors as extractMatches, but without keyword filtering
    const SELECTORS = [
      '[data-product-id]',
      'li.product',
      'li[class*="product"]',
      '[class*="product-card"]',
      '[class*="product-item"]',
      '[class*="product-tile"]',
      '[class*="ProductItem"]',
      '[class*="item-card"]',
      '[data-product]',
      'article[class*="product"]',
      '.card',                       // BigCommerce
      '.products-list .item',        // Magento
      '.products-grid .item',        // Magento
      'li.product-item',             // Magento
      '.product-items > .product-item', // Magento
      '.productborder',              // LightSpeed Classic theme
      '.product-grid[class*="col-"]', // LightSpeed Nova theme (solelyoutdoors)
      '.product-thumb',              // OpenCart
      '.product-layout',             // OpenCart
      'div.product',
      'a.product',                   // Anchor-based product card (bullseyenorth ColdFusion)
      '[class*="klevuProduct"]',     // Klevu JS search overlay (BigCommerce, etc.)
      '.kuResultsListing li',        // Klevu search results list
      '[class*="hikashop_product"]', // HikaShop (Joomla)
      '.category_products .product', // 3dcart/Shift4Shop
      '[class*="product-index"]',   // 3dcart/Shift4Shop grid
      '.listing-item',              // GoDaddy OLS / generic classifieds
      '[class*="ols-product"]',     // GoDaddy Online Store
      '.store_product_list_wrapper', // Activant/Epicor iNet (canadasgunstore)
      '.grid-product',               // Ecwid (triggersandbows)
    ];

    for (const selector of SELECTORS) {
      $(selector).each((_, el) => {
        const element = $(el);

        const title = this.extractTitle(element, element.text());
        if (!title || title.length < 3) return;
        if (/^\$?\d[\d,.]*$/.test(title)) return;
        // Reject obvious nav/category labels (short, generic, no specifics)
        if (this.isNavTitle(title)) return;

        const url = this.extractLink(element, baseUrl);
        if (!url || seen.has(url)) return;
        if (this.isNavUrl(url)) return;
        seen.add(url);

        const { price, regularPrice } = this.extractPricesFromElement(element);
        const inStock = this.isInStock(element);
        const thumbnail = this.extractThumbnail($, element, baseUrl);
        let sourceId = element.attr('data-product-id')
          || element.attr('data-product_id')  // WooCommerce uses underscore
          || element.closest('[data-product-id]').attr('data-product-id')
          || element.closest('[data-product_id]').attr('data-product_id')
          || element.attr('class')?.match(/\bpost-(\d+)\b/)?.[1]  // WooCommerce post ID in class
          || undefined;
        // Fallback: extract numeric product ID from URL (e.g. bullseyenorth /shop/slug-28443)
        if (!sourceId && url) {
          const urlIdMatch = url.match(/-(\d{4,})(?:[?#]|$)/);
          if (urlIdMatch) sourceId = urlIdMatch[1];
        }

        products.push({
          url,
          sourceId,
          title,
          price,
          regularPrice,
          stockStatus: inStock ? 'in_stock' : 'out_of_stock',
          thumbnail,
          tags: categoryTag,
        });
      });
    }

    // Phase 2: link-based fallback for sites without standard product card markup
    // (e.g., custom PHP stores, classifieds, HikaShop)
    if (products.length === 0) {
      const origin = (() => { try { return new URL(baseUrl).origin; } catch { return ''; } })();

      $('a[href]').each((_, el) => {
        const a = $(el);
        const href = a.attr('href') || '';
        const text = a.text().trim().replace(/\s+/g, ' ');

        if (text.length < 8 || text.length > 300) return;
        if (/^\$?\d[\d,.]*$/.test(text)) return;
        if (this.isNavTitle(text)) return;

        // Skip navigation links
        const hrefPath = href.split('?')[0];
        if (href === '#' || href === baseUrl) return;
        if (/\/(cart|login|register|account|page\/\d|search|contact|about|faq|privacy|terms)\b/i.test(hrefPath)) return;
        if (this.isNavUrl(href)) return;

        // Must look like a product/detail page link (not a navigation link)
        const isProductLink = /\/(product|item|lot|p\/|listing|detail|shop\/ols\/products|departments)\b/i.test(hrefPath) ||
          /\.(html?|php|asp)(\?|$)/.test(href) ||
          /product_detail|product\.php|product_name|_p\//i.test(href);
        if (!isProductLink) return;
        // Volusion/3dcart category pages use _s/ pattern — not product pages
        if (/_s\/\d+\.htm/i.test(href)) return;

        let fullUrl: string;
        try {
          fullUrl = href.startsWith('http') ? href : new URL(href, baseUrl).toString();
        } catch { return; }

        if (origin && !fullUrl.startsWith(origin)) return;
        if (seen.has(fullUrl)) return;
        seen.add(fullUrl);

        const parent = this.findProductContainer($, a);
        const prices = parent?.length ? this.extractPricesFromElement(parent) : {};
        const thumbnail = parent?.length ? this.extractThumbnail($, parent, baseUrl) : undefined;

        products.push({
          url: fullUrl,
          title: text.slice(0, 160),
          price: prices.price,
          regularPrice: prices.regularPrice,
          stockStatus: 'in_stock',
          thumbnail,
          tags: categoryTag,
        });
      });
    }

    return products;
  }

  getNextPageUrl($: cheerio.CheerioAPI, currentUrl: string): string | null {
    // Try common pagination patterns across platforms
    const nextLink = $(
      'a.next, a[rel="next"], ' +                                    // Standard
      '[class*="pagination"] a:contains("Next"), ' +                  // Text-based
      '[class*="pagination"] a:contains("›"), ' +                     // Arrow-based
      '.pagination-item--next a, ' +                                  // BigCommerce
      '.pages-item-next a, ' +                                        // Magento
      'a.page-numbers.next'                                           // WordPress
    ).first();

    if (nextLink.length) {
      const href = nextLink.attr('href');
      if (href) return this.resolveUrl(href, currentUrl);
    }
    return null;
  }

  /**
   * Derive a category tag from the catalog page URL path and/or breadcrumbs.
   * Returns a comma-separated string like "ammunition" or "firearms,rifles", or undefined.
   */
  private _deriveCategoryTag($: cheerio.CheerioAPI, pageUrl: string): string | undefined {
    // 1. Try breadcrumbs on the page (most accurate)
    const breadcrumbSel = '.breadcrumb, [class*="breadcrumb"], nav[aria-label="breadcrumb"], .crumbs, #breadcrumbs';
    const bcEl = $(breadcrumbSel).first();
    if (bcEl.length) {
      const crumbs = bcEl.find('a, span, li')
        .map((_, el) => $(el).text().trim().toLowerCase())
        .get()
        .filter(t => t.length > 1 && !/^(home|all|shop|products?|store|catalog)$/i.test(t));
      if (crumbs.length > 0) {
        // Deduplicate and take up to 3
        return [...new Set(crumbs)].slice(0, 3).join(',');
      }
    }

    // 2. Fall back to URL path segments
    try {
      const path = new URL(pageUrl).pathname;
      const segments = path.split('/').filter(Boolean)
        .map(s => decodeURIComponent(s).replace(/[-_+]/g, ' ').toLowerCase())
        .filter(s => !/^\d+$/.test(s))                          // skip numeric IDs
        .filter(s => !/^(shop|products?|catalog|page|index|all|categories?)$/i.test(s)) // skip generic
        .filter(s => s.length > 1 && s.length < 40);
      if (segments.length > 0) {
        return segments.slice(0, 3).join(',');
      }
    } catch { /* ignore */ }

    return undefined;
  }

  /** Walk up from a link element to find the nearest product-like container */
  private findProductContainer($: cheerio.CheerioAPI, el: cheerio.Cheerio<any>): cheerio.Cheerio<any> | null {
    // First try specific product container selectors
    const container = el.closest(
      '[class*="productborder"], [class*="product-card"], [class*="product-item"], ' +
      '[class*="product-tile"], [class*="item-card"], [class*="grid-item"], ' +
      'li.product, div.product, a.product, article, .card, [data-product-id], [data-product]'
    );
    if (container.length) return container;

    // Fall back to walking up a few levels to find a container with both text and img/price
    let current = el.parent();
    for (let i = 0; i < 6 && current.length; i++) {
      const hasImg = current.find('img').length > 0;
      const hasPrice = current.find('[class*="price"]').length > 0 ||
                       /(?:C?\$\s*[\d,]+\.\d{2})/.test(current.text().slice(0, 500));
      if (hasImg || hasPrice) return current;
      current = current.parent();
    }

    // Last resort — immediate parent chain
    return el.closest('li, div, article, section, tr');
  }
}
