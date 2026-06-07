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

  /**
   * Detect a classifieds "wanted"/buy-request ad from its title. Anchored to the
   * title start/end so for-sale listings aren't misflagged (e.g. a rifle whose
   * blurb mentions "looking for"). Shared by the classifieds/forum adapters so
   * the patterns live in one place. Wanted ads get category='wanted' and their
   * price/stock suppressed (a buy-request has no real price/stock).
   */
  protected isWantedAdTitle(title: string): boolean {
    const t = title.trim();
    // Prefix: "Wanted: …", "WTB …", "WTT …", "ISO …", "Looking for …",
    // "In search of …", "Want to buy …". Bare "LF" is intentionally excluded —
    // it collides with retail product names (LF-15 lower, lead-free "LF" ammo)
    // and the generic adapter that calls this serves ~23 retail sites.
    if (/^(wanted|wtb|wtt|iso|looking\s+for|in\s+search\s+of|want\s+to\s+buy)\b/i.test(t)) return true;
    // Suffix: "Sks wanted", "Norinco parts WTB"
    if (/\b(wanted|wtb|wtt|iso)\s*$/i.test(t)) return true;
    // Inline "Wanted:" label
    if (/\bwanted\s*:/i.test(t)) return true;
    return false;
  }

  /** Extract thumbnail URL from an element's img children */
  protected extractThumbnail($: cheerio.CheerioAPI, element: cheerio.Cheerio<any>, baseUrl: string): string | undefined {
    // 1. Try the first <img> inside the element.
    const direct = this._thumbnailFromImg(element.find('img').first(), baseUrl);
    if (direct) return direct;

    // 2. Fallback: the matched element carries no usable <img>. This happens on
    //    sites where the product card splits the image and the title into
    //    SIBLING anchors (e.g. TownPost's Next.js cards: a text-only <a> wins the
    //    URL dedupe while the image lives in a sibling <a> of the same card div
    //    that has no card/product class to match a class selector against).
    //    Climb to the LARGEST ancestor that still references only ONE distinct
    //    product link, then pull its first usable image. Stopping at one-link
    //    scope guarantees the image belongs to this card and not a neighbour —
    //    the moment an ancestor contains 2+ distinct hrefs we are in the grid
    //    wrapper and bail. This is additive: it only fires when step 1 found
    //    nothing, so it can never discard an image step 1 already captured.
    let card: cheerio.Cheerio<any> | null = null;
    let cur = element.parent();
    for (let depth = 0; depth < 5 && cur.length; depth++) {
      const hrefs = new Set<string>();
      cur.find('a[href]').each((_, a) => {
        const h = (a.attribs?.href || '').trim();
        if (h && !/^(javascript:|mailto:|tel:|data:|#)/i.test(h)) hrefs.add(h.replace(/[?#].*$/, ''));
      });
      if (hrefs.size > 1) break; // reached a multi-card container — stop before it
      if (cur.find('img').length > 0) card = cur; // candidate: scoped to one product, has an image
      cur = cur.parent();
    }
    if (card) {
      const fromCard = this._thumbnailFromImg(card.find('img').first(), baseUrl);
      if (fromCard) return fromCard;
    }
    return undefined;
  }

  /** Resolve a usable image URL from a single <img>, skipping placeholders. */
  private _thumbnailFromImg(img: cheerio.Cheerio<any>, baseUrl: string): string | undefined {
    if (!img.length) return undefined;

    // Prefer data-src (lazy-loaded real image) over src (may be a placeholder/loading SVG)
    // Klevu JS overlay uses "origin" attribute for the real CDN image URL.
    // data-wood-src: Woodmart WooCommerce theme lazy-load (e.g. g4cgunstore.com); src is a base64 placeholder.
    const dataSrc = img.attr('data-src') || img.attr('data-lazy-src') || img.attr('data-original') || img.attr('data-wood-src') || img.attr('origin') || '';
    const src = img.attr('src') || '';
    // Use data-src if available, otherwise src — but skip loading/placeholder SVGs
    const isPlaceholder = /loading|place-?holder|blank|spacer|spinner|\.svg$/i.test(src) ||
      /klevu\.com/i.test(src);
    let chosen = dataSrc || (isPlaceholder ? '' : src);
    // Last resort: pull the first candidate from srcset/data-srcset. Some lazy-load
    // themes leave src as an inline base64/SVG placeholder and only populate the
    // responsive set (the actual CDN URLs live there).
    if (!chosen) {
      const set = img.attr('srcset') || img.attr('data-srcset') || '';
      if (set) {
        // srcset = "url1 320w, url2 640w" — first token of the first entry is the URL.
        const first = set.split(',')[0]?.trim().split(/\s+/)[0] || '';
        if (first && !/^data:/i.test(first)) chosen = first;
      }
    }
    if (!chosen) return undefined;
    // Final check: reject placeholder URLs regardless of which attribute they came from
    if (/place-?holder|klevu\.com|blank\.(gif|png|jpg)/i.test(chosen)) return undefined;
    if (/^data:/i.test(chosen)) return undefined;

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
    // Highest priority: Wix Stores product cards label the title span
    // `data-hook="product-item-name"` and put the price in a SIBLING `[data-hook*=price]`
    // span. Without this, the generic selectors below miss it and we fall through to
    // fallbackText = the entire `a.text()` which concatenates title + "Price$X.YY",
    // producing the surplusherbys.com title-merge bug (2026-05-31).
    let titleEl = element.find('[data-hook="product-item-name"]').first();
    // Next priority: an explicit title test-id. Classifieds marketplaces
    // (TownPost Next.js cards) label the title span `data-testid="ad-title"` and
    // give it NO title/name class, so without this the generic selectors below
    // miss it and we fall through to fallbackText = the whole card's concatenated
    // text (price + title + sr-only "categories:..." + town + "5 minutes ago").
    // Retail cards don't carry data-testid="ad-title", so this is a no-op for them.
    if (!titleEl.length) {
      titleEl = element.find('[data-testid="ad-title"]').first();
    }
    // Prefer explicit title/name classes (avoids grabbing brand-only h4 on BigCommerce)
    if (!titleEl.length) {
      titleEl = element.find('.card-title, .product-title, .product-name, .product_name').first();
    }
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

    // TownPost classifieds fallback malformation. When a card's title can't be read
    // from `data-testid="ad-title"` (older markup), `raw` becomes the whole anchor's
    // concatenated text: `$<price><title>categories:<cats><town><time-ago>` — e.g.
    // `$1200.00Steiner GS3 ...categories:Sporting GoodsGunsToronto, ON1 day ago`.
    // Two signatures must BOTH hold to fire this strip: a leading `$<price>` AND a
    // `categories:` sr-only tail. Requiring both narrows it to the TownPost shape and
    // spares legitimate titles that merely contain the word "categories:" (e.g.
    // "Browse all categories: rifles, shotguns", "FDE Lower - categories: Rifle Parts"),
    // which have no leading price. It can still over-strip a contrived title that both
    // starts with a price AND contains "categories:" — no live fleet title does today.
    if (/^\s*\$\s*[\d,]/.test(raw) && /categories:/i.test(raw)) {
      raw = raw
        .replace(/\s*categories:.*$/i, '')
        .replace(/^\s*\$\s*[\d,]+(?:\.\d{1,2})?\s*/, '')
        .trim();
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
    // Prefer the first <a> whose href looks like a product page (not an image).
    // Common WC themes wrap image-zoom <a href="image.jpg"> ABOVE the
    // product-link <a href="/product/slug">; taking the first link blindly
    // pulls the image URL as the "product URL" (Corwin-Arms repro 2026-05-27).
    const IMAGE_EXT = /\.(jpe?g|png|gif|webp|svg|bmp|avif)(\?|#|$)/i;
    const isProductHref = (h: string | undefined) => {
      if (!h) return false;
      const t = h.trim();
      if (/^(javascript:|mailto:|tel:|data:|#)/i.test(t)) return false;
      if (IMAGE_EXT.test(t)) return false;
      return true;
    };

    if (element.is('a')) {
      const href = element.attr('href') || '';
      if (isProductHref(href)) return resolveUrl(href, baseUrl);
      return '';
    }
    const closest = element.closest('a').attr('href');
    if (isProductHref(closest)) return resolveUrl(closest!, baseUrl);
    let chosen = '';
    element.find('a[href]').each((_, el) => {
      if (chosen) return;
      const href = (el.attribs?.href || '').trim();
      if (isProductHref(href)) chosen = href;
    });
    if (chosen) return resolveUrl(chosen, baseUrl);
    return '';
  }

  /** Extract both sale and regular prices from an element */
  protected extractPricesFromElement(element: cheerio.Cheerio<any>): { price?: number; regularPrice?: number } {
    const result = this._extractPriceInternal(element);
    if (!result.price) return {};
    // Only set regularPrice if it's actually higher than the sale price
    if (result.regularPrice && result.regularPrice > result.price) {
      return result;
    }
    return { price: result.price };
  }

  /** Standard price extraction from an element — prioritizes sale/discount prices */
  protected extractPriceFromElement(element: cheerio.Cheerio<any>): number | undefined {
    return this._extractPriceInternal(element).price;
  }

  private _extractPriceInternal(element: cheerio.Cheerio<any>): { price?: number; regularPrice?: number } {
    // Try to find a struck-through / regular price for the regularPrice field
    let regularPrice: number | undefined;
    const struckEls = element.find('del [class*="price"], s [class*="price"], strike [class*="price"], del, s, strike');
    struckEls.each((_, el) => {
      if (regularPrice) return;
      const p = extractPrice(element.find(el).text());
      if (p) regularPrice = p;
    });
    // Also check elements with "regular" or "was" in class name
    if (!regularPrice) {
      const regEl = element.find('[class*="regular"], [class*="was-price"], [class*="old-price"], [class*="original"], .listPrice').first();
      if (regEl.length) {
        const p = extractPrice(regEl.text());
        if (p) regularPrice = p;
      }
    }
    // Check for "Regular Price:" text pattern
    if (!regularPrice) {
      const regMatch = element.text().match(/(?:Regular\s*Price|Was|MSRP)[:\s]*(?:CAD\s*|C)?\$\s*([\d,]+(?:\.\d{1,2})?)/i);
      if (regMatch) {
        const v = parseFloat(regMatch[1].replace(/,/g, ''));
        if (v >= 10) regularPrice = v;
      }
    }

    // 1. Try sale/discount price selectors first (these are the CURRENT price the customer pays)
    const saleSelectors = [
      '.special-price .price',     // Magento sale price
      '.price-sale',               // Generic sale price
      '.sale-price',               // Generic
      '.salePrice',                // CamelCase (bullseyenorth ColdFusion)
      '.current-price .price',     // BigCommerce sale price
      'ins .woocommerce-Price-amount', // WooCommerce sale (inside <ins>)
      '[class*="sale"] [class*="price"]', // Generic sale container
    ];
    for (const sel of saleSelectors) {
      const el = element.find(sel).first();
      if (el.length) {
        const price = extractPrice(el.text());
        if (price) return { price, regularPrice };
      }
    }

    // 2. Try specific "current price" selectors (BigCommerce, WooCommerce, Schema.org)
    const specificSelectors = [
      '.price--withoutTax',        // BigCommerce current price
      '.price--main',              // BigCommerce variant
      '.woocommerce-Price-amount',  // WooCommerce
      '[itemprop="price"]',        // Schema.org
    ];
    for (const sel of specificSelectors) {
      const el = element.find(sel).first();
      if (el.length) {
        const price = extractPrice(el.text());
        if (price) return { price, regularPrice };
      }
    }

    // 2b. title="$X" attribute (TownPost listing cards use <span title="$195.00">).
    // Structured attribute, unambiguous currency — accept any positive value.
    // Picks the LOWEST (likely current/sale) when multiple are present.
    const titlePrices: number[] = [];
    element.find('[title^="$"], [title^="C$"], [title^="CAD"]').each((_, el) => {
      const t = element.find(el).attr('title') || '';
      const p = extractPrice(t);
      if (p) titlePrices.push(p);
    });
    if (titlePrices.length) {
      return { price: Math.min(...titlePrices), regularPrice };
    }

    // 3. Try all price-like elements, but skip struck-through / "was" / "regular" prices
    // Note: class matching is case-sensitive in Cheerio, so we need both cases
    // (e.g. bullseyenorth uses "listPrice" / "salePrice" with capital P)
    const priceEls = element.find(
      '[class*="price"], [class*="Price"], [class*="cost"], [class*="amount"], [class*="field-price"], .pricing'
    );
    const prices: number[] = [];
    priceEls.each((_, el) => {
      const priceEl = element.find(el);
      const text = priceEl.text().trim();
      // Skip struck-through prices (original/regular price)
      if (priceEl.is('del, s, strike') || priceEl.closest('del, s, strike').length) return;
      if (priceEl.hasClass('price-regular') || priceEl.hasClass('listPrice') || /\bregular\b|\bwas\b|\bmsrp\b|\boriginal\b/i.test(priceEl.attr('class') || '')) return;
      const price = extractPrice(text);
      if (price) prices.push(price);
    });
    // If we found multiple prices, the lower one is likely the sale price
    if (prices.length > 1) {
      const salePrice = Math.min(...prices);
      // If no regularPrice found yet, the higher price is likely the regular
      if (!regularPrice) regularPrice = Math.max(...prices);
      return { price: salePrice, regularPrice };
    }
    if (prices.length === 1) return { price: prices[0], regularPrice };

    // 4. Last resort: extract from element's full text
    const fullText = element.text();
    const allPrices: number[] = [];
    const priceRegex = /(?:CAD\s*|C)?\$\s*([\d,]+(?:\.\d{1,2})?)/g;
    let m: RegExpExecArray | null;
    while ((m = priceRegex.exec(fullText)) !== null) {
      const v = parseFloat(m[1].replace(/,/g, ''));
      if (v >= 10) allPrices.push(v);
    }
    if (allPrices.length > 1) {
      const salePrice = Math.min(...allPrices);
      if (!regularPrice) regularPrice = Math.max(...allPrices);
      return { price: salePrice, regularPrice };
    }
    if (allPrices.length === 1) return { price: allPrices[0], regularPrice };

    return {};
  }

  // ── URL & title filters (shared across adapters) ────────────────────

  /** Check if a URL is a category/navigation/utility page rather than a product page */
  protected isNavUrl(url: string): boolean {
    if (/\/(product-category|categorie-produit|category|categories|collections|brands|tags|subcategory|shop\/?\?|manufacturer)\b/i.test(url)) return true;
    if (/\/(wishlist|cart|checkout|account|login|register|registration|giftcert|contact|about|faq|privacy|terms|shipping|returns|blog|news|content\.php|pages?\/)/i.test(url)) return true;
    // TownPost classifieds: /buysell, /buysell/<province>, /sellers, /forsale are
    // province/section landing pages, not ad detail pages. Real ads are under
    // /marketplace/<city>/<category>/<slug>/<numericId>. Anchored to standalone
    // path segments to avoid false matches inside product slugs.
    if (/\/(buysell|sellers|forsale)(\/|$|\?)/i.test(url)) return true;
    // Volusion/3dcart utility pages
    if (/\/(shoppingcart|myaccount|default)\.(asp|php|htm)/i.test(url)) return true;
    // BigCommerce/generic: search pages, gift certificate pages
    if (/\/search\.php/i.test(url)) return true;
    if (/\/giftcertificates/i.test(url)) return true;
    // BigCommerce Stencil faceted-navigation pages. A `_bc_fsnf` query param is the
    // BC "faceted search nav filter" flag — these URLs (e.g.
    // `/ar-15-parts/brakes.html?_bc_fsnf=1&brand=252`) are a category page filtered
    // by a brand/feature facet, NOT a product. The card markup BC renders for them
    // is the category tile (title = category name, no thumbnail/sourceId), so they
    // leak into extractCatalogProducts as junk "products". The param is unique to
    // facet pages — real BC product detail URLs (`/<slug>/`) never carry it — so
    // matching it is precise and generic across every BC Stencil site.
    // (truenortharms.com repro 2026-06-05: 364 such rows titled "Brakes" etc.)
    if (/[?&]_bc_fsnf=/i.test(url)) return true;
    // Generic faceted-navigation query params. A category listing filtered by a
    // brand/sort/price/colour/size facet renders a category TILE card (title =
    // category/brand name, price=null, no sourceId) that leaks into
    // extractCatalogProducts as a junk "product". (rdsc.ca repro 2026-06-06: 1347
    // rows incl. `/new-products.html?manufacturer=1590` titled "Zero Tolerance 14item".)
    //
    // This is a DENY-LIST, not "any query string = nav": OpenCart
    // (`?route=product/product&product_id=NN&path=NN`), Volusion
    // (`?ProductCode=XXX`), custom PHP (`?p=slug`), Shopify (`?variant=NN`) and
    // Odoo (`/shop/<slug>?category=NN`) all carry query params on REAL product
    // detail URLs. Each param below was verified to appear on ZERO active product
    // rows across the fleet DB (scripts/_facet-explore-2026-06-06.ts), so denying
    // it cannot drop a legitimate product. NOTE deliberately EXCLUDED: `category`
    // (50 priced Odoo products use `?category=NN`), `path`/`product_id`/`route`/`p`
    // (OpenCart/PHP product params), `page`/`limit`/`limitstart` (pagination),
    // `variant`/`id`/`sku`/`productcode` (product detail), `orderby`/`product_list_order`
    // (price-bearing rows make them ambiguous, and rdsc does not involve them).
    if (/[?&](manufacturer|brand|filter|color|colour|size|dir|cat|sort|order|price|price_min|price_max|min_price|max_price|product_list_dir)=/i.test(url)) return true;
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
    // Bare domain or URL extracted as a "title" — e.g. a footer/share link or a
    // logo-only card whose only text was the shop domain. Real product titles are
    // never just a hostname/URL. (aagcanada.ca repro 2026-05-29: 52 rows titled
    // "www.aagcanada.ca".)
    if (/^(https?:\/\/|www\.)/i.test(t)) return true;
    // Bare host like "aagcanada.ca" / "vortexoptics.com" — require an alphabetic TLD
    // (>=2 letters) so caliber titles ("9.3x62", "5.56x45") are NOT misflagged.
    if (/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*\.[a-z]{2,24}\/?$/i.test(t)) return true;
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
