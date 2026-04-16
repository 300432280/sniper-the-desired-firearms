/**
 * pre-bootstrap-probe.ts — Mechanical 7-phase site probing script.
 *
 * Takes a URL, runs automated probes across 7 phases, outputs a structured
 * JSON report. No AI/judgment needed — pure automation, CI-runnable.
 *
 * Usage:
 *   cd backend && npx tsx scripts/pre-bootstrap-probe.ts https://example.com
 *
 * Output: JSON to stdout, progress to stderr.
 */

import 'dotenv/config';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { execSync } from 'child_process';
import path from 'path';
import * as https from 'https';
import * as http from 'http';
import { Agent as UndiciAgent } from 'undici';

// Custom HTTP(S) agents with generous maxHeaderSize so sites like Drupal that
// emit enormous `x-drupal-cache-tags` (16KB+) headers don't trip Node's
// default 16KB parser limit. Without this, axios throws HPE_HEADER_OVERFLOW
// and the native-fetch fallback ALSO throws UND_ERR_HEADERS_OVERFLOW —
// producing false "site unreachable" signals in Phase 3.
const BIG_HEADER_HTTP_AGENT = new http.Agent({ keepAlive: true, maxHeaderSize: 131072 } as any);
const BIG_HEADER_HTTPS_AGENT = new https.Agent({ keepAlive: true, maxHeaderSize: 131072 } as any);

// Undici dispatcher with raised header size for the native-fetch fallback.
const BIG_HEADER_UNDICI = new UndiciAgent({ maxResponseSize: -1, headersTimeout: 20000, bodyTimeout: 20000, connect: { timeout: 20000 }, maxHeaderSize: 131072 } as any);

// Single logger used everywhere. Declared early so the WAF-fallback helpers
// below (playwrightFetch, etc.) can reference it without TS complaining about
// use-before-declaration.
const log = (...args: any[]) => process.stderr.write(args.join(' ') + '\n');

// When Phase 1 confirms a JS-challenge WAF (Sucuri, Cloudflare active, Incapsula,
// SiteGround sgcaptcha), all subsequent axios HTML fetches receive the challenge
// page (tiny ~1-2 KB body with JS that sets a cookie then reloads). Running Phase
// 2+ against the challenge body produces cascading failures (0 products, null
// platform, no sort UI, no pagination). The probe falls back to
// `fetchWithPlaywright` — the same Playwright-driven fetcher used by
// `catalog-crawler.ts` / `watermark-crawler.ts` / `waf-cookie-manager.ts` — to
// obtain the real rendered HTML. See playbook Mistake 38 (2026-04-15).
let g_wafFallbackRequired = false;    // set by Phase 1 when a JS-challenge WAF is confirmed
let g_wafFallbackObserved = false;    // set at runtime when any axios response body looks like a challenge
let g_playwrightHits = 0;             // count of Playwright fallback invocations
let g_playwrightClosed = false;

/**
 * Detect whether an axios response body is a WAF challenge page (and not real
 * content). Heuristics target Sucuri (sucuri_cloudproxy_js / "You are being
 * redirected"), Cloudflare IUAM + Turnstile + managed challenge, Incapsula
 * (_Incapsula_Resource / Imperva), SiteGround sgcaptcha meta-refresh. Also
 * treat any <5KB body that passed heavy WAF detection as suspect.
 */
function isWafChallengeBody(body: string, status: number, hasWaf: boolean): boolean {
  if (!body) return false;
  // Explicit vendor signatures (authoritative — no size gate needed)
  if (/sucuri_cloudproxy_js|Sucuri\b|Access Denied - Sucuri/i.test(body)) return true;
  if (/_Incapsula_Resource|Incapsula incident|Imperva/i.test(body)) return true;
  if (/sg-?captcha|\.well-known\/sgcaptcha/i.test(body)) return true;
  if (/cf-browser-verification|cf-challenge|_cf_chl|cdn-cgi\/challenge-platform|Just a moment\.\.\.|Checking your browser|Verifying you are human|Attention Required!/i.test(body)) return true;
  // Generic small-body-with-waf-context heuristic: when Phase 1 saw WAF
  // indicators AND the body is tiny, assume a challenge even if the vendor
  // signature rotated. Keeps the probe resilient to vendor UI changes.
  if (hasWaf && body.length < 5000 && /<script[\s\S]*?(location\.reload|document\.cookie|eval\()/i.test(body)) return true;
  if (hasWaf && (status === 307 || status === 403 || status === 503) && body.length < 3000) return true;
  return false;
}

/**
 * Playwright-backed HTML fetch. Uses the same `fetchWithPlaywright` module
 * that production `catalog-crawler.ts` / `watermark-crawler.ts` already call
 * for WAF bypass — the probe piggy-backs so it doesn't reinvent Sucuri/CF
 * handling. Returns a normalized `{ status, headers, data, method }` tuple
 * compatible with `safeFetch`'s return type.
 */
async function playwrightFetch(url: string): Promise<{ status: number; headers: Record<string, any>; data: string; method: 'playwright' } | null> {
  try {
    // Lazy import so non-WAF sites never touch Playwright (saves ~800ms + browser spawn)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { fetchWithPlaywright } = await import('../src/services/scraper/playwright-fetcher');
    const { html } = await fetchWithPlaywright(url, { timeout: 45000 });
    g_playwrightHits++;
    // Playwright-sourced fetches are synthetic 200 — the browser followed
    // redirects and resolved any challenge. Headers are not exposed by
    // `fetchWithPlaywright`, so we return an empty object; callers that need
    // real headers (API probes) don't use this path.
    return { status: 200, headers: {}, data: html, method: 'playwright' };
  } catch (e: any) {
    log(`  [playwright] fetch failed for ${url}: ${(e?.message || '').slice(0, 160)}`);
    return null;
  }
}

/**
 * Ensure Playwright browser is closed at the end of the probe run. Safe to
 * call even when Playwright was never used — the import is lazy.
 */
async function closePlaywrightIfNeeded(): Promise<void> {
  if (g_playwrightClosed || g_playwrightHits === 0) return;
  g_playwrightClosed = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { closeBrowser } = await import('../src/services/scraper/playwright-fetcher');
    await closeBrowser();
  } catch { /* ignore — process exit will clean up anyway */ }
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface Confidence { value: string | number | boolean | null; confidence: 'high' | 'medium' | 'low' | 'none' }
interface ProbeError { phase: string; message: string; stack?: string }

// M10: Phase status / dependency tracking. Every phase output has these three
// fields so the assembly layer can differentiate "ran but produced no useful
// output" (failed) from "didn't run because an upstream phase failed"
// (skipped-upstream). Confidence calculation only penalizes failed phases.
type PhaseStatus = 'completed' | 'failed' | 'skipped-upstream';
interface PhaseStatusFields {
  status: PhaseStatus;
  dependencies: string[];
  skipReason: string | null;
}

interface AccessPhase extends PhaseStatusFields {
  canonicalUrl: Confidence;
  hasWaf: Confidence;
  wafType: Confidence;
  wafProbeEvidence: Record<string, any>;
  userAgentResults: { ua: string; label: string; status: number | null; error?: string; method?: string }[];
  crawlDelay: Confidence;
  robotsDisallowed: string[];
  malformedHeaders: Confidence; // NEW — Celerant/ColdFusion HPE indicator
  serverHeader: Confidence;     // NEW — captured server header from real response
}

interface PlatformPhase extends PhaseStatusFields {
  platform: Confidence;
  platformMarkers: string[];
  jsOverlay: Confidence;
  renderingMode: Confidence;
  availableApis: { name: string; accessible: boolean; productCount?: number; evidence?: string }[];
  needsPlaywright: Confidence;
  multilingual: Confidence;
  sitemapUrls: string[];
  sitemapProductCount: Confidence;
}

interface AdapterPhase extends PhaseStatusFields {
  suggestedAdapter: Confidence;
  apiAccessible: Confidence;
  extractionTestResult: {
    url: string;
    productsFound: number;
    sampleTitles: string[];
  } | null;
}

interface CatalogPhase extends PhaseStatusFields {
  categoryTree: { name: string; url: string; count?: number; parentId?: number }[];
  navLinks: string[];
  sitemapProductCount: Confidence;
  apiProductCount: Confidence;
}

interface SortOption { value: string; text: string; selectName: string; selectId: string }

interface SortPhase extends PhaseStatusFields {
  sortOptions: SortOption[];
  sortScheme: Confidence;     // 'query' | 'path' | 'hash' | 'js-only' | null
  idJumpTest: {
    defaultFirstProduct: string | null;
    newestFirstProduct: string | null;
    counterControlFirstProduct: string | null;
    newestParam: string | null;
    counterControlParam: string | null;
    verdict: 'honored' | 'honored-default-is-newest' | 'noop' | 'not-tested' | 'no-sort-options';
  };
  // Disambiguation: when multiple options match the newest-style regex
  // (e.g. Celerant has both `new-arrivals` and `newest-rcvd`), run ID-jump
  // against EACH candidate and report which one produces the distinct newest slug.
  newestCandidates?: { value: string; text: string; firstProduct: string | null; score: number }[];
  openCartDateProbe?: { param: string; firstProduct: string | null; defaultFirstProduct: string | null; honored: boolean };
}

interface PaginationPhase extends PhaseStatusFields {
  paginationPattern: Confidence;
  perPage: Confidence;
  page1Products: string[];
  page2Products: string[];
  zeroOverlap: Confidence;
  paginationLinks: string[];
  // Drupal Views and some custom paginators use 0-indexed page numbers —
  // `?page=0` = page 1, `?page=1` = page 2. Detected by scanning paginationLinks
  // for a `page=0` reference. This signal feeds into profile.paginationPattern.zeroIndexed.
  zeroIndexed: Confidence;
  // Some sites render the first page with NO pagination param at all
  // (`/catalog` is page 1, `/catalog?page=2` is page 2) while others
  // always include the param (`?page=1` is page 1). Detected by checking
  // whether the "current" pagination link has an explicit page value.
  firstPageHasParam: Confidence;
  // Total pages observed from last-page / highest-page pagination links.
  // Useful for productCount estimation: totalPages * perPage ≈ total items.
  totalPagesObserved: Confidence;
}

interface AssemblyPhase extends PhaseStatusFields {
  overallConfidence: 'high' | 'medium' | 'low';
  // M10: skipped phases tracked separately from failed phases. Skipped =
  // didn't run because an upstream dep failed; failed = ran but produced
  // no useful output. Confidence calculation only penalizes failures.
  skippedPhases: string[];
  completedPhases: string[];
  failedPhases: string[];
  warnings: string[];
  // Derived expected product count — NULL when ingredients aren't all present.
  // Combines Phase 6 totalPagesObserved + perPage. Falls back to sitemap count
  // when no pagination was observed. Always record the `source` so the skill
  // judgment layer knows whether to trust it or run a manual pagination walk.
  expectedProductCount: Confidence;
  expectedProductCountSource: string | null; // 'pagination-walk' | 'sitemap' | 'api' | null
  // Flag set when Phase 5/6 had to test against a facet-filtered URL because
  // the bare category URL failed (WAF challenge, robots.txt disallow, etc.).
  // When true, totalPagesObserved is a FACET count, NOT the global count —
  // the skill must re-verify the global count separately before writing the
  // profile's expectedProductCount.
  testUrlWasFacetFiltered: Confidence;
  // Flag set when Phase 1 detected a JS-challenge WAF (Sucuri / CF active /
  // Incapsula / sgcaptcha) AND Phase 2+ had to fall through to Playwright to
  // obtain real HTML. Informs the skill that `needsPlaywright: true` AND
  // `wafWorkaround.method: 'cookie-cache'` belong in the profile. See Mistake 38.
  wafFallbackUsed: Confidence;
  // Number of Playwright-backed HTML fetches the probe issued. High numbers
  // (>10) on a single probe run indicate the WAF challenge is served on every
  // URL — the site needs `needsPlaywright: true` pervasively, not just for
  // the initial cookie solve.
  playwrightFetchCount: number;
}

interface ProbeReport {
  url: string;
  canonicalUrl: string;
  probedAt: string;
  phases: {
    access: AccessPhase;
    platform: PlatformPhase;
    adapter: AdapterPhase;
    catalog: CatalogPhase;
    sort: SortPhase;
    pagination: PaginationPhase;
    assembly: AssemblyPhase;
  };
  errors: ProbeError[];
  duration: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────────
// (log() is declared at the top of the file so WAF-fallback helpers can use it.)

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';

function conf(value: any, confidence: Confidence['confidence']): Confidence {
  return { value, confidence };
}

// M10: phase dependency map. Each entry lists which other phases must have
// status==='completed' before this phase is allowed to run. Assembly depends
// on ALL phases (it reads their results, but tolerates skipped/failed deps).
const PHASE_DEPENDENCIES: Record<string, string[]> = {
  access: [],
  platform: ['access'],
  adapter: ['platform'],
  catalog: ['platform'],
  sort: ['access', 'platform'],
  pagination: ['access', 'platform'],
  assembly: ['access', 'platform', 'adapter', 'catalog', 'sort', 'pagination'],
};

// Build empty/null-shaped phase results for the skipped-upstream case. Each
// helper preserves the contract of the corresponding phase function so
// downstream consumers (assembly, type-check) are unchanged.
function emptyAccessPhase(skipReason: string | null = null): AccessPhase {
  return {
    canonicalUrl: conf(null, 'none'), hasWaf: conf(null, 'none'), wafType: conf(null, 'none'),
    wafProbeEvidence: {}, userAgentResults: [],
    crawlDelay: conf(null, 'none'), robotsDisallowed: [],
    malformedHeaders: conf(null, 'none'), serverHeader: conf(null, 'none'),
    status: skipReason ? 'skipped-upstream' : 'failed',
    dependencies: PHASE_DEPENDENCIES.access,
    skipReason,
  };
}
function emptyPlatformPhase(skipReason: string | null = null): PlatformPhase {
  return {
    platform: conf(null, 'none'), platformMarkers: [], jsOverlay: conf(null, 'none'),
    renderingMode: conf(null, 'none'), availableApis: [], needsPlaywright: conf(null, 'none'),
    multilingual: conf(false, 'none'), sitemapUrls: [], sitemapProductCount: conf(null, 'none'),
    status: skipReason ? 'skipped-upstream' : 'failed',
    dependencies: PHASE_DEPENDENCIES.platform,
    skipReason,
  };
}
function emptyAdapterPhase(skipReason: string | null = null): AdapterPhase {
  return {
    suggestedAdapter: conf(null, 'none'), apiAccessible: conf(false, 'none'), extractionTestResult: null,
    status: skipReason ? 'skipped-upstream' : 'failed',
    dependencies: PHASE_DEPENDENCIES.adapter,
    skipReason,
  };
}
function emptyCatalogPhase(skipReason: string | null = null): CatalogPhase {
  return {
    categoryTree: [], navLinks: [],
    sitemapProductCount: conf(null, 'none'), apiProductCount: conf(null, 'none'),
    status: skipReason ? 'skipped-upstream' : 'failed',
    dependencies: PHASE_DEPENDENCIES.catalog,
    skipReason,
  };
}
function emptySortPhase(skipReason: string | null = null): SortPhase {
  return {
    sortOptions: [],
    sortScheme: conf(null, 'none'),
    idJumpTest: {
      defaultFirstProduct: null, newestFirstProduct: null, counterControlFirstProduct: null,
      newestParam: null, counterControlParam: null, verdict: 'not-tested',
    },
    status: skipReason ? 'skipped-upstream' : 'failed',
    dependencies: PHASE_DEPENDENCIES.sort,
    skipReason,
  };
}
function emptyPaginationPhase(skipReason: string | null = null): PaginationPhase {
  return {
    paginationPattern: conf(null, 'none'), perPage: conf(null, 'none'),
    page1Products: [], page2Products: [], zeroOverlap: conf(null, 'none'), paginationLinks: [],
    zeroIndexed: conf(null, 'none'), firstPageHasParam: conf(null, 'none'),
    totalPagesObserved: conf(null, 'none'),
    status: skipReason ? 'skipped-upstream' : 'failed',
    dependencies: PHASE_DEPENDENCIES.pagination,
    skipReason,
  };
}

// Decide a phase's status from its primary-output presence. Used to mark
// `completed` vs `failed` after the phase returns. The exact "did it produce
// useful output?" rule lives in the per-phase assembly logic; this is the
// authoritative judgement used by downstream dependency checks.
function isPhaseCompleted(phaseName: string, phase: any): boolean {
  switch (phaseName) {
    case 'access':
      // canonical URL resolved, OR we got headers from the WAF probe (origin reachable somehow)
      return (phase as AccessPhase).canonicalUrl?.confidence !== 'none' ||
             Boolean((phase as AccessPhase).wafProbeEvidence?.probeBatchesRun);
    case 'platform':
      // Platform identified OR sitemap/api count present (still useful downstream)
      return Boolean((phase as PlatformPhase).platform?.value) ||
             ((phase as PlatformPhase).availableApis || []).some(a => a.accessible) ||
             Boolean((phase as PlatformPhase).sitemapProductCount?.value);
    case 'adapter':
      // Suggested adapter known AND extraction worked (or API accessible)
      return Boolean((phase as AdapterPhase).suggestedAdapter?.value);
    case 'catalog':
      return ((phase as CatalogPhase).categoryTree?.length || 0) > 0 ||
             ((phase as CatalogPhase).navLinks?.length || 0) > 0;
    case 'sort':
      return (phase as SortPhase).idJumpTest?.verdict !== 'not-tested';
    case 'pagination':
      return Boolean((phase as PaginationPhase).paginationPattern?.value) ||
             ((phase as PaginationPhase).page1Products?.length || 0) > 0;
    default:
      return true;
  }
}

// Check whether all of a phase's deps are completed. Returns the first
// failing dep name (or null when all are satisfied).
function findFailingDependency(phaseName: string, phaseStatuses: Record<string, PhaseStatus>): string | null {
  const deps = PHASE_DEPENDENCIES[phaseName] || [];
  for (const dep of deps) {
    if (phaseStatuses[dep] !== 'completed') return dep;
  }
  return null;
}

// Finalize a phase's status from its actual output — the per-phase probe
// functions always return status:'completed' optimistically, but a phase that
// ran WITHOUT throwing can still produce unusable output (e.g. 0 products, no
// platform markers). `isPhaseCompleted` is the authoritative check. Called by
// main() after each phase returns.
function finalizePhaseStatus<T extends PhaseStatusFields>(name: string, phase: T): T {
  phase.status = isPhaseCompleted(name, phase) ? 'completed' : 'failed';
  return phase;
}

/**
 * Native-fetch fallback for servers that send malformed HTTP/1.1 headers
 * (e.g. Celerant/ColdFusion sends `X-Frame-Options : SAMEORIGIN` with trailing
 * whitespace before the colon, which trips Node's llhttp parser
 * HPE_INVALID_HEADER_TOKEN). Matches production http-client.ts:277-302.
 */
async function nativeFetchText(url: string, headers: Record<string, string>): Promise<{ status: number; headers: Record<string, any>; data: string } | null> {
  try {
    const resp = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
      // Custom undici dispatcher with raised maxHeaderSize so Drupal-style
      // cache-tags headers (16KB+) don't produce UND_ERR_HEADERS_OVERFLOW.
      // @ts-ignore — undici dispatcher is a valid fetch option at runtime.
      dispatcher: BIG_HEADER_UNDICI,
    });
    const text = await resp.text();
    return {
      status: resp.status,
      headers: Object.fromEntries(resp.headers.entries()),
      data: text,
    };
  } catch {
    return null;
  }
}

// ─── M1: Retry-once wrapper ────────────────────────────────────────────────────
// Wraps every safeFetch/safeFetchJson call with one automatic retry on
// transient failure (network error / 5xx status / empty body). Does NOT retry
// on 4xx (deliberate blocks), HPE parse errors (their own native-fetch path
// already handles them), or WAF challenge bodies (separate Playwright path).
//
// Retry signal classifications:
//   - retryable: result === null (network error/timeout w/o HPE), 5xx status,
//                or empty body on a 2xx response (CDN truncation / partial)
//   - non-retryable: 4xx (deliberate block, retry won't help), 2xx with body,
//                    'playwright' / 'native-fetch' methods (those have their
//                    own fallback semantics already; an HPE error already ran
//                    native-fetch as a recovery — re-running axios first
//                    would just hit HPE again).
//
// Retryable network error patterns. Matches Mistake 6 (durhamoutdoors.ca).
const RETRYABLE_NET_ERR_RE = /econnreset|etimedout|enotfound|socket hang up|epipe|eai_again|network|fetch failed|aborterror|abort/i;
const RETRY_DELAY_MS = 2000;

interface FetchResult {
  status: number;
  headers: Record<string, any>;
  data: any;
  method?: 'axios' | 'native-fetch' | 'playwright';
}

function classifyRetry(result: FetchResult | null, lastErrMsg: string | null, isJson: boolean): { retry: boolean; reason: string } {
  // Null result with HPE/parse error → DON'T retry (native-fetch already tried)
  if (result === null) {
    if (lastErrMsg && /parse error|hpe_invalid|invalid header/i.test(lastErrMsg)) {
      return { retry: false, reason: 'HPE-parse-error (native-fetch fallback handles this)' };
    }
    if (lastErrMsg && RETRYABLE_NET_ERR_RE.test(lastErrMsg)) {
      return { retry: true, reason: `network error: ${lastErrMsg.slice(0, 80)}` };
    }
    if (lastErrMsg) {
      return { retry: true, reason: `unknown error: ${lastErrMsg.slice(0, 80)}` };
    }
    return { retry: true, reason: 'null result (no error captured)' };
  }
  // Playwright resolves to synthetic 200 — never retry that
  if (result.method === 'playwright') return { retry: false, reason: 'playwright fallback succeeded' };
  // 5xx → retry
  if (result.status >= 500 && result.status < 600) {
    return { retry: true, reason: `${result.status} server error` };
  }
  // Empty body on a 2xx → retry (CDN truncation, partial response)
  if (result.status >= 200 && result.status < 300) {
    if (isJson) {
      // For JSON, treat null/undefined data as empty
      if (result.data === null || result.data === undefined) {
        return { retry: true, reason: `${result.status} but body is null` };
      }
    } else {
      const body = typeof result.data === 'string' ? result.data : '';
      if (body.length === 0) {
        return { retry: true, reason: `${result.status} but body is empty` };
      }
    }
  }
  // Everything else (4xx, 2xx with body) → no retry
  return { retry: false, reason: 'no retry needed' };
}

async function retryOnce<T extends FetchResult | null>(
  url: string,
  attempt: () => Promise<{ result: T; errMsg: string | null }>,
  isJson: boolean,
): Promise<T> {
  const first = await attempt();
  const { retry, reason } = classifyRetry(first.result, first.errMsg, isJson);
  if (!retry) return first.result;
  log(`[RETRY] ${url} failed (${reason}), retrying in 2s...`);
  await new Promise<void>(r => setTimeout(r, RETRY_DELAY_MS));
  const second = await attempt();
  return second.result;
}

// ─── safeFetch / safeFetchJson — single-attempt cores + retry wrappers ─────────
async function safeFetchOnce(url: string, opts: Record<string, any> = {}): Promise<{ result: { status: number; headers: Record<string, any>; data: string; method?: 'axios' | 'native-fetch' | 'playwright' } | null; errMsg: string | null }> {
  const defaultHeaders = {
    'User-Agent': DESKTOP_UA,
    Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
    'Accept-Language': 'en-CA,en;q=0.9',
  };
  const mergedHeaders = { ...defaultHeaders, ...(opts.headers || {}) };
  // allowPlaywright: caller opts out when they need to see the raw challenge
  // body (e.g. the initial Phase 1 probe before WAF state is known). Default
  // is to auto-fall-back when Phase 1 set g_wafFallbackRequired.
  const allowPlaywright = opts.allowPlaywright !== false;
  try {
    const resp = await axios.get(url, {
      timeout: 20000,
      maxRedirects: 10,
      validateStatus: () => true,
      responseType: 'text',
      httpAgent: BIG_HEADER_HTTP_AGENT,
      httpsAgent: BIG_HEADER_HTTPS_AGENT,
      ...opts,
      headers: mergedHeaders,
    });
    const body = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
    // If Phase 1 flagged a JS-challenge WAF AND the response body looks like
    // a challenge page, fall through to Playwright. This is what makes the
    // probe usable on Sucuri/Cloudflare-active/Incapsula/sgcaptcha sites
    // where axios receives a 307/403 redirect-to-challenge HTML instead of
    // the real page. See playbook Mistake 38.
    if (allowPlaywright && g_wafFallbackRequired && isWafChallengeBody(body, resp.status, true)) {
      g_wafFallbackObserved = true;
      const pw = await playwrightFetch(url);
      if (pw) return { result: pw, errMsg: null };
    }
    return {
      result: {
        status: resp.status,
        headers: resp.headers,
        data: body,
        method: 'axios',
      },
      errMsg: null,
    };
  } catch (e: any) {
    const msg = e?.message || '';
    // HPE_INVALID_HEADER_TOKEN / Parse Error — server sent malformed headers
    // (Celerant ColdFusion, some legacy IIS configs). Fall back to undici's
    // native fetch which is more lenient.
    const lowered = msg.toLowerCase();
    if (lowered.includes('parse error') || lowered.includes('hpe_invalid') || lowered.includes('invalid header')) {
      const r = await nativeFetchText(url, mergedHeaders);
      if (r) {
        // Even native-fetch can get a challenge body if the server is behind
        // Sucuri+ColdFusion (rare but real — the Sucuri edge still serves
        // challenge HTML regardless of origin-header quirks).
        if (allowPlaywright && g_wafFallbackRequired && isWafChallengeBody(r.data, r.status, true)) {
          g_wafFallbackObserved = true;
          const pw = await playwrightFetch(url);
          if (pw) return { result: pw, errMsg: null };
        }
        return { result: { ...r, method: 'native-fetch' }, errMsg: null };
      }
      // native-fetch also failed — preserve HPE message so retry skips
      return { result: null, errMsg: msg || 'HPE parse error and native-fetch failed' };
    }
    // Timeout / connection reset with WAF confirmed → try Playwright
    if (allowPlaywright && g_wafFallbackRequired) {
      const pw = await playwrightFetch(url);
      if (pw) return { result: pw, errMsg: null };
    }
    return { result: null, errMsg: msg };
  }
}

async function safeFetch(url: string, opts: Record<string, any> = {}): Promise<{ status: number; headers: Record<string, any>; data: string; method?: 'axios' | 'native-fetch' | 'playwright' } | null> {
  return retryOnce(url, () => safeFetchOnce(url, opts), false);
}

async function safeFetchJsonOnce(url: string, opts: Record<string, any> = {}): Promise<{ result: { status: number; headers: Record<string, any>; data: any; method?: 'axios' | 'native-fetch' } | null; errMsg: string | null }> {
  const defaultHeaders = {
    'User-Agent': DESKTOP_UA,
    Accept: 'application/json,*/*;q=0.8',
  };
  const mergedHeaders = { ...defaultHeaders, ...(opts.headers || {}) };
  try {
    const resp = await axios.get(url, {
      timeout: 20000,
      maxRedirects: 10,
      validateStatus: () => true,
      httpAgent: BIG_HEADER_HTTP_AGENT,
      httpsAgent: BIG_HEADER_HTTPS_AGENT,
      ...opts,
      headers: mergedHeaders,
    });
    return { result: { status: resp.status, headers: resp.headers, data: resp.data, method: 'axios' }, errMsg: null };
  } catch (e: any) {
    const msg = e?.message || '';
    const lowered = msg.toLowerCase();
    if (lowered.includes('parse error') || lowered.includes('hpe_invalid') || lowered.includes('invalid header')) {
      const r = await nativeFetchText(url, mergedHeaders);
      if (r) {
        try { return { result: { ...r, data: JSON.parse(r.data), method: 'native-fetch' }, errMsg: null }; }
        catch { return { result: { ...r, data: null, method: 'native-fetch' }, errMsg: null }; }
      }
      return { result: null, errMsg: msg || 'HPE parse error and native-fetch failed' };
    }
    return { result: null, errMsg: msg };
  }
}

async function safeFetchJson(url: string, opts: Record<string, any> = {}): Promise<{ status: number; headers: Record<string, any>; data: any; method?: 'axios' | 'native-fetch' } | null> {
  return retryOnce(url, () => safeFetchJsonOnce(url, opts), true);
}

function extractFirstProducts($: cheerio.CheerioAPI, baseUrl: string, limit = 5): string[] {
  const products: string[] = [];
  const seen = new Set<string>();

  // Selector priority order — same as GenericRetailAdapter.extractCatalogProducts
  // PLUS Drupal-based listing selectors (node--type-classified / data-history-node-id)
  // so classifieds-style Drupal sites (gunpost.ca, other Drupal Views listings) are
  // extractable even though they don't use the word "product" anywhere.
  const SELECTORS = [
    '[data-product-id]', 'li.product', 'li[class*="product"]',
    '[class*="product-card"]', '[class*="product-item"]', '[class*="product-tile"]',
    '[data-product]', 'article[class*="product"]', '.card',
    '.products-list .item', '.products-grid .item', 'li.product-item',
    '.product-items > .product-item', '.productborder',
    '.product-grid[class*="col-"]', '.product-element',
    '.product-thumb', '.product-layout', 'div.product', 'a.product',
    '[class*="klevuProduct"]', '.kuResultsListing li',
    '[class*="hikashop_product"]', '.category_products .product',
    '[class*="product-index"]', '.listing-item', '[class*="ols-product"]',
    '.store_product_list_wrapper', '.grid-product',
    '[data-aid="PRODUCT_LIST_RENDERED"] [data-ux="GridCell"]',
    // Drupal listings — classifieds, auction, commerce. Matches gunpost.ca's
    // `<article data-history-node-id="N" class="node--type-classified gunpost-teaser">`.
    'article[data-history-node-id]',
    '[class*="node--type-classified"]',
    '[class*="node--type-product"]',
    '[class*="node--view-mode-teaser"]',
  ];

  for (const selector of SELECTORS) {
    $(selector).each((_, el) => {
      if (products.length >= limit) return;
      const element = $(el);
      // Skip sidebar/related
      if (element.closest('.sidebar, aside, .block-related, .block-viewed-products, .block-upsell').length > 0) return;

      // Extract product URL
      let href = element.find('a[href]').first().attr('href') || element.attr('href') || '';
      if (!href) return;
      try {
        href = href.startsWith('http') ? href : new URL(href, baseUrl).toString();
      } catch { return; }
      if (seen.has(href)) return;
      seen.add(href);
      products.push(href);
    });
    if (products.length >= limit) break;
  }
  return products;
}

function extractProductTitles($: cheerio.CheerioAPI, limit = 3): string[] {
  const titles: string[] = [];
  // Extend selectors to match Celerant-style `a.product` + `article[class*=product]`
  // and also accept <span class="name"> which is the Celerant title container.
  // Also handle Drupal classifieds articles where title is inside `.field--name-title`
  // or a wrapping <h2>/<h3> anchor.
  const SELECTORS = [
    '[data-product-id]', 'li.product', '[class*="product-card"]',
    '[class*="product-item"]', '.card', '.products-list .item',
    '.product-thumb', 'div.product',
    'a.product', 'article[class*="product"]',
    'article[data-history-node-id]',
    '[class*="node--type-classified"]',
    '[class*="node--type-product"]',
  ];
  for (const sel of SELECTORS) {
    $(sel).each((_, el) => {
      if (titles.length >= limit) return;
      const element = $(el);
      if (element.closest('.sidebar, aside').length > 0) return;
      const title = element.find('h2, h3, h4, .product-title, .card-title, [class*="product-name"], [class*="ProductName"], span.name, .name').first().text().trim()
        || element.find('a').first().text().trim()
        || element.text().trim();
      if (title && title.length > 3 && title.length < 200 && !/^\$?\d[\d,.]*$/.test(title)) {
        titles.push(title.replace(/\s+/g, ' ').slice(0, 120));
      }
    });
    if (titles.length >= limit) break;
  }
  return titles;
}

// ── Phase 1: Access & Security ─────────────────────────────────────────────────

async function probeAccess(inputUrl: string): Promise<{ result: AccessPhase; canonical: string }> {
  log('[Phase 1] Access & Security...');

  // Follow redirects to find canonical host
  let canonicalUrl = inputUrl;
  let canonicalConf: Confidence['confidence'] = 'low';
  try {
    const resp = await axios.head(inputUrl, {
      timeout: 15000, maxRedirects: 10, validateStatus: () => true,
      headers: { 'User-Agent': DESKTOP_UA },
      httpAgent: BIG_HEADER_HTTP_AGENT, httpsAgent: BIG_HEADER_HTTPS_AGENT,
    });
    if (resp.request?.res?.responseUrl) {
      canonicalUrl = resp.request.res.responseUrl;
      canonicalConf = 'high';
    }
  } catch {
    // Try GET fallback
    const r = await safeFetch(inputUrl);
    if (r) canonicalConf = 'medium';
  }
  // Normalize: strip trailing slash for consistency
  canonicalUrl = canonicalUrl.replace(/\/$/, '');
  const origin = new URL(canonicalUrl).origin;

  // Run heavy WAF probe
  let wafEvidence: Record<string, any> = {};
  let hasWaf = false;
  let wafType: string | null = null;
  try {
    const probeScript = path.resolve(__dirname, 'heavy-waf-probe.sh');
    log('  Running heavy-waf-probe.sh...');
    const probeOutput = execSync(`bash "${probeScript}" "${origin}"`, {
      timeout: 120000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Parse WAF indicators ONLY from actual header lines (BATCH 1).
    // Naive substring match against the whole probe output matches the
    // INTERPRETATION GUIDE trailer ("no cf-ray/x-sucuri" etc.) and the
    // "WAF INDICATORS IN HEADERS" legend, producing false positives.
    const headerBatchMatch = probeOutput.match(/=== BATCH 1:[^=]*===([\s\S]*?)(?=\n=== BATCH)/);
    const headerLines = (headerBatchMatch ? headerBatchMatch[1] : '').split('\n');
    // Each header line from BATCH 1 starts with a lowercase header name followed by ':'
    // e.g. "server: Null", "cf-ray: 123", "x-sucuri-id: abc"
    const headerOnly = headerLines.filter(l => /^[a-z][a-z0-9-]+:/i.test(l.trim())).join('\n');

    const hasCfRay = /^cf-ray:/im.test(headerOnly);
    const hasSucuri = /^x-sucuri-(id|cache|block):/im.test(headerOnly);
    const hasIncapsulaHeader = /^(x-iinfo|x-cdn:\s*incapsula):/im.test(headerOnly);
    const hasSgCaptcha = /^sg-captcha:/im.test(headerOnly);
    const hasCloudflareServer = /^server:\s*cloudflare/im.test(headerOnly);
    // Cookie-based WAF markers (check set-cookie lines specifically)
    const hasIncapsulaCookie = /^set-cookie:\s*(visid_incap|incap_ses|nlbi_)/im.test(headerOnly);

    // Status-code signals from all batches (these are safe — STATUS= is probe-specific prefix)
    const has403 = /\bSTATUS=403\b/.test(probeOutput);
    const has429 = /\bSTATUS=429\b/.test(probeOutput);
    const has503 = /\bSTATUS=503\b/.test(probeOutput);

    if (hasCfRay || hasCloudflareServer) {
      hasWaf = true;
      wafType = has403 || has503 ? 'cloudflare-active' : 'cloudflare-passive';
    } else if (hasSucuri) {
      hasWaf = true;
      wafType = 'sucuri';
    } else if (hasIncapsulaHeader || hasIncapsulaCookie) {
      hasWaf = true;
      wafType = 'incapsula';
    } else if (hasSgCaptcha) {
      hasWaf = true;
      wafType = 'siteground-sgcaptcha';
    } else if (has403 || has429 || has503) {
      hasWaf = true;
      wafType = has429 ? 'rate-limit' : 'unknown';
    }

    wafEvidence.cfRay = hasCfRay;
    wafEvidence.sucuri = hasSucuri;
    wafEvidence.incapsulaHeader = hasIncapsulaHeader;
    wafEvidence.incapsulaCookie = hasIncapsulaCookie;
    wafEvidence.sgCaptcha = hasSgCaptcha;
    wafEvidence.cloudflareServer = hasCloudflareServer;
    wafEvidence.saw403 = has403;
    wafEvidence.saw429 = has429;
    wafEvidence.saw503 = has503;
    // Capture the actual server header(s) seen — useful for platform detection
    const serverMatch = headerOnly.match(/^server:\s*(.+)$/im);
    wafEvidence.serverHeader = serverMatch ? serverMatch[1].trim() : null;
    // Capture set-cookie signatures (CFID/CFTOKEN = ColdFusion, ASP.NET_SessionId = IIS)
    wafEvidence.setCookieMarkers = {
      cfid: /^set-cookie:\s*CFID=/im.test(headerOnly),
      cftoken: /^set-cookie:\s*CFTOKEN=/im.test(headerOnly),
      aspNetSession: /^set-cookie:\s*ASP\.NET_SessionId=/im.test(headerOnly),
      jSessionId: /^set-cookie:\s*JSESSIONID=/im.test(headerOnly),
      phpSession: /^set-cookie:\s*PHPSESSID=/im.test(headerOnly),
    };
    wafEvidence.probeBatchesRun = (probeOutput.match(/=== BATCH/g) || []).length;
  } catch (e: any) {
    wafEvidence.error = e.message?.slice(0, 500);
    log('  WAF probe failed:', e.message?.slice(0, 200));
  }

  // Arm the Playwright fallback for Phase 2+ when Phase 1 confirmed a
  // JS-challenge WAF. Sucuri / Cloudflare active / Incapsula / SiteGround
  // sgcaptcha all serve a tiny HTML shell with JS that sets a cookie then
  // reloads — axios sees the shell, not the real page. Passive Cloudflare
  // (no challenge, cf-ray only) does NOT need fallback. rate-limit/unknown
  // are treated as fallback-eligible as a safety net — if it's not really
  // a challenge, the body size heuristic inside isWafChallengeBody() will
  // let the axios response through unchanged.
  const JS_CHALLENGE_TYPES = new Set(['sucuri', 'cloudflare-active', 'incapsula', 'siteground-sgcaptcha', 'rate-limit', 'unknown']);
  if (wafType && JS_CHALLENGE_TYPES.has(wafType)) {
    g_wafFallbackRequired = true;
    log(`  [waf] Playwright fallback ARMED for wafType=${wafType} — Phase 2+ HTML fetches will auto-escalate on challenge body.`);
  }

  // Test multiple UAs — with native-fetch fallback for malformed-header sites.
  // We track whether axios saw HPE errors so the platform phase can flag
  // Celerant/ColdFusion / legacy-IIS malformed-response-header quirks.
  const uaTests = [
    { label: 'desktop-chrome', ua: DESKTOP_UA },
    { label: 'iphone-safari', ua: IPHONE_UA },
    { label: 'python-bot', ua: 'python-requests/2.31.0' },
    { label: 'curl', ua: 'curl/8.1.2' },
    { label: 'no-ua', ua: '' },
  ];
  const uaResults: AccessPhase['userAgentResults'] = [];
  let anyHpeError = false;
  for (const t of uaTests) {
    const headers: Record<string, string> = { Accept: 'text/html' };
    if (t.ua) headers['User-Agent'] = t.ua;
    try {
      const r = await axios.get(origin, {
        timeout: 15000, maxRedirects: 10, validateStatus: () => true, headers,
        httpAgent: BIG_HEADER_HTTP_AGENT, httpsAgent: BIG_HEADER_HTTPS_AGENT,
      });
      uaResults.push({ ua: t.ua, label: t.label, status: r.status, method: 'axios' });
    } catch (e: any) {
      const msg = e?.message || '';
      const isHpe = /parse error|hpe_invalid|invalid header/i.test(msg);
      if (isHpe) anyHpeError = true;
      if (isHpe) {
        const r = await nativeFetchText(origin, headers);
        if (r) uaResults.push({ ua: t.ua, label: t.label, status: r.status, method: 'native-fetch', error: 'HPE_INVALID_HEADER_TOKEN (axios fallback ok)' });
        else uaResults.push({ ua: t.ua, label: t.label, status: null, error: `${msg.slice(0, 200)} (native-fetch also failed)`, method: 'native-fetch' });
      } else {
        uaResults.push({ ua: t.ua, label: t.label, status: null, error: msg.slice(0, 200) });
      }
    }
  }

  // robots.txt
  let crawlDelay: number | null = null;
  const robotsDisallowed: string[] = [];
  const robotsResp = await safeFetch(`${origin}/robots.txt`);
  if (robotsResp && robotsResp.status === 200 && robotsResp.data.includes('User-agent')) {
    const lines = robotsResp.data.split('\n');
    for (const line of lines) {
      const cdMatch = line.match(/^Crawl-delay:\s*(\d+)/i);
      if (cdMatch) crawlDelay = parseInt(cdMatch[1]);
      const disMatch = line.match(/^Disallow:\s*(.+)/i);
      if (disMatch) robotsDisallowed.push(disMatch[1].trim());
    }
  }

  return {
    canonical: origin,
    result: {
      canonicalUrl: conf(canonicalUrl, canonicalConf),
      hasWaf: conf(hasWaf, hasWaf ? 'high' : 'medium'),
      wafType: conf(wafType, wafType ? 'high' : 'none'),
      wafProbeEvidence: wafEvidence,
      userAgentResults: uaResults,
      crawlDelay: conf(crawlDelay, crawlDelay !== null ? 'high' : 'none'),
      robotsDisallowed,
      malformedHeaders: conf(anyHpeError, anyHpeError ? 'high' : 'low'),
      serverHeader: conf(wafEvidence.serverHeader, wafEvidence.serverHeader ? 'high' : 'none'),
      // M10 — populated by main() based on isPhaseCompleted; placeholder here
      status: 'completed' as PhaseStatus,
      dependencies: PHASE_DEPENDENCIES.access,
      skipReason: null,
    },
  };
}

// ── Phase 2: Platform & Rendering ──────────────────────────────────────────────

async function probePlatform(origin: string, accessPhase?: AccessPhase): Promise<PlatformPhase> {
  log('[Phase 2] Platform & Rendering...');

  const resp = await safeFetch(origin);
  if (!resp) {
    return {
      platform: conf(null, 'none'), platformMarkers: [], jsOverlay: conf(null, 'none'),
      renderingMode: conf(null, 'none'), availableApis: [], needsPlaywright: conf(null, 'none'),
      multilingual: conf(false, 'none'), sitemapUrls: [], sitemapProductCount: conf(null, 'none'),
      status: 'failed' as PhaseStatus,
      dependencies: PHASE_DEPENDENCIES.platform,
      skipReason: null,
    };
  }

  const html = resp.data;
  const headers = resp.headers;
  const markers: string[] = [];
  let platform: string | null = null;
  let platformConf: Confidence['confidence'] = 'low';

  // Phase 1 signals (may be undefined if accessPhase not passed)
  const wafEvidence = accessPhase?.wafProbeEvidence || {};
  const sawCfCookies = !!wafEvidence.setCookieMarkers?.cfid || !!wafEvidence.setCookieMarkers?.cftoken;
  const sawAspNetSession = !!wafEvidence.setCookieMarkers?.aspNetSession;
  const sawMalformedHeaders = accessPhase?.malformedHeaders?.value === true;
  const accessServerHeader = accessPhase?.serverHeader?.value as string | null;

  // Platform detection — ordered by specificity.
  // Signature set also consults Phase 1 signals (set-cookie, server header,
  // malformed-header presence) so vendors like Celerant/ColdFusion that
  // otherwise look like plain HTML are correctly identified.
  const checks: [string, RegExp | ((h: string, hd: Record<string, any>) => boolean)][] = [
    ['woocommerce', (h) => /wp-content\/plugins\/woocommerce|wc-ajax|class="woocommerce/i.test(h)],
    ['shopify', (h) => /cdn\.shopify\.com|window\.Shopify|\/cdn\/shop\//i.test(h)],
    ['bigcommerce-stencil', (h) => /Stencil\.storefrontAPIToken|cdn11\.bigcommerce\.com/i.test(h) && /BCData/i.test(h)],
    ['bigcommerce-blueprint', (h) => /BCData/i.test(h) && !/Stencil/i.test(h)],
    ['magento2', (h) => /static\/version\d|requirejs-config|Magento_/i.test(h)],
    ['magento1', (h) => /\/js\/varien\/|catalog\/product\/view\/id\//i.test(h)],
    ['opencart', (h) => /catalog\/view\/theme|route=product\/category/i.test(h)],
    ['lightspeed', (h) => /cdn\.shoplightspeed\.com|shoplightspeed/i.test(h)],
    ['ecwid-on-wordpress', (h) => /app\.ecwid\.com\/script\.js/i.test(h)],
    ['odoo', (h) => /content="Odoo"|oe_website_sale|oe_currency_value/i.test(h)],
    ['volusion', (_h, hd) => /Volusion/i.test(hd['x-powered-by'] || '')],
    ['wix-stores', (h) => /wixBiSession|thunderbolt/i.test(h)],
    ['godaddy-ols', (h) => /mysimplestore|data-aid="PRODUCT_LIST_RENDERED"/i.test(h)],
    // ColdFusion signatures (Mistake: Celerant/ColdFusion sites silently HPE
    // axios due to trailing-space headers like `X-Frame-Options : SAMEORIGIN`).
    // Celerant is the dominant ColdFusion eCommerce vendor in the Canadian
    // firearms fleet — their storefront JS is served from celerantwebservices.com.
    ['celerant-coldfusion', (h) =>
      /celerantwebservices\.com/i.test(h) ||
      (sawCfCookies && /all-products\/browse|\/orderby\/|\/perpage\//i.test(h)) ||
      (sawCfCookies && sawMalformedHeaders && /\.cfm\b/i.test(h))],
    ['coldfusion', (h) =>
      /\.cfm\b/i.test(h) || sawCfCookies ||
      /(?:jakarta|kotlin|webcharts|cfclient|cfform|cfinput|cfmodule)/i.test(h)],
    // ASP.NET / IIS signatures
    ['aspnet', (h, hd) =>
      /__VIEWSTATE|__EVENTVALIDATION|\.aspx\b/i.test(h) ||
      /asp\.net/i.test(hd['x-powered-by'] || '') ||
      sawAspNetSession],
    // Drupal signatures — header-first (most authoritative), then HTML markers.
    // More specific (Drupal Commerce) checked BEFORE plain Drupal so
    // first-match-wins lands on the more informative tag.
    // `x-generator: Drupal 10` + `x-commerce-core: 2` → Drupal Commerce.
    // Plain Drupal without Commerce is still Drupal (classifieds, news, etc.).
    ['drupal-commerce', (_h, hd) =>
      hd['x-commerce-core'] !== undefined &&
      (/^Drupal\b/i.test(hd['x-generator'] || '') || hd['x-drupal-cache-tags'] !== undefined)],
    ['drupal', (h, hd) =>
      /^Drupal\b/i.test(hd['x-generator'] || '') ||
      /data-drupal-selector|drupalSettings|data-history-node-id|\/sites\/default\/files\//i.test(h) ||
      hd['x-drupal-cache'] !== undefined ||
      hd['x-drupal-dynamic-cache'] !== undefined ||
      hd['x-drupal-cache-tags'] !== undefined],
    ['wordpress', (h) => /wp-content/i.test(h)],
  ];

  for (const [name, check] of checks) {
    const matched = typeof check === 'function' ? check(html, headers) : check.test(html);
    if (matched) {
      markers.push(name);
      if (!platform) {
        platform = name;
        platformConf = 'high';
      }
    }
  }

  // Volusion from response headers specifically
  if (/Volusion/i.test(headers['x-powered-by'] || '')) {
    if (!markers.includes('volusion')) markers.push('volusion');
    if (!platform) { platform = 'volusion'; platformConf = 'high'; }
  }
  // Wix from server header
  if (/Pepyaka/i.test(headers['server'] || '')) {
    if (!markers.includes('wix-stores')) markers.push('wix-stores');
    if (!platform) { platform = 'wix-stores'; platformConf = 'high'; }
  }

  // Generator meta tag
  const $ = cheerio.load(html);
  const generator = $('meta[name="generator"]').attr('content') || '';
  if (generator) markers.push(`generator:${generator}`);

  // Platform-diagnostic markers from Phase 1 signals
  if (sawCfCookies) markers.push('cookie:CFID-CFTOKEN');
  if (sawAspNetSession) markers.push('cookie:ASP.NET_SessionId');
  if (sawMalformedHeaders) markers.push('malformed-headers:HPE_INVALID_HEADER_TOKEN');
  if (accessServerHeader && /^null$/i.test(accessServerHeader.trim())) markers.push('server:Null');
  if (accessServerHeader && /adobe|coldfusion|lucee|openbd/i.test(accessServerHeader)) {
    markers.push(`server:${accessServerHeader}`);
  }

  // Response-header markers — useful for downstream judgment even when the
  // platform regex didn't promote them. These headers are the authoritative
  // signal for Drupal / Drupal Commerce / WP and cannot be forged by theme
  // customization the way HTML can.
  const xGen = headers['x-generator'];
  if (xGen) markers.push(`x-generator:${String(xGen).slice(0, 80)}`);
  const xCommerce = headers['x-commerce-core'];
  if (xCommerce) markers.push(`x-commerce-core:${xCommerce}`);
  if (headers['x-drupal-cache'] || headers['x-drupal-dynamic-cache']) markers.push('header:x-drupal-cache');
  if (headers['x-drupal-cache-tags']) markers.push('header:x-drupal-cache-tags');

  // JS overlay detection
  let jsOverlay: string | null = null;
  if (/cdn\.searchspring\.net/i.test(html)) jsOverlay = 'searchspring';
  else if (/klevu-/i.test(html)) jsOverlay = 'klevu';
  else if (/algolia/i.test(html)) jsOverlay = 'algolia';
  else if (/fastsimonsearch|fast-simon/i.test(html)) jsOverlay = 'fastsimmon';
  else if (/constructor\.io/i.test(html)) jsOverlay = 'constructor-io';

  // Rendering mode — check if products are in initial HTML
  const testProducts = extractFirstProducts($, origin, 3);
  const productTitles = extractProductTitles($, 3);
  let renderingMode: string;
  if (testProducts.length > 0 || productTitles.length > 0) {
    renderingMode = 'static-html';
  } else if (html.length > 5000) {
    renderingMode = 'spa-likely';
  } else {
    renderingMode = 'unknown';
  }

  // API probes
  const apis: PlatformPhase['availableApis'] = [];

  // WP REST API
  const wpRest = await safeFetchJson(`${origin}/wp-json/wp/v2/product?per_page=1`);
  if (wpRest && wpRest.status === 200 && Array.isArray(wpRest.data)) {
    const total = parseInt(wpRest.headers['x-wp-total'] || '0');
    apis.push({ name: 'wp-rest', accessible: true, productCount: total, evidence: `x-wp-total: ${total}` });
  } else {
    apis.push({ name: 'wp-rest', accessible: false, evidence: wpRest ? `status ${wpRest.status}` : 'timeout/error' });
  }

  // WC Store API
  const storeApi = await safeFetchJson(`${origin}/wp-json/wc/store/v1/products?per_page=1`);
  if (storeApi && storeApi.status === 200 && Array.isArray(storeApi.data)) {
    const total = parseInt(storeApi.headers['x-wp-total'] || '0');
    apis.push({ name: 'wc-store-api', accessible: true, productCount: total, evidence: `x-wp-total: ${total}` });
  } else {
    apis.push({ name: 'wc-store-api', accessible: false, evidence: storeApi ? `status ${storeApi.status}` : 'timeout/error' });
  }

  // Shopify
  const shopifyApi = await safeFetchJson(`${origin}/products.json?limit=1`);
  if (shopifyApi && shopifyApi.status === 200 && shopifyApi.data?.products) {
    apis.push({ name: 'shopify-json', accessible: true, evidence: `products array present` });
  } else {
    apis.push({ name: 'shopify-json', accessible: false, evidence: shopifyApi ? `status ${shopifyApi.status}` : 'timeout/error' });
  }

  // Ecwid store ID extraction
  if (platform === 'ecwid-on-wordpress') {
    const ecwidMatch = html.match(/app\.ecwid\.com\/script\.js\?(\d+)/);
    if (ecwidMatch) {
      const storeId = ecwidMatch[1];
      try {
        const ecwidResp = await axios.post(
          `https://us-vir2-storefront-api.ecwid.com/storefront/api/v1/${storeId}/catalog/search`,
          { lang: 'en', pagination: { offset: 0, limit: 1 } },
          {
            timeout: 15000,
            headers: { 'Content-Type': 'application/json', Origin: origin, Referer: `${origin}/` },
            httpAgent: BIG_HEADER_HTTP_AGENT, httpsAgent: BIG_HEADER_HTTPS_AGENT,
          },
        );
        if (ecwidResp.data?.totalProductsCount !== undefined) {
          apis.push({
            name: 'ecwid-storefront',
            accessible: true,
            productCount: ecwidResp.data.totalProductsCount,
            evidence: `storeId=${storeId}, totalProductsCount=${ecwidResp.data.totalProductsCount}`,
          });
        }
      } catch {
        apis.push({ name: 'ecwid-storefront', accessible: false, evidence: `storeId=${storeId}, request failed` });
      }
    }
  }

  // Sitemaps — try canonical, index, product-specific, and several vendor-specific forms.
  // Platform-specific paths are checked first; fall back to generic.
  const sitemapCandidates = [
    '/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml',
    '/product-sitemap.xml', '/sitemap_products.xml', '/products-sitemap.xml',
    '/store-products-sitemap.xml', // Wix
    '/sitemap/products.xml',
    '/sitemap_products_1.xml',     // Shopify
  ];
  const sitemapUrls: string[] = [];
  let sitemapProductCount: number | null = null;
  let sitemapIndexFollowed = 0;
  // Tracks which sitemap URLs (absolute) have already been counted — prevents
  // double-counting when `/sitemap_index.xml` lists `/product-sitemap.xml`
  // AND the candidate list ALSO probes `/product-sitemap.xml` directly.
  const countedSitemaps = new Set<string>();

  // Heuristics for classifying a <loc> as a product vs category
  function classifyLocs(locs: string[]): { product: number; likelyProduct: string[] } {
    // Product URL positive patterns — broaden to common vendor schemes.
    // Celerant uses /shop/<slug>-<id>; Shopify /products/<handle>; BC /<slug>/;
    // Magento uses .html suffix on product pages; OpenCart uses product_id=N in queries.
    const productPatterns = [
      /\/products?\/[^\/]+\/?$/i,          // /products/foo or /product/foo
      /\/shop\/[^\/]+(?:\-\d{2,})?\/?$/i,   // /shop/foo-123 (Celerant) or /shop/foo
      /\/product-page\/[^\/]+\/?$/i,       // Wix
      /\/item\/[^\/]+\/?$/i,               // eBay-style
      /\/p\/[^\/]+\/?$/i,                  // shortened
      /[-_]p\d{3,}\.html/i,                 // legacy .html with id suffix
      /\/[^\/]+-\d{4,}\/?$/i,              // /<slug>-NNNN (Celerant without /shop prefix)
      /\/productdetails\.asp/i,            // Volusion
      /\/catalog\/product\/view\/id\/\d+/i, // Magento
      /route=product\/product/i,            // OpenCart
      // Drupal classifieds 3-segment nested path — /<cat>/<subcat>/<location>/<slug>
      // e.g. gunpost.ca /firearms/rifles/edmonton/mauser-sporter-243-win-24
      // Match 4 or more slash-separated path segments after the domain, each
      // non-empty. This is intentionally loose; categoryPatterns filter out
      // obvious nav paths upstream.
      /\/[a-z][a-z0-9-]+\/[a-z][a-z0-9-]+\/[a-z][a-z0-9-]+\/[a-z][a-z0-9-]{3,}\/?$/i,
    ];
    // Obvious category / navigation negative patterns
    const categoryPatterns = [
      /\/product-category\//i,
      /\/collections?\//i,
      /\/category\//i,
      /\/brand\//i,
      /\/tag\//i,
      /\/page\/\d+/i,
      /\/browse\/?$/i,
      /\/(cart|checkout|account|login|contact|about|faq|blog|news|privacy|terms|search)\b/i,
    ];
    const likelyProduct: string[] = [];
    let product = 0;
    for (const raw of locs) {
      const loc = raw.replace(/^<loc>/, '').replace(/<\/loc>$/, '').trim();
      if (categoryPatterns.some(p => p.test(loc))) continue;
      if (productPatterns.some(p => p.test(loc))) {
        product++;
        if (likelyProduct.length < 5) likelyProduct.push(loc);
      }
    }
    return { product, likelyProduct };
  }

  for (const smPath of sitemapCandidates) {
    const smAbs = `${origin}${smPath}`;
    if (countedSitemaps.has(smAbs)) continue;
    const smResp = await safeFetch(smAbs);
    if (smResp && smResp.status === 200 && smResp.data.includes('<')) {
      sitemapUrls.push(smPath);
      countedSitemaps.add(smAbs);
      const rawLocs = smResp.data.match(/<loc>[^<]+<\/loc>/g) || [];
      // Detect sitemap index — count <sitemap> entries (not <url>)
      const isIndex = /<sitemap>/.test(smResp.data) && !/<url>/.test(smResp.data.slice(0, 2000));
      if (isIndex) {
        // Follow sub-sitemaps. WooCommerce Yoast/RankMath sites typically
        // split their product catalog into /product-sitemap.xml,
        // /product-sitemap2.xml, ... /product-sitemapN.xml (one per 5000
        // products by default). 16k-product sites (gotenda.com) have 17
        // sub-sitemaps — capping at 5 undercounts by ~70%.
        //
        // Strategy: identify PRODUCT sub-sitemaps via URL pattern AND follow
        // all of them (up to 40, which covers 200k-product sites). Other
        // child sitemaps (category, post, author, user) are followed with a
        // smaller cap since they rarely add product counts but could on
        // sites with non-standard sitemap naming (gunpost.ca simple_sitemap).
        const PRODUCT_SM_RE = /product[-_]?sitemap(?:\d+|\.xml|_\d+|-\d+)?|sitemap_products?|products?-sitemap|store[-_]?products[-_]?sitemap|sitemap_products_\d+/i;
        const productSubSitemaps: string[] = [];
        const otherSubSitemaps: string[] = [];
        for (const l of rawLocs) {
          if (PRODUCT_SM_RE.test(l)) productSubSitemaps.push(l);
          else otherSubSitemaps.push(l);
        }
        const MAX_PRODUCT_FOLLOWS = 40;
        const MAX_OTHER_FOLLOWS = 5;
        const planned: string[] = [
          ...productSubSitemaps.slice(0, MAX_PRODUCT_FOLLOWS),
          ...otherSubSitemaps.slice(0, MAX_OTHER_FOLLOWS),
        ];
        for (const child of planned) {
          const subUrl = child.replace(/^<loc>/, '').replace(/<\/loc>$/, '').trim();
          if (countedSitemaps.has(subUrl)) continue;
          sitemapIndexFollowed++;
          countedSitemaps.add(subUrl);
          const sub = await safeFetch(subUrl);
          if (sub && sub.status === 200) {
            const subLocs = sub.data.match(/<loc>[^<]+<\/loc>/g) || [];
            const { product } = classifyLocs(subLocs);
            if (product > 0) sitemapProductCount = (sitemapProductCount || 0) + product;
          }
        }
        continue;
      }
      // Non-index sitemap: classify every <loc> regardless of path keyword.
      // Previously we only counted if the path/contents had "product" — that
      // missed legitimate product sitemaps like Celerant /sitemap.xml which
      // doesn't use the "product" word anywhere.
      const { product } = classifyLocs(rawLocs);
      if (product > 0) sitemapProductCount = (sitemapProductCount || 0) + product;
    }
  }

  // Multilingual detection
  const hasHreflang = $('link[hreflang]').length > 0;
  const hasWpml = /wpml/i.test(html);
  const hasLangPrefix = /\/(en|fr|es|de)\//i.test(html);
  const multilingual = hasHreflang || hasWpml || hasLangPrefix;

  // needsPlaywright=true when:
  //   (a) SPA detected (static HTML returns 0 products but site renders in browser), OR
  //   (b) JS overlay detected (Searchspring, Klevu, FastSimon) — sort/filter
  //       are JS-only, need Playwright to drive, OR
  //   (c) WAF fallback was ARMED in Phase 1 — production adapter will need
  //       waf-cookie-manager + periodic Playwright solve. This is the authoritative
  //       signal for WooCommerce/Shopify sites behind Sucuri/CF-active/Incapsula.
  const needsPlaywright = renderingMode === 'spa-likely' || jsOverlay !== null || g_wafFallbackRequired;
  const needsPlaywrightConf: Confidence['confidence'] =
    g_wafFallbackRequired ? 'high' :        // WAF confirmed via heavy probe
    (renderingMode === 'spa-likely' || jsOverlay !== null) ? 'medium' :
    'low';

  return {
    platform: conf(platform, platformConf),
    platformMarkers: markers,
    jsOverlay: conf(jsOverlay, jsOverlay ? 'high' : 'none'),
    renderingMode: conf(renderingMode, renderingMode !== 'unknown' ? 'medium' : 'low'),
    availableApis: apis,
    needsPlaywright: conf(needsPlaywright, needsPlaywrightConf),
    multilingual: conf(multilingual, multilingual ? 'medium' : 'low'),
    sitemapUrls,
    sitemapProductCount: conf(sitemapProductCount, sitemapProductCount ? 'medium' : 'none'),
    status: 'completed' as PhaseStatus,
    dependencies: PHASE_DEPENDENCIES.platform,
    skipReason: null,
  };
}

// ── Phase 3: Adapter Selection & Testing ───────────────────────────────────────

async function probeAdapter(origin: string, platformPhase: PlatformPhase): Promise<AdapterPhase> {
  log('[Phase 3] Adapter Selection & Testing...');

  const platform = platformPhase.platform.value as string | null;
  const apis = platformPhase.availableApis;
  const wpRestApi = apis.find(a => a.name === 'wp-rest' && a.accessible);
  const shopifyApi = apis.find(a => a.name === 'shopify-json' && a.accessible);
  const ecwidApi = apis.find(a => a.name === 'ecwid-storefront' && a.accessible);

  let suggestedAdapter: string;
  let adapterConf: Confidence['confidence'] = 'medium';

  // Drupal classifieds detection — look for node--type-classified / gunpost-teaser
  // markers in the homepage/catalog HTML. If present alongside platform=drupal*,
  // suggest the purpose-built `classifieds-gunpost` adapter (domain-generic
  // for any Drupal-classified-node-type site using the same view mode and
  // `data-history-node-id` convention). Callers can still override.
  const isDrupalPlatform = platform === 'drupal' || platform === 'drupal-commerce';
  let isDrupalClassifieds = false;
  if (isDrupalPlatform) {
    const homeResp = await safeFetch(origin);
    if (homeResp && /node--type-classified|gunpost-teaser|classified-teaser/i.test(homeResp.data)) {
      isDrupalClassifieds = true;
    }
  }

  // When a JS-challenge WAF is in front of a known platform, the WP REST /
  // Shopify JSON / Ecwid storefront probes return 307/403 because axios can't
  // solve the challenge. BUT the production adapter has its own WAF cookie
  // solve path (`ensureCookies` in WooCommerceAdapter.searchViaApi,
  // waf-cookie-manager.ts), so the adapter WILL work at runtime once cookies
  // are cached. Treat platform==='woocommerce' + wafFallbackRequired as
  // sufficient evidence for adapter='woocommerce' — downgrading to
  // generic-retail would silently disable API-date-since-watermark and break
  // the 16k-product sites (gotenda.com is the canonical case — see Mistake 38).
  const apiGatedByWaf = g_wafFallbackRequired && !wpRestApi && !shopifyApi && !ecwidApi;

  if (platform === 'woocommerce' && wpRestApi) {
    suggestedAdapter = 'woocommerce';
    adapterConf = 'high';
  } else if (platform === 'woocommerce' && apiGatedByWaf) {
    suggestedAdapter = 'woocommerce';
    adapterConf = 'medium';
    log('  [adapter] platform=woocommerce but WP REST blocked by WAF. Assuming API will work once waf-cookie-manager solves cookies at runtime. See Mistake 38.');
  } else if (platform === 'shopify' && shopifyApi) {
    suggestedAdapter = 'shopify';
    adapterConf = 'high';
  } else if (platform === 'shopify' && apiGatedByWaf) {
    suggestedAdapter = 'shopify';
    adapterConf = 'medium';
    log('  [adapter] platform=shopify but /products.json blocked by WAF. Assuming API will work once waf-cookie-manager solves cookies at runtime.');
  } else if (platform === 'ecwid-on-wordpress' && ecwidApi) {
    suggestedAdapter = 'generic-retail'; // Ecwid handled as apiAlternative in GenericRetail
    adapterConf = 'high';
  } else if (isDrupalClassifieds) {
    // The classifieds-gunpost adapter's selectors (node--type-classified,
    // gunpost-teaser, data-history-node-id) match any Drupal site using
    // the standard classifieds content type + default teaser view mode.
    suggestedAdapter = 'classifieds-gunpost';
    adapterConf = 'high';
  } else if (platform) {
    suggestedAdapter = 'generic-retail';
    adapterConf = 'medium';
  } else {
    suggestedAdapter = 'generic-retail';
    adapterConf = 'low';
  }

  // API accessibility test
  let apiAccessible = false;
  if (wpRestApi) {
    // Test date-sorted query
    const r = await safeFetchJson(`${origin}/wp-json/wp/v2/product?per_page=1&orderby=date&order=desc`);
    apiAccessible = !!(r && r.status === 200 && Array.isArray(r.data) && r.data.length > 0);
  } else if (shopifyApi) {
    apiAccessible = true;
  } else if (ecwidApi) {
    apiAccessible = true;
  }

  // Extraction test — fetch a category page and try to extract products
  let extractionResult: AdapterPhase['extractionTestResult'] = null;
  // Try to find a category page from nav links
  const homeResp = await safeFetch(origin);
  if (homeResp) {
    const $ = cheerio.load(homeResp.data);
    // Find first plausible category link
    let categoryUrl: string | null = null;

    $('nav a[href], header a[href], .menu a[href], [class*="nav"] a[href]').each((_, el) => {
      if (categoryUrl) return;
      const href = $(el).attr('href') || '';
      // Skip non-category links
      if (/\/(cart|login|account|contact|about|faq|blog|news|privacy|terms|checkout|search|my-)\b/i.test(href)) return;
      if (href === '/' || href === '#' || href === origin) return;
      // Must look like a category/collection — generic platform-native paths
      // + some common domain-agnostic markers. Domain-specific category names
      // (firearms/rifles/etc.) are NOT in this list to keep the probe generic.
      // Added: classifieds-style listing paths (/ads, /listings, /classifieds)
      // so Drupal / custom classifieds sites are detected (gunpost.ca uses /ads).
      if (/\/(product-category|collections?|departments?|category|categories|shop|store|browse|all-products|all|products|catalog|ads|listings|classifieds)\b/i.test(href)) {
        try {
          const abs = href.startsWith('http') ? href : new URL(href, origin).toString();
          // Same-host only — never drift to a subdomain. gunpost.ca's nav
          // links to `shop.gunpost.ca/` (a separate WooCommerce merch site);
          // auditing that subdomain produces wrong platform/adapter output
          // for the origin site being probed.
          const abdOrigin = new URL(abs).origin;
          if (abdOrigin !== origin) return;
          categoryUrl = abs;
        } catch {}
      }
    });

    if (categoryUrl) {
      log(`  Testing extraction on: ${categoryUrl}`);
      const catResp = await safeFetch(categoryUrl);
      if (catResp && catResp.status === 200) {
        const cat$ = cheerio.load(catResp.data);
        const products = extractFirstProducts(cat$, categoryUrl, 10);
        const titles = extractProductTitles(cat$, 5);
        extractionResult = {
          url: categoryUrl,
          productsFound: products.length,
          sampleTitles: titles,
        };

        // Sub-category tile detection — WooCommerce/BC Stencil/Magento themes
        // can be configured to show subcategory tiles on parent category pages
        // instead of (or above) the product grid. The `extractFirstProducts`
        // selector matches these tiles (they also use `.product` / `li.product`
        // wrappers), so `productsFound` looks fine — but Phase 5 fails to find
        // a sort `<select>` and Phase 6 fails to find product-level pagination
        // because the tile page has neither.
        //
        // Heuristic: titles matching `^[A-Z][A-Z\s&\-\/]*\(\d+\)` (ALLCAPS
        // NAME followed by a `(count)`) or pure ALLCAPS titles with no
        // sentence-case content are category tiles, not product names.
        // Real product titles mix casing and SKU-like fragments.
        const TILE_RE = /^[A-Z0-9][A-Z0-9\s&\-\/]+(?:\s*\(\d+\))?$/;
        const tileTitleCount = titles.filter(t => TILE_RE.test(t) && /\(\d+\)$/.test(t)).length;
        const looksLikeTilePage = titles.length > 0 && tileTitleCount / titles.length >= 0.5;
        if (looksLikeTilePage) {
          log(`  [adapter] Parent category returned subcategory tiles (${tileTitleCount}/${titles.length} titles match tile pattern). Searching for a leaf category with real products...`);
          // Find a child URL under the same category — nav links that start
          // with the parent path + extra segment.
          const parentPath = new URL(categoryUrl).pathname.replace(/\/+$/, '');
          const childCandidates: string[] = [];
          $('nav a[href], header a[href], .menu a[href], [class*="nav"] a[href]').each((_, el) => {
            const href = $(el).attr('href') || '';
            if (!href) return;
            try {
              const abs = href.startsWith('http') ? href : new URL(href, origin).toString();
              if (new URL(abs).origin !== origin) return;
              const p = new URL(abs).pathname.replace(/\/+$/, '');
              if (p.startsWith(parentPath + '/') && p !== parentPath) {
                if (!childCandidates.includes(abs)) childCandidates.push(abs);
              }
            } catch {}
          });
          // Try each child; take the first one that returns real products
          // (i.e. titles that DON'T look like tiles).
          for (const child of childCandidates.slice(0, 5)) {
            const cResp = await safeFetch(child);
            if (!cResp || cResp.status !== 200) continue;
            const c$ = cheerio.load(cResp.data);
            const cProducts = extractFirstProducts(c$, child, 10);
            const cTitles = extractProductTitles(c$, 5);
            if (cProducts.length === 0 || cTitles.length === 0) continue;
            const cTileCount = cTitles.filter(t => TILE_RE.test(t) && /\(\d+\)$/.test(t)).length;
            if (cTileCount / cTitles.length < 0.5) {
              log(`  [adapter] Leaf category found: ${child} (${cProducts.length} products, ${cTitles.length} titles, tile ratio ${cTileCount}/${cTitles.length})`);
              extractionResult = {
                url: child,
                productsFound: cProducts.length,
                sampleTitles: cTitles,
              };
              break;
            }
          }
        }
      }
    }
  }

  return {
    suggestedAdapter: conf(suggestedAdapter, adapterConf),
    apiAccessible: conf(apiAccessible, apiAccessible ? 'high' : 'low'),
    extractionTestResult: extractionResult,
    status: 'completed' as PhaseStatus,
    dependencies: PHASE_DEPENDENCIES.adapter,
    skipReason: null,
  };
}

// ── Phase 4: Catalog Discovery ─────────────────────────────────────────────────

async function probeCatalog(origin: string, platformPhase: PlatformPhase): Promise<CatalogPhase> {
  log('[Phase 4] Catalog Discovery...');

  const platform = platformPhase.platform.value as string | null;
  const categoryTree: CatalogPhase['categoryTree'] = [];
  let apiProductCount: number | null = null;

  // WooCommerce: category taxonomy API
  if (platform === 'woocommerce') {
    const catResp = await safeFetchJson(`${origin}/wp-json/wp/v2/product_cat?per_page=100&hide_empty=true`);
    if (catResp && catResp.status === 200 && Array.isArray(catResp.data)) {
      for (const cat of catResp.data) {
        categoryTree.push({
          name: cat.name,
          url: cat.link || '',
          count: cat.count,
          parentId: cat.parent,
        });
      }
    }
    // Total product count from WP REST
    const wpTotal = platformPhase.availableApis.find(a => a.name === 'wp-rest')?.productCount;
    if (wpTotal) apiProductCount = wpTotal;
  }

  // Shopify: collections API
  if (platform === 'shopify') {
    const colResp = await safeFetchJson(`${origin}/collections.json?limit=250`);
    if (colResp && colResp.status === 200 && colResp.data?.collections) {
      for (const col of colResp.data.collections) {
        categoryTree.push({
          name: col.title,
          url: `/collections/${col.handle}`,
          count: col.products_count,
        });
      }
    }
  }

  // Nav link extraction from homepage
  const navLinks: string[] = [];
  const homeResp = await safeFetch(origin);
  if (homeResp) {
    const $ = cheerio.load(homeResp.data);
    const seen = new Set<string>();
    $('nav a[href], header a[href], .menu a[href], [class*="nav"] a[href], .mega-menu a[href]').each((_, el) => {
      let href = $(el).attr('href') || '';
      if (!href || href === '/' || href === '#') return;
      try {
        href = href.startsWith('http') ? href : new URL(href, origin).toString();
      } catch { return; }
      // Only same-origin
      if (!href.startsWith(origin)) return;
      // Skip obvious non-category
      if (/\/(cart|login|account|contact|about|faq|blog|news|privacy|terms|search|my-|checkout)\b/i.test(href)) return;
      const path = new URL(href).pathname;
      if (!seen.has(path)) {
        seen.add(path);
        navLinks.push(path);
      }
    });
  }

  // Sitemap product count from Phase 2
  const smCount = platformPhase.sitemapProductCount.value as number | null;

  return {
    categoryTree,
    navLinks,
    sitemapProductCount: conf(smCount, smCount ? 'medium' : 'none'),
    apiProductCount: conf(apiProductCount, apiProductCount ? 'high' : 'none'),
    status: 'completed' as PhaseStatus,
    dependencies: PHASE_DEPENDENCIES.catalog,
    skipReason: null,
  };
}

// ── Phase 5: Sort Verification ─────────────────────────────────────────────────

async function probeSort(origin: string, platformPhase: PlatformPhase, catalogPhase: CatalogPhase, adapterPhase?: AdapterPhase): Promise<SortPhase> {
  log('[Phase 5] Sort Verification...');

  const platform = platformPhase.platform.value as string | null;

  // Find a category page to test sort on.
  // For a clean ID-jump test, the "default" URL must have NO sort applied —
  // any testUrl with `/orderby/<value>/`, `?sort=`, etc. biases the baseline
  // toward whatever sort was baked into the URL.
  function stripSortFromUrl(u: string): string {
    try {
      const url = new URL(u);
      // Strip path-based sort segments
      url.pathname = url.pathname.replace(/\/(orderby|sort_by|sort-by|sort|order)\/[A-Za-z][A-Za-z0-9_-]+/g, '');
      // Strip query-based sort params — includes Drupal Views `sort_by` + `sort_order`
      for (const key of ['sort', 'order', 'sortby', 'sortBy', 'product_list_order', 'product_list_dir', 'orderby', 'sort_by', 'sort_order']) {
        url.searchParams.delete(key);
      }
      return url.toString().replace(/\/+$/, '');
    } catch { return u; }
  }

  let testUrl: string | null = null;
  // Prefer the URL Phase 3 already verified extracts products. This avoids
  // false "sort not tested" verdicts on sites where the bare category URL
  // returns a WAF challenge but a sub-category URL (CF rule-selective) works.
  // Gunpost.ca is the canonical case: `/ads` returns 403 with cf-mitigated:challenge,
  // but `/ads?f[0]=c:1` (facet-filtered) returns 200.
  if (adapterPhase?.extractionTestResult?.url && adapterPhase.extractionTestResult.productsFound > 0) {
    testUrl = adapterPhase.extractionTestResult.url;
  }
  // Prefer a category from the tree
  if (!testUrl && catalogPhase.categoryTree.length > 0) {
    const cat = catalogPhase.categoryTree.find(c => (c.count || 0) > 5) || catalogPhase.categoryTree[0];
    testUrl = cat.url.startsWith('http') ? cat.url : `${origin}${cat.url}`;
  }
  // Fallback: pick from nav links (generic platform-native paths only).
  // Prefer paths WITHOUT a pre-baked /orderby/... segment so the default-sort
  // baseline is unbiased.
  // Classifieds-style /ads|/listings|/classifieds are included so Drupal-based
  // classifieds (gunpost.ca) and custom classifieds sites get sort/pagination
  // verified too.
  if (!testUrl && catalogPhase.navLinks.length > 0) {
    const candidates = catalogPhase.navLinks.filter(p =>
      /\/(product-category|collections?|departments?|category|categories|shop|store|browse|all-products|catalog|products|ads|listings|classifieds)\b/i.test(p)
    );
    // Bare URL (no /orderby|/sort path segment) is preferred
    const bare = candidates.find(p => !/\/(orderby|sort_by|sort-by|sort|order)\//i.test(p));
    const chosen = bare || candidates[0];
    if (chosen) testUrl = `${origin}${chosen}`;
  }
  // Strip any lingering sort segment from the chosen testUrl
  if (testUrl) testUrl = stripSortFromUrl(testUrl);

  if (!testUrl) {
    return {
      sortOptions: [],
      sortScheme: conf(null, 'none'),
      idJumpTest: {
        defaultFirstProduct: null, newestFirstProduct: null, counterControlFirstProduct: null,
        newestParam: null, counterControlParam: null, verdict: 'not-tested',
      },
      status: 'failed' as PhaseStatus,
      dependencies: PHASE_DEPENDENCIES.sort,
      skipReason: null,
    };
  }

  log(`  Sort test URL: ${testUrl}`);
  const catResp = await safeFetch(testUrl);
  if (!catResp || catResp.status !== 200) {
    return {
      sortOptions: [],
      sortScheme: conf(null, 'none'),
      idJumpTest: {
        defaultFirstProduct: null, newestFirstProduct: null, counterControlFirstProduct: null,
        newestParam: null, counterControlParam: null, verdict: 'not-tested',
      },
      status: 'failed' as PhaseStatus,
      dependencies: PHASE_DEPENDENCIES.sort,
      skipReason: null,
    };
  }

  const $ = cheerio.load(catResp.data);

  // Extract sort options from <select> elements. Dedupe by (name+value) —
  // some sites render the <select> twice (top and bottom of the page).
  const sortOptionsSeen = new Set<string>();
  const sortOptions: SortOption[] = [];
  $('select').each((_, sel) => {
    const selEl = $(sel);
    const name = selEl.attr('name') || '';
    const id = selEl.attr('id') || '';
    // Heuristic: sort-related select elements
    if (/sort|order/i.test(name + id) || selEl.closest('[class*="sort"]').length > 0) {
      selEl.find('option').each((_, opt) => {
        const value = $(opt).attr('value') || '';
        const text = $(opt).text().trim();
        const key = `${name}|${id}|${value}`;
        if ((value || text) && !sortOptionsSeen.has(key)) {
          sortOptionsSeen.add(key);
          sortOptions.push({ value, text, selectName: name, selectId: id });
        }
      });
    }
  });

  // Also check <a> based sort (Odoo + Drupal Views style): href carries
  // query params. Drupal Views uses `sort_by=<column>&sort_order=ASC|DESC`;
  // Odoo uses `order=<column>+<dir>`; some Drupal themes use a plain
  // `sort=<column>&order=<dir>` pair on <a> tags instead of <select>.
  $('a[href*="order="], a[href*="sort="], a[href*="sortby="], a[href*="sort_by="]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim();
    const paramMatch = href.match(/[?&](order|sort|sortby|sort_by|product_list_order)=([^&#]+)/);
    if (paramMatch && text) {
      // Capture paired direction params (sort_order for Drupal Views,
      // order for bare Drupal-sort anchors) so the option value reflects
      // the full sort directive. Without this, ID-jump builds `?sort=created`
      // (ASC default) instead of `?sort=created&order=desc` and misses the
      // newest-first intent the link encodes.
      let fullValue = paramMatch[2];
      let paired: string | null = null;
      if (paramMatch[1] === 'sort_by') {
        const m = href.match(/[?&]sort_order=([^&#]+)/);
        if (m) paired = `sort_order=${m[1]}`;
      } else if (paramMatch[1] === 'sort') {
        const m = href.match(/[?&]order=([^&#]+)/);
        if (m) paired = `order=${m[1]}`;
      }
      if (paired) fullValue = `${paramMatch[2]}&${paired}`;
      const key = `${paramMatch[1]}||${fullValue}`;
      if (!sortOptionsSeen.has(key)) {
        sortOptionsSeen.add(key);
        sortOptions.push({ value: fullValue, text, selectName: paramMatch[1], selectId: '' });
      }
    }
  });

  // Detect path-based sort scheme. Some platforms (Celerant, some OpenCart
  // themes, certain LightSpeed configurations) encode sort in the URL path
  // as /orderby/<value>/ or /sort/<value>/ rather than as a query param.
  // We scan all nav/pagination links for /orderby/|/sort_by/|/sort/|/o/|/order/ path
  // segments followed by an identifier to detect this convention.
  let sortScheme: 'query' | 'path' | 'hash' | 'js-only' | null = null;
  const pathSortRegex = /\/(orderby|sort_by|sort-by|sort|order)\/([A-Za-z][A-Za-z0-9_-]+)\//;
  let pathSortSegmentFound: string | null = null;
  $('a[href]').each((_, el) => {
    if (pathSortSegmentFound) return;
    const href = $(el).attr('href') || '';
    const m = href.match(pathSortRegex);
    if (m) pathSortSegmentFound = m[1]; // the keyword, e.g. "orderby"
  });
  if (pathSortSegmentFound) sortScheme = 'path';
  else if (sortOptions.some(o => o.selectName || o.selectId)) sortScheme = 'query';
  // Hash sort scheme is Searchspring-detected in Phase 2 — not mechanical from DOM alone.
  // JS-only sort scheme (Ecwid SPA, GoDaddy OLS) needs Playwright — probe can't detect from static HTML.

  if (sortOptions.length === 0) {
    // No sort UI found — check if OpenCart (hidden date sort probe)
    const result: SortPhase = {
      sortOptions: [],
      sortScheme: conf(pathSortSegmentFound ? 'path' : null, pathSortSegmentFound ? 'medium' : 'none'),
      idJumpTest: {
        defaultFirstProduct: null, newestFirstProduct: null, counterControlFirstProduct: null,
        newestParam: null, counterControlParam: null, verdict: 'no-sort-options',
      },
      status: 'completed' as PhaseStatus,
      dependencies: PHASE_DEPENDENCIES.sort,
      skipReason: null,
    };

    if (platform === 'opencart') {
      // OpenCart hidden date sort probe (Mistake 21)
      const defaultProducts = extractFirstProducts($, testUrl, 1);
      const dateProbeUrl = testUrl + (testUrl.includes('?') ? '&' : '?') + 'sort=p.date_added&order=DESC';
      const dateResp = await safeFetch(dateProbeUrl);
      if (dateResp && dateResp.status === 200) {
        const date$ = cheerio.load(dateResp.data);
        const dateProducts = extractFirstProducts(date$, dateProbeUrl, 1);
        result.openCartDateProbe = {
          param: '?sort=p.date_added&order=DESC',
          firstProduct: dateProducts[0] || null,
          defaultFirstProduct: defaultProducts[0] || null,
          honored: dateProducts[0] !== defaultProducts[0] && dateProducts.length > 0,
        };
        if (result.openCartDateProbe.honored) {
          result.idJumpTest.verdict = 'honored';
          result.idJumpTest.newestParam = 'sort=p.date_added&order=DESC';
          result.idJumpTest.defaultFirstProduct = defaultProducts[0] || null;
          result.idJumpTest.newestFirstProduct = dateProducts[0] || null;
        }
      }
    }

    return result;
  }

  // Identify ALL newest-style candidates (not just the first). Different vendors
  // expose multiple newest-style sorts with different semantics (e.g. Celerant's
  // `new-arrivals` = "new to storefront" vs `newest-rcvd` = "newest received by
  // warehouse" — both match the newest regex but produce DIFFERENT orderings).
  // Probing all candidates and picking the one that produces the most distinct
  // ordering avoids silently choosing the wrong one.
  // NEWEST_REGEX matches both text labels ("Newest", "New Arrivals", "Posted Date")
  // and machine values (`created`, `date_pub`, `addedTimeDesc`, etc.). The
  // `created&order=desc` / `sort_by=date_pub&sort_order=DESC` full option
  // values produced by the anchor-pair capture above are covered by the
  // `created.*desc` and `date.*desc` fragments.
  // The bare `posted` / `date_pub` / `created` words match the "newest by date"
  // intent found on Drupal classifieds sites where the sort label is literally
  // "Posted Date" rather than "Newest".
  // Vendor-specific newest-sort label variants:
  //   WooCommerce default:    text="Sort by latest", value="date"
  //   Shopify default:         text="Date, new to old", value="created-descending"
  //   BC Stencil default:      text="Newest Items", value="newest"
  //   Magento default:         text="Newest" or "Most Recent", value varies
  //   Celerant default:        text="New Arrivals" or "Newest Received", value="new-arrivals"
  //   Drupal Views classifieds: text="Posted Date" (with `&order=desc`),
  //                             value="created&order=desc" or "date_pub&sort_order=DESC"
  //   Ecwid storefront API:    value="addedTimeDesc" (no <select>, API only)
  //   GoDaddy OLS SPA:         value="descend_by_created_at" (hash, not <select>)
  // The regex must match EITHER the option's text OR its value — the text
  // is the human label and the value is the machine token; different vendors
  // use different fields as the sort signal.
  const NEWEST_REGEX = /newest|new.to.old|most.recent|new[- ]?arrival|date.*desc|added.*desc|created.*desc|published.*desc|addedtimedesc|created-descending|published-descending|recent|posted|\bcreated\b|\bdate_pub\b|\blatest\b|\bdate$|^date\b|\bby date\b|\bsort by date\b/i;
  // Counter-control selection is load-bearing for the 3-outcome sort test:
  // when `newest == default`, we need ANOTHER sort option that demonstrably
  // re-orders the results — only then can we distinguish "honored-default-
  // is-newest" from true "noop". WooCommerce's default select exposes
  // popularity / rating / date / price (low→high) / price-desc (high→low)
  // and has NO alphaasc option, so the old regex matched nothing on 16k-
  // product WooCommerce sites (gotenda.com canonical case, Mistake 38).
  // Rank counter candidates by likely-to-differ-from-newest:
  //   1. alpha/name/title ASC (classic counter — most likely to differ)
  //   2. price ASC or DESC (price variance is almost always independent of date)
  //   3. popularity / rating / bestsellers (default merchant-pushed order —
  //      usually differs from strict date)
  //   4. ANY remaining sort option that is NOT a newest candidate
  const COUNTER_REGEX = /alpha.*asc|name.*asc|\ba.*z\b|title.*asc|nameasc|alphaasc/i;
  const PRICE_REGEX = /\bprice\b|priceasc|price-low|price.*low|low.*high|high.*low|price-desc|pricedesc/i;
  const POPULARITY_REGEX = /popularity|popular|bestseller|best.sell|trending|featured|rating/i;

  const newestCandidates = sortOptions.filter(o => NEWEST_REGEX.test(o.text + ' ' + o.value));
  const newestSet = new Set(newestCandidates.map(o => o.value));
  const isNewest = (o: SortOption) => newestSet.has(o.value);
  let counterOption: SortOption | null =
    sortOptions.find(o => !isNewest(o) && COUNTER_REGEX.test(o.text + ' ' + o.value)) ||
    sortOptions.find(o => !isNewest(o) && PRICE_REGEX.test(o.text + ' ' + o.value)) ||
    sortOptions.find(o => !isNewest(o) && POPULARITY_REGEX.test(o.text + ' ' + o.value)) ||
    sortOptions.find(o => !isNewest(o)) ||
    null;

  // Helper: build a URL applying a given sort option. Supports BOTH query-param
  // schemes (`?order=<value>`) and path schemes (`/orderby/<value>/`).
  // Handles paired values like `created&order=desc` or `date_pub&sort_order=DESC`
  // emitted by the anchor-pair capture — split on `&` and apply each sub-param.
  const buildSortUrl = (opt: SortOption): string => {
    if (sortScheme === 'path' && pathSortSegmentFound) {
      // Path-based: insert `/<keyword>/<value>` before the trailing slash.
      // If the value has paired query params (unlikely for path-scheme sites),
      // strip them for the path insertion.
      const pathValue = opt.value.split('&')[0];
      const base = testUrl!.replace(/\/+$/, '');
      const re = new RegExp(`/${pathSortSegmentFound}/[A-Za-z][A-Za-z0-9_-]*`);
      if (re.test(base)) return base.replace(re, `/${pathSortSegmentFound}/${pathValue}`);
      return `${base}/${pathSortSegmentFound}/${pathValue}`;
    }
    // Query-param scheme
    const base = new URL(testUrl!);
    if (opt.selectName) {
      // Split paired values (e.g. `created&order=desc` → `sort=created` +
      // `order=desc`). The primary value is the first sub-token; any
      // `key=value` parts after `&` are applied as additional searchParams.
      const parts = opt.value.split('&');
      const primaryValue = parts[0];
      base.searchParams.set(opt.selectName, primaryValue);
      for (const extra of parts.slice(1)) {
        const eq = extra.indexOf('=');
        if (eq > 0) {
          base.searchParams.set(extra.slice(0, eq), extra.slice(eq + 1));
        }
      }
      return base.toString();
    }
    // <a>-based without selectName: assume the option value is a literal
    // query string fragment
    return testUrl + (testUrl!.includes('?') ? '&' : '?') + `${opt.selectName || 'sort'}=${opt.value}`;
  };

  // Default (unsorted) first product
  const defaultProducts = extractFirstProducts($, testUrl, 1);

  // Run ID-jump for every newest candidate — collect { value, text, firstProduct, score }
  const newestResults: { value: string; text: string; firstProduct: string | null; score: number }[] = [];
  for (const cand of newestCandidates) {
    const sortUrl = buildSortUrl(cand);
    const r = await safeFetch(sortUrl);
    if (r && r.status === 200) {
      const s$ = cheerio.load(r.data);
      const firstProduct = extractFirstProducts(s$, sortUrl, 1)[0] || null;
      // Score: distinct-from-default (+2) + distinct-from-other-candidates (+1 each)
      let score = 0;
      if (firstProduct && defaultProducts[0] && firstProduct !== defaultProducts[0]) score += 2;
      newestResults.push({ value: cand.value, text: cand.text, firstProduct, score });
    } else {
      newestResults.push({ value: cand.value, text: cand.text, firstProduct: null, score: -1 });
    }
  }
  // Award +1 for each other candidate with a different firstProduct
  for (const r of newestResults) {
    if (!r.firstProduct) continue;
    for (const other of newestResults) {
      if (other === r) continue;
      if (other.firstProduct && other.firstProduct !== r.firstProduct) r.score += 1;
    }
  }
  newestResults.sort((a, b) => b.score - a.score);

  // The primary newest option is the highest-scoring one
  const primaryNewest = newestResults.length > 0 && newestResults[0].score >= 0
    ? newestCandidates.find(c => c.value === newestResults[0].value) || null
    : null;

  let counterProducts: string[] = [];
  let counterParam: string | null = null;
  if (counterOption) {
    const sortUrl = buildSortUrl(counterOption);
    counterParam = sortScheme === 'path'
      ? `${pathSortSegmentFound}/${counterOption.value}`
      : `${counterOption.selectName}=${counterOption.value}`;
    const r = await safeFetch(sortUrl);
    if (r && r.status === 200) {
      const s$ = cheerio.load(r.data);
      counterProducts = extractFirstProducts(s$, sortUrl, 1);
    }
  }

  const newestProducts: string[] = primaryNewest
    ? [newestResults[0].firstProduct].filter(Boolean) as string[]
    : [];
  const newestParam = primaryNewest
    ? (sortScheme === 'path'
        ? `${pathSortSegmentFound}/${primaryNewest.value}`
        : `${primaryNewest.selectName}=${primaryNewest.value}`)
    : null;

  // Determine verdict — 3-outcome decision tree (Mistake 29):
  //   `honored`                  — newest != default
  //   `honored-default-is-newest` — newest == default BUT counter-control differs
  //   `noop`                     — everything identical
  let verdict: SortPhase['idJumpTest']['verdict'] = 'noop';
  if (newestProducts[0] && defaultProducts[0]) {
    if (newestProducts[0] !== defaultProducts[0]) {
      verdict = 'honored';
    } else if (counterProducts[0] && counterProducts[0] !== defaultProducts[0]) {
      verdict = 'honored-default-is-newest';
    } else {
      verdict = 'noop';
    }
  } else if (newestCandidates.length === 0) {
    verdict = 'no-sort-options';
  }

  return {
    sortOptions,
    sortScheme: conf(sortScheme, sortScheme ? 'high' : 'none'),
    newestCandidates: newestResults.length > 0 ? newestResults : undefined,
    idJumpTest: {
      defaultFirstProduct: defaultProducts[0] || null,
      newestFirstProduct: newestProducts[0] || null,
      counterControlFirstProduct: counterProducts[0] || null,
      newestParam,
      counterControlParam: counterParam,
      verdict,
    },
    status: 'completed' as PhaseStatus,
    dependencies: PHASE_DEPENDENCIES.sort,
    skipReason: null,
  };
}

// ── Phase 6: Pagination Verification ───────────────────────────────────────────

async function probePagination(origin: string, catalogPhase: CatalogPhase, platformPhase: PlatformPhase, adapterPhase?: AdapterPhase): Promise<PaginationPhase> {
  log('[Phase 6] Pagination Verification...');

  // Find a category page to test
  let testUrl: string | null = null;
  // Prefer Phase 3's verified URL (see Phase 5 rationale) so CF-selective
  // WAFs don't kill Phase 6 when the bare catalog URL is blocked.
  if (adapterPhase?.extractionTestResult?.url && adapterPhase.extractionTestResult.productsFound > 0) {
    testUrl = adapterPhase.extractionTestResult.url;
  }
  if (!testUrl && catalogPhase.categoryTree.length > 0) {
    const cat = catalogPhase.categoryTree.find(c => (c.count || 0) > 30) || catalogPhase.categoryTree[0];
    testUrl = cat.url.startsWith('http') ? cat.url : `${origin}${cat.url}`;
  }
  if (!testUrl && catalogPhase.navLinks.length > 0) {
    const candidate = catalogPhase.navLinks.find(p =>
      /\/(product-category|collections?|departments?|category|categories|shop|store|browse|all-products|catalog|products|ads|listings|classifieds)\b/i.test(p)
    );
    if (candidate) testUrl = `${origin}${candidate}`;
  }

  const empty: PaginationPhase = {
    paginationPattern: conf(null, 'none'), perPage: conf(null, 'none'),
    page1Products: [], page2Products: [], zeroOverlap: conf(null, 'none'), paginationLinks: [],
    zeroIndexed: conf(null, 'none'), firstPageHasParam: conf(null, 'none'),
    totalPagesObserved: conf(null, 'none'),
    status: 'failed' as PhaseStatus,
    dependencies: PHASE_DEPENDENCIES.pagination,
    skipReason: null,
  };

  if (!testUrl) return empty;

  log(`  Pagination test URL: ${testUrl}`);
  const p1Resp = await safeFetch(testUrl);
  if (!p1Resp || p1Resp.status !== 200) return empty;

  const p1$ = cheerio.load(p1Resp.data);
  const page1Products = extractFirstProducts(p1$, testUrl, 20);

  // Extract pagination links from HTML
  const paginationLinks: string[] = [];
  const paginationSelectors = [
    'a[href*="page="]', 'a[href*="/page/"]', 'a[href*="paged="]',
    '.pagination a[href]', '.pager a[href]', 'nav.woocommerce-pagination a[href]',
    '[class*="pagination"] a[href]', 'a[class*="page-numbers"]',
    'a[href*="page"][href*=".html"]', // LightSpeed suffix
  ];
  const seenLinks = new Set<string>();
  for (const sel of paginationSelectors) {
    p1$(sel).each((_, el) => {
      const href = p1$(el).attr('href') || '';
      if (href && !seenLinks.has(href)) {
        seenLinks.add(href);
        paginationLinks.push(href);
      }
    });
  }

  // Detect pagination pattern from links
  let detectedPattern: string | null = null;
  let page2Url: string | null = null;

  for (const link of paginationLinks) {
    let fullLink: string;
    try {
      fullLink = link.startsWith('http') ? link : new URL(link, testUrl).toString();
    } catch { continue; }

    // Query param: ?page=2
    if (/[?&]page=2(&|$)/.test(fullLink)) {
      detectedPattern = 'query:page';
      page2Url = fullLink;
      break;
    }
    // Path: /page/2
    if (/\/page\/2\/?/.test(fullLink)) {
      detectedPattern = 'path:/page/{N}';
      page2Url = fullLink;
      break;
    }
    // Paged query: ?paged=2
    if (/[?&]paged=2(&|$)/.test(fullLink)) {
      detectedPattern = 'query:paged';
      page2Url = fullLink;
      break;
    }
    // Suffix: page2.html (LightSpeed)
    if (/page2\.html/.test(fullLink)) {
      detectedPattern = 'suffix-replace:page{N}.html';
      page2Url = fullLink;
      break;
    }
    // Offset query: ?offset=N
    if (/[?&]offset=\d+/.test(fullLink)) {
      detectedPattern = 'offset-query';
      page2Url = fullLink;
      break;
    }
  }

  // VERIFY detected pattern against counter-candidate. Some platforms (LightSpeed
  // eCom, certain Celerant configs) accept BOTH `?page=N` AND `/page/N` in URLs,
  // but only one is actually honored — the other silently returns page 1. Run
  // a cross-check: if we detected query:page, also try path:/page/{N} and take
  // whichever produces page-1-distinct products (non-overlap with page 1).
  async function verifyPattern(pattern: string, url: string): Promise<{ pattern: string; url: string; p2Products: string[]; overlap: number } | null> {
    const r = await safeFetch(url);
    if (!r || r.status !== 200) return null;
    const c$ = cheerio.load(r.data);
    const p2 = extractFirstProducts(c$, url, 20);
    const overlap = p2.filter(u => page1Products.includes(u)).length;
    return { pattern, url, p2Products: p2, overlap };
  }

  // If no page 2 link found from DOM, OR we want to cross-verify, try common
  // patterns. Critically: candidates must PRESERVE any sort-path segment
  // (e.g. /orderby/<value>/) that's already baked into testUrl.
  const candidates: { pattern: string; url: string }[] = [];
  const baseNoTrailing = testUrl.replace(/\/+$/, '');
  candidates.push({ pattern: 'query:page', url: testUrl + (testUrl.includes('?') ? '&page=2' : '?page=2') });
  candidates.push({ pattern: 'path:/page/{N}', url: `${baseNoTrailing}/page/2` });
  candidates.push({ pattern: 'query:paged', url: testUrl + (testUrl.includes('?') ? '&paged=2' : '?paged=2') });
  // Suffix-replace for LightSpeed eCom-style `page2.html`
  if (/\.html(\?|$)/.test(testUrl)) {
    candidates.push({ pattern: 'suffix-replace:page{N}.html', url: testUrl.replace(/\/([^/?#.]*?)(\.html)(\?.*)?$/, '/$1/page2.html$3') });
  }

  // If DOM already pointed to a specific pattern, test it FIRST but still
  // verify against page-1 non-overlap
  if (page2Url && detectedPattern) {
    candidates.unshift({ pattern: detectedPattern, url: page2Url });
  }

  // Probe every candidate and keep the first with zero-overlap-to-page-1
  let bestCandidate: { pattern: string; url: string; p2Products: string[]; overlap: number } | null = null;
  for (const c of candidates) {
    const result = await verifyPattern(c.pattern, c.url);
    if (!result) continue;
    // Keep the first pattern that produces fresh products
    if (result.p2Products.length > 0 && result.overlap === 0) {
      bestCandidate = result;
      break;
    }
    // Keep the "best" (lowest-overlap) as a fallback if none fully zero
    if (!bestCandidate || result.overlap < bestCandidate.overlap) bestCandidate = result;
  }
  if (bestCandidate) {
    detectedPattern = bestCandidate.pattern;
    page2Url = bestCandidate.url;
  }

  // Fetch page 2 and compare
  let page2Products: string[] = [];
  if (page2Url) {
    const p2Resp = await safeFetch(page2Url);
    if (p2Resp && p2Resp.status === 200) {
      const p2$ = cheerio.load(p2Resp.data);
      page2Products = extractFirstProducts(p2$, page2Url, 20);
    }
  }

  const overlap = page2Products.filter(u => page1Products.includes(u));
  const zeroOverlap = page2Products.length > 0 && overlap.length === 0;

  // Detect 0-indexed pagination (Drupal Views convention).
  // Signal: any pagination link with `?page=0` OR `&page=0` literal. Matches
  // gunpost.ca (`<a href="?sort_by=...&page=0" title="Current page">`). This
  // feeds profile.paginationPattern.zeroIndexed.
  const zeroIndexed = paginationLinks.some(l => /[?&]page=0(&|$|#)/.test(l));

  // Detect firstPageHasParam — if the page-0 or page-1 link is the
  // "Current page" anchor, the param is explicit; otherwise the default
  // URL (no page param) IS page 1.
  const firstPageHasParam = !!paginationLinks.find(l =>
    /title=("Current page"|'Current page')/i.test(l) ||
    /aria-current=("page"|'page')/i.test(l)
  );

  // Max page observed across the page-link DOM. Useful for product-count
  // estimation (totalPages * perPage ≈ total count). gunpost.ca advertises
  // `page=1693` on the Rifles facet (1694 pages × 18 = 30,492 ≈ 30,423).
  let totalPages: number | null = null;
  for (const l of paginationLinks) {
    const m = l.match(/[?&]page=(\d+)/);
    if (m) {
      const n = parseInt(m[1]);
      if (!isNaN(n) && (totalPages === null || n > totalPages)) totalPages = n;
    }
  }
  // If 0-indexed, totalPages is max-observed + 1 (since index 0 = page 1)
  const totalPagesAdjusted = totalPages !== null ? (zeroIndexed ? totalPages + 1 : totalPages) : null;

  return {
    paginationPattern: conf(detectedPattern, detectedPattern && zeroOverlap ? 'high' : detectedPattern ? 'medium' : 'none'),
    perPage: conf(page1Products.length > 0 ? page1Products.length : null, page1Products.length > 0 ? 'medium' : 'none'),
    page1Products: page1Products.slice(0, 5),
    page2Products: page2Products.slice(0, 5),
    zeroOverlap: conf(zeroOverlap, page2Products.length > 0 ? 'high' : 'none'),
    paginationLinks: paginationLinks.slice(0, 10),
    zeroIndexed: conf(zeroIndexed, zeroIndexed ? 'high' : paginationLinks.length > 0 ? 'medium' : 'none'),
    firstPageHasParam: conf(firstPageHasParam, firstPageHasParam ? 'high' : paginationLinks.length > 0 ? 'medium' : 'none'),
    totalPagesObserved: conf(totalPagesAdjusted, totalPagesAdjusted !== null ? 'medium' : 'none'),
    status: 'completed' as PhaseStatus,
    dependencies: PHASE_DEPENDENCIES.pagination,
    skipReason: null,
  };
}

// ── Phase 7: Assembly ──────────────────────────────────────────────────────────

function assemble(
  errors: ProbeError[],
  access: AccessPhase,
  platform: PlatformPhase,
  adapter: AdapterPhase,
  catalog: CatalogPhase,
  sort: SortPhase,
  pagination: PaginationPhase,
): AssemblyPhase {
  const completed: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];

  // M10: classify each phase by its status field. `skipped-upstream` =
  // didn't run because dep failed. `failed` = ran but produced no useful
  // output. `completed` = ran successfully. The lists are mutually exclusive.
  const phasesArr: { name: string; phase: PhaseStatusFields }[] = [
    { name: 'access', phase: access },
    { name: 'platform', phase: platform },
    { name: 'adapter', phase: adapter },
    { name: 'catalog', phase: catalog },
    { name: 'sort', phase: sort },
    { name: 'pagination', phase: pagination },
  ];
  for (const { name, phase } of phasesArr) {
    if (phase.status === 'completed') completed.push(name);
    else if (phase.status === 'skipped-upstream') skipped.push(name);
    else failed.push(name);
  }

  // Per-phase warnings (only fire on failures, not skips — a skipped phase's
  // failure was already announced by the dep that caused the skip).
  if (failed.includes('adapter') && (!adapter.extractionTestResult || adapter.extractionTestResult.productsFound === 0)) {
    warnings.push('Product extraction returned 0 products — may need Playwright or different selectors');
  }
  if (failed.includes('sort') || skipped.includes('sort')) {
    if (sort.idJumpTest.verdict === 'no-sort-options') {
      warnings.push('No sort UI found in HTML. If this is a SPA, drive Playwright to discover sort controls (Mistake 19).');
    }
  } else if (sort.idJumpTest.verdict !== 'honored' && sort.idJumpTest.verdict !== 'honored-default-is-newest') {
    // Sort completed but didn't show clear newest-first honoring
    warnings.push('Sort options found but none honored newest-first ordering. Verify manually.');
  }
  if (failed.includes('pagination')) {
    warnings.push('Pagination not verified — page 2 overlap test failed or no page 2 found.');
  }
  if (skipped.length > 0) {
    warnings.push(`Phases skipped due to upstream dep failure: ${skipped.join(', ')}. Each skipped phase has skipReason set.`);
  }

  // WAF warnings
  if (access.hasWaf.value && !access.wafProbeEvidence.error) {
    warnings.push(`WAF detected: ${access.wafType.value}. May need cookie management or Playwright.`);
  }

  // Malformed-header warning (Celerant / ColdFusion / legacy IIS). The production
  // http-client.ts catches this via native-fetch fallback; the probe now also
  // handles it, but any site that triggers this needs explicit `wafWorkaround`
  // profile metadata.
  if (access.malformedHeaders?.value === true) {
    warnings.push('Server sends malformed HTTP/1.1 headers (HPE_INVALID_HEADER_TOKEN). Axios fails; native-fetch fallback in http-client.ts handles this. Profile must record wafWorkaround.method=undici-fallback.');
  }

  // SPA warning
  if (platform.renderingMode.value === 'spa-likely') {
    warnings.push('Site appears to be a SPA. Static HTML extraction may return 0 products. Use Playwright.');
  }

  // JS overlay warning
  if (platform.jsOverlay.value) {
    warnings.push(`JS overlay detected: ${platform.jsOverlay.value}. Sort/pagination may be hijacked (see Searchspring/Klevu lessons).`);
  }

  // Multiple-newest-sort disambiguation warning
  if ((sort as any).newestCandidates && (sort as any).newestCandidates.length > 1) {
    const chosen = (sort as any).newestCandidates[0];
    warnings.push(`Multiple newest-style sort options found (${(sort as any).newestCandidates.length}). Selected "${chosen?.value}" via ID-jump score=${chosen?.score}. Verify manually — other candidates may be correct for different merchants (e.g. Celerant new-arrivals vs newest-rcvd).`);
  }

  // Path-based sort scheme warning — informs the skill to emit path-form sortParam
  if (sort.sortScheme?.value === 'path') {
    warnings.push('Sort uses URL PATH scheme (not query param). catalogUrls must bake sort segment into the URL (e.g. /orderby/<value>/). paginationPattern must preserve the sort segment in page URLs.');
  }

  const phaseErrors = errors.map(e => e.phase);
  // M10: overallConfidence only penalizes FAILED phases — phases that ran but
  // produced no useful output. Skipped-upstream phases didn't run at all
  // (their parent dep failed), so the user already lost confidence at the
  // upstream failure; double-counting via a skipped child would mis-weight.
  const overallConfidence = failed.length === 0 ? 'high' : failed.length <= 2 ? 'medium' : 'low';

  // Detect whether the pagination/sort test URL was facet-filtered. Common
  // signals: URL contains `f[0]=` (Drupal Views facet), `category=` query
  // param, etc. When true, totalPagesObserved is a SUBSET count, not the
  // global count — the skill must warn the operator.
  const probeTestUrl = adapter.extractionTestResult?.url || '';
  const FACET_FILTERED_RE = /(?:[?&](?:f(?:\[|%5B)\d+(?:\]|%5D)=|category=|cat=|taxonomy=|filter=)|\/(?:category|department|brand)\/)/i;
  const wasFacetFiltered = FACET_FILTERED_RE.test(probeTestUrl);

  // Derive an expected product count from the probe ingredients. Priority:
  //   1. API product count (WP REST, WC Store API, Ecwid totalProductsCount)
  //   2. Pagination walk (totalPages * perPage) — only when NOT facet-filtered
  //   3. Sitemap count (always a fallback — may lag for classifieds)
  let expectedCount: number | null = null;
  let expectedSource: string | null = null;
  // 1. API count
  const apiCount = platform.availableApis.find(a => a.accessible && a.productCount)?.productCount;
  if (apiCount && apiCount > 0) {
    expectedCount = apiCount;
    expectedSource = 'api';
  }
  // 2. Pagination walk (only when we trust the scope)
  if (!expectedCount) {
    const totalPages = pagination.totalPagesObserved.value as number | null;
    const perPage = pagination.perPage.value as number | null;
    if (totalPages && perPage && !wasFacetFiltered) {
      expectedCount = totalPages * perPage;
      expectedSource = 'pagination-walk';
    }
  }
  // 3. Sitemap fallback
  if (!expectedCount) {
    const smCount = platform.sitemapProductCount.value as number | null;
    if (smCount && smCount > 0) {
      expectedCount = smCount;
      expectedSource = 'sitemap';
    }
  }

  // Warning when we had to facet-filter — skill must re-verify global count
  if (wasFacetFiltered) {
    warnings.push(
      `Probe test URL was facet-filtered (${probeTestUrl}). Phase 6 totalPagesObserved reflects the FACET subset, not the global catalog. Re-verify expectedProductCount by walking the global sorted URL before writing the profile.`,
    );
  }

  // Warning when the best-count source is sitemap for a classifieds-style
  // site (Drupal classifieds, etc.). Sitemap lags the live /ads listing
  // because expired/sold listings drop from sitemap faster than from the
  // live catalog.
  if (expectedSource === 'sitemap' && adapter.suggestedAdapter.value === 'classifieds-gunpost') {
    warnings.push(
      `Sitemap product count (${expectedCount}) used for classifieds site. Sitemap typically LAGS the live /ads listing by 1-3 days because expired/sold listings drop from sitemap faster. Prefer a pagination walk of the global sorted catalogUrl for canonical count.`,
    );
  }

  // WAF-fallback signal — the probe itself had to use Playwright to get past
  // a JS-challenge WAF. Informs the skill to set `needsPlaywright: true` and
  // (for WooCommerce sites) `wafWorkaround.method: 'cookie-cache'`.
  if (g_wafFallbackObserved) {
    warnings.push(
      `Probe used Playwright fallback ${g_playwrightHits} time(s) to bypass JS-challenge WAF. Profile must set needsPlaywright=true. For WooCommerce/Shopify/Ecwid sites, also set wafWorkaround.method='cookie-cache' so waf-cookie-manager.ts pre-solves cookies once per 30-90min instead of re-running Playwright per request.`,
    );
  }

  return {
    overallConfidence,
    completedPhases: completed,
    failedPhases: failed,
    skippedPhases: skipped,
    warnings,
    expectedProductCount: conf(expectedCount, expectedCount ? (expectedSource === 'api' ? 'high' : 'medium') : 'none'),
    expectedProductCountSource: expectedSource,
    testUrlWasFacetFiltered: conf(wasFacetFiltered, wasFacetFiltered ? 'high' : 'low'),
    wafFallbackUsed: conf(g_wafFallbackObserved, g_wafFallbackObserved ? 'high' : 'low'),
    playwrightFetchCount: g_playwrightHits,
    // Assembly always runs to completion (it's pure aggregation, can't fail
    // unless a phase result is malformed). The dependencies array reflects
    // that it consumed all phase outputs.
    status: 'completed' as PhaseStatus,
    dependencies: PHASE_DEPENDENCIES.assembly,
    skipReason: null,
  };
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const inputUrl = process.argv[2];
  if (!inputUrl) {
    console.error('Usage: npx tsx scripts/pre-bootstrap-probe.ts https://example.com');
    process.exit(1);
  }

  // Normalize URL
  let url = inputUrl;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  const startTime = Date.now();
  const errors: ProbeError[] = [];

  log(`\nPre-bootstrap probe: ${url}`);
  log('=' .repeat(60));

  // M10: track each phase's status so downstream phases can check deps before
  // running. The map is the single source of truth for "did this phase
  // complete?" — both the dep gate and the assembly classifier read from it.
  const phaseStatuses: Record<string, PhaseStatus> = {};

  // Phase 1: Access (no deps)
  let accessResult: AccessPhase;
  let canonical: string;
  try {
    const r = await probeAccess(url);
    accessResult = r.result;
    canonical = r.canonical;
  } catch (e: any) {
    errors.push({ phase: 'access', message: e.message, stack: e.stack?.slice(0, 500) });
    canonical = new URL(url).origin;
    accessResult = emptyAccessPhase();
    accessResult.wafProbeEvidence = { error: e.message };
  }
  phaseStatuses.access = finalizePhaseStatus('access', accessResult).status;

  // Phase 2: Platform (deps: access)
  let platformResult: PlatformPhase;
  let failingDep = findFailingDependency('platform', phaseStatuses);
  if (failingDep) {
    log(`[Phase 2] SKIPPED — upstream dep "${failingDep}" failed`);
    platformResult = emptyPlatformPhase(`Phase ${failingDep} failed`);
  } else {
    try {
      platformResult = await probePlatform(canonical, accessResult);
    } catch (e: any) {
      errors.push({ phase: 'platform', message: e.message, stack: e.stack?.slice(0, 500) });
      platformResult = emptyPlatformPhase();
    }
    finalizePhaseStatus('platform', platformResult);
  }
  phaseStatuses.platform = platformResult.status;

  // Phase 3: Adapter (deps: platform)
  let adapterResult: AdapterPhase;
  failingDep = findFailingDependency('adapter', phaseStatuses);
  if (failingDep) {
    log(`[Phase 3] SKIPPED — upstream dep "${failingDep}" failed`);
    adapterResult = emptyAdapterPhase(`Phase ${failingDep} failed`);
  } else {
    try {
      adapterResult = await probeAdapter(canonical, platformResult);
    } catch (e: any) {
      errors.push({ phase: 'adapter', message: e.message, stack: e.stack?.slice(0, 500) });
      adapterResult = emptyAdapterPhase();
    }
    finalizePhaseStatus('adapter', adapterResult);
  }
  phaseStatuses.adapter = adapterResult.status;

  // Phase 4: Catalog (deps: platform)
  let catalogResult: CatalogPhase;
  failingDep = findFailingDependency('catalog', phaseStatuses);
  if (failingDep) {
    log(`[Phase 4] SKIPPED — upstream dep "${failingDep}" failed`);
    catalogResult = emptyCatalogPhase(`Phase ${failingDep} failed`);
  } else {
    try {
      catalogResult = await probeCatalog(canonical, platformResult);
    } catch (e: any) {
      errors.push({ phase: 'catalog', message: e.message, stack: e.stack?.slice(0, 500) });
      catalogResult = emptyCatalogPhase();
    }
    finalizePhaseStatus('catalog', catalogResult);
  }
  phaseStatuses.catalog = catalogResult.status;

  // Phase 5: Sort (deps: access, platform)
  let sortResult: SortPhase;
  failingDep = findFailingDependency('sort', phaseStatuses);
  if (failingDep) {
    log(`[Phase 5] SKIPPED — upstream dep "${failingDep}" failed`);
    sortResult = emptySortPhase(`Phase ${failingDep} failed`);
  } else {
    try {
      sortResult = await probeSort(canonical, platformResult, catalogResult, adapterResult);
    } catch (e: any) {
      errors.push({ phase: 'sort', message: e.message, stack: e.stack?.slice(0, 500) });
      sortResult = emptySortPhase();
    }
    finalizePhaseStatus('sort', sortResult);
  }
  phaseStatuses.sort = sortResult.status;

  // Phase 6: Pagination (deps: access, platform)
  let paginationResult: PaginationPhase;
  failingDep = findFailingDependency('pagination', phaseStatuses);
  if (failingDep) {
    log(`[Phase 6] SKIPPED — upstream dep "${failingDep}" failed`);
    paginationResult = emptyPaginationPhase(`Phase ${failingDep} failed`);
  } else {
    try {
      paginationResult = await probePagination(canonical, catalogResult, platformResult, adapterResult);
    } catch (e: any) {
      errors.push({ phase: 'pagination', message: e.message, stack: e.stack?.slice(0, 500) });
      paginationResult = emptyPaginationPhase();
    }
    finalizePhaseStatus('pagination', paginationResult);
  }
  phaseStatuses.pagination = paginationResult.status;

  // Phase 7: Assembly (deps: ALL — but tolerates skipped/failed deps;
  // assembly is pure aggregation, never gets skipped itself)
  const assemblyResult = assemble(errors, accessResult, platformResult, adapterResult, catalogResult, sortResult, paginationResult);

  const report: ProbeReport = {
    url,
    canonicalUrl: (accessResult.canonicalUrl.value as string) || url,
    probedAt: new Date().toISOString(),
    phases: {
      access: accessResult,
      platform: platformResult,
      adapter: adapterResult,
      catalog: catalogResult,
      sort: sortResult,
      pagination: paginationResult,
      assembly: assemblyResult,
    },
    errors,
    duration: Date.now() - startTime,
  };

  log('\n' + '='.repeat(60));
  log(`Probe complete in ${report.duration}ms — ${assemblyResult.overallConfidence} confidence`);
  log(`  Completed: ${assemblyResult.completedPhases.join(', ') || 'none'}`);
  log(`  Failed: ${assemblyResult.failedPhases.join(', ') || 'none'}`);
  log(`  Skipped: ${assemblyResult.skippedPhases.join(', ') || 'none'}`);
  if (assemblyResult.warnings.length > 0) {
    log('  Warnings:');
    for (const w of assemblyResult.warnings) log(`    - ${w}`);
  }

  // Output JSON to stdout
  console.log(JSON.stringify(report, null, 2));

  // Close Playwright browser if we spun one up. No-op when probe never used
  // the Playwright fallback. Without this, node hangs on exit.
  await closePlaywrightIfNeeded();
}

// Test-only exports — let regression harnesses import the retry helpers and
// fetch primitives without spawning the full probe. Gated by `require.main`
// check below so this is a no-op when run directly via `npx tsx`.
export { safeFetch, safeFetchJson, safeFetchOnce, safeFetchJsonOnce, retryOnce, classifyRetry, RETRY_DELAY_MS, PHASE_DEPENDENCIES, isPhaseCompleted, findFailingDependency, finalizePhaseStatus };

if (require.main === module) {
  main().catch(async e => {
    console.error('Fatal error:', e);
    await closePlaywrightIfNeeded().catch(() => {});
    process.exit(1);
  }).finally(() => {
    // Redis keepalive inside playwright-fetcher's require-chain can prevent
    // process exit. Force it after a short grace period.
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
