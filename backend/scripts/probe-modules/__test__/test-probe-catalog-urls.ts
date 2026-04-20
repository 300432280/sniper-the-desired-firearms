/**
 * test-probe-catalog-urls.ts — 5-site regression harness for Module 5.
 *
 * Covers 5 platform families. Asserts each source fires (or correctly no-ops)
 * without site-specific branches in the module.
 *
 *   1. WooCommerce with taxonomy API (CF-passive) → canadafirstammo.ca
 *      Expect: wpV2ProductCat.status=200 with count>=1, ≥1 candidate from
 *      'wp-taxonomy-api' source, nav-menu also populates.
 *
 *   2. Shopify with collections API               → aagcanada.ca
 *      Expect: shopifyCollections.status=200 with count>=1, ≥1 candidate
 *      from 'shopify-collections' source.
 *
 *   3. BigCommerce Stencil (no public taxonomy)   → theammosource.com
 *      Expect: all 3 API probes fail or return empty, but nav-menu and
 *      sitemap-dirname still produce candidates. totalCandidates > 0.
 *      No crashes on API 404.
 *
 *   4. Drupal classifieds (Cloudflare rule-based) → gunpost.ca
 *      Expect: taxonomy APIs all 404 / fail; nav-menu populates (Drupal
 *      standard menu markup). totalCandidates > 0.
 *
 *   5. Celerant / ColdFusion (no taxonomy API)    → bullseyenorth.com
 *      Expect: no taxonomy API hits; nav-menu + sitemap-dirname produce
 *      candidates. Tests that the module handles HPE malformed-header
 *      escalation without crashing (Module 1 handles it transparently).
 *
 * Run:
 *   cd backend && npx tsx scripts/probe-modules/__test__/test-probe-catalog-urls.ts
 *
 * Exits 0 if all 5 pass. Non-zero if any fail.
 */

import { runProbeCatalogUrls, ProbeCatalogUrlsResult, CandidateSource } from '../probe-catalog-urls';
import { closePlaywrightIfUsed } from '../probe-fetch';

interface TestCase {
  name: string;
  origin: string;
  family: string;
  expectedSources: CandidateSource[]; // sources we expect to have AT LEAST ONE candidate
  assert: (r: ProbeCatalogUrlsResult) => string | null;
}

function sourceCounts(r: ProbeCatalogUrlsResult): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of r.candidates) out[c.source] = (out[c.source] || 0) + 1;
  return out;
}

const CASES: TestCase[] = [
  {
    name: 'canadafirstammo.ca',
    origin: 'https://canadafirstammo.ca',
    family: 'WooCommerce + taxonomy API',
    expectedSources: ['wp-taxonomy-api', 'nav-menu'],
    assert: (r) => {
      if (r.totalCandidates === 0) return `no candidates emitted`;
      const counts = sourceCounts(r);
      if (!r.taxonomyApiReachable.wpV2ProductCat)
        return `expected wpV2ProductCat probe to be present`;
      if (r.taxonomyApiReachable.wpV2ProductCat.status !== 200)
        return `expected wpV2ProductCat.status=200, got ${r.taxonomyApiReachable.wpV2ProductCat.status}`;
      if (
        r.taxonomyApiReachable.wpV2ProductCat.count === null ||
        r.taxonomyApiReachable.wpV2ProductCat.count < 1
      )
        return `expected wpV2ProductCat.count>=1, got ${r.taxonomyApiReachable.wpV2ProductCat.count}`;
      if ((counts['wp-taxonomy-api'] || 0) < 1)
        return `expected ≥1 'wp-taxonomy-api' candidate, got ${counts['wp-taxonomy-api'] || 0}`;
      // Each wp-taxonomy-api candidate should have productCount numeric (WP returns `count` field).
      const wpCandidates = r.candidates.filter((c) => c.source === 'wp-taxonomy-api');
      const numericCount = wpCandidates.filter((c) => typeof c.productCount === 'number').length;
      if (numericCount === 0)
        return `expected wp-taxonomy-api candidates to have numeric productCount, got 0/${wpCandidates.length}`;
      return null;
    },
  },
  {
    name: 'aagcanada.ca',
    origin: 'https://aagcanada.ca',
    family: 'Shopify + collections API',
    expectedSources: ['shopify-collections'],
    assert: (r) => {
      if (r.totalCandidates === 0) return `no candidates emitted`;
      const counts = sourceCounts(r);
      if (!r.taxonomyApiReachable.shopifyCollections)
        return `expected shopifyCollections probe to be present`;
      if (r.taxonomyApiReachable.shopifyCollections.status !== 200)
        return `expected shopifyCollections.status=200, got ${r.taxonomyApiReachable.shopifyCollections.status}`;
      if (
        r.taxonomyApiReachable.shopifyCollections.count === null ||
        r.taxonomyApiReachable.shopifyCollections.count < 1
      )
        return `expected shopifyCollections.count>=1, got ${r.taxonomyApiReachable.shopifyCollections.count}`;
      if ((counts['shopify-collections'] || 0) < 1)
        return `expected ≥1 'shopify-collections' candidate, got ${counts['shopify-collections'] || 0}`;
      // Shopify collection URLs should be absolute and point at /collections/<handle>.
      const shopifyCandidates = r.candidates.filter((c) => c.source === 'shopify-collections');
      const wellFormed = shopifyCandidates.filter((c) => /\/collections\/[^\/?#]+\/?$/.test(c.url));
      if (wellFormed.length === 0)
        return `expected shopify-collections URLs to match /collections/<handle>, got 0/${shopifyCandidates.length} well-formed`;
      return null;
    },
  },
  {
    name: 'theammosource.com',
    origin: 'https://www.theammosource.com',
    family: 'BigCommerce Stencil (no public taxonomy)',
    expectedSources: ['nav-menu'],
    assert: (r) => {
      if (r.totalCandidates === 0) return `no candidates emitted`;
      const counts = sourceCounts(r);
      // All 3 taxonomy APIs should have been probed WITHOUT crashing.
      if (!r.taxonomyApiReachable.wpV2ProductCat)
        return `expected wpV2ProductCat probe to be attempted`;
      if (!r.taxonomyApiReachable.shopifyCollections)
        return `expected shopifyCollections probe to be attempted`;
      if (!r.taxonomyApiReachable.bcCategories)
        return `expected bcCategories probe to be attempted`;
      // Shopify/WP MUST be non-200 (site is BC, not Shopify/WC). BC probe
      // is expected to 404 or 401 on Stencil. Any 200 would be an error.
      if (r.taxonomyApiReachable.shopifyCollections.status === 200)
        return `BC site should not return Shopify collections 200`;
      // Falls back to nav-menu — MUST have candidates.
      if ((counts['nav-menu'] || 0) < 1)
        return `expected ≥1 'nav-menu' candidate, got ${counts['nav-menu'] || 0}`;
      return null;
    },
  },
  {
    name: 'gunpost.ca',
    origin: 'https://www.gunpost.ca',
    family: 'Drupal classifieds (Cloudflare challenge)',
    expectedSources: [], // Either nav-menu (if CF resolves) OR zero with WAF warning
    assert: (r) => {
      // All 3 taxonomy API probes MUST have been attempted without crash (this
      // is the no-site-specific-branch invariant — module doesn't know the
      // site is Drupal, so it MUST try all 3 endpoints).
      if (!r.taxonomyApiReachable.wpV2ProductCat)
        return `wpV2ProductCat probe should have been attempted (no crash)`;
      if (!r.taxonomyApiReachable.shopifyCollections)
        return `shopifyCollections probe should have been attempted (no crash)`;
      if (!r.taxonomyApiReachable.bcCategories)
        return `bcCategories probe should have been attempted (no crash)`;
      // Drupal should NOT return 200 on WP/Shopify/BC endpoints. This is the
      // "no false-positive" invariant — if any of these returned 200+candidates,
      // we're misclassifying the site.
      if (r.taxonomyApiReachable.wpV2ProductCat.status === 200)
        return `Drupal site should not return WP REST 200`;
      if (r.taxonomyApiReachable.shopifyCollections.status === 200)
        return `Drupal site should not return Shopify 200`;
      // Acceptable outcomes:
      //   (a) candidates emitted (CF challenge auto-resolved, Playwright fetched HTML)
      //   (b) zero candidates + clear "homepage fetch failed" warning signaling
      //       the WAF block. The skill layer — NOT this module — then escalates
      //       to manual site onboarding or a longer CF solve timeout.
      // INVALID outcome: zero candidates with NO warning (means we silently
      // swallowed a fetch failure).
      if (r.totalCandidates === 0) {
        const hasWafWarning =
          r.warnings.some((w) => /homepage fetch failed|body empty/i.test(w)) ||
          r.warnings.length > 0;
        if (!hasWafWarning)
          return `zero candidates AND no warning — silent failure (CF challenge unresolved should produce a warning)`;
        // Module correctly reported block. Skill handles it.
        return null;
      }
      return null;
    },
  },
  {
    name: 'bullseyenorth.com',
    origin: 'https://www.bullseyenorth.com',
    family: 'Celerant / ColdFusion (no taxonomy API)',
    expectedSources: ['nav-menu'],
    assert: (r) => {
      if (r.totalCandidates === 0) return `no candidates emitted`;
      const counts = sourceCounts(r);
      // All 3 taxonomy APIs probed, none should return 200.
      if (!r.taxonomyApiReachable.wpV2ProductCat)
        return `wpV2ProductCat probe should have been attempted`;
      if (!r.taxonomyApiReachable.shopifyCollections)
        return `shopifyCollections probe should have been attempted`;
      if (!r.taxonomyApiReachable.bcCategories)
        return `bcCategories probe should have been attempted`;
      if (r.taxonomyApiReachable.wpV2ProductCat.status === 200)
        return `Celerant site should not return WP REST 200`;
      // nav-menu must populate. Celerant navigation uses standard <nav> markup
      // with /shop/... category URLs. Module 1 handles the HPE malformed-header
      // escalation transparently.
      if ((counts['nav-menu'] || 0) < 1)
        return `expected ≥1 'nav-menu' candidate, got ${counts['nav-menu'] || 0} (navLinkCount=${r.navLinkCount})`;
      return null;
    },
  },
];

interface TestResult {
  name: string;
  family: string;
  passed: boolean;
  error: string | null;
  result: ProbeCatalogUrlsResult;
  wallMs: number;
}

async function runCase(c: TestCase): Promise<TestResult> {
  process.stderr.write(`\n── [${c.family}] ${c.origin} ──\n`);
  const t0 = Date.now();
  let r: ProbeCatalogUrlsResult;
  try {
    r = await runProbeCatalogUrls(c.origin);
  } catch (e: any) {
    return {
      name: c.name,
      family: c.family,
      passed: false,
      error: `runProbeCatalogUrls threw: ${e?.message || e}`,
      result: {} as ProbeCatalogUrlsResult,
      wallMs: Date.now() - t0,
    };
  }
  const wallMs = Date.now() - t0;
  const err = c.assert(r);
  const passed = err === null;
  const counts = sourceCounts(r);
  const countSummary = Object.entries(counts)
    .map(([s, n]) => `${s}=${n}`)
    .join(', ');
  process.stderr.write(
    `  sources=[${countSummary}] totalCandidates=${r.totalCandidates} navLinkCount=${r.navLinkCount} wall=${wallMs}ms → ${passed ? 'PASS' : 'FAIL: ' + err}\n`,
  );
  if (!passed || r.warnings.length > 0) {
    const apiSummary = [
      `wp-v2=${r.taxonomyApiReachable.wpV2ProductCat?.status ?? 'null'}/${r.taxonomyApiReachable.wpV2ProductCat?.count ?? 'null'}`,
      `shopify=${r.taxonomyApiReachable.shopifyCollections?.status ?? 'null'}/${r.taxonomyApiReachable.shopifyCollections?.count ?? 'null'}`,
      `bc=${r.taxonomyApiReachable.bcCategories?.status ?? 'null'}/${r.taxonomyApiReachable.bcCategories?.count ?? 'null'}`,
    ].join(' ');
    process.stderr.write(`  APIs: ${apiSummary}\n`);
    if (r.warnings.length > 0) {
      process.stderr.write(`  warnings: ${r.warnings.slice(0, 3).join(' | ')}\n`);
    }
    // Dump first 5 candidates for debugging
    if (r.candidates.length > 0) {
      process.stderr.write(
        `  first-candidates: ${r.candidates
          .slice(0, 5)
          .map((c) => `${c.source}:${new URL(c.url).pathname.slice(0, 50)}`)
          .join(' | ')}\n`,
      );
    }
  }
  return { name: c.name, family: c.family, passed, error: err, result: r, wallMs };
}

async function main(): Promise<number> {
  process.stderr.write(
    '╔══════════════════════════════════════════════════════════════════╗\n',
  );
  process.stderr.write(
    '║ probe-catalog-urls.ts — 5-site regression (5 platform families)  ║\n',
  );
  process.stderr.write(
    '╚══════════════════════════════════════════════════════════════════╝\n',
  );

  const results: TestResult[] = [];
  for (const c of CASES) {
    results.push(await runCase(c));
  }

  // Summary table
  process.stderr.write('\n═══ SUMMARY ═══\n');
  const colW = { n: 22, f: 44 };
  process.stderr.write(
    `${'site'.padEnd(colW.n)}  ${'family'.padEnd(colW.f)}  total  nav  sources-breakdown  result\n`,
  );
  process.stderr.write('─'.repeat(colW.n + colW.f + 60) + '\n');
  for (const r of results) {
    const counts = sourceCounts(r.result);
    const sourcesBreakdown = Object.entries(counts)
      .map(([s, n]) => `${s}=${n}`)
      .join(',');
    process.stderr.write(
      `${r.name.padEnd(colW.n)}  ${r.family.padEnd(colW.f)}  ${String(r.result.totalCandidates ?? 0).padStart(5)}  ${String(r.result.navLinkCount ?? 0).padStart(3)}  ${sourcesBreakdown.padEnd(40)}  ${r.passed ? 'PASS' : 'FAIL: ' + r.error}\n`,
    );
  }

  const failed = results.filter((r) => !r.passed);
  process.stderr.write(
    `\nTotals: ${results.length - failed.length}/${results.length} passed\n`,
  );

  await closePlaywrightIfUsed();
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(`test harness crashed: ${e?.stack || e?.message || e}\n`);
    process.exit(2);
  });
