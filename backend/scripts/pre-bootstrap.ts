/**
 * pre-bootstrap.ts — Orchestrator composing the 9 decomposed probe modules.
 *
 * Single responsibility: given an input URL, run all probe modules in
 * dependency order, collect their outputs into a single evidence blob, and
 * write that blob to stdout + `pre-bootstrap-output/<domain>.json`.
 *
 * THIS MODULE IS INTENTIONALLY THIN.
 *   - NO interpretation of module outputs.
 *   - NO platform-specific branching (`if (platform === 'woocommerce') ...`).
 *   - NO business logic beyond one ~15-line testUrl picker.
 *   - Each module runs in try/catch — a single module failure does not abort
 *     the run. The only fatal is probe-access crashing (downstream modules
 *     cannot proceed without a canonical origin).
 *
 * Module order (dependencies top-down):
 *   1. probe-access        (URL)            → canonicalOrigin, recommendedUa, hasWaf
 *   2. probe-platform      (canonicalOrigin, ua)
 *   3. probe-sitemap       (canonicalOrigin, ua)
 *   4. probe-catalog-urls  (canonicalOrigin, ua, wafSuspected)
 *   5. pickTestUrl         (catalogUrls, canonicalOrigin)   ← tiny inline helper
 *   6. probe-rendering     (testUrl, ua, wafSuspected)
 *   7. probe-extraction    (testUrl, ua, mode)
 *   8. probe-sort          (testUrl, ua, mode)
 *   9. probe-pagination    (testUrl, ua, sortUrl)
 *
 * CLI:
 *   npx tsx scripts/pre-bootstrap.ts <url> [--output-dir <path>]
 *
 * Exit: 0 on any completion (even with moduleErrors); 1 if access fatal;
 *       2 on bad args.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { closePlaywrightIfUsed, UaMode } from './probe-modules/probe-fetch';
import { runProbeAccess, ProbeAccessResult } from './probe-modules/probe-access';
import { runProbePlatform, ProbePlatformResult } from './probe-modules/probe-platform';
import { runProbeSitemap, ProbeSitemapResult } from './probe-modules/probe-sitemap';
import {
  runProbeCatalogUrls,
  ProbeCatalogUrlsResult,
} from './probe-modules/probe-catalog-urls';
import { runProbeRendering, ProbeRenderingResult } from './probe-modules/probe-rendering';
import { runProbeExtraction, ProbeExtractionResult } from './probe-modules/probe-extraction';
import { runProbeSort, ProbeSortResult } from './probe-modules/probe-sort';
import { runProbePagination, ProbePaginationResult } from './probe-modules/probe-pagination';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PreBootstrapEvidence {
  inputUrl: string;
  canonicalOrigin: string;
  runAt: string;
  runDurationMs: number;
  testUrl: string | null;
  testUrlReason: string;
  access: ProbeAccessResult;
  platform: ProbePlatformResult | null;
  sitemap: ProbeSitemapResult | null;
  catalogUrls: ProbeCatalogUrlsResult | null;
  rendering: ProbeRenderingResult | null;
  extraction: ProbeExtractionResult | null;
  sort: ProbeSortResult | null;
  pagination: ProbePaginationResult | null;
  moduleErrors: Array<{ module: string; error: string }>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const log = (m: string) => process.stderr.write(m + '\n');

/**
 * testUrl picker — ~15 lines, NOT a separate module.
 * Priority:
 *   1. Highest productCount from taxonomy-API candidates (authoritative counts).
 *   2. First nav-menu or homepage-anchor candidate.
 *   3. First sitemap-dirname candidate.
 *   4. Origin root (last-resort; rendering/extraction will likely fail usefully).
 */
function pickTestUrl(
  catalogUrls: ProbeCatalogUrlsResult | null,
  canonicalOrigin: string,
): { url: string; reason: string } {
  if (!catalogUrls || catalogUrls.candidates.length === 0) {
    return { url: canonicalOrigin + '/', reason: 'no catalog candidates — falling back to origin root' };
  }
  const apiCandidates = catalogUrls.candidates
    .filter(
      (c) =>
        (c.source === 'wp-taxonomy-api' ||
          c.source === 'shopify-collections' ||
          c.source === 'bc-categories') &&
        typeof c.productCount === 'number' &&
        (c.productCount ?? 0) > 0,
    )
    .sort((a, b) => (b.productCount ?? 0) - (a.productCount ?? 0));
  if (apiCandidates.length > 0) {
    return {
      url: apiCandidates[0].url,
      reason: `highest taxonomy-API productCount (${apiCandidates[0].productCount} from ${apiCandidates[0].source})`,
    };
  }
  const navCandidate = catalogUrls.candidates.find(
    (c) => c.source === 'nav-menu' || c.source === 'homepage-anchor',
  );
  if (navCandidate) {
    return { url: navCandidate.url, reason: `first nav/anchor candidate (${navCandidate.source})` };
  }
  const dirCandidate = catalogUrls.candidates.find((c) => c.source === 'sitemap-dirname');
  if (dirCandidate) {
    return { url: dirCandidate.url, reason: 'first sitemap-dirname candidate' };
  }
  return { url: canonicalOrigin + '/', reason: 'no usable candidates — falling back to origin root' };
}

function deriveDomainFilename(canonicalOrigin: string): string {
  try {
    const host = new URL(canonicalOrigin).host;
    return host.replace(/[^a-z0-9.-]/gi, '_') + '.json';
  } catch {
    return canonicalOrigin.replace(/[^a-z0-9.-]/gi, '_') + '.json';
  }
}

async function safeRun<T>(
  label: string,
  fn: () => Promise<T>,
  moduleErrors: Array<{ module: string; error: string }>,
): Promise<T | null> {
  try {
    return await fn();
  } catch (e: any) {
    const msg = e?.stack || e?.message || String(e);
    log(`[pre-bootstrap] ${label} threw: ${msg.split('\n')[0]}`);
    moduleErrors.push({ module: label, error: msg.slice(0, 2000) });
    return null;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

export interface RunOrchestratorOpts {
  outputDir?: string;
}

export async function runPreBootstrap(
  inputUrl: string,
  opts: RunOrchestratorOpts = {},
): Promise<PreBootstrapEvidence> {
  const t0 = Date.now();
  const runAt = new Date().toISOString();
  const moduleErrors: Array<{ module: string; error: string }> = [];

  // ── Phase 1: access (FATAL on failure — need canonicalOrigin) ──────────────
  log(`[pre-bootstrap] phase 1/9: probe-access`);
  const access = await runProbeAccess(inputUrl);
  const canonicalOrigin = access.canonicalOrigin;
  const recommendedUa: UaMode = access.recommendedUa;
  const wafSuspected = access.hasWaf === true;

  // ── Phase 2: platform ──────────────────────────────────────────────────────
  log(`[pre-bootstrap] phase 2/9: probe-platform`);
  const platform = await safeRun(
    'probe-platform',
    () => runProbePlatform(canonicalOrigin, { ua: recommendedUa, wafSuspected }),
    moduleErrors,
  );

  // ── Phase 3: sitemap ───────────────────────────────────────────────────────
  log(`[pre-bootstrap] phase 3/9: probe-sitemap`);
  const sitemap = await safeRun(
    'probe-sitemap',
    () => runProbeSitemap(canonicalOrigin, { ua: recommendedUa }),
    moduleErrors,
  );

  // ── Phase 4: catalog URLs ──────────────────────────────────────────────────
  log(`[pre-bootstrap] phase 4/9: probe-catalog-urls`);
  const catalogUrls = await safeRun(
    'probe-catalog-urls',
    () => runProbeCatalogUrls(canonicalOrigin, { ua: recommendedUa, wafSuspected }),
    moduleErrors,
  );

  // ── Phase 5: pick testUrl (inline, ~15 lines) ──────────────────────────────
  const picked = pickTestUrl(catalogUrls, canonicalOrigin);
  const testUrl = picked.url;
  const testUrlReason = picked.reason;
  log(`[pre-bootstrap] testUrl picked: ${testUrl} (${testUrlReason})`);

  // ── Phase 6: rendering ─────────────────────────────────────────────────────
  log(`[pre-bootstrap] phase 6/9: probe-rendering`);
  const rendering = await safeRun(
    'probe-rendering',
    () => runProbeRendering(testUrl, { ua: recommendedUa, wafSuspected }),
    moduleErrors,
  );

  // ── Phase 7: extraction ────────────────────────────────────────────────────
  const extractionMode =
    rendering && rendering.needsPlaywright ? ('playwright' as const) : ('auto' as const);
  log(`[pre-bootstrap] phase 7/9: probe-extraction (mode=${extractionMode})`);
  const extraction = await safeRun(
    'probe-extraction',
    () =>
      runProbeExtraction(testUrl, {
        mode: extractionMode,
        ua: recommendedUa,
        wafSuspected,
      }),
    moduleErrors,
  );

  // ── Phase 8: sort ──────────────────────────────────────────────────────────
  log(`[pre-bootstrap] phase 8/9: probe-sort`);
  const sort = await safeRun(
    'probe-sort',
    () =>
      runProbeSort(testUrl, {
        ua: recommendedUa,
        mode: extractionMode,
        wafSuspected,
      }),
    moduleErrors,
  );

  // ── Phase 9: pagination ────────────────────────────────────────────────────
  // Prefer the top-ranked newest URL from probe-sort when available — this lets
  // pagination interact with the sort segment exactly as runtime would.
  const topNewestValue = sort?.rankedNewest?.[0]?.value ?? null;
  const topNewestTested =
    sort?.newestCandidates?.find((c) => c.value === topNewestValue)?.testedUrl ?? null;
  log(`[pre-bootstrap] phase 9/9: probe-pagination (sortUrl=${topNewestTested ?? 'none'})`);
  const pagination = await safeRun(
    'probe-pagination',
    () =>
      runProbePagination(testUrl, {
        ua: recommendedUa,
        mode: extractionMode,
        wafSuspected,
        sortUrl: topNewestTested ?? undefined,
      }),
    moduleErrors,
  );

  const runDurationMs = Date.now() - t0;

  const evidence: PreBootstrapEvidence = {
    inputUrl,
    canonicalOrigin,
    runAt,
    runDurationMs,
    testUrl,
    testUrlReason,
    access,
    platform,
    sitemap,
    catalogUrls,
    rendering,
    extraction,
    sort,
    pagination,
    moduleErrors,
  };

  // ── Write output file ──────────────────────────────────────────────────────
  const outputDir =
    opts.outputDir ?? path.join(__dirname, 'pre-bootstrap-output');
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    const filename = deriveDomainFilename(canonicalOrigin);
    const outPath = path.join(outputDir, filename);
    fs.writeFileSync(outPath, JSON.stringify(evidence, null, 2));
    log(`[pre-bootstrap] wrote ${outPath}`);
  } catch (e: any) {
    log(`[pre-bootstrap] failed to write output file: ${e?.message || e}`);
  }

  return evidence;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { url: string; opts: RunOrchestratorOpts } | null {
  const positional: string[] = [];
  const opts: RunOrchestratorOpts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--output-dir') {
      const v = argv[++i];
      if (!v) return null;
      opts.outputDir = v;
    } else if (a.startsWith('--')) {
      return null;
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 1) return null;
  return { url: positional[0], opts };
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) {
    process.stderr.write(
      'usage: pre-bootstrap.ts <url> [--output-dir <path>]\n',
    );
    return 2;
  }
  try {
    const evidence = await runPreBootstrap(parsed.url, parsed.opts);
    process.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
    await closePlaywrightIfUsed();
    return 0;
  } catch (e: any) {
    process.stderr.write(`pre-bootstrap access-phase fatal: ${e?.stack || e?.message || e}\n`);
    await closePlaywrightIfUsed();
    return 1;
  }
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`pre-bootstrap crashed: ${e?.stack || e?.message || e}\n`);
      process.exit(1);
    });
}
