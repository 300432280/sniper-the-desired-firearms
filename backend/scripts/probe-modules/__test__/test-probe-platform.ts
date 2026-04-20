/**
 * test-probe-platform.ts — 5-site regression harness for Module 4 (probe-platform).
 *
 * Covers 5 platform families. Asserts the module's GENERIC marker scanner
 * handles each correctly without site-specific branches, AND the key coexist
 * invariant: when multiple platforms are present (WordPress + Ecwid, Celerant
 * + ColdFusion), ALL of them are emitted. The skill — not this module —
 * picks a single verdict.
 *
 *   1. WooCommerce (CF-passive)            → canadafirstammo.ca
 *      Expect: strong `woocommerce` marker, wpJsonWcStore.status=200 with
 *      xWpTotal populated, topCandidates[0] = woocommerce, NO shopify marker.
 *      Note: leverarms.com appears in the module brief as alternative — but
 *      many WooCommerce sites in the fleet sit behind Cloudflare-passive
 *      (cf-ray returns on homepage). We don't care about WAF here; we care
 *      about the WC markers being caught regardless.
 *
 *   2. BigCommerce Stencil (CF-passive)    → theammosource.com
 *      Expect: strong `bigcommerce-stencil` marker, NO woocommerce / shopify
 *      / magento markers, topCandidates[0] = bigcommerce-stencil.
 *
 *   3. Shopify                             → aagcanada.ca
 *      Expect: strong `shopify` marker, shopifyProducts.status=200 with
 *      count >= 1, topCandidates[0] = shopify.
 *
 *   4. Ecwid-on-WordPress (coexist test)   → triggersandbows.com
 *      Expect: BOTH `wordpress` AND `ecwid` markers emitted — this is the
 *      defining design test. If the scanner picks a single winner, this test
 *      fails. ecwidStorefront API reachable with totalProductsCount in body.
 *
 *   5. Celerant / ColdFusion (coexist)     → bullseyenorth.com
 *      Expect: BOTH `coldfusion` AND `celerant-coldfusion` markers. The
 *      coldfusion marker fires on CFID+CFTOKEN cookies; the celerant marker
 *      fires on the celerantwebservices.com script URL in HTML. Second
 *      coexist test — same principle as (4) but different stack.
 *
 * Run:
 *   cd backend && npx tsx scripts/probe-modules/__test__/test-probe-platform.ts
 *
 * Exits 0 if all 5 pass. Non-zero if any fail.
 */

import { runProbePlatform, ProbePlatformResult } from '../probe-platform';
import { closePlaywrightIfUsed } from '../probe-fetch';

interface TestCase {
  name: string;
  url: string;
  family: string;
  assert: (r: ProbePlatformResult) => string | null;
}

function hasMarker(
  r: ProbePlatformResult,
  name: string,
  minStrength: 'strong' | 'medium' | 'weak' = 'weak',
): boolean {
  const rank: Record<string, number> = { weak: 1, medium: 2, strong: 3 };
  return r.markers.some(
    (m) => m.marker === name && rank[m.strength] >= rank[minStrength],
  );
}

const CASES: TestCase[] = [
  {
    name: 'canadafirstammo.ca',
    url: 'https://canadafirstammo.ca',
    family: 'WooCommerce (CF-passive)',
    assert: (r) => {
      if (!hasMarker(r, 'woocommerce', 'strong'))
        return `expected strong 'woocommerce' marker, got [${r.markers.map((m) => `${m.marker}:${m.strength}`).join(', ')}]`;
      if (hasMarker(r, 'shopify'))
        return `expected NO shopify marker (site is WooCommerce), got shopify marker`;
      if (hasMarker(r, 'bigcommerce-stencil'))
        return `expected NO bigcommerce-stencil marker`;
      // API probe: wc-store must return 200 with xWpTotal populated (this is
      // what the WooCommerceAdapter uses for catalog size).
      const store = r.apiEndpointsReachable.wpJsonWcStore;
      if (!store || store.status !== 200)
        return `expected wpJsonWcStore.status=200, got ${store?.status}`;
      if (store.xWpTotal === null || store.xWpTotal < 1)
        return `expected xWpTotal>=1 on wpJsonWcStore, got ${store.xWpTotal}`;
      // topCandidates[0] must be woocommerce
      if (r.topCandidates.length === 0 || r.topCandidates[0].platform !== 'woocommerce')
        return `expected topCandidates[0]=woocommerce, got ${r.topCandidates[0]?.platform} (full: ${JSON.stringify(r.topCandidates.slice(0, 3))})`;
      return null;
    },
  },
  {
    name: 'theammosource.com',
    url: 'https://www.theammosource.com',
    family: 'BigCommerce Stencil',
    assert: (r) => {
      if (!hasMarker(r, 'bigcommerce-stencil', 'strong'))
        return `expected strong 'bigcommerce-stencil' marker, got [${r.markers.map((m) => `${m.marker}:${m.strength}`).join(', ')}]`;
      if (hasMarker(r, 'woocommerce'))
        return `expected NO woocommerce marker, got woocommerce marker`;
      if (hasMarker(r, 'shopify'))
        return `expected NO shopify marker, got shopify marker`;
      if (hasMarker(r, 'magento-1.x') || hasMarker(r, 'magento-2.x'))
        return `expected NO magento markers, got one`;
      if (r.topCandidates.length === 0 || r.topCandidates[0].platform !== 'bigcommerce-stencil')
        return `expected topCandidates[0]=bigcommerce-stencil, got ${r.topCandidates[0]?.platform} (full: ${JSON.stringify(r.topCandidates.slice(0, 3))})`;
      return null;
    },
  },
  {
    name: 'aagcanada.ca',
    url: 'https://aagcanada.ca',
    family: 'Shopify',
    assert: (r) => {
      if (!hasMarker(r, 'shopify', 'strong'))
        return `expected strong 'shopify' marker, got [${r.markers.map((m) => `${m.marker}:${m.strength}`).join(', ')}]`;
      const sh = r.apiEndpointsReachable.shopifyProducts;
      if (!sh || sh.status !== 200)
        return `expected shopifyProducts.status=200, got ${sh?.status}`;
      if (sh.count === null || sh.count < 1)
        return `expected shopifyProducts.count>=1, got ${sh.count}`;
      if (r.topCandidates.length === 0 || r.topCandidates[0].platform !== 'shopify')
        return `expected topCandidates[0]=shopify, got ${r.topCandidates[0]?.platform}`;
      return null;
    },
  },
  {
    name: 'triggersandbows.com',
    url: 'https://www.triggersandbows.com',
    family: 'Ecwid-on-WordPress (coexist)',
    assert: (r) => {
      // COEXIST INVARIANT — BOTH must be present.
      if (!hasMarker(r, 'ecwid', 'strong') && !hasMarker(r, 'ecwid', 'medium'))
        return `expected 'ecwid' marker (strong or medium), got [${r.markers.map((m) => `${m.marker}:${m.strength}`).join(', ')}]`;
      if (!hasMarker(r, 'wordpress'))
        return `expected 'wordpress' marker (coexist — both emitted), got [${r.markers.map((m) => `${m.marker}:${m.strength}`).join(', ')}]`;
      // Ecwid storefront API probe — storeId was extracted and API was hit.
      const ec = r.apiEndpointsReachable.ecwidStorefront;
      if (!ec)
        return `expected ecwidStorefront probe to have run (storeId extracted from HTML), got null`;
      if (ec.status !== 200)
        return `expected ecwidStorefront.status=200, got ${ec.status} (err=${ec.errorMessage})`;
      // totalProductsCount is the structured field parsed from the full JSON
      // response before truncation. Proves the storefront API returned a
      // well-formed Ecwid product-search response.
      if (ec.totalProductsCount === null || ec.totalProductsCount < 1)
        return `expected ecwidStorefront.totalProductsCount>=1, got ${ec.totalProductsCount}`;
      // topCandidates ranking — ecwid should beat bare wordpress because
      // it has strong strength + API bonus (score >= 6) vs wordpress weak/medium.
      const top = r.topCandidates[0];
      if (!top || top.platform !== 'ecwid')
        return `expected topCandidates[0]=ecwid (score should beat wordpress due to strong marker + API bonus), got ${top?.platform} (full: ${JSON.stringify(r.topCandidates.slice(0, 5))})`;
      return null;
    },
  },
  {
    name: 'bullseyenorth.com',
    url: 'https://www.bullseyenorth.com',
    family: 'Celerant / ColdFusion (coexist)',
    assert: (r) => {
      // COEXIST INVARIANT — BOTH must be present.
      if (!hasMarker(r, 'celerant-coldfusion', 'strong'))
        return `expected strong 'celerant-coldfusion' marker (celerantwebservices.com script URL), got [${r.markers.map((m) => `${m.marker}:${m.strength}`).join(', ')}]`;
      if (!hasMarker(r, 'coldfusion'))
        return `expected 'coldfusion' marker (CFID/CFTOKEN cookies), got [${r.markers.map((m) => `${m.marker}:${m.strength}`).join(', ')}]`;
      // No competing ecommerce platform false-positives — Celerant's homepage
      // HTML should NOT match WC/Shopify/Magento markers.
      if (hasMarker(r, 'woocommerce'))
        return `expected NO woocommerce marker on Celerant site`;
      if (hasMarker(r, 'shopify'))
        return `expected NO shopify marker on Celerant site`;
      if (hasMarker(r, 'magento-1.x') || hasMarker(r, 'magento-2.x'))
        return `expected NO magento markers on Celerant site`;
      // topCandidates[0] should be celerant-coldfusion (score 3 from strong)
      // or coldfusion (if double-emitted + CFID/CFTOKEN cookies both hit).
      // Either is an acceptable outcome — the skill handles the "prefer
      // informative tag" rule. Assert one of them wins.
      const top = r.topCandidates[0];
      const topAcceptable =
        top && (top.platform === 'celerant-coldfusion' || top.platform === 'coldfusion');
      if (!topAcceptable)
        return `expected topCandidates[0] in {celerant-coldfusion, coldfusion}, got ${top?.platform} (full: ${JSON.stringify(r.topCandidates.slice(0, 5))})`;
      return null;
    },
  },
];

interface TestResult {
  name: string;
  family: string;
  passed: boolean;
  error: string | null;
  result: ProbePlatformResult;
  wallMs: number;
}

async function runCase(c: TestCase): Promise<TestResult> {
  process.stderr.write(`\n── [${c.family}] ${c.url} ──\n`);
  const t0 = Date.now();
  let r: ProbePlatformResult;
  try {
    r = await runProbePlatform(c.url);
  } catch (e: any) {
    return {
      name: c.name,
      family: c.family,
      passed: false,
      error: `runProbePlatform threw: ${e?.message || e}`,
      result: {} as ProbePlatformResult,
      wallMs: Date.now() - t0,
    };
  }
  const wallMs = Date.now() - t0;
  const err = c.assert(r);
  const passed = err === null;
  const markerSummary = r.markers.map((m) => `${m.marker}:${m.strength}`).join(', ');
  const topSummary = r.topCandidates
    .slice(0, 3)
    .map((tc) => `${tc.platform}=${tc.score}`)
    .join(', ');
  process.stderr.write(
    `  markers=[${markerSummary}] top=[${topSummary}] overlays=[${r.jsOverlayDetected.join(',')}] wall=${wallMs}ms → ${passed ? 'PASS' : 'FAIL: ' + err}\n`,
  );
  if (!passed || r.warnings.length > 0) {
    const apiSummary = [
      `wc-store=${r.apiEndpointsReachable.wpJsonWcStore?.status ?? 'null'}/x-wp-total=${r.apiEndpointsReachable.wpJsonWcStore?.xWpTotal ?? 'null'}`,
      `wp-v2=${r.apiEndpointsReachable.wpJsonWpV2?.status ?? 'null'}`,
      `shopify=${r.apiEndpointsReachable.shopifyProducts?.status ?? 'null'}/count=${r.apiEndpointsReachable.shopifyProducts?.count ?? 'null'}`,
      `bc-gql=${r.apiEndpointsReachable.bcGraphQL?.status ?? 'null'}`,
      `ecwid=${r.apiEndpointsReachable.ecwidStorefront?.status ?? 'n/a'}`,
      `magento=${r.apiEndpointsReachable.magentoRest?.status ?? 'null'}`,
    ].join(' ');
    process.stderr.write(`  APIs: ${apiSummary}\n`);
    process.stderr.write(
      `  generator=${r.generatorMeta ?? 'none'} server=${r.headerServer ?? 'none'} poweredBy=${r.headerPoweredBy ?? 'none'}\n`,
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
    '║ probe-platform.ts — 5-site regression (5 platform families)  ║\n',
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
  const colW = { n: 22, f: 38 };
  process.stderr.write(
    `${'site'.padEnd(colW.n)}  ${'family'.padEnd(colW.f)}  top-candidate           markers  result\n`,
  );
  process.stderr.write('─'.repeat(colW.n + colW.f + 55) + '\n');
  for (const r of results) {
    const top = r.result.topCandidates?.[0]
      ? `${r.result.topCandidates[0].platform}=${r.result.topCandidates[0].score}`
      : '(none)';
    const markerCount = String(r.result.markers?.length ?? 0).padEnd(6);
    process.stderr.write(
      `${r.name.padEnd(colW.n)}  ${r.family.padEnd(colW.f)}  ${top.padEnd(22)}  ${markerCount}  ${r.passed ? 'PASS' : 'FAIL: ' + r.error}\n`,
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
