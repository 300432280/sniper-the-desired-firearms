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
  errors?: string[];
}

// ── Scraping options ─────────────────────────────────────────────────────────

export interface ScrapeOptions {
  inStockOnly?: boolean;
  maxPrice?: number;
  cookies?: string;
  fast?: boolean;
  maxPages?: number;
}

export type ExtractionOptions = Pick<ScrapeOptions, 'inStockOnly' | 'maxPrice'>;

// ── Site classification ──────────────────────────────────────────────────────

export type SiteType = 'retailer' | 'classifieds' | 'forum' | 'auction' | 'generic';

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
}
