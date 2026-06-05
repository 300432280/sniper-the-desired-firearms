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
import { _getSiteCacheEntry } from './scraper/adapter-registry';
import { applyContentChange } from './product-upsert';
import type { SiteStreamState } from './scraper/types';

/** Max detail-page verifications per trigger (rate limiting) */
const MAX_VERIFY_PER_TICK = 10;

/** Higher batch for bootstrap-phase bulk reconciliation (no detail-page fetch) */
const MAX_BOOTSTRAP_BULK_PER_TICK = 200;

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
 *
 * In bootstrap phase, only the mono crawl (T4) runs — T2/T3 don't exist yet.
 * We use T4's last cycle completion as the safe window without requiring T2/T3.
 */
function computeSafeWindow(
  streamId: string,
  streamState: SiteStreamState,
  crawlPhase: string = 'maintain',
): Date | null {
  // In bootstrap phase, only T4 (mono crawl) runs. Use its cycle as safe window.
  if (crawlPhase === 'bootstrap') {
    const key = `${streamId}:4`;
    const ts = streamState.tiers[key];
    if (!ts || !ts.lastCycleCompletedAt || !ts.lastCycleStartedAt) return null;
    return new Date(ts.lastCycleStartedAt);
  }

  // Maintain phase: require all active tiers to have completed
  const startTimes: Date[] = [];

  for (const tier of [2, 3, 4] as const) {
    const key = `${streamId}:${tier}`;
    const ts = streamState.tiers[key];
    if (!ts) continue; // Tier doesn't exist in state — skip (may not be configured)

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
async function verifyDetailPage(url: string, domain?: string): Promise<'alive' | 'sold' | 'deleted'> {
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

      // Sold indicators — check site profile for custom patterns, fall back to generic
      if (hasSoldIndicators(html, domain)) {
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
 * Build sold-detection regex patterns from site profile or use generic defaults.
 * Profile entries like "field-sold Yes" become /field-sold\s+Yes/i,
 * entries like "class=sold" become /class="[^"]*\bsold\b[^"]*"/i.
 */
function hasSoldIndicators(html: string, domain?: string): boolean {
  // Try to get site-specific sold detection patterns from profile
  if (domain) {
    const entry = _getSiteCacheEntry(domain);
    const patterns: string[] | undefined = entry?.siteProfile?.classifiedRules?.soldDetection;
    if (patterns && patterns.length > 0) {
      for (const pattern of patterns) {
        // Convert pattern entries to regex:
        // "class=sold" → match class attribute containing "sold"
        // "field-sold Yes" → literal match in HTML
        // "SOLD" → case-insensitive literal match
        if (pattern.startsWith('class=')) {
          const className = pattern.slice(6); // after "class="
          const re = new RegExp(`class="[^"]*\\b${className}\\b[^"]*"`, 'i');
          if (re.test(html)) return true;
        } else {
          // Literal pattern match (escape regex special chars, allow flexible whitespace)
          const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
          if (new RegExp(escaped, 'i').test(html)) return true;
        }
      }
      return false; // Profile had patterns but none matched — don't fall through to generic
    }
  }

  // Generic fallback: detect common sold CSS classes
  if (/class="[^"]*\bsold\b[^"]*"/i.test(html)) return true;
  return false;
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
  crawlPhase: string = 'maintain',
): Promise<StaleCheckResult> {
  const result: StaleCheckResult = {
    candidatesFound: 0, verified: 0, markedSold: 0,
    markedInactive: 0, falsePositives: 0, skippedBudget: 0, errors: 0,
  };

  // Look up domain + adapter type for reconciliation strategy
  const site = await prisma.monitoredSite.findUnique({
    where: { id: siteId },
    select: { domain: true, adapterType: true },
  });
  const domain = site?.domain;

  // ── Bootstrap bulk reconciliation for API-backed sites ──────────────────
  // WooCommerce and Shopify catalog crawlers get authoritative stock data from
  // their Store/Admin APIs. During bootstrap, the mono tier (T4) visits every
  // catalog page. Products not seen by the crawler for >7 days are genuinely
  // absent from the catalog — we can mark them out_of_stock in bulk without
  // expensive detail-page verification.
  //
  // This fixes the bootstrap stock mismatch (e.g. 9,532 DB in_stock vs 3,488
  // actual) which previously couldn't self-correct because:
  //   1. computeSafeWindow returns null until T4 completes a full cycle
  //   2. The 7-day fallback only processed 10 products/tick (600 days to reconcile)
  const isApiBacked = site?.adapterType === 'woocommerce' || site?.adapterType === 'shopify';
  if (crawlPhase === 'bootstrap' && isApiBacked) {
    const BOOTSTRAP_STALE_DAYS = 7;
    const bootstrapCutoff = new Date(Date.now() - BOOTSTRAP_STALE_DAYS * 24 * 60 * 60 * 1000);

    const bulkCandidates = await prisma.productIndex.findMany({
      where: {
        siteId,
        isActive: true,
        stockStatus: 'in_stock',
        lastSeenAt: { lt: bootstrapCutoff },
      },
      orderBy: { lastSeenAt: 'asc' },
      take: MAX_BOOTSTRAP_BULK_PER_TICK,
      select: { id: true, price: true, regularPrice: true },
    });

    if (bulkCandidates.length > 0) {
      const now = new Date();
      // Bulk update — no detail-page fetch needed, API data is authoritative.
      // All rows are in_stock → out_of_stock (a real stock change), so bump
      // contentChangedAt and record one history row per candidate.
      await prisma.$transaction([
        prisma.productIndex.updateMany({
          where: { id: { in: bulkCandidates.map(p => p.id) } },
          data: {
            stockStatus: 'out_of_stock',
            staleSince: now,
            staleVerifiedAt: now,
            contentChangedAt: now,
          },
        }),
        prisma.productHistory.createMany({
          data: bulkCandidates.map(p => ({
            productIndexId: p.id,
            price: p.price,
            regularPrice: p.regularPrice,
            stockStatus: 'out_of_stock',
            changeKind: 'stock',
          })),
        }),
      ]);
      result.candidatesFound = bulkCandidates.length;
      result.markedSold = bulkCandidates.length;

      console.log(
        `[StaleDetector] ${domain}: bootstrap bulk reconciliation — ` +
        `marked ${bulkCandidates.length} unseen products out_of_stock ` +
        `(not seen since ${bootstrapCutoff.toISOString().slice(0, 10)})`
      );

      pushEvent({
        type: 'info',
        message: `StaleDetector: ${domain} bootstrap reconciliation — ${bulkCandidates.length} products → out_of_stock`,
      });
    }

    return result;
  }

  // ── Standard stale detection (maintain phase + non-API sites) ───────────

  // 1. Compute safe window — returns null if not all tiers have completed
  const safeWindow = computeSafeWindow(streamId, streamState, crawlPhase);

  // Fallback: if safe window isn't available (tiers haven't completed),
  // still check products unseen for >N days as a safety net.
  // This prevents dead products from staying active forever on sites
  // where tiers take a long time to complete full cycles.
  //
  // Bootstrap phase uses a shorter window (7 days) because T4 mono crawl
  // takes a long time to complete a full cycle, and stock data drifts
  // significantly in the meantime (e.g. 9k in_stock vs 3.5k real).
  const FALLBACK_STALE_DAYS = crawlPhase === 'bootstrap' ? 7 : 14;
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
    await recheckSoldProducts(siteId, result, domain);
    return result;
  }

  // 3. Verify each candidate via detail page
  for (const product of candidates) {
    try {
      const status = await verifyDetailPage(product.url, domain);
      result.verified++;
      const now = new Date();

      if (status === 'sold') {
        const change = applyContentChange(
          { price: product.price, regularPrice: product.regularPrice, stockStatus: product.stockStatus },
          { price: product.price, regularPrice: product.regularPrice, stockStatus: 'out_of_stock' },
        );
        await prisma.$transaction([
          prisma.productIndex.update({
            where: { id: product.id },
            data: {
              stockStatus: 'out_of_stock',
              staleSince: product.staleSince ?? now,
              staleVerifiedAt: now,
              ...(change.changed ? { contentChangedAt: now } : {}),
            },
          }),
          ...(change.history
            ? [prisma.productHistory.create({ data: { productIndexId: product.id, ...change.history } })]
            : []),
        ]);
        result.markedSold++;
      } else if (status === 'deleted') {
        // Also flip stockStatus → out_of_stock so the row agrees with history
        // and future restock detection works.
        const change = applyContentChange(
          { price: product.price, regularPrice: product.regularPrice, stockStatus: product.stockStatus },
          { price: product.price, regularPrice: product.regularPrice, stockStatus: 'out_of_stock' },
        );
        await prisma.$transaction([
          prisma.productIndex.update({
            where: { id: product.id },
            data: {
              isActive: false,
              // Was already OOS then vanished → likely sold; otherwise unknown.
              delistReason: product.stockStatus === 'out_of_stock' ? 'sold' : 'unknown',
              stockStatus: 'out_of_stock',
              staleSince: product.staleSince ?? now,
              staleVerifiedAt: now,
              ...(change.changed ? { contentChangedAt: now } : {}),
            },
          }),
          ...(change.history
            ? [prisma.productHistory.create({ data: { productIndexId: product.id, ...change.history } })]
            : []),
        ]);
        result.markedInactive++;
      } else {
        // False positive — product still alive, refresh lastSeenAt
        await prisma.productIndex.update({
          where: { id: product.id },
          data: {
            lastSeenAt: now,
            staleSince: null,
            staleVerifiedAt: now,
            delistReason: null, // still listed → clear any prior delist reason
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
    await recheckSoldProducts(siteId, result, domain);
  }

  return result;
}

/**
 * Re-check products previously marked sold. Classifieds sites often remove
 * sold listings after a few days — transition them from out_of_stock to isActive=false.
 */
async function recheckSoldProducts(
  siteId: string,
  result: StaleCheckResult,
  domain?: string,
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
      const status = await verifyDetailPage(product.url, domain);
      const now = new Date();

      if (status === 'deleted') {
        await prisma.productIndex.update({
          where: { id: product.id },
          data: {
            isActive: false,
            // Was already OOS then vanished → likely sold; otherwise unknown.
            delistReason: product.stockStatus === 'out_of_stock' ? 'sold' : 'unknown',
            staleVerifiedAt: now,
          },
        });
        result.markedInactive++;
      } else if (status === 'alive') {
        // Was sold but is back? Seller re-listed — a restock (out_of_stock → in_stock),
        // the most alert-worthy stock change. Record it.
        const change = applyContentChange(
          { price: product.price, regularPrice: product.regularPrice, stockStatus: product.stockStatus },
          { price: product.price, regularPrice: product.regularPrice, stockStatus: 'in_stock' },
        );
        await prisma.$transaction([
          prisma.productIndex.update({
            where: { id: product.id },
            data: {
              stockStatus: 'in_stock',
              staleSince: null,
              staleVerifiedAt: now,
              lastSeenAt: now,
              delistReason: null, // re-listed → clear any prior delist reason
              ...(change.changed ? { contentChangedAt: now } : {}),
            },
          }),
          ...(change.history
            ? [prisma.productHistory.create({ data: { productIndexId: product.id, ...change.history } })]
            : []),
        ]);
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
