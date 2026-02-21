import type * as cheerio from 'cheerio';
import type { ScrapedMatch, SiteType, ExtractionOptions, SiteAdapter, ScrapeOptions } from '../types';
import { extractPrice, extractPriceFromTitle } from '../utils/price';
import { isInStock } from '../utils/stock';
import { resolveUrl } from '../utils/url';

/**
 * Base class providing shared helpers for all adapters.
 * Subclasses must implement: name, siteType, getSearchUrl, extractMatches.
 */
export abstract class AbstractAdapter implements SiteAdapter {
  abstract name: string;
  abstract siteType: SiteType;
  abstract getSearchUrl(origin: string, keyword: string): string;
  abstract extractMatches(
    $: cheerio.CheerioAPI,
    keyword: string,
    baseUrl: string,
    options: ExtractionOptions
  ): ScrapedMatch[];

  // Optional overrides
  searchViaApi?(origin: string, keyword: string, options: ScrapeOptions): Promise<ScrapedMatch[]>;
  getNextPageUrl?($: cheerio.CheerioAPI, currentUrl: string): string | null;

  // ── Shared extraction helpers ──────────────────────────────────────────

  /** Extract thumbnail URL from an element's img children */
  protected extractThumbnail($: cheerio.CheerioAPI, element: cheerio.Cheerio<any>, baseUrl: string): string | undefined {
    const img = element.find('img').first();
    if (!img.length) return undefined;

    // Prefer data-src (lazy-loaded real image) over src (may be a placeholder/loading SVG)
    const dataSrc = img.attr('data-src') || img.attr('data-lazy-src') || img.attr('data-original') || '';
    const src = img.attr('src') || '';
    // Use data-src if available, otherwise src — but skip loading/placeholder SVGs
    const isPlaceholder = /loading|placeholder|blank|spacer|spinner|\.svg$/i.test(src);
    const chosen = dataSrc || (isPlaceholder ? '' : src);
    if (!chosen) return undefined;

    try {
      if (chosen.startsWith('http')) return chosen;
      if (chosen.startsWith('//')) return `https:${chosen}`;
      return new URL(chosen, baseUrl).toString();
    } catch {
      return undefined;
    }
  }

  /** Extract a date from an element */
  protected extractPostDate(element: cheerio.Cheerio<any>): string | undefined {
    // Look for time elements first
    const timeEl = element.find('time[datetime]').first();
    if (timeEl.length) {
      return timeEl.attr('datetime') || undefined;
    }

    // Look for date-like text patterns
    const dateEl = element.find('[class*="date"], [class*="time"], [class*="posted"]').first();
    if (dateEl.length) {
      const text = dateEl.text().trim();
      // ISO date patterns or common formats
      const match = text.match(/(\d{4}-\d{2}-\d{2})|(\w{3}\s+\d{1,2},?\s+\d{4})|(\d{1,2}\/\d{1,2}\/\d{2,4})/);
      if (match) return match[0];
    }

    return undefined;
  }

  /** Standard title extraction from an element */
  protected extractTitle(element: cheerio.Cheerio<any>, fallbackText: string): string {
    // Prefer explicit title/name classes (avoids grabbing brand-only h4 on BigCommerce)
    let titleEl = element.find('.card-title, .product-title, .product-name, .product_name').first();
    if (!titleEl.length) {
      titleEl = element.find('[class*="product-title"], [class*="product-name"], [class*="item-title"]').first();
    }
    if (!titleEl.length) {
      titleEl = element.find('[class*="title"], [class*="name"], [class*="heading"]').first();
    }
    // Only fall back to h-tags if nothing more specific found
    if (!titleEl.length) {
      titleEl = element.find('h1, h2, h3, h4').first();
    }
    const raw = (titleEl.length ? titleEl.text() : fallbackText).trim().replace(/\s+/g, ' ').slice(0, 160);
    return raw;
  }

  /** Standard link extraction from an element */
  protected extractLink(element: cheerio.Cheerio<any>, baseUrl: string): string {
    const linkEl = element.is('a')
      ? element
      : (element.closest('a').length ? element.closest('a') : element.find('a[href]').first());
    const href = linkEl.attr('href') || '';
    return resolveUrl(href, baseUrl);
  }

  /** Standard price extraction from an element */
  protected extractPriceFromElement(element: cheerio.Cheerio<any>): number | undefined {
    // Try specific "current price" selectors first (BigCommerce, WooCommerce, Magento)
    const specificSelectors = [
      '.price--withoutTax',        // BigCommerce current price
      '.price--main',              // BigCommerce variant
      '.current-price .price',     // BigCommerce sale price
      '.woocommerce-Price-amount',  // WooCommerce
      '[itemprop="price"]',        // Schema.org
      '.special-price .price',     // Magento sale price
    ];
    for (const sel of specificSelectors) {
      const el = element.find(sel).first();
      if (el.length) {
        const price = extractPrice(el.text());
        if (price) return price;
      }
    }

    // Try all price-like elements, pick the first with an actual value
    const priceEls = element.find(
      '[class*="price"], [class*="cost"], [class*="amount"], [class*="field-price"]'
    );
    let result: number | undefined;
    priceEls.each((_, el) => {
      if (result) return;
      const text = element.find(el).text().trim();
      const price = extractPrice(text);
      if (price) result = price;
    });
    if (result) return result;

    // Last resort: extract from element's full text
    return extractPrice(element.text());
  }

  // Re-export utilities for adapter convenience
  protected extractPrice = extractPrice;
  protected extractPriceFromTitle = extractPriceFromTitle;
  protected isInStock = isInStock;
  protected resolveUrl = resolveUrl;
}
