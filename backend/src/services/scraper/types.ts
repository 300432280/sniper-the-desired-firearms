import type * as cheerio from 'cheerio';

// ── Scraping output types ────────────────────────────────────────────────────

export interface ScrapedMatch {
  title: string;
  price?: number;
  url: string;
  inStock?: boolean;
  thumbnail?: string;
  postDate?: string;
  seller?: string;
}

export interface ScrapeResult {
  matches: ScrapedMatch[];
  contentHash: string;
  scrapedAt: Date;
  loginRequired?: boolean;
  adapterUsed?: string;
  usedPlaywright?: boolean;
  errors?: string[];
  /** Metadata from the fetch (response time, signals) — used by crawler to update site metrics */
  fetchMeta?: {
    responseTimeMs: number;
    statusCode: number;
    signals: { hasWaf: boolean; hasRateLimit: boolean; hasCaptcha: boolean };
    headers: Record<string, any>;
  };
}

// ── Scraping options ─────────────────────────────────────────────────────────

export interface ScrapeOptions {
  inStockOnly?: boolean;
  maxPrice?: number;
  cookies?: string;
  fast?: boolean;
  maxPages?: number;
  /** Site difficulty rating (0-100) — affects request delays and pagination behavior */
  difficultyRating?: number;
}

export type ExtractionOptions = Pick<ScrapeOptions, 'inStockOnly' | 'maxPrice'>;

// ── Site classification ──────────────────────────────────────────────────────

export type SiteType = 'retailer' | 'classifieds' | 'forum' | 'auction' | 'generic';

// ── Catalog product (ProductIndex row) ──────────────────────────────────────

export interface CatalogProduct {
  url: string;
  title: string;
  price?: number;
  stockStatus?: 'in_stock' | 'out_of_stock' | 'unknown';
  thumbnail?: string;
  category?: 'new' | 'used' | 'auction_lot' | 'classified';
  closingAt?: Date;
}

export interface CatalogPage {
  products: CatalogProduct[];
  nextPageUrl?: string;
  /** Total pages estimate (if available from API response headers) */
  totalPages?: number;
}

// ── Adapter interface (Phase 3) ──────────────────────────────────────────────

export interface SiteAdapter {
  /** Human-readable name, e.g. "Shopify", "iCollector" */
  name: string;
  /** The site classification this adapter handles */
  siteType: SiteType;
  /** Build the search URL for a given keyword */
  getSearchUrl(origin: string, keyword: string): string;
  /** Optional: search via JSON API instead of HTML scraping */
  searchViaApi?(origin: string, keyword: string, options: ScrapeOptions): Promise<ScrapedMatch[]>;
  /** Extract matches from a loaded HTML page */
  extractMatches($: cheerio.CheerioAPI, keyword: string, baseUrl: string, options: ExtractionOptions): ScrapedMatch[];
  /** Optional: extract the next page URL for pagination */
  getNextPageUrl?($: cheerio.CheerioAPI, currentUrl: string): string | null;

  // ── Catalog crawl methods (Phase 3) ─────────────────────────────────────

  /** URL for "new arrivals" / "sort by newest" page (Tier 1 watermark crawl) */
  getNewArrivalsUrl?(origin: string): string;
  /** Fetch a catalog page via API (preferred — structured data with prices) */
  fetchCatalogPage?(origin: string, page: number, options?: { sortBy?: 'newest' | 'oldest'; perPage?: number }): Promise<CatalogPage>;
  /** Extract catalog products from an HTML page (fallback when no API available) */
  extractCatalogProducts?($: cheerio.CheerioAPI, baseUrl: string): CatalogProduct[];
}
