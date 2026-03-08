import type * as cheerio from 'cheerio';
import type { ScrapedMatch, ExtractionOptions, CatalogProduct } from '../types';
import { AbstractAdapter } from './base';

/**
 * Generic retail adapter — fallback for non-Shopify, non-WooCommerce retailers.
 * Tries common product card patterns, then falls back to link-based extraction.
 */
export class GenericRetailAdapter extends AbstractAdapter {
  name = 'GenericRetail';
  siteType = 'retailer' as const;

  getSearchUrl(origin: string, keyword: string): string {
    return `${origin}/search?q=${encodeURIComponent(keyword)}`;
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
      '.productborder',              // LightSpeed (gagnonsports, etc.)
      '[class*="product-thumb"]',    // OpenCart (including product-thumb_ variants)
      '[class*="product-layout"]',   // OpenCart grid/list (including product-layout_ variants)
      'div.product',                 // Generic product div
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

        const price = this.extractPriceFromElement(element);
        const inStock = this.isInStock(element);
        const thumbnail = this.extractThumbnail($, element, baseUrl);

        if (options.inStockOnly && !inStock) return;
        if (options.maxPrice && price && price > options.maxPrice) return;

        seen.add(titleKey);
        matches.push({ title: rawTitle, price, url: productUrl, inStock, thumbnail });
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
        let thumbnail: string | undefined;

        if (parent && parent.length) {
          price = this.extractPriceFromElement(parent);
          thumbnail = this.extractThumbnail($, parent, baseUrl);
        }

        if (options.maxPrice && price && price > options.maxPrice) return;

        seen.add(titleKey);
        matches.push({ title: text.slice(0, 160), price, url: fullUrl, inStock: true, thumbnail });
      });
    }

    return matches;
  }

  // ── Catalog Crawl Methods (Phase 3) ───────────────────────────────────────

  /**
   * Site-specific product listing URLs for each generic-retail site.
   * Shared by getNewArrivalsUrls() (Tier 1 watermark) and getCatalogUrls() (Tiers 2-4 catalog).
   * Each block is tagged with the platform/CMS for the site.
   */
  private _getSiteSpecificUrls(origin: string): string[] {
    const urls: string[] = [];

    if (origin.includes('lockharttactical.com')) {
      // HikaShop (Joomla) — products live on /product and /category, NOT homepage
      urls.push(`${origin}/category`, `${origin}/product`);
    }
    if (origin.includes('canadasgunstore.ca')) {
      // Activant/Epicor iNet — products on department pages
      urls.push(
        `${origin}/departments/firearms-%7C30%7CFA.html`,
        `${origin}/departments/rifles-non-restricted-%7C30%7CFA%7CRIFLNR.html`,
        `${origin}/departments/pistols-%7C30%7CFA%7CPISTOL.html`,
        `${origin}/departments/shotguns-%7C30%7CFA%7CSHOTGUN.html`,
        `${origin}/departments/promotions-5.html`,
      );
    }
    if (origin.includes('precisionoptics.net')) {
      // 3dcart/Shift4Shop — category pages use _s/ID.htm pattern
      urls.push(
        `${origin}/Riflescopes_s/64.htm`,
        `${origin}/Firearms_s/325.htm`,
        `${origin}/Ammunition_s/550.htm`,
        `${origin}/Binoculars_s/65.htm`,
        `${origin}/category_s/860.htm`,  // Clearance/Used
      );
    }
    if (origin.includes('gagnonsports.com')) {
      // LightSpeed — .productborder only on leaf category pages
      urls.push(
        `${origin}/firearms/new-firearms/centerfire-rifles/`,
        `${origin}/firearms/new-firearms/rimfire-rifles/`,
        `${origin}/firearms/new-firearms/shotguns/`,
        `${origin}/firearms/new-firearms/restricted-firearms/`,
        `${origin}/firearms/new-firearms/air-guns/`,
        `${origin}/firearms/used-firearms/used-rifles/`,
        `${origin}/firearms/used-firearms/used-shotguns/`,
      );
    }
    if (origin.includes('reliablegun.com')) {
      // nopCommerce — homepage has 9 featured products, category pages have more
      urls.push(
        `${origin}/firearms`,
        `${origin}/firearms/rifles`,
        `${origin}/firearms/shotguns`,
        `${origin}/firearms/handguns`,
        `${origin}/`,
      );
    }
    if (origin.includes('nordicmarksman.com')) {
      // BigCommerce — /categories.php lists products with .card selector
      urls.push(
        `${origin}/categories.php`,
        `${origin}/firearms-and-stocks/`,
        `${origin}/shotguns/`,
      );
    }
    if (origin.includes('rdsc.ca')) {
      // BigCommerce — /categories.php has 1054 products
      urls.push(`${origin}/categories.php`);
    }
    if (origin.includes('alflahertys.com')) {
      // BigCommerce + Klevu JS overlay — products only render on LEAF category pages.
      // Navigation pages (/categories.php, /firearms-and-ammunition/) list subcategory
      // links but do NOT render Klevu product cards.
      urls.push(
        `${origin}/shooting-supplies-firearms-ammunition/firearms/rifles/`,
        `${origin}/shooting-supplies-firearms-and-ammunition/firearms/shotguns/`,
        `${origin}/shooting-supplies-firearms-ammunition/firearms/handguns/`,
        `${origin}/shooting-supplies-firearms-ammunition/ammunition/centerfire-ammunition/`,
        `${origin}/shooting-supplies-firearms-ammunition/ammunition/rimfire-ammunition/`,
        `${origin}/shooting-supplies-firearms-ammunition/ammunition/shotgun-ammunition/`,
        `${origin}/shooting-supplies-firearms-ammunition/optics/riflescopes/`,
        `${origin}/als-bargains/`,
      );
    }
    if (origin.includes('durhamoutdoors.ca')) {
      // Custom PHP store — homepage has .product-item cards
      urls.push(`${origin}/`);
    }
    if (origin.includes('firearmsoutletcanada.com')) {
      // BigCommerce — /categories.php has 104+ products
      urls.push(`${origin}/categories.php`);
    }
    if (origin.includes('store.theshootingcentre.com')) {
      // BigCommerce — /categories.php has 40+ products
      urls.push(`${origin}/categories.php`);
    }
    if (origin.includes('store.prophetriver.com')) {
      // BigCommerce — /categories.php has 20+ products
      urls.push(`${origin}/categories.php`);
    }
    if (origin.includes('irunguns.ca')) {
      // Custom PHP store — subcategory.php/category.php URLs
      urls.push(
        `${origin}/subcategory.php?parent=Firearms`,
        `${origin}/category.php?parent=Magazines`,
        `${origin}/category.php?parent=Import_/_Export`,
      );
    }
    if (origin.includes('northprosports.com')) {
      // OpenCart — firearm-related category paths
      urls.push(
        `${origin}/index.php?route=product/category&path=1055`,  // Sale
        `${origin}/index.php?route=product/category&path=62`,    // Firearms
        `${origin}/index.php?route=product/category&path=64`,    // Used
        `${origin}/`,
      );
    }
    if (origin.includes('londerosports.com')) {
      // Magento — needs specific category URLs
      urls.push(
        `${origin}/firearms.html`,
        `${origin}/ammunition.html`,
        `${origin}/optics.html`,
        `${origin}/`,
      );
    }
    if (origin.includes('outfitters.goldnloan.com')) {
      // LightSpeed — product listing pages
      urls.push(
        `${origin}/firearms/`,
        `${origin}/ammunition/`,
        `${origin}/`,
      );
    }
    if (origin.includes('triggersandbows.com')) {
      // Ecwid on WordPress — homepage has .grid-product cards
      urls.push(`${origin}/`);
    }

    return urls;
  }

  /**
   * URLs for Tier 1 watermark crawl (new product discovery).
   * Site-specific URLs + generic "new arrivals" fallback patterns.
   */
  getNewArrivalsUrls(origin: string): string[] {
    const urls = this._getSiteSpecificUrls(origin);

    // Generic "new arrivals" URL patterns (tried after site-specific URLs)
    urls.push(
      `${origin}/new-arrivals`,           // Common across many platforms
      `${origin}/new`,                     // Shorthand variant
      `${origin}/whats-new`,              // BigCommerce pattern
      `${origin}/categories.php`,         // BigCommerce all-categories page
      `${origin}/search?sort=newest`,     // BigCommerce search sorted newest
      `${origin}/catalogsearch/result/?q=&product_list_order=newest`, // Magento
      `${origin}/shop/?orderby=date`,     // WooCommerce-like
      `${origin}/`,                       // Homepage (last resort)
    );

    return urls;
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

  extractCatalogProducts($: cheerio.CheerioAPI, baseUrl: string): CatalogProduct[] {
    const products: CatalogProduct[] = [];
    const seen = new Set<string>();

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
      '.productborder',              // LightSpeed
      '.product-thumb',              // OpenCart
      '.product-layout',             // OpenCart
      'div.product',
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
        const price = parent?.length ? this.extractPriceFromElement(parent) : undefined;
        const thumbnail = parent?.length ? this.extractThumbnail($, parent, baseUrl) : undefined;

        products.push({
          url: fullUrl,
          title: text.slice(0, 160),
          price,
          stockStatus: 'in_stock',
          thumbnail,
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

  /** Walk up from a link element to find the nearest product-like container */
  private findProductContainer($: cheerio.CheerioAPI, el: cheerio.Cheerio<any>): cheerio.Cheerio<any> | null {
    // First try specific product container selectors
    const container = el.closest(
      '[class*="productborder"], [class*="product-card"], [class*="product-item"], ' +
      '[class*="product-tile"], [class*="item-card"], [class*="grid-item"], ' +
      'li.product, div.product, article, .card, [data-product-id], [data-product]'
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
