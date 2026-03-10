import type * as cheerio from 'cheerio';

// ── Scraping output types ────────────────────────────────────────────────────

export interface ScrapedMatch {
  title: string;
  price?: number;
  regularPrice?: number;     // Original price before discount (for strikethrough)
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
  regularPrice?: number;     // Original price before discount (for strikethrough)
  stockStatus?: 'in_stock' | 'out_of_stock' | 'unknown';
  thumbnail?: string;
  category?: 'new' | 'used' | 'auction_lot' | 'classified';
  tags?: string;           // Comma-separated product tags from source
  productType?: string;    // "firearm" | "ammunition" | "optics" | "parts" | "gear" | "knives" | "other"
  sourceCategory?: string; // Raw category from API (Shopify product_type, WooCommerce category names)
  closingAt?: Date;
}

export interface CatalogPage {
  products: CatalogProduct[];
  nextPageUrl?: string;
  /** Total pages estimate (if available from API response headers) */
  totalPages?: number;
}

// ── Stream types (Per-stream tier structure) ─────────────────────────────────

/** A stream is a paginated product list that can be crawled independently. */
export interface Stream {
  /** Unique ID within the site, e.g. "api", "firearms", "ammunition" */
  id: string;
  /** Base URL for this stream */
  url: string;
  /** Sort parameter to append for newest-first, e.g. "?sort=newest" */
  sortParam?: string;
  /** Estimated total pages from previous crawls */
  totalPages?: number;
  /** Category derived from URL path (for classification + domain priority) */
  category?: string;
  /** How to crawl this stream */
  type: 'api' | 'html';
}

/** Per-stream per-tier state tracking. */
export interface StreamTierState {
  streamId: string;
  tier: 2 | 3 | 4;
  /** Resume page within this tier's range */
  currentPage: number;
  /** Resume URL for HTML pagination mid-page */
  currentPageUrl?: string;
  /** First page this tier owns */
  pageRangeStart: number;
  /** Last page (undefined for T4 = open-ended) */
  pageRangeEnd?: number;
  /** ISO string — when this tier last completed on this stream */
  lastRefreshedAt?: string;
  cycleStartedAt?: string;
  cooldownEndsAt?: string;
  /** Absolute date range for API streams (ISO strings) */
  dateRangeStart?: string;
  dateRangeEnd?: string;
  status: 'idle' | 'in_progress' | 'cooldown';
}

/** Full stream state stored on MonitoredSite (JSON column). */
export interface SiteStreamState {
  /** Detected streams for this site */
  streams: Stream[];
  /** Per-stream per-tier state, keyed by "streamId:tier" e.g. "firearms:2" */
  tiers: Record<string, StreamTierState>;
  /** When streams were last detected */
  detectedAt?: string;
}

/** Priority function: sort streams by crawl priority (highest first). */
export type StreamPriority = (
  streams: Array<Stream & { lastRefreshedAt?: string }>,
) => Array<Stream & { lastRefreshedAt?: string }>;

// ── Adapter interface ────────────────────────────────────────────────────────

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
  /** Multiple fallback URLs for new arrivals (tried in order if primary returns 0 products) */
  getNewArrivalsUrls?(origin: string): string[];
  /**
   * URLs for full catalog crawl (Tiers 2-4 catalog refresh).
   * Returns site-specific category/listing page URLs that cover the full product catalog.
   * Used by the catalog crawler to update prices, stock, thumbnails, and detect removed products.
   * Separate from getNewArrivalsUrls() which targets new-product discovery (Tier 1 watermark).
   */
  getCatalogUrls?(origin: string): string[];
  /** Fetch a catalog page via API (preferred — structured data with prices) */
  fetchCatalogPage?(origin: string, page: number, options?: { sortBy?: 'newest' | 'oldest'; perPage?: number; dateAfter?: string; dateBefore?: string }): Promise<CatalogPage>;
  /** Extract catalog products from an HTML page (fallback when no API available) */
  extractCatalogProducts?($: cheerio.CheerioAPI, baseUrl: string): CatalogProduct[];
}
