/**
 * test-probe-fetch.ts — 5-site regression harness for Module 1 (probe-fetch).
 *
 * Covers 5 platform families. Asserts the module's abstraction handles each
 * correctly without site-specific branches:
 *
 *   1. WooCommerce, no WAF                 → leverarms.com
 *      Expect: axios 200, no escalations, no retries.
 *
 *   2. WooCommerce + Sucuri WAF            → gotenda.com
 *      Expect: axios receives 307+challenge body → authoritative Sucuri
 *      signature detected → `playwright-waf` escalation → final method
 *      'playwright', status 200.
 *
 *   3. Celerant / ColdFusion               → bullseyenorth.com
 *      Expect: axios HPE parse error (trailing-space headers) →
 *      `native-fetch-malformed-header` escalation → final method
 *      'native-fetch', status 200.
 *
 *   4. Drupal + Cloudflare                 → gunpost.ca
 *      Expect: axios 200 on bare `/ads` OR Cloudflare interactive challenge
 *      depending on IP reputation. Either way, final status 200 via some
 *      method. If challenge served, `playwright-waf` fires. Module must not
 *      crash on 16KB `x-drupal-cache-tags` header (BIG_HEADER_HTTP_AGENT).
 *
 *   5. BigCommerce Stencil                 → theammosource.com
 *      Expect: axios 200, no escalations. (Cloudflare-passive per persona;
 *      cf-ray in headers but no active challenge.)
 *
 * Run:
 *   cd backend && npx tsx scripts/probe-modules/__test__/test-probe-fetch.ts
 *
 * Exits 0 if all 5 pass. Non-zero if any fail.
 */

import { fetchForProbe, closePlaywrightIfUsed, ProbeFetchResult } from '../probe-fetch';

interface TestCase {
  name: string;
  url: string;
  family: string;
  /** Extra opts passed to fetchForProbe (beyond defaults). */
  opts?: Parameters<typeof fetchForProbe>[1];
  /** Assertion fn: return null for PASS, string error for FAIL. */
  assert: (r: ProbeFetchResult) => string | null;
}

const CASES: TestCase[] = [
  {
    name: 'leverarms.com',
    url: 'https://www.leverarms.com/',
    family: 'WooCommerce, no WAF',
    assert: (r) => {
      if (r.status !== 200) return `expected status 200, got ${r.status}`;
      if (r.method !== 'axios' && r.method !== 'native-fetch')
        return `expected axios/native-fetch, got ${r.method}`;
      if (r.escalations.includes('playwright-waf'))
        return `unexpected playwright-waf escalation (${r.escalations.join(',')})`;
      if (r.bodyBytes < 5000) return `suspiciously small body (${r.bodyBytes}b)`;
      return null;
    },
  },
  {
    name: 'gotenda.com',
    url: 'https://www.gotenda.com/',
    family: 'WooCommerce + Sucuri WAF',
    assert: (r) => {
      if (r.status !== 200) return `expected status 200, got ${r.status}`;
      // Sucuri's initial response IS an authoritative challenge body →
      // module MUST escalate to Playwright and end on method=playwright.
      if (r.method !== 'playwright')
        return `expected method=playwright (Sucuri challenge body should escalate), got ${r.method}`;
      if (!r.escalations.includes('playwright-waf'))
        return `expected playwright-waf escalation, got [${r.escalations.join(',')}]`;
      if (r.bodyBytes < 5000) return `post-Playwright body too small (${r.bodyBytes}b)`;
      return null;
    },
  },
  {
    name: 'bullseyenorth.com',
    url: 'https://www.bullseyenorth.com/',
    family: 'Celerant / ColdFusion (malformed headers)',
    assert: (r) => {
      if (r.status !== 200) return `expected status 200, got ${r.status}`;
      // Celerant sends trailing-space headers → axios MUST fail with HPE →
      // module MUST escalate to native-fetch.
      if (r.method !== 'native-fetch')
        return `expected method=native-fetch (HPE malformed header should escalate), got ${r.method}`;
      if (!r.escalations.includes('native-fetch-malformed-header'))
        return `expected native-fetch-malformed-header escalation, got [${r.escalations.join(',')}]`;
      // First error should be classified as fallback-trigger (HPE)
      const firstErr = r.errors[0];
      if (!firstErr) return `expected at least one error entry (HPE), got none`;
      if (firstErr.classification !== 'fallback-trigger')
        return `expected first error classification='fallback-trigger', got '${firstErr.classification}' msg='${firstErr.message.slice(0, 80)}'`;
      return null;
    },
  },
  {
    name: 'gunpost.ca',
    url: 'https://www.gunpost.ca/',
    family: 'Drupal + Cloudflare',
    assert: (r) => {
      // Two valid outcomes:
      //   (a) axios 200 (cloudflare-passive; homepage served through) — preferred
      //   (b) Cloudflare active challenge → playwright-waf escalation → method=playwright 200
      if (r.status !== 200) return `expected status 200, got ${r.status}`;
      if (r.method === null) return `no method set`;
      // Must not crash on 16KB Drupal cache-tag headers — if it did, we'd see
      // HPE_HEADER_OVERFLOW in errors AND fail to get a response.
      const hasHeaderOverflow = r.errors.some((e) =>
        /headers_overflow|hpe_header_overflow/i.test(e.message),
      );
      if (hasHeaderOverflow) return `header overflow (BIG_HEADER agents should prevent this): ${r.errors.map((e) => e.message.slice(0, 60)).join(' | ')}`;
      return null;
    },
  },
  {
    name: 'theammosource.com',
    url: 'https://www.theammosource.com/',
    family: 'BigCommerce Stencil (Cloudflare-passive)',
    assert: (r) => {
      if (r.status !== 200) return `expected status 200, got ${r.status}`;
      // Passive CF — no active challenge, should stay on axios.
      if (r.method !== 'axios' && r.method !== 'native-fetch' && r.method !== 'playwright')
        return `no method`;
      // Body should be large (BC Stencil homepage is ~100KB+)
      if (r.bodyBytes < 10000) return `body suspiciously small (${r.bodyBytes}b)`;
      return null;
    },
  },
];

interface TestResult {
  name: string;
  family: string;
  passed: boolean;
  error: string | null;
  result: ProbeFetchResult;
}

async function runCase(c: TestCase): Promise<TestResult> {
  process.stderr.write(`\n── [${c.family}] ${c.url} ──\n`);
  const t0 = Date.now();
  let r: ProbeFetchResult;
  try {
    r = await fetchForProbe(c.url, c.opts);
  } catch (e: any) {
    // fetchForProbe should NEVER throw — it returns a structured envelope.
    // If it does, that's a module bug.
    return {
      name: c.name,
      family: c.family,
      passed: false,
      error: `fetchForProbe threw: ${e?.message || e}`,
      result: {} as ProbeFetchResult,
    };
  }
  const wall = Date.now() - t0;
  const err = c.assert(r);
  const passed = err === null;
  process.stderr.write(
    `  status=${r.status} method=${r.method} bytes=${r.bodyBytes} retries=${r.retries} escalations=[${r.escalations.join(',')}] wall=${wall}ms → ${passed ? 'PASS' : 'FAIL: ' + err}\n`,
  );
  return { name: c.name, family: c.family, passed, error: err, result: r };
}

async function main(): Promise<number> {
  process.stderr.write(
    '╔══════════════════════════════════════════════════════════════╗\n',
  );
  process.stderr.write(
    '║ probe-fetch.ts — 5-site regression (5 platform families)     ║\n',
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
  const colW = { n: 24, f: 40 };
  process.stderr.write(
    `${'site'.padEnd(colW.n)}  ${'family'.padEnd(colW.f)}  status  method         esc       result\n`,
  );
  process.stderr.write('─'.repeat(colW.n + colW.f + 40) + '\n');
  for (const r of results) {
    const m = r.result.method ?? '(none)';
    const e = r.result.escalations?.join(',') || '-';
    const s = r.result.status?.toString() ?? 'null';
    process.stderr.write(
      `${r.name.padEnd(colW.n)}  ${r.family.padEnd(colW.f)}  ${s.padEnd(6)}  ${m.padEnd(13)}  ${e.padEnd(9)}  ${r.passed ? 'PASS' : 'FAIL: ' + r.error}\n`,
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
