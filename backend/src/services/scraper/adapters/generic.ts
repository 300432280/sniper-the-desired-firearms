import type * as cheerio from 'cheerio';
import type { ScrapedMatch, ExtractionOptions } from '../types';
import { AbstractAdapter } from './base';

/**
 * Ultimate fallback adapter — tries all common selector patterns.
 * Used when no site-specific adapter matches.
 */
export class GenericAdapter extends AbstractAdapter {
  name = 'Generic';
  siteType = 'generic' as const;

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

    const ALL_SELECTORS = [
      '[class*="product-card"]', '[class*="product-item"]', '[class*="product-tile"]',
      '[data-product-id]', '[data-product]', 'article[class*="product"]', 'li[class*="product"]',
      '[class*="listing"]', '[class*="classified"]', '[class*="post-card"]',
      '[class*="ad-card"]', '[class*="search-result"]',
      '[class*="lot"]', '[class*="auction"]',
      'article.post', 'article',
    ];

    for (const selector of ALL_SELECTORS) {
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
        const price = this.extractPriceFromElement(element) ?? this.extractPriceFromTitle(rawTitle);
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
}
