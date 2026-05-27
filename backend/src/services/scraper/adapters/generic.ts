import type * as cheerio from 'cheerio';
import type { ScrapedMatch, ExtractionOptions, CatalogProduct } from '../types';
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
      '[class*="item_card"]',          // TownPost classifieds (.category_item_card)
      '[class*="newest-ads"]',         // TownPost newest ads
      '[class*="lot"]', '[class*="auction"]',
      'article.post', 'article',
    ];

    for (const selector of ALL_SELECTORS) {
      $(selector).each((_, el) => {
        const element = $(el);
        const text = element.text();
        if (!options.isSearchPage && !text.toLowerCase().includes(keywordLower)) return;

        const rawTitle = this.extractTitle(element, text);
        if (!rawTitle || rawTitle.length < 3) return;
        if (/^\$?\d[\d,.]*$/.test(rawTitle)) return;
        if (this.isNavTitle(rawTitle)) return;

        const titleKey = rawTitle.toLowerCase().slice(0, 60);
        if (seen.has(titleKey)) return;

        const productUrl = this.extractLink(element, baseUrl);
        if (this.isNavUrl(productUrl)) return;
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

  // ── Catalog Crawl Methods (Phase 3) ───────────────────────────────────────

  getNewArrivalsUrl(origin: string): string {
    return `${origin}/`;
  }

  getNewArrivalsUrls(origin: string): string[] {
    // Read catalog URLs from site profile
    try {
      const domain = new URL(origin).hostname.replace(/^www\./, '');
      const { _getSiteCacheEntry } = require('../adapter-registry');
      const entry = _getSiteCacheEntry?.(domain);
      if (entry?.siteProfile?.catalogUrls?.length) {
        const urls = entry.siteProfile.catalogUrls.map((u: string) => u.startsWith('http') ? u : `${origin}${u}`);
        urls.push(`${origin}/`);
        return urls;
      }
    } catch { /* profile lookup failed */ }

    return [`${origin}/`];
  }

  extractCatalogProducts($: cheerio.CheerioAPI, baseUrl: string): CatalogProduct[] {
    const products: CatalogProduct[] = [];
    const seen = new Set<string>();

    const ALL_SELECTORS = [
      '[class*="product-card"]', '[class*="product-item"]', '[class*="product-tile"]',
      '[data-product-id]', '[data-product]', 'article[class*="product"]', 'li[class*="product"]',
      '[class*="listing"]', '[class*="classified"]', '[class*="post-card"]',
      '[class*="ad-card"]',
      '[class*="item_card"]',          // TownPost classifieds (.category_item_card)
      '[class*="newest-ads"]',         // TownPost newest ads
      'a[href*="/marketplace/"]',      // TownPost classifieds (Next.js SPA, anchor-wrapped cards)
      '[class*="lot"]', '[class*="auction"]',
    ];

    for (const selector of ALL_SELECTORS) {
      $(selector).each((_, el) => {
        const element = $(el);

        const title = this.extractTitle(element, element.text());
        if (!title || title.length < 3) return;
        if (/^\$?\d[\d,.]*$/.test(title)) return;
        if (this.isNavTitle(title)) return;

        const url = this.extractLink(element, baseUrl);
        if (!url || seen.has(url)) return;
        if (this.isNavUrl(url)) return;
        seen.add(url);

        const price = this.extractPriceFromElement(element) ?? this.extractPriceFromTitle(title);
        const inStock = this.isInStock(element);
        const thumbnail = this.extractThumbnail($, element, baseUrl);

        // Source ID extraction — same patterns as generic-retail.ts:1020-1032.
        // Pattern 1: slug-embedded ID (e.g. /shop/slug-28443)
        // Pattern 2: trailing path segment ID (e.g. TownPost /marketplace/.../1171321)
        let sourceId = element.attr('data-product-id')
          || element.attr('data-product_id')
          || element.closest('[data-product-id]').attr('data-product-id')
          || element.closest('[data-product_id]').attr('data-product_id')
          || undefined;
        if (!sourceId && url) {
          const urlIdMatch = url.match(/-(\d{4,})(?:[?#]|$)/) || url.match(/\/(\d{5,})(?:[?#]|$)/);
          if (urlIdMatch) sourceId = urlIdMatch[1];
        }

        products.push({
          url,
          sourceId,
          title,
          price,
          stockStatus: inStock ? 'in_stock' : 'out_of_stock',
          thumbnail,
        });
      });
    }

    return products;
  }
}
