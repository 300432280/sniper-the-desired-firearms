import type * as cheerio from 'cheerio';
import type { ScrapedMatch, ExtractionOptions } from '../types';
import { AbstractAdapter } from './base';

/**
 * XenForo forum adapter — covers CGN, Gun Owners of Canada.
 * Selectors: .structItem, .structItem-title a
 */
export class XenForoAdapter extends AbstractAdapter {
  name = 'XenForo';
  siteType = 'forum' as const;

  getSearchUrl(origin: string, keyword: string): string {
    return `${origin}/search/?q=${encodeURIComponent(keyword)}&t=post`;
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

    const xfThreads = $('.structItem, [class*="structItem--thread"]');
    xfThreads.each((_, el) => {
      const element = $(el);
      const text = element.text();
      if (!text.toLowerCase().includes(keywordLower)) return;

      let titleEl = element.find('.structItem-title a').first();
      if (!titleEl.length) titleEl = element.find('[class*="title"] a').first();

      const rawTitle = (titleEl.length ? titleEl.text() : text).trim().replace(/\s+/g, ' ').slice(0, 160);
      if (!rawTitle || rawTitle.length < 3) return;

      const titleKey = rawTitle.toLowerCase().slice(0, 60);
      if (seen.has(titleKey)) return;

      const href = titleEl.attr('href') || '';
      const threadUrl = this.resolveUrl(href, baseUrl);

      const price = this.extractPriceFromTitle(rawTitle);
      if (options.maxPrice && price && price > options.maxPrice) return;

      const postDate = this.extractPostDate(element);
      const thumbnail = this.extractThumbnail($, element, baseUrl);

      seen.add(titleKey);
      matches.push({ title: rawTitle, price, url: threadUrl, postDate, thumbnail });
    });

    return matches;
  }
}
