/**
 * Catalog Crawler — Tiers 2-4 date-based full catalog refresh.
 *
 * Tier 2 (Recent):  last Tier 1 → 7 days back,  cooldown 5 hours
 * Tier 3 (Aging):   8 → 21 days back,           cooldown 9 hours
 * Tier 4 (Archive): 22+ days back,              cooldown 17 hours
 *
 * Each tier operates in cycles:
 * 1. Start: snapshot date boundaries as absolute dates
 * 2. Run: crawl from most recent to least recent, consuming allocated tokens
 * 3. Continue: if tokens run out, pick up next hour
 * 4. Complete: cooldown timer starts
 * 5. Cooldown: wait for min spacing, then begin next cycle
 */

import { prisma } from '../lib/prisma';
import { getAdapterForUrl, _getSiteCacheEntry } from './scraper/adapter-registry';
import { fetchPageWithMeta, randomDelay } from './scraper/http-client';
import { consumeToken } from './token-budget';
import { matchNewProducts } from './keyword-matcher';
import type { CatalogProduct, Stream, StreamTierState } from './scraper/types';
import { saveProducts } from './product-upsert';
import * as cheerio from 'cheerio';

/** WAF sites require multiple consecutive empty pages before declaring end-of-catalog. */
const MAX_CONSECUTIVE_EMPTY_PAGES = 3;

/**
 * Detect total pages from HTML pagination links on the first page.
 * Looks for common patterns: numbered page links, "last" links, "of N" text.
 */
export function detectTotalPagesFromHtml($: cheerio.CheerioAPI, currentUrl: string): number | undefined {
  let maxPage = 0;

  // Strategy 1: Find numbered page links in pagination containers
  const paginationSelectors = [
    '.pagination a', '.pager a', '.paging a', 'nav.pagination a',
    '[class*="pagination"] a', '[class*="pager"] a',
    'ul.page-numbers a', '.wp-pagenavi a',
    '.paginator a', '.page-item a',
  ];

  for (const sel of paginationSelectors) {
    $(sel).each((_, el) => {
      const text = $(el).text().trim();
      const num = parseInt(text, 10);
      if (num > 0 && num < 100000) maxPage = Math.max(maxPage, num);

      // Also check href for page= or /page/ patterns
      const href = $(el).attr('href') || '';
      const pageMatch = href.match(/[?&]page=(\d+)|\/page\/(\d+)|[?&]p=(\d+)/i);
      if (pageMatch) {
        const p = parseInt(pageMatch[1] || pageMatch[2] || pageMatch[3], 10);
        if (p > 0 && p < 100000) maxPage = Math.max(maxPage, p);
      }
    });
  }

  // Strategy 2: Look for "Page X of Y" or "X / Y" patterns in pagination area
  if (maxPage === 0) {
    const pageText = $('[class*="pagination"], [class*="pager"], .paginator').text();
    const ofMatch = pageText.match(/(?:page\s+\d+\s+of\s+|\/\s*)(\d+)/i);
    if (ofMatch) {
      const p = parseInt(ofMatch[1], 10);
      if (p > 0 && p < 100000) maxPage = p;
    }
  }

  // Strategy 3: "Last" page link
  if (maxPage === 0) {
    $('a[title*="last" i], a[aria-label*="last" i], a.last, .pagination .last a').each((_, el) => {
      const href = $(el).attr('href') || '';
      const pageMatch = href.match(/[?&]page=(\d+)|\/page\/(\d+)|[?&]p=(\d+)/i);
      if (pageMatch) {
        const p = parseInt(pageMatch[1] || pageMatch[2] || pageMatch[3], 10);
        if (p > 0 && p < 100000) maxPage = Math.max(maxPage, p);
      }
    });
  }

  return maxPage > 1 ? maxPage : undefined;
}

export interface PaginationPattern {
  /**
   * 'query'          = ?page=N (default)
   * 'path'           = /page/N suffix
   * 'offset-query'   = ?top=(N-1)*perPage (offset/skip-style, e.g. Activant/iNet)
   * 'suffix-replace' = replace trailing literal (e.g. '.html') with '-{N}.html'
   *                    (CS-Cart legacy PHP, e.g. durhamoutdoors.ca)
   */
  type: 'query' | 'path' | 'offset-query' | 'suffix-replace';
  /**
   * For type='query': param name (default 'page')
   * For type='path': segment template with {N} (default '/page/{N}')
   * For type='offset-query': param name (default 'offset')
   * For type='suffix-replace': replacement template with {N} (default '-{N}.html')
   */
  template?: string;
  /**
   * Required for type='offset-query': items per page used to compute offset = (pageNum-1) * perPage
   */
  perPage?: number;
  /**
   * For type='suffix-replace': the literal suffix to match and replace
   * (e.g. '.html'). Default: '.html'.
   */
  match?: string;
}

/**
 * Construct a paginated URL from a base URL and a page number.
 * Default behavior is query-style (`?page=N`). When `pattern.type === 'path'`,
 * a path segment (default `/page/{N}`) is appended instead — required for sites
 * like Celerant ColdFusion that silently ignore query-style pagination.
 * Returns the base URL unchanged if pageNum <= 1.
 */
export function buildPaginatedUrl(baseUrl: string, pageNum: number, pattern?: PaginationPattern): string {
  if (pageNum <= 1) return baseUrl;

  if (pattern?.type === 'path') {
    const template = pattern.template || '/page/{N}';
    const stripped = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    return `${stripped}${template.replace('{N}', String(pageNum))}`;
  }

  if (pattern?.type === 'suffix-replace') {
    const match = pattern.match || '.html';
    const template = pattern.template || '-{N}.html';
    if (!baseUrl.endsWith(match)) {
      // Fall back: append template as-is
      return baseUrl + template.replace('{N}', String(pageNum));
    }
    const withoutSuffix = baseUrl.slice(0, baseUrl.length - match.length);
    return withoutSuffix + template.replace('{N}', String(pageNum));
  }

  if (pattern?.type === 'offset-query') {
    const paramName = pattern.template || 'offset';
    if (!pattern.perPage) {
      console.warn(`[buildPaginatedUrl] offset-query pattern missing perPage; falling back to query type for ${baseUrl}`);
      const sep = baseUrl.includes('?') ? '&' : '?';
      return `${baseUrl}${sep}${paramName}=${pageNum}`;
    }
    const offset = (pageNum - 1) * pattern.perPage;
    // Use string concatenation to preserve literal characters like `|` which
    // the URL constructor would percent-encode.
    const sep = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${sep}${paramName}=${offset}`;
  }

  const paramName = pattern?.template || 'page';
  try {
    const url = new URL(baseUrl);
    url.searchParams.set(paramName, String(pageNum));
    return url.toString();
  } catch {
    // Fallback for malformed URLs: simple string manipulation
    const re = new RegExp(`([?&])${paramName}=\\d+`);
    if (re.test(baseUrl)) {
      return baseUrl.replace(re, `$1${paramName}=${pageNum}`);
    }
    const sep = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${sep}${paramName}=${pageNum}`;
  }
}

// ── Tier Configuration ──────────────────────────────────────────────────────

interface TierConfig {
  tier: 2 | 3 | 4;
  /** Days back from "now" for the end of the date range */
  daysBackEnd: number;
  /** Days back from "now" for the start of the date range (null = unlimited) */
  daysBackStart: number | null;
  /** Minimum hours between cycle starts */
  cooldownHours: number;
}

const TIER_CONFIGS: TierConfig[] = [
  { tier: 2, daysBackEnd: 0, daysBackStart: 7, cooldownHours: 5 },
  { tier: 3, daysBackEnd: 8, daysBackStart: 21, cooldownHours: 9 },
  { tier: 4, daysBackEnd: 22, daysBackStart: null, cooldownHours: 17 },
];

// ── Tier State ──────────────────────────────────────────────────────────────

export interface TierCycleState {
  status: 'idle' | 'in_progress' | 'cooldown';
  /** Absolute date range snapshot (ISO strings) */
  dateRangeStart?: string;
  dateRangeEnd?: string;
  /** Current page in the catalog crawl (API-based path) */
  currentPage: number;
  /** Current URL index in the catalog URL list (HTML-based path, for resume) */
  currentUrlIndex?: number;
  /** Resume URL within current catalog URL when tokens ran out mid-pagination */
  currentPageUrl?: string;
  /** When this cycle started */
  cycleStartedAt?: string;
  /** When cooldown ends (cycle can restart) */
  cooldownEndsAt?: string;
  /**
   * Consecutive completed API cycles that returned 0 products.
   * After 3 consecutive empty cycles, force HTML fallback (Mistake 34 fix).
   */
  consecutiveEmptyApiCycles?: number;
}

export interface TierState {
  tier2: TierCycleState;
  tier3: TierCycleState;
  tier4: TierCycleState;
}

const DEFAULT_TIER_CYCLE: TierCycleState = {
  status: 'idle',
  currentPage: 0,
};

export function parseTierState(json: any): TierState {
  if (typeof json === 'string') {
    try { json = JSON.parse(json); } catch { json = {}; }
  }
  return {
    tier2: { ...DEFAULT_TIER_CYCLE, ...(json?.tier2 || {}) },
    tier3: { ...DEFAULT_TIER_CYCLE, ...(json?.tier3 || {}) },
    tier4: { ...DEFAULT_TIER_CYCLE, ...(json?.tier4 || {}) },
  };
}

// ── Catalog Crawl Execution ─────────────────────────────────────────────────

interface CatalogCrawlResult {
  tier: 2 | 3 | 4;
  status: 'success' | 'fail' | 'partial';
  productsFound: number;
  pagesScanned: number;
  tokensUsed: number;
  cycleComplete: boolean;
  errorMessage?: string;
}

/**
 * Run catalog crawl for a specific tier on a site.
 * Consumes allocated tokens, saves products to ProductIndex,
 * updates tier state.
 */
export async function crawlCatalogTier(params: {
  siteId: string;
  url: string;
  domain: string;
  tier: 2 | 3 | 4;
  tierState: TierCycleState;
  tokensAllocated: number;
  baseBudget: number;
  capacity: number;
  hasWaf?: boolean;
}): Promise<CatalogCrawlResult> {
  const { siteId, url, domain, tier, tierState, tokensAllocated } = params;
  const { adapter } = await getAdapterForUrl(url);
  const origin = new URL(url).origin;

  // siteProfile is the source of truth for per-site config. Read perPage from it;
  // fall back to the historical WAF/non-WAF defaults only when the profile is missing the field.
  const profileEntry = _getSiteCacheEntry(domain.replace(/^www\./, ''));
  const profilePerPage: number | undefined = profileEntry?.siteProfile?.perPage ?? undefined;

  let pagesScanned = 0;
  let tokensUsed = 0;
  let productsFound = 0;
  let cycleComplete = false;
  const allProducts: CatalogProduct[] = [];

  try {
    // API-based catalog crawl (preferred — Shopify, WooCommerce, iCollector)
    // fetchCatalogPage returns null when the adapter doesn't support API crawl for this site
    // (e.g. GenericRetail without Klevu API key). In that case, fall through to HTML extraction.
    let apiCrawlUsed = false;
    if (adapter.fetchCatalogPage) {
      let page = tierState.currentPage || 1;
      let consecutiveEmptyApi = 0;

      while (tokensUsed < tokensAllocated) {
        consumeToken(siteId, tier);
        tokensUsed++;

        const catalogPage = await adapter.fetchCatalogPage(origin, page, {
          sortBy: 'newest',
          perPage: profilePerPage || (params.hasWaf ? 20 : 50),
          dateAfter: tierState.dateRangeStart || undefined,
          dateBefore: tierState.dateRangeEnd || undefined,
          hasWaf: params.hasWaf,
        });

        // null = adapter doesn't support API crawl for this site, fall through to HTML
        if (catalogPage === null) {
          // Refund the token we consumed for this failed probe
          tokensUsed--;
          break;
        }
        apiCrawlUsed = true;
        pagesScanned++;

        if (catalogPage.products.length === 0) {
          if (params.hasWaf) {
            consecutiveEmptyApi++;
            console.log(`[CatalogCrawl] ${params.domain} T${tier}: empty API page ${page} (WAF site, consecutive=${consecutiveEmptyApi}/${MAX_CONSECUTIVE_EMPTY_PAGES})`);
            if (consecutiveEmptyApi >= MAX_CONSECUTIVE_EMPTY_PAGES) {
              cycleComplete = true;
              break;
            }
            page++;
            await randomDelay(1000, 2000);
            continue;
          }
          cycleComplete = true;
          break;
        }
        consecutiveEmptyApi = 0;

        allProducts.push(...catalogPage.products);
        productsFound += catalogPage.products.length;

        if (!catalogPage.nextPageUrl && (!catalogPage.totalPages || page >= catalogPage.totalPages)) {
          cycleComplete = true;
          break;
        }

        page++;
        await randomDelay(300, 800);
      }
    }

    // ── Mistake 34 fix: detect permanently broken API returning 0 products ──
    // When an API returns { products: [], totalPages: undefined } (e.g. WooCommerce 401),
    // apiCrawlUsed is true but productsFound is 0. After 3 consecutive such cycles,
    // force the HTML fallback path so the site doesn't silently crawl 0 products forever.
    if (apiCrawlUsed && productsFound === 0 && pagesScanned > 0) {
      const prev = tierState.consecutiveEmptyApiCycles ?? 0;
      tierState.consecutiveEmptyApiCycles = prev + 1;
      console.log(`[CatalogCrawl] ${params.domain} T${tier}: API returned 0 products (consecutive empty cycles: ${tierState.consecutiveEmptyApiCycles}/3)`);
      if (tierState.consecutiveEmptyApiCycles >= 3) {
        console.warn(`[CatalogCrawl] ${params.domain} T${tier}: API has returned 0 products for 3 consecutive cycles — forcing HTML fallback`);
        apiCrawlUsed = false;
        cycleComplete = false;
        pagesScanned = 0;
        // Keep the counter so it persists; it resets when products are found
      }
    } else if (apiCrawlUsed && productsFound > 0) {
      // API is healthy — reset the counter
      tierState.consecutiveEmptyApiCycles = 0;
    }

    // HTML-based catalog crawl — uses adapter's catalog URLs with pagination
    // (BigCommerce, Magento, custom PHP, etc.)
    // Also used when fetchCatalogPage returns null (API not supported for this site).
    if (!apiCrawlUsed && adapter.extractCatalogProducts) {
      // Get catalog URLs from adapter — prefer getCatalogUrls() (designed for full catalog refresh),
      // fall back to getNewArrivalsUrls() (watermark URLs also work for catalog), then generic /shop/
      const rawUrls: string[] = [];
      if (adapter.getCatalogUrls) {
        rawUrls.push(...adapter.getCatalogUrls(origin));
      } else if (adapter.getNewArrivalsUrls) {
        rawUrls.push(...adapter.getNewArrivalsUrls(origin));
      } else if (adapter.getNewArrivalsUrl) {
        rawUrls.push(adapter.getNewArrivalsUrl(origin));
      } else {
        rawUrls.push(`${origin}/shop/`);
      }
      const catalogUrls = [...new Set(rawUrls)];

      // Resume from tracked URL index (persisted across ticks for partial cycles)
      let urlIdx = tierState.currentUrlIndex ?? 0;

      let consecutiveEmptyHtml = 0;

      while (urlIdx < catalogUrls.length && tokensUsed < tokensAllocated) {
        // Resume from saved page URL if tokens ran out mid-pagination last tick
        let currentUrl: string | null = tierState.currentPageUrl ?? catalogUrls[urlIdx];
        tierState.currentPageUrl = undefined; // Clear after resuming

        while (currentUrl && tokensUsed < tokensAllocated) {
          consumeToken(siteId, tier);
          tokensUsed++;

          let html = '';

          // For WAF sites (e.g. alflahertys), use Playwright directly
          if (params.hasWaf) {
            try {
              const { fetchWithPlaywright } = await import('./scraper/playwright-fetcher');
              const pwResult = await fetchWithPlaywright(currentUrl, { timeout: 45000 });
              html = pwResult.html;
            } catch {
              // Retry once after 3s delay
              console.log(`[CatalogCrawl] ${params.domain} T${tier}: Playwright failed for ${currentUrl}, retrying in 3s...`);
              await new Promise(r => setTimeout(r, 3000));
              try {
                const { fetchWithPlaywright } = await import('./scraper/playwright-fetcher');
                const pwResult = await fetchWithPlaywright(currentUrl, { timeout: 45000 });
                html = pwResult.html;
              } catch {
                console.log(`[CatalogCrawl] ${params.domain} T${tier}: Playwright retry failed for ${currentUrl}, skipping page`);
                // Skip this page, continue to next page via getNextPageUrl or next catalog URL
                break;
              }
            }
          } else {
            try {
              const fetchResult = await fetchPageWithMeta(currentUrl, undefined, { difficultyRating: 0 });
              html = fetchResult.html;
            } catch {
              break; // Fetch failed, try next URL
            }

            // Playwright fallback if static HTML looks blocked/empty.
            // Markers: Incapsula, generic 403, Cloudflare active challenge,
            // Cloudflare "Just a moment" interstitial, and Imunify360
            // "One moment, please" interstitial (added 2026-05-25 after
            // kodiakdefence.com walked page 1 successfully via cached
            // Playwright cookies but page 2 returned the Imunify360 challenge
            // body, 4744 bytes -- above the 2000-byte threshold and contains
            // none of the previously-listed markers, so the walker treated it
            // as end-of-catalog instead of falling through to Playwright).
            const isBlocked = html.length < 2000 ||
              /Incapsula|Access Denied|403 Forbidden|challenge-platform|Just a moment|One moment, please/i.test(html);
            if (isBlocked && html.length > 0) {
              try {
                const { fetchWithPlaywright } = await import('./scraper/playwright-fetcher');
                const pwResult = await fetchWithPlaywright(currentUrl, { timeout: 30000 });
                html = pwResult.html;
              } catch { /* continue with what we have */ }
            }
          }

          const $ = cheerio.load(html);
          pagesScanned++;

          let products = adapter.extractCatalogProducts($, currentUrl);

          // Playwright fallback: large HTML but 0 products (SPA/AJAX-loaded content)
          if (products.length === 0 && !params.hasWaf && html.length > 5000) {
            try {
              const { fetchWithPlaywright } = await import('./scraper/playwright-fetcher');
              const pwResult = await fetchWithPlaywright(currentUrl, { timeout: 30000 });
              if (pwResult.html.length > html.length) {
                const $pw = cheerio.load(pwResult.html);
                products = adapter.extractCatalogProducts($pw, currentUrl);
              }
            } catch { /* continue */ }
          }

          // WAF sites: 0 products might be Cloudflare block, not end-of-catalog
          if (products.length === 0 && params.hasWaf && html.length > 2000) {
            // Got HTML but no products — could be a Cloudflare challenge page. Retry with Playwright.
            console.log(`[CatalogCrawl] ${params.domain} T${tier}: 0 products but ${html.length} bytes HTML (WAF), retrying with Playwright...`);
            try {
              const { fetchWithPlaywright } = await import('./scraper/playwright-fetcher');
              const pwResult = await fetchWithPlaywright(currentUrl, { timeout: 45000 });
              const $pw = cheerio.load(pwResult.html);
              products = adapter.extractCatalogProducts($pw, currentUrl);
            } catch { /* still 0 products */ }
          }

          if (products.length === 0) {
            if (params.hasWaf) {
              consecutiveEmptyHtml++;
              console.log(`[CatalogCrawl] ${params.domain} T${tier}: 0 products on ${currentUrl} (WAF, consecutive=${consecutiveEmptyHtml}/${MAX_CONSECUTIVE_EMPTY_PAGES})`);
              if (consecutiveEmptyHtml >= MAX_CONSECUTIVE_EMPTY_PAGES) break; // consecutive empty = real end
              // Try next page instead of breaking
              const skipNextUrl: string | null = adapter.getNextPageUrl?.($, currentUrl) ?? null;
              if (skipNextUrl) {
                currentUrl = skipNextUrl;
                await randomDelay(1000, 2000);
                continue;
              }
            }
            break; // Non-WAF or no next page: 0 products = end
          }
          consecutiveEmptyHtml = 0; // Reset on success

          allProducts.push(...products);
          productsFound += products.length;

          // Check for next page (BigCommerce: ?page=N, Magento: ?p=N, etc.)
          const nextUrl: string | null = adapter.getNextPageUrl?.($, currentUrl) ?? null;
          if (!nextUrl) break;
          currentUrl = nextUrl;

          await randomDelay(300, 800);
        }

        // Only advance to next URL if inner loop finished naturally (not token exhaustion)
        if (tokensUsed < tokensAllocated) {
          urlIdx++;
        } else if (currentUrl) {
          // Tokens ran out mid-pagination — save the next page URL for resume
          tierState.currentPageUrl = currentUrl;
        }
      }

      // Persist URL position for resume on next tick
      tierState.currentUrlIndex = urlIdx;

      if (urlIdx >= catalogUrls.length) {
        cycleComplete = true;
      }
    } else {
      // No catalog crawl method available
      cycleComplete = true;
    }

    // Save products to ProductIndex
    const savedProducts = await saveProducts(siteId, allProducts);

    // Run keyword matcher on newly discovered products
    if (savedProducts.length > 0) {
      await matchNewProducts(savedProducts);
    }

    return {
      tier,
      status: cycleComplete ? 'success' : 'partial',
      productsFound,
      pagesScanned,
      tokensUsed,
      cycleComplete,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return {
      tier,
      status: 'fail',
      productsFound,
      pagesScanned,
      tokensUsed,
      cycleComplete: false,
      errorMessage: msg,
    };
  }
}

// ── Tier Scheduling Logic ───────────────────────────────────────────────────

/**
 * Determine which catalog tiers should run this hour for a site.
 * Called by the scheduler tick. Accepts optional per-site cooldown overrides.
 */
export function getActiveTiers(tierState: TierState): { tier2: boolean; tier3: boolean; tier4: boolean } {
  const now = new Date();
  return {
    tier2: isTierActive(tierState.tier2, TIER_CONFIGS[0], now),
    tier3: isTierActive(tierState.tier3, TIER_CONFIGS[1], now),
    tier4: isTierActive(tierState.tier4, TIER_CONFIGS[2], now),
  };
}

function isTierActive(cycle: TierCycleState, config: TierConfig, now: Date): boolean {
  if (cycle.status === 'in_progress') return true;

  if (cycle.status === 'cooldown' && cycle.cooldownEndsAt) {
    return new Date(cycle.cooldownEndsAt) <= now;
  }

  // Idle — ready to start
  return true;
}

/**
 * Start a new cycle for a tier: snapshot date boundaries.
 */
export function startTierCycle(tier: 2 | 3 | 4): TierCycleState {
  const config = TIER_CONFIGS.find(c => c.tier === tier)!;
  const now = new Date();

  const dateRangeEnd = new Date(now);
  dateRangeEnd.setDate(dateRangeEnd.getDate() - config.daysBackEnd);

  const dateRangeStart = config.daysBackStart != null
    ? new Date(now.getTime() - config.daysBackStart * 24 * 60 * 60 * 1000)
    : undefined;

  return {
    status: 'in_progress',
    dateRangeStart: dateRangeStart?.toISOString(),
    dateRangeEnd: dateRangeEnd.toISOString(),
    currentPage: 1,
    cycleStartedAt: now.toISOString(),
  };
}

/**
 * Transition a tier to cooldown after cycle completes.
 * Accepts optional per-site cooldown override (hours). Falls back to TIER_CONFIGS default.
 */
export function completeTierCycle(tier: 2 | 3 | 4, cycleState: TierCycleState, cooldownHoursOverride?: number): TierCycleState {
  const config = TIER_CONFIGS.find(c => c.tier === tier)!;
  const cooldownHours = cooldownHoursOverride ?? config.cooldownHours;
  const cycleStart = cycleState.cycleStartedAt ? new Date(cycleState.cycleStartedAt) : new Date();
  const cooldownEnd = new Date(cycleStart.getTime() + cooldownHours * 60 * 60 * 1000);

  // Preserve consecutive empty API cycle counter across cycle boundaries (Mistake 34 fix)
  const consecutiveEmptyApiCycles = cycleState.consecutiveEmptyApiCycles;

  // If cycle took longer than cooldown, start next cycle immediately
  if (cooldownEnd <= new Date()) {
    return { ...DEFAULT_TIER_CYCLE, status: 'idle', consecutiveEmptyApiCycles };
  }

  return {
    status: 'cooldown',
    currentPage: 0,
    cooldownEndsAt: cooldownEnd.toISOString(),
    cycleStartedAt: cycleState.cycleStartedAt,
    consecutiveEmptyApiCycles,
  };
}

/**
 * Update tier state after a crawl run (persist current page position).
 */
export function updateTierProgress(
  tierState: TierCycleState,
  pagesScanned: number,
  cycleComplete: boolean,
  tier: 2 | 3 | 4,
  cooldownHoursOverride?: number,
): TierCycleState {
  if (cycleComplete) {
    return completeTierCycle(tier, tierState, cooldownHoursOverride);
  }

  return {
    ...tierState,
    currentPage: tierState.currentPage + pagesScanned,
  };
}

// ── Stream-Based Catalog Crawl (Phase 2) ────────────────────────────────────

interface StreamCrawlResult {
  streamId: string;
  tier: 2 | 3 | 4;
  status: 'success' | 'fail' | 'partial' | 'skip';
  productsFound: number;
  pagesScanned: number;
  tokensUsed: number;
  cycleComplete: boolean;
  /** Total pages discovered (for updating stream page ranges) */
  totalPagesDiscovered?: number;
  errorMessage?: string;
}

/**
 * Crawl a single stream for a specific tier.
 * API streams use date-range filtering. HTML streams use page-range division.
 */
export async function crawlStreamTier(params: {
  siteId: string;
  url: string;
  domain: string;
  stream: Stream;
  tier: 2 | 3 | 4;
  tierState: StreamTierState;
  tokensAllocated: number;
  hasWaf?: boolean;
  perPage?: number; // From site profile — overrides default (WAF: 20, normal: 50)
  paginationPattern?: PaginationPattern; // From site profile — for path-style pagination
}): Promise<StreamCrawlResult> {
  const { siteId, url, stream, tier, tierState, tokensAllocated } = params;
  const { adapter } = await getAdapterForUrl(url);
  const origin = new URL(url).origin;

  let pagesScanned = 0;
  let tokensUsed = 0;
  let productsFound = 0;
  let cycleComplete = false;
  let totalPagesDiscovered: number | undefined;
  const allProducts: CatalogProduct[] = [];

  try {
    if (adapter.fetchCatalogPage && stream.type === 'api') {
      // ── API-based fetch: structured JSON with prices/stock (only for 'api' streams)
      // 'api' type streams use date ranges for tier partitioning (WooCommerce)
      // 'html' type API streams use page ranges for tier partitioning (Shopify — no date filter support)
      const useDateRanges = stream.type === 'api';
      let page = tierState.currentPage || tierState.pageRangeStart || 1;
      const pageRangeEnd = tierState.pageRangeEnd;
      let consecutiveEmptyStreamApi = 0;

      while (tokensUsed < tokensAllocated) {
        // Stop if we've exceeded this tier's page range (page-partitioned APIs only)
        if (!useDateRanges && pageRangeEnd != null && page > pageRangeEnd) {
          cycleComplete = true;
          break;
        }

        consumeToken(siteId, tier);
        tokensUsed++;

        const catalogPage = await adapter.fetchCatalogPage(origin, page, {
          sortBy: 'newest',
          perPage: params.perPage || (params.hasWaf ? 20 : 50),
          dateAfter: useDateRanges ? (tierState.dateRangeStart || undefined) : undefined,
          dateBefore: useDateRanges ? (tierState.dateRangeEnd || undefined) : undefined,
          hasWaf: params.hasWaf,
        });
        // null = adapter doesn't support API crawl (shouldn't happen for 'api' streams, but guard anyway)
        if (catalogPage === null) {
          tokensUsed--;
          break;
        }
        pagesScanned++;

        if (catalogPage.totalPages) totalPagesDiscovered = catalogPage.totalPages;

        if (catalogPage.products.length === 0) {
          // If we know totalPages and haven't reached it, an empty page is likely
          // a transient error (WAF timeout, cookie expiry) — stop but resume later.
          if (totalPagesDiscovered && page < totalPagesDiscovered) {
            console.log(`[CatalogCrawl] Stream "${stream.id}" T${tier}: empty page ${page} but totalPages=${totalPagesDiscovered} — will resume`);
            break;
          }
          // WAF sites: require 3 consecutive empty pages before declaring end-of-catalog
          if (params.hasWaf) {
            consecutiveEmptyStreamApi++;
            console.log(`[CatalogCrawl] Stream "${stream.id}" T${tier}: empty API page ${page} (WAF, consecutive=${consecutiveEmptyStreamApi}/${MAX_CONSECUTIVE_EMPTY_PAGES})`);
            if (consecutiveEmptyStreamApi >= MAX_CONSECUTIVE_EMPTY_PAGES) {
              cycleComplete = true;
              break;
            }
            page++;
            await randomDelay(1000, 2000);
            continue;
          }
          cycleComplete = true;
          break;
        }
        consecutiveEmptyStreamApi = 0;

        allProducts.push(...catalogPage.products);
        productsFound += catalogPage.products.length;

        if (!catalogPage.nextPageUrl && (!catalogPage.totalPages || page >= catalogPage.totalPages)) {
          cycleComplete = true;
          break;
        }

        page++;
        await randomDelay(300, 800);
      }

      // Update resume position
      tierState.currentPage = page;

    } else if (stream.type === 'html' && adapter.extractCatalogProducts) {
      // ── HTML stream: crawl one URL with page-range boundaries
      // Skip to pageRangeStart if resuming from beginning
      let currentPageNum = tierState.currentPage || tierState.pageRangeStart || 1;

      // If we have a saved URL, use it. Otherwise construct the correct paginated URL
      // so that resuming at currentPage > 1 doesn't accidentally fetch page 1.
      let currentUrl: string | null = tierState.currentPageUrl
        ?? buildPaginatedUrl(stream.url, currentPageNum, params.paginationPattern);
      tierState.currentPageUrl = undefined;
      const pageRangeEnd = tierState.pageRangeEnd;
      let consecutiveEmptyStreamHtml = 0;

      while (currentUrl && tokensUsed < tokensAllocated) {
        // Stop if we've exceeded this tier's page range
        if (pageRangeEnd != null && currentPageNum > pageRangeEnd) {
          cycleComplete = true;
          break;
        }

        consumeToken(siteId, tier);
        tokensUsed++;

        let html = '';

        if (params.hasWaf) {
          try {
            const { fetchWithPlaywright } = await import('./scraper/playwright-fetcher');
            const pwResult = await fetchWithPlaywright(currentUrl, { timeout: 45000 });
            html = pwResult.html;
          } catch {
            // Retry once after 3s delay
            console.log(`[CatalogCrawl] Stream "${stream.id}" T${tier}: Playwright failed for ${currentUrl}, retrying in 3s...`);
            await new Promise(r => setTimeout(r, 3000));
            try {
              const { fetchWithPlaywright } = await import('./scraper/playwright-fetcher');
              const pwResult = await fetchWithPlaywright(currentUrl, { timeout: 45000 });
              html = pwResult.html;
            } catch {
              console.log(`[CatalogCrawl] Stream "${stream.id}" T${tier}: Playwright retry failed for ${currentUrl}, skipping page`);
              // Skip this page, try next via getNextPageUrl
              const skipUrl: string | null = adapter.getNextPageUrl?.(cheerio.load(''), currentUrl) ?? null;
              if (skipUrl) {
                currentUrl = skipUrl;
                currentPageNum++;
                continue;
              }
              break;
            }
          }
        } else {
          try {
            const fetchResult = await fetchPageWithMeta(currentUrl, undefined, { difficultyRating: 0 });
            html = fetchResult.html;
          } catch {
            break;
          }

          const isBlocked = html.length < 2000 ||
            /Incapsula|Access Denied|403 Forbidden|challenge-platform|Just a moment/i.test(html);
          if (isBlocked && html.length > 0) {
            try {
              const { fetchWithPlaywright } = await import('./scraper/playwright-fetcher');
              const pwResult = await fetchWithPlaywright(currentUrl, { timeout: 30000 });
              html = pwResult.html;
            } catch { /* continue with what we have */ }
          }
        }

        const $ = cheerio.load(html);
        pagesScanned++;

        // On the first page, try to detect total pages from pagination HTML
        if (pagesScanned === 1 && !totalPagesDiscovered) {
          const detected = detectTotalPagesFromHtml($, currentUrl);
          if (detected) totalPagesDiscovered = detected;
        }

        let products = adapter.extractCatalogProducts($, currentUrl);

        if (products.length === 0 && !params.hasWaf && html.length > 5000) {
          try {
            const { fetchWithPlaywright } = await import('./scraper/playwright-fetcher');
            const pwResult = await fetchWithPlaywright(currentUrl, { timeout: 30000 });
            if (pwResult.html.length > html.length) {
              const $pw = cheerio.load(pwResult.html);
              products = adapter.extractCatalogProducts($pw, currentUrl);
            }
          } catch { /* continue */ }
        }

        // WAF sites: 0 products might be Cloudflare block, not end-of-catalog
        if (products.length === 0 && params.hasWaf && html.length > 2000) {
          console.log(`[CatalogCrawl] Stream "${stream.id}" T${tier}: 0 products but ${html.length} bytes HTML (WAF), retrying with Playwright...`);
          try {
            const { fetchWithPlaywright } = await import('./scraper/playwright-fetcher');
            const pwResult = await fetchWithPlaywright(currentUrl, { timeout: 45000 });
            const $pw = cheerio.load(pwResult.html);
            products = adapter.extractCatalogProducts($pw, currentUrl);
          } catch { /* still 0 products */ }
        }

        if (products.length === 0) {
          if (params.hasWaf) {
            consecutiveEmptyStreamHtml++;
            console.log(`[CatalogCrawl] Stream "${stream.id}" T${tier}: 0 products on page ${currentPageNum} (WAF, consecutive=${consecutiveEmptyStreamHtml}/${MAX_CONSECUTIVE_EMPTY_PAGES})`);
            if (consecutiveEmptyStreamHtml >= MAX_CONSECUTIVE_EMPTY_PAGES) {
              cycleComplete = true;
              break;
            }
            // Try next page instead of declaring end
            const skipNextUrl: string | null = adapter.getNextPageUrl?.($, currentUrl) ?? null;
            if (skipNextUrl) {
              currentUrl = skipNextUrl;
              currentPageNum++;
              await randomDelay(1000, 2000);
              continue;
            }
          }
          // Non-WAF or no next page: end of this stream's pages
          cycleComplete = true;
          break;
        }
        consecutiveEmptyStreamHtml = 0;

        allProducts.push(...products);
        productsFound += products.length;

        // Try the adapter's next-page selector first; fall back to the profile's
        // paginationPattern if the selector misses (theme-specific markup).
        // Without this fallback, themes like dt-the7 (kodiakdefence) -- which
        // use custom pagination markup not matched by .woocommerce-pagination
        // -- would have the walker stop after page 1, treating "selector
        // returned null" as "end of catalog" when actually it just means
        // "this theme's pagination doesn't look like the canonical WC theme".
        // Termination still works: when the constructed URL returns 0 products,
        // the 0-products branch above (line ~860) marks cycleComplete=true.
        let nextUrl: string | null = adapter.getNextPageUrl?.($, currentUrl) ?? null;
        if (!nextUrl && params.paginationPattern) {
          nextUrl = buildPaginatedUrl(stream.url, currentPageNum + 1, params.paginationPattern);
        }
        if (!nextUrl) {
          // No next page = we've discovered total pages for this stream
          totalPagesDiscovered = currentPageNum;
          cycleComplete = true;
          break;
        }

        currentUrl = nextUrl;
        currentPageNum++;
        await randomDelay(300, 800);
      }

      // Save resume position
      if (!cycleComplete && currentUrl) {
        tierState.currentPage = currentPageNum;
        tierState.currentPageUrl = currentUrl;
      } else {
        tierState.currentPage = currentPageNum;
      }
    } else {
      cycleComplete = true;
    }

    // If we broke out of the loop without scanning ANY pages (fetch error on first attempt),
    // skip ahead by 1 page so we don't get stuck retrying the same blocked page forever.
    // This is the root cause of the "stuck tier" problem — Cloudflare/WAF blocks one page,
    // the tier persists in_progress at the same page number, and repeats every job.
    if (pagesScanned === 0 && !cycleComplete) {
      const nextPage = (tierState.currentPage || 1) + 1;
      const pageEnd = tierState.pageRangeEnd;
      if (pageEnd != null && nextPage > pageEnd) {
        cycleComplete = true;
      } else {
        tierState.currentPage = nextPage;
        // Construct the correct URL for the skipped-to page so the next
        // invocation doesn't fall back to page 1 from stream.url.
        tierState.currentPageUrl = stream.type === 'html'
          ? buildPaginatedUrl(stream.url, nextPage, params.paginationPattern)
          : undefined;
        console.log(`[CatalogCrawl] Stream "${stream.id}" T${tier}: fetch failed on page ${nextPage - 1}, skipping to page ${nextPage}`);
      }
    }

    // Tag products with stream category if they don't already have tags.
    // This ensures products from category-specific streams (e.g. /firearms, /ammunition)
    // get tagged even if the adapter couldn't derive a tag from the HTML.
    if (stream.category) {
      for (const p of allProducts) {
        if (!p.tags) p.tags = stream.category;
      }
    }

    // Save products to ProductIndex
    const savedProducts = await saveProducts(siteId, allProducts);
    if (savedProducts.length > 0) {
      await matchNewProducts(savedProducts);
    }

    return {
      streamId: stream.id,
      tier,
      status: cycleComplete ? 'success' : (pagesScanned === 0 ? 'skip' : 'partial'),
      productsFound,
      pagesScanned,
      tokensUsed,
      cycleComplete,
      totalPagesDiscovered,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    // If we scanned some pages before failing, currentPage was already advanced
    // in the loop. If we failed on the very first page attempt:
    // - For timeouts/network errors: DON'T skip ahead — the whole server is likely
    //   down, and skipping just wastes tokens on the next page which will also fail.
    // - For page-specific errors (403, WAF block): skip ahead by 1 to avoid retrying
    //   the same blocked page forever.
    const isServerWideError = /timeout|ECONNREFUSED|ENOTFOUND|ECONNRESET|socket hang up/i.test(msg);
    if (pagesScanned === 0 && !cycleComplete && !isServerWideError) {
      tierState.currentPage = (tierState.currentPage || 1) + 1;
      console.log(`[CatalogCrawl] Stream "${stream.id}" T${tier}: page-specific error on page ${tierState.currentPage - 1}, will skip to page ${tierState.currentPage} on retry: ${msg.substring(0, 80)}`);
    } else if (pagesScanned === 0 && isServerWideError) {
      console.log(`[CatalogCrawl] Stream "${stream.id}" T${tier}: server error on page ${tierState.currentPage}, will retry same page: ${msg.substring(0, 80)}`);
    }
    return {
      streamId: stream.id,
      tier,
      status: 'fail',
      productsFound,
      pagesScanned,
      tokensUsed,
      cycleComplete: false,
      errorMessage: msg,
    };
  }
}

/**
 * Check if a stream tier is active (ready to run or in progress).
 */
export function isStreamTierActive(state: StreamTierState, now: Date = new Date()): boolean {
  if (state.status === 'in_progress') return true;
  if (state.status === 'cooldown' && state.cooldownEndsAt) {
    return new Date(state.cooldownEndsAt) <= now;
  }
  return true; // idle = ready
}

/**
 * Start a new cycle for a stream tier.
 * API streams snapshot date boundaries. HTML streams use page ranges.
 */
export function startStreamTierCycle(
  stream: Stream,
  tier: 2 | 3 | 4,
  existing: StreamTierState,
): StreamTierState {
  const config = TIER_CONFIGS.find(c => c.tier === tier)!;
  const now = new Date();

  if (stream.type === 'api') {
    // API streams use date ranges
    const dateRangeEnd = new Date(now);
    dateRangeEnd.setDate(dateRangeEnd.getDate() - config.daysBackEnd);
    const dateRangeStart = config.daysBackStart != null
      ? new Date(now.getTime() - config.daysBackStart * 24 * 60 * 60 * 1000)
      : undefined;

    return {
      ...existing,
      status: 'in_progress',
      currentPage: 1,
      currentPageUrl: undefined,
      dateRangeStart: dateRangeStart?.toISOString(),
      dateRangeEnd: dateRangeEnd.toISOString(),
      cycleStartedAt: now.toISOString(),
    };
  }

  // HTML streams use page ranges (preserved from existing state)
  return {
    ...existing,
    status: 'in_progress',
    currentPage: existing.pageRangeStart || 1,
    currentPageUrl: undefined,
    cycleStartedAt: now.toISOString(),
  };
}

/**
 * Complete a stream tier cycle → transition to cooldown.
 */
export function completeStreamTierCycle(
  state: StreamTierState,
  cooldownHours: number,
): StreamTierState {
  const cycleStart = state.cycleStartedAt ? new Date(state.cycleStartedAt) : new Date();
  const now = new Date();
  const cooldownEnd = new Date(cycleStart.getTime() + cooldownHours * 60 * 60 * 1000);

  const base = {
    ...state,
    currentPage: state.pageRangeStart || 1,
    lastRefreshedAt: now.toISOString(),
    // Record cycle timestamps for cross-tier stale detection
    lastCycleStartedAt: state.cycleStartedAt,
    lastCycleCompletedAt: now.toISOString(),
  };

  if (cooldownEnd <= now) {
    return { ...base, status: 'idle' as const };
  }

  return {
    ...base,
    status: 'cooldown' as const,
    cooldownEndsAt: cooldownEnd.toISOString(),
  };
}

// ── Save Products ───────────────────────────────────────────────────────────

// saveProducts is now imported from './product-upsert' (shared with watermark-crawler)
