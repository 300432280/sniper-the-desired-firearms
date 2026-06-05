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

  // ── Classifieds scoping ───────────────────────────────────────────────────

  /**
   * True when the site this URL belongs to is a classifieds marketplace
   * (siteCategory='classified' / siteType='classifieds', e.g. townpost.ca).
   * Looked up from the DB site cache by domain — the same source
   * getNewArrivalsUrls() already uses. Returns false for the ~23 RETAIL sites
   * that also fall back to this generic adapter, so their out-of-stock /
   * price / title behaviour is unchanged.
   */
  private isClassifiedSite(baseUrl: string): boolean {
    try {
      const domain = new URL(baseUrl).hostname.replace(/^www\./, '');
      const { _getSiteCacheEntry } = require('../adapter-registry');
      const entry = _getSiteCacheEntry?.(domain);
      return entry?.siteCategory === 'classified' || entry?.siteType === 'classifieds';
    } catch {
      return false;
    }
  }

  /**
   * Resolve stock status for a card.
   *
   * RETAIL (isClassified=false): unchanged from the original
   * `inStock ? 'in_stock' : 'out_of_stock'` — a true `false`/`undefined` from
   * isInStock (disabled cart, "out of stock" text, or no buy signal) keeps
   * marking out_of_stock so real OOS retail products are still flagged.
   *
   * CLASSIFIEDS (isClassified=true): a live listing is AVAILABLE by default. A
   * classified ad has no add-to-cart, so isInStock() returns undefined for every
   * ad — the old retail mapping wrongly turned that into out_of_stock for all
   * 9,046 active townpost ads. Here a card is `in_stock` UNLESS isInStock()
   * explicitly returns false (an out-of-stock term like "sold" appears in the
   * card text). The detail-page `<title>Sold ` signal isn't present on listing
   * cards, so listing extraction yields in_stock; a "sold"/"sold out" badge in
   * card text (if a site adds one) is still honoured via isInStock's outTerms.
   */
  private resolveStockStatus(
    element: cheerio.Cheerio<any>,
    isClassified: boolean,
  ): 'in_stock' | 'out_of_stock' {
    const signal = this.isInStock(element);
    if (isClassified) {
      return signal === false ? 'out_of_stock' : 'in_stock';
    }
    return signal ? 'in_stock' : 'out_of_stock';
  }

  /**
   * Classifieds price extraction. A classified card carries its asking price in
   * a free-text field a seller types — TownPost renders it as
   * `<span title="95$">95$</span>` (trailing-$) or `<span title="$195.00">`
   * (prefix-$). The shared extractPriceFromElement only catches prefix-$ via
   * `[title^="$"]`, so trailing-$ asking prices are missed. Here we read ANY
   * `title` attr (or its text) that contains a `$` — safe because it is only
   * called on classifieds cards — and parse it with extractPriceFromTitle,
   * which understands prefix-$, no-space-$, and trailing-$ forms. Picks the
   * LOWEST positive value when several are present (mirrors base.ts 2b).
   */
  private extractClassifiedPrice(element: cheerio.Cheerio<any>): number | undefined {
    const candidates: number[] = [];
    element.find('[title*="$"]').each((_, el) => {
      const node = element.find(el);
      const attr = node.attr('title') || '';
      const p = this.extractPriceFromTitle(attr) ?? this.extractPriceFromTitle(node.text());
      if (p) candidates.push(p);
    });
    return candidates.length ? Math.min(...candidates) : undefined;
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
    const isClassified = this.isClassifiedSite(baseUrl);

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

        // On classifieds, the asking price lives in a seller-typed price span
        // (TownPost: `<span title="95$">`). Read it directly (handles trailing-$),
        // then fall back to the shared element/title extractors. Retail keeps the
        // original element-first order untouched.
        const price = isClassified
          ? (this.extractClassifiedPrice(element) ?? this.extractPriceFromElement(element) ?? this.extractPriceFromTitle(title))
          : (this.extractPriceFromElement(element) ?? this.extractPriceFromTitle(title));
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

        // Classifieds (e.g. TownPost) carry buy-requests ("wanted"/WTB/ISO/LF)
        // alongside for-sale listings — tag them so search can filter them out.
        // A buy-request has no real price/stock, so suppress both.
        const wanted = this.isWantedAdTitle(title);
        products.push({
          url,
          sourceId,
          title,
          price: wanted ? undefined : price,
          stockStatus: wanted ? undefined : this.resolveStockStatus(element, isClassified),
          thumbnail,
          category: wanted ? 'wanted' : undefined,
        });
      });
    }

    return products;
  }
}
