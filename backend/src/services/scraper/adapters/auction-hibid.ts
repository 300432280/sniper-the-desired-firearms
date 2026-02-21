import type * as cheerio from 'cheerio';
import type { ScrapedMatch, ExtractionOptions } from '../types';
import { AbstractAdapter } from './base';
import { extractBidPrice } from '../utils/price';

/**
 * HiBid auction adapter — HiBid-specific selectors.
 */
export class HiBidAdapter extends AbstractAdapter {
  name = 'HiBid';
  siteType = 'auction' as const;

  getSearchUrl(origin: string, keyword: string): string {
    return `${origin}/search?searchPhrase=${encodeURIComponent(keyword)}`;
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

    const LOT_SELECTORS = [
      '[class*="lotContainer"]',
      '[class*="LotTile"]',
      '[class*="lot-tile"]',
      '[class*="lot-item"]',
      '[class*="lotItem"]',
      '[class*="catalog-item"]',
      '[class*="auction-item"]',
      '[class*="item-card"]',
    ];

    for (const selector of LOT_SELECTORS) {
      $(selector).each((_, el) => {
        const element = $(el);
        const text = element.text();
        if (!text.toLowerCase().includes(keywordLower)) return;

        let titleEl = element.find('[class*="lot-title"], [class*="lotTitle"], [class*="lot-name"]').first();
        if (!titleEl.length) titleEl = element.find('h3, h4, h2').first();
        if (!titleEl.length) titleEl = element.find('[class*="title"], [class*="name"], [class*="description"]').first();

        const rawTitle = (titleEl.length ? titleEl.text() : text).trim().replace(/\s+/g, ' ').slice(0, 160);
        if (!rawTitle || rawTitle.length < 3) return;
        if (/^\$?\d[\d,.]*$/.test(rawTitle)) return;
        if (!rawTitle.toLowerCase().includes(keywordLower)) return;

        const cleanTitle = rawTitle.replace(/^\d+[A-Za-z]?\s*-\s*/, '');
        const titleKey = cleanTitle.toLowerCase().slice(0, 60);
        if (seen.has(titleKey)) return;

        const lotUrl = this.extractLink(element, baseUrl);

        const bidEl = element.find('[class*="current-bid"], [class*="winning-bid"], [class*="bid-amount"], [class*="price"]').first();
        const price = bidEl.length ? extractBidPrice(bidEl.text()) : extractBidPrice(element.text());

        if (options.maxPrice && price && price > options.maxPrice) return;

        const thumbnail = this.extractThumbnail($, element, baseUrl);

        seen.add(titleKey);
        matches.push({ title: cleanTitle || rawTitle, price, url: lotUrl, thumbnail });
      });
    }

    return matches;
  }
}
