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
      '.product-element',            // LightSpeed Developer/custom theme (gobles.ca)
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
      '[data-aid="PRODUCT_LIST_RENDERED"] [data-ux="GridCell"]', // GoDaddy OLS (liangjian.ca)
      'a[href*="/marketplace/"]',    // TownPost classifieds (Next.js SPA, anchor-wrapped cards)
      '[class*="oe_product"]',       // Odoo Website Sale (outfitters.goldnloan.com) — explicit; .card fallback already catches most
      'form[class*="oe_product"]',   // Odoo form-wrapped product cards
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
          const urlIdMatch = productUrl.match(/-(\d{4,})(?:[?#]|$)/) || productUrl.match(/\/(\d{5,})(?:[?#]|$)/);
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
          return url + (url.includes('?') ? '&' : '?') + sortParam.replace(/^\?/, '');
        })
      : [];

    const urls = [...sortedUrls, ...siteUrls];

    // Generic fallback URLs with platform-aware sort params from profile.
    // Keys are engine families; actual stored tags may be more specific
    // (e.g. 'bigcommerce-stencil', 'magento-2.x', 'celerant-coldfusion').
    // Matched via prefix/substring lookup so vendor-specific tags resolve correctly.
    const platform = (profile?.platform || '').toLowerCase();
    const platformSortMap: Record<string, string> = {
      bigcommerce: 'sort=newest',
      magento: 'product_list_order=created_at&product_list_dir=desc',
      lightspeed: 'sort=newest',
      coldfusion: 'sort=new-arrivals', // Matches 'coldfusion' and 'celerant-coldfusion'
    };
    let resolvedPlatformSort = '';
    for (const key of Object.keys(platformSortMap)) {
      if (platform.includes(key)) { resolvedPlatformSort = platformSortMap[key]; break; }
    }
    const platformSort = sortParam || resolvedPlatformSort;

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
   * Fetch a catalog page via a profile-declared API.
   *
   * Two profile-driven branches are supported, in order:
   *   1. `siteProfile.apiAlternative.type === 'mysimplestore'` — GoDaddy OLS sites whose
   *      storefront is a SPA but whose backend exposes a clean Ransack-style JSON API
   *      (e.g. liangjian.ca → 31990017-...mysimplestore.com/api/v2/products).
   *      ~47x faster than the Playwright HTML route, returns real `created_at`.
   *   2. `siteProfile.apiConfig.klevuApiKey` — Klevu-search sites (e.g. alflahertys.com).
   *
   * On any failure (network error, non-200, malformed JSON, missing critical fields)
   * this method returns `null`, which the catalog/watermark crawler interprets as
   * "no API available, fall through to HTML/Playwright extraction." Therefore the
   * existing HTML route remains the universal fallback — we never need to call it
   * from inside this method.
   *
   * Returns null for any site whose profile declares neither branch.
   */
  async fetchCatalogPage(
    origin: string,
    page: number,
    options?: { sortBy?: 'newest' | 'oldest'; perPage?: number; dateAfter?: string; dateBefore?: string },
  ): Promise<CatalogPage | null> {
    const profile = GenericRetailAdapter._getProfileSync(origin);

    // ── Branch 0: Ecwid storefront API (undocumented, used by Ecwid-on-WordPress sites) ──
    // See playbook Mistake 31 and backend/scripts/tb-real-ui4.ts for the canonical
    // UI-drive discovery harness that captured the real POST body byte-for-byte.
    if (profile?.apiAlternative?.type === 'ecwid-storefront-api') {
      try {
        return await this._fetchEcwidStorefrontPage(profile.apiAlternative, page, options);
      } catch (err) {
        console.log(`[GenericRetail] ecwid-storefront-api error for ${origin} page ${page}: ${err instanceof Error ? err.message : err}. Returning null so dispatcher falls back to HTML.`);
        return null;
      }
    }

    // ── Branch: BigCommerce Stencil GraphQL Storefront API ──
    if (profile?.apiAlternative?.type === 'bigcommerce-graphql') {
      try {
        return await this._fetchBigCommerceGraphQLPage(profile.apiAlternative, origin, page, options);
      } catch (err) {
        console.log(`[GenericRetail] bigcommerce-graphql error for ${origin} page ${page}: ${err instanceof Error ? err.message : err}. Returning null so dispatcher falls back to HTML.`);
        return null;
      }
    }

    // ── Branch 1: profile-declared JSON API (e.g. mysimplestore for GoDaddy OLS) ──
    if (profile?.apiAlternative?.type === 'mysimplestore') {
      try {
        return await this._fetchMysimplestorePage(profile.apiAlternative, page, options?.perPage);
      } catch (err) {
        console.log(`[GenericRetail] mysimplestore API error for ${origin} page ${page}: ${err instanceof Error ? err.message : err}. Returning null so dispatcher falls back to HTML.`);
        return null;
      }
    }

    // ── Branch 2: Klevu search API (existing) ──
    // Only use Klevu API for sites with klevuApiKey in profile.
    // Return null for non-Klevu sites so the catalog crawler falls through to HTML extraction.
    if (!profile?.apiConfig?.klevuApiKey) {
      return null;
    }

    // Self-heal the Klevu key — probe stored key first, re-scrape homepage on failure.
    const { resolveKlevuKey } = await import('../klevu-key-resolver');
    const domain = new URL(origin).hostname.replace(/^www\./, '');
    const klevuKey = await resolveKlevuKey(domain, origin, {
      hasWaf: profile?.requiresSucuri || profile?.hasWaf || false,
    });
    if (!klevuKey) {
      console.log(`[GenericRetail] Klevu key unresolved for ${origin} — returning empty catalog page`);
      return { products: [], totalPages: 0 };
    }
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

  /**
   * Fetch a catalog page from a mysimplestore.com REST API (used by GoDaddy OLS sites).
   *
   * Reads ALL site-specific configuration from `apiCfg` (which comes from
   * `siteProfile.apiAlternative`). The adapter has zero hardcoded mysimplestore
   * domains, store IDs, or sort param strings — every site that wants to use this
   * branch must declare its own config in the profile. The shape we expect:
   *
   *   {
   *     type: 'mysimplestore',
   *     baseUrl: 'https://<storeId>.mysimplestore.com',
   *     productsEndpoint: '/api/v2/products',
   *     appParam: 'app=vnext',                       // raw `key=value` string, may be omitted
   *     sortParam: 'q[descend_by_created_at]=true',  // raw query string fragment, may be omitted
   *     maxPerPage: 250,                              // upper bound on per_page
   *   }
   *
   * Throws on network error or non-2xx — caller catches and returns null so the
   * dispatcher falls back to HTML/Playwright. Returns null only if the JSON shape
   * is unrecognised (no `products` array).
   */
  private async _fetchMysimplestorePage(
    apiCfg: any,
    page: number,
    perPageOpt?: number,
  ): Promise<CatalogPage | null> {
    const perPage = Math.min(perPageOpt || 15, apiCfg.maxPerPage || 250);

    // Build the URL by raw concatenation. We avoid URLSearchParams because
    // mysimplestore expects literal `[` and `]` in `q[...]` keys, which
    // URLSearchParams percent-encodes (`%5B`/`%5D`) — the API still works with
    // either form, but we keep the raw form to match what the SPA itself sends
    // (verified via DevTools network capture 2026-04-07).
    const parts: string[] = [];
    if (apiCfg.appParam) parts.push(String(apiCfg.appParam));
    parts.push(`page=${encodeURIComponent(String(page))}`);
    parts.push(`per_page=${encodeURIComponent(String(perPage))}`);
    if (apiCfg.sortParam) parts.push(String(apiCfg.sortParam));
    const url = `${apiCfg.baseUrl}${apiCfg.productsEndpoint}?${parts.join('&')}`;

    const response = await axios.get(url, {
      timeout: 15000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });

    const data = response.data;
    if (!data || !Array.isArray(data.products)) {
      console.log(`[GenericRetail] mysimplestore: unexpected JSON shape (no products array) for ${url}`);
      return null;
    }

    const baseDomain: string = data.base_domain_url || '';
    const totalCount = typeof data.total_count === 'number' ? data.total_count : undefined;
    const totalPages = typeof data.pages === 'number'
      ? data.pages
      : (totalCount !== undefined ? Math.ceil(totalCount / perPage) : undefined);

    const products: CatalogProduct[] = [];
    for (const p of data.products) {
      if (!p || !p.relative_url || !p.name) continue;
      const fullUrl: string = String(p.relative_url).startsWith('http')
        ? String(p.relative_url)
        : `${baseDomain}${p.relative_url}`;

      const thumbRaw: string | undefined = p.default_asset_url
        || (Array.isArray(p.image_list) && p.image_list[0]?.url)
        || undefined;
      const thumbnail = thumbRaw
        ? (thumbRaw.startsWith('//') ? `https:${thumbRaw}` : thumbRaw)
        : undefined;

      const priceNumeric = typeof p.price?.numeric === 'number' ? p.price.numeric : undefined;
      const salePriceNumeric = typeof p.sale_price?.numeric === 'number' ? p.sale_price.numeric : null;
      const onSale = p['on_sale?'] === true && salePriceNumeric != null && salePriceNumeric > 0;

      products.push({
        url: fullUrl,
        sourceId: p.id != null ? String(p.id) : undefined,
        title: String(p.name).trim().slice(0, 160),
        price: onSale ? salePriceNumeric! : priceNumeric,
        regularPrice: onSale ? priceNumeric : undefined,
        stockStatus: p.in_stock === true ? 'in_stock' : (p.in_stock === false ? 'out_of_stock' : 'unknown'),
        thumbnail,
        postDate: p.created_at || undefined,
      });
    }

    return {
      products,
      totalPages,
    };
  }

  /**
   * Fetch a catalog page from an Ecwid storefront API (undocumented, no auth).
   *
   * Used by Ecwid-on-WordPress sites. Detection: `<script src="https://app.ecwid.com/script.js?<storeId>">`.
   * Discovery harness: `backend/scripts/tb-real-ui4.ts` (Playwright drives the live sort dropdown
   * + pagination and captures the real POST body byte-for-byte). See playbook Mistake 31.
   *
   * Reads ALL site-specific configuration from `apiCfg` (from `siteProfile.apiAlternative`).
   * The adapter has ZERO hardcoded Ecwid domains, store IDs, or field names — every Ecwid site
   * declares its own config in the profile. Expected shape:
   *
   *   {
   *     type: 'ecwid-storefront-api',
   *     endpoint: 'https://<region>-storefront-api.ecwid.com/storefront/api/v1/<storeId>/catalog/search',
   *     httpMethod: 'POST',
   *     headers: { 'Content-Type': 'application/json', 'Origin': '<merchant>', 'Referer': '<merchant>/' },
   *     bodyTemplate: {
   *       lang: 'en',
   *       pagination: { offset: 0, limit: 100 },
   *       sortBy: 'addedTimeDesc',
   *       urlParams: { baseUrl, canonicalBaseUrl, isCleanUrls, isCanonicalUrlsEnabled, isSlugsWithoutIds }
   *     },
   *     responseSchema: {
   *       productsPath: 'products',
   *       totalPath: 'totalProductsCount',
   *       productUrlPath: 'seo.canonicalUrl',
   *       productNamePath: 'name'
   *     },
   *     sortOptions: ['addedTimeDesc', 'priceAsc', ...],
   *     defaultSortBy: 'addedTimeDesc'
   *   }
   *
   * Watermark crawler passes `{ sortBy: 'newest' | 'oldest', perPage }` — we map
   * `'newest'` → `apiCfg.defaultSortBy` (usually `addedTimeDesc`) and `'oldest'` → an
   * ascending sort from `sortOptions` if one exists.
   *
   * IMPORTANT: Ecwid product responses have NO `created_at` / `updated_at` fields, so
   * `postDate` is always undefined. Watermark detection therefore relies on URL matching,
   * not date comparison. This is why `navigate-from-watermark` is the correct crawler
   * method (walk sorted by `addedTimeDesc` until we hit a known URL), NOT `api-date-since-watermark`.
   *
   * Throws on network error or non-2xx — caller catches and returns null so the
   * dispatcher falls back to HTML/Playwright.
   */
  private async _fetchEcwidStorefrontPage(
    apiCfg: any,
    page: number,
    options?: { sortBy?: 'newest' | 'oldest'; perPage?: number },
  ): Promise<CatalogPage | null> {
    const templateLimit = apiCfg.bodyTemplate?.pagination?.limit;
    const perPage = Math.min(options?.perPage || templateLimit || 100, 200);
    const offset = (page - 1) * perPage;

    // Resolve sortBy: adapter gets 'newest'/'oldest'; Ecwid wants camelCase values like 'addedTimeDesc'.
    let sortBy: string = apiCfg.defaultSortBy || apiCfg.bodyTemplate?.sortBy || 'addedTimeDesc';
    if (options?.sortBy === 'oldest') {
      const asc = (apiCfg.sortOptions || []).find((s: string) => /asc$/i.test(s) && /added|created|time/i.test(s));
      if (asc) sortBy = asc;
    }

    // Build the POST body from template, overriding pagination + sortBy.
    const body = {
      ...(apiCfg.bodyTemplate || {}),
      pagination: { offset, limit: perPage },
      sortBy,
    };

    const response = await axios.post(apiCfg.endpoint, body, {
      timeout: 20000,
      headers: {
        'Accept': 'application/json, text/plain, */*',
        ...(apiCfg.headers || {}),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      validateStatus: (s) => s === 200,
    });

    const data = response.data;
    const schema = apiCfg.responseSchema || {};
    const productsPath: string = schema.productsPath || 'products';
    const totalPath: string = schema.totalPath || 'totalProductsCount';
    const productUrlPath: string = schema.productUrlPath || 'seo.canonicalUrl';
    const productNamePath: string = schema.productNamePath || 'name';

    const getPath = (obj: any, path: string): any =>
      path.split('.').reduce((acc: any, key: string) => (acc == null ? undefined : acc[key]), obj);

    const rawProducts = getPath(data, productsPath);
    if (!data || !Array.isArray(rawProducts)) {
      console.log(`[GenericRetail] ecwid-storefront-api: unexpected JSON shape (no ${productsPath} array) for ${apiCfg.endpoint}`);
      return null;
    }

    const totalProducts = getPath(data, totalPath);
    const totalPages = typeof totalProducts === 'number' ? Math.ceil(totalProducts / perPage) : undefined;

    const products: CatalogProduct[] = [];
    for (const p of rawProducts) {
      if (!p) continue;
      const url = getPath(p, productUrlPath);
      const name = getPath(p, productNamePath);
      if (!url || !name) continue;

      // Verified via live probe on 2026-04-09 (playbook Mistake 31):
      //   - Product ID lives at `identifier.productId` (NOT `p.id`).
      //   - Price lives at `defaultOptionsOverrides.pricesOverrides.basePrice`.
      //   - No `media.images` / thumbnail field exists in /catalog/search responses.
      //   - No `created_at` / `updated_at` / date fields exist (see class doc above).
      const productId = getPath(p, 'identifier.productId');
      const priceNumeric = getPath(p, 'defaultOptionsOverrides.pricesOverrides.basePrice');

      products.push({
        url: String(url),
        sourceId: productId != null ? String(productId) : undefined,
        title: String(name).trim().slice(0, 160),
        price: typeof priceNumeric === 'number' ? priceNumeric : undefined,
        stockStatus: 'unknown', // /catalog/search preview shape does not expose stock
        // thumbnail: undefined — Ecwid /catalog/search does not return image URLs
        // postDate: undefined — Ecwid product responses have no date fields
      });
    }

    return {
      products,
      totalPages,
      nextPageUrl: totalPages !== undefined && page < totalPages ? `ecwid://page/${page + 1}` : undefined,
    };
  }

  // ── BigCommerce Stencil GraphQL Storefront API ──────────────────────────
  // BC Stencil storefronts expose a GraphQL endpoint at POST /graphql.
  // Auth: Bearer JWT scraped from storefront HTML. The JWT is typically found in:
  //   - `<input class='hidden_token' value='eyJ...'>`  (filter/widget plugins)
  //   - `data-hidden_token="eyJ..."` (script data attributes)
  //   - `'Authorization': 'Bearer eyJ...'` (inline JS)
  //   - or via a custom regex in the profile
  // The JWT's `cors` claim tells us the correct origin for the /graphql endpoint,
  // which may differ from the storefront origin (e.g. store.prophetriver.com vs
  // www.prophetriver.com).
  //
  // BC Storefront GraphQL schema (verified 2026-04-10 on prophetriver.com):
  //   - `products(first, after)` — returns ALL products by entity ID (ascending),
  //     NO `sortBy` argument. Used for full catalog walk (T2-4).
  //   - `newestProducts(first, after)` — returns products in descending createdAt
  //     order with cursor pagination. Used for T1 watermark crawl.
  //   - Both return `createdAt { utc }` — unlocks `api-date-since-watermark`.
  //
  // Unlike Ecwid, BC GraphQL uses cursor-based pagination, not offset.
  // We cache `endCursor` per origin+queryType combo. If cursor is missing
  // for page >1, return null (fallback to HTML).

  private _bcGraphqlTokenCache = new Map<string, { token: string; graphqlOrigin: string; expiresAt: number }>();
  private _bcCursorCache: Map<string, string> | undefined;

  /**
   * Fetch a catalog page from a BigCommerce Stencil GraphQL Storefront API.
   *
   * Reads ALL site-specific configuration from `apiCfg` (from `siteProfile.apiAlternative`).
   * The adapter has ZERO hardcoded BC domains, tokens, or queries — every site declares
   * its own config in the profile. Expected shape:
   *
   *   {
   *     type: 'bigcommerce-graphql',
   *     graphqlUrl: '/graphql',                    // relative to graphqlOrigin (auto-detected from JWT cors)
   *     tokenScrapeUrl: '/',                       // page to scrape JWT from
   *     tokenRegex: null,                          // null = use default JWT regex (eyJ...)
   *     tokenCacheTtlMs: 3600000,                  // 1 hour cache
   *     productsQuery: null,                       // null = use default query
   *     currencyCode: 'CAD',                       // currency for prices
   *   }
   *
   * Throws on network error or non-200 — caller catches and returns null so the
   * dispatcher falls back to HTML/Playwright.
   */
  private async _fetchBigCommerceGraphQLPage(
    apiCfg: any,
    origin: string,
    page: number,
    options?: { sortBy?: 'newest' | 'oldest'; perPage?: number; dateAfter?: string },
  ): Promise<CatalogPage | null> {
    const perPage = Math.min(options?.perPage || 50, 50); // BC GraphQL max is 50 for newestProducts

    // 1. Resolve token + graphqlOrigin (scrape from HTML or use cache)
    const resolved = await this._resolveBcGraphqlToken(apiCfg, origin);
    if (!resolved) {
      console.log(`[GenericRetail] bigcommerce-graphql: could not resolve token for ${origin}`);
      return null;
    }
    const { token, graphqlOrigin } = resolved;

    // 2. Choose query type based on sort
    // - 'newest' → newestProducts (descending createdAt, for T1 watermark)
    // - anything else → products (ascending entityId, for T2-4 full catalog)
    const useNewest = options?.sortBy === 'newest';
    const queryType = useNewest ? 'newestProducts' : 'products';
    const currency = apiCfg.currencyCode || 'CAD';

    const query = apiCfg.productsQuery || `
      query BcCatalogPage($pageSize: Int!, $after: String) {
        site {
          ${queryType}(first: $pageSize, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            edges {
              node {
                entityId
                name
                path
                createdAt { utc }
                prices(currencyCode: ${currency}) {
                  price { value currencyCode }
                  salePrice { value }
                }
                defaultImage { url(width: 300) }
                availabilityV2 { status }
                sku
              }
            }
          }
        }
      }
    `;

    // For cursor-based pagination, we need the endCursor from previous page.
    // Cache it keyed by origin + queryType. If cursor is missing for page >1,
    // return null so the dispatcher falls back to HTML.
    const cursorKey = `${origin}:cursor:${queryType}`;
    let afterCursor: string | null = null;
    if (page > 1) {
      afterCursor = this._bcCursorCache?.get(cursorKey) || null;
      if (!afterCursor) {
        console.log(`[GenericRetail] bigcommerce-graphql: no cursor for page ${page} (${queryType}) on ${origin}, falling back`);
        return null;
      }
    }

    // 3. POST to GraphQL (use graphqlOrigin from JWT cors, not storefront origin)
    const graphqlUrl = `${graphqlOrigin}${apiCfg.graphqlUrl || '/graphql'}`;
    const response = await axios.post(graphqlUrl, {
      query,
      variables: {
        pageSize: perPage,
        after: afterCursor,
      },
    }, {
      timeout: 20000,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'Origin': graphqlOrigin,
      },
      validateStatus: (s: number) => s === 200,
    });

    const data = response.data?.data?.site?.[queryType];
    if (!data || !Array.isArray(data.edges)) {
      console.log(`[GenericRetail] bigcommerce-graphql: unexpected response shape for ${origin} (${queryType})`);
      return null;
    }

    // Cache cursor for next page
    if (!this._bcCursorCache) this._bcCursorCache = new Map();
    if (data.pageInfo?.endCursor) {
      this._bcCursorCache.set(cursorKey, data.pageInfo.endCursor);
    }

    // 4. Map edges to CatalogProduct[]
    const products: CatalogProduct[] = [];
    for (const edge of data.edges) {
      const node = edge.node;
      if (!node || !node.path || !node.name) continue;

      const fullUrl = node.path.startsWith('http') ? node.path : `${origin}${node.path}`;
      const price = node.prices?.salePrice?.value ?? node.prices?.price?.value;

      products.push({
        url: fullUrl,
        sourceId: node.entityId != null ? String(node.entityId) : undefined,
        title: String(node.name).trim().slice(0, 160),
        price: typeof price === 'number' ? price : undefined,
        stockStatus: node.availabilityV2?.status === 'Available' ? 'in_stock'
          : node.availabilityV2?.status === 'Unavailable' ? 'out_of_stock' : 'unknown',
        thumbnail: node.defaultImage?.url || undefined,
        postDate: node.createdAt?.utc || undefined,
        tags: node.sku || undefined,
      });
    }

    // BC GraphQL doesn't give total count in the products/newestProducts query.
    // Use hasNextPage to signal more pages.
    const hasNext = data.pageInfo?.hasNextPage === true;

    return {
      products,
      totalPages: hasNext ? page + 1 : page, // approximate — tells crawler there's at least one more page
      nextPageUrl: hasNext ? `bcgql://page/${page + 1}` : undefined,
    };
  }

  /**
   * Scrape and cache the BC Stencil GraphQL Storefront API JWT from a storefront page.
   *
   * Token locations in BC Stencil HTML (verified 2026-04-10):
   *   1. `<input class='hidden_token' value='eyJ...'>`  (arizonreports filter plugin)
   *   2. `data-hidden_token="eyJ..."` (script data attributes)
   *   3. `'Authorization': 'Bearer eyJ...'` (inline JS)
   *   4. Custom regex from profile (`apiCfg.tokenRegex`)
   *
   * The JWT's `cors` claim contains the origin to use for /graphql (may differ from
   * the storefront domain). We decode the JWT payload to extract it.
   *
   * Cached for `tokenCacheTtlMs` (default 1h), re-scraped on expiry.
   */
  private async _resolveBcGraphqlToken(
    apiCfg: any,
    origin: string,
  ): Promise<{ token: string; graphqlOrigin: string } | null> {
    // Check cache first
    const cached = this._bcGraphqlTokenCache.get(origin);
    if (cached && Date.now() < cached.expiresAt) {
      return { token: cached.token, graphqlOrigin: cached.graphqlOrigin };
    }

    // Scrape token from a storefront page
    const scrapeUrl = `${origin}${apiCfg.tokenScrapeUrl || '/'}`;
    try {
      const resp = await axios.get(scrapeUrl, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'text/html',
        },
      });

      const html = typeof resp.data === 'string' ? resp.data : '';
      let token: string | null = null;

      // Try profile regex first
      if (apiCfg.tokenRegex) {
        const regex = new RegExp(apiCfg.tokenRegex);
        const match = html.match(regex);
        if (match?.[1]) token = match[1];
      }

      // Default: find any JWT (eyJ...) in the HTML — BC Storefront tokens are always JWTs
      if (!token) {
        const jwtMatch = html.match(/eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/);
        if (jwtMatch) token = jwtMatch[0];
      }

      if (!token) {
        console.log(`[GenericRetail] bigcommerce-graphql: JWT not found in ${scrapeUrl}`);
        return null;
      }

      // Decode JWT payload to get CORS origin for /graphql endpoint
      let graphqlOrigin = origin;
      try {
        const payloadB64 = token.split('.')[1];
        const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
        if (Array.isArray(payload.cors) && payload.cors.length > 0) {
          graphqlOrigin = payload.cors[0];
        }
      } catch {
        // If JWT decode fails, fall back to storefront origin
      }

      // Allow profile override for graphqlOrigin
      if (apiCfg.graphqlOrigin) {
        graphqlOrigin = apiCfg.graphqlOrigin;
      }

      const ttl = apiCfg.tokenCacheTtlMs || 3600000; // 1 hour default
      this._bcGraphqlTokenCache.set(origin, { token, graphqlOrigin, expiresAt: Date.now() + ttl });
      console.log(`[GenericRetail] bigcommerce-graphql: JWT scraped and cached for ${origin} → ${graphqlOrigin} (${token.slice(0, 12)}...)`);
      return { token, graphqlOrigin };
    } catch (err) {
      console.log(`[GenericRetail] bigcommerce-graphql: token scrape failed for ${scrapeUrl}: ${err instanceof Error ? err.message : err}`);
      return null;
    }
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
      '.product-element',            // LightSpeed Developer/custom theme (gobles.ca)
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
      '[data-aid="PRODUCT_LIST_RENDERED"] [data-ux="GridCell"]', // GoDaddy OLS (liangjian.ca)
      'a[href*="/marketplace/"]',    // TownPost classifieds (Next.js SPA, anchor-wrapped cards)
      '[class*="oe_product"]',       // Odoo Website Sale (outfitters.goldnloan.com) — explicit; .card fallback already catches most
      'form[class*="oe_product"]',   // Odoo form-wrapped product cards
    ];

    // Sidebar blocks that Magento 2 (and similar platforms) render even on
    // empty/past-last-page category responses.  Products matched inside these
    // containers are "phantom" items — Related, Recently Viewed, Upsell, etc.
    // Skipping them prevents the adapter from returning 10-20 ghost products
    // when the main product grid is actually empty (e.g. requesting ?p=100 on
    // a 71-page category).
    const SIDEBAR_BLACKLIST = [
      '.block-related',
      '.block-viewed-products',
      '.block-upsell',
      '.block.crosssell',
      '.related-items',
      '.recently-viewed',
      '.crosssell',
      '.upsell',
      '[class*="related-products"]',
      '[class*="recently-viewed"]',
      '[class*="you-may-also-like"]',
      '.sidebar',                      // Generic sidebar wrapper
      'aside',                         // Semantic sidebar element
    ];
    const sidebarSelector = SIDEBAR_BLACKLIST.join(', ');

    for (const selector of SELECTORS) {
      $(selector).each((_, el) => {
        const element = $(el);

        // Skip products inside sidebar/related/upsell blocks (Magento 2 phantom products)
        if (element.closest(sidebarSelector).length > 0) {
          return; // ancestor is a sidebar block — skip
        }

        const title = this.extractTitle(element, element.text());
        if (!title || title.length < 3) return;
        if (/^\$?\d[\d,.]*$/.test(title)) return;
        // Reject obvious nav/category labels (short, generic, no specifics)
        if (this.isNavTitle(title)) return;

        const url = this.extractLink(element, baseUrl);
        if (!url || seen.has(url)) return;
        // Magento 1.x product detail URLs follow `/catalog/product/view/id/NN/s/slug/category/NN/`.
        // The trailing `/category/NN/` breadcrumb segment trips the generic `isNavUrl`
        // category-page filter even though this is unambiguously a product detail page.
        // Whitelist the Magento 1 product view pattern so these survive the nav check.
        const isMagento1ProductView = /\/catalog\/product\/view\/id\/\d+\//i.test(url);
        if (!isMagento1ProductView && this.isNavUrl(url)) return;
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
        // Fallback: extract numeric product ID from URL
        // Pattern 1: slug-embedded ID (e.g. bullseyenorth /shop/slug-28443)
        // Pattern 2: trailing path segment ID (e.g. TownPost /marketplace/.../1139775)
        if (!sourceId && url) {
          const urlIdMatch = url.match(/-(\d{4,})(?:[?#]|$)/) || url.match(/\/(\d{5,})(?:[?#]|$)/);
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

    // Phase 3: Enrich no-price products from page-level JSON-LD and meta tags.
    // BigCommerce (and some other platforms) serve prices in structured data that
    // the card-level CSS extraction misses (JS-rendered or non-standard markup).
    this._enrichPricesFromStructuredData($, products);

    return products;
  }

  /**
   * Enrich catalog products that have no price using page-level structured data.
   * Sources (highest priority first):
   *   1. meta[property="product:price:amount"] — single-product pages
   *   2. JSON-LD Product offers.price / offers.lowPrice
   *   3. meta[property="og:price:amount"]
   *
   * For listing pages with multiple products, builds a URL→price map from JSON-LD
   * ItemList/Product entries. For single-product pages, applies the page-level price
   * to the sole product.
   */
  private _enrichPricesFromStructuredData(
    $: cheerio.CheerioAPI,
    products: CatalogProduct[],
  ): void {
    const noPriceProducts = products.filter(p => !p.price);
    if (noPriceProducts.length === 0) return;

    // Build a URL→{price, regularPrice} map from JSON-LD on the page
    const jsonLdPrices = new Map<string, { price: number; regularPrice?: number }>();
    let singleJsonLdPrice: { price: number; regularPrice?: number } | undefined;

    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const raw = $(el).html();
        if (!raw) return;
        const data = JSON.parse(raw);
        const items = Array.isArray(data) ? data : [data];

        for (const item of items) {
          // Handle ItemList (BigCommerce category pages)
          if (item['@type'] === 'ItemList' && Array.isArray(item.itemListElement)) {
            for (const entry of item.itemListElement) {
              const product = entry.item || entry;
              this._extractJsonLdProductPrice(product, jsonLdPrices);
            }
          }
          // Handle direct Product or @graph containing Products
          this._extractJsonLdProductPrice(item, jsonLdPrices);
          if (Array.isArray(item['@graph'])) {
            for (const node of item['@graph']) {
              this._extractJsonLdProductPrice(node, jsonLdPrices);
            }
          }
        }
      } catch { /* malformed JSON-LD — skip */ }
    });

    // If JSON-LD had exactly one product with a price and no URL match, save it
    if (jsonLdPrices.size === 1) {
      singleJsonLdPrice = [...jsonLdPrices.values()][0];
    }

    // Also extract from product:price:amount and og:price:amount meta tags
    let metaPrice: number | undefined;
    const productPriceMeta = $('meta[property="product:price:amount"]').attr('content');
    if (productPriceMeta) {
      const p = parseFloat(productPriceMeta.replace(/,/g, ''));
      if (!isNaN(p) && p > 0) metaPrice = p;
    }
    if (!metaPrice) {
      const ogPriceMeta = $('meta[property="og:price:amount"]').attr('content');
      if (ogPriceMeta) {
        const p = parseFloat(ogPriceMeta.replace(/,/g, ''));
        if (!isNaN(p) && p > 0) metaPrice = p;
      }
    }

    // Apply prices to products that are missing them
    for (const product of noPriceProducts) {
      // Try URL-matched JSON-LD price first
      const normalized = product.url.replace(/\/$/, '').toLowerCase();
      for (const [jsonUrl, priceData] of jsonLdPrices) {
        if (!jsonUrl) continue; // Skip empty-key fallback entries for now
        try {
          const normalizedJson = jsonUrl.replace(/\/$/, '').toLowerCase();
          if (normalizedJson === normalized) {
            product.price = priceData.price;
            if (priceData.regularPrice && priceData.regularPrice > priceData.price) {
              product.regularPrice = priceData.regularPrice;
            }
            break;
          }
          // Also match by pathname (JSON-LD may have full URL, product may have relative)
          const jsonPath = new URL(jsonUrl).pathname.replace(/\/$/, '').toLowerCase();
          if (normalized.endsWith(jsonPath)) {
            product.price = priceData.price;
            if (priceData.regularPrice && priceData.regularPrice > priceData.price) {
              product.regularPrice = priceData.regularPrice;
            }
            break;
          }
        } catch { /* invalid URL — skip */ }
      }
      if (product.price) continue;

      // Single JSON-LD product on the page — apply to single no-price product
      if (singleJsonLdPrice && noPriceProducts.length === 1) {
        product.price = singleJsonLdPrice.price;
        if (singleJsonLdPrice.regularPrice && singleJsonLdPrice.regularPrice > singleJsonLdPrice.price) {
          product.regularPrice = singleJsonLdPrice.regularPrice;
        }
        continue;
      }
      // Also try the empty-key fallback (JSON-LD Product with no URL)
      const fallback = jsonLdPrices.get('');
      if (fallback && noPriceProducts.length === 1) {
        product.price = fallback.price;
        if (fallback.regularPrice && fallback.regularPrice > fallback.price) {
          product.regularPrice = fallback.regularPrice;
        }
        continue;
      }

      // Meta tag price — only apply to single-product pages
      if (metaPrice && products.length === 1) {
        product.price = metaPrice;
      }
    }
  }

  /** Extract price from a JSON-LD Product node and add to the URL→price map */
  private _extractJsonLdProductPrice(
    node: any,
    priceMap: Map<string, { price: number; regularPrice?: number }>,
  ): void {
    if (!node || typeof node !== 'object') return;
    if (node['@type'] !== 'Product' && node['@type'] !== 'IndividualProduct') return;

    const url = node.url;
    const offers = node.offers;
    if (!offers) return;

    const offerList = Array.isArray(offers) ? offers : [offers];
    let price: number | undefined;
    let regularPrice: number | undefined;

    for (const offer of offerList) {
      if (!price && offer.price !== undefined) {
        const p = typeof offer.price === 'number'
          ? offer.price
          : parseFloat(String(offer.price).replace(/,/g, ''));
        if (!isNaN(p) && p > 0) price = p;
      }
      if (!price && offer.lowPrice !== undefined) {
        const p = typeof offer.lowPrice === 'number'
          ? offer.lowPrice
          : parseFloat(String(offer.lowPrice).replace(/,/g, ''));
        if (!isNaN(p) && p > 0) price = p;
      }
      if (offer.highPrice !== undefined) {
        const rp = typeof offer.highPrice === 'number'
          ? offer.highPrice
          : parseFloat(String(offer.highPrice).replace(/,/g, ''));
        if (!isNaN(rp) && rp > 0) regularPrice = rp;
      }
    }

    if (price && url) {
      priceMap.set(url, { price, regularPrice });
    } else if (price) {
      // No URL but has price — use empty string key as fallback
      priceMap.set('', { price, regularPrice });
    }
  }

  getNextPageUrl($: cheerio.CheerioAPI, currentUrl: string): string | null {
    // Try common pagination patterns across platforms
    const nextLink = $(
      'a.next, a[rel="next"], ' +                                    // Standard
      '[class*="pagination"] a:contains("Next"), ' +                  // Text-based
      '[class*="pagination"] a:contains("›"), ' +                     // Arrow-based (single chevron)
      '[class*="pagination"] a:contains("»"), ' +                     // Arrow-based (double chevron — Epicor/Activant iNet)
      '.pagination-item--next a, ' +                                  // BigCommerce
      '.pages-item-next a, ' +                                        // Magento
      'a.page-numbers.next, ' +                                         // WordPress
      '[data-aid="PAGINATION_ARROW_FORWARD"] a, ' +                     // GoDaddy OLS (liangjian.ca)
      'a[data-aid="PAGINATION_ARROW_FORWARD"], ' +                      // GoDaddy OLS (alternate)
      '.pager .next-page a, ' +                                        // NopCommerce (reliablegun.com)
      '.pager a:contains("Next"), ' +                                  // NopCommerce text-based fallback
      '.next-page a, ' +                                               // Generic .next-page wrapper
      'a[aria-label="Next"], ' +                                       // Aria-labeled (Odoo, accessible templates)
      'nav[class*="paginate"] a[aria-label*="Next"]'                   // Odoo Website Sale paginate nav
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
