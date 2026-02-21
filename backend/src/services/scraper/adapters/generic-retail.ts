import type * as cheerio from 'cheerio';
import type { ScrapedMatch, ExtractionOptions } from '../types';
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
      'div.product',                 // Generic product div
    ];

    for (const selector of SELECTORS) {
      $(selector).each((_, el) => {
        const element = $(el);
        const text = element.text();
        if (!text.toLowerCase().includes(keywordLower)) return;

        const rawTitle = this.extractTitle(element, text);
        if (!rawTitle || rawTitle.length < 3) return;
        if (/^\$?\d[\d,.]*$/.test(rawTitle)) return;

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
        if (text.length < 8 || text.length > 200) return;
        if (/^\$?\d[\d,.]*$/.test(text)) return; // Just a price

        // Skip navigation/breadcrumb/pagination/category links
        if (href === '#' || href === baseUrl) return;
        if (/\/(cart|login|register|account|page\/\d|search)\b/i.test(href)) return;
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

  /** Check if a URL is a category/navigation page rather than a product page */
  private isNavUrl(url: string): boolean {
    return /\/(product-category|category|categories|collections|brands|departments|tags|subcategory|shop\/?\?|manufacturer)\b/i.test(url);
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
