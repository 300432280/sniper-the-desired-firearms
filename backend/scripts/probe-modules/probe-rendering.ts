/**
 * probe-rendering.ts — Module 7 of the decomposed pre-bootstrap probe.
 *
 * Single responsibility: given ONE catalog URL, answer the question "does
 * this URL need Playwright to extract products, or does plain HTTP suffice?"
 *
 * Mechanism:
 *   1. Static fetch via probe-extraction with mode='static' (NO auto-escalation
 *      to Playwright — probe-fetch's WAF body heuristic is bypassed so we
 *      get a HONEST picture of what plain axios sees).
 *   2. If static products >= STATIC_OK_THRESHOLD (5) → short-circuit:
 *      verdict='static-ok', needsPlaywright=false, Playwright NOT called.
 *   3. Otherwise re-fetch via probe-extraction with mode='playwright'.
 *      Compare static vs Playwright outcomes and emit one of four verdicts.
 *
 * Why a short-circuit is essential (design rationale):
 *   Module 7 will run on every catalog URL shortlisted by Module 5. Most
 *   fleet catalog URLs (60%+) are static-HTML-first (WooCommerce, Magento,
 *   BigCommerce Stencil, Celerant, Volusion, OpenCart, Wix Stores SSR, etc.).
 *   Calling Playwright for those just to confirm "yes static is fine" would
 *   waste ~20s per URL, ~2 minutes per site. The short-circuit keeps the
 *   probe fast for the common case while still paying the Playwright cost
 *   when static genuinely returns nothing.
 *
 * Why the threshold is 5 (and not 1):
 *   A page may extract 1-4 stray products from header recent-items, cart
 *   modals, footer featured, etc. 5+ is a reliable signal that the primary
 *   product grid has been rendered by static HTML. In Module 6's regression,
 *   static-capable sites all produced 10-50+ products on catalog pages;
 *   Playwright-required sites (gotenda Sucuri WAF) produced 0 statically.
 *   The gap between "0-1 strays" and "10+ real products" is wide enough
 *   that 5 is a safe cutoff.
 *
 * Key lesson encoded (Mistake 19 — "test the production Playwright fallback
 * before declaring SPA blocked"):
 *   Two past audits on liangjian.ca saw 0 static products and immediately
 *   wrote `blockedReason: 'godaddy-ols-spa-api-on-foreign-origin'` into the
 *   profile. Neither tested the production Playwright fallback first. This
 *   module makes that testing MANDATORY and AUTOMATIC — if static returns
 *   <5 products, Playwright is called unconditionally before any verdict
 *   is emitted. The skill layer never gets a chance to declare "blocked"
 *   without empirical Playwright evidence.
 *
 * CLI:
 *   npx tsx scripts/probe-modules/probe-rendering.ts <catalogUrl>
 *     [--ua desktop|iphone|custom:<string>]
 *     [--waf-suspected]
 *     [--timeout <ms>]
 *
 * Output: JSON to stdout. Progress to stderr.
 * Exit: 0 on successful comparison; 1 if both fetches failed entirely;
 *       2 on bad args.
 *
 * Does NOT:
 *   - Decide platform (Module 4)
 *   - Decide catalogUrls (Module 5)
 *   - Run extraction on multiple URLs
 *   - Solve WAF directly (probe-fetch escalates on authoritative signatures,
 *     but here we force mode='static' first so static honestly fails on WAF
 *     sites — then mode='playwright' handles them the same way WAF sites
 *     are handled by the production crawler)
 *   - Drive Playwright UI (clicking sort dropdowns, pagination buttons) —
 *     that's for the skill layer, not a mechanical probe module.
 */

import { runProbeExtraction, ProbeExtractionResult } from './probe-extraction';
import { closePlaywrightIfUsed, UaMode } from './probe-fetch';

// ── Thresholds ───────────────────────────────────────────────────────────────

/** Static product count at or above which we short-circuit and skip Playwright. */
const STATIC_OK_THRESHOLD = 5;

/** Playwright count at or above which we consider it a successful render. */
const PLAYWRIGHT_OK_THRESHOLD = 5;

/** Ratio above which Playwright is "meaningfully more" than static. */
const PLAYWRIGHT_VS_STATIC_RATIO = 2.0;

// ── Types ────────────────────────────────────────────────────────────────────

export type RenderingVerdict =
  | 'static-ok'
  | 'static-zero-playwright-ok'
  | 'both-zero'
  | 'static-ok-playwright-also-ok';

export interface StaticFetchSummary {
  status: number | null;
  bodyBytes: number;
  productCount: number;
  method: 'axios' | 'native-fetch' | 'playwright' | 'none';
}

export interface PlaywrightFetchSummary {
  status: number | null;
  bodyBytes: number;
  productCount: number;
}

export interface ProbeRenderingResult {
  testUrl: string;
  staticFetch: StaticFetchSummary;
  /** null when short-circuit fires (static >= threshold); populated otherwise. */
  playwrightFetch: PlaywrightFetchSummary | null;
  verdict: RenderingVerdict;
  needsPlaywright: boolean;
  reason: string;
  wallMs: number;
}

export interface RunProbeRenderingOpts {
  ua?: UaMode;
  wafSuspected?: boolean;
  timeoutMs?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const log = (m: string) => process.stderr.write(m + '\n');

function summarizeStatic(r: ProbeExtractionResult): StaticFetchSummary {
  return {
    status: r.status,
    bodyBytes: r.bodyBytes,
    productCount: r.productCount,
    // `fetchMethod` is null only when the fetch failed entirely — encode as
    // 'none' in the summary so downstream consumers never see a silent null.
    method: (r.fetchMethod ?? 'none') as StaticFetchSummary['method'],
  };
}

function summarizePlaywright(r: ProbeExtractionResult): PlaywrightFetchSummary {
  return {
    status: r.status,
    bodyBytes: r.bodyBytes,
    productCount: r.productCount,
  };
}

/**
 * Decide the verdict given static and (optional) Playwright counts.
 * Pure function — no side effects.
 */
function decideVerdict(
  staticCount: number,
  playwrightCount: number | null,
): { verdict: RenderingVerdict; needsPlaywright: boolean; reason: string } {
  // Short-circuit path — Playwright not called.
  if (playwrightCount === null) {
    return {
      verdict: 'static-ok',
      needsPlaywright: false,
      reason: `static returned ${staticCount} products (>= ${STATIC_OK_THRESHOLD} threshold); Playwright not needed`,
    };
  }

  // Full comparison path.
  if (staticCount === 0 && playwrightCount >= PLAYWRIGHT_OK_THRESHOLD) {
    return {
      verdict: 'static-zero-playwright-ok',
      needsPlaywright: true,
      reason: `static returned 0 products but Playwright returned ${playwrightCount} — SPA or WAF-gated content (Mistake 19)`,
    };
  }

  if (staticCount === 0 && playwrightCount === 0) {
    return {
      verdict: 'both-zero',
      needsPlaywright: false,
      reason: `both static and Playwright returned 0 products — URL may be wrong, deeply blocked, or page has no product grid`,
    };
  }

  // static > 0 cases
  if (playwrightCount > 0 && playwrightCount >= staticCount * PLAYWRIGHT_VS_STATIC_RATIO) {
    return {
      verdict: 'static-ok-playwright-also-ok',
      needsPlaywright: true,
      reason: `static returned ${staticCount} but Playwright returned ${playwrightCount} (${(playwrightCount / Math.max(staticCount, 1)).toFixed(1)}× more) — partial SSR, Playwright recommended for full coverage`,
    };
  }

  // static > 0 and Playwright didn't meaningfully exceed it. Treat as static-ok;
  // this path is only reachable when static was in the 1..(threshold-1) range
  // AND Playwright didn't do dramatically better. Skill layer decides if the
  // low absolute count (e.g. 2 products) is a real problem or just a small
  // category.
  return {
    verdict: 'static-ok',
    needsPlaywright: false,
    reason: `static returned ${staticCount} products; Playwright returned ${playwrightCount} (no meaningful gain)`,
  };
}

// ── Main public API ──────────────────────────────────────────────────────────

export async function runProbeRendering(
  catalogUrl: string,
  opts: RunProbeRenderingOpts = {},
): Promise<ProbeRenderingResult> {
  const t0 = Date.now();

  // ── Step 1: static fetch ───────────────────────────────────────────────────
  // Force mode='static' — we do NOT want probe-fetch's auto-escalation to
  // Playwright here, because the whole point of this module is to get an
  // HONEST static-fetch signal. If static would have escalated via the WAF
  // heuristic, that's a signal Playwright is needed — and Step 2 will call
  // Playwright explicitly.
  log(`[probe-rendering] static fetch: ${catalogUrl}`);
  const staticResult = await runProbeExtraction(catalogUrl, {
    mode: 'static',
    ua: opts.ua ?? 'desktop',
    wafSuspected: opts.wafSuspected,
    timeoutMs: opts.timeoutMs,
  });

  const staticSummary = summarizeStatic(staticResult);
  log(
    `[probe-rendering] static: status=${staticSummary.status} method=${staticSummary.method} body=${staticSummary.bodyBytes}b products=${staticSummary.productCount}`,
  );

  // ── Step 2: short-circuit if static is sufficient ──────────────────────────
  if (staticSummary.productCount >= STATIC_OK_THRESHOLD) {
    const { verdict, needsPlaywright, reason } = decideVerdict(
      staticSummary.productCount,
      null,
    );
    return {
      testUrl: catalogUrl,
      staticFetch: staticSummary,
      playwrightFetch: null,
      verdict,
      needsPlaywright,
      reason,
      wallMs: Date.now() - t0,
    };
  }

  // ── Step 3: fall back to Playwright ────────────────────────────────────────
  log(
    `[probe-rendering] static returned ${staticSummary.productCount} (< ${STATIC_OK_THRESHOLD}) — calling Playwright`,
  );
  const playwrightResult = await runProbeExtraction(catalogUrl, {
    mode: 'playwright',
    ua: opts.ua ?? 'desktop',
    timeoutMs: opts.timeoutMs,
  });

  const playwrightSummary = summarizePlaywright(playwrightResult);
  log(
    `[probe-rendering] playwright: status=${playwrightSummary.status} body=${playwrightSummary.bodyBytes}b products=${playwrightSummary.productCount}`,
  );

  const { verdict, needsPlaywright, reason } = decideVerdict(
    staticSummary.productCount,
    playwrightSummary.productCount,
  );

  return {
    testUrl: catalogUrl,
    staticFetch: staticSummary,
    playwrightFetch: playwrightSummary,
    verdict,
    needsPlaywright,
    reason,
    wallMs: Date.now() - t0,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { url: string; opts: RunProbeRenderingOpts } | null {
  const positional: string[] = [];
  const opts: RunProbeRenderingOpts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ua') {
      const v = argv[++i];
      if (v === 'desktop' || v === 'iphone') opts.ua = v;
      else if (v?.startsWith('custom:')) opts.ua = v as UaMode;
      else return null;
    } else if (a === '--waf-suspected') {
      opts.wafSuspected = true;
    } else if (a === '--timeout') {
      const v = argv[++i];
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return null;
      opts.timeoutMs = n;
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
      'usage: probe-rendering.ts <catalogUrl> [--ua desktop|iphone|custom:<string>] [--waf-suspected] [--timeout <ms>]\n',
    );
    return 2;
  }
  const result = await runProbeRendering(parsed.url, parsed.opts);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  await closePlaywrightIfUsed();
  // Exit 0 on any successful comparison (including both-zero — that's a
  // valid verdict). Exit 1 only if static fetch completely crashed AND
  // Playwright wasn't even attempted (shouldn't happen — runProbeExtraction
  // never crashes, it returns status:null). The reachable failure mode is
  // verdict=both-zero + static.method='none' — which still exits 0, because
  // the MODULE succeeded in reporting the comparison.
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`probe-rendering crashed: ${e?.stack || e?.message || e}\n`);
      process.exit(1);
    });
}
