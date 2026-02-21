import type * as cheerio from 'cheerio';
import type { ScrapedMatch, ExtractionOptions } from '../types';
import { AbstractAdapter } from './base';

/**
 * Gunpost.ca classifieds adapter (Drupal-based).
 * Selectors: node--type-classified, gunpost-teaser, article
 */
export class GunpostAdapter extends AbstractAdapter {
  name = 'Gunpost';
  siteType = 'classifieds' as const;

  getSearchUrl(origin: string, keyword: string): string {
    return `${origin}/ads?key=${encodeURIComponent(keyword)}`;
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
      '[class*="node--type-classified"]',
      '[class*="gunpost-teaser"]',
      '[class*="node--type-"][class*="teaser"]',
      '[class*="classified-ad"]',
      '[class*="classified-item"]',
      '[class*="listing-card"]',
      '[class*="listing-item"]',
      '[class*="ad-card"]',
      '[class*="post-card"]',
      '[class*="search-result"]',
      'article[class*="classified"]',
      'article[class*="listing"]',
      'article.post',
      'article',
    ];

    for (const selector of SELECTORS) {
      $(selector).each((_, el) => {
        const element = $(el);
        const text = element.text();
        if (!text.toLowerCase().includes(keywordLower)) return;

        let titleEl = element.find('h1, h2, h3, h4').first();
        if (!titleEl.length) {
          titleEl = element.find('[class*="title"], [class*="name"], [class*="heading"], [class*="field-name-title"]').first();
        }
        const rawTitle = (titleEl.length ? titleEl.text() : text).trim().replace(/\s+/g, ' ').slice(0, 160);
        if (!rawTitle || rawTitle.length < 3) return;
        if (/^\$?\d[\d,.]*$/.test(rawTitle)) return;

        const titleKey = rawTitle.toLowerCase().slice(0, 60);
        if (seen.has(titleKey)) return;

        const productUrl = this.extractLink(element, baseUrl);

        const priceEl = element.find('[class*="price"], [class*="cost"], [class*="amount"], [class*="field-price"]').first();
        let price = this.extractPrice(priceEl.text() || '');
        if (!price) price = this.extractPriceFromTitle(rawTitle);

        if (options.maxPrice && price && price > options.maxPrice) return;

        const thumbnail = this.extractThumbnail($, element, baseUrl);
        const postDate = this.extractPostDate(element);

        seen.add(titleKey);
        matches.push({ title: rawTitle, price, url: productUrl, thumbnail, postDate });
      });
    }

    return matches;
  }
}
