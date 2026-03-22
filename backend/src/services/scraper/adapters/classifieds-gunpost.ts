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

  /** Extract category tags from gunpost URL path segments, e.g. /firearms/rifles/city/slug → "Firearms, Rifles" */
  private extractCategoryFromUrl(url: string): string | null {
    try {
      const path = new URL(url).pathname;
      const segments = path.split('/').filter(Boolean);
      // Pattern: /{category}/{subcategory}/{location}/{slug} — we want segments 0 and 1
      if (segments.length >= 2 && segments[0] !== 'ads') {
        const format = (s: string) => s.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        return [format(segments[0]), format(segments[1])].join(', ');
      }
    } catch { /* ignore bad URLs */ }
    return null;
  }

  /** Cap classifieds prices — anything over $99,999 is a placeholder/junk value */
  private sanitizeClassifiedPrice(price: number | undefined): number | undefined {
    if (price && price > 99999) return undefined;
    return price;
  }

  /** Detect wanted/WTB/WTT/ISO ads by title — these are buy requests, not for-sale listings */
  private isWantedAd(title: string): boolean {
    return /^(wanted|wtb|wtt|iso)\b/i.test(title.trim());
  }

  /**
   * Override base extractPostDate to grab gunpost's node__pubdate specifically.
   * This date reflects the MODIFIED/BUMPED date on the listing index page,
   * not the original post date — which is what we need for watermark tracking.
   */
  protected override extractPostDate(element: cheerio.Cheerio<any>): string | undefined {
    // Gunpost-specific: node__pubdate shows the modified/bumped date
    const pubdate = element.find('.node__pubdate, [class*="pubdate"]').first();
    if (pubdate.length) {
      const text = pubdate.text().trim();
      // Parse "Mar 9, 2026 - 3:28 PM" into ISO string
      const match = text.match(/(\w{3})\s+(\d{1,2}),?\s+(\d{4})\s*-?\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i);
      if (match) {
        const [, mon, day, year, hour, min, ampm] = match;
        const months: Record<string, string> = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
        const m = months[mon] || '01';
        let h = parseInt(hour);
        if (ampm.toUpperCase() === 'PM' && h < 12) h += 12;
        if (ampm.toUpperCase() === 'AM' && h === 12) h = 0;
        return `${year}-${m}-${day.padStart(2, '0')}T${String(h).padStart(2, '0')}:${min}:00`;
      }
      // Fallback: try base date patterns
      const dateMatch = text.match(/(\w{3}\s+\d{1,2},?\s+\d{4})/);
      if (dateMatch) return dateMatch[0];
    }
    return super.extractPostDate(element);
  }

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
        const wanted = this.isWantedAd(rawTitle);
        matches.push({
          title: rawTitle,
          price: wanted ? undefined : this.sanitizeClassifiedPrice(price),
          url: productUrl,
          thumbnail,
          postDate,
          inStock: wanted ? undefined : true,
        });
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

        const tags = this.extractCategoryFromUrl(url);
        const wanted = this.isWantedAd(title);
        const postDate = this.extractPostDate(element);

        products.push({
          url,
          title,
          price: wanted ? undefined : this.sanitizeClassifiedPrice(price),
          stockStatus: wanted ? undefined : 'in_stock',
          thumbnail,
          category: wanted ? 'wanted' : 'classified',
          tags: tags ?? undefined,
          postDate,
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
