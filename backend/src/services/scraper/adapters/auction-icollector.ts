import type * as cheerio from 'cheerio';
import axios from 'axios';
import type { ScrapedMatch, ExtractionOptions, ScrapeOptions } from '../types';
import { AbstractAdapter } from './base';
import { pickUserAgent } from '../http-client';

interface ICollectorItem {
  ItemID: number;
  ItemTitle: string;
  ItemLot: string;
  ItemCurrentBidAmount: number;
  AuctionCurrencyCode: string;
  AuctioneerName: string;
  AuctionCity: string;
  AuctionProvince: string;
  AuctionCountry: string;
  ImageUrl?: string;
}

function icollectorFriendlyUrl(title: string, itemId: number): string {
  const slug = title
    .replace(/[^a-zA-Z0-9\- ]/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+$|(-)+/g, '-');
  return `https://www.icollector.com/${slug}_i${itemId}`;
}

/**
 * iCollector adapter — uses CloudSearch JSON API for comprehensive search.
 */
export class ICollectorAdapter extends AbstractAdapter {
  name = 'iCollector';
  siteType = 'auction' as const;

  getSearchUrl(origin: string, keyword: string): string {
    return `${origin}/search/?q=${encodeURIComponent(keyword)}`;
  }

  async searchViaApi(_origin: string, keyword: string, options: ScrapeOptions): Promise<ScrapedMatch[]> {
    const API_URL = 'https://www.icollector.com/handlers/controls/CloudsearchItemSearch.ashx';
    const maxItems = options.fast ? 50 : 100;

    const response = await axios.get(API_URL, {
      params: {
        command: 'searchitems',
        unitsPerPage: maxItems,
        page: 1,
        isCurrent: 1,
        keywords: keyword,
        sortBy: 'TimeLeft',
        searchFields: 'ItemName',
        exactKeywords: 'false',
        hasImage: 'false',
      },
      headers: {
        'User-Agent': pickUserAgent('icollector.com'),
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: 'https://www.icollector.com/search.aspx',
      },
      timeout: 20000,
    });

    const data = response.data;
    const items: ICollectorItem[] = data.ItemResults || [];
    const totalCount: number = data.ItemCount || 0;
    const keywordLower = keyword.toLowerCase();

    const matches: ScrapedMatch[] = [];
    const seen = new Set<string>();

    for (const item of items) {
      const title = (item.ItemTitle || '').trim();
      if (!title) continue;
      if (!title.toLowerCase().includes(keywordLower)) continue;

      const titleKey = title.toLowerCase().slice(0, 60);
      if (seen.has(titleKey)) continue;
      seen.add(titleKey);

      const url = icollectorFriendlyUrl(title, item.ItemID);
      const price = item.ItemCurrentBidAmount > 0 ? item.ItemCurrentBidAmount : undefined;
      const seller = item.AuctioneerName || undefined;
      const thumbnail = item.ImageUrl || undefined;

      if (options.maxPrice && price && price > options.maxPrice) continue;

      matches.push({
        title: title.slice(0, 160),
        price,
        url,
        seller,
        thumbnail,
      });
    }

    console.log(`[iCollector] API search for "${keyword}": ${matches.length} matches (${totalCount} total from API)`);
    return matches;
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
      '.gridItem',
      '[class*="catLot"]',
      '[class*="lot-item"]',
      '[class*="lotItem"]',
      '[class*="catalog-item"]',
      '[class*="auction-item"]',
    ];

    for (const selector of LOT_SELECTORS) {
      $(selector).each((_, el) => {
        const element = $(el);

        let rawTitle = '';
        let lotUrl = '';

        const icTitleLink = element.find(
          '.gridView_itemListing a[href*="_i"], .gridView_heading a[href*="_i"], a.row_thumbnail[title]'
        ).first();
        if (icTitleLink.length) {
          rawTitle = (icTitleLink.attr('title') || icTitleLink.text()).trim().replace(/\s+/g, ' ').slice(0, 160);
          lotUrl = icTitleLink.attr('href') || '';
          if (lotUrl && !lotUrl.startsWith('http')) lotUrl = this.resolveUrl(lotUrl, baseUrl);
        }

        if (!rawTitle) {
          const text = element.text();
          if (!text.toLowerCase().includes(keywordLower)) return;

          let titleEl = element.find('[class*="lot-title"], [class*="lotTitle"]').first();
          if (!titleEl.length) titleEl = element.find('h3, h4, h2').first();
          if (!titleEl.length) titleEl = element.find('[class*="title"], [class*="name"]').first();
          rawTitle = (titleEl.length ? titleEl.text() : text).trim().replace(/\s+/g, ' ').slice(0, 160);
        }

        if (!rawTitle || rawTitle.length < 3) return;
        if (/^\$?\d[\d,.]*$/.test(rawTitle)) return;
        if (!rawTitle.toLowerCase().includes(keywordLower)) return;

        const cleanTitle = rawTitle.replace(/^\d+[A-Za-z]?\s*-\s*/, '');
        const titleKey = cleanTitle.toLowerCase().slice(0, 60);
        if (seen.has(titleKey)) return;

        if (!lotUrl) lotUrl = this.extractLink(element, baseUrl);

        const bidEl = element.find('[class*="current-bid"], [class*="bid-amount"], [class*="price"]').first();
        const { extractBidPrice } = require('../utils/price');
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
