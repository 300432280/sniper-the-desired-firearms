/**
 * test-pre-bootstrap.ts — 3-site E2E regression for the orchestrator.
 *
 * Runs the full 9-module pipeline against 3 sites covering:
 *   1. canadafirstammo.ca  — WooCommerce happy path (all phases populate).
 *   2. www.bullseyenorth.com — Celerant ColdFusion (HPE malformed headers,
 *      path-scheme sort).
 *   3. aagcanada.ca — Shopify API-heavy.
 *
 * For each site, asserts:
 *   - access.canonicalOrigin is set
 *   - platform.markers.length > 0
 *   - catalogUrls.totalCandidates > 0
 *   - testUrl !== null
 *   - extraction.productCount > 0
 *   - sort.verdict !== 'unknown'
 *   - pagination.paginationPattern !== null OR pagination.verdict === 'single-page'
 *   - moduleErrors.length === 0
 *   - output file written
 *
 * Run:
 *   cd backend && npx tsx scripts/probe-modules/__test__/test-pre-bootstrap.ts
 *
 * Exits 0 if all 3 pass. Non-zero if any fail.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { runPreBootstrap, PreBootstrapEvidence } from '../../pre-bootstrap';
import { closePlaywrightIfUsed } from '../probe-fetch';

interface TestCase {
  name: string;
  url: string;
  family: string;
  assert: (r: PreBootstrapEvidence, outputPath: string) => string | null;
}

const OUTPUT_DIR = path.join(__dirname, '..', '..', 'pre-bootstrap-output');

const CASES: TestCase[] = [
  {
    name: 'canadafirstammo.ca',
    url: 'https://canadafirstammo.ca',
    family: 'WooCommerce happy path',
    assert: (r, outPath) => {
      if (!r.access.canonicalOrigin) return `access.canonicalOrigin empty`;
      if (!r.platform) return `platform null (moduleErrors=${JSON.stringify(r.moduleErrors)})`;
      if (r.platform.markers.length === 0) return `platform.markers.length=0`;
      if (!r.catalogUrls) return `catalogUrls null`;
      if (r.catalogUrls.totalCandidates === 0) return `catalogUrls.totalCandidates=0`;
      if (!r.testUrl) return `testUrl is null`;
      if (!r.extraction) return `extraction null`;
      if (r.extraction.productCount === 0)
        return `extraction.productCount=0 (testUrl=${r.testUrl})`;
      if (!r.sort) return `sort null`;
      if (r.sort.verdict === 'unknown')
        return `sort.verdict=unknown (reason: ${r.sort.verdictReason})`;
      if (!r.pagination) return `pagination null`;
      if (r.pagination.paginationPattern === null && r.pagination.verdict !== 'single-page')
        return `pagination: no paginationPattern AND verdict=${r.pagination.verdict}`;
      if (r.moduleErrors.length > 0)
        return `moduleErrors: ${r.moduleErrors.map((e) => e.module).join(',')}`;
      if (!fs.existsSync(outPath)) return `output file not written: ${outPath}`;
      return null;
    },
  },
  {
    name: 'bullseyenorth.com',
    url: 'https://www.bullseyenorth.com',
    family: 'Celerant ColdFusion (HPE + path-sort)',
    assert: (r, outPath) => {
      if (!r.access.canonicalOrigin) return `access.canonicalOrigin empty`;
      if (!r.platform) return `platform null`;
      if (r.platform.markers.length === 0) return `platform.markers.length=0`;
      if (!r.catalogUrls) return `catalogUrls null`;
      if (r.catalogUrls.totalCandidates === 0) return `catalogUrls.totalCandidates=0`;
      if (!r.testUrl) return `testUrl is null`;
      if (!r.extraction) return `extraction null`;
      if (r.extraction.productCount === 0)
        return `extraction.productCount=0 (testUrl=${r.testUrl})`;
      if (!r.sort) return `sort null`;
      if (r.sort.verdict === 'unknown')
        return `sort.verdict=unknown (reason: ${r.sort.verdictReason})`;
      if (!r.pagination) return `pagination null`;
      if (r.pagination.paginationPattern === null && r.pagination.verdict !== 'single-page')
        return `pagination: no paginationPattern AND verdict=${r.pagination.verdict}`;
      if (r.moduleErrors.length > 0)
        return `moduleErrors: ${r.moduleErrors.map((e) => e.module).join(',')}`;
      if (!fs.existsSync(outPath)) return `output file not written: ${outPath}`;
      return null;
    },
  },
  {
    name: 'aagcanada.ca',
    url: 'https://aagcanada.ca',
    family: 'Shopify API-heavy',
    assert: (r, outPath) => {
      if (!r.access.canonicalOrigin) return `access.canonicalOrigin empty`;
      if (!r.platform) return `platform null`;
      if (r.platform.markers.length === 0) return `platform.markers.length=0`;
      if (!r.catalogUrls) return `catalogUrls null`;
      if (r.catalogUrls.totalCandidates === 0) return `catalogUrls.totalCandidates=0`;
      if (!r.testUrl) return `testUrl is null`;
      if (!r.extraction) return `extraction null`;
      if (r.extraction.productCount === 0)
        return `extraction.productCount=0 (testUrl=${r.testUrl})`;
      if (!r.sort) return `sort null`;
      if (r.sort.verdict === 'unknown')
        return `sort.verdict=unknown (reason: ${r.sort.verdictReason})`;
      if (!r.pagination) return `pagination null`;
      if (r.pagination.paginationPattern === null && r.pagination.verdict !== 'single-page')
        return `pagination: no paginationPattern AND verdict=${r.pagination.verdict}`;
      if (r.moduleErrors.length > 0)
        return `moduleErrors: ${r.moduleErrors.map((e) => e.module).join(',')}`;
      if (!fs.existsSync(outPath)) return `output file not written: ${outPath}`;
      return null;
    },
  },
];

interface TestResult {
  name: string;
  family: string;
  passed: boolean;
  error: string | null;
  evidence: PreBootstrapEvidence | null;
  outputPath: string;
  wallMs: number;
}

function outputPathFor(canonicalOrigin: string): string {
  let host: string;
  try {
    host = new URL(canonicalOrigin).host;
  } catch {
    host = canonicalOrigin;
  }
  return path.join(OUTPUT_DIR, host.replace(/[^a-z0-9.-]/gi, '_') + '.json');
}

async function runCase(c: TestCase): Promise<TestResult> {
  process.stderr.write(`\n── [${c.family}] ${c.url} ──\n`);
  const t0 = Date.now();
  let ev: PreBootstrapEvidence;
  try {
    ev = await runPreBootstrap(c.url);
  } catch (e: any) {
    return {
      name: c.name,
      family: c.family,
      passed: false,
      error: `runPreBootstrap threw: ${e?.message || e}`,
      evidence: null,
      outputPath: '',
      wallMs: Date.now() - t0,
    };
  }
  const wallMs = Date.now() - t0;
  const outPath = outputPathFor(ev.canonicalOrigin);
  const err = c.assert(ev, outPath);
  const passed = err === null;
  const phases = [
    ev.access ? 'access' : '',
    ev.platform ? 'platform' : '',
    ev.sitemap ? 'sitemap' : '',
    ev.catalogUrls ? 'catalogUrls' : '',
    ev.rendering ? 'rendering' : '',
    ev.extraction ? 'extraction' : '',
    ev.sort ? 'sort' : '',
    ev.pagination ? 'pagination' : '',
  ]
    .filter(Boolean)
    .join(',');
  process.stderr.write(
    `  phases=[${phases}] products=${ev.extraction?.productCount ?? 0} sort=${ev.sort?.verdict ?? '?'} pgn=${ev.pagination?.verdict ?? '?'} errs=${ev.moduleErrors.length} wall=${Math.round(wallMs / 1000)}s → ${passed ? 'PASS' : 'FAIL: ' + err}\n`,
  );
  if (!passed && ev.moduleErrors.length > 0) {
    for (const me of ev.moduleErrors) {
      process.stderr.write(`  moduleError[${me.module}]: ${me.error.split('\n')[0]}\n`);
    }
  }
  return { name: c.name, family: c.family, passed, error: err, evidence: ev, outputPath: outPath, wallMs };
}

async function main(): Promise<number> {
  process.stderr.write(
    '╔══════════════════════════════════════════════════════════════╗\n',
  );
  process.stderr.write(
    '║ pre-bootstrap.ts — 3-site E2E regression                     ║\n',
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
  const colW = { n: 26, f: 38 };
  process.stderr.write(
    `${'site'.padEnd(colW.n)}  ${'family'.padEnd(colW.f)}  phases  products  sort              pgn               errs  wall   result\n`,
  );
  process.stderr.write('─'.repeat(colW.n + colW.f + 85) + '\n');
  for (const r of results) {
    const phaseCount = r.evidence
      ? [
          r.evidence.access,
          r.evidence.platform,
          r.evidence.sitemap,
          r.evidence.catalogUrls,
          r.evidence.rendering,
          r.evidence.extraction,
          r.evidence.sort,
          r.evidence.pagination,
        ].filter(Boolean).length
      : 0;
    const products = r.evidence?.extraction?.productCount ?? 0;
    const sortV = (r.evidence?.sort?.verdict ?? '?').padEnd(18);
    const pgnV = (r.evidence?.pagination?.verdict ?? '?').padEnd(18);
    const errs = r.evidence?.moduleErrors.length ?? 0;
    const wall = `${Math.round(r.wallMs / 1000)}s`.padEnd(5);
    process.stderr.write(
      `${r.name.padEnd(colW.n)}  ${r.family.padEnd(colW.f)}  ${phaseCount}/8     ${String(products).padEnd(8)}  ${sortV}  ${pgnV}  ${String(errs).padEnd(4)}  ${wall}  ${r.passed ? 'PASS' : 'FAIL: ' + r.error}\n`,
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
