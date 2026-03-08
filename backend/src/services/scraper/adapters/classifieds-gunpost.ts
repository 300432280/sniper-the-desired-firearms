import type * as cheerio from 'cheerio';
import type { ScrapedMatch, ExtractionOptions, CatalogProduct } from '../types';
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
        if (this.isNavTitle(rawTitle)) return;

        const titleKey = rawTitle.toLowerCase().slice(0, 60);
        if (seen.has(titleKey)) return;

        const productUrl = this.extractLink(element, baseUrl);
        if (this.isNavUrl(productUrl)) return;

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

  // ── Catalog Crawl Methods (Phase 3) ───────────────────────────────────────

  getNewArrivalsUrl(origin: string): string {
    return `${origin}/ads`;
  }

  getNewArrivalsUrls(origin: string): string[] {
    return [
      `${origin}/ads?sort_by=date_pub&sort_order=DESC`,
      `${origin}/ads`,
      `${origin}/`,
    ];
  }

  extractCatalogProducts($: cheerio.CheerioAPI, baseUrl: string): CatalogProduct[] {
    const products: CatalogProduct[] = [];
    const seen = new Set<string>();

    const SELECTORS = [
      '[class*="node--type-classified"]',
      '[class*="gunpost-teaser"]',
      '[class*="node--type-"][class*="teaser"]',
      '[class*="classified-ad"]',
      '[class*="classified-item"]',
      '[class*="listing-card"]',
      '[class*="listing-item"]',
      'article[class*="classified"]',
      'article[class*="listing"]',
    ];

    for (const selector of SELECTORS) {
      $(selector).each((_, el) => {
        const element = $(el);

        let titleEl = element.find('h1, h2, h3, h4').first();
        if (!titleEl.length) {
          titleEl = element.find('[class*="title"], [class*="name"], [class*="heading"], [class*="field-name-title"]').first();
        }
        const title = (titleEl.length ? titleEl.text() : element.text()).trim().replace(/\s+/g, ' ').slice(0, 160);
        if (!title || title.length < 3) return;
        if (/^\$?\d[\d,.]*$/.test(title)) return;

        const url = this.extractLink(element, baseUrl);
        if (!url || seen.has(url)) return;
        seen.add(url);

        const priceEl = element.find('[class*="price"], [class*="cost"], [class*="amount"], [class*="field-price"]').first();
        let price = this.extractPrice(priceEl.text() || '');
        if (!price) price = this.extractPriceFromTitle(title);

        const thumbnail = this.extractThumbnail($, element, baseUrl);

        products.push({
          url,
          title,
          price,
          stockStatus: 'in_stock',
          thumbnail,
          category: 'classified',
        });
      });
    }

    return products;
  }

  getNextPageUrl($: cheerio.CheerioAPI, currentUrl: string): string | null {
    const nextLink = $('a[rel="next"], [class*="pager"] a:contains("Next"), [class*="pager"] a:contains("›"), li.pager__item--next a').first();
    if (nextLink.length) {
      const href = nextLink.attr('href');
      if (href) return this.resolveUrl(href, currentUrl);
    }
    return null;
  }
}
