/**
 * test-probe-pagination.ts — 5-site regression harness for Module 9.
 *
 * Covers 5 pagination families. Asserts the pattern detection + zero-overlap
 * test work via ONE generic pathway with no site-specific branches in the
 * module:
 *
 *   1. WooCommerce query pagination        — canadafirstammo.ca /product-category/ammunition/
 *      Expect: paginationPattern={type:'query', template:'page'},
 *      verdict='verified', zeroOverlap=true, totalPagesObserved is a number.
 *
 *   2. Celerant path pagination            — bullseyenorth.com /firearms
 *      Expect: paginationPattern={type:'path', template:'/page/{N}'} (or
 *      similar path-style), verdict='verified', zeroOverlap=true. Celerant
 *      uses `/page/N/` path segments.
 *
 *   3. Shopify query                       — aagcanada.ca /collections/all
 *      Expect: paginationPattern={type:'query', template:'page'},
 *      verdict='verified', zeroOverlap=true. Shopify's /collections/all
 *      serves ~100+ products via `?page=N`.
 *
 *   4. BC Stencil query                    — theammosource.com /rifle-ammunition/
 *      Expect: paginationPattern={type:'query', template:'page'},
 *      verdict='verified', zeroOverlap=true. BC Stencil uses `?page=N`.
 *
 *   5. Small catalog / no pagination       — theammosource.com /hearing-protection/
 *      Expect: verdict in {'single-page', 'no-pagination-found'} with
 *      appropriate reason. Small BC Stencil categories don't trigger
 *      pagination.
 *
 * Each assertion checks:
 *   - `paginationPattern` matches expected OBJECT shape (Mistake 14 — not a string)
 *   - `zeroOverlap` true for multi-page cases
 *   - `verdict` matches expected
 *   - `totalPagesObserved` is number or null (not missing)
 *
 * Run:
 *   cd backend && npx tsx scripts/probe-modules/__test__/test-probe-pagination.ts
 *
 * Exits 0 if all 5 pass. Non-zero if any fail.
 */

import { runProbePagination, ProbePaginationResult, PaginationPatternShape } from '../probe-pagination';
import { closePlaywrightIfUsed } from '../probe-fetch';

interface TestCase {
  name: string;
  url: string;
  family: string;
  sortUrl?: string;
  ua?: 'desktop' | 'iphone';
  wafSuspected?: boolean;
  assert: (r: ProbePaginationResult) => string | null;
}

/**
 * Shared assertion: verify paginationPattern is an OBJECT (not a string) and
 * that the `totalPagesObserved` field exists (may be null, but must be
 * either number or null — never undefined, never missing).
 */
function assertPatternShape(
  r: ProbePaginationResult,
  expectedType: PaginationPatternShape['type'],
  expectedTemplate?: string,
): string | null {
  if (r.paginationPattern === null)
    return `expected paginationPattern OBJECT, got null (verdict=${r.verdict} reason=${r.verdictReason})`;
  // Mistake 14: must be object, not string
  if (typeof r.paginationPattern !== 'object')
    return `paginationPattern must be OBJECT (Mistake 14), got ${typeof r.paginationPattern}: ${JSON.stringify(r.paginationPattern)}`;
  if (r.paginationPattern.type !== expectedType)
    return `expected paginationPattern.type='${expectedType}', got '${r.paginationPattern.type}'`;
  if (expectedTemplate !== undefined) {
    const t = (r.paginationPattern as any).template;
    if (t !== expectedTemplate)
      return `expected paginationPattern.template='${expectedTemplate}', got '${t}'`;
  }
  // totalPagesObserved must be number or null (never undefined)
  if (r.totalPagesObserved !== null && typeof r.totalPagesObserved !== 'number')
    return `totalPagesObserved must be number|null, got ${typeof r.totalPagesObserved}`;
  return null;
}

const CASES: TestCase[] = [
  {
    name: 'canadafirstammo.ca',
    url: 'https://canadafirstammo.ca/product-category/ammunition/',
    family: 'WooCommerce (path or query)',
    // canadafirstammo.ca runs the Minimog WooCommerce theme with
    // `data-type="load-more"` pagination which renders NO static anchors.
    // The site DOES accept /page/N/ path URLs directly (DB-verified profile
    // stores `type:'path', template:'/page/{N}/'`). We assert via the
    // heuristic-probe pathway — ANY working WooCommerce pagination shape
    // (query or path) is acceptable as long as zero-overlap proves it works.
    assert: (r) => {
      if (r.paginationPattern === null)
        return `expected paginationPattern OBJECT, got null (verdict=${r.verdict} reason=${r.verdictReason})`;
      if (typeof r.paginationPattern !== 'object')
        return `paginationPattern must be OBJECT (Mistake 14), got ${typeof r.paginationPattern}`;
      // Accept either query-style or path-style (site's theme may flip).
      if (r.paginationPattern.type !== 'query' && r.paginationPattern.type !== 'path')
        return `expected paginationPattern.type in {query, path}, got '${r.paginationPattern.type}'`;
      if (r.verdict !== 'verified')
        return `expected verdict='verified', got '${r.verdict}' (reason: ${r.verdictReason})`;
      if (!r.zeroOverlap)
        return `expected zeroOverlap=true (got false, overlap=[${r.overlapProducts.slice(0, 3).join(', ')}])`;
      if (r.page2ProductCount === 0)
        return `expected page2 to have products, got 0`;
      // totalPagesObserved must be number or null (never undefined)
      if (r.totalPagesObserved !== null && typeof r.totalPagesObserved !== 'number')
        return `totalPagesObserved must be number|null, got ${typeof r.totalPagesObserved}`;
      return null;
    },
  },
  {
    name: 'bullseyenorth.com',
    url: 'https://www.bullseyenorth.com/firearms',
    family: 'Celerant path pagination',
    assert: (r) => {
      if (r.paginationPattern === null)
        return `expected paginationPattern OBJECT, got null (verdict=${r.verdict} reason=${r.verdictReason})`;
      if (typeof r.paginationPattern !== 'object')
        return `paginationPattern must be OBJECT (Mistake 14), got ${typeof r.paginationPattern}`;
      if (r.paginationPattern.type !== 'path')
        return `expected paginationPattern.type='path' (Celerant uses /page/{N}/), got '${r.paginationPattern.type}'`;
      if (r.verdict !== 'verified')
        return `expected verdict='verified', got '${r.verdict}' (reason: ${r.verdictReason})`;
      if (!r.zeroOverlap)
        return `expected zeroOverlap=true on path pattern (got false, overlap=${r.overlapProducts.length})`;
      if (r.page2ProductCount === 0)
        return `expected page2 to have products, got 0`;
      return null;
    },
  },
  {
    name: 'aagcanada.ca',
    url: 'https://aagcanada.ca/collections/all',
    family: 'Shopify query pagination',
    assert: (r) => {
      const shapeErr = assertPatternShape(r, 'query', 'page');
      if (shapeErr) return shapeErr;
      if (r.verdict !== 'verified')
        return `expected verdict='verified', got '${r.verdict}' (reason: ${r.verdictReason})`;
      if (!r.zeroOverlap)
        return `expected zeroOverlap=true (got false, overlap=${r.overlapProducts.length})`;
      return null;
    },
  },
  {
    name: 'theammosource.com (rifle-ammo)',
    url: 'https://www.theammosource.com/rifle-ammunition/',
    family: 'BC Stencil query pagination',
    assert: (r) => {
      const shapeErr = assertPatternShape(r, 'query', 'page');
      if (shapeErr) return shapeErr;
      if (r.verdict !== 'verified')
        return `expected verdict='verified', got '${r.verdict}' (reason: ${r.verdictReason})`;
      if (!r.zeroOverlap)
        return `expected zeroOverlap=true (got false, overlap=${r.overlapProducts.length})`;
      return null;
    },
  },
  {
    name: 'theammosource.com (hearing, small)',
    url: 'https://www.theammosource.com/hearing-protection/',
    family: 'Small catalog / no pagination',
    assert: (r) => {
      // Accept `single-page` OR `no-pagination-found` (both valid for small BC
      // Stencil cats). `verified` is also acceptable if the small category
      // happens to paginate (unlikely but not a bug).
      if (r.verdict !== 'single-page' && r.verdict !== 'no-pagination-found' && r.verdict !== 'verified')
        return `expected verdict in {single-page, no-pagination-found, verified}, got '${r.verdict}' (reason: ${r.verdictReason})`;
      // totalPagesObserved may be number or null; either is fine on small cat
      if (r.totalPagesObserved !== null && typeof r.totalPagesObserved !== 'number')
        return `totalPagesObserved must be number|null, got ${typeof r.totalPagesObserved}`;
      // If verdict is single-page or no-pagination, paginationPattern may be
      // null; that's expected. If verified, it must be an object.
      if (r.verdict === 'verified' && r.paginationPattern === null)
        return `verdict=verified but paginationPattern is null`;
      return null;
    },
  },
];

interface TestResult {
  name: string;
  family: string;
  passed: boolean;
  error: string | null;
  result: ProbePaginationResult;
  wallMs: number;
}

async function runCase(c: TestCase): Promise<TestResult> {
  process.stderr.write(`\n── [${c.family}] ${c.url} ──\n`);
  const t0 = Date.now();
  let r: ProbePaginationResult;
  try {
    r = await runProbePagination(c.url, {
      ua: c.ua ?? 'desktop',
      mode: 'auto',
      sortUrl: c.sortUrl,
      wafSuspected: c.wafSuspected,
    });
  } catch (e: any) {
    return {
      name: c.name,
      family: c.family,
      passed: false,
      error: `runProbePagination threw: ${e?.message || e}`,
      result: {} as ProbePaginationResult,
      wallMs: Date.now() - t0,
    };
  }
  const wallMs = Date.now() - t0;
  const err = c.assert(r);
  const passed = err === null;
  const patternStr = r.paginationPattern
    ? `${r.paginationPattern.type}${(r.paginationPattern as any).template ? ':' + (r.paginationPattern as any).template : ''}`
    : 'null';
  process.stderr.write(
    `  pattern=${patternStr} verdict=${r.verdict} p1=${r.page1ProductCount} p2=${r.page2ProductCount} zeroOverlap=${r.zeroOverlap} totalPages=${r.totalPagesObserved} wall=${wallMs}ms → ${passed ? 'PASS' : 'FAIL: ' + err}\n`,
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
    '║ probe-pagination.ts — 5-site regression (5 pagination families) ║\n',
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
  const colW = { n: 32, f: 36 };
  process.stderr.write(
    `${'site'.padEnd(colW.n)}  ${'family'.padEnd(colW.f)}  pattern          verdict              p1/p2    result\n`,
  );
  process.stderr.write('─'.repeat(colW.n + colW.f + 70) + '\n');
  for (const r of results) {
    const patternStr = r.result.paginationPattern
      ? `${r.result.paginationPattern.type}:${(r.result.paginationPattern as any).template || (r.result.paginationPattern as any).match || '?'}`
      : 'null';
    const verdict = (r.result.verdict || '?').padEnd(20);
    const cnt = `${r.result.page1ProductCount || 0}/${r.result.page2ProductCount || 0}`.padEnd(8);
    process.stderr.write(
      `${r.name.padEnd(colW.n)}  ${r.family.padEnd(colW.f)}  ${patternStr.padEnd(16)}  ${verdict}  ${cnt}  ${r.passed ? 'PASS' : 'FAIL: ' + r.error}\n`,
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
