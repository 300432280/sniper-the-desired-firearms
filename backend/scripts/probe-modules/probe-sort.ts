/**
 * probe-sort.ts — Module 8 of the decomposed pre-bootstrap probe.
 *
 * Single responsibility: given ONE catalog URL, discover the sort scheme,
 * enumerate "newest" sort candidates, run ID-jump tests for each, and emit
 * a 3-outcome verdict (Mistake 29) plus a ranked list so the skill can pick
 * the canonical newest value (Mistake 36 — Celerant exposes multiple newest
 * candidates with different semantics; rank them by ID-jump score).
 *
 * Mechanism:
 *   1. Fetch the testUrl as-is (baseline). Use probe-extraction so we get
 *      raw HTML + first product ID + sort <select> definitions in one pass.
 *   2. Scan the baseline HTML for:
 *        - anchor-based sort options (Odoo/Drupal Views `<a href="?order=...">`)
 *        - path-scheme detection (`/orderby/<value>/` segments anywhere in
 *          anchor hrefs → sortScheme='path')
 *   3. Build the candidate list: all <select>-based options + anchor-based
 *      options + any `--extra-candidates` passed by the skill (OpenCart's
 *      hidden `p.date_added` per Mistake 21 is the canonical case).
 *   4. Filter to "newest-looking" candidates via the broadened NEWEST_REGEX
 *      (Mistake 38 added `\blatest\b`).
 *   5. Pick an alpha counter-control via the 4-tier cascade (Mistake 38):
 *      alpha → any price → popularity/rating → any non-newest option.
 *   6. For EACH newest candidate + the counter-control, fetch its URL via
 *      probe-extraction, capture first product, compute ID-jump score:
 *        - +2 if firstProduct !== baselineFirstProduct
 *        - +1 for each OTHER newest candidate whose firstProduct differs
 *          from this one (Mistake 36 cross-scoring)
 *   7. Emit the 3-outcome verdict (Mistake 29):
 *        - 'honored'                 — top newest differs from default
 *        - 'honored-default-is-newest' — top newest == default BUT alpha
 *                                         control differs → default IS newest
 *        - 'noop-small'              — <20 products, too few to reorder
 *        - 'noop-large'              — plenty of products but nothing differs
 *        - 'unknown'                 — baseline failed or 0 products
 *      and `rankedNewest` sorted desc by score so skill picks [0].
 *
 * Scope boundaries (what this module does NOT do):
 *   - Pagination (Module 9)
 *   - Watermark-method decision (skill — needs sort + API accessibility)
 *   - Platform-specific URL mutations (Volusion `searching=Y`, etc.) —
 *     the skill either pre-bakes those into the testUrl OR passes known
 *     working values via --extra-candidates
 *   - Driving Playwright UI to click sort dropdowns (Searchspring hash
 *     discovery etc. — Mistake 25 — is a separate one-off script the skill
 *     writes when needed)
 *
 * CLI:
 *   npx tsx scripts/probe-modules/probe-sort.ts <catalogUrl>
 *     [--ua desktop|iphone|custom:<string>]
 *     [--mode static|playwright|auto]
 *     [--extra-candidates val1,val2,val3]
 *     [--waf-suspected]
 *     [--timeout <ms>]
 *
 * Output: JSON to stdout. Progress to stderr.
 * Exit: 0 on success; 1 if baseline fetch failed; 2 on bad args.
 */

import { fetchForProbe, closePlaywrightIfUsed, UaMode, FetchMode } from './probe-fetch';
import { runProbeExtraction, ExtractedProduct } from './probe-extraction';

// Cheerio type alias — see note in probe-extraction.ts for why we lazy-load.
type CheerioAPI = any;

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Broadened "newest" regex. Captures:
 *   - WooCommerce default:   text="Sort by latest", value="date"
 *   - Shopify default:       text="Date, new to old", value="created-descending"
 *   - BC Stencil default:    text="Newest Items", value="newest"
 *   - Magento default:       text="Newest" or "Most Recent", value varies
 *   - Celerant default:      text="New Arrivals", value="new-arrivals" or "newest-rcvd"
 *   - Drupal Views anchors:  value="created&order=desc" / "date_pub&sort_order=DESC"
 *   - Ecwid storefront API:  value="addedTimeDesc" (no <select>, API only)
 *   - GoDaddy OLS SPA:       value="descend_by_created_at" (hash, not <select>)
 *
 * Must match against BOTH text (human label) and value (machine token) because
 * different vendors use different fields as the sort signal.
 */
const NEWEST_REGEX =
  /newest|new.to.old|most.recent|new[- ]?arrival|date.*desc|added.*desc|created.*desc|published.*desc|addedtimedesc|created-descending|published-descending|recent|posted|\bcreated\b|\bdate_pub\b|\blatest\b|\bdate$|^date\b|\bby date\b|\bsort by date\b/i;

/**
 * Negative filter — an option matching NEWEST_REGEX is REJECTED if it ALSO
 * matches this regex. Shopify's `created-ascending` (oldest-first) trips
 * NEWEST_REGEX via the `\bcreated\b` fragment, but the label "Date, old to new"
 * / value "created-ascending" clearly indicates oldest-first. Similarly for
 * "Oldest First", "Date, old to new", "Sort by oldest", `asc` on a date field.
 */
const OLDEST_REGEX =
  /oldest|old.to.new|date-ascending|created-ascending|published-ascending|date.*asc\b|created.*asc\b|published.*asc\b|added.*asc\b/i;

/**
 * Counter-control regexes — priority cascade for the 3-outcome sort test.
 * WooCommerce's default select has NO alpha sort, only popularity/rating/
 * date/price (Mistake 38). The counter must be ANY option that demonstrably
 * re-orders results so we can distinguish `honored-default-is-newest` from
 * `noop`.
 */
const COUNTER_REGEX = /alpha.*asc|name.*asc|\ba.*z\b|title.*asc|nameasc|alphaasc|name-?a-?to-?z/i;
const PRICE_REGEX = /\bprice\b|priceasc|price-low|price.*low|low.*high|high.*low|price-desc|pricedesc/i;
const POPULARITY_REGEX = /popularity|popular|bestseller|best.sell|trending|featured|rating/i;

/**
 * Path-sort detection. Some platforms (Celerant ColdFusion, a few OpenCart
 * themes, some LightSpeed configs) encode sort in the URL path as
 * `/orderby/<value>/` or `/sort/<value>/` rather than as a query parameter.
 * If we find any anchor with one of these path segments followed by an
 * identifier, sortScheme='path'.
 */
const PATH_SORT_REGEX = /\/(orderby|sort_by|sort-by|sort|order)\/([A-Za-z][A-Za-z0-9_-]+)\/?/;

/** Small-catalog threshold — below this, reordering has no observable effect. */
const SMALL_CATALOG_THRESHOLD = 20;

/** Sample size for `sampleProducts` on each candidate. */
const SAMPLE_SIZE = 3;

// ── Types ────────────────────────────────────────────────────────────────────

export type SortScheme = 'query' | 'path' | 'hash' | 'form-post' | 'none';

export type SortVerdict =
  | 'honored'
  | 'honored-default-is-newest'
  | 'noop-small'
  | 'noop-large'
  | 'unknown';

/**
 * A sort option surfaced from either a <select> dropdown or an anchor-based
 * sort control. `selectName` holds the query-param name (`sort`, `orderby`,
 * `product_list_order`, ...) for both <select>s and anchors; `selectId` is
 * only populated for <select>s. `value` is the raw option value which for
 * anchor-pair captures may include `&order=desc` tail (Drupal Views).
 */
export interface SortOptionRaw {
  selectId: string | null;
  selectName: string | null;
  value: string;
  text: string;
  /**
   * For path-scheme options: the FULL anchor href observed in the DOM. This
   * is load-bearing because path-scheme sites often require specific prefix
   * segments (Celerant's `/browse/`, some LightSpeed themes' `/c/`) that a
   * naive `base + /keyword/value` construction would miss. When present,
   * `buildSortUrl` uses this verbatim (with base-relative resolution) instead
   * of synthesizing from scratch. For query-scheme options this is null.
   */
  fullAnchorHref?: string | null;
}

export interface FirstProductSummary {
  title: string | null;
  url: string | null;
  sourceId: string | null;
}

export interface NewestCandidateResult {
  value: string;
  text: string;
  testedUrl: string;
  firstProductTitle: string | null;
  firstProductSourceId: string | null;
  /**
   * idJumpScore = +2 if differs from baseline + 1 per OTHER newest candidate
   * whose firstProduct differs from this one. A candidate with score >= 3
   * is strong evidence the sort is honored.
   */
  idJumpScore: number;
  sampleProducts: Array<{ title: string; url: string; sourceId: string | null }>;
}

export interface AlphaControlResult {
  value: string;
  text: string;
  testedUrl: string;
  firstProductTitle: string | null;
  firstProductSourceId: string | null;
}

export interface ProbeSortResult {
  testUrl: string;
  sortScheme: SortScheme;
  sortOptions: SortOptionRaw[];
  newestCandidates: NewestCandidateResult[];
  alphaControlResult: AlphaControlResult | null;
  baselineFirstProduct: FirstProductSummary | null;
  baselineProductCount: number;
  verdict: SortVerdict;
  verdictReason: string;
  /**
   * Newest candidates sorted desc by idJumpScore. Skill picks [0] as the
   * canonical newest. Tied scores preserve input order (first-listed wins).
   * Candidates whose fetch failed are assigned score = -1 and sort to the end.
   */
  rankedNewest: Array<{ value: string; score: number }>;
  wallMs: number;
}

export interface RunProbeSortOpts {
  ua?: UaMode;
  mode?: FetchMode;
  /** Extra candidate values the skill wants probed alongside discovered options
   *  (OpenCart hidden `p.date_added` per Mistake 21; Magento merchant-specific
   *  values per Mistake 20). Each is treated as a query-param value under a
   *  guessed sort param (see pickDefaultSortParamName). */
  extraCandidates?: string[];
  wafSuspected?: boolean;
  timeoutMs?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const log = (m: string) => process.stderr.write(m + '\n');

/**
 * Strip any already-applied sort from the testUrl so the baseline is a clean
 * default ordering. Matches the old monolith's stripSortFromUrl — skill
 * callers sometimes pass a URL that already has `?sort=X` or `/orderby/X/`
 * baked in from their own discovery; we MUST strip before using it as the
 * baseline or the ID-jump test is biased.
 */
function stripSortFromUrl(u: string): string {
  try {
    const url = new URL(u);
    // Strip path-based sort segments
    url.pathname = url.pathname.replace(
      /\/(orderby|sort_by|sort-by|sort|order)\/[A-Za-z][A-Za-z0-9_-]+/g,
      '',
    );
    // Strip query-based sort params — Drupal Views `sort_by` + `sort_order`,
    // Magento `product_list_order` + `product_list_dir`, etc.
    for (const key of [
      'sort',
      'order',
      'sortby',
      'sortBy',
      'product_list_order',
      'product_list_dir',
      'orderby',
      'sort_by',
      'sort_order',
    ]) {
      url.searchParams.delete(key);
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    return u;
  }
}

/**
 * Extract <select>-based sort options. Matches Module 6's extraction heuristic
 * exactly so the two modules agree on what counts as a "sort select":
 *   - name/id contains /sort|order/ OR
 *   - element is inside a sort-related container OR
 *   - >=2 options match sort-term regex (fallback for unnamed selects).
 */
function extractSelectSortOptions($: CheerioAPI): SortOptionRaw[] {
  const seen = new Set<string>();
  const out: SortOptionRaw[] = [];
  $('select').each((_: any, sel: any) => {
    const $sel = $(sel);
    const name = ($sel.attr('name') || '').trim();
    const id = ($sel.attr('id') || '').trim();
    const nameOrId = `${name} ${id}`.toLowerCase();
    const sortTermRe =
      /newest|latest|date|price|name|popular|featured|rating|alpha|recent|created|published/i;
    const isSortyName = /sort|order/i.test(nameOrId);
    const inSortContainer = $sel.closest('[class*="sort"]').length > 0;

    const options: Array<{ value: string; text: string }> = [];
    $sel.find('option').each((_i: any, opt: any) => {
      const value = ($(opt).attr('value') || '').trim();
      const text = $(opt).text().replace(/\s+/g, ' ').trim();
      if (!value && !text) return;
      options.push({ value, text });
    });
    if (options.length === 0) return;

    const hasSortyOptions =
      options.length >= 2 && options.some((o) => sortTermRe.test(o.text) || sortTermRe.test(o.value));
    if (!isSortyName && !inSortContainer && !hasSortyOptions) return;

    for (const o of options) {
      // Dedupe by (name|id|value) — some themes render the <select> twice
      // (top + bottom of grid).
      const key = `${name}|${id}|${o.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        selectName: name || null,
        selectId: id || null,
        value: o.value,
        text: o.text,
      });
    }
  });
  return out;
}

/**
 * Extract anchor-based sort options (Odoo, Drupal Views, some Celerant
 * themes). The href carries a sort query-param directly. For Drupal Views,
 * the `sort_by`/`sort` anchor is typically paired with a `sort_order`/`order`
 * anchor specifying the direction — we capture that pairing into the value
 * (e.g. `created&order=desc`) so the ID-jump builder applies both params.
 */
function extractAnchorSortOptions($: CheerioAPI): SortOptionRaw[] {
  const seen = new Set<string>();
  const out: SortOptionRaw[] = [];
  $('a[href*="order="], a[href*="sort="], a[href*="sortby="], a[href*="sort_by="]').each(
    (_: any, el: any) => {
      const href = $(el).attr('href') || '';
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      const m = href.match(/[?&](order|sort|sortby|sort_by|product_list_order)=([^&#]+)/);
      if (!m || !text) return;
      let fullValue = m[2];
      let paired: string | null = null;
      // Capture paired direction for Drupal Views
      if (m[1] === 'sort_by') {
        const pm = href.match(/[?&]sort_order=([^&#]+)/);
        if (pm) paired = `sort_order=${pm[1]}`;
      } else if (m[1] === 'sort') {
        const pm = href.match(/[?&]order=([^&#]+)/);
        if (pm) paired = `order=${pm[1]}`;
      }
      if (paired) fullValue = `${m[2]}&${paired}`;
      const key = `${m[1]}||${fullValue}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        selectName: m[1],
        selectId: null,
        value: fullValue,
        text,
      });
    },
  );
  return out;
}

/**
 * Detect path-scheme sort. Scans all anchor hrefs for `/orderby/<value>/` or
 * `/sort/<value>/` etc. Returns the path keyword if found (e.g. "orderby"),
 * null if no path-sort segments detected.
 */
function detectPathSortKeyword($: CheerioAPI): string | null {
  let keyword: string | null = null;
  $('a[href]').each((_: any, el: any) => {
    if (keyword) return;
    const href = $(el).attr('href') || '';
    const m = href.match(PATH_SORT_REGEX);
    if (m) keyword = m[1];
  });
  return keyword;
}

/**
 * For path-scheme sites, enumerate path-sort options by scanning every
 * anchor with `/<keyword>/<value>/` and extracting the value + anchor text
 * + full href. Celerant's sort UI is a list of `<a>` links in a sidebar
 * widget — this captures all of them.
 *
 * We also check <select onChange="parent.location='...'"> handlers since
 * Celerant-style sites sometimes express the sort as a <select> whose
 * options are DOM values BUT the resulting URL is path-scheme because
 * the onChange handler concatenates them into a `/<keyword>/<value>` path.
 * The onChange URL prefix tells us the required base path (e.g.
 * `/all-products/browse/orderby/`).
 */
function extractPathSortOptions(
  $: CheerioAPI,
  keyword: string,
): { options: SortOptionRaw[]; anchorBaseUrl: string | null } {
  const seen = new Set<string>();
  const out: SortOptionRaw[] = [];
  const pathRe = new RegExp(`/${keyword}/([A-Za-z][A-Za-z0-9_-]+)(?:/|$|\\?)`);

  // First: scan <select onChange="... '/<keyword>/'+this..."> to find the base
  // path a path-scheme site uses for sort URLs. Celerant pattern:
  //   <select onChange="parent.location='https://.../all-products/browse/orderby/'+this.options[this.selectedIndex].value;">
  // The prefix up through `/<keyword>/` is the base we need to mimic.
  let anchorBaseUrl: string | null = null;
  $('select').each((_: any, sel: any) => {
    if (anchorBaseUrl) return;
    const onChange = ($(sel).attr('onchange') || '').toLowerCase();
    // match e.g. "'/blah/orderby/'" up to the `+` token — capture the URL literal
    const m = onChange.match(new RegExp(`['"\`]([^'"\`]+/${keyword}/)['"\`]\\s*\\+`, 'i'));
    if (m) anchorBaseUrl = m[1];
  });

  // Second: scan anchors with `/<keyword>/<value>` in href. Each anchor's
  // full href is captured so buildSortUrl can use it verbatim.
  $('a[href]').each((_: any, el: any) => {
    const href = $(el).attr('href') || '';
    const m = href.match(pathRe);
    if (!m) return;
    const value = m[1];
    if (seen.has(value)) return;
    seen.add(value);
    const text = $(el).text().replace(/\s+/g, ' ').trim() || value;
    out.push({
      selectName: keyword,
      selectId: null,
      value,
      text,
      fullAnchorHref: href,
    });
  });

  // Third: for each <select> option that appears as part of a path-scheme
  // sort (its onChange builds a URL with `/<keyword>/<value>`), add the
  // option too. Dedupe by value.
  $('select').each((_: any, sel: any) => {
    const onChange = ($(sel).attr('onchange') || '');
    if (!new RegExp(`/${keyword}/`, 'i').test(onChange)) return;
    $(sel)
      .find('option')
      .each((_i: any, opt: any) => {
        const value = ($(opt).attr('value') || '').trim();
        if (!value || seen.has(value)) return;
        seen.add(value);
        const text = $(opt).text().replace(/\s+/g, ' ').trim() || value;
        out.push({
          selectName: keyword,
          selectId: null,
          value,
          text,
          fullAnchorHref: null, // constructed below in buildSortUrl via anchorBaseUrl
        });
      });
  });

  return { options: out, anchorBaseUrl };
}

/**
 * Decide which param name to use for `--extra-candidates` values when the
 * baseline has no native <select>. Matches the OpenCart Mistake 21 case:
 * if the page has no visible date-sort option but we want to probe
 * `p.date_added`, we need a guess for the param name. We walk the select
 * options first to find any common name, then fall back to 'sort'.
 */
function pickDefaultSortParamName(options: SortOptionRaw[]): string {
  for (const o of options) {
    if (o.selectName) return o.selectName;
  }
  return 'sort';
}

/**
 * Build the URL that applies a given sort option. Supports both query-param
 * scheme (`?sort=X`, `?orderby=X`, paired values like `created&order=desc`)
 * and path scheme (`/orderby/X/`). Returns the fully-resolved URL string.
 *
 * Path-scheme construction priority (each fallback covers more platforms):
 *   1. opt.fullAnchorHref — use the exact URL the DOM's sort link points to.
 *      This handles Celerant `/all-products/browse/orderby/<value>` where
 *      the category's sort URL pattern requires a `/browse/` prefix segment.
 *   2. anchorBaseUrl — constructed URL using the onChange handler's base path
 *      (e.g. `/all-products/browse/orderby/`) + the option value. Handles
 *      <select>-discovered options on Celerant that have no anchor template.
 *   3. Naive `<testUrl>/<keyword>/<value>` — last-resort construction for
 *      sites where no anchor/onChange template was found. Produces incorrect
 *      URLs on Celerant but is the only option when we have nothing else.
 */
function buildSortUrl(
  testUrl: string,
  opt: SortOptionRaw,
  scheme: SortScheme,
  anchorBaseUrl: string | null = null,
): string {
  if (scheme === 'path' && opt.selectName) {
    const pathValue = opt.value.split('&')[0];

    // Priority 1: use the DOM's full anchor href verbatim if captured.
    if (opt.fullAnchorHref) {
      try {
        return new URL(opt.fullAnchorHref, testUrl).toString();
      } catch {
        // fall through to construction paths
      }
    }

    // Priority 2: onChange handler base path.
    if (anchorBaseUrl) {
      const baseJoined = anchorBaseUrl.endsWith('/')
        ? `${anchorBaseUrl}${pathValue}`
        : `${anchorBaseUrl}/${pathValue}`;
      try {
        return new URL(baseJoined, testUrl).toString();
      } catch {
        // fall through
      }
    }

    // Priority 3: naive construction. Replace any existing /<keyword>/<prev>/
    // segment if one is already in the URL; otherwise append.
    const base = testUrl.replace(/\/+$/, '');
    const re = new RegExp(`/${opt.selectName}/[A-Za-z][A-Za-z0-9_-]*`);
    if (re.test(base)) {
      return base.replace(re, `/${opt.selectName}/${pathValue}`);
    }
    return `${base}/${opt.selectName}/${pathValue}`;
  }
  // Query scheme (default)
  let url: URL;
  try {
    url = new URL(testUrl);
  } catch {
    // Malformed testUrl — fall back to raw concatenation
    const sep = testUrl.includes('?') ? '&' : '?';
    return `${testUrl}${sep}${opt.selectName || 'sort'}=${encodeURIComponent(opt.value)}`;
  }
  const paramName = opt.selectName || 'sort';
  // Split paired values: "created&order=desc" → set sort=created AND order=desc
  const parts = opt.value.split('&');
  const primary = parts[0];
  url.searchParams.set(paramName, primary);
  for (const extra of parts.slice(1)) {
    const eq = extra.indexOf('=');
    if (eq > 0) {
      url.searchParams.set(extra.slice(0, eq), extra.slice(eq + 1));
    }
  }
  return url.toString();
}

/**
 * Normalize a product identity for comparison — prefer sourceId (stable DB
 * ID), fall back to URL (slug), fall back to title. This is what the ID-jump
 * test actually compares. Returns null if all three are missing.
 */
function productIdentity(p: ExtractedProduct | null): string | null {
  if (!p) return null;
  if (p.sourceId) return `id:${p.sourceId}`;
  if (p.url) return `url:${p.url}`;
  if (p.title) return `t:${p.title}`;
  return null;
}

function toFirstProductSummary(p: ExtractedProduct | null): FirstProductSummary | null {
  if (!p) return null;
  return { title: p.title || null, url: p.url || null, sourceId: p.sourceId || null };
}

// ── Main public API ──────────────────────────────────────────────────────────

export async function runProbeSort(
  catalogUrl: string,
  opts: RunProbeSortOpts = {},
): Promise<ProbeSortResult> {
  const t0 = Date.now();
  const ua: UaMode = opts.ua ?? 'desktop';
  const mode: FetchMode = opts.mode ?? 'auto';

  // ── Step 1: strip pre-existing sort, fetch baseline ──────────────────────
  const cleanedUrl = stripSortFromUrl(catalogUrl);
  log(`[probe-sort] baseline fetch: ${cleanedUrl} (ua=${ua} mode=${mode})`);

  // Use probe-extraction so we get products + raw HTML in one call. probe-
  // extraction already handles WAF-escalation + Playwright + HPE fallback.
  const baselineExtract = await runProbeExtraction(cleanedUrl, {
    ua,
    mode,
    wafSuspected: opts.wafSuspected,
    timeoutMs: opts.timeoutMs,
  });

  if (baselineExtract.status === null) {
    log(`[probe-sort] baseline fetch failed — cannot proceed`);
    return {
      testUrl: cleanedUrl,
      sortScheme: 'none',
      sortOptions: [],
      newestCandidates: [],
      alphaControlResult: null,
      baselineFirstProduct: null,
      baselineProductCount: 0,
      verdict: 'unknown',
      verdictReason: `baseline fetch failed: ${baselineExtract.warnings.join(' | ').slice(0, 200)}`,
      rankedNewest: [],
      wallMs: Date.now() - t0,
    };
  }

  const baselineProducts = baselineExtract.productsFound;
  const baselineFirst = baselineProducts[0] || null;
  const baselineFirstId = productIdentity(baselineFirst);

  // ── Step 2: re-fetch raw HTML for path-scheme + anchor-sort scanning ─────
  // probe-extraction returns products + select-based sort options but NOT
  // anchors or path-segments. We need the raw HTML for those. Re-fetch is
  // the simplest approach — cached WAF cookies are reused, and the cost is
  // one axios GET (~200ms). No site-specific logic.
  let $: CheerioAPI;
  const rawFetch = await fetchForProbe(cleanedUrl, {
    ua,
    mode,
    accept: 'html',
    wafSuspected: opts.wafSuspected,
    timeoutMs: opts.timeoutMs,
    fullBody: true,
  });
  if (rawFetch.status === null || !rawFetch.bodySample) {
    // Baseline extraction succeeded but raw refetch didn't — fall back to
    // sortSelects from Module 6 and assume query scheme if any options exist.
    log(`[probe-sort] raw-HTML refetch failed, falling back to extraction-only sort options`);
    $ = null;
  } else {
    const { load: cheerioLoad } = await import('cheerio');
    $ = cheerioLoad(rawFetch.bodySample);
  }

  // ── Step 3: gather sort options + detect scheme ──────────────────────────
  let selectOptions: SortOptionRaw[] = [];
  let anchorOptions: SortOptionRaw[] = [];
  let pathKeyword: string | null = null;
  let pathOptions: SortOptionRaw[] = [];
  let anchorBaseUrl: string | null = null;

  if ($) {
    selectOptions = extractSelectSortOptions($);
    anchorOptions = extractAnchorSortOptions($);
    pathKeyword = detectPathSortKeyword($);
    if (pathKeyword) {
      const pathResult = extractPathSortOptions($, pathKeyword);
      pathOptions = pathResult.options;
      anchorBaseUrl = pathResult.anchorBaseUrl;
    }
  } else {
    // Fallback: use Module 6's sortSelects verbatim
    for (const s of baselineExtract.sortSelects) {
      for (const o of s.options) {
        selectOptions.push({
          selectName: s.name,
          selectId: s.id,
          value: o.value,
          text: o.text,
        });
      }
    }
  }

  // Determine sortScheme
  let sortScheme: SortScheme = 'none';
  if (pathKeyword && pathOptions.length > 0) {
    sortScheme = 'path';
  } else if (selectOptions.length > 0 || anchorOptions.length > 0) {
    sortScheme = 'query';
  }
  // Note: 'hash' and 'form-post' schemes are not detectable from static HTML
  // alone. Searchspring hash discovery requires Playwright UI clicks (Mistake
  // 25) — that's skill-layer work, not a probe module. If the skill already
  // knows the site uses hash/form-post scheme, it can pass candidates via
  // --extra-candidates with pre-built hash URLs.

  // Combined option list — path options take precedence when scheme=path.
  // Query + anchor options are merged under scheme=query.
  const allOptions: SortOptionRaw[] = sortScheme === 'path' ? pathOptions : [...selectOptions, ...anchorOptions];

  // ── Step 4: handle --extra-candidates ────────────────────────────────────
  const extraCandidates = (opts.extraCandidates || []).filter((v) => v.trim().length > 0);
  if (extraCandidates.length > 0) {
    const paramName = pickDefaultSortParamName(allOptions);
    for (const val of extraCandidates) {
      // Skip if already present in allOptions (skill duplicated a discovered value)
      if (allOptions.some((o) => o.value === val)) continue;
      allOptions.push({
        selectName: paramName,
        selectId: null,
        value: val,
        text: `(extra-candidate: ${val})`,
      });
    }
  }

  log(
    `[probe-sort] scheme=${sortScheme} selectOptions=${selectOptions.length} anchorOptions=${anchorOptions.length} pathOptions=${pathOptions.length} extra=${extraCandidates.length} baselineProducts=${baselineProducts.length}`,
  );

  // ── Step 5: classify candidates ──────────────────────────────────────────
  const newestOpts = allOptions.filter((o) => {
    const hay = `${o.text} ${o.value}`;
    if (!NEWEST_REGEX.test(hay)) return false;
    if (OLDEST_REGEX.test(hay)) return false; // reject oldest-first false positives
    return true;
  });
  // Dedupe newest by value (some sites list the same sort under multiple <select>
  // instances at top + bottom — prevents double-scoring)
  const newestSeen = new Set<string>();
  const newestUnique = newestOpts.filter((o) => {
    if (newestSeen.has(o.value)) return false;
    newestSeen.add(o.value);
    return true;
  });

  const isNewestValue = (v: string) => newestSeen.has(v);
  const alphaOpt =
    allOptions.find((o) => !isNewestValue(o.value) && COUNTER_REGEX.test(`${o.text} ${o.value}`)) ||
    allOptions.find((o) => !isNewestValue(o.value) && PRICE_REGEX.test(`${o.text} ${o.value}`)) ||
    allOptions.find((o) => !isNewestValue(o.value) && POPULARITY_REGEX.test(`${o.text} ${o.value}`)) ||
    allOptions.find((o) => !isNewestValue(o.value)) ||
    null;

  log(
    `[probe-sort] newestCandidates=${newestUnique.length} alphaControl=${alphaOpt ? `${alphaOpt.selectName || '<anchor>'}=${alphaOpt.value}` : 'none'}`,
  );

  // ── Step 6: ID-jump tests ────────────────────────────────────────────────
  const newestResults: NewestCandidateResult[] = [];
  for (const cand of newestUnique) {
    const sortUrl = buildSortUrl(cleanedUrl, cand, sortScheme, anchorBaseUrl);
    log(`  id-jump newest: ${cand.value} → ${sortUrl}`);
    const r = await runProbeExtraction(sortUrl, {
      ua,
      mode,
      wafSuspected: opts.wafSuspected,
      timeoutMs: opts.timeoutMs,
    });
    if (r.status === null || r.productCount === 0) {
      newestResults.push({
        value: cand.value,
        text: cand.text,
        testedUrl: sortUrl,
        firstProductTitle: null,
        firstProductSourceId: null,
        idJumpScore: -1,
        sampleProducts: [],
      });
      continue;
    }
    const first = r.productsFound[0];
    const sample = r.productsFound.slice(0, SAMPLE_SIZE).map((p) => ({
      title: p.title,
      url: p.url,
      sourceId: p.sourceId,
    }));
    // Score phase 1: +2 if differs from baseline
    let score = 0;
    const candId = productIdentity(first);
    if (candId && baselineFirstId && candId !== baselineFirstId) score += 2;
    newestResults.push({
      value: cand.value,
      text: cand.text,
      testedUrl: sortUrl,
      firstProductTitle: first.title || null,
      firstProductSourceId: first.sourceId || null,
      idJumpScore: score,
      sampleProducts: sample,
    });
  }

  // Score phase 2: +1 per OTHER candidate whose firstProduct differs from this one.
  // This is Mistake 36 disambiguation — Celerant's `new-arrivals` vs `newest-rcvd`
  // both differ from default; the one that ALSO differs from the OTHER wins.
  for (let i = 0; i < newestResults.length; i++) {
    const self = newestResults[i];
    if (self.idJumpScore < 0) continue;
    const selfId = self.firstProductSourceId
      ? `id:${self.firstProductSourceId}`
      : self.firstProductTitle
        ? `t:${self.firstProductTitle}`
        : null;
    if (!selfId) continue;
    for (let j = 0; j < newestResults.length; j++) {
      if (i === j) continue;
      const other = newestResults[j];
      if (other.idJumpScore < 0) continue;
      const otherId = other.firstProductSourceId
        ? `id:${other.firstProductSourceId}`
        : other.firstProductTitle
          ? `t:${other.firstProductTitle}`
          : null;
      if (otherId && otherId !== selfId) self.idJumpScore += 1;
    }
  }

  // ── Step 7: alpha counter-control ────────────────────────────────────────
  let alphaControl: AlphaControlResult | null = null;
  if (alphaOpt) {
    const alphaUrl = buildSortUrl(cleanedUrl, alphaOpt, sortScheme, anchorBaseUrl);
    log(`  id-jump alpha-control: ${alphaOpt.value} → ${alphaUrl}`);
    const r = await runProbeExtraction(alphaUrl, {
      ua,
      mode,
      wafSuspected: opts.wafSuspected,
      timeoutMs: opts.timeoutMs,
    });
    if (r.status !== null && r.productCount > 0) {
      const first = r.productsFound[0];
      alphaControl = {
        value: alphaOpt.value,
        text: alphaOpt.text,
        testedUrl: alphaUrl,
        firstProductTitle: first.title || null,
        firstProductSourceId: first.sourceId || null,
      };
    } else {
      alphaControl = {
        value: alphaOpt.value,
        text: alphaOpt.text,
        testedUrl: alphaUrl,
        firstProductTitle: null,
        firstProductSourceId: null,
      };
    }
  }

  // ── Step 8: verdict ──────────────────────────────────────────────────────
  // Sort ranked desc. Candidates with score=-1 (fetch failed) sort last.
  const rankedNewest = newestResults
    .map((r) => ({ value: r.value, score: r.idJumpScore }))
    .sort((a, b) => b.score - a.score);

  let verdict: SortVerdict = 'unknown';
  let verdictReason = '';

  if (baselineProducts.length === 0) {
    verdict = 'unknown';
    verdictReason = 'baseline returned 0 products; cannot run ID-jump test';
  } else if (newestResults.length === 0) {
    if (baselineProducts.length < SMALL_CATALOG_THRESHOLD) {
      verdict = 'noop-small';
      verdictReason = `no newest-matching sort option found and baseline has only ${baselineProducts.length} products (<${SMALL_CATALOG_THRESHOLD}); too small to observe sort effects`;
    } else {
      verdict = 'noop-large';
      verdictReason = `no newest-matching sort option found among ${allOptions.length} discovered options on a catalog of ${baselineProducts.length}+ products`;
    }
  } else {
    const topNewest = newestResults.find((r) => r.value === rankedNewest[0]?.value);
    const topScore = rankedNewest[0]?.score ?? -1;
    if (topScore >= 3) {
      verdict = 'honored';
      verdictReason = `top candidate '${topNewest?.value}' scored ${topScore} (>=3: differs from baseline AND at least one other newest candidate)`;
    } else if (topScore >= 2) {
      verdict = 'honored';
      verdictReason = `top candidate '${topNewest?.value}' scored ${topScore} (differs from baseline; only ${newestResults.length} newest candidate tested, no cross-comparison)`;
    } else {
      // Top newest differs from baseline: not really — else score would be >=2.
      // All newest candidates either tied with baseline or their fetch failed.
      // Consult alpha control to distinguish honored-default-is-newest from noop.
      const anyFetched = newestResults.some((r) => r.idJumpScore >= 0);
      if (!anyFetched) {
        verdict = 'unknown';
        verdictReason = `all ${newestResults.length} newest-candidate fetches failed; cannot decide`;
      } else if (alphaControl && alphaControl.firstProductSourceId) {
        const alphaId = `id:${alphaControl.firstProductSourceId}`;
        if (alphaId !== baselineFirstId) {
          verdict = 'honored-default-is-newest';
          verdictReason = `newest candidates tied with baseline (score=0) BUT alpha-control '${alphaControl.value}' produced a different first product (${alphaControl.firstProductTitle}); default ordering IS newest`;
        } else if (baselineProducts.length < SMALL_CATALOG_THRESHOLD) {
          verdict = 'noop-small';
          verdictReason = `baseline has ${baselineProducts.length} products (<${SMALL_CATALOG_THRESHOLD}); too small to observe sort effects`;
        } else {
          verdict = 'noop-large';
          verdictReason = `baseline has ${baselineProducts.length}+ products; newest AND alpha-control all tie with default — sort params appear to be ignored by the server`;
        }
      } else if (alphaControl && alphaControl.firstProductTitle) {
        // Compare by title if sourceId missing
        const alphaTitle = alphaControl.firstProductTitle;
        const baselineTitle = baselineFirst?.title || '';
        if (alphaTitle !== baselineTitle) {
          verdict = 'honored-default-is-newest';
          verdictReason = `newest candidates tied with baseline BUT alpha-control '${alphaControl.value}' produced a different first product (${alphaTitle}); default ordering IS newest`;
        } else if (baselineProducts.length < SMALL_CATALOG_THRESHOLD) {
          verdict = 'noop-small';
          verdictReason = `baseline has ${baselineProducts.length} products (<${SMALL_CATALOG_THRESHOLD}); too small to observe sort effects`;
        } else {
          verdict = 'noop-large';
          verdictReason = `baseline has ${baselineProducts.length}+ products; newest AND alpha-control all tie with default — sort params appear to be ignored`;
        }
      } else {
        // No alpha control available
        if (baselineProducts.length < SMALL_CATALOG_THRESHOLD) {
          verdict = 'noop-small';
          verdictReason = `no alpha counter-control available; baseline has ${baselineProducts.length} products (<${SMALL_CATALOG_THRESHOLD})`;
        } else {
          verdict = 'noop-large';
          verdictReason = `no alpha counter-control available; newest candidates all tied with baseline on a ${baselineProducts.length}+ product catalog`;
        }
      }
    }
  }

  log(`[probe-sort] verdict=${verdict} — ${verdictReason}`);

  return {
    testUrl: cleanedUrl,
    sortScheme,
    sortOptions: allOptions,
    newestCandidates: newestResults,
    alphaControlResult: alphaControl,
    baselineFirstProduct: toFirstProductSummary(baselineFirst),
    baselineProductCount: baselineProducts.length,
    verdict,
    verdictReason,
    rankedNewest,
    wallMs: Date.now() - t0,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { url: string; opts: RunProbeSortOpts } | null {
  const positional: string[] = [];
  const opts: RunProbeSortOpts = {};
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
    } else if (a === '--extra-candidates') {
      const v = argv[++i];
      if (!v) return null;
      opts.extraCandidates = v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
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
      'usage: probe-sort.ts <catalogUrl> [--ua desktop|iphone|custom:<string>] [--mode static|playwright|auto] [--extra-candidates val1,val2,val3] [--waf-suspected] [--timeout <ms>]\n',
    );
    return 2;
  }
  const result = await runProbeSort(parsed.url, parsed.opts);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  await closePlaywrightIfUsed();
  return result.verdict === 'unknown' && result.baselineProductCount === 0 ? 1 : 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`probe-sort crashed: ${e?.stack || e?.message || e}\n`);
      process.exit(1);
    });
}
