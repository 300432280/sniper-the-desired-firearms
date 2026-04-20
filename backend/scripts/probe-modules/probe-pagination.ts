/**
 * probe-pagination.ts — Module 9 of the decomposed pre-bootstrap probe.
 *
 * Single responsibility: given ONE catalog URL (optionally with sort segment
 * baked in), detect the pagination scheme, build a page-2 URL, fetch it, and
 * run a zero-overlap test against page 1 to prove the pattern is HONORED
 * (not silently ignored — Mistake 26 LightSpeed, Mistake 27 Wix).
 *
 * The output `paginationPattern` is the SAME profile-shape OBJECT the
 * production `catalog-crawler.ts` consumes (see `PaginationPattern` interface
 * at `catalog-crawler.ts:84`). A string return is NOT acceptable
 * (Mistake 14 — a stored pagination "query:page" string would crash the
 * pagination builder because it expects `{type:'query', template:'page'}`).
 *
 * Mechanism:
 *   1. Fetch page 1 via Module 6 (`runProbeExtraction`) — gets products +
 *      raw pagination candidate anchors + raw sort selects (unused here) in
 *      one pass. Uses fullBody + WAF/Playwright escalation already baked in.
 *   2. Scan the captured `paginationCandidates[]` anchors to infer the
 *      pattern. Each anchor href is matched against a priority-ordered list
 *      of patterns: `?page=N`, `?p=N`, `?paged=N`, `/page/N/`, `/page-N/`,
 *      `-N.html` / `pageN.html`, `?offset=N`, `?start=N`. The most common
 *      shape (by anchor count) wins.
 *   3. Build the page-2 URL via the production `buildPaginatedUrl` so we
 *      prove the exact code the runtime uses actually produces a working
 *      URL — not just a plausible one.
 *   4. Fetch page 2 via Module 6 and extract products.
 *   5. Zero-overlap test: compare page-1 product URL Set to page-2 URL Set.
 *        - 0 overlap + both non-empty → verdict 'verified'
 *        - page-2 products === page-1 products (full overlap) → verdict
 *          'broken-overlap' (Mistake 26/27 — silently served page 1)
 *        - partial overlap → verdict 'works-but-sort-ignored' (rare edge)
 *        - page-1 products but no page-2 pattern detectable → 'single-page'
 *          (small catalog) or 'no-pagination-found'
 *   6. Detect `zeroIndexed` (Mistake 37 — Drupal/gunpost uses `?page=0` as
 *      page 1) and `firstPageHasParam` (is `?page=1` explicit or implicit?).
 *   7. Extract `totalPagesObserved` from the highest pagination anchor
 *      page number — saves the skill from walking the catalog.
 *
 * Scope boundaries (what this module does NOT do):
 *   - Walk all pages (that's orchestrator/skill work — too expensive).
 *   - Compute `expectedProductCount` (skill reconciles from sitemap/pagination).
 *   - Decide watermark method (skill).
 *   - Bake platform-specific URL quirks INSIDE the module (Volusion's
 *     `searching=Y` requirement, LightSpeed's sort+suffix mashup). The skill
 *     must pre-build those URLs and pass via `--sort-url`.
 *   - Detect API pagination (`api-offset`, `api-page`) — those are decided
 *     at the API layer (WooCommerce/Shopify/Ecwid) outside this module.
 *
 * CLI:
 *   npx tsx scripts/probe-modules/probe-pagination.ts <catalogUrl>
 *     [--sort-url <pre-sorted-url>]
 *     [--ua desktop|iphone|custom:<string>]
 *     [--mode static|playwright|auto]
 *     [--waf-suspected]
 *     [--timeout <ms>]
 *
 * Output: JSON to stdout. Progress to stderr.
 * Exit: 0 on module success; 1 if baseline (page 1) fetch failed entirely;
 *       2 on bad args.
 */

import { closePlaywrightIfUsed, UaMode, FetchMode } from './probe-fetch';
import { runProbeExtraction, PaginationCandidate } from './probe-extraction';

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Profile-ready pagination pattern shape. Mirrors the production
 * `PaginationPattern` interface at `catalog-crawler.ts:84`, plus two
 * API-shape variants for completeness (api-offset / api-page are decided
 * elsewhere but the type surface allows a skill to emit them here too).
 */
export type PaginationPatternShape =
  | { type: 'query'; template: string; zeroIndexed?: boolean; firstPageHasParam?: boolean }
  | { type: 'path'; template: string }
  | { type: 'offset-query'; template: string; perPage: number }
  | { type: 'suffix-replace'; match: string; template: string }
  | { type: 'api-offset'; limit: number; offsetField: string; limitField: string; maxPerRequest?: number }
  | { type: 'api-page'; param: string };

export type PaginationVerdict =
  | 'verified'
  | 'works-but-sort-ignored'
  | 'broken-overlap'
  | 'single-page'
  | 'no-pagination-found';

export interface ProbePaginationResult {
  testUrl: string;
  sortedTestUrl: string | null;
  /** Profile-ready OBJECT (not a string — Mistake 14 protection). */
  paginationPattern: PaginationPatternShape | null;
  page1ProductCount: number;
  page2ProductCount: number;
  zeroOverlap: boolean;
  /** Up to 5 sample URLs that overlapped between page 1 and page 2. */
  overlapProducts: string[];
  /**
   * Highest page number observed across all pagination anchors. Saves the
   * skill from a full walk when deriving `expectedProductCount`.
   * Adjusted for zeroIndexed sites (Drupal): if max-observed is 1692 and
   * zeroIndexed=true, totalPagesObserved = 1693.
   */
  totalPagesObserved: number | null;
  /** If we ever walked to the last page (we don't in this module), item count. */
  lastPageItemCount: number | null;
  /** Sample of pagination anchors with page-number extraction (up to 10). */
  paginationLinkSample: Array<{ href: string; page: number | null }>;
  verdict: PaginationVerdict;
  verdictReason: string;
  wallMs: number;
}

export interface RunProbePaginationOpts {
  /** Fully-sorted URL (skill pre-bakes Volusion `searching=Y`, LightSpeed
   *  `?sort=newest`, Searchspring hash fragment, etc.). When set, we use this
   *  as the page-1 URL so pagination interacts with the sort segment exactly
   *  as runtime would. */
  sortUrl?: string;
  ua?: UaMode;
  mode?: FetchMode;
  wafSuspected?: boolean;
  timeoutMs?: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Small-catalog threshold — below this, pagination may not exist at all. */
const SINGLE_PAGE_THRESHOLD = 3;

// ── Helpers ──────────────────────────────────────────────────────────────────

const log = (m: string) => process.stderr.write(m + '\n');

/**
 * Extract page number from a pagination href. Matches (in priority order):
 *   `?page=N`, `?paged=N`, `?p=N`, `/page/N`, `/page-N`, `pageN.html`,
 *   `-N.html`, `?offset=N`, `?start=N`.
 * Returns null if no page number could be extracted.
 */
function extractPageNumber(href: string): number | null {
  // Query-style
  const queryMatches = [
    /[?&]page=(\d+)(?:&|$|#)/i,
    /[?&]paged=(\d+)(?:&|$|#)/i,
    /[?&]p=(\d+)(?:&|$|#)/i,
  ];
  for (const re of queryMatches) {
    const m = href.match(re);
    if (m) return parseInt(m[1], 10);
  }
  // Path-style — must come before suffix matches because `/page/2` could be
  // captured by a lazy suffix regex too.
  const pathMatches = [/\/page\/(\d+)(?:\/|$|\?)/i, /\/page-(\d+)(?:\/|$|\?)/i];
  for (const re of pathMatches) {
    const m = href.match(re);
    if (m) return parseInt(m[1], 10);
  }
  // Suffix-style (LightSpeed eCom legacy, CS-Cart)
  // Match `pageN.html` first (it's more specific), then the generic `-N.html`.
  const suffixMatches = [/page(\d+)\.html(?:\?|$|#)/i, /-(\d+)\.html(?:\?|$|#)/i];
  for (const re of suffixMatches) {
    const m = href.match(re);
    if (m) return parseInt(m[1], 10);
  }
  // Offset/start
  const offsetMatches = [/[?&]offset=(\d+)(?:&|$|#)/i, /[?&]start=(\d+)(?:&|$|#)/i];
  for (const re of offsetMatches) {
    const m = href.match(re);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

/**
 * Detect the pagination shape used by a single href. Returns a
 * `PaginationPatternShape` stub (without perPage/fields that require
 * measurement) or null if the href doesn't match any known shape.
 *
 * For `suffix-replace`, the stub's `match` field is set to `.html` — the
 * caller may refine to `-1.html` if the base URL happens to end that way.
 * For `offset-query`, `perPage` is left at 0; the caller must measure.
 */
function detectShapeFromHref(href: string): PaginationPatternShape | null {
  // Query-style (priority order matches production expectations)
  if (/[?&]page=\d+/i.test(href)) return { type: 'query', template: 'page' };
  if (/[?&]paged=\d+/i.test(href)) return { type: 'query', template: 'paged' };
  if (/[?&]p=\d+/i.test(href)) return { type: 'query', template: 'p' };
  // Path-style
  if (/\/page\/\d+/i.test(href)) return { type: 'path', template: '/page/{N}' };
  if (/\/page-\d+/i.test(href)) return { type: 'path', template: '/page-{N}' };
  // Suffix-style — LightSpeed eCom `page{N}.html`
  if (/page\d+\.html/i.test(href))
    return { type: 'suffix-replace', match: '.html', template: 'page{N}.html' };
  // Suffix-style — CS-Cart `<slug>-{N}.html`
  if (/-\d+\.html/i.test(href))
    return { type: 'suffix-replace', match: '.html', template: '-{N}.html' };
  // Offset-query
  if (/[?&]offset=\d+/i.test(href))
    return { type: 'offset-query', template: 'offset', perPage: 0 };
  if (/[?&]start=\d+/i.test(href))
    return { type: 'offset-query', template: 'start', perPage: 0 };
  return null;
}

/**
 * Score pagination shape candidates by frequency across all anchors, then
 * pick the winner. Ties broken by priority order (query > path > suffix >
 * offset) because most CMS pagination is query-style.
 *
 * `anchorsForPattern` is the load-bearing output: callers MUST prefer one
 * of these hrefs verbatim as the page-2 URL, because path-scheme sites
 * often require prefix segments (Celerant's `/browse/`, some LightSpeed
 * themes' `/c/`) that naive base-URL + `/page/2` synthesis would miss
 * entirely. Same lesson as probe-sort.ts `fullAnchorHref`.
 */
function pickPatternFromAnchors(
  candidates: PaginationCandidate[],
): { pattern: PaginationPatternShape; frequency: number; anchorsForPattern: PaginationCandidate[] } | null {
  const counts = new Map<string, { pattern: PaginationPatternShape; count: number; anchors: PaginationCandidate[] }>();
  for (const c of candidates) {
    const shape = detectShapeFromHref(c.href);
    if (!shape) continue;
    // Dedupe key includes type + template (or match for suffix-replace).
    const key =
      shape.type === 'suffix-replace'
        ? `${shape.type}|${shape.match}|${shape.template}`
        : shape.type === 'offset-query'
          ? `${shape.type}|${shape.template}`
          : shape.type === 'query' || shape.type === 'path'
            ? `${shape.type}|${shape.template}`
            : `${shape.type}`;
    const prev = counts.get(key);
    if (prev) {
      prev.count++;
      prev.anchors.push(c);
    } else {
      counts.set(key, { pattern: shape, count: 1, anchors: [c] });
    }
  }
  if (counts.size === 0) return null;
  // Priority order for tie-breaking
  const typePriority: Record<string, number> = {
    query: 0,
    path: 1,
    'suffix-replace': 2,
    'offset-query': 3,
    'api-offset': 4,
    'api-page': 5,
  };
  const ranked = Array.from(counts.values()).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return (typePriority[a.pattern.type] ?? 99) - (typePriority[b.pattern.type] ?? 99);
  });
  const winner = ranked[0];
  return { pattern: winner.pattern, frequency: winner.count, anchorsForPattern: winner.anchors };
}

/**
 * Pick the anchor whose extracted page number is `targetPage` (typically 2
 * for the zero-overlap test, or 1 for zeroIndexed Drupal sites). If no
 * anchor for targetPage exists, pick the anchor with the lowest page number
 * greater than `currentPage` (fallback — rare). Returns null if no suitable
 * anchor. Load-bearing for path-scheme sites with non-trivial path prefixes.
 */
function pickPageNAnchor(
  anchors: PaginationCandidate[],
  targetPage: number,
  currentPage: number = 1,
): PaginationCandidate | null {
  // Exact match first
  for (const a of anchors) {
    const n = extractPageNumber(a.href);
    if (n === targetPage) return a;
  }
  // Fallback: lowest page-number > currentPage
  let best: { anchor: PaginationCandidate; page: number } | null = null;
  for (const a of anchors) {
    const n = extractPageNumber(a.href);
    if (n === null) continue;
    if (n <= currentPage) continue;
    if (best === null || n < best.page) best = { anchor: a, page: n };
  }
  return best?.anchor ?? null;
}

/**
 * Measure `perPage` for an `offset-query` pattern. We need this because the
 * production `buildPaginatedUrl` computes offset as `(pageNum - 1) * perPage`.
 * Infer from the two smallest offset values observed, or fall back to the
 * page-1 product count.
 */
function measureOffsetPerPage(
  anchors: PaginationCandidate[],
  page1ProductCount: number,
): number {
  const offsets: number[] = [];
  for (const a of anchors) {
    const m =
      a.href.match(/[?&]offset=(\d+)/i) || a.href.match(/[?&]start=(\d+)/i);
    if (m) {
      const n = parseInt(m[1], 10);
      if (!Number.isNaN(n)) offsets.push(n);
    }
  }
  // Sort distinct offsets ascending.
  const unique = Array.from(new Set(offsets)).sort((a, b) => a - b);
  if (unique.length >= 2) {
    // Smallest positive delta is perPage.
    for (let i = 1; i < unique.length; i++) {
      const d = unique[i] - unique[i - 1];
      if (d > 0) return d;
    }
  }
  // Fallback: assume perPage == page1 count (rough but usable).
  return page1ProductCount > 0 ? page1ProductCount : 20;
}

/**
 * Build the page-N URL via the SAME production function the runtime uses.
 * Lazy-load to keep probe-fetch's module-init clean (see probe-extraction.ts
 * comment about module init ordering).
 */
async function buildPageUrl(baseUrl: string, pageNum: number, pattern: PaginationPatternShape): Promise<string> {
  const { buildPaginatedUrl } = await import('../../src/services/catalog-crawler');
  // The production function only accepts the non-API shapes. If the skill
  // happens to pass an api-* shape we fall through to a synthetic URL.
  if (pattern.type === 'api-offset' || pattern.type === 'api-page') {
    // Synthetic query-param URL for API-shape patterns. We don't invoke
    // buildPaginatedUrl because the production signature doesn't support them.
    const param = pattern.type === 'api-page' ? pattern.param : pattern.offsetField;
    const sep = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${sep}${param}=${pageNum}`;
  }
  return buildPaginatedUrl(baseUrl, pageNum, pattern as any);
}

/**
 * Normalize a product URL for Set-based comparison. Strips trailing slashes,
 * fragments, and query strings EXCEPT those likely to be the product
 * identifier (e.g. Volusion `ProductCode`, Magento `product_id`). Most
 * modern storefronts use path-based product URLs, so the default of stripping
 * all query strings is safe.
 */
function normalizeProductUrl(u: string): string {
  try {
    const url = new URL(u);
    // Preserve product-identifier query params that many retro storefronts use.
    const preservedParams = ['productcode', 'product_id', 'sku', 'id'];
    const preserved = new URLSearchParams();
    for (const [k, v] of url.searchParams) {
      if (preservedParams.includes(k.toLowerCase())) preserved.set(k, v);
    }
    url.search = preserved.toString();
    url.hash = '';
    let out = url.toString();
    if (out.endsWith('/') && url.pathname !== '/') out = out.slice(0, -1);
    return out.toLowerCase();
  } catch {
    return u.replace(/[#?].*$/, '').replace(/\/+$/, '').toLowerCase();
  }
}

// ── Main public API ──────────────────────────────────────────────────────────

export async function runProbePagination(
  catalogUrl: string,
  opts: RunProbePaginationOpts = {},
): Promise<ProbePaginationResult> {
  const t0 = Date.now();
  const ua: UaMode = opts.ua ?? 'desktop';
  const mode: FetchMode = opts.mode ?? 'auto';

  // If the skill passed a pre-sorted URL, that's the baseline; otherwise use
  // catalogUrl as-is. testUrl is preserved separately for the result envelope.
  const baseUrl = opts.sortUrl || catalogUrl;
  log(`[probe-pagination] page 1 fetch: ${baseUrl} (ua=${ua} mode=${mode})`);

  // ── Step 1: Fetch page 1 ────────────────────────────────────────────────
  const page1 = await runProbeExtraction(baseUrl, {
    ua,
    mode,
    wafSuspected: opts.wafSuspected,
    timeoutMs: opts.timeoutMs,
  });

  if (page1.status === null) {
    log(`[probe-pagination] page 1 fetch failed`);
    return {
      testUrl: catalogUrl,
      sortedTestUrl: opts.sortUrl ?? null,
      paginationPattern: null,
      page1ProductCount: 0,
      page2ProductCount: 0,
      zeroOverlap: false,
      overlapProducts: [],
      totalPagesObserved: null,
      lastPageItemCount: null,
      paginationLinkSample: [],
      verdict: 'no-pagination-found',
      verdictReason: `page 1 fetch failed: ${page1.warnings.join(' | ').slice(0, 200)}`,
      wallMs: Date.now() - t0,
    };
  }

  const page1Products = page1.productsFound;
  const page1UrlSet = new Set(page1Products.map((p) => normalizeProductUrl(p.url)));
  const paginationCandidates = page1.paginationCandidates;

  log(
    `[probe-pagination] page 1: ${page1Products.length} products, ${paginationCandidates.length} pagination anchors`,
  );

  // Compose paginationLinkSample (up to 10, with page numbers)
  const paginationLinkSample = paginationCandidates.slice(0, 10).map((c) => ({
    href: c.href,
    page: extractPageNumber(c.href),
  }));

  // Detect zeroIndexed (Drupal Views — Mistake 37)
  const zeroIndexed = paginationCandidates.some((c) => /[?&]page=0(?:&|$|#)/.test(c.href));

  // Detect firstPageHasParam — whether `?page=1` is explicit or implicit.
  // Signal: a pagination anchor with `?page=1` (or `?page=0` when zeroIndexed).
  // If we see a page 1/0 anchor that equals the bare testUrl, the param is
  // implicit (first page has NO param); otherwise it's explicit.
  const firstPageHasParam = paginationCandidates.some((c) => {
    if (zeroIndexed) return /[?&]page=0(?:&|$|#)/.test(c.href);
    return /[?&]page=1(?:&|$|#)/.test(c.href);
  });

  // totalPagesObserved: highest page number across all anchors.
  let maxPage: number | null = null;
  for (const c of paginationCandidates) {
    const n = extractPageNumber(c.href);
    if (n !== null && (maxPage === null || n > maxPage)) maxPage = n;
  }
  // Adjust for zero-indexed sites (Drupal gunpost: max anchor ?page=1691 → 1692 pages)
  const totalPagesObserved =
    maxPage !== null ? (zeroIndexed ? maxPage + 1 : maxPage) : null;

  // ── Step 2: Single-page / no-pagination handling ─────────────────────────
  if (paginationCandidates.length === 0) {
    if (page1Products.length < SINGLE_PAGE_THRESHOLD) {
      return {
        testUrl: catalogUrl,
        sortedTestUrl: opts.sortUrl ?? null,
        paginationPattern: null,
        page1ProductCount: page1Products.length,
        page2ProductCount: 0,
        zeroOverlap: false,
        overlapProducts: [],
        totalPagesObserved,
        lastPageItemCount: null,
        paginationLinkSample,
        verdict: 'single-page',
        verdictReason: `page 1 has ${page1Products.length} products and no pagination anchors — single-page catalog`,
        wallMs: Date.now() - t0,
      };
    }
    // Products exist but no pagination found in DOM — could be a site that
    // renders all products on page 1, OR pagination is JS/AJAX-driven (e.g.
    // WooCommerce themes with `data-type="load-more"` that render no anchors
    // but accept `/page/N/` URLs directly when visited). Try heuristic probes
    // against known pagination shapes in priority order, take the first that
    // produces zero-overlap fresh products.
    log(
      `[probe-pagination] no pagination anchors found but page 1 has ${page1Products.length} products — probing heuristic patterns`,
    );
    const heuristicCandidates: PaginationPatternShape[] = [
      { type: 'query', template: 'page' },
      { type: 'path', template: '/page/{N}' },
      { type: 'path', template: '/page/{N}/' },
      { type: 'query', template: 'paged' },
    ];
    for (const cand of heuristicCandidates) {
      const trialUrl = await buildPageUrl(baseUrl, 2, cand);
      // Skip if the builder produced the same URL as page 1 (offset-query
      // without perPage or malformed pattern)
      if (trialUrl === baseUrl) continue;
      const p2 = await runProbeExtraction(trialUrl, {
        ua,
        mode,
        wafSuspected: opts.wafSuspected,
        timeoutMs: opts.timeoutMs,
      });
      if (p2.status === null || p2.productCount === 0) continue;
      const p2UrlSet = new Set(p2.productsFound.map((p) => normalizeProductUrl(p.url)));
      const overlap = [...p2UrlSet].filter((u) => page1UrlSet.has(u));
      if (overlap.length === 0) {
        return {
          testUrl: catalogUrl,
          sortedTestUrl: opts.sortUrl ?? null,
          paginationPattern: cand,
          page1ProductCount: page1Products.length,
          page2ProductCount: p2.productCount,
          zeroOverlap: true,
          overlapProducts: [],
          totalPagesObserved,
          lastPageItemCount: null,
          paginationLinkSample,
          verdict: 'verified',
          verdictReason: `no DOM anchors found but heuristic ${cand.type}:${(cand as any).template} produced ${p2.productCount} fresh products (zero overlap)`,
          wallMs: Date.now() - t0,
        };
      }
      // Pattern produced products but they overlap — move on to next
    }
    return {
      testUrl: catalogUrl,
      sortedTestUrl: opts.sortUrl ?? null,
      paginationPattern: null,
      page1ProductCount: page1Products.length,
      page2ProductCount: 0,
      zeroOverlap: false,
      overlapProducts: [],
      totalPagesObserved,
      lastPageItemCount: null,
      paginationLinkSample,
      verdict: 'no-pagination-found',
      verdictReason: `no pagination anchors in DOM AND ${heuristicCandidates.length} heuristic patterns (${heuristicCandidates.map((c) => `${c.type}:${(c as any).template}`).join(', ')}) did not produce distinct products`,
      wallMs: Date.now() - t0,
    };
  }

  // ── Step 3: Pick pattern from anchors ────────────────────────────────────
  const picked = pickPatternFromAnchors(paginationCandidates);
  if (!picked) {
    log(`[probe-pagination] pagination anchors present but none matched known patterns`);
    return {
      testUrl: catalogUrl,
      sortedTestUrl: opts.sortUrl ?? null,
      paginationPattern: null,
      page1ProductCount: page1Products.length,
      page2ProductCount: 0,
      zeroOverlap: false,
      overlapProducts: [],
      totalPagesObserved,
      lastPageItemCount: null,
      paginationLinkSample,
      verdict: 'no-pagination-found',
      verdictReason: `${paginationCandidates.length} pagination anchors found but none matched any known pagination shape`,
      wallMs: Date.now() - t0,
    };
  }

  let pattern: PaginationPatternShape = picked.pattern;

  // Refine offset-query with measured perPage
  if (pattern.type === 'offset-query') {
    const perPage = measureOffsetPerPage(picked.anchorsForPattern, page1Products.length);
    pattern = { ...pattern, perPage };
  }

  // Attach zeroIndexed / firstPageHasParam to query-style pattern (the only
  // variant that carries them in the production interface). path-scheme sites
  // always have first-page-implicit and are 1-indexed; suffix-replace uses
  // page1 as the bare URL by convention.
  if (pattern.type === 'query') {
    const enriched: PaginationPatternShape & { zeroIndexed?: boolean; firstPageHasParam?: boolean } = {
      ...pattern,
    };
    if (zeroIndexed) enriched.zeroIndexed = true;
    if (firstPageHasParam) enriched.firstPageHasParam = true;
    pattern = enriched;
  }

  log(
    `[probe-pagination] picked pattern: ${JSON.stringify(pattern)} (frequency=${picked.frequency}/${paginationCandidates.length})`,
  );

  // ── Step 4: Build page-2 URL + fetch ─────────────────────────────────────
  // Strategy: PREFER the actual anchor href from the DOM for page 2. That
  // URL already encodes any required path prefixes (Celerant `/browse/`,
  // LightSpeed theme `/c/`, Volusion `?searching=Y&page=N`, etc.) that naive
  // base-URL + pattern synthesis would miss. Only fall back to synthesizing
  // via production `buildPaginatedUrl` when no anchor for page 2 exists.
  // If zeroIndexed, "page 2" semantically maps to URL `?page=1`.
  const zeroIndexedTargetPage = zeroIndexed ? 1 : 2;
  const page2Anchor = pickPageNAnchor(picked.anchorsForPattern, zeroIndexedTargetPage, zeroIndexed ? 0 : 1);

  let p2Url: string;
  if (page2Anchor) {
    p2Url = page2Anchor.href;
    log(`[probe-pagination] using DOM anchor for page 2: ${p2Url}`);
  } else if (zeroIndexed && pattern.type === 'query') {
    // Zero-indexed site with no anchor for page 2 — synthesize `?page=1`.
    try {
      const u = new URL(baseUrl);
      u.searchParams.set(pattern.template, String(zeroIndexedTargetPage));
      p2Url = u.toString();
    } catch {
      const sep = baseUrl.includes('?') ? '&' : '?';
      p2Url = `${baseUrl}${sep}${pattern.template}=${zeroIndexedTargetPage}`;
    }
    log(`[probe-pagination] synthesized zero-indexed page 2 URL: ${p2Url}`);
  } else {
    p2Url = await buildPageUrl(baseUrl, 2, pattern);
    log(`[probe-pagination] synthesized page 2 URL via buildPaginatedUrl: ${p2Url}`);
  }

  log(`[probe-pagination] page 2 fetch: ${p2Url}`);
  const page2 = await runProbeExtraction(p2Url, {
    ua,
    mode,
    wafSuspected: opts.wafSuspected,
    timeoutMs: opts.timeoutMs,
  });

  if (page2.status === null) {
    return {
      testUrl: catalogUrl,
      sortedTestUrl: opts.sortUrl ?? null,
      paginationPattern: pattern,
      page1ProductCount: page1Products.length,
      page2ProductCount: 0,
      zeroOverlap: false,
      overlapProducts: [],
      totalPagesObserved,
      lastPageItemCount: null,
      paginationLinkSample,
      verdict: 'broken-overlap',
      verdictReason: `page 2 fetch failed (${p2Url}); pattern may be wrong or site may block pagination requests: ${page2.warnings.join(' | ').slice(0, 200)}`,
      wallMs: Date.now() - t0,
    };
  }

  // ── Step 5: Zero-overlap test ────────────────────────────────────────────
  const page2Products = page2.productsFound;
  const page2UrlSet = new Set(page2Products.map((p) => normalizeProductUrl(p.url)));
  const overlap: string[] = [];
  for (const u of page2UrlSet) {
    if (page1UrlSet.has(u)) overlap.push(u);
  }

  let verdict: PaginationVerdict;
  let verdictReason: string;

  if (page2Products.length === 0) {
    // Page 2 returned 0 products. Could be legitimate last page (but then
    // page 1 would have been single-page already — we wouldn't be here),
    // a truly broken pattern, or a very small catalog (2 pages where page 2
    // is sparse). Treat as broken-overlap since the pattern produced a URL
    // that yields nothing fresh.
    verdict = 'broken-overlap';
    verdictReason = `page 2 (${p2Url}) returned 0 products; pattern may be ignored or URL is malformed`;
  } else if (overlap.length === 0) {
    verdict = 'verified';
    verdictReason = `page 1 (${page1Products.length}) vs page 2 (${page2Products.length}): zero URL overlap — pagination is honored`;
  } else if (overlap.length >= page1UrlSet.size && page2UrlSet.size <= page1UrlSet.size) {
    // Full overlap — pattern is silently ignored (Mistake 26/27)
    verdict = 'broken-overlap';
    verdictReason = `page 2 returned the SAME ${overlap.length} products as page 1 — pattern silently ignored (Mistake 26 LightSpeed / Mistake 27 Wix)`;
  } else {
    // Partial overlap — rare; pattern may be partially honored (e.g. sort
    // changed but offset didn't fully advance). Still fresh products exist.
    verdict = 'works-but-sort-ignored';
    verdictReason = `page 2 has ${overlap.length} overlapping URLs with page 1 out of ${page2Products.length}; partial pagination`;
  }

  const zeroOverlap = overlap.length === 0 && page2Products.length > 0;

  log(
    `[probe-pagination] verdict=${verdict} page1=${page1Products.length} page2=${page2Products.length} overlap=${overlap.length}`,
  );

  return {
    testUrl: catalogUrl,
    sortedTestUrl: opts.sortUrl ?? null,
    paginationPattern: pattern,
    page1ProductCount: page1Products.length,
    page2ProductCount: page2Products.length,
    zeroOverlap,
    overlapProducts: overlap.slice(0, 5),
    totalPagesObserved,
    lastPageItemCount: null,
    paginationLinkSample,
    verdict,
    verdictReason,
    wallMs: Date.now() - t0,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { url: string; opts: RunProbePaginationOpts } | null {
  const positional: string[] = [];
  const opts: RunProbePaginationOpts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sort-url') {
      const v = argv[++i];
      if (!v) return null;
      opts.sortUrl = v;
    } else if (a === '--ua') {
      const v = argv[++i];
      if (v === 'desktop' || v === 'iphone') opts.ua = v;
      else if (v?.startsWith('custom:')) opts.ua = v as UaMode;
      else return null;
    } else if (a === '--mode') {
      const v = argv[++i];
      if (v === 'static' || v === 'playwright' || v === 'auto') opts.mode = v;
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
      'usage: probe-pagination.ts <catalogUrl> [--sort-url <pre-sorted-url>] [--ua desktop|iphone|custom:<string>] [--mode static|playwright|auto] [--waf-suspected] [--timeout <ms>]\n',
    );
    return 2;
  }
  const result = await runProbePagination(parsed.url, parsed.opts);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  await closePlaywrightIfUsed();
  // Exit 1 only if page 1 fetch failed entirely.
  return result.page1ProductCount === 0 && result.verdict === 'no-pagination-found'
    ? 1
    : 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`probe-pagination crashed: ${e?.stack || e?.message || e}\n`);
      process.exit(1);
    });
}
