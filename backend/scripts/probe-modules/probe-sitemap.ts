/**
 * probe-sitemap.ts — Module 2 of the decomposed pre-bootstrap probe.
 *
 * Single responsibility: given an origin URL, find all sitemaps, follow
 * sitemap indices recursively, filter <loc> entries to product URL patterns,
 * count them, and return the list of sub-sitemaps followed.
 *
 * Does NOT:
 *   - HEAD-test random URLs for liveness (too expensive — orchestrator can
 *     spot-check).
 *   - Classify sitemap counts as authoritative (Mistake 29 BC Stencil
 *     inflation, Mistake 37 Drupal classifieds lag). That's skill work.
 *   - Recognize per-platform product-URL schemes via hardcoded branches —
 *     uses a GENERIC heuristic (include/exclude + shape similarity).
 *   - Parse sitemap for anything besides <loc> (and we ignore <lastmod>).
 *
 * Discovery order:
 *   1. robots.txt — read `Sitemap:` directives (primary; authoritative per
 *      sitemap.xml protocol).
 *   2. /sitemap.xml
 *   3. /sitemap_index.xml (and /sitemap-index.xml)
 *   4. Platform-common filenames (FALLBACK only, NOT platform detection):
 *      /product-sitemap.xml, /store-products-sitemap.xml,
 *      /products-sitemap.xml, /sitemap_products.xml, /sitemap_products_1.xml,
 *      /ecstore-1-sitemap.xml, /xmlsitemap.php (BigCommerce), /sitemap/products.xml.
 *   5. If the sitemap is a <sitemapindex>, follow each <sitemap><loc>
 *      recursively up to --max-sub-sitemaps (default 40 — covers 200k-product
 *      sites like Yoast/RankMath splitting at 5k per child).
 *
 * Confidence:
 *   - high — ≥3 sub-sitemaps concur on product pattern, OR single sitemap
 *     with ≥100 product URLs.
 *   - medium — single sitemap with 10-99 product URLs.
 *   - low — <10 URLs, or pattern inconsistency.
 *   - none — no sitemap found.
 *
 * Salvage: the old 2,751-line monolith had a similar sitemap block at
 * lines 1248-1420 (classifyLocs + PRODUCT_SM_RE + sub-sitemap fan-out).
 * This module is a clean redesign — wider product-URL heuristic, cleaner
 * sub-sitemap follow logic, dedupe via Set, and its own CLI. The key shape
 * of the discovery (robots → /sitemap.xml → index → follow children) is
 * preserved because that shape is correct.
 *
 * CLI:
 *   npx tsx scripts/probe-modules/probe-sitemap.ts <origin>
 *     [--ua desktop|iphone]
 *     [--max-sub-sitemaps <N>]
 *
 * Output: JSON to stdout. Progress to stderr.
 * Exit: 0 if ≥1 sitemap found, 1 if none, 2 on bad args.
 */

import { fetchForProbe, closePlaywrightIfUsed, ProbeFetchResult, UaMode } from './probe-fetch';

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_SUB_SITEMAPS = 40;
const MAX_OTHER_SUB_SITEMAPS = 5; // non-product-named children (category, post, author)
const PRODUCT_SAMPLE_LIMIT = 20;

/**
 * Canonical candidate paths. Robots.txt-declared sitemaps take priority; these
 * are FALLBACK only. No platform detection — these filenames exist across many
 * platforms.
 */
const SITEMAP_CANDIDATES = [
  '/sitemap.xml',
  '/sitemap_index.xml',
  '/sitemap-index.xml',
  '/product-sitemap.xml',
  '/sitemap_products.xml',
  '/products-sitemap.xml',
  '/store-products-sitemap.xml', // Wix, Ecwid
  '/sitemap/products.xml',
  '/sitemap_products_1.xml', // Shopify shard-1
  '/ecstore-1-sitemap.xml', // Ecwid/mysimplestore shard-1
  '/xmlsitemap.php', // BigCommerce Blueprint/Stencil
];

/**
 * PRODUCT_SM_RE — matches filenames that are *likely* product-sub-sitemaps
 * inside a <sitemapindex>. Used to prioritize which children to follow
 * (product sub-sitemaps get the 40-follow budget; others cap at 5). NOT used
 * to exclude — any sub-sitemap might contain products, it's just about
 * ordering when the index has many children.
 */
const PRODUCT_SM_RE =
  /product[-_]?sitemap(?:\d+|\.xml|_\d+|-\d+)?|sitemap_products?|products?-sitemap|store[-_]?products[-_]?sitemap|sitemap_products_\d+|ecstore[-_]?\d+[-_]?sitemap/i;

/**
 * Negative patterns — a <loc> matching ANY of these is NOT a product. Covers
 * nav, taxonomy, static pages, feeds. Intentionally broad: if we misclassify
 * a legit product URL as non-product we'll undercount, but if we let a
 * category URL through we'll overcount AND poison the downstream sort/filter
 * audit.
 */
const NEGATIVE_PATTERNS: RegExp[] = [
  /\/wp-content\//i,
  /\/wp-admin\//i,
  /\/wp-includes\//i,
  /\/product-category\//i,
  /\/product_category\//i,
  /\/collections?(?:\/[^\/]+)?\/?$/i, // /collections or /collections/x — but allow /collections/foo/products/bar
  /\/category\//i,
  /\/categories\//i,
  /\/brand\//i,
  /\/brands\//i,
  /\/tag\//i,
  /\/tags\//i,
  /\/author\//i,
  /\/feed\/?$/i,
  /\/rss\/?$/i,
  /\/sitemap/i, // recursive: sitemap links to itself
  /\/robots\.txt/i,
  /\/page\/\d+/i,
  /\/(cart|checkout|account|login|register|logout|my-account|wishlist)\b/i,
  /\/(about|about-us|contact|contact-us|faq|help|support|blog|news|press|privacy|terms|policy|policies|shipping|returns|warranty|store-locator|locations|careers|jobs)\b/i,
  /\/search\b/i,
  /\/(en|fr|es|de|cn|zh)\/?$/i, // language-root only (no path after)
];

/**
 * Positive patterns — a <loc> matching ANY of these is likely a product.
 * Generic schemes common across platforms. Not exhaustive; the long-descriptive-
 * slug shape heuristic at the bottom catches sites like BC Stencil that use
 * bare `/<slug>/` without any ID prefix or suffix.
 */
const POSITIVE_PATTERNS: RegExp[] = [
  /\/products?\/[^\/?#]+\/?$/i, // /product/foo or /products/foo (singular+plural, optional trailing slash)
  /\/product-page\/[^\/?#]+\/?$/i, // Wix
  /\/shop\/[^\/?#]+(?:-\d+)?\/?$/i, // Celerant / generic /shop/<slug>-<id>
  /\/store\/[^\/?#]+\/?$/i, // generic /store/<slug>
  /\/item\/[^\/?#]+\/?$/i, // marketplace-style
  /\/listing\/[^\/?#]+\/?$/i, // classifieds
  /\/listings\/[^\/?#]+\/?$/i,
  /\/ads\/[^\/?#]+\/?$/i, // Drupal classifieds (gunpost)
  /\/p\/[^\/?#]+\/?$/i, // shortened /p/<slug>
  /\/catalog\/product\/view\/id\/\d+/i, // Magento 1.x/2.x
  /\/productdetails\.asp/i, // Volusion
  /[?&]route=product\/product\b/i, // OpenCart
  /\/[^\/?#]+-\d{3,}\/?$/i, // /<slug>-NNN (numeric ID suffix, min 3 digits)
  /[-_]p\d{3,}\.html?$/i, // /<slug>_p123.html (legacy .html-ID suffix)
  /\/\d{3,}\.html?$/i, // /12345.html (pure numeric .html)
  /\/product\.php\?/i, // legacy PHP
  /\/detail\/[^\/?#]+\/?$/i, // generic detail pages
  // Drupal classifieds 3+ segment nested paths:
  //   /<cat>/<subcat>/<location>/<slug>
  //   e.g. gunpost.ca /firearms/rifles/edmonton/mauser-sporter-243-win-24
  // Match 4+ non-empty slug segments. categoryPatterns above already excluded
  // the common nav paths so this doesn't eat /about/team/us/contact.
  /\/[a-z][a-z0-9-]+\/[a-z][a-z0-9-]+\/[a-z][a-z0-9-]+\/[a-z][a-z0-9-]{3,}\/?$/i,
  // GENERIC DESCRIPTIVE-SLUG HEURISTIC — single-segment path with ≥4 hyphens
  // AND ≥30 chars of slug. Real products have descriptive names like
  // `northland-thumper-jig-1-4-oz-glow-watermelon-2-pc` (14 hyphens, 48 chars)
  // or `bolt-action-rifles-2` (3 hyphens, 20 chars, category — correctly
  // excluded by length threshold). Catches BC Stencil /<slug>/ without a
  // numeric ID which is the common case on many BC/Magento/Shopify stores.
  /^https?:\/\/[^\/]+\/[a-z0-9][a-z0-9-]{29,}\/?$/i,
];

/**
 * Helper: count hyphens in the final path segment. Used as a second gate on
 * the descriptive-slug pattern to avoid matching long single-word
 * underscore-only category slugs.
 */
function segmentHyphenCount(url: string): number {
  try {
    const u = new URL(url);
    const seg = u.pathname.replace(/\/$/, '').split('/').pop() || '';
    return (seg.match(/-/g) || []).length;
  } catch {
    return 0;
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

export type SitemapType = 'index' | 'urlset';
export type SitemapMethod = 'axios' | 'native-fetch' | 'playwright';

export interface SitemapFound {
  url: string;
  type: SitemapType;
  urls: number; // total <loc> entries (pre-classification)
  products: number; // <loc> matching product pattern
  method: SitemapMethod;
}

export interface SitemapError {
  url: string;
  message: string;
}

export interface ProbeSitemapResult {
  origin: string;
  sitemapsChecked: string[];
  sitemapsFound: SitemapFound[];
  subSitemapsFollowed: number;
  totalProductUrls: number;
  productUrlSample: string[];
  productUrlPattern: string;
  confidence: 'high' | 'medium' | 'low' | 'none';
  warnings: string[];
  errors: SitemapError[];
}

// ── Utilities ────────────────────────────────────────────────────────────────

function normalizeOrigin(input: string): string {
  // Strip trailing slash from origin — all paths in SITEMAP_CANDIDATES
  // lead with `/`.
  try {
    const u = new URL(input);
    return `${u.protocol}//${u.host}`;
  } catch {
    // Input might already be origin-only without protocol. Try to repair.
    if (!/^https?:\/\//i.test(input)) {
      return `https://${input.replace(/\/$/, '')}`;
    }
    return input.replace(/\/$/, '');
  }
}

/**
 * Decode XML entity references inside <loc> text. Per the sitemap.xml spec
 * (https://www.sitemaps.org/protocol.html §4.3), URLs in <loc> are XML-encoded
 * and MUST be decoded by consumers. The five predefined XML entities are
 * mandatory (&amp; &lt; &gt; &apos; &quot;); numeric character refs (&#NN;
 * &#xNN;) are also legal and commonly used by ColdFusion/Celerant sitemaps,
 * which emit `&#x2f;` in place of `/` to sidestep some intermediate encoders.
 *
 * Without decoding, the URL `/vortex&#x2f;vortex-diamondback-hd-9658` fails
 * every positive pattern (because the pattern char class [a-z0-9-] rejects
 * the `&`). With decoding it becomes `/vortex/vortex-diamondback-hd-9658`
 * which matches the generic `/<slug>-\d{3,}$` id-suffix pattern. This is NOT
 * a site-specific branch — it is a spec-mandated decoding step.
 */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      const n = parseInt(hex, 16);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : _m;
    })
    .replace(/&#(\d+);/g, (_m, dec) => {
      const n = parseInt(dec, 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : _m;
    });
}

function extractLocs(xml: string): string[] {
  // Tolerant <loc> extractor: handles both `<loc>url</loc>` and
  // `<loc><![CDATA[url]]></loc>`, and some whitespace. Decodes XML entities
  // per sitemap.xml spec §4.3 (mandatory).
  const out: string[] = [];
  const re = /<loc>\s*(?:<!\[CDATA\[)?([^<\]]+?)(?:\]\]>)?\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const url = decodeXmlEntities(m[1].trim());
    if (url) out.push(url);
  }
  return out;
}

function isSitemapIndex(xml: string): boolean {
  // A <sitemapindex> root means this is an index of sub-sitemaps (not products).
  // Prefer structural check over simple presence of `<sitemap>` — some urlsets
  // have blog-related entries that include the word 'sitemap' in text.
  return /<sitemapindex[\s>]/i.test(xml);
}

function looksLikeXml(body: string): boolean {
  if (!body) return false;
  // Require either an XML prolog OR a sitemap/urlset tag in the first 2KB.
  const head = body.slice(0, 2048);
  return /<\?xml|<urlset[\s>]|<sitemapindex[\s>]|<loc>/i.test(head);
}

/**
 * Classify a batch of <loc> URLs into products vs non-products.
 * Uses the GENERIC POSITIVE/NEGATIVE pattern pair — no platform branches.
 *
 * The last positive pattern (descriptive-slug shape) gets a second-stage
 * hyphen check to avoid matching very long single-word slugs (which would
 * be rare but could be category pages).
 */
function classifyLocs(locs: string[]): { products: string[]; nonProducts: number } {
  const products: string[] = [];
  let nonProducts = 0;
  const lastIdx = POSITIVE_PATTERNS.length - 1;
  for (const loc of locs) {
    if (NEGATIVE_PATTERNS.some((p) => p.test(loc))) {
      nonProducts++;
      continue;
    }
    let matched = false;
    for (let i = 0; i < POSITIVE_PATTERNS.length; i++) {
      if (POSITIVE_PATTERNS[i].test(loc)) {
        // Descriptive-slug shape pattern: also require ≥3 hyphens in the slug
        // to avoid matching the rare long single-word category slug.
        if (i === lastIdx && segmentHyphenCount(loc) < 3) continue;
        matched = true;
        break;
      }
    }
    if (matched) products.push(loc);
    else nonProducts++;
  }
  return { products, nonProducts };
}

/**
 * Which positive regex fired the most? Returned as the `productUrlPattern`
 * signal so the skill can cross-reference with its expected-platform shape.
 */
function dominantPattern(locs: string[]): string {
  const counts = new Map<number, number>();
  const lastIdx = POSITIVE_PATTERNS.length - 1;
  for (const loc of locs) {
    if (NEGATIVE_PATTERNS.some((p) => p.test(loc))) continue;
    for (let i = 0; i < POSITIVE_PATTERNS.length; i++) {
      if (POSITIVE_PATTERNS[i].test(loc)) {
        if (i === lastIdx && segmentHyphenCount(loc) < 3) continue;
        counts.set(i, (counts.get(i) || 0) + 1);
        break;
      }
    }
  }
  let bestIdx = -1;
  let bestCount = 0;
  for (const [i, c] of counts.entries()) {
    if (c > bestCount) {
      bestCount = c;
      bestIdx = i;
    }
  }
  if (bestIdx === -1) return '(none)';
  return POSITIVE_PATTERNS[bestIdx].source;
}

/**
 * Parse `Sitemap:` directives out of robots.txt body. Absolute URLs only
 * (per spec) — but we tolerate relative and resolve against origin.
 */
function parseRobotsSitemaps(robotsBody: string, origin: string): string[] {
  const out: string[] = [];
  for (const line of robotsBody.split('\n')) {
    const m = line.match(/^\s*sitemap\s*:\s*(\S+)/i);
    if (!m) continue;
    let url = m[1].trim();
    if (!url) continue;
    if (!/^https?:\/\//i.test(url)) {
      // Relative — resolve against origin.
      if (!url.startsWith('/')) url = '/' + url;
      url = origin + url;
    }
    out.push(url);
  }
  return out;
}

// ── Fetch wrapper ─────────────────────────────────────────────────────────────

const log = (msg: string) => process.stderr.write(msg + '\n');

interface FetchedSitemap {
  url: string;
  status: number | null;
  body: string;
  method: SitemapMethod | null;
}

async function fetchSitemap(url: string, ua: UaMode): Promise<FetchedSitemap> {
  // Sitemaps are XML; axios accept=html works fine (servers ignore Accept
  // differences for static XML). Use accept=html to share the auth path
  // with HTML probes — if a site serves XML only via Accept: application/xml
  // in the future, we'd broaden the fetch module's accept type.
  const r: ProbeFetchResult = await fetchForProbe(url, { ua, mode: 'auto', accept: 'html' });
  return {
    url,
    status: r.status,
    body: r.bodySample || '', // bodySample is capped at 8KB in probe-fetch; we need the full body
    method: r.method,
  };
}

/**
 * Full-body fetch variant — bodySample is capped at 8KB in probe-fetch,
 * which is FINE for HTML snippets but a problem for sitemaps that routinely
 * exceed 8KB (a 5000-product sitemap is ~500KB). We use probe-fetch as the
 * transport primitive but then need the complete body. Solution: call
 * fetchForProbe, then re-issue a native read if the body was truncated.
 *
 * Rather than adding a hack, we accept a tradeoff: probe-fetch's bodySample
 * IS our source of truth. We update probe-fetch's contract? No — Module 1
 * is committed. Instead, we reach into the same primitives here for the
 * byte-accurate XML.
 *
 * Clean solution: use fetchForProbe for status+escalation+method, then
 * if the sitemap body was truncated at the sample limit, re-run a direct
 * axios fetch to get the full XML. This keeps Module 1 untouched.
 */
async function fetchSitemapFull(
  url: string,
  ua: UaMode,
): Promise<{
  status: number | null;
  body: string;
  method: SitemapMethod | null;
  errMsg: string | null;
}> {
  // Use probe-fetch to get the escalation path sorted (WAF, HPE, etc.).
  // If the body comes back suspiciously small relative to the XML it
  // describes, re-fetch via axios directly using responseType text.
  const r: ProbeFetchResult = await fetchForProbe(url, { ua, mode: 'auto', accept: 'html' });
  if (r.status === null) {
    return {
      status: null,
      body: '',
      method: null,
      errMsg: r.errors.length > 0 ? r.errors[r.errors.length - 1].message : 'fetch failed',
    };
  }

  // probe-fetch's bodySample caps at 8KB. Sitemaps routinely exceed 8KB
  // (a 5000-product sitemap is ~500KB; bullseyenorth's is 1.9MB). When
  // truncated, re-fetch the full body using the SAME transport that Module 1
  // successfully used. Respecting Module 1's method is load-bearing:
  // Celerant's malformed headers make axios fail HPE; only native-fetch works.
  // Falling back to axios for the re-fetch discards the work Module 1 did.
  if (r.bodySample && r.bodyBytes > r.bodySample.length) {
    if (r.method === 'playwright') {
      // Playwright returns the full rendered body; if sample is still
      // truncated, something's wrong — fall back to sample.
      return { status: r.status, body: r.bodySample, method: r.method, errMsg: null };
    }
    const userAgent =
      ua === 'iphone'
        ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1'
        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const headers = {
      'User-Agent': userAgent,
      Accept: 'application/xml,text/xml,*/*;q=0.8',
    };

    // If Module 1 used native-fetch (HPE fallback), re-fetch via native fetch.
    // Node's default fetch is lenient for Celerant-style trailing-space headers.
    if (r.method === 'native-fetch') {
      try {
        const resp = await fetch(url, {
          headers,
          redirect: 'follow',
          signal: AbortSignal.timeout(20000),
        });
        const body = await resp.text();
        return { status: resp.status, body, method: 'native-fetch', errMsg: null };
      } catch (e: any) {
        return {
          status: r.status,
          body: r.bodySample,
          method: r.method,
          errMsg: `full-body native re-fetch failed: ${e?.message || e}`,
        };
      }
    }

    // Module 1 used axios — try axios first, fall back to native fetch on HPE.
    try {
      const axios = (await import('axios')).default;
      const resp = await axios.get(url, {
        timeout: 20000,
        maxRedirects: 10,
        validateStatus: () => true,
        responseType: 'text',
        headers,
      });
      const body = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
      return { status: resp.status, body, method: 'axios', errMsg: null };
    } catch (e: any) {
      const msg = e?.message || String(e);
      // HPE fallback — same escalation Module 1 does.
      if (/parse error|hpe_invalid|invalid header/i.test(msg)) {
        try {
          const resp = await fetch(url, {
            headers,
            redirect: 'follow',
            signal: AbortSignal.timeout(20000),
          });
          const body = await resp.text();
          return { status: resp.status, body, method: 'native-fetch', errMsg: null };
        } catch (e2: any) {
          return {
            status: r.status,
            body: r.bodySample,
            method: r.method,
            errMsg: `full-body axios→native re-fetch failed: ${e2?.message || e2}`,
          };
        }
      }
      return {
        status: r.status,
        body: r.bodySample,
        method: r.method,
        errMsg: `full-body re-fetch failed: ${msg}`,
      };
    }
  }

  // Body fits in the sample — use it directly.
  return { status: r.status, body: r.bodySample, method: r.method, errMsg: null };
}

// ── Main public API ──────────────────────────────────────────────────────────

export interface RunProbeSitemapOpts {
  ua?: UaMode;
  maxSubSitemaps?: number;
}

export async function runProbeSitemap(
  originInput: string,
  opts: RunProbeSitemapOpts = {},
): Promise<ProbeSitemapResult> {
  const origin = normalizeOrigin(originInput);
  const ua: UaMode = opts.ua || 'desktop';
  const maxSubSitemaps = opts.maxSubSitemaps ?? DEFAULT_MAX_SUB_SITEMAPS;

  const sitemapsChecked: string[] = [];
  const sitemapsFound: SitemapFound[] = [];
  const errors: SitemapError[] = [];
  const warnings: string[] = [];
  const productUrlsAggregate: string[] = [];
  // Absolute-URL dedupe — prevents double-counting when
  // /sitemap_index.xml lists /product-sitemap.xml AND the candidate list
  // ALSO probes /product-sitemap.xml directly.
  const countedSitemaps = new Set<string>();
  let subSitemapsFollowed = 0;

  // ── Step 1: robots.txt discovery ─────────────────────────────────────────
  log(`[probe-sitemap] ${origin} — checking robots.txt`);
  const robotsUrl = `${origin}/robots.txt`;
  sitemapsChecked.push(robotsUrl);
  const robotsFetch = await fetchForProbe(robotsUrl, { ua, mode: 'auto', accept: 'html' });
  let robotsSitemaps: string[] = [];
  if (robotsFetch.status === 200 && robotsFetch.bodySample) {
    robotsSitemaps = parseRobotsSitemaps(robotsFetch.bodySample, origin);
    if (robotsSitemaps.length > 0) {
      log(`  robots.txt declared ${robotsSitemaps.length} Sitemap: entries`);
    }
  }

  // ── Step 2: build candidate list ──────────────────────────────────────────
  // robots.txt sitemaps first, then canonical fallbacks. Dedup absolute URLs.
  const candidateQueue: string[] = [];
  const seenCandidates = new Set<string>();
  const pushCandidate = (abs: string) => {
    if (!seenCandidates.has(abs)) {
      seenCandidates.add(abs);
      candidateQueue.push(abs);
    }
  };
  for (const u of robotsSitemaps) pushCandidate(u);
  for (const path of SITEMAP_CANDIDATES) pushCandidate(`${origin}${path}`);

  // ── Step 3: process candidates ────────────────────────────────────────────
  // We process all top-level candidates first. Sitemap indices get their
  // children queued for follow-up. Children are tracked separately so they
  // count against maxSubSitemaps.
  interface ChildTask {
    url: string;
    parentUrl: string;
    isProductNamed: boolean;
  }
  const childQueue: ChildTask[] = [];

  for (const candidate of candidateQueue) {
    if (countedSitemaps.has(candidate)) continue;
    if (!sitemapsChecked.includes(candidate)) sitemapsChecked.push(candidate);

    const fetched = await fetchSitemapFull(candidate, ua);
    if (fetched.status !== 200 || !fetched.body) {
      if (fetched.errMsg) errors.push({ url: candidate, message: fetched.errMsg });
      continue;
    }
    if (!looksLikeXml(fetched.body)) {
      // Body came back non-XML despite 200 status — typically a WAF challenge
      // page (Cloudflare "Just a moment...") or a CMS-custom 404 HTML shell.
      // Record so skill knows why a candidate yielded nothing.
      if (/<title>\s*Just a moment|cf-browser-verification|cloudflare/i.test(fetched.body.slice(0, 2048))) {
        errors.push({ url: candidate, message: 'Cloudflare challenge returned instead of XML' });
      } else if (/<!doctype html|<html/i.test(fetched.body.slice(0, 200))) {
        errors.push({ url: candidate, message: 'HTML returned instead of XML (likely 404 page served with 200)' });
      }
      continue;
    }

    countedSitemaps.add(candidate);

    const locs = extractLocs(fetched.body);
    if (isSitemapIndex(fetched.body)) {
      // Sitemap index — enqueue children.
      const sorted: { url: string; isProduct: boolean }[] = locs.map((u) => ({
        url: u,
        isProduct: PRODUCT_SM_RE.test(u),
      }));
      // Product-named children prioritized; cap non-product children separately.
      const productChildren = sorted.filter((c) => c.isProduct).slice(0, maxSubSitemaps);
      const otherChildren = sorted.filter((c) => !c.isProduct).slice(0, MAX_OTHER_SUB_SITEMAPS);

      sitemapsFound.push({
        url: candidate,
        type: 'index',
        urls: locs.length,
        products: 0, // indexes themselves don't have products; children do
        method: fetched.method || 'axios',
      });

      for (const c of [...productChildren, ...otherChildren]) {
        if (!countedSitemaps.has(c.url)) {
          childQueue.push({ url: c.url, parentUrl: candidate, isProductNamed: c.isProduct });
        }
      }
    } else {
      // Regular urlset.
      const { products } = classifyLocs(locs);
      productUrlsAggregate.push(...products);
      sitemapsFound.push({
        url: candidate,
        type: 'urlset',
        urls: locs.length,
        products: products.length,
        method: fetched.method || 'axios',
      });
      if (locs.length > 0 && products.length === 0) {
        warnings.push(
          `${candidate}: ${locs.length} <loc> entries, 0 matched product pattern — may be nav-only sitemap`,
        );
      } else if (locs.length === 1) {
        warnings.push(`${candidate}: single <loc> — may not be a product sitemap`);
      }
    }
  }

  // ── Step 4: process child queue (sitemap index fan-out) ──────────────────
  for (const child of childQueue) {
    if (subSitemapsFollowed >= maxSubSitemaps && !child.isProductNamed) {
      // Already over budget for non-product children.
      continue;
    }
    if (subSitemapsFollowed >= maxSubSitemaps + MAX_OTHER_SUB_SITEMAPS) break;
    if (countedSitemaps.has(child.url)) continue;
    sitemapsChecked.push(child.url);
    countedSitemaps.add(child.url);
    subSitemapsFollowed++;

    const fetched = await fetchSitemapFull(child.url, ua);
    if (fetched.status !== 200 || !fetched.body) {
      if (fetched.errMsg) errors.push({ url: child.url, message: fetched.errMsg });
      continue;
    }
    if (!looksLikeXml(fetched.body)) continue;

    const locs = extractLocs(fetched.body);

    // A child can itself be a nested index (rare — seen in Wix and some
    // multi-locale sites). Follow one more level only; don't recurse
    // indefinitely.
    if (isSitemapIndex(fetched.body)) {
      sitemapsFound.push({
        url: child.url,
        type: 'index',
        urls: locs.length,
        products: 0,
        method: fetched.method || 'axios',
      });
      const nestedCap = Math.min(locs.length, 10); // cap nested recursion
      for (let i = 0; i < nestedCap; i++) {
        const nestedUrl = locs[i];
        if (countedSitemaps.has(nestedUrl)) continue;
        sitemapsChecked.push(nestedUrl);
        countedSitemaps.add(nestedUrl);
        subSitemapsFollowed++;
        const nestedFetched = await fetchSitemapFull(nestedUrl, ua);
        if (nestedFetched.status !== 200 || !nestedFetched.body) {
          if (nestedFetched.errMsg) errors.push({ url: nestedUrl, message: nestedFetched.errMsg });
          continue;
        }
        if (!looksLikeXml(nestedFetched.body)) continue;
        if (isSitemapIndex(nestedFetched.body)) {
          // Don't recurse further — flag warning.
          warnings.push(`${nestedUrl}: nested sitemap index at depth 3+ — stopped following`);
          continue;
        }
        const nLocs = extractLocs(nestedFetched.body);
        const { products } = classifyLocs(nLocs);
        productUrlsAggregate.push(...products);
        sitemapsFound.push({
          url: nestedUrl,
          type: 'urlset',
          urls: nLocs.length,
          products: products.length,
          method: nestedFetched.method || 'axios',
        });
      }
      continue;
    }

    const { products } = classifyLocs(locs);
    productUrlsAggregate.push(...products);
    sitemapsFound.push({
      url: child.url,
      type: 'urlset',
      urls: locs.length,
      products: products.length,
      method: fetched.method || 'axios',
    });
  }

  // ── Step 5: dedupe product URLs across sub-sitemaps ──────────────────────
  // Sitemap shards can be byte-identical duplicates (per playbook: triggersandbows
  // ecstore-1-sitemap.xml = ecstore-2-sitemap.xml). Dedupe via Set on the
  // final aggregate — not on a per-sitemap basis, because legitimate pagination
  // shards (Shopify sitemap_products_1, _2) should NOT overlap.
  const uniqueProductUrls = Array.from(new Set(productUrlsAggregate));
  const duplicatesDropped = productUrlsAggregate.length - uniqueProductUrls.length;
  if (duplicatesDropped > 0) {
    warnings.push(
      `${duplicatesDropped} duplicate product URLs across sub-sitemaps (possible shard duplication — check md5)`,
    );
  }
  const totalProductUrls = uniqueProductUrls.length;

  // ── Step 6: sample + pattern + confidence ─────────────────────────────────
  const productUrlSample = uniqueProductUrls.slice(0, PRODUCT_SAMPLE_LIMIT);
  const productUrlPattern = dominantPattern(uniqueProductUrls);

  // Confidence:
  //   high — ≥3 sub-sitemaps concur on the product URL pattern, OR single
  //          sitemap/urlset with ≥100 product URLs
  //   medium — 10-99 product URLs
  //   low — <10 URLs or pattern inconsistency
  //   none — no sitemap found
  const urlsetsFound = sitemapsFound.filter((s) => s.type === 'urlset' && s.products > 0);
  let confidence: 'high' | 'medium' | 'low' | 'none';
  if (sitemapsFound.length === 0) {
    confidence = 'none';
  } else if (urlsetsFound.length >= 3 || totalProductUrls >= 100) {
    confidence = 'high';
  } else if (totalProductUrls >= 10) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  return {
    origin,
    sitemapsChecked,
    sitemapsFound,
    subSitemapsFollowed,
    totalProductUrls,
    productUrlSample,
    productUrlPattern,
    confidence,
    warnings,
    errors,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { origin: string; opts: RunProbeSitemapOpts } | null {
  const positional: string[] = [];
  const opts: RunProbeSitemapOpts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ua') {
      const v = argv[++i];
      if (v === 'desktop' || v === 'iphone') opts.ua = v;
      else return null;
    } else if (a === '--max-sub-sitemaps') {
      const v = argv[++i];
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return null;
      opts.maxSubSitemaps = n;
    } else if (a.startsWith('--')) {
      return null;
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 1) return null;
  return { origin: positional[0], opts };
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) {
    process.stderr.write(
      'usage: probe-sitemap.ts <origin> [--ua desktop|iphone] [--max-sub-sitemaps <N>]\n',
    );
    return 2;
  }
  const result = await runProbeSitemap(parsed.origin, parsed.opts);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  await closePlaywrightIfUsed();
  return result.sitemapsFound.length > 0 ? 0 : 1;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`probe-sitemap crashed: ${e?.stack || e?.message || e}\n`);
      process.exit(2);
    });
}
