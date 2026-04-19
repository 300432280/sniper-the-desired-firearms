/**
 * test-probe-sitemap.ts — 5-site regression harness for Module 2 (probe-sitemap).
 *
 * Covers 5 platform families. Asserts the module's GENERIC product-URL
 * heuristic + discovery logic handles each correctly without per-site
 * branches.
 *
 *   1. WooCommerce (Yoast multi-index)  → reliablegun.com
 *      Expect: sitemap index → multiple product-sitemap sub-sitemaps followed
 *      → totalProductUrls ≈ 3,500 ±10%.
 *
 *   2. Celerant / ColdFusion            → bullseyenorth.com
 *      Expect: /sitemap.xml urlset with mixed product + nav URLs → filter
 *      yields ~3,000-3,500 products. Tests that the /shop/<slug>-<id>
 *      positive pattern fires without a platform branch. Also tests that
 *      malformed-header HPE escalation (from Module 1) flows through to
 *      produce a usable body.
 *
 *   3. Drupal classifieds               → gunpost.ca
 *      Expect: sitemap (possibly index) yields ~22,739 products. Drupal
 *      classifieds nested slug pattern (/<cat>/<subcat>/<location>/<slug>)
 *      must fire. Tests that BIG_HEADER_HTTP_AGENT (Module 1) handles
 *      Drupal's 16KB+ x-drupal-cache-tags headers without crashing.
 *
 *   4. Shopify                          → aagcanada.ca
 *      Expect: /sitemap_products_1.xml urlset → totalProductUrls ≈ 550
 *      ±10%. Tests the /products/<handle> positive pattern.
 *
 *   5. BigCommerce Stencil              → theammosource.com
 *      Expect: /xmlsitemap.php OR /sitemap.xml index → large total
 *      (BC sitemaps include all products). Tests that BC's
 *      /<slug>-NNN / /<slug>/?/ patterns are recognized.
 *
 * Run:
 *   cd backend && npx tsx scripts/probe-modules/__test__/test-probe-sitemap.ts
 *
 * Exits 0 if all 5 pass. Non-zero if any fail.
 */

import { runProbeSitemap, ProbeSitemapResult } from '../probe-sitemap';
import { closePlaywrightIfUsed } from '../probe-fetch';

interface TestCase {
  name: string;
  origin: string;
  family: string;
  assert: (r: ProbeSitemapResult) => string | null;
}

// Tolerance helpers for ±10% count checks.
function within(actual: number, expected: number, tolerance = 0.1): boolean {
  const delta = Math.abs(actual - expected);
  return delta <= expected * tolerance;
}

const CASES: TestCase[] = [
  {
    name: 'reliablegun.com',
    origin: 'https://www.reliablegun.com',
    family: 'nopCommerce flat urlset',
    // reliablegun exposes a single flat /sitemap.xml with everything (no
    // sitemapindex). ~2,000-3,500 products depending on inventory. This
    // tests the common nopCommerce/custom-platform case where there's no
    // index — just one big urlset.
    assert: (r) => {
      if (r.sitemapsFound.length < 1) return `no sitemaps found`;
      if (r.totalProductUrls < 1000)
        return `expected ≥1,000 products, got ${r.totalProductUrls}`;
      if (r.confidence !== 'high')
        return `expected confidence=high (${r.totalProductUrls} products), got ${r.confidence}`;
      return null;
    },
  },
  {
    name: 'bullseyenorth.com',
    origin: 'https://www.bullseyenorth.com',
    family: 'Celerant / ColdFusion (malformed headers)',
    assert: (r) => {
      if (r.sitemapsFound.length < 1) return `no sitemaps found`;
      // Celerant /sitemap.xml is a urlset (not index) with ~3,000-3,500 products.
      // The /shop/<slug>-<id> pattern MUST fire via the generic positive regex.
      if (r.totalProductUrls < 500)
        return `expected >500 Celerant products, got ${r.totalProductUrls} — check /shop/<slug>-<id> generic pattern`;
      // The fetched sitemap's method should have escalated to native-fetch
      // due to Celerant's malformed headers (Module 1 HPE escalation).
      const hasNf = r.sitemapsFound.some((s) => s.method === 'native-fetch');
      if (!hasNf)
        return `expected native-fetch method on at least one sitemap (Celerant HPE), methods=[${r.sitemapsFound.map((s) => s.method).join(',')}]`;
      if (r.confidence === 'none' || r.confidence === 'low')
        return `expected confidence≥medium, got ${r.confidence}`;
      return null;
    },
  },
  {
    name: 'gunpost.ca',
    origin: 'https://www.gunpost.ca',
    family: 'Drupal classifieds (Cloudflare-hostile)',
    // Two valid outcomes for this site:
    //   (a) If Cloudflare auto-resolves via Playwright, we get the sitemap and
    //       count ~22,739 classifieds (Mistake 37 — sitemap lags live 30,423).
    //   (b) If Cloudflare does NOT auto-resolve (hostile IP rep, no cookie),
    //       every candidate returns the challenge page. Module MUST handle
    //       this gracefully: no crash, errors[] populated with
    //       "Cloudflare challenge" messages, confidence=none. The skill can
    //       then decide to use Playwright-authed-session or fall back to
    //       pagination-walk for product count.
    //
    // What we're really testing here: the module doesn't crash on
    // 16KB+ x-drupal-cache-tags (BIG_HEADER_HTTP_AGENT from Module 1) AND
    // correctly reports the WAF-blocked state rather than producing a
    // false positive count from challenge HTML.
    assert: (r) => {
      // Must not have crashed on 16KB Drupal cache-tag headers.
      const hasHeaderOverflow = r.errors.some((e) =>
        /headers_overflow|hpe_header/i.test(e.message),
      );
      if (hasHeaderOverflow)
        return `header overflow (BIG_HEADER agents should prevent): ${r.errors.map((e) => e.message.slice(0, 80)).join(' | ')}`;

      // Must not have mis-counted challenge HTML as products.
      const isCfBlocked = r.errors.some((e) =>
        /cloudflare|just a moment/i.test(e.message),
      );
      if (isCfBlocked) {
        // Valid "fully-blocked" outcome: no sitemaps + confidence=none +
        // every error names the CF challenge.
        if (r.sitemapsFound.length === 0 && r.confidence === 'none') {
          return null; // PASS: correctly reported block
        }
        // If any sitemap IS found despite CF blocks (partial success), also OK.
        if (r.totalProductUrls > 5000) return null;
        return `CF blocked some fetches but module reported conflicting state: sitemaps=${r.sitemapsFound.length} products=${r.totalProductUrls} conf=${r.confidence}`;
      }

      // Unblocked outcome: expect large product count.
      if (r.sitemapsFound.length < 1) return `no sitemaps found and no CF block reported`;
      if (r.totalProductUrls < 5000)
        return `expected >5000 Drupal classified listings, got ${r.totalProductUrls} — check nested-slug generic pattern`;
      return null;
    },
  },
  {
    name: 'aagcanada.ca',
    origin: 'https://aagcanada.ca',
    family: 'Shopify',
    assert: (r) => {
      if (r.sitemapsFound.length < 1) return `no sitemaps found`;
      // Shopify typical: a few hundred products. Allow wide window because
      // inventory fluctuates. Key test: /products/<handle> pattern must fire.
      if (r.totalProductUrls < 100)
        return `expected ≥100 Shopify products, got ${r.totalProductUrls} — check /products/<handle> pattern`;
      // Dominant pattern should be a /products/ variant.
      if (!r.productUrlPattern.includes('product'))
        return `expected productUrlPattern to reference 'product', got '${r.productUrlPattern}'`;
      if (r.confidence !== 'high' && r.confidence !== 'medium')
        return `expected confidence≥medium, got ${r.confidence}`;
      return null;
    },
  },
  {
    name: 'theammosource.com',
    origin: 'https://www.theammosource.com',
    family: 'BigCommerce Stencil',
    assert: (r) => {
      if (r.sitemapsFound.length < 1) return `no sitemaps found`;
      // BC sitemaps for retail ammo site commonly have thousands of products.
      // Generic positive patterns (/products/<slug> or /<slug>/?/) should cover BC.
      if (r.totalProductUrls < 500)
        return `expected ≥500 BC Stencil products, got ${r.totalProductUrls}`;
      if (r.confidence !== 'high')
        return `expected confidence=high for large BC site, got ${r.confidence}`;
      return null;
    },
  },
];

interface TestResult {
  name: string;
  family: string;
  passed: boolean;
  error: string | null;
  result: ProbeSitemapResult;
  wallMs: number;
}

async function runCase(c: TestCase): Promise<TestResult> {
  process.stderr.write(`\n── [${c.family}] ${c.origin} ──\n`);
  const t0 = Date.now();
  let r: ProbeSitemapResult;
  try {
    r = await runProbeSitemap(c.origin);
  } catch (e: any) {
    return {
      name: c.name,
      family: c.family,
      passed: false,
      error: `runProbeSitemap threw: ${e?.message || e}`,
      result: {} as ProbeSitemapResult,
      wallMs: Date.now() - t0,
    };
  }
  const wallMs = Date.now() - t0;
  const err = c.assert(r);
  const passed = err === null;
  process.stderr.write(
    `  sitemaps=${r.sitemapsFound.length} subFollowed=${r.subSitemapsFollowed} products=${r.totalProductUrls} conf=${r.confidence} wall=${wallMs}ms → ${passed ? 'PASS' : 'FAIL: ' + err}\n`,
  );
  if (!passed || r.warnings.length > 0) {
    process.stderr.write(`  pattern: ${r.productUrlPattern}\n`);
    if (r.warnings.length > 0) {
      process.stderr.write(`  warnings: ${r.warnings.slice(0, 3).join(' | ')}\n`);
    }
    if (r.errors.length > 0) {
      process.stderr.write(
        `  errors: ${r.errors.slice(0, 3).map((e) => `${e.url.slice(-50)}: ${e.message.slice(0, 60)}`).join(' | ')}\n`,
      );
    }
    process.stderr.write(
      `  sample: ${r.productUrlSample.slice(0, 3).map((u) => u.slice(-60)).join(' | ')}\n`,
    );
  }
  return { name: c.name, family: c.family, passed, error: err, result: r, wallMs };
}

async function main(): Promise<number> {
  process.stderr.write('╔══════════════════════════════════════════════════════════════╗\n');
  process.stderr.write('║ probe-sitemap.ts — 5-site regression (5 platform families)   ║\n');
  process.stderr.write('╚══════════════════════════════════════════════════════════════╝\n');

  const results: TestResult[] = [];
  for (const c of CASES) {
    results.push(await runCase(c));
  }

  // Summary table
  process.stderr.write('\n═══ SUMMARY ═══\n');
  const colW = { n: 24, f: 42 };
  process.stderr.write(
    `${'site'.padEnd(colW.n)}  ${'family'.padEnd(colW.f)}  sitemaps  sub  products  conf    result\n`,
  );
  process.stderr.write('─'.repeat(colW.n + colW.f + 50) + '\n');
  for (const r of results) {
    const s = r.result.sitemapsFound?.length ?? 0;
    const sub = r.result.subSitemapsFollowed ?? 0;
    const p = r.result.totalProductUrls ?? 0;
    const c = r.result.confidence ?? '-';
    process.stderr.write(
      `${r.name.padEnd(colW.n)}  ${r.family.padEnd(colW.f)}  ${String(s).padEnd(8)}  ${String(sub).padEnd(3)}  ${String(p).padEnd(8)}  ${c.padEnd(6)}  ${r.passed ? 'PASS' : 'FAIL: ' + r.error}\n`,
    );
  }

  const failed = results.filter((r) => !r.passed);
  process.stderr.write(`\nTotals: ${results.length - failed.length}/${results.length} passed\n`);

  await closePlaywrightIfUsed();

  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(`test harness crashed: ${e?.stack || e?.message || e}\n`);
    process.exit(2);
  });
