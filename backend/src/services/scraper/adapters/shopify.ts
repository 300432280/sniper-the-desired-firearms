import type * as cheerio from 'cheerio';
import type { ScrapedMatch, ExtractionOptions, ScrapeOptions } from '../types';
import { AbstractAdapter } from './base';
import { pickUserAgent } from '../http-client';
import axios from 'axios';

/**
 * Shopify adapter — covers ~60% of Canadian firearms retail sites.
 *
 * Search: {origin}/search?q={keyword}&type=product
 * Optional API: /search/suggest.json?q={keyword}&resources[type]=product
 * Selectors: [data-product-id], product-card variants, grid items
 * Pagination: ?page=N
 */
export class ShopifyAdapter extends AbstractAdapter {
  name = 'Shopify';
  siteType = 'retailer' as const;

  getSearchUrl(origin: string, keyword: string): string {
    return `${origin}/search?q=${encodeURIComponent(keyword)}&type=product`;
  }

  async searchViaApi(origin: string, keyword: string, options: ScrapeOptions): Promise<ScrapedMatch[]> {
    try {
      const url = `${origin}/search/suggest.json`;
      const response = await axios.get(url, {
        params: {
          q: keyword,
          'resources[type]': 'product',
          'resources[limit]': options.fast ? 10 : 25,
        },
        headers: {
          'User-Agent': pickUserAgent(new URL(origin).hostname),
          Accept: 'application/json',
        },
        timeout: 15000,
      });

      const products = response.data?.resources?.results?.products || [];
      if (!Array.isArray(products) || products.length === 0) return [];

      const keywordLower = keyword.toLowerCase();
      const matches: ScrapedMatch[] = [];

      for (const product of products) {
        const title = (product.title || '').trim();
        if (!title || !title.toLowerCase().includes(keywordLower)) continue;

        const productUrl = product.url
          ? (product.url.startsWith('http') ? product.url : `${origin}${product.url}`)
          : origin;

        const price = product.price ? parseFloat(product.price) / 100 : undefined;
        const thumbnail = product.image || product.featured_image?.url || undefined;

        if (options.maxPrice && price && price > options.maxPrice) continue;

        matches.push({
          title: title.slice(0, 160),
          price: price && price > 0 ? price : undefined,
          url: productUrl,
          thumbnail,
          inStock: product.available !== false,
          seller: undefined,
        });
      }

      return matches;
    } catch {
      return []; // API not available, fall back to HTML
    }
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
      '[data-product-id]',
      '[class*="product-card"]',
      '[class*="product-item"]',
      '[class*="product-tile"]',
      '[class*="ProductItem"]',
      '.grid__item [class*="product"]',
      'li[class*="product"]',
      'article[class*="product"]',
      '[class*="grid-item"]',
    ];

    for (const selector of SELECTORS) {
      $(selector).each((_, el) => {
        const element = $(el);
        const text = element.text();
        if (!text.toLowerCase().includes(keywordLower)) return;

        const rawTitle = this.extractTitle(element, text);
        if (!rawTitle || rawTitle.length < 3) return;
        if (/^\$?\d[\d,.]*$/.test(rawTitle)) return;

        const titleKey = rawTitle.toLowerCase().slice(0, 60);
        if (seen.has(titleKey)) return;

        const productUrl = this.extractLink(element, baseUrl);
        const price = this.extractPriceFromElement(element);
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

  getNextPageUrl($: cheerio.CheerioAPI, currentUrl: string): string | null {
    // Shopify pagination: ?page=N
    const nextLink = $('a[rel="next"], [class*="pagination"] a:contains("Next"), [class*="pagination"] a:contains("›")').first();
    if (nextLink.length) {
      const href = nextLink.attr('href');
      if (href) {
        return this.resolveUrl(href, currentUrl);
      }
    }
    return null;
  }
}
