/**
 * probe-catalog-urls.ts — Module 5 of the decomposed pre-bootstrap probe.
 *
 * Single responsibility: given a canonical origin, emit RAW catalog URL
 * candidates from multiple orthogonal sources. Does NOT rank, dedupe, score
 * relevance, drop "too-small" categories, or pick a final catalogUrls[] —
 * those decisions are the skill's job.
 *
 * Sources emitted (all run unconditionally; 404s are no-ops):
 *   1. nav-menu           — <a href> inside <nav>/<header>/[class*=nav]/[id*=menu]
 *                           filtered to same-origin, minus obvious non-category
 *                           paths (cart, login, about, blog...). Label = anchor
 *                           text. This is the primary source for platforms with
 *                           no public taxonomy API (BC Stencil, Celerant).
 *   2. homepage-anchor    — every <a href> on the homepage matching positive
 *                           category-URL patterns (/category/, /product-category/,
 *                           /collections/, /shop/, /c/). Catches sites where nav
 *                           is driven by mega-menus that render outside <nav>.
 *   3. wp-taxonomy-api    — /wp-json/wp/v2/product_cat?per_page=100&hide_empty=true
 *                           returns WooCommerce category tree with name, slug, link,
 *                           count, parent. Best source when available (authoritative).
 *   4. shopify-collections — /collections.json?limit=250 returns collections with
 *                           handle, title, products_count. Shopify-specific but
 *                           we always try (no platform gate — fails fast on 404).
 *   5. bc-categories      — /api/v2/catalog/categories — rarely public on BC
 *                           Stencil, but harmless to probe.
 *   6. sitemap-dirname    — take product URLs from sitemap, group by directory
 *                           prefix, emit prefixes with ≥3 products as candidates.
 *                           Uses probe-sitemap (Module 2) under the hood when
 *                           caller doesn't pass --sitemap-url.
 *
 * CRITICAL design decisions (Mistakes 4, 5, 12 from crawler-specialist.md):
 *   - NO site-specific branches. Every source runs the same generic logic for
 *     every origin. API probes fail fast on 404.
 *   - NO ranking. The output is a flat list of candidates — the skill composes
 *     them into the final catalogUrls[] using its own priority rules.
 *   - NO dropping by size. Even candidates with productCount=1 are emitted.
 *     The full-coverage rule (user-enforced 2026-04-10 truenortharms.com) lives
 *     in the skill, not the probe.
 *   - NO sub-category-tile detection. probe-extraction (Module 6) handles that
 *     per-URL when each candidate is tested.
 *
 * CLI:
 *   npx tsx scripts/probe-modules/probe-catalog-urls.ts <origin>
 *     [--ua desktop|iphone|custom:<string>]
 *     [--sitemap-url <url>]            (optional — skip auto-sitemap discovery)
 *     [--waf-suspected]
 *
 * Output: JSON to stdout. Progress to stderr.
 * Exit: 0 if ≥1 candidate found; 1 if none; 2 on bad args.
 */

import { fetchForProbe, closePlaywrightIfUsed, UaMode, ProbeFetchResult } from './probe-fetch';
import { runProbeSitemap } from './probe-sitemap';

// cheerio is lazy-loaded inside extractNavLinks/extractHomepageAnchors — see
// NOTE: loading cheerio at module-top triggers an interaction with Node's
// undici HTTP parser that breaks the lenient `fetch()` fallback for malformed
// HTTP responses (Celerant-style trailing-space headers). Reproduced with a
// minimal harness: a single `import * as cheerio from 'cheerio'` at module top
// turns native-fetch's "lenient" parse into strict, causing bullseyenorth.com
// to fail with `fetch failed (cause: Response does not match the HTTP/1.1
// protocol (Invalid header token))` even though axios-HPE → native-fetch is
// the correct escalation path. Moving cheerio inside the functions that use
// it — loaded via a dynamic `import()` — restores native-fetch's lenient
// behavior. Root cause: one of cheerio's transitive deps (parse5, entities,
// domhandler, htmlparser2, etc.) almost certainly monkey-patches something in
// the http / HTTP-parser stack at module init. Lazy-loading isolates that.
//
// Type alias — cheerio's CheerioAPI is `any`-compatible for our purposes
// (we only call `.each`, `.attr`, `.text`, and the returned $ function).
// Keep this typed loosely to avoid requiring the cheerio namespace at
// module top.
type CheerioAPI = (sel: string) => any;

// ── Types ────────────────────────────────────────────────────────────────────

export type CandidateSource =
  | 'nav-menu'
  | 'wp-taxonomy-api'
  | 'shopify-collections'
  | 'bc-categories'
  | 'sitemap-dirname'
  | 'homepage-anchor';

export interface CatalogUrlCandidate {
  url: string;
  source: CandidateSource;
  label: string | null;
  productCount: number | null;
  parent: string | null;
}

export interface TaxonomyApiProbe {
  url: string;
  status: number | null;
  count: number | null;
  sample: string;
}

export interface ProbeCatalogUrlsResult {
  origin: string;
  candidates: CatalogUrlCandidate[];
  taxonomyApiReachable: {
    wpV2ProductCat: TaxonomyApiProbe | null;
    shopifyCollections: TaxonomyApiProbe | null;
    bcCategories: TaxonomyApiProbe | null;
  };
  navLinkCount: number;
  totalCandidates: number;
  warnings: string[];
}

export interface RunProbeCatalogUrlsOpts {
  ua?: UaMode;
  sitemapUrl?: string;
  wafSuspected?: boolean;
}

// ── Constants ────────────────────────────────────────────────────────────────

const log = (msg: string) => process.stderr.write(msg + '\n');

/**
 * Paths we KNOW are not categories. Minimal list — we don't try to be
 * exhaustive; false negatives just produce a candidate that probe-extraction
 * will later reject. The rule: better to over-emit than under-emit.
 */
const NON_CATEGORY_PATH_RE =
  /\/(cart|checkout|account|login|register|logout|my-account|wishlist|search|contact|contact-us|about|about-us|faq|help|support|terms|privacy|policy|policies|shipping|returns|warranty|store-locator|locations|careers|jobs|blog|news|press|feed|rss|sitemap|robots\.txt|api\b|graphql|wp-admin|wp-login|wp-content|wp-includes|admin|dashboard)\b/i;

/**
 * Heuristic positive patterns for homepage-anchor source. Broader than
 * nav-menu because many sites put their primary catalog links in mega-menus
 * that render OUTSIDE semantic <nav>/<header> tags.
 */
const CATEGORY_PATH_PATTERNS: RegExp[] = [
  /\/product-category\//i, // WooCommerce
  /\/product_category\//i,
  /\/category\//i, // generic / OpenCart / Magento
  /\/categories\//i,
  /\/collections\/[^\/?#]+\/?$/i, // Shopify — /collections/<handle>
  /\/c\/[^\/?#]+\/?$/i, // some BC / custom
  /\/shop\/[^\/]+\/?$/i, // /shop/<something> — guarded against /shop alone
  /\/store\/[^\/]+\/?$/i,
  /\/department\//i, // legacy
  /\/brand\//i, // often a valid catalog axis
  /\/brands\//i,
  /\/tag\//i, // WooCommerce product tag
  /\/taxonomy\//i,
];

// ── Nav-menu extraction ──────────────────────────────────────────────────────

/**
 * Resolve a href to an absolute URL within the same origin. Returns null if:
 *   - href is empty, `#`, `/`, mailto:, tel:, javascript:
 *   - href resolves to a different origin
 *   - resolution throws (malformed href)
 */
function resolveSameOrigin(href: string, origin: string): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed || trimmed === '#' || trimmed === '/') return null;
  if (/^(mailto:|tel:|javascript:|sms:|ftp:)/i.test(trimmed)) return null;
  if (trimmed.startsWith('#')) return null;
  try {
    const u = new URL(trimmed, origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const originHost = new URL(origin).host;
    if (u.host !== originHost) return null;
    // Drop the fragment — fragments don't change the resource. Query strings are
    // preserved (many sort/filter-style URLs are valid catalog entry points).
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

interface NavLinkRaw {
  url: string;
  label: string;
}

/**
 * Extract <a href> elements from nav-like containers. The selector set matches
 * what the old monolith probeCatalog used (verified compatible with BC Stencil,
 * Shopify, WooCommerce, Celerant nav markup).
 */
function extractNavLinks($: CheerioAPI, origin: string): NavLinkRaw[] {
  const out: NavLinkRaw[] = [];
  const seen = new Set<string>();
  const selector =
    'nav a[href], header a[href], [class*="nav"] a[href], [class*="menu"] a[href], [id*="menu"] a[href], [id*="nav"] a[href], [class*="mega-menu"] a[href], [class*="navigation"] a[href]';
  $(selector).each((_, el) => {
    const href = $(el).attr('href') || '';
    const abs = resolveSameOrigin(href, origin);
    if (!abs) return;
    if (seen.has(abs)) return;
    // Skip obvious non-category paths.
    let path: string;
    try {
      path = new URL(abs).pathname;
    } catch {
      return;
    }
    if (NON_CATEGORY_PATH_RE.test(path)) return;
    // Reject the homepage itself (path "/" or "").
    if (path === '/' || path === '') return;
    seen.add(abs);
    const label = ($(el).text() || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    out.push({ url: abs, label });
  });
  return out;
}

/**
 * Extract EVERY <a href> on the page that matches a category-URL pattern.
 * Complements nav-menu for sites where the catalog links live outside
 * semantic nav tags (mega-menus injected via JS, footer category blocks,
 * etc.).
 */
function extractHomepageAnchors($: CheerioAPI, origin: string): NavLinkRaw[] {
  const out: NavLinkRaw[] = [];
  const seen = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const abs = resolveSameOrigin(href, origin);
    if (!abs) return;
    if (seen.has(abs)) return;
    let path: string;
    try {
      path = new URL(abs).pathname;
    } catch {
      return;
    }
    if (NON_CATEGORY_PATH_RE.test(path)) return;
    if (path === '/' || path === '') return;
    // Must match a category-URL pattern — homepage-anchor is stricter than
    // nav-menu because we're scanning the ENTIRE document, not just nav areas.
    if (!CATEGORY_PATH_PATTERNS.some((re) => re.test(abs))) return;
    seen.add(abs);
    const label = ($(el).text() || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    out.push({ url: abs, label });
  });
  return out;
}

// ── Taxonomy API probes ──────────────────────────────────────────────────────

async function probeWpV2ProductCat(
  origin: string,
  ua: UaMode,
  wafSuspected: boolean,
): Promise<{ probe: TaxonomyApiProbe; candidates: CatalogUrlCandidate[] }> {
  const url = `${origin}/wp-json/wp/v2/product_cat?per_page=100&hide_empty=true`;
  // fullBody: true — WP REST category responses on large stores can exceed 8KB
  // (100 categories x ~200 bytes of nested meta each = ~20KB). We need the full
  // JSON document to parse.
  const r = await fetchForProbe(url, {
    ua,
    mode: 'static',
    accept: 'json',
    timeoutMs: 15_000,
    fullBody: true,
    wafSuspected,
  });
  const probe: TaxonomyApiProbe = {
    url,
    status: r.status,
    count: null,
    sample: (r.bodySample || '').slice(0, 1024),
  };
  const candidates: CatalogUrlCandidate[] = [];
  let parsedOk = false;
  if (r.status === 200 && r.bodySample) {
    try {
      const parsed = JSON.parse(r.bodySample);
      if (Array.isArray(parsed)) {
        parsedOk = true;
        probe.count = parsed.length;
        // Build an id → link map so we can resolve `parent` (WP returns parent
        // as an integer ID; we want the URL of the parent category).
        const idToLink = new Map<number, string>();
        for (const cat of parsed) {
          if (typeof cat?.id === 'number' && typeof cat?.link === 'string') {
            idToLink.set(cat.id, cat.link);
          }
        }
        for (const cat of parsed) {
          const catUrl: string | null = typeof cat?.link === 'string' ? cat.link : null;
          if (!catUrl) continue;
          const parentId: number = typeof cat?.parent === 'number' ? cat.parent : 0;
          candidates.push({
            url: catUrl,
            source: 'wp-taxonomy-api',
            label: typeof cat?.name === 'string' ? cat.name.slice(0, 80) : null,
            productCount: typeof cat?.count === 'number' ? cat.count : null,
            parent: parentId > 0 ? idToLink.get(parentId) ?? null : null,
          });
        }
      }
    } catch {
      // Non-JSON body or malformed
    }
  }
  // If we claimed status=200 but couldn't parse the expected JSON shape, the
  // endpoint is not actually serving the API — it's a 200 HTML fallback page
  // (common on Celerant/ColdFusion, nopCommerce, other "200 for everything"
  // platforms). Nullify status so the skill/test layer doesn't misread this
  // as a reachable API.
  if (r.status === 200 && !parsedOk) probe.status = null;
  return { probe, candidates };
}

async function probeShopifyCollections(
  origin: string,
  ua: UaMode,
  wafSuspected: boolean,
): Promise<{ probe: TaxonomyApiProbe; candidates: CatalogUrlCandidate[] }> {
  const url = `${origin}/collections.json?limit=250`;
  const r = await fetchForProbe(url, {
    ua,
    mode: 'static',
    accept: 'json',
    timeoutMs: 15_000,
    fullBody: true,
    wafSuspected,
  });
  const probe: TaxonomyApiProbe = {
    url,
    status: r.status,
    count: null,
    sample: (r.bodySample || '').slice(0, 1024),
  };
  const candidates: CatalogUrlCandidate[] = [];
  let parsedOk = false;
  if (r.status === 200 && r.bodySample) {
    try {
      const parsed = JSON.parse(r.bodySample);
      if (parsed && Array.isArray(parsed.collections)) {
        parsedOk = true;
        probe.count = parsed.collections.length;
        for (const col of parsed.collections) {
          if (typeof col?.handle !== 'string') continue;
          const collectionUrl = `${origin}/collections/${col.handle}`;
          candidates.push({
            url: collectionUrl,
            source: 'shopify-collections',
            label: typeof col?.title === 'string' ? col.title.slice(0, 80) : null,
            productCount:
              typeof col?.products_count === 'number' ? col.products_count : null,
            parent: null, // Shopify /collections.json doesn't expose nesting
          });
        }
      }
    } catch {
      // drop
    }
  }
  if (r.status === 200 && !parsedOk) probe.status = null;
  return { probe, candidates };
}

async function probeBcCategories(
  origin: string,
  ua: UaMode,
  wafSuspected: boolean,
): Promise<{ probe: TaxonomyApiProbe; candidates: CatalogUrlCandidate[] }> {
  // /api/v2/catalog/categories is the BigCommerce v2 storefront endpoint.
  // Rarely public on Stencil stores (requires tokens), but occasionally
  // reachable on Blueprint. Harmless to probe.
  const url = `${origin}/api/v2/catalog/categories`;
  const r = await fetchForProbe(url, {
    ua,
    mode: 'static',
    accept: 'json',
    timeoutMs: 10_000,
    fullBody: true,
    wafSuspected,
  });
  const probe: TaxonomyApiProbe = {
    url,
    status: r.status,
    count: null,
    sample: (r.bodySample || '').slice(0, 1024),
  };
  const candidates: CatalogUrlCandidate[] = [];
  let parsedOk = false;
  if (r.status === 200 && r.bodySample) {
    try {
      const parsed = JSON.parse(r.bodySample);
      // BC V2 returns a flat array; some variants wrap in {data:[...]}. Handle both.
      const arr: any[] = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.data)
          ? parsed.data
          : [];
      if (arr.length > 0) {
        parsedOk = true;
        probe.count = arr.length;
        for (const cat of arr) {
          // BC v2 category shape: { id, parent_id, name, custom_url: { url } }.
          const customUrl = cat?.custom_url?.url;
          if (typeof customUrl !== 'string' || !customUrl) continue;
          const fullUrl = customUrl.startsWith('http')
            ? customUrl
            : `${origin}${customUrl.startsWith('/') ? '' : '/'}${customUrl}`;
          candidates.push({
            url: fullUrl,
            source: 'bc-categories',
            label: typeof cat?.name === 'string' ? cat.name.slice(0, 80) : null,
            productCount: null, // BC v2 category does not return product_count in the core response
            parent: null, // parent_id is an integer; resolving to URL would need a second pass — leave null
          });
        }
      }
    } catch {
      // drop
    }
  }
  if (r.status === 200 && !parsedOk) probe.status = null;
  return { probe, candidates };
}

// ── Sitemap-dirname grouping ─────────────────────────────────────────────────

/**
 * Given a list of product URLs (sourced from sitemap), group by directory
 * prefix. Each prefix with ≥3 products is emitted as a candidate.
 *
 * Example input:
 *   /product-category/firearms/rifles/xyz-p12345
 *   /product-category/firearms/rifles/abc-p23456
 *   /product-category/firearms/rifles/def-p34567
 *   /product-category/firearms/shotguns/ghi-p45678
 *
 * Output prefixes (≥3 products):
 *   /product-category/firearms/rifles/ → count 3
 *
 * We emit BOTH the deepest qualifying prefix AND all parent prefixes that
 * also qualify. That matches the "100% coverage" rule — if /firearms has
 * enough products AND /firearms/rifles does too, emit both. The skill decides
 * which level to keep.
 */
function groupByDirname(
  productUrls: string[],
  origin: string,
  minPerPrefix = 3,
): CatalogUrlCandidate[] {
  const prefixCounts = new Map<string, number>();
  const originHost = (() => {
    try {
      return new URL(origin).host;
    } catch {
      return '';
    }
  })();
  for (const url of productUrls) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      continue;
    }
    if (u.host !== originHost) continue;
    const segments = u.pathname.split('/').filter(Boolean);
    // Walk each prefix except the last (final segment is the product slug
    // itself; a prefix of the full path would mean "just this product").
    for (let i = 1; i < segments.length; i++) {
      const prefix = '/' + segments.slice(0, i).join('/') + '/';
      prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1);
    }
  }
  const out: CatalogUrlCandidate[] = [];
  for (const [prefix, count] of prefixCounts.entries()) {
    if (count < minPerPrefix) continue;
    // Reject prefixes that are obvious non-category paths.
    if (NON_CATEGORY_PATH_RE.test(prefix)) continue;
    // Reject the root "/" (happens when all products are top-level).
    if (prefix === '/' || prefix === '') continue;
    out.push({
      url: `${origin}${prefix}`,
      source: 'sitemap-dirname',
      label: null,
      productCount: count,
      parent: null,
    });
  }
  return out;
}

/**
 * If caller passed --sitemap-url, fetch it directly and extract <loc> entries.
 * Otherwise delegate to probe-sitemap (Module 2) which has full discovery logic.
 * Returns product URLs (already classified by the positive/negative patterns
 * in Module 2 when we delegate; raw <loc> entries when --sitemap-url given).
 */
async function getSitemapProductUrls(
  origin: string,
  sitemapUrl: string | undefined,
  ua: UaMode,
): Promise<string[]> {
  if (sitemapUrl) {
    log(`[probe-catalog-urls] fetching explicit sitemap URL: ${sitemapUrl}`);
    // Single sitemap — fetch and extract <loc> entries, no classification.
    // We could import probe-sitemap's classifier, but given the caller has
    // specifically said "use this sitemap," trust them and return all <loc>s.
    const r = await fetchForProbe(sitemapUrl, {
      ua,
      mode: 'auto',
      accept: 'html', // sitemaps are XML but servers serve them fine under text/html accept
      timeoutMs: 20_000,
      fullBody: true,
    });
    if (r.status !== 200 || !r.bodySample) return [];
    const locs: string[] = [];
    const re = /<loc>\s*(?:<!\[CDATA\[)?([^<\]]+?)(?:\]\]>)?\s*<\/loc>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(r.bodySample)) !== null) {
      const url = m[1].trim();
      if (url) locs.push(url);
    }
    return locs;
  }
  // Delegate to Module 2 — it handles robots.txt → candidates → sub-sitemap
  // fan-out and returns classified product URLs. We accept whatever it finds.
  log(`[probe-catalog-urls] delegating sitemap discovery to probe-sitemap`);
  try {
    const smResult = await runProbeSitemap(origin, { ua });
    return smResult.productUrlSample || [];
    // productUrlSample is a capped sample; for deep classification we'd want
    // the full product list. probe-sitemap doesn't currently expose that — the
    // sample (20 URLs) is enough to reveal the dominant dirname pattern on
    // small catalogs. On large catalogs, the sample is biased toward the
    // first sub-sitemap followed, which is fine for dirname extraction
    // because directory structure is homogeneous across sub-sitemaps.
  } catch (e: any) {
    log(`[probe-catalog-urls] probe-sitemap threw: ${e?.message || e} — skipping sitemap-dirname`);
    return [];
  }
}

// ── Main public API ──────────────────────────────────────────────────────────

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

export async function runProbeCatalogUrls(
  inputOrigin: string,
  opts: RunProbeCatalogUrlsOpts = {},
): Promise<ProbeCatalogUrlsResult> {
  const origin = normalizeOrigin(inputOrigin);
  const ua: UaMode = opts.ua ?? 'desktop';
  const wafSuspected = opts.wafSuspected === true;
  const warnings: string[] = [];

  // ── Step 1: fetch homepage ─────────────────────────────────────────────────
  log(`[probe-catalog-urls] fetching homepage: ${origin} (ua=${ua})`);
  const homeR: ProbeFetchResult = await fetchForProbe(origin + '/', {
    ua,
    mode: 'auto',
    accept: 'html',
    timeoutMs: 20_000,
    fullBody: true,
    wafSuspected,
  });
  if (homeR.status === null) {
    warnings.push(
      `homepage fetch failed: ${homeR.errors.map((e) => e.message).join('; ').slice(0, 200)}`,
    );
  } else if (homeR.bodyBytes < 1000) {
    warnings.push(`homepage body too small (${homeR.bodyBytes}b) to extract nav links`);
  }
  // Track whether a WAF escalation was attempted — used later to decide if
  // zero-result extraction should produce a warning (escalation fired but
  // challenge likely unresolved, leaving the challenge-page body in place).
  const wafEscalated = homeR.escalations.includes('playwright-waf');

  // ── Step 2: nav-menu + homepage-anchor extraction ─────────────────────────
  const navCandidates: CatalogUrlCandidate[] = [];
  const anchorCandidates: CatalogUrlCandidate[] = [];
  let navLinkCount = 0;
  if (homeR.status !== null && homeR.bodySample) {
    // Lazy-load cheerio — see note at top of file for why module-top import
    // breaks the native-fetch HPE fallback path. By the time we reach here,
    // all the fetch() calls that need the lenient parser have already run.
    const { load: cheerioLoad } = await import('cheerio');
    const $ = cheerioLoad(homeR.bodySample);
    const navLinks = extractNavLinks($, origin);
    navLinkCount = navLinks.length;
    for (const nl of navLinks) {
      navCandidates.push({
        url: nl.url,
        source: 'nav-menu',
        label: nl.label || null,
        productCount: null,
        parent: null,
      });
    }
    const anchors = extractHomepageAnchors($, origin);
    for (const a of anchors) {
      anchorCandidates.push({
        url: a.url,
        source: 'homepage-anchor',
        label: a.label || null,
        productCount: null,
        parent: null,
      });
    }
    log(
      `[probe-catalog-urls] nav-menu=${navCandidates.length} homepage-anchor=${anchorCandidates.length}`,
    );
  } else {
    warnings.push('homepage body empty — skipping nav-menu + homepage-anchor extraction');
  }

  // ── Step 3: API probes (parallel) ─────────────────────────────────────────
  log(`[probe-catalog-urls] probing taxonomy APIs in parallel`);
  const [wpRes, shopifyRes, bcRes] = await Promise.all([
    probeWpV2ProductCat(origin, ua, wafSuspected),
    probeShopifyCollections(origin, ua, wafSuspected),
    probeBcCategories(origin, ua, wafSuspected),
  ]);
  log(
    `  wp-v2=${wpRes.probe.status ?? 'err'}/${wpRes.candidates.length} ` +
      `shopify=${shopifyRes.probe.status ?? 'err'}/${shopifyRes.candidates.length} ` +
      `bc=${bcRes.probe.status ?? 'err'}/${bcRes.candidates.length}`,
  );

  // ── Step 4: sitemap-dirname grouping ──────────────────────────────────────
  log(`[probe-catalog-urls] sitemap-dirname grouping…`);
  const productUrls = await getSitemapProductUrls(origin, opts.sitemapUrl, ua);
  const dirnameCandidates = groupByDirname(productUrls, origin, 3);
  log(
    `[probe-catalog-urls] sitemap yielded ${productUrls.length} product URLs → ${dirnameCandidates.length} dirname prefixes (min 3/prefix)`,
  );

  // ── Step 5: assemble candidates ────────────────────────────────────────────
  const candidates: CatalogUrlCandidate[] = [
    ...navCandidates,
    ...anchorCandidates,
    ...wpRes.candidates,
    ...shopifyRes.candidates,
    ...bcRes.candidates,
    ...dirnameCandidates,
  ];

  // Final diagnostic: if WAF escalation fired earlier AND we still got zero
  // candidates, the challenge was likely never solved — warn the skill layer.
  if (wafEscalated && candidates.length === 0) {
    warnings.push(
      `WAF challenge likely unresolved — Playwright escalated but no catalog URL candidates were extracted from any source`,
    );
  }

  return {
    origin,
    candidates,
    taxonomyApiReachable: {
      wpV2ProductCat: wpRes.probe,
      shopifyCollections: shopifyRes.probe,
      bcCategories: bcRes.probe,
    },
    navLinkCount,
    totalCandidates: candidates.length,
    warnings,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(
  argv: string[],
): { origin: string; opts: RunProbeCatalogUrlsOpts } | null {
  const positional: string[] = [];
  const opts: RunProbeCatalogUrlsOpts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ua') {
      const v = argv[++i];
      if (v === 'desktop' || v === 'iphone') opts.ua = v;
      else if (v?.startsWith('custom:')) opts.ua = v as UaMode;
      else return null;
    } else if (a === '--sitemap-url') {
      const v = argv[++i];
      if (!v) return null;
      opts.sitemapUrl = v;
    } else if (a === '--waf-suspected') {
      opts.wafSuspected = true;
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
      'usage: probe-catalog-urls.ts <origin> [--ua desktop|iphone|custom:<string>] [--sitemap-url <url>] [--waf-suspected]\n',
    );
    return 2;
  }
  const result = await runProbeCatalogUrls(parsed.origin, parsed.opts);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  await closePlaywrightIfUsed();
  return result.totalCandidates > 0 ? 0 : 1;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`probe-catalog-urls crashed: ${e?.stack || e?.message || e}\n`);
      process.exit(1);
    });
}
