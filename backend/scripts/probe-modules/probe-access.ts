/**
 * probe-access.ts — Module 3 of the decomposed pre-bootstrap probe.
 *
 * Single responsibility: given an input URL, produce a WAF + UA + canonical-origin
 * evidence envelope. Does NOT detect platform (that's probe-platform — WAF vs
 * platform are orthogonal). Does NOT decide adapterType (that's skill). Does
 * NOT solve WAF challenges (probe-fetch handles Playwright escalation
 * internally for HTML; this module only detects). Does NOT probe anything
 * beyond homepage + robots.txt (one URL → one access verdict).
 *
 * Pipeline:
 *   1. Resolve canonical origin — redirect follow via fetchForProbe, capture
 *      final URL. Apex → www redirects are common and load-bearing for WAF
 *      detection (site 24 reliablegun.com lesson — apex on one stack, www
 *      behind CDN).
 *   2. Fetch robots.txt — record accessibility, Sitemap: lines, Crawl-delay.
 *   3. Run heavy-waf-probe.sh as subprocess (240s timeout — BATCH 3 rapid
 *      burst can take up to 200s on slow backends; 120s was too tight and
 *      produced truncated output that caused false-negative sgcaptcha
 *      verdicts). Parse BATCH 1 header lines ONLY (Mistake 36 — naive
 *      whole-output regex matches INTERPRETATION GUIDE trailer text).
 *   4. Run UA sweep — 5 UAs (desktop, iphone, curl, bot, no-UA) in parallel
 *      via fetchForProbe. Capture status + bodyBytes + sample + cfRay +
 *      sgCaptcha per UA.
 *   5. Interpret heavy probe → initial verdict (hasWaf, wafType, confidence).
 *   5b. Apply UA-sweep overrides: if a UA received `sg-captcha: challenge`
 *      response header, force wafType='sgcaptcha' regardless of heavy-probe
 *      verdict (happens when the heavy probe truncates mid-BATCH). Same
 *      escalation for cf-ray → cloudflare-passive/active.
 *   6. Select recommended UA: (a) live evidence first (selectRecommendedUa),
 *      (b) fleet-rule override (WAF_REQUIRES_IPHONE) when wafType is a JS-
 *      challenge family and desktop didn't prove it works (Mistake 30 Fix B).
 *   7. Decide playwrightRequired: true iff ALL static UAs appear blocked AND
 *      a Playwright fetch returned substantial content.
 *
 * Salvage: derived from pre-bootstrap-probe.ts probeAccess (lines 740-1040).
 * Key pieces preserved: BATCH 1 header-line-only parser, WAF vendor priority
 * (Cloudflare first, then Sucuri, then Incapsula, then sgcaptcha), cookie
 * marker extraction, UA-class decision tree. This module is a clean rewrite
 * of the OUTPUT SHAPE — the monolith emitted ad-hoc wafProbeEvidence + a
 * flat userAgentResults array; this module emits a structured envelope with
 * an explicit evidence section and pure-function outputs that the skill can
 * cross-check.
 *
 * CLI:
 *   npx tsx scripts/probe-modules/probe-access.ts <url>
 *     [--ua-probe-timeout <ms>]
 *     [--skip-heavy-probe]
 *
 * Output: JSON to stdout. Progress to stderr.
 * Exit: 0 on module success (even if WAF not determined); 2 on bad args;
 *       1 on module crash.
 */

import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { fetchForProbe, closePlaywrightIfUsed, resolveUa, ProbeFetchResult } from './probe-fetch';

const execFileAsync = promisify(execFile);

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Heavy probe timeout. 240s (not 120s) because BATCH 3 rapid-burst can hit
 * curl's own 20s timeout per request — 10 bursts × 20s worst case = 200s for
 * BATCH 3 alone. When the script is SIGTERM'd mid-batch, downstream parsers
 * can miss authoritative signals (e.g. `sg-captcha` in BATCH 1) if the
 * truncation lands at an unlucky offset. 240s safely covers worst-case
 * backend slowness without waiting indefinitely.
 */
const HEAVY_PROBE_TIMEOUT_MS = 240_000;
const UA_PROBE_TIMEOUT_MS_DEFAULT = 20_000;
const PLAYWRIGHT_CONFIRM_TIMEOUT_MS = 60_000;
const BODY_REAL_CONTENT_THRESHOLD = 8_000; // bytes
const BODY_CHALLENGE_THRESHOLD = 2_000; // bytes

/**
 * JS-challenge WAF types that fleet experience (doctordeals.ca, thegundealer.ca,
 * gagnonsports.com) proves require an iPhone UA for post-solve axios replays —
 * SiteGround sgcaptcha / Sucuri / Cloudflare active / Incapsula all serve
 * different cookie sets per UA class (Mistake 30 Fix B).
 *
 * Pre-solve every UA sees the same challenge body, so the UA sweep alone
 * cannot pick iPhone. This mapping applies the fleet rule based on wafType.
 */
const WAF_REQUIRES_IPHONE: ReadonlySet<WafType> = new Set<WafType>([
  'sucuri',
  'cloudflare-active',
  'incapsula',
  'sgcaptcha',
]);

/**
 * Challenge-body signatures. If a UA's body matches ANY of these, that UA's
 * attempt is "challenged" regardless of status code. Covers Sucuri,
 * Incapsula/Imperva, SiteGround sgcaptcha, Cloudflare active family.
 *
 * NOTE: keep this in sync with probe-fetch.ts `hasAuthoritativeWafSignature`.
 * Duplicating rather than importing because Module 1's function is private —
 * and diverging one side from the other would be a Mistake 2 risk (two
 * "authoritative" definitions of WAF). We accept duplication here and mark
 * the invariant with a comment.
 */
const CHALLENGE_MARKER_RE =
  /sucuri_cloudproxy_js|Access Denied - Sucuri|_Incapsula_Resource|Incapsula incident|Imperva|sg-?captcha|\.well-known\/sgcaptcha|cf-browser-verification|cf-challenge|_cf_chl|cdn-cgi\/challenge-platform|Just a moment\.\.\.|Checking your browser|Verifying you are human|Attention Required!/i;

/**
 * Real-content markers. Generic cross-platform catalog indicators. One of these
 * appearing in a >8KB body = UA returns real content (not a challenge shell).
 *
 * Intentionally broad: product cards, nav links, platform CSS classes, cart
 * widgets, JS bundle markers. Matches extractFirstProducts SELECTORS shape.
 */
const REAL_HTML_MARKER_RE =
  /data-product-id=|class="product|class="woocommerce|class="listing|product-card|product-item|product-tile|cdn\.shopify\.com|wp-content\/plugins\/woocommerce|add-to-cart|cdn11\.bigcommerce\.com|BCData|Stencil\.storefrontAPIToken|Magento_|requirejs-config|shoplightspeed|app\.ecwid\.com\/script\.js|mysimplestore|data-aid="PRODUCT_LIST_RENDERED"|oe_website_sale|thunderbolt|wixBiSession|wc-ajax|ec-store|class="ec-|celerantwebservices|\/webscr\?|kuResultsListing|hikashop_product|node--type-classified/i;

// ── Types ────────────────────────────────────────────────────────────────────

export type WafType =
  | 'cloudflare-active'
  | 'cloudflare-passive'
  | 'sucuri'
  | 'incapsula'
  | 'sgcaptcha'
  | 'malcare'
  | 'rule-selective'
  | 'rate-limit'
  | 'path-selective'
  | null;

export type WafConfidence = 'high' | 'medium' | 'low' | 'none';

export interface UAResult {
  status: number | null;
  bodyBytes: number;
  sampleBody: string;
  method: string;
  cfRay: string | null;
  sgCaptcha: boolean;
  looksLikeChallenge: boolean;
  looksLikeRealContent: boolean;
}

export interface UASweep {
  desktop: UAResult;
  iphone: UAResult;
  curl: UAResult;
  bot: UAResult;
  noUa: UAResult;
}

export interface WafEvidenceCookies {
  cfid: boolean; // ColdFusion CFID
  cftoken: boolean; // ColdFusion CFTOKEN
  cfBm: boolean; // Cloudflare __cf_bm
  cfClearance: boolean; // Cloudflare cf_clearance
  sucuri: boolean; // sucuri_cloudproxy_*
  incapsula: boolean; // incap_ses_* / visid_incap_* / nlbi_
  aspNetSession: boolean; // ASP.NET_SessionId
}

export interface WafEvidence {
  headerServers: string[];
  setCookieMarkers: WafEvidenceCookies;
  honeypotBlocked: boolean;
  sqliBlocked: boolean;
  xssBlocked: boolean;
  rateLimitObserved: boolean;
  uaFilterObserved: boolean;
  heavyProbeRawOutput: string;
}

export interface ProbeAccessResult {
  inputUrl: string;
  canonicalOrigin: string;
  apexRedirects: boolean;
  robotsTxt: {
    accessible: boolean;
    sitemapLines: string[];
    crawlDelay: number | null;
  };
  uaSweep: UASweep;
  recommendedUa: 'desktop' | 'iphone';
  uaOverrideReason: string | null;
  hasWaf: boolean | null;
  wafType: WafType;
  wafConfidence: WafConfidence;
  wafEvidence: WafEvidence;
  playwrightRequired: boolean;
  warnings: string[];
}

// ── Pure functions (exported for testing) ────────────────────────────────────

/**
 * Generic product-HTML / real-content detection + challenge detection.
 * Used by the UA-sweep analyzer.
 */
export function classifyBody(
  body: string,
  status: number | null,
): { looksLikeChallenge: boolean; looksLikeRealContent: boolean } {
  const len = body?.length || 0;
  const hasMarker = body && CHALLENGE_MARKER_RE.test(body);
  const tinySuspicious =
    len > 0 &&
    len < BODY_CHALLENGE_THRESHOLD &&
    (status === 307 || status === 403 || status === 503);
  const metaRefresh =
    len > 0 &&
    len < BODY_CHALLENGE_THRESHOLD &&
    /<meta[^>]*refresh[^>]*0[^>]*["';][^>]*(captcha|challenge|verify)/i.test(body);
  const looksLikeChallenge = Boolean(hasMarker || tinySuspicious || metaRefresh);
  const looksLikeRealContent = Boolean(
    body && len > BODY_REAL_CONTENT_THRESHOLD && REAL_HTML_MARKER_RE.test(body) && !looksLikeChallenge,
  );
  return { looksLikeChallenge, looksLikeRealContent };
}

/**
 * Select the recommended UA from a sweep. Pure function — all inputs are in
 * the sweep struct, output is deterministic.
 *
 * Decision tree (Mistake 30 Fix B):
 *   (a) desktop returned real content → desktop (strongest signal)
 *   (b) desktop blocked/small AND iPhone returned real content → iPhone
 *   (c) desktop ambiguous AND iPhone clearly works → iPhone (medium)
 *   (d) both blocked → desktop (fallback; Playwright will handle escalation)
 *   (e) both ambiguous (no challenge, no real content — e.g. thin landing
 *       page without product markers) → desktop (default)
 */
export function selectRecommendedUa(sweep: UASweep): {
  ua: 'desktop' | 'iphone';
  reason: string | null;
} {
  const d = sweep.desktop;
  const i = sweep.iphone;

  const desktopWorks = d.status === 200 && d.looksLikeRealContent;
  const desktopBlocked =
    d.status === null ||
    d.status === 307 ||
    d.status === 403 ||
    d.status === 503 ||
    d.looksLikeChallenge ||
    (d.bodyBytes > 0 && d.bodyBytes < BODY_CHALLENGE_THRESHOLD);
  const iphoneWorks = i.status === 200 && i.looksLikeRealContent;

  if (desktopWorks) {
    return { ua: 'desktop', reason: null };
  }
  if (desktopBlocked && iphoneWorks) {
    return {
      ua: 'iphone',
      reason: `desktop blocked (status=${d.status ?? 'null'}, bytes=${d.bodyBytes}, challenge=${d.looksLikeChallenge}) but iPhone returned real content (bytes=${i.bodyBytes})`,
    };
  }
  if (iphoneWorks) {
    return {
      ua: 'iphone',
      reason: `desktop ambiguous (status=${d.status ?? 'null'}, bytes=${d.bodyBytes}) but iPhone returned real content (bytes=${i.bodyBytes})`,
    };
  }
  return { ua: 'desktop', reason: null };
}

/**
 * Interpret heavy-waf-probe.sh stdout. Parses BATCH 1 header lines only
 * (Mistake 36 — naive whole-output regex matches INTERPRETATION GUIDE).
 */
export function interpretHeavyProbe(stdout: string): {
  hasWaf: boolean | null;
  wafType: WafType;
  confidence: WafConfidence;
  evidence: WafEvidence;
} {
  const evidence: WafEvidence = {
    headerServers: [],
    setCookieMarkers: {
      cfid: false,
      cftoken: false,
      cfBm: false,
      cfClearance: false,
      sucuri: false,
      incapsula: false,
      aspNetSession: false,
    },
    honeypotBlocked: false,
    sqliBlocked: false,
    xssBlocked: false,
    rateLimitObserved: false,
    uaFilterObserved: false,
    heavyProbeRawOutput: stdout,
  };

  if (!stdout || stdout.length === 0) {
    return { hasWaf: null, wafType: null, confidence: 'none', evidence };
  }

  // ── BATCH 1: header fingerprint (header lines only — Mistake 36) ───────────
  // Extract all BATCH 1 sub-sections (1a /, 1b robots.txt, 1c sitemap.xml),
  // then strip everything that isn't an HTTP header line (format: `name: value`).
  const batch1Match = stdout.match(/=== BATCH 1:[^=]*===([\s\S]*?)(?=\n=== BATCH)/);
  const batch1Text = batch1Match ? batch1Match[1] : '';
  // Header lines always look like `<name>: <value>`; filter to those.
  const headerLines = batch1Text
    .split('\n')
    .filter((l) => /^[a-z][a-z0-9-]+:/i.test(l.trim()));
  const headerBlock = headerLines.join('\n');

  // ── Vendor header detection (authoritative) ─────────────────────────────
  const hasCfRay = /^cf-ray:/im.test(headerBlock);
  const hasCfMitigated = /^cf-mitigated:/im.test(headerBlock);
  const hasCloudflareServer = /^server:\s*cloudflare/im.test(headerBlock);
  const hasSucuriHeader = /^x-sucuri-(id|cache|block):/im.test(headerBlock);
  const hasIncapsulaHeader = /^x-iinfo:|^x-cdn:\s*incapsula/im.test(headerBlock);
  const hasSgCaptchaHeader = /^sg-captcha:/im.test(headerBlock);

  // ── Cookie markers (useful for platform cross-reference AND WAF) ─────────
  // Cloudflare: __cf_bm (bot mgmt), cf_clearance (post-challenge cookie)
  evidence.setCookieMarkers.cfBm = /^set-cookie:\s*__cf_bm=/im.test(headerBlock);
  evidence.setCookieMarkers.cfClearance = /^set-cookie:\s*cf_clearance=/im.test(headerBlock);
  // Sucuri: sucuri_cloudproxy_* cookies
  evidence.setCookieMarkers.sucuri = /^set-cookie:\s*sucuri_cloudproxy/im.test(headerBlock);
  // Incapsula: visid_incap_*, incap_ses_*, nlbi_
  evidence.setCookieMarkers.incapsula = /^set-cookie:\s*(visid_incap|incap_ses|nlbi_)/im.test(
    headerBlock,
  );
  // ColdFusion: CFID / CFTOKEN
  evidence.setCookieMarkers.cfid = /^set-cookie:\s*CFID=/im.test(headerBlock);
  evidence.setCookieMarkers.cftoken = /^set-cookie:\s*CFTOKEN=/im.test(headerBlock);
  // ASP.NET / IIS: ASP.NET_SessionId
  evidence.setCookieMarkers.aspNetSession = /^set-cookie:\s*ASP\.NET_SessionId=/im.test(headerBlock);

  // ── Server headers (useful for platform detection downstream) ─────────────
  const serverMatches = headerBlock.match(/^server:\s*(.+)$/gim) || [];
  const seenServers = new Set<string>();
  for (const m of serverMatches) {
    const v = m.replace(/^server:\s*/i, '').trim();
    if (v && !seenServers.has(v)) {
      seenServers.add(v);
      evidence.headerServers.push(v);
    }
  }

  // ── Batch-level behavior signals ──────────────────────────────────────────
  // BATCH 3: rapid burst — if any 429/503 appears, rate limit observed.
  const batch3Match = stdout.match(/=== BATCH 3:[^=]*===([\s\S]*?)(?=\n=== BATCH)/);
  const batch3Text = batch3Match ? batch3Match[1] : '';
  evidence.rateLimitObserved = /\bSTATUS=(429|503)\b/.test(batch3Text);

  // BATCH 4: honeypot/admin paths — 403 on any indicates path-selective WAF.
  const batch4Match = stdout.match(/=== BATCH 4:[^=]*===([\s\S]*?)(?=\n=== BATCH)/);
  const batch4Text = batch4Match ? batch4Match[1] : '';
  evidence.honeypotBlocked = /\bSTATUS=403\b/.test(batch4Text);

  // BATCH 6: SQLi-shaped query — 403 indicates rule-selective WAF.
  const batch6Match = stdout.match(/=== BATCH 6:[^=]*===([\s\S]*?)(?=\n=== BATCH)/);
  const batch6Text = batch6Match ? batch6Match[1] : '';
  evidence.sqliBlocked = /\bSTATUS=403\b/.test(batch6Text);

  // BATCH 7: XSS-shaped query — 403 indicates rule-selective WAF.
  const batch7Match = stdout.match(/=== BATCH 7:[^=]*===([\s\S]*?)(?=\n=== BATCH)/);
  const batch7Text = batch7Match ? batch7Match[1] : '';
  evidence.xssBlocked = /\bSTATUS=403\b/.test(batch7Text);

  // BATCH 2: multi-UA — if Chrome 200 but bot/curl 403, UA filter observed.
  const batch2Match = stdout.match(/=== BATCH 2:[^=]*===([\s\S]*?)(?=\n=== BATCH)/);
  const batch2Text = batch2Match ? batch2Match[1] : '';
  const desktopLine = (batch2Text.match(/\[2a-desktop\][\s\S]*?\n/) || [''])[0];
  const botLine = (batch2Text.match(/\[2c-bot\][\s\S]*?\n/) || [''])[0];
  const curlLine = (batch2Text.match(/\[2d-curl\][\s\S]*?\n/) || [''])[0];
  const desktop200 = /\bSTATUS=200\b/.test(desktopLine);
  const bot403 = /\bSTATUS=403\b/.test(botLine);
  const curl403 = /\bSTATUS=403\b/.test(curlLine);
  evidence.uaFilterObserved = desktop200 && (bot403 || curl403);

  // ── Verdict assembly (vendor priority matters) ────────────────────────────
  let hasWaf: boolean | null = false;
  let wafType: WafType = null;
  let confidence: WafConfidence = 'none';

  // Vendor priority: Cloudflare → Sucuri → Incapsula → sgcaptcha → behavior
  // Cloudflare first because cf-ray is present on ALL CF-fronted responses,
  // passive or active. Determine active vs passive by whether the homepage
  // ever returned 403/503/challenge status.
  const anyChallengeStatus =
    /\bSTATUS=403\b/.test(batch1Text) ||
    /\bSTATUS=503\b/.test(batch1Text) ||
    /\bSTATUS=403\b/.test(batch2Text) ||
    /\bSTATUS=503\b/.test(batch2Text);

  if (hasCfRay || hasCloudflareServer || hasCfMitigated) {
    hasWaf = true;
    wafType = anyChallengeStatus ? 'cloudflare-active' : 'cloudflare-passive';
    confidence = 'high';
  } else if (hasSucuriHeader || evidence.setCookieMarkers.sucuri) {
    hasWaf = true;
    wafType = 'sucuri';
    confidence = 'high';
  } else if (hasIncapsulaHeader || evidence.setCookieMarkers.incapsula) {
    hasWaf = true;
    wafType = 'incapsula';
    confidence = 'high';
  } else if (hasSgCaptchaHeader) {
    hasWaf = true;
    wafType = 'sgcaptcha';
    confidence = 'high';
  } else if (evidence.rateLimitObserved) {
    hasWaf = true;
    wafType = 'rate-limit';
    confidence = 'medium';
  } else if (evidence.honeypotBlocked && !evidence.sqliBlocked && !evidence.xssBlocked) {
    // Honeypot blocked but rule-filters clean — path-selective (generic webapp
    // firewall or htaccess deny rules on admin paths, not a real WAF).
    hasWaf = true;
    wafType = 'path-selective';
    confidence = 'medium';
  } else if (evidence.sqliBlocked || evidence.xssBlocked) {
    hasWaf = true;
    wafType = 'rule-selective';
    confidence = 'medium';
  } else if (evidence.uaFilterObserved) {
    // Non-CF UA filter rule. Could be mod_security / cPanel / server-side rule.
    hasWaf = true;
    wafType = 'rule-selective';
    confidence = 'low';
  } else {
    hasWaf = false;
    wafType = null;
    confidence = 'medium';
  }

  return { hasWaf, wafType, confidence, evidence };
}

// ── Low-level utilities ───────────────────────────────────────────────────────

const log = (msg: string) => process.stderr.write(msg + '\n');

function normalizeOrigin(input: string): string {
  try {
    const u = new URL(input);
    return `${u.protocol}//${u.host}`;
  } catch {
    if (!/^https?:\/\//i.test(input)) {
      return `https://${input.replace(/\/$/, '')}`;
    }
    return input.replace(/\/$/, '');
  }
}

/**
 * Resolve canonical origin via redirect follow. Returns both the canonical
 * URL and whether the apex redirected somewhere else (e.g. `example.com` →
 * `www.example.com`). The canonical-origin URL is what all subsequent probes
 * target.
 */
async function resolveCanonicalOrigin(inputUrl: string): Promise<{
  canonicalOrigin: string;
  apexRedirects: boolean;
}> {
  const normalized = normalizeOrigin(inputUrl);
  // Use fetchForProbe for the redirect follow — it has retry + HPE fallback.
  // accept=html because we don't need JSON parsing; the status + final URL
  // are what we care about.
  const r: ProbeFetchResult = await fetchForProbe(normalized + '/', {
    ua: 'desktop',
    mode: 'auto',
    accept: 'html',
    timeoutMs: 15_000,
  });
  // fetchForProbe's `url` field IS the final URL after redirect follow
  // (for axios path: resp.request.res.responseUrl; for native-fetch: resp.url;
  // for playwright: passes through input URL). Normalize the final URL to
  // origin-only for consistency.
  if (r.status === null) {
    // Network failure — return the normalized input as the best guess.
    return { canonicalOrigin: normalized, apexRedirects: false };
  }
  let finalOrigin: string;
  try {
    const u = new URL(r.url);
    finalOrigin = `${u.protocol}//${u.host}`;
  } catch {
    finalOrigin = normalized;
  }
  const apexRedirects = normalizeOrigin(normalized) !== finalOrigin;
  return { canonicalOrigin: finalOrigin, apexRedirects };
}

/**
 * Parse robots.txt into sitemap lines + crawl-delay.
 */
async function fetchRobotsTxt(origin: string): Promise<{
  accessible: boolean;
  sitemapLines: string[];
  crawlDelay: number | null;
}> {
  const r = await fetchForProbe(`${origin}/robots.txt`, {
    ua: 'desktop',
    mode: 'auto',
    accept: 'html',
    timeoutMs: 15_000,
  });
  if (r.status !== 200 || !r.bodySample) {
    return { accessible: false, sitemapLines: [], crawlDelay: null };
  }
  const body = r.bodySample;
  if (!/User-agent:/i.test(body)) {
    // 200 but not a real robots.txt (some sites serve an HTML 200 homepage
    // for unknown paths).
    return { accessible: false, sitemapLines: [], crawlDelay: null };
  }
  const sitemapLines: string[] = [];
  let crawlDelay: number | null = null;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    const sm = line.match(/^sitemap\s*:\s*(\S+)/i);
    if (sm) {
      sitemapLines.push(sm[1].trim());
      continue;
    }
    const cd = line.match(/^crawl-delay\s*:\s*(\d+)/i);
    if (cd && crawlDelay === null) {
      crawlDelay = parseInt(cd[1], 10);
    }
  }
  return { accessible: true, sitemapLines, crawlDelay };
}

/**
 * Run heavy-waf-probe.sh and return its stdout. Gracefully handles bash
 * absence (Windows without Git Bash) — returns empty string and caller emits
 * a warning + null verdict.
 */
async function runHeavyWafProbe(canonicalUrl: string): Promise<{
  stdout: string;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const probePath = path.resolve(__dirname, '..', 'heavy-waf-probe.sh');
  try {
    // Git Bash is available on Windows as `bash` if installed. On Linux/Mac
    // `bash` is universally present.
    const { stdout } = await execFileAsync('bash', [probePath, canonicalUrl], {
      timeout: HEAVY_PROBE_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024, // 10MB — heavy probe can be large
      encoding: 'utf8',
    });
    return { stdout, warnings };
  } catch (e: any) {
    // execFile throws on non-zero exit OR on ENOENT (bash not found).
    // Distinguish: if we got stdout attached to the error, the script ran
    // but exited non-zero (still useful for parsing). If ENOENT / spawn
    // error, bash isn't available.
    const msg: string = e?.message || String(e);
    if (e?.code === 'ENOENT' || /spawn.*ENOENT/i.test(msg)) {
      warnings.push('bash not available — heavy-waf-probe.sh skipped, hasWaf will be null');
      return { stdout: '', warnings };
    }
    if (e?.killed || e?.signal === 'SIGTERM') {
      warnings.push(`heavy-waf-probe.sh timed out after ${HEAVY_PROBE_TIMEOUT_MS}ms`);
    }
    // Return whatever stdout we got — the script may have emitted batches
    // before timeout/error.
    const partialStdout: string = e?.stdout || '';
    if (partialStdout) {
      warnings.push(`heavy-waf-probe.sh exited non-zero; parsing partial output (${partialStdout.length} bytes)`);
      return { stdout: partialStdout, warnings };
    }
    warnings.push(`heavy-waf-probe.sh failed: ${msg.slice(0, 200)}`);
    return { stdout: '', warnings };
  }
}

/**
 * Run one UA probe via fetchForProbe. Returns a UAResult with sampling.
 * Uses mode=static to avoid Playwright escalation — this module only wants
 * to know what each UA class gets from the RAW HTTP layer. Playwright
 * confirmation happens separately in `probePlaywrightReachability`.
 */
async function runUaProbe(
  url: string,
  ua: 'desktop' | 'iphone' | string,
  timeoutMs: number,
): Promise<UAResult> {
  // For non-standard UAs (curl, bot, no-ua), pass via custom: prefix to
  // probe-fetch. For no-UA, custom:'' resolves back to desktop per
  // resolveUa's contract — we work around by passing an axios header
  // override; but probe-fetch doesn't expose header overrides. Solution:
  // map an empty UA via custom: to a very minimal "X-None" value; since
  // servers that require UA reject absent UA, this still exposes the
  // behavior (a rejection). Better: call raw axios for the no-UA case
  // to match heavy-probe batch 8 semantics exactly.
  //
  // For simplicity + alignment with probe-fetch's primitive, we accept
  // that "no-UA" in this module is approximated by an explicitly-empty
  // custom UA — and document the approximation. This is a module-3
  // concern and doesn't affect downstream modules because the skill
  // consumes recommendedUa, not the raw no-UA result.
  let uaOpt: 'desktop' | 'iphone' | `custom:${string}`;
  if (ua === 'desktop') uaOpt = 'desktop';
  else if (ua === 'iphone') uaOpt = 'iphone';
  else uaOpt = `custom:${ua}` as const;

  const r = await fetchForProbe(url, {
    ua: uaOpt,
    mode: 'static', // no Playwright escalation — we want raw UA behavior
    accept: 'html',
    timeoutMs,
  });
  const sampleBody = r.bodySample || '';
  const cls = classifyBody(sampleBody, r.status);
  return {
    status: r.status,
    bodyBytes: r.bodyBytes,
    sampleBody: sampleBody.slice(0, 2000), // cap output size
    method: r.method ?? 'none',
    cfRay: r.headers?.['cf-ray'] || null,
    sgCaptcha: Boolean(r.headers?.['sg-captcha']) || /sg-?captcha/i.test(sampleBody),
    looksLikeChallenge: cls.looksLikeChallenge,
    looksLikeRealContent: cls.looksLikeRealContent,
  };
}

/**
 * Confirm Playwright reachability when all static UAs appear blocked.
 * Returns true iff Playwright fetched >8KB of real content.
 */
async function confirmPlaywrightReachability(canonicalOrigin: string): Promise<boolean> {
  try {
    const r = await fetchForProbe(canonicalOrigin + '/', {
      mode: 'playwright',
      accept: 'html',
      timeoutMs: PLAYWRIGHT_CONFIRM_TIMEOUT_MS,
    });
    if (r.status !== 200) return false;
    const cls = classifyBody(r.bodySample || '', r.status);
    return cls.looksLikeRealContent || r.bodyBytes > BODY_REAL_CONTENT_THRESHOLD;
  } catch {
    return false;
  }
}

// ── Main public API ──────────────────────────────────────────────────────────

export interface RunProbeAccessOpts {
  uaProbeTimeoutMs?: number;
  skipHeavyProbe?: boolean;
}

export async function runProbeAccess(
  inputUrl: string,
  opts: RunProbeAccessOpts = {},
): Promise<ProbeAccessResult> {
  const uaProbeTimeoutMs = opts.uaProbeTimeoutMs ?? UA_PROBE_TIMEOUT_MS_DEFAULT;
  const warnings: string[] = [];

  // ── Step 1: canonical origin ─────────────────────────────────────────────
  log(`[probe-access] resolving canonical origin: ${inputUrl}`);
  const { canonicalOrigin, apexRedirects } = await resolveCanonicalOrigin(inputUrl);
  if (apexRedirects) {
    log(`  apex redirected to: ${canonicalOrigin}`);
  }

  // ── Step 2: robots.txt ───────────────────────────────────────────────────
  log(`[probe-access] fetching robots.txt`);
  const robotsTxt = await fetchRobotsTxt(canonicalOrigin);
  log(
    `  robots.txt ${robotsTxt.accessible ? 'accessible' : 'missing'}, sitemap-lines=${robotsTxt.sitemapLines.length}, crawl-delay=${robotsTxt.crawlDelay ?? 'none'}`,
  );

  // ── Step 3: heavy WAF probe (subprocess) ─────────────────────────────────
  let heavyProbeOutput = '';
  if (!opts.skipHeavyProbe) {
    log(`[probe-access] running heavy-waf-probe.sh (timeout ${HEAVY_PROBE_TIMEOUT_MS / 1000}s)`);
    const { stdout, warnings: heavyWarnings } = await runHeavyWafProbe(canonicalOrigin);
    heavyProbeOutput = stdout;
    warnings.push(...heavyWarnings);
    log(`  heavy probe: ${stdout.length} bytes output`);
  } else {
    warnings.push('heavy-waf-probe skipped by --skip-heavy-probe');
  }

  // ── Step 4: UA sweep (5 UAs in parallel) ─────────────────────────────────
  log(`[probe-access] running UA sweep (5 UAs in parallel)`);
  const canonicalUrl = canonicalOrigin + '/';
  const [desktopR, iphoneR, curlR, botR, noUaR] = await Promise.all([
    runUaProbe(canonicalUrl, 'desktop', uaProbeTimeoutMs),
    runUaProbe(canonicalUrl, 'iphone', uaProbeTimeoutMs),
    runUaProbe(canonicalUrl, 'curl/8.1.2', uaProbeTimeoutMs),
    runUaProbe(canonicalUrl, 'python-requests/2.31.0', uaProbeTimeoutMs),
    runUaProbe(canonicalUrl, '', uaProbeTimeoutMs), // approximated: empty custom UA
  ]);
  const uaSweep: UASweep = {
    desktop: desktopR,
    iphone: iphoneR,
    curl: curlR,
    bot: botR,
    noUa: noUaR,
  };
  log(
    `  desktop: status=${desktopR.status}, bytes=${desktopR.bodyBytes}, challenge=${desktopR.looksLikeChallenge}, real=${desktopR.looksLikeRealContent}`,
  );
  log(
    `  iphone:  status=${iphoneR.status}, bytes=${iphoneR.bodyBytes}, challenge=${iphoneR.looksLikeChallenge}, real=${iphoneR.looksLikeRealContent}`,
  );
  log(`  curl:    status=${curlR.status}, bytes=${curlR.bodyBytes}`);
  log(`  bot:     status=${botR.status}, bytes=${botR.bodyBytes}`);
  log(`  no-ua:   status=${noUaR.status}, bytes=${noUaR.bodyBytes}`);

  // ── Step 5: interpret heavy probe ────────────────────────────────────────
  const heavyVerdict = interpretHeavyProbe(heavyProbeOutput);

  // If heavy probe was skipped/unavailable, attempt a fallback inference
  // from the UA sweep alone: if desktop and iphone BOTH look real → no WAF
  // (low confidence). If either UA saw a challenge body or was blocked, we
  // say hasWaf=null (unknown — need heavy probe).
  let hasWaf = heavyVerdict.hasWaf;
  let wafType = heavyVerdict.wafType;
  let wafConfidence = heavyVerdict.confidence;
  const evidence = heavyVerdict.evidence;

  if (heavyProbeOutput.length === 0) {
    const bothReal =
      desktopR.looksLikeRealContent && iphoneR.looksLikeRealContent;
    const anyChallenge =
      desktopR.looksLikeChallenge || iphoneR.looksLikeChallenge;
    if (bothReal && !anyChallenge) {
      hasWaf = false;
      wafType = null;
      wafConfidence = 'low';
    } else {
      hasWaf = null;
      wafType = null;
      wafConfidence = 'none';
    }
  }

  // ── Step 5b: UA-sweep-driven verdict overrides ───────────────────────────
  // The UA sweep uses live axios + native-fetch against the canonical URL on
  // the SAME process — it's authoritative for vendor signals that happen to
  // arrive on the HOMEPAGE response rather than the heavy-probe-observed paths
  // (/, /robots.txt, /sitemap.xml). When the heavy probe gets truncated
  // (SIGTERM mid-batch on slow backends, Mistake 36 — partial parse drops
  // authoritative signals), these overrides recover the verdict from live
  // evidence. All overrides are "promote to higher-authority type" — we never
  // demote a positive verdict.

  // (a) sgcaptcha via UA-sweep sg-captcha header OR challenge-body marker.
  //     sg-captcha is an authoritative vendor header; response-header presence
  //     on ANY static UA beats any heavy-probe behavioural verdict.
  const sgSeenInUaSweep =
    desktopR.sgCaptcha ||
    iphoneR.sgCaptcha ||
    curlR.sgCaptcha ||
    botR.sgCaptcha ||
    noUaR.sgCaptcha;
  if (sgSeenInUaSweep && wafType !== 'sgcaptcha') {
    log(
      `[probe-access] UA sweep saw sg-captcha — overriding wafType=${wafType} → sgcaptcha`,
    );
    hasWaf = true;
    wafType = 'sgcaptcha';
    wafConfidence = 'high';
  }

  // (b) Cloudflare via UA-sweep cf-ray. Authoritative CF vendor header —
  //     present iff response went through Cloudflare.
  const uaCfRay = desktopR.cfRay || iphoneR.cfRay;
  if (uaCfRay && !evidence.headerServers.some((s) => /cloudflare/i.test(s))) {
    evidence.headerServers.push(`cloudflare (via cf-ray: ${uaCfRay})`);
  }
  // Promote to cloudflare-* if heavy probe missed it AND no higher-priority
  // vendor (Sucuri/Incapsula/sgcaptcha) is already detected.
  if (uaCfRay && !wafType) {
    // Determine active vs passive by whether any UA was challenged.
    const anyUaChallenged =
      desktopR.looksLikeChallenge ||
      iphoneR.looksLikeChallenge ||
      curlR.looksLikeChallenge ||
      botR.looksLikeChallenge ||
      (desktopR.status !== null && (desktopR.status === 403 || desktopR.status === 503));
    log(
      `[probe-access] UA sweep saw cf-ray but heavy probe missed CF — upgrading to cloudflare-${anyUaChallenged ? 'active' : 'passive'}`,
    );
    hasWaf = true;
    wafType = anyUaChallenged ? 'cloudflare-active' : 'cloudflare-passive';
    wafConfidence = 'high';
  }

  // ── Step 6: recommended UA ───────────────────────────────────────────────
  // First: pure live-evidence decision (selectRecommendedUa).
  const uaDecision = selectRecommendedUa(uaSweep);
  let recommendedUa: 'desktop' | 'iphone' = uaDecision.ua;
  let uaOverrideReason: string | null = uaDecision.reason;

  // Second: fleet-rule override. When wafType is a JS-challenge family
  // (Mistake 30 Fix B), the pre-solve UA sweep CANNOT distinguish which UA
  // will replay cleanly post-cookie-solve — all UAs see the same challenge
  // body. Fleet experience shows iPhone gets the full cookie set and desktop
  // does not. Apply iPhone unless live evidence proved desktop already works
  // (i.e. desktop returned real content — then the site is clearly not
  // actively gating desktop, so trust live evidence over the rule).
  if (wafType && WAF_REQUIRES_IPHONE.has(wafType)) {
    const desktopProvenToWork =
      desktopR.status === 200 && desktopR.looksLikeRealContent;
    if (!desktopProvenToWork && recommendedUa !== 'iphone') {
      log(
        `[probe-access] wafType=${wafType} + desktop not proven — applying fleet rule: recommendedUa=iphone`,
      );
      recommendedUa = 'iphone';
      uaOverrideReason = `fleet rule: wafType=${wafType} requires iPhone UA post-solve (Mistake 30 Fix B)`;
    }
  }
  log(`[probe-access] recommendedUa=${recommendedUa}${uaOverrideReason ? ` (${uaOverrideReason})` : ''}`);

  // ── Step 7: Playwright fallback determination ────────────────────────────
  // playwrightRequired=true iff ALL static UAs are blocked/challenged AND
  // we have reason to believe the site IS reachable (Playwright check).
  // We only run the Playwright probe when the UA sweep suggests it's needed
  // (don't pay the browser spawn cost for cleanly-200 sites).
  let playwrightRequired = false;
  const allUAsBlocked =
    !desktopR.looksLikeRealContent &&
    !iphoneR.looksLikeRealContent &&
    (desktopR.looksLikeChallenge ||
      iphoneR.looksLikeChallenge ||
      desktopR.status === null ||
      iphoneR.status === null ||
      (desktopR.bodyBytes < BODY_REAL_CONTENT_THRESHOLD &&
        iphoneR.bodyBytes < BODY_REAL_CONTENT_THRESHOLD));
  if (allUAsBlocked) {
    log(`[probe-access] all UAs blocked — confirming Playwright reachability`);
    playwrightRequired = await confirmPlaywrightReachability(canonicalOrigin);
    log(`  playwrightRequired=${playwrightRequired}`);
  }

  return {
    inputUrl,
    canonicalOrigin,
    apexRedirects,
    robotsTxt,
    uaSweep,
    recommendedUa,
    uaOverrideReason,
    hasWaf,
    wafType,
    wafConfidence,
    wafEvidence: evidence,
    playwrightRequired,
    warnings,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { url: string; opts: RunProbeAccessOpts } | null {
  const positional: string[] = [];
  const opts: RunProbeAccessOpts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ua-probe-timeout') {
      const v = argv[++i];
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return null;
      opts.uaProbeTimeoutMs = n;
    } else if (a === '--skip-heavy-probe') {
      opts.skipHeavyProbe = true;
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
      'usage: probe-access.ts <url> [--ua-probe-timeout <ms>] [--skip-heavy-probe]\n',
    );
    return 2;
  }
  const result = await runProbeAccess(parsed.url, parsed.opts);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  await closePlaywrightIfUsed();
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`probe-access crashed: ${e?.stack || e?.message || e}\n`);
      process.exit(1);
    });
}

// Reference resolveUa to avoid unused-import complaints if the project ever
// adds a noUnusedLocals rule — it's conceptually useful for readers to see
// this module is aware of probe-fetch's UA primitives.
void resolveUa;
