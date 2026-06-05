import type * as cheerio from 'cheerio';

// ── Scraping output types ────────────────────────────────────────────────────

export interface ScrapedMatch {
  title: string;
  price?: number;
  regularPrice?: number;     // Original price before discount (for strikethrough)
  url: string;
  sourceId?: string;         // Platform-stable product ID (Shopify ID, WP post ID, Drupal node ID, etc.)
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
  /** Site has WAF (Sucuri/Incapsula/Cloudflare) — use WAF cookies for API calls */
  hasWaf?: boolean;
}

export type ExtractionOptions = Pick<ScrapeOptions, 'inStockOnly' | 'maxPrice'> & {
  /**
   * True when extractMatches is called on a search-results page (e.g. /search?q=rifle).
   * Adapters MUST skip the per-card keyword-text filter when this is true -- the
   * search engine already filtered results; re-filtering by the literal keyword
   * silently drops foreign-language matches ("Carabine" != "rifle") and matches
   * whose card text uses synonyms or model names ("Aridus Remington 870" lacks
   * the word "rifle" but is one).
   */
  isSearchPage?: boolean;
};

// ── Site classification ──────────────────────────────────────────────────────

export type SiteType = 'retailer' | 'classifieds' | 'forum' | 'auction' | 'generic';

// ── Catalog product (ProductIndex row) ──────────────────────────────────────

export interface CatalogProduct {
  url: string;
  sourceId?: string;       // Platform-stable product ID (Shopify ID, WP post ID, Drupal node ID, etc.)
  title: string;
  price?: number;
  regularPrice?: number;     // Original price before discount (for strikethrough)
  stockStatus?: 'in_stock' | 'out_of_stock' | 'unknown';
  thumbnail?: string;
  category?: 'new' | 'used' | 'auction_lot' | 'classified' | 'wanted';
  tags?: string;           // Comma-separated product tags from source
  productType?: string;    // "firearm" | "ammunition" | "optics" | "parts" | "gear" | "knives" | "other"
  sourceCategory?: string; // Raw category from API (Shopify product_type, WooCommerce category names)
  closingAt?: Date;
  postDate?: string;       // Date string from listing (modified/bumped date on classifieds)
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
  /** Cross-tier stale detection: when the most recent completed cycle started */
  lastCycleStartedAt?: string;
  /** Cross-tier stale detection: when the most recent cycle completed */
  lastCycleCompletedAt?: string;
  /** Absolute date range for API streams (ISO strings) */
  dateRangeStart?: string;
  dateRangeEnd?: string;
  status: 'idle' | 'in_progress' | 'cooldown';
  /** Number of full bootstrap passes completed (for coverage retry logic) */
  bootstrapPassCount?: number;
  /** True if bootstrap completed without reaching 95% coverage */
  coverageWarning?: boolean;
  /** ISO string — when this tier was last dispatched to a worker (for round-robin rotation across streams) */
  lastDispatchedAt?: string;
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

// ── SiteProfile field documentation ─────────────────────────────────────────
// SiteProfile is stored as a Prisma JSON column on MonitoredSite.siteProfile
// (schema.prisma:195). There is NO strict TypeScript interface for it — it is
// consumed as `any` throughout the codebase. New fields are documented here
// and backfilled via scripts under backend/scripts/.
//
// Field: sortAxis ─ Optional. The raw API response field that the watermark
// crawler's chosen method sorts AND filters on. The adapter's emitted
// CatalogProduct.postDate MUST equal `rawApiRow[sortAxis]` — if not,
// maintain-readiness walkOk drift and watermark-crawler newestDateSeen
// monotonic advancement both break (see A2 fix at woocommerce.ts:411).
//
// Inference rules (used by backend/scripts/_backfill-sort-axis-2026-05-30.js
// and asserted by runWatermarkWalkCheck in maintain-readiness.ts):
//
//   WooCommerce + api-date-since-watermark → 'modified'
//   WooCommerce + navigate-from-watermark  → 'date'
//   Shopify     + any                      → 'published_at'
//   Ecwid       + any                      → null   (no date field on products)
//   full-catalog-sweep (any platform)      → null   (no sort axis used)
//
// Type: 'modified' | 'date' | 'published_at' | 'addedTimeDesc' | null | undefined
// (`addedTimeDesc` is reserved for any future Ecwid platform that exposes a
// real timestamp field; today no such field is known.)
//
// Field: wcHidesOosInStoreApi ─ Optional. Audit-only flag — TRUE when the
// site's WC admin setting `wc_hide_out_of_stock_items` is on, meaning the
// public Store API silently excludes OOS products from default responses.
// Detected via 3-probe count comparison: if unfiltered_total < instock_only_total
// + outofstock_only_total, the filter is on. Audit-only because the A3 fix at
// worker.ts (around line 451-464) already sends `stock_status[]=instock,outofstock`
// unconditionally, so the runtime is unaffected. This flag exists so the
// operator can see WHICH sites had the issue and decide whether re-bootstrap
// is needed to backfill previously-hidden OOS products.
//
// Only applicable to WC sites. Other platforms: leave undefined.
//
// Inference: written by the pre-bootstrap WC probe stage AND backfilled by the
//   _backfill-wc-hide-oos-2026-05-30.js script.
//
// Type: boolean | null | undefined
//
// Field: deletionMarkers ─ Optional. Per-site deletion-page signatures captured
// during pre-bootstrap by fetching a known-invalid product URL and diffing
// against a known-live URL. Verifier reads these FIRST (per-site precedence),
// falls back to the global hardcoded patterns in product-verifier.ts:227-260.
//
// Captures three lists, each LOWERCASED at capture time so verifier can compare
// against $('h1').first().text().toLowerCase() etc without re-lowering:
//
//   h1Patterns:    array of strings to match against deletion page <h1>
//   titlePatterns: array of strings to match against deletion page <title>
//   bodyPatterns:  array of regex SOURCE strings (no flags — verifier adds 'i')
//                  intended to match deletion-prose in body text
//
// Detection method (pre-bootstrap stage): fetch one live URL + one invalid
// URL (constructed by appending '-this-does-not-exist-99999' to the live URL
// path), diff h1/title/body, retain markers unique to the invalid page.
//
// For sites that return clean HTTP 404 for deleted products: deletionMarkers
// MAY be null (status short-circuit in product-verifier.ts:93 already handles).
//
// Type: { h1Patterns: string[]; titlePatterns: string[]; bodyPatterns: string[] } | null | undefined

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
  fetchCatalogPage?(origin: string, page: number, options?: { sortBy?: 'newest' | 'oldest'; perPage?: number; dateAfter?: string; dateBefore?: string; hasWaf?: boolean }): Promise<CatalogPage | null>;
  /** Whether fetchCatalogPage supports dateAfter/dateBefore filtering. If false, tiers use page ranges instead. */
  supportsDateFilter?: boolean;
  /**
   * Extract catalog products from an HTML page (fallback when no API available).
   * `opts.listingOmitsStock` (default false): when true, a card with NO stock signal
   * (isInStock===undefined) maps to 'unknown' instead of 'out_of_stock'. For sites
   * whose listing cards never expose stock (e.g. gobles.ca, northprosports.com).
   */
  extractCatalogProducts?(
    $: cheerio.CheerioAPI,
    baseUrl: string,
    opts?: { listingOmitsStock?: boolean },
  ): CatalogProduct[];
}
