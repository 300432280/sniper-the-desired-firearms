/**
 * probe-fetch.ts — Module 1 of the decomposed pre-bootstrap probe.
 *
 * Single responsibility: one hardened network primitive that all other probe
 * modules depend on. Handles the full stack:
 *
 *   axios (with raised maxHeaderSize)
 *     └─ on HPE parse error → native-fetch via undici (raised maxHeaderSize)
 *         └─ on WAF challenge body (or --mode playwright) → fetchWithPlaywright
 *
 * Plus:
 *   - Single retry on transient failures (5xx, empty 2xx, network errors).
 *     Matches Mistake 6 / M1 from Wave 1.
 *   - Three user-agent modes: desktop (default), iphone, custom:<string>.
 *     Required for sites where UA class gates WAF cookie delivery (Mistake 30
 *     Fix B — SiteGround/Sucuri/Cloudflare serve different cookie sets per UA).
 *   - Structured error envelope: every attempt's message + classification is
 *     preserved in the output (`errors[]`), even when a later escalation
 *     succeeds. Callers can audit the path taken.
 *   - `escalations[]` timeline records every fallback fired so higher-level
 *     modules (probe-access, probe-platform) can cross-reference why the
 *     fetch took the path it did.
 *
 * CLI:
 *   npx tsx scripts/probe-modules/probe-fetch.ts <url>
 *     [--ua desktop|iphone|custom:<string>]
 *     [--mode static|playwright|auto]
 *     [--accept json|html]
 *     [--timeout <ms>]
 *
 * Output: JSON to stdout. Progress to stderr. Exit 0 on module success
 * (even if fetch failed — the result envelope carries `status:null`), non-zero
 * only on bad CLI args / module crash.
 *
 * Does NOT do: HTML parsing (callers use cheerio), platform detection,
 * product extraction, WAF verdict. Those are separate modules. This module
 * only delivers an HTTP response (or a structured failure).
 *
 * Salvage: pieces of this module are derived from the 2,751-line monolith
 * `pre-bootstrap-probe.ts`:
 *   - lines 26-31: BIG_HEADER_HTTP_AGENT / BIG_HEADER_HTTPS_AGENT / BIG_HEADER_UNDICI
 *   - lines 73-86: isWafChallengeBody (challenge-body heuristic)
 *   - lines 289-290: DESKTOP_UA / IPHONE_UA constants
 *   - lines 471-473: RETRYABLE_NET_ERR_RE
 *   - lines 534-653: axios → native-fetch → playwright orchestration shape
 *   - lines 481-517: classifyRetry (retry-once classifier)
 *
 * But this module is a clean redesign, not a copy — it owns a narrower
 * responsibility (single URL, single module) and has a stable public shape.
 */

import axios from 'axios';
import * as http from 'http';
import * as https from 'https';
import { Agent as UndiciAgent } from 'undici';

// ── Constants ────────────────────────────────────────────────────────────────

/** Desktop Chrome on Windows — baseline UA for most fleet sites. */
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * iPhone Safari — required for sites where desktop UA is WAF-blocked post-solve.
 * SiteGround sgcaptcha, Sucuri, Cloudflare-active serve different cookie sets
 * per UA class; desktop gets a 1-cookie reply that 403s, iPhone gets 10 cookies
 * that replay cleanly (Mistake 30 Fix B).
 */
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';

/**
 * Raised maxHeaderSize (128KB, 8x Node default). Drupal emits
 * `x-drupal-cache-tags` headers that exceed 16KB → Node's default parser trips
 * HPE_HEADER_OVERFLOW + undici trips UND_ERR_HEADERS_OVERFLOW, producing false
 * "site unreachable" signals. The old monolith learned this on gunpost.ca.
 */
const BIG_HEADER_HTTP_AGENT = new http.Agent({ keepAlive: true, maxHeaderSize: 131072 } as any);
const BIG_HEADER_HTTPS_AGENT = new https.Agent({ keepAlive: true, maxHeaderSize: 131072 } as any);
const BIG_HEADER_UNDICI = new UndiciAgent({
  maxResponseSize: -1,
  headersTimeout: 20000,
  bodyTimeout: 20000,
  connect: { timeout: 20000 },
  maxHeaderSize: 131072,
} as any);

/**
 * Retry on transient network errors (Mistake 6 — durhamoutdoors.ca intermittent
 * ECONNRESET). Matches the monolith's `RETRYABLE_NET_ERR_RE`.
 */
const RETRYABLE_NET_ERR_RE =
  /econnreset|etimedout|enotfound|socket hang up|epipe|eai_again|network|fetch failed|aborterror|abort/i;

const DEFAULT_TIMEOUT_MS = 20000;
const RETRY_DELAY_MS = 2000;
const BODY_SAMPLE_BYTES = 8 * 1024;

// ── Types ────────────────────────────────────────────────────────────────────

export type UaMode = 'desktop' | 'iphone' | `custom:${string}`;
export type FetchMode = 'static' | 'playwright' | 'auto';
export type AcceptMode = 'html' | 'json';

export type EscalationReason =
  | 'native-fetch-malformed-header'
  | 'playwright-waf'
  | 'playwright-spa';

export type ErrorClassification = 'retryable' | 'fatal' | 'fallback-trigger';

export interface FetchOpts {
  ua?: UaMode;
  mode?: FetchMode;
  accept?: AcceptMode;
  timeoutMs?: number;
  /**
   * Hint from a higher-level caller (e.g. probe-access) that a JS-challenge WAF
   * has been confirmed for this domain. When set, small suspect bodies are
   * escalated to Playwright even without an authoritative vendor signature.
   * Default false — module is safe to call without any prior knowledge.
   */
  wafSuspected?: boolean;
  /**
   * Return the full response body in `bodySample` instead of the default 8KB
   * truncation. Required by probe-platform (marker scanning needs the whole
   * HTML — WooCommerce/Ecwid/platform script tags routinely live beyond 8KB
   * on modern theme-heavy homepages, e.g. canadafirstammo.ca's 465KB body).
   * Default false — module 1's default output is still capped for efficiency.
   */
  fullBody?: boolean;
}

export interface FetchError {
  attempt: number;
  message: string;
  classification: ErrorClassification;
}

export interface ProbeFetchResult {
  url: string;
  requestedUrl: string;
  status: number | null;
  headers: Record<string, string>;
  bodySample: string;
  bodyBytes: number;
  method: 'axios' | 'native-fetch' | 'playwright' | null;
  ua: string;
  wall_ms: number;
  retries: number;
  escalations: EscalationReason[];
  errors: FetchError[];
}

// ── UA resolution ────────────────────────────────────────────────────────────

export function resolveUa(mode: UaMode | undefined): string {
  if (!mode || mode === 'desktop') return DESKTOP_UA;
  if (mode === 'iphone') return IPHONE_UA;
  if (mode.startsWith('custom:')) {
    const custom = mode.slice('custom:'.length);
    if (custom.length === 0) return DESKTOP_UA;
    return custom;
  }
  return DESKTOP_UA;
}

// ── WAF challenge body heuristic ──────────────────────────────────────────────

/**
 * Authoritative vendor-signature check. Returns true ONLY when the body
 * contains an explicit WAF challenge fingerprint. No size-gating here — this
 * is called when we haven't yet decided whether the site has WAF.
 */
function hasAuthoritativeWafSignature(body: string): boolean {
  if (!body) return false;
  // Sucuri / CloudProxy
  if (/sucuri_cloudproxy_js|Access Denied - Sucuri/.test(body)) return true;
  // Incapsula / Imperva
  if (/_Incapsula_Resource|Incapsula incident|Imperva/i.test(body)) return true;
  // SiteGround sgcaptcha
  if (/sg-?captcha|\.well-known\/sgcaptcha/i.test(body)) return true;
  // Cloudflare active challenge family
  if (
    /cf-browser-verification|cf-challenge|_cf_chl|cdn-cgi\/challenge-platform|Just a moment\.\.\.|Checking your browser|Verifying you are human|Attention Required!/i.test(
      body,
    )
  )
    return true;
  return false;
}

/**
 * Secondary heuristic (only fired when caller opts in via `wafSuspected`).
 * Catches challenge body with rotated vendor strings — small body with
 * cookie/reload JS, or a tiny 307/403/503 response.
 */
function isSuspectedWafBody(body: string, status: number): boolean {
  if (!body) return false;
  if (body.length < 5000 && /<script[\s\S]*?(location\.reload|document\.cookie|eval\()/i.test(body))
    return true;
  if ((status === 307 || status === 403 || status === 503) && body.length < 3000) return true;
  return false;
}

// ── Classifier for retry / fallback decisions ─────────────────────────────────

function classifyError(errMsg: string | null): ErrorClassification {
  if (!errMsg) return 'fatal';
  const lowered = errMsg.toLowerCase();
  if (
    lowered.includes('parse error') ||
    lowered.includes('hpe_invalid') ||
    lowered.includes('invalid header')
  ) {
    return 'fallback-trigger'; // → native-fetch
  }
  if (RETRYABLE_NET_ERR_RE.test(errMsg)) return 'retryable';
  return 'fatal';
}

function classifyResult(
  status: number,
  bodyLen: number,
  isJson: boolean,
  data: any,
): 'retryable' | 'ok' {
  // 5xx → retry
  if (status >= 500 && status < 600) return 'retryable';
  // Empty body on a 2xx → retry (CDN truncation, partial response)
  if (status >= 200 && status < 300) {
    if (isJson) {
      if (data === null || data === undefined) return 'retryable';
    } else if (bodyLen === 0) {
      return 'retryable';
    }
  }
  return 'ok';
}

// ── Low-level fetchers ────────────────────────────────────────────────────────

interface RawFetch {
  status: number;
  headers: Record<string, string>;
  data: string;
  finalUrl: string;
}

function normalizeHeaders(h: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  // Axios headers are plain objects; undici uses Headers — handle both.
  if (typeof h.entries === 'function') {
    for (const [k, v] of h.entries()) out[String(k).toLowerCase()] = String(v);
    return out;
  }
  for (const [k, v] of Object.entries(h)) {
    out[String(k).toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

async function axiosFetchOnce(
  url: string,
  ua: string,
  accept: AcceptMode,
  timeoutMs: number,
): Promise<{ raw: RawFetch | null; errMsg: string | null }> {
  const headers: Record<string, string> = {
    'User-Agent': ua,
    Accept:
      accept === 'json'
        ? 'application/json,*/*;q=0.8'
        : 'text/html,application/xhtml+xml,*/*;q=0.8',
    'Accept-Language': 'en-CA,en;q=0.9',
  };

  try {
    const resp = await axios.get(url, {
      timeout: timeoutMs,
      maxRedirects: 10,
      validateStatus: () => true,
      responseType: 'text',
      httpAgent: BIG_HEADER_HTTP_AGENT,
      httpsAgent: BIG_HEADER_HTTPS_AGENT,
      headers,
    });
    const body = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
    // axios attaches request._redirectable info; final URL available at
    // resp.request?.res?.responseUrl for redirect-followed responses.
    const finalUrl: string =
      (resp as any).request?.res?.responseUrl ||
      (resp as any).request?.responseURL ||
      url;
    return {
      raw: {
        status: resp.status,
        headers: normalizeHeaders(resp.headers),
        data: body,
        finalUrl,
      },
      errMsg: null,
    };
  } catch (e: any) {
    return { raw: null, errMsg: e?.message || String(e) };
  }
}

async function nativeFetchOnce(
  url: string,
  ua: string,
  accept: AcceptMode,
  timeoutMs: number,
  useBigHeaderDispatcher: boolean,
): Promise<{ raw: RawFetch | null; errMsg: string | null }> {
  const headers: Record<string, string> = {
    'User-Agent': ua,
    Accept:
      accept === 'json'
        ? 'application/json,*/*;q=0.8'
        : 'text/html,application/xhtml+xml,*/*;q=0.8',
    'Accept-Language': 'en-CA,en;q=0.9',
  };
  // NOTE on dispatcher selection:
  //   - Default (no dispatcher): lenient header-parsing — accepts trailing-space
  //     and other malformed-but-recoverable headers that Node's HTTP parser AND
  //     a custom undici Agent BOTH reject (e.g. Celerant ColdFusion sends
  //     `X-Frame-Options : SAMEORIGIN`). This is what production
  //     `http-client.ts:nativeFetchFallback` uses.
  //   - Big-header dispatcher: needed only when response headers exceed Node's
  //     default 16KB (e.g. some Drupal sites emit 16KB+ x-drupal-cache-tags
  //     headers that trip UND_ERR_HEADERS_OVERFLOW). Caller passes
  //     `useBigHeaderDispatcher=true` as a second-attempt only.
  const fetchOpts: any = {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (useBigHeaderDispatcher) fetchOpts.dispatcher = BIG_HEADER_UNDICI;
  try {
    const resp = await fetch(url, fetchOpts);
    const body = await resp.text();
    return {
      raw: {
        status: resp.status,
        headers: normalizeHeaders(resp.headers),
        data: body,
        finalUrl: resp.url || url,
      },
      errMsg: null,
    };
  } catch (e: any) {
    // undici exposes the underlying cause for header-overflow / invalid-header
    // errors on e.cause.message — surface that so the caller can detect
    // header-overflow and retry with the big-header dispatcher.
    const msg = e?.message || String(e);
    const cause = e?.cause?.message || '';
    const combined = cause ? `${msg} (cause: ${cause})` : msg;
    return { raw: null, errMsg: combined };
  }
}

function isHeaderOverflow(errMsg: string | null): boolean {
  if (!errMsg) return false;
  return /headers_overflow|hpe_header_overflow|headers size|header size|HeadersOverflow/i.test(
    errMsg,
  );
}

let g_playwrightEverUsed = false;

async function playwrightFetchOnce(
  url: string,
  timeoutMs: number,
): Promise<{ raw: RawFetch | null; errMsg: string | null }> {
  try {
    // Lazy import so non-Playwright code paths never pay the browser spawn cost.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { fetchWithPlaywright } = await import('../../src/services/scraper/playwright-fetcher');
    const { html } = await fetchWithPlaywright(url, { timeout: Math.max(timeoutMs, 45000) });
    g_playwrightEverUsed = true;
    return {
      raw: {
        status: 200,
        headers: {}, // Playwright wrapper does not expose response headers
        data: html,
        finalUrl: url, // Playwright returns final rendered URL via page; wrapper does not expose — use input
      },
      errMsg: null,
    };
  } catch (e: any) {
    return { raw: null, errMsg: e?.message || String(e) };
  }
}

/**
 * Close the shared Playwright browser if it was ever spawned. Safe to call
 * regardless of whether Playwright was used.
 */
export async function closePlaywrightIfUsed(): Promise<void> {
  if (!g_playwrightEverUsed) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { closeBrowser } = await import('../../src/services/scraper/playwright-fetcher');
    await closeBrowser();
  } catch {
    // process exit will clean up
  }
}

// ── Main public API ──────────────────────────────────────────────────────────

const log = (msg: string) => process.stderr.write(msg + '\n');

/**
 * Single URL fetch with retry + escalations. The workhorse of every other
 * probe module.
 */
export async function fetchForProbe(
  url: string,
  opts: FetchOpts = {},
): Promise<ProbeFetchResult> {
  const start = Date.now();
  const mode: FetchMode = opts.mode ?? 'auto';
  const accept: AcceptMode = opts.accept ?? 'html';
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ua = resolveUa(opts.ua);

  const errors: FetchError[] = [];
  const escalations: EscalationReason[] = [];
  let retries = 0;
  let method: 'axios' | 'native-fetch' | 'playwright' | null = null;
  let finalRaw: RawFetch | null = null;

  // ── Mode: playwright (skip axios entirely) ─────────────────────────────────
  if (mode === 'playwright') {
    escalations.push('playwright-spa');
    const pw = await playwrightFetchOnce(url, timeoutMs);
    if (pw.raw) {
      finalRaw = pw.raw;
      method = 'playwright';
    } else if (pw.errMsg) {
      errors.push({ attempt: 1, message: pw.errMsg, classification: 'fatal' });
    }
    // NOTE: must forward `opts.fullBody` — otherwise mode='playwright' callers
    // (e.g. probe-extraction walking an SPA) receive an 8KB-truncated bodySample
    // and extraction returns 0 products. The `mode='auto'` + static paths
    // correctly forward `fullBody` via the end-of-function buildResult call;
    // this early-return branch was the only one missing it.
    return buildResult(
      url,
      finalRaw,
      method,
      ua,
      start,
      retries,
      escalations,
      errors,
      opts.fullBody === true,
    );
  }

  // ── Mode: static or auto ───────────────────────────────────────────────────
  // Attempt 1: axios
  let attempt = 1;
  let ax = await axiosFetchOnce(url, ua, accept, timeoutMs);

  // HPE → native-fetch fallback (this counts as an escalation, not a retry)
  if (!ax.raw && ax.errMsg) {
    const cls = classifyError(ax.errMsg);
    errors.push({ attempt, message: ax.errMsg, classification: cls });
    if (cls === 'fallback-trigger') {
      log(`[probe-fetch] HPE malformed header, escalating to native-fetch: ${url}`);
      escalations.push('native-fetch-malformed-header');
      // Two-step native-fetch: lenient default first, big-header dispatcher
      // only if the first fails with header-overflow. This lets us handle
      // BOTH Celerant-style trailing-space headers (lenient) AND Drupal-style
      // 16KB+ cache-tags (big-header) without making one break the other.
      let nf = await nativeFetchOnce(url, ua, accept, timeoutMs, /*big*/ false);
      attempt++;
      if (!nf.raw && isHeaderOverflow(nf.errMsg)) {
        errors.push({ attempt, message: nf.errMsg!, classification: 'fallback-trigger' });
        log(`[probe-fetch] native-fetch header overflow, retrying with big-header dispatcher: ${url}`);
        nf = await nativeFetchOnce(url, ua, accept, timeoutMs, /*big*/ true);
        attempt++;
      }
      if (nf.raw) {
        finalRaw = nf.raw;
        method = 'native-fetch';
      } else if (nf.errMsg) {
        errors.push({ attempt, message: nf.errMsg, classification: classifyError(nf.errMsg) });
      }
    } else if (cls === 'retryable') {
      // Retry once with axios
      await delay(RETRY_DELAY_MS);
      retries++;
      attempt++;
      log(`[probe-fetch] retry 1/1 after transient error: ${url}`);
      ax = await axiosFetchOnce(url, ua, accept, timeoutMs);
      if (!ax.raw && ax.errMsg) {
        const cls2 = classifyError(ax.errMsg);
        errors.push({ attempt, message: ax.errMsg, classification: cls2 });
        if (cls2 === 'fallback-trigger') {
          escalations.push('native-fetch-malformed-header');
          let nf = await nativeFetchOnce(url, ua, accept, timeoutMs, /*big*/ false);
          attempt++;
          if (!nf.raw && isHeaderOverflow(nf.errMsg)) {
            errors.push({ attempt, message: nf.errMsg!, classification: 'fallback-trigger' });
            nf = await nativeFetchOnce(url, ua, accept, timeoutMs, /*big*/ true);
            attempt++;
          }
          if (nf.raw) {
            finalRaw = nf.raw;
            method = 'native-fetch';
          } else if (nf.errMsg) {
            errors.push({ attempt, message: nf.errMsg, classification: classifyError(nf.errMsg) });
          }
        }
      } else if (ax.raw) {
        finalRaw = ax.raw;
        method = 'axios';
      }
    }
  } else if (ax.raw) {
    finalRaw = ax.raw;
    method = 'axios';
  }

  // Classify the result body — retry once on 5xx/empty-2xx if we haven't yet.
  if (finalRaw && retries === 0) {
    const isJson = accept === 'json';
    const bodyLen = finalRaw.data?.length ?? 0;
    const verdict = classifyResult(finalRaw.status, bodyLen, isJson, finalRaw.data);
    if (verdict === 'retryable') {
      errors.push({
        attempt,
        message: `${finalRaw.status} ${bodyLen === 0 ? 'empty body' : 'server error'}`,
        classification: 'retryable',
      });
      await delay(RETRY_DELAY_MS);
      retries++;
      attempt++;
      log(`[probe-fetch] retry 1/1 after ${finalRaw.status}/${bodyLen}b body: ${url}`);
      // Retry on the same transport that just gave us a bad response.
      if (method === 'axios') {
        const ax2 = await axiosFetchOnce(url, ua, accept, timeoutMs);
        if (ax2.raw) {
          finalRaw = ax2.raw;
        } else if (ax2.errMsg) {
          errors.push({ attempt, message: ax2.errMsg, classification: classifyError(ax2.errMsg) });
          finalRaw = null;
          method = null;
        }
      } else if (method === 'native-fetch') {
        const nf2 = await nativeFetchOnce(url, ua, accept, timeoutMs, /*big*/ false);
        if (nf2.raw) {
          finalRaw = nf2.raw;
        } else if (nf2.errMsg) {
          errors.push({ attempt, message: nf2.errMsg, classification: classifyError(nf2.errMsg) });
          finalRaw = null;
          method = null;
        }
      }
    }
  }

  // ── WAF challenge body escalation (mode=auto only; JSON callers opt out) ───
  // JSON APIs behind a WAF can't be unblocked via Playwright (Playwright
  // renders HTML, not JSON). Callers who want JSON must handle WAF at a
  // different layer (e.g. waf-cookie-manager runtime replay). We gate
  // Playwright escalation on accept=html.
  if (mode === 'auto' && accept === 'html' && finalRaw) {
    const body = finalRaw.data || '';
    const isAuthoritative = hasAuthoritativeWafSignature(body);
    const isSuspected = opts.wafSuspected === true && isSuspectedWafBody(body, finalRaw.status);
    if (isAuthoritative || isSuspected) {
      log(
        `[probe-fetch] WAF body detected (${isAuthoritative ? 'authoritative' : 'suspected'}), escalating to Playwright: ${url}`,
      );
      escalations.push('playwright-waf');
      const pw = await playwrightFetchOnce(url, timeoutMs);
      attempt++;
      if (pw.raw) {
        finalRaw = pw.raw;
        method = 'playwright';
      } else if (pw.errMsg) {
        errors.push({ attempt, message: pw.errMsg, classification: 'fatal' });
      }
    }
  }

  return buildResult(url, finalRaw, method, ua, start, retries, escalations, errors, opts.fullBody === true);
}

function buildResult(
  requestedUrl: string,
  raw: RawFetch | null,
  method: 'axios' | 'native-fetch' | 'playwright' | null,
  ua: string,
  start: number,
  retries: number,
  escalations: EscalationReason[],
  errors: FetchError[],
  fullBody: boolean,
): ProbeFetchResult {
  const wall_ms = Date.now() - start;
  if (!raw) {
    return {
      url: requestedUrl,
      requestedUrl,
      status: null,
      headers: {},
      bodySample: '',
      bodyBytes: 0,
      method: null,
      ua,
      wall_ms,
      retries,
      escalations,
      errors,
    };
  }
  const body = raw.data || '';
  const bodyBytes = Buffer.byteLength(body, 'utf8');
  const bodySample = fullBody
    ? body
    : body.length > BODY_SAMPLE_BYTES
      ? body.slice(0, BODY_SAMPLE_BYTES)
      : body;
  return {
    url: raw.finalUrl || requestedUrl,
    requestedUrl,
    status: raw.status,
    headers: raw.headers,
    bodySample,
    bodyBytes,
    method,
    ua,
    wall_ms,
    retries,
    escalations,
    errors,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { url: string; opts: FetchOpts } | null {
  const positional: string[] = [];
  const opts: FetchOpts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ua') {
      const v = argv[++i];
      if (v === 'desktop' || v === 'iphone') opts.ua = v;
      else if (v?.startsWith('custom:')) opts.ua = v as UaMode;
      else return null;
    } else if (a === '--mode') {
      const v = argv[++i];
      if (v === 'static' || v === 'playwright' || v === 'auto') opts.mode = v;
      else return null;
    } else if (a === '--accept') {
      const v = argv[++i];
      if (v === 'html' || v === 'json') opts.accept = v;
      else return null;
    } else if (a === '--timeout') {
      const v = argv[++i];
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return null;
      opts.timeoutMs = n;
    } else if (a === '--waf-suspected') {
      opts.wafSuspected = true;
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
      'usage: probe-fetch.ts <url> [--ua desktop|iphone|custom:<string>] [--mode static|playwright|auto] [--accept html|json] [--timeout <ms>] [--waf-suspected]\n',
    );
    return 2;
  }
  const result = await fetchForProbe(parsed.url, parsed.opts);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  await closePlaywrightIfUsed();
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((e) => {
      process.stderr.write(`probe-fetch crashed: ${e?.stack || e?.message || e}\n`);
      process.exit(1);
    });
}
