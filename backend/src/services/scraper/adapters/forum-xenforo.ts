import type * as cheerio from 'cheerio';
import type { ScrapedMatch, ExtractionOptions, CatalogProduct } from '../types';
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

      // XenForo title structure: .structItem-title may contain a prefix label <a> ("WTS :")
      // followed by the actual thread title <a>. Use full container text for title,
      // and find the thread link (points to /threads/, not /forums/ prefix filter).
      const { title: rawTitle, href } = this.extractXfTitle($, element);
      if (!rawTitle || rawTitle.length < 3) return;

      const titleKey = rawTitle.toLowerCase().slice(0, 60);
      if (seen.has(titleKey)) return;

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

  // ── Catalog Crawl Methods (Phase 3) ───────────────────────────────────────

  getNewArrivalsUrl(origin: string): string {
    return `${origin}/whats-new/posts/`;
  }

  getNewArrivalsUrls(origin: string): string[] {
    const urls: string[] = [];

    // Site-specific exchange/classified forum sections (public, no auth)
    // Must target individual sub-forums (which list threads/structItems),
    // NOT the parent category page (which only lists sub-forum links)
    if (origin.includes('canadiangunnutz.com')) {
      urls.push(
        `${origin}/forum/forums/exchange-of-hunting-and-sporting-rifles.64/`,
        `${origin}/forum/forums/exchange-of-modern-sporting-rifles.65/`,
        `${origin}/forum/forums/exchange-of-pistols-and-revolvers.66/`,
        `${origin}/forum/forums/exchange-of-shotguns.145/`,
        `${origin}/forum/forums/exchange-of-rimfire-firearms.160/`,
        `${origin}/forum/forums/exchange-of-military-surplus-rifle.128/`,
        `${origin}/forum/forums/exchange-of-precision-and-target-rifles.156/`,
        `${origin}/forum/forums/exchange-of-12x-prohib-firearms.330/`,
        `${origin}/forum/forums/exchange-of-optics.67/`,
        `${origin}/forum/forums/exchange-of-reloading-components-and-equipment.68/`,
      );
    }

    urls.push(
      `${origin}/whats-new/posts/`,
      `${origin}/forums/`,
    );

    return urls;
  }

  extractCatalogProducts($: cheerio.CheerioAPI, baseUrl: string): CatalogProduct[] {
    const products: CatalogProduct[] = [];
    const seen = new Set<string>();

    // XenForo thread listings (structItem is the thread row)
    const xfThreads = $('.structItem, [class*="structItem--thread"]');
    xfThreads.each((_, el) => {
      const element = $(el);

      const { title, href } = this.extractXfTitle($, element);
      if (!title || title.length < 3) return;
      // Skip prefix labels that link to forum pages instead of threads
      if (!href || !href.includes('/threads/')) return;

      const url = this.resolveUrl(href, baseUrl);
      if (!url || seen.has(url)) return;
      seen.add(url);

      const price = this.extractPriceFromTitle(title);
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

    return products;
  }

  /**
   * Extract title and thread href from a XenForo .structItem element.
   * Handles the common pattern where .structItem-title contains:
   *   <a class="labelLink">WTS :</a>  (prefix label, links to prefix filter)
   *   <a href="/threads/...">Actual Title</a>  (thread link)
   * Returns full title text and the thread href (not the prefix filter href).
   */
  private extractXfTitle($: cheerio.CheerioAPI, element: cheerio.Cheerio<any>): { title: string; href: string } {
    const titleContainer = element.find('.structItem-title');
    if (!titleContainer.length) {
      const altContainer = element.find('[class*="title"]');
      const altLink = altContainer.find('a').first();
      return {
        title: (altLink.length ? altLink.text() : element.text()).trim().replace(/\s+/g, ' ').slice(0, 160),
        href: altLink.attr('href') || '',
      };
    }

    // Full text of the title container (includes prefix label + thread title)
    const fullTitle = titleContainer.text().trim().replace(/\s+/g, ' ').slice(0, 160);

    // Find the thread link — it's the <a> whose href points to /threads/, not /forums/
    const links = titleContainer.find('a');
    let threadHref = '';
    let threadText = '';

    links.each((_, a) => {
      const href = $(a).attr('href') || '';
      // Thread links contain /threads/, prefix label links contain /forums/
      if (href.includes('/threads/')) {
        threadHref = href;
        threadText = $(a).text().trim();
      }
    });

    // Fallback: if no /threads/ link found, use last link
    if (!threadHref && links.length) {
      const lastLink = links.last();
      threadHref = lastLink.attr('href') || '';
      threadText = lastLink.text().trim();
    }

    return {
      title: fullTitle || threadText,
      href: threadHref,
    };
  }

  getNextPageUrl($: cheerio.CheerioAPI, currentUrl: string): string | null {
    const nextLink = $('a.pageNav-jump--next, a[rel="next"]').first();
    if (nextLink.length) {
      const href = nextLink.attr('href');
      if (href) return this.resolveUrl(href, currentUrl);
    }
    return null;
  }
}
