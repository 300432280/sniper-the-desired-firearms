/**
 * @deprecated 2026-04-27 — Generic discovery superseded by AI-driven per-site audit.
 * See `_DEPRECATED.md` in this folder and `docs/superpowers/plans/2026-04-27-pivot-to-ai-audit.md`.
 * Do not import from this file in new code.
 */
// backend/scripts/probe/geography-count/index.ts
// Geography & Count stage sequence per architectural redesign:
//   1. sitemap-products: extract product URL Set (ground truth for set-cover)
//   2. catalog-urls: multi-source candidate generation (API + nav + view-all + breadcrumb)
//   3. select-catalog-set: greedy minimum set cover against sitemap
//   4. pagination-detect: detect on best selected catalog
//   5. walk-verify: full walk + dedupe across selected catalogs
//   6. global-count + reconcile: API count, then reconcile with walk (Bug B6)
//
// Bug B4 fix: zeroProductUrls hard-fail fires BEFORE drift check.

import { extractSitemapProducts } from './sitemap-products';
import { discoverCatalogUrls, discoverBreadcrumbCategories } from './catalog-urls';
import { selectCatalogSet, COVERAGE_TARGET_PCT, isViewAllUrl } from './select-catalog-set';
import { detectPagination } from './pagination-detect';
import { getGlobalCount, reconcileCountAfterWalk } from './global-count';
import { walkAndDedupe } from './walk-verify';
import type { AccessIdentityState, GeographyCountState, StageFailure } from '../shared/types';

export async function runGeographyCount(prev: AccessIdentityState): Promise<GeographyCountState | StageFailure> {

  // ─── Step 1: Extract sitemap product URL Set ─────────────────────────
  process.stderr.write(`  [Geography&Count] Step 1: sitemap product URL set\n`);
  const sitemap = await extractSitemapProducts(prev);

  // ─── Step 2: Multi-source catalog URL candidate discovery ────────────
  process.stderr.write(`  [Geography&Count] Step 2: catalog URL candidate discovery\n`);
  const sitemapProductUrlArray = sitemap.available ? [...sitemap.urlSet] : undefined;
  const cu = await discoverCatalogUrls(prev, sitemapProductUrlArray);

  if (cu.candidates.length === 0) {
    return fail('no catalogUrls discovered', {
      source: cu.source,
      sitemapAvailable: sitemap.available,
      sitemapProductCount: sitemap.productCount,
    });
  }

  // ─── Step 3: Pagination detection (before set-cover needs it for sampling) ──
  // testUrl preference order:
  //   1. Canonical-sorted URL (contains /orderby/ or ?sort=) — represents the
  //      runtime catalog the operator typically picks; perPage from this URL
  //      reflects the operator's chosen per-page setting.
  //   2. Category-pattern URL (/product-category/, /collections/, etc.).
  //   3. Highest page1ProductCount URL.
  process.stderr.write(`  [Geography&Count] Step 3: pagination detection\n`);
  const sortedCandidates = [...cu.candidates].sort((a, b) => b.page1ProductCount - a.page1ProductCount);
  const canonicalSortedCandidate = sortedCandidates.find(
    c => /\/orderby\/|[?&]sort/i.test(c.url)
  );
  const categoryCandidate = sortedCandidates.find(
    c => /\/(product-category|collections|categories|category|departments)\//i.test(c.url)
  );
  const bestForPagination = canonicalSortedCandidate || categoryCandidate || sortedCandidates[0];
  const pagRes = await detectPagination({ ...prev, catalogUrls: [bestForPagination.url, ...cu.candidates.filter(c => c.url !== bestForPagination.url).map(c => c.url)] });
  process.stderr.write(
    `  [Geography&Count] pagination: type=${pagRes.pattern.type}, perPage=${pagRes.pattern.perPage}, testA=${pagRes.evidence.testA_page1_vs_page2.passed}\n`
  );

  // ─── Step 4: Set-cover selection against sitemap ─────────────────────
  process.stderr.write(`  [Geography&Count] Step 4: set-cover selection\n`);

  // Fast path: when candidates come from a platform taxonomy API (WC product_cat,
  // Shopify collections.json) or category tree walk (BC Stencil) with many categories,
  // skip the expensive set-cover sampling. The taxonomy/tree already provides the correct
  // category set; sampling each one just wastes 50+ HTTP requests. The walk step does
  // the real dedup.
  let setCover: Awaited<ReturnType<typeof selectCatalogSet>>;
  const useFastPath = (cu.source === 'taxonomy-api' || cu.source === 'category-tree-walk') && cu.candidates.length > 15;
  if (useFastPath) {
    const productive = cu.candidates.filter(c => c.page1ProductCount >= 1);
    process.stderr.write(
      `  [set-cover] ${cu.source} fast path: ${productive.length} categories, skipping sampling\n`
    );
    setCover = {
      selectedCatalogUrls: productive.map(c => c.url),
      coveragePct: 0, // unknown until walk
      sitemapTotal: sitemap.urlSet.size,
      droppedForOverlap: [],
      candidateCoverage: productive.map(c => ({ url: c.url, estimatedCoverage: 0, selected: true })),
    };
  } else {
    setCover = await selectCatalogSet(prev, cu.candidates, sitemap.urlSet, pagRes.pattern);
  }

  if (setCover.selectedCatalogUrls.length === 0) {
    return fail('set-cover selected 0 catalog URLs', {
      candidateCount: cu.candidates.length,
      sitemapTotal: setCover.sitemapTotal,
    });
  }

  // If coverage is low and sitemap is available, try breadcrumb fallback
  // for categories not found by primary sources.
  // Skip when fast path was used — coverage is 0 by design (not sampled).
  if (!useFastPath && sitemap.available && setCover.coveragePct < COVERAGE_TARGET_PCT && sitemapProductUrlArray) {
    process.stderr.write(
      `  [Geography&Count] coverage ${setCover.coveragePct.toFixed(1)}% < ${COVERAGE_TARGET_PCT}% — trying breadcrumb fallback\n`
    );
    const existingUrls = new Set(setCover.selectedCatalogUrls.map(u => u.replace(/\/$/, '').toLowerCase()));
    const breadcrumbCandidates = await discoverBreadcrumbCategories(prev, sitemapProductUrlArray, existingUrls);
    if (breadcrumbCandidates.length > 0) {
      // Re-run set-cover with the expanded candidate set
      const allCandidates = [
        ...cu.candidates,
        ...breadcrumbCandidates,
      ];
      const setCover2 = await selectCatalogSet(prev, allCandidates, sitemap.urlSet, pagRes.pattern);
      if (setCover2.selectedCatalogUrls.length > 0) {
        // Use the expanded result
        Object.assign(setCover, setCover2);
      }
    }
  }

  process.stderr.write(
    `  [Geography&Count] selected ${setCover.selectedCatalogUrls.length} catalogUrls, coverage ${setCover.coveragePct.toFixed(1)}%\n`
  );

  // ─── Step 5: Walk every selected catalogUrl ──────────────────────────
  // Bug R2-4: Walk aggregator (view-all) URLs FIRST so their products are
  // not pre-seen via smaller category walks. This prevents the consecutive-
  // zero-NEW logic from wrongly truncating the aggregator walk.
  const sortedCatalogUrls = [...setCover.selectedCatalogUrls].sort((a, b) => {
    const aIsAgg = isViewAllUrl(a) ? 1 : 0;
    const bIsAgg = isViewAllUrl(b) ? 1 : 0;
    return bIsAgg - aIsAgg; // aggregators first
  });
  process.stderr.write(`  [Geography&Count] Step 5: walk-verify (${sortedCatalogUrls.length} urls, aggregators first)\n`);

  // Pre-fetch a rough global count estimate for walk page-cap calculation.
  // Use sitemap count if available, otherwise skip (walkAndDedupe uses 200-page default).
  const roughGlobalCount = sitemap.available ? sitemap.productCount : undefined;
  const walk = await walkAndDedupe(prev, sortedCatalogUrls, pagRes.pattern, roughGlobalCount);

  // Bug B4: Hard fail if ALL or MOST catalogUrls return 0 products on page 1
  // (sub-category tile trap or selector mismatch — Mistake 38).
  // This MUST fire BEFORE the drift check.
  // Note: some WC parent categories return 0 products (show tiles) — that's
  // normal when we also include their children. Only fail if extraction is
  // fundamentally broken (> 80% of URLs return 0).
  if (walk.zeroProductUrls.length > 0) {
    const zeroPct = (walk.zeroProductUrls.length / setCover.selectedCatalogUrls.length) * 100;
    if (zeroPct > 80) {
      return fail(
        `${walk.zeroProductUrls.length}/${setCover.selectedCatalogUrls.length} catalogUrls returned 0 products (selector mismatch — Mistake 38)`,
        { zeroProductUrls: walk.zeroProductUrls.slice(0, 10), walkCounts: walk.walkCounts },
      );
    }
    if (walk.zeroProductUrls.length > 0) {
      process.stderr.write(
        `  [Geography&Count] B4 warn: ${walk.zeroProductUrls.length} catalogUrls returned 0 products (${zeroPct.toFixed(0)}% — normal for WC parent tiles)\n`
      );
    }
  }

  if (walk.uniqueProductUrls.size === 0) {
    return fail('walk returned 0 products from all catalogUrls', { walkCounts: walk.walkCounts });
  }

  // ─── Step 6: Global count + reconcile ────────────────────────────────
  process.stderr.write(`  [Geography&Count] Step 6: global count + reconcile\n`);
  const gc = await getGlobalCount(
    prev,
    sitemap.available ? sitemap.productCount : undefined,
    sitemap.available ? { shards: sitemap.shardsConsulted, totalLocs: sitemap.totalLocs } : undefined,
  );

  // Bug B6: Reconcile — if walk > probe count (e.g. Celerant /perpage/9999 caps), trust walk
  const walkedCount = walk.uniqueProductUrls.size;
  const reconciledGc = reconcileCountAfterWalk(gc, walkedCount);

  const globalCount = reconciledGc?.count ?? walkedCount;
  const method = reconciledGc?.method ?? 'catalog-walk-only';
  const driftPct = reconciledGc ? Math.abs(globalCount - walkedCount) / globalCount * 100 : 0;

  // Bug R2-6: Log when sitemap appears incomplete vs walked count
  if (sitemap.available && sitemap.productCount > 0 && walkedCount > sitemap.productCount * 1.1) {
    process.stderr.write(
      `  [Geography&Count] R2-6 note: sitemap appears incomplete (${sitemap.productCount} sitemap URLs, walked ${walkedCount} — ` +
      `${((walkedCount / sitemap.productCount - 1) * 100).toFixed(0)}% more walked). ` +
      `Classifieds and newly-added products may lag in sitemap generation.\n`
    );
  }

  // Log when count sources disagree significantly (messy count target)
  if (sitemap.available && sitemap.productCount > 0 && reconciledGc) {
    const sitemapDelta = Math.abs(reconciledGc.count - sitemap.productCount) / Math.max(reconciledGc.count, sitemap.productCount) * 100;
    const walkDelta = Math.abs(walkedCount - reconciledGc.count) / Math.max(walkedCount, reconciledGc.count) * 100;
    if (sitemapDelta > 5 && walkDelta > 5) {
      process.stderr.write(
        `  [Geography&Count] count-source divergence: walked=${walkedCount}, ${reconciledGc.method}=${reconciledGc.count}, sitemap=${sitemap.productCount}. ` +
        `Possible: (a) sitemap includes drafts/hidden, (b) site targets firearm-relevant subset, (c) walk missed categories, (d) sitemap lags live.\n`
      );
    }
  }

  // Spec §4.3: drift > 5% is hard fail
  if (driftPct > 5) {
    return fail(
      `Drift ${driftPct.toFixed(2)}% exceeds 5% hard-fail threshold (walked=${walkedCount}, expected=${globalCount})`,
      {
        walkCounts: walk.walkCounts,
        globalCount,
        walkedCount,
        method,
        setCoverCoverage: setCover.coveragePct,
        sitemapTotal: setCover.sitemapTotal,
      },
    );
  }

  // ─── Step 7: Minimum-overlap pruning ────────────────────────────────
  // After walk-verify, walkCounts[i].uniqueProducts is the NEW-unique-products
  // contribution of catalogUrl i (deduped against everything walked before it).
  // For "minimum overlap" output (per feedback_catalog_urls_full_coverage.md), drop
  // catalogUrls whose NEW contribution is < 1% of total walked unique. This collapses
  // a 3-URL "/all-products/browse-orderby + /knives + /all-products/browse-default"
  // result down to the 1 URL that actually covers everything when one mega-URL exists,
  // while preserving the spine on platforms where each top-level category is disjoint.
  const PRUNE_THRESHOLD_PCT = 1; // <1% NEW contribution → redundant subset
  const finalCatalogUrls = walk.walkCounts
    .filter(wc => {
      const pct = walkedCount > 0 ? (wc.uniqueProducts / walkedCount) * 100 : 0;
      return pct >= PRUNE_THRESHOLD_PCT;
    })
    .map(wc => wc.url);
  // Safety: never produce empty catalogUrls — if pruning would remove everything
  // (degenerate input), keep the highest-contributing URL.
  if (finalCatalogUrls.length === 0 && walk.walkCounts.length > 0) {
    const top = [...walk.walkCounts].sort((a, b) => b.uniqueProducts - a.uniqueProducts)[0];
    finalCatalogUrls.push(top.url);
  }
  const droppedCount = setCover.selectedCatalogUrls.length - finalCatalogUrls.length;
  if (droppedCount > 0) {
    process.stderr.write(
      `  [Geography&Count] min-overlap pruning: dropped ${droppedCount} catalogUrl(s) with <${PRUNE_THRESHOLD_PCT}% NEW contribution; final ${finalCatalogUrls.length} URL(s)\n`
    );
  }

  return {
    ...prev,
    catalogUrls: finalCatalogUrls,
    catalogUrlSource: cu.source,
    catalogUrlWalkCounts: walk.walkCounts,
    walkedUniqueCount: walkedCount,
    globalProductCount: globalCount,
    globalProductCountMethod: method,
    globalProductCountEvidence: reconciledGc?.evidence ?? {},
    driftPct,
    coverageStrategy: reconciledGc && /api|wp-rest|store-api|shopify|ecwid|klevu/.test(method) ? 'api-walk'
                    : (reconciledGc ? 'hybrid' : 'html-walk'),
    paginationPattern: pagRes.pattern,
    paginationEvidence: pagRes.evidence,
  };

  function fail(reason: string, evidence: Record<string, unknown>): StageFailure {
    return { stageFailed: true, stageNumber: 3, reason, evidence, timestamp: new Date().toISOString() };
  }
}
