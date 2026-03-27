/**
 * Stale Product Detector
 *
 * Triggered when any stream tier completes a cycle. Determines which products
 * have gone unseen across ALL tiers' most recent complete sweeps, then verifies
 * via detail page fetch.
 *
 * A product is only flagged as a stale candidate when every tier that covers
 * the site has completed a full cycle AND none of them found the product.
 * This prevents false positives from page-content shifting between tier boundaries.
 *
 * Lifecycle:
 *   Listed (in_stock) → Sold (out_of_stock) → Deleted (isActive=false)
 *   Listed (in_stock) → Deleted directly (isActive=false)
 *
 * All data is preserved — isActive=false is a soft-delete. No rows are ever removed.
 */

import { prisma } from '../lib/prisma';
import { pushEvent } from './debugLog';
import type { SiteStreamState } from './scraper/types';

/** Max detail-page verifications per trigger (rate limiting) */
const MAX_VERIFY_PER_TICK = 10;

/** Hours between re-verification attempts on the same product */
const REVERIFY_COOLDOWN_HOURS = 48;

/** Days after marking sold before re-checking for deletion */
const SOLD_RECHECK_DAYS = 5;

/** ms delay between detail page fetches */
const FETCH_DELAY_MS = 1500;

export interface StaleCheckResult {
  candidatesFound: number;
  verified: number;
  markedSold: number;
  markedInactive: number;
  falsePositives: number;
  skippedBudget: number;
  errors: number;
}

/**
 * Compute the "safe window" timestamp. A product unseen since before this
 * time has been missed by ALL tiers in their most recent complete sweep.
 *
 * Returns null if any tier hasn't completed a cycle yet (not safe to detect).
 */
function computeSafeWindow(
  streamId: string,
  streamState: SiteStreamState,
): Date | null {
  const startTimes: Date[] = [];

  for (const tier of [2, 3, 4] as const) {
    const key = `${streamId}:${tier}`;
    const ts = streamState.tiers[key];
    if (!ts) return null; // Tier doesn't exist

    // Skip tiers with no work (pageRangeStart > pageRangeEnd = empty range)
    if (ts.pageRangeStart && ts.pageRangeEnd && ts.pageRangeStart > ts.pageRangeEnd) {
      continue;
    }

    // Every active tier must have completed at least one cycle
    if (!ts.lastCycleCompletedAt || !ts.lastCycleStartedAt) return null;
    startTimes.push(new Date(ts.lastCycleStartedAt));
  }

  if (startTimes.length === 0) return null;

  // MIN of all cycle start times = the earliest point at which all tiers
  // began their most recent sweep. Products unseen since before this are
  // confirmed missed by everyone.
  return new Date(Math.min(...startTimes.map(d => d.getTime())));
}

/**
 * Fetch a product's detail page and determine its status.
 * Uses the shared http-client for UA rotation, rate limiting, and SSRF protection.
 */
async function verifyDetailPage(url: string): Promise<'alive' | 'sold' | 'deleted'> {
  // Retry up to 2 times on transient errors (Cloudflare 520/502/503).
  // These status codes hide real 404s — a single attempt is not reliable.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { fetchPageWithMeta } = await import('./scraper/http-client');
      const { html, statusCode } = await fetchPageWithMeta(url, undefined, { difficultyRating: 0 });

      if (statusCode === 404 || statusCode === 410) return 'deleted';

      // Cloudflare transient errors — retry
      if (statusCode === 520 || statusCode === 502 || statusCode === 503) {
        if (attempt < 2) { await new Promise(r => setTimeout(r, 2000)); continue; }
        // Still failing after retry — can't determine
        throw new Error(`Transient ${statusCode} after retry`);
      }

      // Sold indicators (gunpost: class="sold Yes", class="field-sold Yes")
      if (/class="[^"]*\bsold\b[^"]*"/i.test(html) || /class="field-sold\s+Yes"/i.test(html)) {
        return 'sold';
      }

      // Soft-404 (page returns 200 but content says "not found")
      if (/<h1[^>]*>[^<]*(?:not found|page introuvable)/i.test(html)
        || /The page you requested does not exist/i.test(html)
        || /has been removed/i.test(html)
        || /no longer available/i.test(html)) {
        return 'deleted';
      }

      // Very small response (< 5KB) on a 200 may be a Cloudflare challenge, not a real page
      if (html.length < 5000 && !html.includes('add-to-cart') && !html.includes('Add to Cart')) {
        if (attempt < 2) { await new Promise(r => setTimeout(r, 2000)); continue; }
      }

      return 'alive';
    } catch (err) {
      if (attempt < 2) { await new Promise(r => setTimeout(r, 2000)); continue; }
      throw new Error(`Failed to verify ${url}: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }
  throw new Error(`Failed to verify ${url} after retries`);
}

/**
 * Check for stale products after a tier cycle completes.
 *
 * Called from worker.ts when any tier's cycleComplete = true.
 */
export async function checkStaleProducts(
  siteId: string,
  streamId: string,
  streamState: SiteStreamState,
): Promise<StaleCheckResult> {
  const result: StaleCheckResult = {
    candidatesFound: 0, verified: 0, markedSold: 0,
    markedInactive: 0, falsePositives: 0, skippedBudget: 0, errors: 0,
  };

  // 1. Compute safe window — returns null if not all tiers have completed
  const safeWindow = computeSafeWindow(streamId, streamState);

  // Fallback: if safe window isn't available (tiers haven't completed),
  // still check products unseen for >14 days as a safety net.
  // This prevents dead products from staying active forever on sites
  // where tiers take a long time to complete full cycles.
  const FALLBACK_STALE_DAYS = 14;
  const fallbackWindow = new Date(Date.now() - FALLBACK_STALE_DAYS * 24 * 60 * 60 * 1000);
  const cutoffDate = safeWindow ?? fallbackWindow;

  const reverifyBefore = new Date(Date.now() - REVERIFY_COOLDOWN_HOURS * 60 * 60 * 1000);

  // 2. Query products not seen since the cutoff (either safe window or 14-day fallback)
  const candidates = await prisma.productIndex.findMany({
    where: {
      siteId,
      isActive: true,
      lastSeenAt: { lt: cutoffDate },
      OR: [
        { staleVerifiedAt: null },
        { staleVerifiedAt: { lt: reverifyBefore } },
      ],
    },
    orderBy: { lastSeenAt: 'asc' },
    take: MAX_VERIFY_PER_TICK,
  });

  result.candidatesFound = candidates.length;
  if (candidates.length === 0) {
    // Also try re-checking sold items while we're here
    await recheckSoldProducts(siteId, result);
    return result;
  }

  // 3. Verify each candidate via detail page
  for (const product of candidates) {
    try {
      const status = await verifyDetailPage(product.url);
      result.verified++;
      const now = new Date();

      if (status === 'sold') {
        await prisma.productIndex.update({
          where: { id: product.id },
          data: {
            stockStatus: 'out_of_stock',
            staleSince: product.staleSince ?? now,
            staleVerifiedAt: now,
          },
        });
        result.markedSold++;
      } else if (status === 'deleted') {
        await prisma.productIndex.update({
          where: { id: product.id },
          data: {
            isActive: false,
            staleSince: product.staleSince ?? now,
            staleVerifiedAt: now,
          },
        });
        result.markedInactive++;
      } else {
        // False positive — product still alive, refresh lastSeenAt
        await prisma.productIndex.update({
          where: { id: product.id },
          data: {
            lastSeenAt: now,
            staleSince: null,
            staleVerifiedAt: now,
          },
        });
        result.falsePositives++;
      }

      await new Promise(r => setTimeout(r, FETCH_DELAY_MS));
    } catch {
      result.errors++;
    }
  }

  // 4. Re-check sold products only when no new candidates were found (lower priority)
  if (candidates.length === 0) {
    await recheckSoldProducts(siteId, result);
  }

  return result;
}

/**
 * Re-check products previously marked sold. Gunpost removes sold listings
 * after ~3 days — transition them from out_of_stock to isActive=false.
 */
async function recheckSoldProducts(
  siteId: string,
  result: StaleCheckResult,
): Promise<void> {
  const recheckCutoff = new Date(Date.now() - SOLD_RECHECK_DAYS * 24 * 60 * 60 * 1000);
  const reverifyBefore = new Date(Date.now() - REVERIFY_COOLDOWN_HOURS * 60 * 60 * 1000);

  const soldProducts = await prisma.productIndex.findMany({
    where: {
      siteId,
      isActive: true,
      stockStatus: 'out_of_stock',
      staleSince: { lt: recheckCutoff },
      OR: [
        { staleVerifiedAt: null },
        { staleVerifiedAt: { lt: reverifyBefore } },
      ],
    },
    orderBy: { staleSince: 'asc' },
    take: 5, // Small batch — lower priority than new candidates
  });

  for (const product of soldProducts) {
    try {
      const status = await verifyDetailPage(product.url);
      const now = new Date();

      if (status === 'deleted') {
        await prisma.productIndex.update({
          where: { id: product.id },
          data: { isActive: false, staleVerifiedAt: now },
        });
        result.markedInactive++;
      } else if (status === 'alive') {
        // Was sold but is back? Seller re-listed.
        await prisma.productIndex.update({
          where: { id: product.id },
          data: {
            stockStatus: 'in_stock',
            staleSince: null,
            staleVerifiedAt: now,
            lastSeenAt: now,
          },
        });
        result.falsePositives++;
      } else {
        // Still sold — just update verification timestamp
        await prisma.productIndex.update({
          where: { id: product.id },
          data: { staleVerifiedAt: now },
        });
      }

      await new Promise(r => setTimeout(r, FETCH_DELAY_MS));
    } catch {
      result.errors++;
    }
  }
}
