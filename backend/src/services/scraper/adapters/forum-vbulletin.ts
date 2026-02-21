import type * as cheerio from 'cheerio';
import type { ScrapedMatch, ExtractionOptions } from '../types';
import { AbstractAdapter } from './base';

/**
 * vBulletin forum adapter.
 * Selectors: .threadbit, li[id^="thread_"], .threadtitle a
 */
export class VBulletinAdapter extends AbstractAdapter {
  name = 'vBulletin';
  siteType = 'forum' as const;

  getSearchUrl(origin: string, keyword: string): string {
    return `${origin}/forum/search.php?do=process&query=${encodeURIComponent(keyword)}&titleonly=1`;
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

    const vbThreads = $('[class*="threadbit"], li[id^="thread_"], [class*="threadtitle"]');
    vbThreads.each((_, el) => {
      const element = $(el);
      const text = element.text();
      if (!text.toLowerCase().includes(keywordLower)) return;

      let titleEl = element.find('.threadtitle a, a[id^="thread_title_"]').first();
      if (!titleEl.length) titleEl = element.find('a[href*="showthread"]').first();
      if (!titleEl.length) titleEl = element.find('h3 a, h4 a').first();

      const rawTitle = (titleEl.length ? titleEl.text() : text).trim().replace(/\s+/g, ' ').slice(0, 160);
      if (!rawTitle || rawTitle.length < 3) return;

      const titleKey = rawTitle.toLowerCase().slice(0, 60);
      if (seen.has(titleKey)) return;

      const href = titleEl.attr('href') || '';
      const threadUrl = this.resolveUrl(href, baseUrl);

      const price = this.extractPriceFromTitle(rawTitle);
      if (options.maxPrice && price && price > options.maxPrice) return;

      const postDate = this.extractPostDate(element);

      seen.add(titleKey);
      matches.push({ title: rawTitle, price, url: threadUrl, postDate });
    });

    return matches;
  }
}
