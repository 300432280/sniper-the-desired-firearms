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
import { getAdapterForUrl } from './scraper/adapter-registry';
import { fetchPageWithMeta, randomDelay } from './scraper/http-client';
import { consumeToken, getCatalogRemaining, allocateCatalogTokens } from './token-budget';
import { matchNewProducts } from './keyword-matcher';
import { pushEvent } from './debugLog';
import type { CatalogProduct } from './scraper/types';
import * as cheerio from 'cheerio';

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
  /** Current page in the catalog crawl */
  currentPage: number;
  /** When this cycle started */
  cycleStartedAt?: string;
  /** When cooldown ends (cycle can restart) */
  cooldownEndsAt?: string;
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
}): Promise<CatalogCrawlResult> {
  const { siteId, url, tier, tierState, tokensAllocated } = params;
  const { adapter } = await getAdapterForUrl(url);
  const origin = new URL(url).origin;

  let pagesScanned = 0;
  let tokensUsed = 0;
  let productsFound = 0;
  let cycleComplete = false;
  const allProducts: CatalogProduct[] = [];

  try {
    let page = tierState.currentPage || 1;

    while (tokensUsed < tokensAllocated) {
      consumeToken(siteId, tier);
      tokensUsed++;

      // API-based catalog crawl (preferred)
      if (adapter.fetchCatalogPage) {
        const catalogPage = await adapter.fetchCatalogPage(origin, page, {
          sortBy: 'newest',
          perPage: 50,
        });
        pagesScanned++;

        if (catalogPage.products.length === 0) {
          cycleComplete = true;
          break;
        }

        // Filter products within the tier's date range
        // (API doesn't support date filtering natively for most platforms,
        //  so we filter by ProductIndex firstSeenAt after save)
        allProducts.push(...catalogPage.products);
        productsFound += catalogPage.products.length;

        if (!catalogPage.nextPageUrl && (!catalogPage.totalPages || page >= catalogPage.totalPages)) {
          cycleComplete = true;
          break;
        }

        page++;
        await randomDelay(300, 800);
      }
      // HTML-based catalog crawl (fallback)
      else if (adapter.extractCatalogProducts) {
        // Build the catalog page URL
        const pageUrl = page === 1
          ? `${origin}/shop/`
          : `${origin}/shop/page/${page}/`;

        const fetchResult = await fetchPageWithMeta(pageUrl, undefined, { difficultyRating: 0 });
        const $ = cheerio.load(fetchResult.html);
        pagesScanned++;

        const products = adapter.extractCatalogProducts($, pageUrl);
        if (products.length === 0) {
          cycleComplete = true;
          break;
        }

        allProducts.push(...products);
        productsFound += products.length;

        // Check for next page
        const nextUrl = adapter.getNextPageUrl?.($, pageUrl);
        if (!nextUrl) {
          cycleComplete = true;
          break;
        }

        page++;
        await randomDelay(300, 800);
      } else {
        // No catalog crawl method available
        cycleComplete = true;
        break;
      }
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
 * Called by the scheduler tick.
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
 */
export function completeTierCycle(tier: 2 | 3 | 4, cycleState: TierCycleState): TierCycleState {
  const config = TIER_CONFIGS.find(c => c.tier === tier)!;
  const cycleStart = cycleState.cycleStartedAt ? new Date(cycleState.cycleStartedAt) : new Date();
  const cooldownEnd = new Date(cycleStart.getTime() + config.cooldownHours * 60 * 60 * 1000);

  // If cycle took longer than cooldown, start next cycle immediately
  if (cooldownEnd <= new Date()) {
    return { ...DEFAULT_TIER_CYCLE, status: 'idle' };
  }

  return {
    status: 'cooldown',
    currentPage: 0,
    cooldownEndsAt: cooldownEnd.toISOString(),
    cycleStartedAt: cycleState.cycleStartedAt,
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
): TierCycleState {
  if (cycleComplete) {
    return completeTierCycle(tier, tierState);
  }

  return {
    ...tierState,
    currentPage: tierState.currentPage + pagesScanned,
  };
}

// ── Save Products ───────────────────────────────────────────────────────────

async function saveProducts(
  siteId: string,
  products: CatalogProduct[],
): Promise<Array<{ id: string; siteId: string; url: string; title: string; price?: number | null; thumbnail?: string | null }>> {
  if (products.length === 0) return [];

  const saved: Array<{ id: string; siteId: string; url: string; title: string; price?: number | null; thumbnail?: string | null }> = [];

  for (const product of products) {
    try {
      const result = await prisma.productIndex.upsert({
        where: { siteId_url: { siteId, url: product.url } },
        update: {
          title: product.title,
          price: product.price ?? null,
          stockStatus: product.stockStatus ?? null,
          thumbnail: product.thumbnail ?? null,
          category: product.category ?? null,
          closingAt: product.closingAt ?? null,
          lastSeenAt: new Date(),
          isActive: true,
        },
        create: {
          siteId,
          url: product.url,
          title: product.title,
          price: product.price ?? null,
          stockStatus: product.stockStatus ?? null,
          thumbnail: product.thumbnail ?? null,
          category: product.category ?? null,
          closingAt: product.closingAt ?? null,
        },
      });

      // Only include in "new" list if it was just created
      if (result.firstSeenAt.getTime() === result.lastSeenAt.getTime()) {
        saved.push(result);
      }
    } catch (err) {
      if (!(err instanceof Error && err.message.includes('Unique constraint'))) {
        console.error(`[CatalogCrawler] Failed to save product ${product.url}:`, err);
      }
    }
  }

  return saved;
}
