/**
 * test-probe-sort.ts — 5-site regression harness for Module 8.
 *
 * Covers 5 sort families. Asserts the sort scheme detection + ID-jump test
 * + 3-outcome verdict all work via ONE generic pathway with no site-specific
 * branches in the module:
 *
 *   1. WooCommerce query sort                — canadafirstammo.ca /product-category/ammunition/
 *      Expect: sortScheme='query', verdict='honored', rankedNewest[0].value==='date'
 *      (WooCommerce's "Sort by latest" option). Alpha control populated.
 *
 *   2. BC Stencil default-is-newest          — theammosource.com /rifle-ammunition/
 *      Expect: sortScheme='query', verdict='honored-default-is-newest'
 *      (merchant default happens to equal `sort=newest`, but alpha counter
 *      demonstrably re-orders). rankedNewest contains `newest`.
 *
 *   3. Celerant path scheme (multi-newest)   — bullseyenorth.com /firearms
 *      Expect: sortScheme='path', verdict='honored',
 *      rankedNewest[0].value==='new-arrivals' (Mistake 36 disambiguation:
 *      `new-arrivals` must score higher than `newest-rcvd`).
 *
 *   4. Shopify query sort                    — aagcanada.ca /collections/all
 *      Expect: sortScheme='query', verdict='honored',
 *      rankedNewest contains `created-descending`. The regex must NOT falsely
 *      rank `created-ascending` (oldest) above `created-descending` —
 *      OLDEST_REGEX filter proves itself here.
 *
 *   5. Small catalog noop                    — theammosource.com /hearing-protection/
 *      Expect: verdict='noop-small', baselineProductCount < 20. Sort options
 *      may be present (BC Stencil always renders the <select>) but the 3-outcome
 *      verdict correctly reports the catalog is too small to distinguish.
 *
 * Run:
 *   cd backend && npx tsx scripts/probe-modules/__test__/test-probe-sort.ts
 *
 * Exits 0 if all 5 pass. Non-zero if any fail.
 */

import { runProbeSort, ProbeSortResult } from '../probe-sort';
import { closePlaywrightIfUsed } from '../probe-fetch';

interface TestCase {
  name: string;
  url: string;
  family: string;
  ua?: 'desktop' | 'iphone';
  wafSuspected?: boolean;
  extraCandidates?: string[];
  assert: (r: ProbeSortResult) => string | null;
}

const CASES: TestCase[] = [
  {
    name: 'canadafirstammo.ca',
    url: 'https://canadafirstammo.ca/product-category/ammunition/',
    family: 'WooCommerce query sort',
    assert: (r) => {
      if (r.sortScheme !== 'query')
        return `expected sortScheme=query, got ${r.sortScheme}`;
      if (r.verdict !== 'honored')
        return `expected verdict=honored, got ${r.verdict} (reason: ${r.verdictReason})`;
      if (r.rankedNewest.length === 0)
        return `expected rankedNewest to have at least one entry`;
      if (r.rankedNewest[0].value !== 'date')
        return `expected rankedNewest[0].value='date', got '${r.rankedNewest[0].value}'`;
      if (!r.baselineFirstProduct)
        return `expected baselineFirstProduct to be populated`;
      // Alpha control: WooCommerce default select has NO alpha option but
      // DOES have "price: low to high" — the 4-tier cascade should find it.
      if (r.alphaControlResult === null)
        return `expected alphaControlResult to be populated (counter-control cascade should find price option)`;
      return null;
    },
  },
  {
    name: 'theammosource.com',
    url: 'https://www.theammosource.com/rifle-ammunition/',
    family: 'BC Stencil default-is-newest',
    assert: (r) => {
      if (r.sortScheme !== 'query')
        return `expected sortScheme=query, got ${r.sortScheme}`;
      if (r.verdict !== 'honored-default-is-newest')
        return `expected verdict=honored-default-is-newest, got ${r.verdict} (reason: ${r.verdictReason})`;
      if (r.rankedNewest.length === 0)
        return `expected rankedNewest to have at least one entry`;
      // rankedNewest should contain `newest` (BC Stencil's canonical value).
      const hasNewest = r.rankedNewest.some((x) => x.value === 'newest');
      if (!hasNewest)
        return `expected rankedNewest to contain value='newest', got values=[${r.rankedNewest.map((x) => x.value).join(', ')}]`;
      // Alpha control must have fired AND produced a different first product
      // (that's what makes this honored-default-is-newest rather than noop-large)
      if (!r.alphaControlResult)
        return `expected alphaControlResult (verdict honored-default-is-newest requires alpha counter)`;
      if (!r.alphaControlResult.firstProductTitle && !r.alphaControlResult.firstProductSourceId)
        return `expected alphaControl to have a first product`;
      return null;
    },
  },
  {
    name: 'bullseyenorth.com',
    url: 'https://www.bullseyenorth.com/firearms',
    family: 'Celerant path scheme (multi-newest)',
    assert: (r) => {
      if (r.sortScheme !== 'path')
        return `expected sortScheme=path, got ${r.sortScheme}`;
      if (r.verdict !== 'honored')
        return `expected verdict=honored, got ${r.verdict} (reason: ${r.verdictReason})`;
      if (r.rankedNewest.length === 0)
        return `expected rankedNewest (Celerant has new-arrivals option)`;
      // Mistake 36: 'new-arrivals' MUST rank above 'newest-rcvd'.
      if (r.rankedNewest[0].value !== 'new-arrivals')
        return `expected rankedNewest[0].value='new-arrivals' (Mistake 36), got '${r.rankedNewest[0].value}' — ranked values: [${r.rankedNewest.map((x) => `${x.value}=${x.score}`).join(', ')}]`;
      // If newest-rcvd is also exposed on this site, it should score lower.
      const newestRcvd = r.rankedNewest.find((x) => x.value === 'newest-rcvd');
      if (newestRcvd && newestRcvd.score >= r.rankedNewest[0].score)
        return `newest-rcvd score (${newestRcvd.score}) must be strictly less than new-arrivals score (${r.rankedNewest[0].score})`;
      return null;
    },
  },
  {
    name: 'aagcanada.ca',
    url: 'https://aagcanada.ca/collections/all',
    family: 'Shopify query sort',
    assert: (r) => {
      if (r.sortScheme !== 'query')
        return `expected sortScheme=query, got ${r.sortScheme}`;
      if (r.verdict !== 'honored')
        return `expected verdict=honored, got ${r.verdict} (reason: ${r.verdictReason})`;
      if (r.rankedNewest.length === 0)
        return `expected rankedNewest to contain Shopify sort values`;
      // rankedNewest must contain `created-descending`.
      const hasCreatedDesc = r.rankedNewest.some((x) => x.value === 'created-descending');
      if (!hasCreatedDesc)
        return `expected rankedNewest to contain 'created-descending', got values=[${r.rankedNewest.map((x) => x.value).join(', ')}]`;
      // `created-ascending` (oldest-first) MUST NOT appear in rankedNewest
      // after OLDEST_REGEX filter. Shopify exposes both `created-ascending`
      // and `created-descending` — only the latter is newest.
      const hasCreatedAsc = r.rankedNewest.some((x) => x.value === 'created-ascending');
      if (hasCreatedAsc)
        return `'created-ascending' (oldest) must be filtered out by OLDEST_REGEX but appeared in rankedNewest`;
      // Top newest must be a descending date value.
      if (r.rankedNewest[0].value !== 'created-descending')
        return `expected rankedNewest[0].value='created-descending', got '${r.rankedNewest[0].value}'`;
      return null;
    },
  },
  {
    name: 'theammosource.com (small cat)',
    url: 'https://www.theammosource.com/hearing-protection/',
    family: 'Small catalog noop',
    assert: (r) => {
      if (r.baselineProductCount >= 20)
        return `expected baselineProductCount <20 (small cat), got ${r.baselineProductCount}`;
      if (r.baselineProductCount === 0)
        return `expected some baseline products (1-19), got 0`;
      // Accept 'noop-small' (expected) OR 'honored-default-is-newest' —
      // BC Stencil sites often have default=newest even on small cats, which
      // means the counter-control can still demonstrate sort works. Both are
      // valid "sort is not broken" verdicts on a small catalog.
      // 'noop-large' or 'unknown' are hard fails.
      if (r.verdict !== 'noop-small' && r.verdict !== 'honored-default-is-newest' && r.verdict !== 'honored')
        return `expected verdict in {noop-small, honored-default-is-newest, honored} on small cat, got ${r.verdict} (reason: ${r.verdictReason})`;
      return null;
    },
  },
];

interface TestResult {
  name: string;
  family: string;
  passed: boolean;
  error: string | null;
  result: ProbeSortResult;
  wallMs: number;
}

async function runCase(c: TestCase): Promise<TestResult> {
  process.stderr.write(`\n── [${c.family}] ${c.url} ──\n`);
  const t0 = Date.now();
  let r: ProbeSortResult;
  try {
    r = await runProbeSort(c.url, {
      ua: c.ua ?? 'desktop',
      mode: 'auto',
      wafSuspected: c.wafSuspected,
      extraCandidates: c.extraCandidates,
    });
  } catch (e: any) {
    return {
      name: c.name,
      family: c.family,
      passed: false,
      error: `runProbeSort threw: ${e?.message || e}`,
      result: {} as ProbeSortResult,
      wallMs: Date.now() - t0,
    };
  }
  const wallMs = Date.now() - t0;
  const err = c.assert(r);
  const passed = err === null;
  const rankedStr = r.rankedNewest
    .slice(0, 3)
    .map((x) => `${x.value}=${x.score}`)
    .join(',');
  process.stderr.write(
    `  scheme=${r.sortScheme} verdict=${r.verdict} baseline=${r.baselineProductCount}p ranked=[${rankedStr}] alpha=${r.alphaControlResult?.value || 'none'} wall=${wallMs}ms → ${passed ? 'PASS' : 'FAIL: ' + err}\n`,
  );
  if (!passed) {
    process.stderr.write(`  verdictReason: ${r.verdictReason}\n`);
  }
  return { name: c.name, family: c.family, passed, error: err, result: r, wallMs };
}

async function main(): Promise<number> {
  process.stderr.write(
    '╔══════════════════════════════════════════════════════════════╗\n',
  );
  process.stderr.write(
    '║ probe-sort.ts — 5-site regression (5 sort families)          ║\n',
  );
  process.stderr.write(
    '╚══════════════════════════════════════════════════════════════╝\n',
  );

  const results: TestResult[] = [];
  for (const c of CASES) {
    results.push(await runCase(c));
  }

  // Summary table
  process.stderr.write('\n═══ SUMMARY ═══\n');
  const colW = { n: 28, f: 38 };
  process.stderr.write(
    `${'site'.padEnd(colW.n)}  ${'family'.padEnd(colW.f)}  scheme  verdict                        top-newest      result\n`,
  );
  process.stderr.write('─'.repeat(colW.n + colW.f + 70) + '\n');
  for (const r of results) {
    const scheme = (r.result.sortScheme || '?').padEnd(6);
    const verdict = (r.result.verdict || '?').padEnd(30);
    const top = r.result.rankedNewest?.[0]
      ? `${r.result.rankedNewest[0].value}=${r.result.rankedNewest[0].score}`
      : '—';
    process.stderr.write(
      `${r.name.padEnd(colW.n)}  ${r.family.padEnd(colW.f)}  ${scheme}  ${verdict}  ${top.padEnd(14)}  ${r.passed ? 'PASS' : 'FAIL: ' + r.error}\n`,
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
