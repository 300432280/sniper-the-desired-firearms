/**
 * @deprecated 2026-04-27 — Generic discovery superseded by AI-driven per-site audit.
 * See `_DEPRECATED.md` in this folder and `docs/superpowers/plans/2026-04-27-pivot-to-ai-audit.md`.
 * Do not import from this file in new code.
 */
// backend/scripts/probe/geography-count/select-catalog-set.ts
// Step 4 of the Geography & Count stage: select catalog URLs from candidates.
//
// Strategy:
// 1. If sitemap URL set is available, use greedy set-cover with sampled product
//    URLs to prioritize candidates. But NEVER drop a candidate just because its
//    page-1 sample doesn't match sitemap (the sample is tiny; the full walk may
//    cover hundreds of sitemap URLs).
// 2. Keep all candidates with >= MIN_PRODUCTS products — the walk-verify step
//    does the real coverage measurement. We only drop candidates that are
//    clearly redundant (100% of their sampled products already covered by
//    higher-priority candidates).
// 3. Drop candidates with < MIN_PRODUCTS unless they're the only candidate.
//
// Anti-ban: 2-3s delay between fetches is handled by fetchUrl in shared/fetch.ts.

import { fetchUrl } from '../shared/fetch';
import { extractProducts } from '../shared/extract';
import { buildPagedUrl } from './pagination-detect';
import type { AccessIdentityState, PaginationPattern } from '../shared/types';

/** Coverage threshold — used for reporting */
export const COVERAGE_TARGET_PCT = 95;

/** Minimum products a candidate must show on page 1 to be included */
const MIN_PRODUCTS = 1;

/** Max pages to sample per candidate for sitemap overlap estimation */
const SAMPLE_PAGES_PER_CANDIDATE = 5;

/**
 * URL-pattern based detection of "view all" / aggregator catalog URLs.
 * These are top-level pages that contain ALL products (not a category subset).
 * Bug R2-4/R2-5: aggregators must be walked first and given generous walk limits.
 * Platform-generic — matches common patterns across Shopify, WooCommerce, BC, etc.
 */
const VIEW_ALL_RE = /\/(shop|shop-2|all-products|collections\/all|catalog|store|inventory|products|all)(\/)?(\?|$)/i;

/**
 * Drupal classifieds canonical sort URL pattern.
 * /ads?sort_by=... covers ALL listings — treat as view-all aggregator.
 * Also matches /listings?sort_by=...
 */
const DRUPAL_SORT_RE = /\/(ads|listings)\?sort_by=/i;

export function isViewAllUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (VIEW_ALL_RE.test(u.pathname + (u.search ? '?' : ''))) return true;
    // Drupal classifieds: /ads?sort_by=... is a view-all sorted catalog
    if (DRUPAL_SORT_RE.test(u.pathname + u.search)) return true;
    return false;
  } catch {
    if (VIEW_ALL_RE.test(url)) return true;
    if (DRUPAL_SORT_RE.test(url)) return true;
    return false;
  }
}

export type CatalogCandidate = {
  url: string;
  page1ProductCount: number;
  sampleProductUrls: string[];
};

export type SetCoverResult = {
  selectedCatalogUrls: string[];
  coveragePct: number;
  sitemapTotal: number;
  droppedForOverlap: string[];
  candidateCoverage: Array<{ url: string; estimatedCoverage: number; selected: boolean }>;
};

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hostname = u.hostname.toLowerCase();
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    u.hash = '';
    return u.toString();
  } catch {
    return url.replace(/\/$/, '').toLowerCase();
  }
}

export async function selectCatalogSet(
  state: AccessIdentityState,
  candidates: CatalogCandidate[],
  sitemapUrlSet: Set<string>,
  paginationPattern: PaginationPattern | null,
): Promise<SetCoverResult> {
  const ctx = { hasWaf: state.hasWaf, wafType: state.wafType, ua: state.userAgentOverride ?? undefined };
  const sitemapTotal = sitemapUrlSet.size;

  // If no sitemap, keep all productive candidates (walk-verify will measure actual coverage)
  if (sitemapTotal === 0) {
    const productive = candidates.filter(c => c.page1ProductCount >= MIN_PRODUCTS);
    process.stderr.write(`  [set-cover] no sitemap URL set — keeping all ${productive.length} productive candidates\n`);
    return {
      selectedCatalogUrls: productive.map(c => c.url),
      coveragePct: 0,
      sitemapTotal: 0,
      droppedForOverlap: [],
      candidateCoverage: productive.map(c => ({ url: c.url, estimatedCoverage: 0, selected: true })),
    };
  }

  // Normalize sitemap URLs
  const normalizedSitemap = new Set<string>();
  for (const u of sitemapUrlSet) {
    normalizedSitemap.add(normalizeUrl(u));
  }

  // Bug R2-5: Detect view-all aggregator candidates. If one exists, it likely
  // covers all products — prioritize it and use a deeper sample depth.
  const viewAllCandidates = candidates.filter(c => isViewAllUrl(c.url) && c.page1ProductCount >= 3);
  const hasViewAll = viewAllCandidates.length > 0;

  if (hasViewAll) {
    process.stderr.write(`  [set-cover] view-all candidates detected: ${viewAllCandidates.map(c => c.url).join(', ')}\n`);
  }

  // For each candidate, gather sampled product URLs (page 1 already provided + extra pages)
  const candidateProductSets: Map<string, Set<string>> = new Map();

  for (const candidate of candidates) {
    const productUrls = new Set<string>();
    for (const u of candidate.sampleProductUrls) {
      productUrls.add(normalizeUrl(u));
    }

    // If page-1 sample is empty (e.g. WC taxonomy candidates use API count
    // but never fetched page 1 HTML), fetch page 1 to get sample product URLs.
    // Only do this for candidates we'll actually sample deeper (skip tiny ones
    // when there are many candidates — performance guard for 50+ category WC sites).
    const shouldSample = candidates.length <= 20 || candidate.page1ProductCount >= 10 || isViewAllUrl(candidate.url);
    if (productUrls.size === 0 && candidate.page1ProductCount >= 1 && shouldSample) {
      try {
        const r = await fetchUrl(candidate.url, { ...ctx, timeoutMs: 15000 });
        if (r.status < 400) {
          const products = extractProducts(r.body, candidate.url, state.platform);
          for (const p of products) {
            productUrls.add(normalizeUrl(p.url));
          }
        }
      } catch { /* skip */ }
    }

    // Sample additional pages to improve overlap estimation.
    // View-all URLs get deeper sampling since their sample-based coverage
    // estimate drives whether we skip the full set-cover.
    const isAgg = isViewAllUrl(candidate.url);
    const sampleDepth = isAgg ? SAMPLE_PAGES_PER_CANDIDATE : Math.min(SAMPLE_PAGES_PER_CANDIDATE, 3);

    if (paginationPattern && paginationPattern.type !== null && candidate.page1ProductCount >= 3 && shouldSample) {
      for (let pageNum = 2; pageNum <= 1 + sampleDepth; pageNum++) {
        const pageUrl = buildPagedUrl(candidate.url, pageNum, paginationPattern);
        try {
          const r = await fetchUrl(pageUrl, { ...ctx, timeoutMs: 15000 });
          if (r.status >= 400) break;
          const products = extractProducts(r.body, pageUrl, state.platform);
          if (products.length === 0) break;
          for (const p of products) {
            productUrls.add(normalizeUrl(p.url));
          }
        } catch { break; }
      }
    }

    candidateProductSets.set(candidate.url, productUrls);
  }

  // Bug R2-5: If a view-all candidate's sampled products have high overlap
  // with the sitemap AND the sample covers a meaningful fraction of sitemap,
  // use it as the sole primary catalog URL. This avoids the set-cover
  // underestimation trap where a 5-page sample of a 48-page aggregator
  // shows only 5% sitemap coverage — set-cover then adds 16 more candidates
  // trying to fill the "gap" that doesn't actually exist.
  //
  // Guard: require sampleCoverage >= 15% of sitemap to avoid false positives
  // from small curated pages that happen to have /shop in their URL (e.g.
  // canadafirstammo /shop-2/ has only 134 products but 100% sample overlap
  // with a 963-product sitemap — sample covers only 7.5%, so it's not a
  // real aggregator).
  if (hasViewAll && sitemapTotal > 0) {
    for (const agg of viewAllCandidates) {
      const sample = candidateProductSets.get(agg.url)!;
      if (sample.size < 5) continue; // too few samples to judge
      let sitemapOverlap = 0;
      for (const u of sample) { if (normalizedSitemap.has(u)) sitemapOverlap++; }
      const sampleOverlapRate = sample.size > 0 ? sitemapOverlap / sample.size : 0;
      const sitemapCoverageRate = sitemapOverlap / sitemapTotal;

      // Require BOTH:
      // (a) >= 50% of sampled products are in sitemap (proves it's a real catalog, not a blog/featured page)
      // (b) sample covers >= 15% of sitemap (proves it's big enough to be a full aggregator, not a curated subset)
      if (sampleOverlapRate >= 0.5 && sitemapCoverageRate >= 0.15) {
        process.stderr.write(
          `  [set-cover] view-all shortcut: ${agg.url} — ${sitemapOverlap}/${sample.size} sampled products in sitemap ` +
          `(overlap ${(sampleOverlapRate * 100).toFixed(0)}%, sitemap coverage ${(sitemapCoverageRate * 100).toFixed(1)}%) → using as primary catalog\n`
        );
        return {
          selectedCatalogUrls: [agg.url],
          coveragePct: sitemapCoverageRate * 100,
          sitemapTotal,
          droppedForOverlap: candidates.filter(c => c.url !== agg.url).map(c => c.url),
          candidateCoverage: candidates.map(c => ({
            url: c.url,
            estimatedCoverage: c.url === agg.url ? sitemapCoverageRate * 100 : 0,
            selected: c.url === agg.url,
          })),
        };
      } else if (sampleOverlapRate >= 0.5) {
        process.stderr.write(
          `  [set-cover] view-all candidate ${agg.url} — overlap ${(sampleOverlapRate * 100).toFixed(0)}% but sitemap coverage only ` +
          `${(sitemapCoverageRate * 100).toFixed(1)}% (${sitemapOverlap}/${sitemapTotal}) — not using shortcut\n`
        );
      }
    }
  }

  // Two-phase selection:
  // Phase A: Greedy set-cover using sampled URLs to pick priority order
  // Phase B: Include remaining productive candidates that weren't redundant

  const covered = new Set<string>();
  const selected: string[] = [];
  const droppedForOverlap: string[] = [];
  const coverageLog: Array<{ url: string; estimatedCoverage: number; selected: boolean }> = [];
  const remaining = new Set(candidates.map(c => c.url));

  // Phase A: Greedy set-cover ordering
  while (remaining.size > 0) {
    let bestUrl: string | null = null;
    let bestNewCount = 0;

    for (const url of remaining) {
      const products = candidateProductSets.get(url)!;
      let newCount = 0;
      for (const pUrl of products) {
        if (normalizedSitemap.has(pUrl) && !covered.has(pUrl)) newCount++;
      }
      if (newCount > bestNewCount) {
        bestNewCount = newCount;
        bestUrl = url;
      }
    }

    if (!bestUrl) {
      // No candidate has any sitemap overlap — but they may still have products
      // that aren't in the sitemap. Keep all productive ones.
      for (const url of remaining) {
        const cand = candidates.find(c => c.url === url)!;
        if (cand.page1ProductCount >= MIN_PRODUCTS) {
          selected.push(url);
          coverageLog.push({ url, estimatedCoverage: 0, selected: true });
        } else {
          droppedForOverlap.push(url);
          coverageLog.push({ url, estimatedCoverage: 0, selected: false });
        }
      }
      break;
    }

    // Select this candidate
    selected.push(bestUrl);
    const products = candidateProductSets.get(bestUrl)!;
    for (const pUrl of products) {
      if (normalizedSitemap.has(pUrl)) covered.add(pUrl);
    }
    remaining.delete(bestUrl);
    coverageLog.push({ url: bestUrl, estimatedCoverage: bestNewCount, selected: true });

    const covPct = (covered.size / sitemapTotal) * 100;
    process.stderr.write(
      `  [set-cover] selected ${bestUrl} (+${bestNewCount} new) → coverage ${covPct.toFixed(1)}%\n`
    );

    // If bestNewCount is 0, this candidate has no sitemap overlap at all
    if (bestNewCount === 0) {
      // Check if candidate is productive — if so, keep it (products may be
      // absent from sitemap, e.g. newly added or classifieds lag)
      const cand = candidates.find(c => c.url === bestUrl)!;
      if (cand.page1ProductCount < MIN_PRODUCTS) {
        // Remove from selected and drop
        selected.pop();
        droppedForOverlap.push(bestUrl);
        coverageLog[coverageLog.length - 1].selected = false;
      }
      // Process remaining
      for (const url of remaining) {
        const cand2 = candidates.find(c => c.url === url)!;
        if (cand2.page1ProductCount >= MIN_PRODUCTS) {
          selected.push(url);
          coverageLog.push({ url, estimatedCoverage: 0, selected: true });
        } else {
          droppedForOverlap.push(url);
          coverageLog.push({ url, estimatedCoverage: 0, selected: false });
        }
      }
      break;
    }
  }

  const coveragePct = sitemapTotal > 0 ? (covered.size / sitemapTotal) * 100 : 0;

  process.stderr.write(
    `  [set-cover] final: ${selected.length} selected, ${droppedForOverlap.length} dropped, sample coverage ${coveragePct.toFixed(1)}% of ${sitemapTotal} sitemap URLs\n`
  );

  return {
    selectedCatalogUrls: selected,
    coveragePct,
    sitemapTotal,
    droppedForOverlap,
    candidateCoverage: coverageLog,
  };
}
