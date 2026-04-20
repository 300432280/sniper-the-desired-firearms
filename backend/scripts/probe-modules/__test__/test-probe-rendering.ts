/**
 * test-probe-rendering.ts — 5-site regression harness for Module 7.
 *
 * Covers 5 platform/access families. Asserts that the static-vs-Playwright
 * comparison emits the correct verdict and short-circuits when appropriate,
 * all via ONE generic pathway with no site-specific branches.
 *
 *   1. BC Stencil static-HTML                → theammosource.com /rifle-ammunition/
 *      Expect: verdict='static-ok', needsPlaywright=false, SHORT-CIRCUIT
 *      (playwrightFetch===null proves Playwright was NOT called — the 20s
 *      Playwright cost was saved). Static returns 20-52+ products.
 *
 *   2. WooCommerce + Sucuri WAF              → gotenda.com /product-category/firearms/handguns/
 *      Static gets 307+1.3KB Sucuri challenge → 0 products (mode='static'
 *      suppresses probe-fetch's WAF escalation). Playwright handles the
 *      challenge via production waf-cookie-manager logic and extracts 20+
 *      real products. Expect verdict='static-zero-playwright-ok',
 *      needsPlaywright=true. This serves as the "known-requires-Playwright"
 *      case — WAF-gated content is indistinguishable from a pure SPA from
 *      the module's perspective, and the response is the same: "use
 *      Playwright." (Mistake 19 lesson — don't declare blocked before
 *      testing Playwright.)
 *
 *   3. WooCommerce static-HTML               → canadafirstammo.ca /product-category/ammunition/
 *      Expect: verdict='static-ok', needsPlaywright=false, SHORT-CIRCUIT.
 *      Validates the short-circuit on a different platform from case 1
 *      (BC Stencil) — proves the threshold logic is platform-agnostic.
 *
 *   4. Celerant / ColdFusion (HPE headers)   → bullseyenorth.com /firearms
 *      Celerant sends trailing-space headers that break axios's parser.
 *      probe-fetch's native-fetch fallback handles this cleanly. Expect
 *      verdict='static-ok', needsPlaywright=false, SHORT-CIRCUIT.
 *      staticFetch.method should be 'native-fetch' (not 'axios' — HPE
 *      forced the fallback). This proves Module 7's short-circuit depends
 *      only on the final product count, not on which transport was used.
 *
 *   5. Drupal + Cloudflare rule-challenge    → gunpost.ca /ads?f[0]=c:1
 *      Cloudflare may rule-selective-challenge gunpost's /ads paths from
 *      certain IPs. Acceptable outcomes:
 *        A) verdict='static-ok' (CF allowed axios through — rare but valid)
 *        B) verdict='static-zero-playwright-ok' (CF blocked axios but
 *           Playwright passed)
 *        C) verdict='both-zero' (CF blocked both — documented edge case
 *           per Mistake 37; the MODULE still successfully emits a verdict)
 *      needsPlaywright will be true for (A) only when static products >= 5
 *      somehow fell below threshold — not asserted here. For (C) the skill
 *      layer uses the reason + needsPlaywright to decide routing.
 *
 * Run:
 *   cd backend && npx tsx scripts/probe-modules/__test__/test-probe-rendering.ts
 *
 * Exits 0 if all 5 pass. Non-zero if any fail.
 */

import { runProbeRendering, ProbeRenderingResult } from '../probe-rendering';
import { closePlaywrightIfUsed } from '../probe-fetch';

interface TestCase {
  name: string;
  url: string;
  family: string;
  ua?: 'desktop' | 'iphone';
  wafSuspected?: boolean;
  assert: (r: ProbeRenderingResult) => string | null;
}

const CASES: TestCase[] = [
  {
    name: 'theammosource.com',
    url: 'https://www.theammosource.com/rifle-ammunition/',
    family: 'BC Stencil (static-ok)',
    assert: (r) => {
      if (r.verdict !== 'static-ok')
        return `expected verdict=static-ok, got ${r.verdict} (reason: ${r.reason})`;
      if (r.needsPlaywright !== false)
        return `expected needsPlaywright=false, got ${r.needsPlaywright}`;
      // SHORT-CIRCUIT INVARIANT: Playwright MUST NOT be called when static >= threshold.
      if (r.playwrightFetch !== null)
        return `short-circuit failed — Playwright was called when static already had ${r.staticFetch.productCount} products`;
      if (r.staticFetch.productCount < 5)
        return `expected static.productCount >= 5, got ${r.staticFetch.productCount}`;
      return null;
    },
  },
  {
    name: 'gotenda.com',
    url: 'https://www.gotenda.com/product-category/firearms/handguns/',
    family: 'WooCommerce + Sucuri WAF (SPA-equivalent)',
    assert: (r) => {
      if (r.verdict !== 'static-zero-playwright-ok')
        return `expected verdict=static-zero-playwright-ok, got ${r.verdict} (reason: ${r.reason})`;
      if (r.needsPlaywright !== true)
        return `expected needsPlaywright=true, got ${r.needsPlaywright}`;
      // Playwright MUST have been called (no short-circuit).
      if (r.playwrightFetch === null)
        return `expected Playwright to have been called (static had <5), but playwrightFetch===null`;
      if (r.staticFetch.productCount !== 0)
        return `expected static.productCount=0 on WAF-gated page, got ${r.staticFetch.productCount}`;
      if (r.playwrightFetch.productCount < 5)
        return `expected playwright.productCount >= 5, got ${r.playwrightFetch.productCount}`;
      return null;
    },
  },
  {
    name: 'canadafirstammo.ca',
    url: 'https://canadafirstammo.ca/product-category/ammunition/',
    family: 'WooCommerce (static-ok)',
    assert: (r) => {
      if (r.verdict !== 'static-ok')
        return `expected verdict=static-ok, got ${r.verdict} (reason: ${r.reason})`;
      if (r.needsPlaywright !== false)
        return `expected needsPlaywright=false, got ${r.needsPlaywright}`;
      if (r.playwrightFetch !== null)
        return `short-circuit failed — Playwright was called when static already had ${r.staticFetch.productCount} products`;
      if (r.staticFetch.productCount < 5)
        return `expected static.productCount >= 5, got ${r.staticFetch.productCount}`;
      return null;
    },
  },
  {
    name: 'bullseyenorth.com',
    url: 'https://www.bullseyenorth.com/firearms',
    family: 'Celerant / ColdFusion (HPE → native-fetch)',
    assert: (r) => {
      if (r.verdict !== 'static-ok')
        return `expected verdict=static-ok, got ${r.verdict} (reason: ${r.reason})`;
      if (r.needsPlaywright !== false)
        return `expected needsPlaywright=false, got ${r.needsPlaywright}`;
      if (r.playwrightFetch !== null)
        return `short-circuit failed — Playwright was called when static already had ${r.staticFetch.productCount} products`;
      // Method-specific invariant: Celerant MUST go through native-fetch
      // because axios trips HPE_INVALID_HEADER_TOKEN on trailing-space
      // headers. This proves the static-fetch pipeline's HPE fallback
      // keeps Module 7's short-circuit intact.
      if (r.staticFetch.method !== 'native-fetch')
        return `expected static.method=native-fetch (HPE fallback), got ${r.staticFetch.method}`;
      if (r.staticFetch.productCount < 5)
        return `expected static.productCount >= 5, got ${r.staticFetch.productCount}`;
      return null;
    },
  },
  {
    name: 'gunpost.ca',
    url: 'https://www.gunpost.ca/ads?f%5B0%5D=c%3A1',
    family: 'Drupal + Cloudflare (rule-challenge)',
    ua: 'iphone',
    wafSuspected: true,
    assert: (r) => {
      // Acceptable outcomes — this site's CF behavior is IP-dependent, so
      // we accept static-ok, static-zero-playwright-ok, OR both-zero.
      // What we DO NOT accept: a crash, a silent mismatch between verdict
      // and needsPlaywright, or an unexpected static-ok-playwright-also-ok.
      const acceptableVerdicts: ProbeRenderingResult['verdict'][] = [
        'static-ok',
        'static-zero-playwright-ok',
        'both-zero',
      ];
      if (!acceptableVerdicts.includes(r.verdict))
        return `unexpected verdict=${r.verdict} for Cloudflare-rule-challenge family (reason: ${r.reason})`;
      // Self-consistency: needsPlaywright MUST align with verdict.
      const expectedNeedsPw =
        r.verdict === 'static-zero-playwright-ok' || r.verdict === 'static-ok-playwright-also-ok';
      if (r.needsPlaywright !== expectedNeedsPw)
        return `needsPlaywright=${r.needsPlaywright} inconsistent with verdict=${r.verdict} (expected needsPlaywright=${expectedNeedsPw})`;
      // For verdicts other than static-ok, Playwright MUST have been called.
      if (r.verdict !== 'static-ok' && r.playwrightFetch === null)
        return `verdict=${r.verdict} but playwrightFetch===null — Playwright should have been called`;
      return null;
    },
  },
];

interface TestResult {
  name: string;
  family: string;
  passed: boolean;
  error: string | null;
  result: ProbeRenderingResult;
  wallMs: number;
  playwrightWasCalled: boolean;
}

async function runCase(c: TestCase): Promise<TestResult> {
  process.stderr.write(`\n── [${c.family}] ${c.url} ──\n`);
  const t0 = Date.now();
  let r: ProbeRenderingResult;
  try {
    r = await runProbeRendering(c.url, {
      ua: c.ua ?? 'desktop',
      wafSuspected: c.wafSuspected,
    });
  } catch (e: any) {
    return {
      name: c.name,
      family: c.family,
      passed: false,
      error: `runProbeRendering threw: ${e?.message || e}`,
      result: {} as ProbeRenderingResult,
      wallMs: Date.now() - t0,
      playwrightWasCalled: false,
    };
  }
  const wallMs = Date.now() - t0;
  const err = c.assert(r);
  const passed = err === null;
  const playwrightWasCalled = r.playwrightFetch !== null;
  process.stderr.write(
    `  static=${r.staticFetch.productCount}p/${r.staticFetch.method} ` +
      `pw=${playwrightWasCalled ? `${r.playwrightFetch!.productCount}p` : 'NOT-CALLED'} ` +
      `verdict=${r.verdict} needsPw=${r.needsPlaywright} wall=${wallMs}ms → ${passed ? 'PASS' : 'FAIL: ' + err}\n`,
  );
  if (!passed) {
    process.stderr.write(`  full reason: ${r.reason}\n`);
  }
  return {
    name: c.name,
    family: c.family,
    passed,
    error: err,
    result: r,
    wallMs,
    playwrightWasCalled,
  };
}

async function main(): Promise<number> {
  process.stderr.write(
    '╔══════════════════════════════════════════════════════════════╗\n',
  );
  process.stderr.write(
    '║ probe-rendering.ts — 5-site regression (5 rendering families)║\n',
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
  const colW = { n: 22, f: 44 };
  process.stderr.write(
    `${'site'.padEnd(colW.n)}  ${'family'.padEnd(colW.f)}  static  pw     verdict                        pw-called?  result\n`,
  );
  process.stderr.write('─'.repeat(colW.n + colW.f + 75) + '\n');
  for (const r of results) {
    const s = String(r.result.staticFetch?.productCount ?? '?').padEnd(6);
    const pwCount = r.result.playwrightFetch
      ? String(r.result.playwrightFetch.productCount).padEnd(5)
      : '—    ';
    const verdict = (r.result.verdict || '?').padEnd(30);
    const pwCalled = r.playwrightWasCalled ? 'yes' : 'NO (short-circuit)';
    process.stderr.write(
      `${r.name.padEnd(colW.n)}  ${r.family.padEnd(colW.f)}  ${s}  ${pwCount}  ${verdict}  ${pwCalled.padEnd(20)}  ${r.passed ? 'PASS' : 'FAIL: ' + r.error}\n`,
    );
  }

  const failed = results.filter((r) => !r.passed);
  process.stderr.write(
    `\nTotals: ${results.length - failed.length}/${results.length} passed\n`,
  );

  // Short-circuit accounting — proves the optimization actually fires.
  const shortCircuits = results.filter((r) => !r.playwrightWasCalled).length;
  process.stderr.write(
    `Short-circuits (Playwright NOT called): ${shortCircuits}/${results.length}\n`,
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
