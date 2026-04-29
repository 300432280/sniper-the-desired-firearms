/**
 * @deprecated 2026-04-27 — Generic discovery superseded by AI-driven per-site audit.
 * See `_DEPRECATED.md` in this folder and `docs/superpowers/plans/2026-04-27-pivot-to-ai-audit.md`.
 * Do not import from this file in new code.
 */
// backend/scripts/probe/room3-geography-count/walk-verify.ts
// Walk every catalogUrl using the discovered paginationPattern.
// Bug #1 fix: uses buildPagedUrl from pagination-detect (no more hardcoded ?page=N).
// Bug #4 fix: returns zeroProductUrls so the composer can hard-fail per spec §4.3.
// Bug R2-4 fix: aggregator URLs (view-all patterns) are walked first and don't break
//   on "all dupes" — only on "0 products returned" (true end) or wrap-around (Mistake 26).
//   Non-aggregator URLs keep the 3-consecutive-zero-NEW early break.
//
// Performance: uses axios first; escalates to Playwright only on WAF challenge.

import { fetchUrl } from '../shared/fetch';
import { extractProducts } from '../shared/extract';
import { buildPagedUrl } from './pagination-detect';
import { hasChallengeMarkers } from '../room2-access-identity/canonical-host';
import { isViewAllUrl } from './select-catalog-set';
import type { AccessIdentityState, PaginationPattern } from '../shared/types';

export type WalkResult = {
  walkCounts: Array<{ url: string; uniqueProducts: number; pages: number }>;
  uniqueProductUrls: Set<string>;
  zeroProductUrls: string[];
};

/** Max consecutive pages with 0 new unique products before stopping a NON-aggregator category walk */
const MAX_CONSECUTIVE_ZERO_NEW = 3;

/** Max consecutive all-dupe pages before stopping an AGGREGATOR walk (generous — aggregators are primary) */
const MAX_CONSECUTIVE_ZERO_NEW_AGGREGATOR = 10;

export async function walkAndDedupe(
  state: AccessIdentityState,
  catalogUrls: string[],
  paginationPattern: PaginationPattern,
  globalProductCount?: number,
): Promise<WalkResult> {
  const ua = state.userAgentOverride ?? undefined;
  let usePlaywright = false;

  const seen = new Set<string>();
  const counts: WalkResult['walkCounts'] = [];
  const zeroProductUrls: string[] = [];

  for (const url of catalogUrls) {
    let pages = 0;
    let countForUrl = 0;
    let pageNum = paginationPattern.startPage + 1;
    const isAggregator = isViewAllUrl(url);

    // For aggregator URLs, allow more pages based on expected global product count.
    // For non-aggregator, keep a tighter cap.
    const perPage = paginationPattern.perPage || 20;
    const maxPages = isAggregator && globalProductCount
      ? Math.max(200, Math.ceil((globalProductCount / perPage) * 1.3))
      : 200;
    let consecutiveZeroNew = 0;
    const zeroNewLimit = isAggregator ? MAX_CONSECUTIVE_ZERO_NEW_AGGREGATOR : MAX_CONSECUTIVE_ZERO_NEW;

    // Capture first-page product URLs for wrap-around detection (Mistake 26).
    // Use a SET of first-page URLs (not just the first product) to avoid false
    // positives on live classifieds sites where new listings push products down
    // between page fetches.
    let firstPageProductUrls: Set<string> | null = null;

    while (pages < maxPages) {
      const pageUrl = pages === 0 ? url : buildPagedUrl(url, pageNum, paginationPattern);
      try {
        const ctx = usePlaywright
          ? { hasWaf: true, wafType: state.wafType, ua, timeoutMs: 20000 }
          : { hasWaf: false as const, ua, timeoutMs: 15000 };

        let r = await fetchUrl(pageUrl, ctx);

        // Check for WAF challenge
        if (!usePlaywright && r.body && hasChallengeMarkers(r.body)) {
          process.stderr.write(`  [walk-verify] WAF challenge on ${pageUrl}, escalating to Playwright\n`);
          usePlaywright = true;
          r = await fetchUrl(pageUrl, { hasWaf: true, wafType: state.wafType, ua, timeoutMs: 20000 });
        }

        if (r.status >= 400) break;
        const products = extractProducts(r.body, pageUrl, state.platform);

        if (products.length === 0) {
          // Truly empty page — no more products
          if (pages === 0) zeroProductUrls.push(url);
          break;
        }

        // Wrap-around detection (Mistake 26): if a MAJORITY (>= 50%) of this page's
        // products match page 1's products, pagination has wrapped back to the start.
        // Using majority match instead of first-product-only to avoid false positives
        // on live classifieds sites where new listings shift content between fetches.
        if (pages === 0) {
          firstPageProductUrls = new Set(products.map(p => p.url));
        } else if (firstPageProductUrls && firstPageProductUrls.size > 0) {
          const overlapCount = products.filter(p => firstPageProductUrls!.has(p.url)).length;
          const overlapPct = products.length > 0 ? overlapCount / products.length : 0;
          if (overlapPct >= 0.5) {
            process.stderr.write(`  [walk-verify] wrap-around detected on ${pageUrl} (${(overlapPct * 100).toFixed(0)}% products match page 1) — stopping\n`);
            break;
          }
        }

        let added = 0;
        for (const p of products) {
          if (!seen.has(p.url)) { seen.add(p.url); added++; }
        }
        countForUrl += added;
        pages++;

        if (added === 0) {
          consecutiveZeroNew++;
          if (consecutiveZeroNew >= zeroNewLimit) {
            if (isAggregator) {
              process.stderr.write(`  [walk-verify] aggregator ${url}: ${consecutiveZeroNew} consecutive all-dupe pages — stopping\n`);
            }
            break;
          }
        } else {
          consecutiveZeroNew = 0;
        }

        pageNum++;
      } catch { break; }
    }
    counts.push({ url, uniqueProducts: countForUrl, pages });
    process.stderr.write(`  [walk-verify] ${url} → ${countForUrl} unique, ${pages} pages (total seen: ${seen.size})${isAggregator ? ' [aggregator]' : ''}\n`);
  }

  return { walkCounts: counts, uniqueProductUrls: seen, zeroProductUrls };
}
