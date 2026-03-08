import type * as cheerio from 'cheerio';
import type { ScrapedMatch, ExtractionOptions, CatalogProduct } from '../types';
import { AbstractAdapter } from './base';
import { extractBidPrice } from '../utils/price';

/** Only index lots whose title matches firearm-related keywords (firearms, ammo, optics, parts, knives, gear). */
const FIREARMS_RELEVANCE = /\b(rifle|shotgun|handgun|pistol|revolver|carbine|firearm|muzzleloader|receiver|ammunit|ammo|cartridge|shotshell|rimfire|centerfire|reload|brass|primer|scope|riflescope|red[\s-]?dot|holographic|rangefinder|binocular|optic|magnifier|knife|knives|blade|bayonet|machete|magazine|trigger|barrel|stock|grip|handguard|bipod|sling|holster|choke|suppressor|silencer|muzzle[\s-]?brake|compensator|gun[\s-]?safe|cleaning[\s-]?kit|bore[\s-]?snake|ear[\s-]?muff|ruger|remington|glock|sig\s?sauer|smith.*wesson|s&w|browning|winchester|benelli|beretta|mossberg|savage|tikka|henry|marlin|colt|stoeger|franchi|weatherby|howa|bergara|sks|norinco|cz[\s-]?\d|tavor|iwi|derya|kel[\s-]?tec|kriss|kodiak|stag[\s-]?\d|eotech|aimpoint|holosun|trijicon|vortex|leupold|bushnell|nightforce|hornady|federal\s+\w+\s+grain|cci|fiocchi|22[\s-]?lr|223[\s-]?rem|308[\s-]?win|5\.56|9mm|12[\s-]?gauge|20[\s-]?gauge|45[\s-]?acp|6\.5[\s-]?creedmoor|300[\s-]?win|7\.62|caliber|gauge)\b/i;

/**
 * HiBid auction adapter — HiBid-specific selectors.
 */
export class HiBidAdapter extends AbstractAdapter {
  name = 'HiBid';
  siteType = 'auction' as const;

  getSearchUrl(origin: string, keyword: string): string {
    return `${origin}/search?searchPhrase=${encodeURIComponent(keyword)}`;
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
      '.lot-tile',                 // HiBid lot tiles (exact class — avoids matching sub-elements)
      '[class*="lotContainer"]',
      '[class*="LotTile"]',
      '[class*="lot-item"]',
      '[class*="lotItem"]',
      '[class*="catalog-item"]',
      '[class*="auction-item"]',
      '[class*="item-card"]',
    ];

    for (const selector of LOT_SELECTORS) {
      $(selector).each((_, el) => {
        const element = $(el);
        const text = element.text();
        if (!text.toLowerCase().includes(keywordLower)) return;

        const rawTitle = this.extractHiBidTitle(element);
        if (!rawTitle || rawTitle.length < 3) return;
        if (/^\$?\d[\d,.]*$/.test(rawTitle)) return;
        if (!rawTitle.toLowerCase().includes(keywordLower)) return;

        const cleanTitle = rawTitle.replace(/^(?:Lot\s+)?\d+[A-Za-z]?\s*\|\s*/, '').trim() || rawTitle;
        const titleKey = cleanTitle.toLowerCase().slice(0, 60);
        if (seen.has(titleKey)) return;

        const lotUrl = this.extractLink(element, baseUrl);

        const bidEl = element.find('[class*="current-bid"], [class*="winning-bid"], [class*="bid-amount"], [class*="price"]').first();
        const price = bidEl.length ? extractBidPrice(bidEl.text()) : extractBidPrice(element.text());

        if (options.maxPrice && price && price > options.maxPrice) return;

        const thumbnail = this.extractThumbnail($, element, baseUrl);

        seen.add(titleKey);
        matches.push({ title: cleanTitle || rawTitle, price, url: lotUrl, thumbnail });
      });
    }

    return matches;
  }

  /**
   * Extract title from HiBid lot element.
   * HiBid uses: .live-catalog-lot-lead-container > a (link text is the title)
   * Also tries standard heading/title selectors as fallback.
   */
  private extractHiBidTitle(element: cheerio.Cheerio<any>): string {
    // HiBid-specific: lot lead link text
    const leadLink = element.find('.live-catalog-lot-lead-container a, [class*="lot-lead"] a').first();
    if (leadLink.length) {
      const text = leadLink.text().trim();
      if (text.length >= 3) return text.replace(/\s+/g, ' ').slice(0, 160);
    }

    // Standard title selectors
    let titleEl = element.find('[class*="lot-title"], [class*="lotTitle"], [class*="lot-name"]').first();
    if (!titleEl.length) titleEl = element.find('h3, h4, h2').first();
    if (!titleEl.length) titleEl = element.find('[class*="title"], [class*="name"], [class*="description"]').first();
    if (titleEl.length) {
      const text = titleEl.text().trim();
      if (text.length >= 3) return text.replace(/\s+/g, ' ').slice(0, 160);
    }

    // Last resort: first a[href*="/lot/"] link text
    const lotLink = element.find('a[href*="/lot/"]').first();
    if (lotLink.length) {
      const text = lotLink.text().trim();
      if (text.length >= 3) return text.replace(/\s+/g, ' ').slice(0, 160);
    }

    return '';
  }

  // ── Catalog Crawl Methods (Phase 3) ───────────────────────────────────────

  getNewArrivalsUrl(origin: string): string {
    return `${origin}/lots`;
  }

  getNewArrivalsUrls(origin: string): string[] {
    return [
      `${origin}/lots`,                 // Main lot listing (most products)
      `${origin}/auctions/current`,     // Current auctions page
      `${origin}/catalog/`,
      `${origin}/`,
    ];
  }

  extractCatalogProducts($: cheerio.CheerioAPI, baseUrl: string): CatalogProduct[] {
    const products: CatalogProduct[] = [];
    const seen = new Set<string>();

    const LOT_SELECTORS = [
      '.lot-tile',                 // HiBid lot tiles (exact class — avoids matching sub-elements)
      '[class*="lotContainer"]',
      '[class*="LotTile"]',
      '[class*="lot-item"]',
      '[class*="lotItem"]',
      '[class*="catalog-item"]',
      '[class*="auction-item"]',
      '[class*="item-card"]',
    ];

    for (const selector of LOT_SELECTORS) {
      $(selector).each((_, el) => {
        const element = $(el);

        const rawTitle = this.extractHiBidTitle(element);
        if (!rawTitle || rawTitle.length < 3) return;
        if (/^\$?\d[\d,.]*$/.test(rawTitle)) return;

        const cleanTitle = rawTitle.replace(/^(?:Lot\s+)?\d+[A-Za-z]?\s*\|\s*/, '').trim() || rawTitle;

        // Only index firearm-related lots — skip coins, art, furniture, etc.
        if (!FIREARMS_RELEVANCE.test(cleanTitle)) return;

        const url = this.extractLink(element, baseUrl);
        if (!url || seen.has(url)) return;
        seen.add(url);

        const bidEl = element.find('[class*="current-bid"], [class*="winning-bid"], [class*="bid-amount"], [class*="price"]').first();
        const price = bidEl.length ? extractBidPrice(bidEl.text()) : extractBidPrice(element.text());
        const thumbnail = this.extractThumbnail($, element, baseUrl);

        products.push({
          url,
          title: cleanTitle || rawTitle,
          price,
          stockStatus: 'in_stock',
          thumbnail,
          category: 'auction_lot',
        });
      });
    }

    return products;
  }
}
