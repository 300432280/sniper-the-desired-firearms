/**
 * test-probe-access.ts — 5-site regression harness for Module 3 (probe-access).
 *
 * Covers 5 WAF / access families. Asserts the module's GENERIC abstractions
 * (heavy-probe parser, UA-sweep classifier, cookie-marker extraction) handle
 * each correctly without site-specific branches:
 *
 *   1. No WAF                              → surplusherbys.com
 *      Expect: hasWaf=false, wafType=null, recommendedUa='desktop',
 *      desktop UA returns real content.
 *      Note: real WAF-free Canadian firearms retailers are rare. Most sites
 *      in the fleet are behind Cloudflare (even aagcanada.ca Shopify is
 *      CF-fronted — cf-ray present). leverarms.com = CF-passive;
 *      corwin-arms.com = LiteSpeed rule-selective; aagcanada.ca = CF-passive.
 *      surplusherbys.com runs on Wix (server: Pepyaka), Wix's edge does NOT
 *      proxy through Cloudflare and does NOT apply SQLi/XSS/honeypot rules
 *      to the storefront — making it a canonical "no-WAF" test target.
 *
 *   2. Cloudflare passive                  → theammosource.com
 *      Expect: hasWaf=true, wafType='cloudflare-passive', evidence has
 *      cf-related header or cookie marker, desktop still returns real
 *      content (passive ≠ active).
 *
 *   3. Sucuri                              → gotenda.com
 *      Expect: hasWaf=true, wafType='sucuri', setCookieMarkers.sucuri=true
 *      OR x-sucuri-* header seen. recommendedUa may be either (both UAs
 *      pre-solve see the same challenge).
 *
 *   4. SiteGround sgcaptcha                → thegundealer.ca
 *      Expect: hasWaf=true, wafType='sgcaptcha', recommendedUa='iphone'
 *      via Mistake 30 Fix B fleet rule (WAF_REQUIRES_IPHONE set).
 *      Pre-solve every UA sees the same challenge body, so live evidence
 *      alone can't pick iPhone — the wafType=sgcaptcha → iPhone mapping
 *      applies the fleet-learned rule.
 *
 *   5. Celerant / ColdFusion, no WAF       → bullseyenorth.com
 *      Expect: hasWaf=false, wafType=null, setCookieMarkers.cfid=true,
 *      setCookieMarkers.cftoken=true. Tests that CFID/CFTOKEN cookie
 *      markers are extracted even though there's no WAF.
 *
 * Run:
 *   cd backend && npx tsx scripts/probe-modules/__test__/test-probe-access.ts
 *
 * Exits 0 if all 5 pass. Non-zero if any fail.
 */

import { runProbeAccess, ProbeAccessResult } from '../probe-access';
import { closePlaywrightIfUsed } from '../probe-fetch';

interface TestCase {
  name: string;
  url: string;
  family: string;
  assert: (r: ProbeAccessResult) => string | null;
}

const CASES: TestCase[] = [
  {
    name: 'surplusherbys.com',
    url: 'https://www.surplusherbys.com',
    family: 'No WAF (Wix / Pepyaka)',
    assert: (r) => {
      if (r.hasWaf !== false)
        return `expected hasWaf=false, got ${r.hasWaf} (wafType=${r.wafType})`;
      if (r.wafType !== null)
        return `expected wafType=null, got ${r.wafType}`;
      if (r.recommendedUa !== 'desktop')
        return `expected recommendedUa=desktop, got ${r.recommendedUa} (reason=${r.uaOverrideReason})`;
      // Desktop must return a 200
      if (r.uaSweep.desktop.status !== 200)
        return `expected desktop UA status=200, got ${r.uaSweep.desktop.status}`;
      // No CF, no Sucuri, no sgcaptcha — authoritative "no vendor WAF"
      if (r.uaSweep.desktop.cfRay !== null)
        return `expected no cf-ray, got ${r.uaSweep.desktop.cfRay}`;
      if (r.wafEvidence.setCookieMarkers.sucuri)
        return `expected no sucuri cookie`;
      if (r.wafEvidence.setCookieMarkers.cfBm || r.wafEvidence.setCookieMarkers.cfClearance)
        return `expected no CF bot-mgmt cookies`;
      return null;
    },
  },
  {
    name: 'theammosource.com',
    url: 'https://www.theammosource.com',
    family: 'Cloudflare passive (BigCommerce Stencil)',
    assert: (r) => {
      if (r.hasWaf !== true)
        return `expected hasWaf=true, got ${r.hasWaf}`;
      if (r.wafType !== 'cloudflare-passive')
        return `expected wafType='cloudflare-passive', got '${r.wafType}'`;
      // Evidence: cf-ray header in UA sweep, OR __cf_bm/cf_clearance cookie
      // marker, OR 'cloudflare' in headerServers.
      const hasCfEvidence =
        r.uaSweep.desktop.cfRay !== null ||
        r.uaSweep.iphone.cfRay !== null ||
        r.wafEvidence.setCookieMarkers.cfBm ||
        r.wafEvidence.setCookieMarkers.cfClearance ||
        r.wafEvidence.headerServers.some((s) => /cloudflare/i.test(s));
      if (!hasCfEvidence)
        return `expected CF evidence (cf-ray / __cf_bm / cf_clearance / server:cloudflare), got headerServers=[${r.wafEvidence.headerServers.join(',')}], cfRay=${r.uaSweep.desktop.cfRay}, markers=${JSON.stringify(r.wafEvidence.setCookieMarkers)}`;
      // Passive: desktop UA should NOT be blocked — site serves real content.
      // Allow looksLikeRealContent OR reasonably large body as proof.
      const desktopOk =
        r.uaSweep.desktop.status === 200 &&
        (r.uaSweep.desktop.looksLikeRealContent || r.uaSweep.desktop.bodyBytes > 10_000);
      if (!desktopOk)
        return `expected desktop UA to return real content for passive CF, got status=${r.uaSweep.desktop.status}, bytes=${r.uaSweep.desktop.bodyBytes}, real=${r.uaSweep.desktop.looksLikeRealContent}`;
      return null;
    },
  },
  {
    name: 'gotenda.com',
    url: 'https://www.gotenda.com',
    family: 'Sucuri WAF (WooCommerce)',
    assert: (r) => {
      if (r.hasWaf !== true)
        return `expected hasWaf=true, got ${r.hasWaf}`;
      if (r.wafType !== 'sucuri')
        return `expected wafType='sucuri', got '${r.wafType}'`;
      // Sucuri evidence: either x-sucuri-* header OR sucuri_cloudproxy cookie.
      // interpretHeavyProbe sets setCookieMarkers.sucuri when
      // `set-cookie: sucuri_cloudproxy*` appears in BATCH 1 headers.
      // If neither is seen, it means we're failing to detect Sucuri — the
      // probe would have to have matched via some other path (and wafType
      // === 'sucuri' means the header OR the cookie path matched), so this
      // is really an audit-trail assertion.
      const hasSucuriEvidence =
        r.wafEvidence.setCookieMarkers.sucuri ||
        // or x-sucuri-* was the trigger — but we don't expose that field
        // directly in evidence; presence of wafType='sucuri' + probe output
        // containing x-sucuri is the proof. Just check the raw probe output.
        /x-sucuri-(id|cache|block):/i.test(r.wafEvidence.heavyProbeRawOutput);
      if (!hasSucuriEvidence)
        return `wafType=sucuri but no sucuri cookie or header evidence found`;
      return null;
    },
  },
  {
    name: 'thegundealer.ca',
    url: 'https://thegundealer.ca',
    family: 'SiteGround sgcaptcha (WooCommerce)',
    assert: (r) => {
      if (r.hasWaf !== true)
        return `expected hasWaf=true, got ${r.hasWaf}`;
      if (r.wafType !== 'sgcaptcha')
        return `expected wafType='sgcaptcha', got '${r.wafType}'`;
      // sg-captcha header should have been detected by heavy probe OR by a UA
      // returning sgCaptcha=true in the UA sweep. Either proves the signature.
      const hasSgEvidence =
        /^sg-captcha:/im.test(r.wafEvidence.heavyProbeRawOutput) ||
        r.uaSweep.desktop.sgCaptcha ||
        r.uaSweep.iphone.sgCaptcha ||
        /sg-?captcha|\.well-known\/sgcaptcha/i.test(r.wafEvidence.heavyProbeRawOutput);
      if (!hasSgEvidence)
        return `wafType=sgcaptcha but no sg-captcha evidence in probe output or UA sweep`;
      // Mistake 30 Fix B: wafType=sgcaptcha → fleet rule recommends iPhone.
      // Pre-solve both UAs see the same challenge, so the fleet-rule override
      // in runProbeAccess (WAF_REQUIRES_IPHONE set) must fire.
      if (r.recommendedUa !== 'iphone')
        return `expected recommendedUa=iphone (Mistake 30 Fix B fleet rule for sgcaptcha), got ${r.recommendedUa} (reason=${r.uaOverrideReason})`;
      return null;
    },
  },
  {
    name: 'bullseyenorth.com',
    url: 'https://www.bullseyenorth.com',
    family: 'Celerant / ColdFusion (no WAF, CFID/CFTOKEN cookies)',
    assert: (r) => {
      // Celerant CF stack does NOT have a WAF in front.
      if (r.hasWaf !== false)
        return `expected hasWaf=false (Celerant, no WAF), got ${r.hasWaf} (wafType=${r.wafType})`;
      if (r.wafType !== null)
        return `expected wafType=null, got ${r.wafType}`;
      // CFID + CFTOKEN cookies must be extracted from BATCH 1 set-cookie
      // headers. If these aren't detected, the cookie-marker regex is broken.
      if (!r.wafEvidence.setCookieMarkers.cfid)
        return `expected setCookieMarkers.cfid=true for ColdFusion site`;
      if (!r.wafEvidence.setCookieMarkers.cftoken)
        return `expected setCookieMarkers.cftoken=true for ColdFusion site`;
      // Celerant serves identical content to every UA (no UA filtering).
      // Whichever UA the module picks, verify THAT UA actually returns real
      // content. This is the correct invariant — we don't care which UA
      // wins (desktop is common but Celerant's HPE-malformed-header bug
      // can occasionally knock out the desktop fetch via native-fetch's
      // own transient failure; in that case iPhone is picked, which is
      // equally correct because Celerant doesn't UA-filter).
      const pick = r.uaSweep[r.recommendedUa];
      if (pick.status !== 200)
        return `recommendedUa=${r.recommendedUa} but that UA returned status=${pick.status}`;
      if (!pick.looksLikeRealContent)
        return `recommendedUa=${r.recommendedUa} but that UA body (${pick.bodyBytes}b) did not match REAL_HTML_MARKER_RE`;
      return null;
    },
  },
];

interface TestResult {
  name: string;
  family: string;
  passed: boolean;
  error: string | null;
  result: ProbeAccessResult;
  wallMs: number;
}

async function runCase(c: TestCase): Promise<TestResult> {
  process.stderr.write(`\n── [${c.family}] ${c.url} ──\n`);
  const t0 = Date.now();
  let r: ProbeAccessResult;
  try {
    r = await runProbeAccess(c.url);
  } catch (e: any) {
    return {
      name: c.name,
      family: c.family,
      passed: false,
      error: `runProbeAccess threw: ${e?.message || e}`,
      result: {} as ProbeAccessResult,
      wallMs: Date.now() - t0,
    };
  }
  const wallMs = Date.now() - t0;
  const err = c.assert(r);
  const passed = err === null;
  process.stderr.write(
    `  hasWaf=${r.hasWaf} wafType=${r.wafType} conf=${r.wafConfidence} ua=${r.recommendedUa} pw=${r.playwrightRequired} wall=${wallMs}ms → ${passed ? 'PASS' : 'FAIL: ' + err}\n`,
  );
  if (!passed || r.warnings.length > 0) {
    process.stderr.write(
      `  desktop: st=${r.uaSweep.desktop.status} bytes=${r.uaSweep.desktop.bodyBytes} ch=${r.uaSweep.desktop.looksLikeChallenge} rc=${r.uaSweep.desktop.looksLikeRealContent} cfRay=${r.uaSweep.desktop.cfRay ?? 'none'}\n`,
    );
    process.stderr.write(
      `  iphone:  st=${r.uaSweep.iphone.status} bytes=${r.uaSweep.iphone.bodyBytes} ch=${r.uaSweep.iphone.looksLikeChallenge} rc=${r.uaSweep.iphone.looksLikeRealContent} cfRay=${r.uaSweep.iphone.cfRay ?? 'none'}\n`,
    );
    process.stderr.write(
      `  cookies: cfid=${r.wafEvidence.setCookieMarkers.cfid} cftoken=${r.wafEvidence.setCookieMarkers.cftoken} cfBm=${r.wafEvidence.setCookieMarkers.cfBm} cfClr=${r.wafEvidence.setCookieMarkers.cfClearance} sucuri=${r.wafEvidence.setCookieMarkers.sucuri} incap=${r.wafEvidence.setCookieMarkers.incapsula} asp=${r.wafEvidence.setCookieMarkers.aspNetSession}\n`,
    );
    process.stderr.write(
      `  evid: servers=[${r.wafEvidence.headerServers.join(',')}] honeypot=${r.wafEvidence.honeypotBlocked} sqli=${r.wafEvidence.sqliBlocked} xss=${r.wafEvidence.xssBlocked} rate=${r.wafEvidence.rateLimitObserved} uaFilter=${r.wafEvidence.uaFilterObserved}\n`,
    );
    if (r.warnings.length > 0) {
      process.stderr.write(`  warnings: ${r.warnings.slice(0, 3).join(' | ')}\n`);
    }
  }
  return { name: c.name, family: c.family, passed, error: err, result: r, wallMs };
}

async function main(): Promise<number> {
  process.stderr.write(
    '╔══════════════════════════════════════════════════════════════╗\n',
  );
  process.stderr.write(
    '║ probe-access.ts — 5-site regression (5 WAF families)         ║\n',
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
    `${'site'.padEnd(colW.n)}  ${'family'.padEnd(colW.f)}  hasWaf  wafType            ua        pw    result\n`,
  );
  process.stderr.write('─'.repeat(colW.n + colW.f + 55) + '\n');
  for (const r of results) {
    const hw = String(r.result.hasWaf ?? '?').padEnd(6);
    const wt = String(r.result.wafType ?? 'null').padEnd(18);
    const ua = String(r.result.recommendedUa ?? '?').padEnd(8);
    const pw = String(r.result.playwrightRequired ?? '?').padEnd(5);
    process.stderr.write(
      `${r.name.padEnd(colW.n)}  ${r.family.padEnd(colW.f)}  ${hw}  ${wt}  ${ua}  ${pw}  ${r.passed ? 'PASS' : 'FAIL: ' + r.error}\n`,
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
