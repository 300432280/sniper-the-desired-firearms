import type * as cheerio from 'cheerio';
import type { ScrapedMatch, SiteType, ExtractionOptions, SiteAdapter, ScrapeOptions } from '../types';
import { extractPrice, extractPriceFromTitle } from '../utils/price';
import { isInStock } from '../utils/stock';
import { resolveUrl } from '../utils/url';

/**
 * Base class providing shared helpers for all adapters.
 * Subclasses must implement: name, siteType, getSearchUrl, extractMatches.
 */
export abstract class AbstractAdapter implements SiteAdapter {
  abstract name: string;
  abstract siteType: SiteType;
  abstract getSearchUrl(origin: string, keyword: string): string;
  abstract extractMatches(
    $: cheerio.CheerioAPI,
    keyword: string,
    baseUrl: string,
    options: ExtractionOptions
  ): ScrapedMatch[];

  // Optional overrides
  searchViaApi?(origin: string, keyword: string, options: ScrapeOptions): Promise<ScrapedMatch[]>;
  getNextPageUrl?($: cheerio.CheerioAPI, currentUrl: string): string | null;

  // ── Shared extraction helpers ──────────────────────────────────────────

  /** Extract thumbnail URL from an element's img children */
  protected extractThumbnail($: cheerio.CheerioAPI, element: cheerio.Cheerio<any>, baseUrl: string): string | undefined {
    const img = element.find('img').first();
    if (!img.length) return undefined;

    // Prefer data-src (lazy-loaded real image) over src (may be a placeholder/loading SVG)
    // Klevu JS overlay uses "origin" attribute for the real CDN image URL.
    const dataSrc = img.attr('data-src') || img.attr('data-lazy-src') || img.attr('data-original') || img.attr('origin') || '';
    const src = img.attr('src') || '';
    // Use data-src if available, otherwise src — but skip loading/placeholder SVGs
    const isPlaceholder = /loading|place-?holder|blank|spacer|spinner|\.svg$/i.test(src) ||
      /klevu\.com/i.test(src);
    const chosen = dataSrc || (isPlaceholder ? '' : src);
    if (!chosen) return undefined;
    // Final check: reject placeholder URLs regardless of which attribute they came from
    if (/place-?holder|klevu\.com|blank\.(gif|png|jpg)/i.test(chosen)) return undefined;

    try {
      if (chosen.startsWith('http')) return chosen;
      if (chosen.startsWith('//')) return `https:${chosen}`;
      return new URL(chosen, baseUrl).toString();
    } catch {
      return undefined;
    }
  }

  /** Extract a date from an element */
  protected extractPostDate(element: cheerio.Cheerio<any>): string | undefined {
    // Look for time elements first
    const timeEl = element.find('time[datetime]').first();
    if (timeEl.length) {
      return timeEl.attr('datetime') || undefined;
    }

    // Look for date-like text patterns
    const dateEl = element.find('[class*="date"], [class*="time"], [class*="posted"]').first();
    if (dateEl.length) {
      const text = dateEl.text().trim();
      // ISO date patterns or common formats
      const match = text.match(/(\d{4}-\d{2}-\d{2})|(\w{3}\s+\d{1,2},?\s+\d{4})|(\d{1,2}\/\d{1,2}\/\d{2,4})/);
      if (match) return match[0];
    }

    return undefined;
  }

  /** Standard title extraction from an element */
  protected extractTitle(element: cheerio.Cheerio<any>, fallbackText: string): string {
    // Prefer explicit title/name classes (avoids grabbing brand-only h4 on BigCommerce)
    let titleEl = element.find('.card-title, .product-title, .product-name, .product_name').first();
    if (!titleEl.length) {
      titleEl = element.find('[class*="product-title"], [class*="product-name"], [class*="item-title"]').first();
    }
    if (!titleEl.length) {
      titleEl = element.find('[class*="title"], [class*="name"], [class*="heading"]').first();
    }
    // Only fall back to h-tags if nothing more specific found
    if (!titleEl.length) {
      titleEl = element.find('h1, h2, h3, h4').first();
    }

    let raw = (titleEl.length ? titleEl.text() : fallbackText).trim().replace(/\s+/g, ' ');

    // BigCommerce: .card-title sometimes wraps an <a> with the real title text.
    // If result looks like UI button text, try the <a> inside the card for actual product name.
    if (/^(choose options?|quick view|product view|buy now|add to cart|out of stock)/i.test(raw)) {
      const link = element.find('a[href*="/"]').first();
      if (link.length) {
        const linkText = link.text().trim().replace(/\s+/g, ' ');
        if (linkText.length > 5 && !/^(choose|quick|product view|buy|add to|out of)/i.test(linkText)) {
          raw = linkText;
        }
      }
    }

    // Strip trailing price + button/status text that BigCommerce/generic-retail cards
    // accidentally include (sibling elements' text captured alongside product title).
    raw = raw
      .replace(/\s*\$\s*[\d,.]+\s*(Choose\s+options?|Add\s+to\s+Cart|Buy\s+Now|Quick\s+view).*$/i, '')
      .replace(/\s*(Temporarily\s+)?Out[- ]of[- ]Stock!?.*$/i, '')
      .replace(/\s*Sold\s+Out!?.*$/i, '')
      .replace(/\s*(Choose\s+options?|Add\s+to\s+Cart|Buy\s+Now|Quick\s+view).*$/i, '')
      .trim()
      .slice(0, 160);

    return raw;
  }

  /** Standard link extraction from an element */
  protected extractLink(element: cheerio.Cheerio<any>, baseUrl: string): string {
    const linkEl = element.is('a')
      ? element
      : (element.closest('a').length ? element.closest('a') : element.find('a[href]').first());
    const href = linkEl.attr('href') || '';
    // Reject non-HTTP links (javascript:, mailto:, tel:, data:, #)
    if (/^(javascript:|mailto:|tel:|data:|#)/i.test(href.trim())) return '';
    return resolveUrl(href, baseUrl);
  }

  /** Standard price extraction from an element */
  protected extractPriceFromElement(element: cheerio.Cheerio<any>): number | undefined {
    // Try specific "current price" selectors first (BigCommerce, WooCommerce, Magento)
    const specificSelectors = [
      '.price--withoutTax',        // BigCommerce current price
      '.price--main',              // BigCommerce variant
      '.current-price .price',     // BigCommerce sale price
      '.woocommerce-Price-amount',  // WooCommerce
      '[itemprop="price"]',        // Schema.org
      '.special-price .price',     // Magento sale price
    ];
    for (const sel of specificSelectors) {
      const el = element.find(sel).first();
      if (el.length) {
        const price = extractPrice(el.text());
        if (price) return price;
      }
    }

    // Try all price-like elements, pick the first with an actual value
    const priceEls = element.find(
      '[class*="price"], [class*="cost"], [class*="amount"], [class*="field-price"]'
    );
    let result: number | undefined;
    priceEls.each((_, el) => {
      if (result) return;
      const text = element.find(el).text().trim();
      const price = extractPrice(text);
      if (price) result = price;
    });
    if (result) return result;

    // Last resort: extract from element's full text
    return extractPrice(element.text());
  }

  // ── URL & title filters (shared across adapters) ────────────────────

  /** Check if a URL is a category/navigation/utility page rather than a product page */
  protected isNavUrl(url: string): boolean {
    if (/\/(product-category|categorie-produit|category|categories|collections|brands|tags|subcategory|shop\/?\?|manufacturer)\b/i.test(url)) return true;
    if (/\/(wishlist|cart|checkout|account|login|register|registration|giftcert|contact|about|faq|privacy|terms|shipping|returns|blog|news|content\.php|pages?\/)/i.test(url)) return true;
    // Volusion/3dcart utility pages
    if (/\/(shoppingcart|myaccount|default)\.(asp|php|htm)/i.test(url)) return true;
    // BigCommerce/generic: search pages, gift certificate pages
    if (/\/search\.php/i.test(url)) return true;
    if (/\/giftcertificates/i.test(url)) return true;
    // Reject URLs that are just the site homepage (path is / or empty)
    try {
      const path = new URL(url).pathname;
      if (path === '/' || path === '') return true;
    } catch { /* ignore parse errors */ }
    return false;
  }

  /**
   * Reject titles that look like navigation labels, category names, or
   * other non-product text that adapters accidentally extract.
   */
  protected isNavTitle(title: string): boolean {
    const t = title.trim();
    // Very short single-word titles are almost always category labels
    if (t.length < 5 && !/\d/.test(t)) return true;
    const NAV_PATTERNS = [
      /^(home|homepage|search|login|register|sign\s*in|sign\s*up|contact|about|faq|help|cart|checkout|wishlist|account|menu|view\s+cart|my\s+account|sign\s*out)$/i,
      /^(clearance|sale|new|new\s+products?|best\s+sellers?|featured|on\s+sale|specials?)$/i,
      /^(manufacturers?|brands?|categories|all\s+products?|shop\s+all|view\s+all|see\s+all)$/i,
      /^(rifles?|shotguns?|handguns?|pistols?|revolvers?|ammunition|ammo|optics?|accessories|parts|magazines?)$/i,
      /^(semi[- ]?automatic|bolt[- ]?action|lever[- ]?action|pump[- ]?action|single[- ]?shot|break[- ]?action|side[- ]?by[- ]?side|over[- ]?under)$/i,
      /^(jobs?|services?|vehicles?|real\s+estate|used\s+furniture|hay\s+for\s+sale|used\s+farm|farm\s+equipment)$/i,
      /^(fish|fishing|hunt|hunting|outdoor|outdoors|camping|archery|marine|apparel|clothing|footwear)$/i,
      /^(search\s+find|return\s+to|go\s+to|click\s+here|read\s+more|learn\s+more|view\s+details?|see\s+more)/i,
      /homepage\s+return/i,
    ];
    for (const pat of NAV_PATTERNS) {
      if (pat.test(t)) return true;
    }
    if (!/[a-zA-Z]/.test(t)) return true;
    if (/^(CA)?\$[\d,.]+$/i.test(t)) return true;
    if (/^(derringer|tactical|black\s*powder|lower\s+receivers?|muzzleloaders?)$/i.test(t)) return true;
    if (/^(contact\s*us|gun\s+auctions?|featured\s+items?|import\s*\/?\s*export|custom\s+engraving)$/i.test(t)) return true;
    if (/^(parts\s*&\s*gear|us\s+store|news\s*&?\s*events?|commonly\s+asked|warranty|terms|privacy|create\s+an?\s+account)$/i.test(t)) return true;
    if (/^(puppies|dogs|trucks|furniture|used\s+\w+|see\s+the\s+newest)/i.test(t)) return true;
    // E-commerce button/UI text extracted as titles
    if (/^(out of stock!?|sold out|choose options?|quick view|product view|buy now|add to cart|view product|sitemap|compare)/i.test(t)) return true;
    // Pure stock status or UI label (e.g. "Out of stock", "| Sitemap")
    if (/^\|?\s*(sitemap|copyright|all rights)/i.test(t)) return true;
    // French category labels (pavillonchassepeche, etc.)
    if (/^(carabines?|fusils?|armes?\s+(à|a)\s+feu|salines?|chasse|pêche|pech[eé]|vêtements?|accessoires?)$/i.test(t)) return true;
    // XenForo sticky/info thread titles
    if (/equipment\s+exchanging.*responsibilit/i.test(t)) return true;
    if (/^ee\s+transactions/i.test(t)) return true;
    return false;
  }

  // Re-export utilities for adapter convenience
  protected extractPrice = extractPrice;
  protected extractPriceFromTitle = extractPriceFromTitle;
  protected isInStock = isInStock;
  protected resolveUrl = resolveUrl;
}
