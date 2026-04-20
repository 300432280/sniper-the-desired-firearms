/**
 * probe-extraction.ts — Module 6 of the decomposed pre-bootstrap probe.
 *
 * Single responsibility: given ONE catalog URL, fetch it, run the production
 * `GenericRetailAdapter.extractCatalogProducts` against the parsed HTML, and
 * emit a raw envelope of:
 *   - products found (count, titles, URLs, prices, sourceIds)
 *   - raw sort <select> definitions (for Module 8 to consume)
 *   - raw pagination candidate anchors (for Module 9 to consume)
 *   - subcategory-tile heuristic (WooCommerce/BC Stencil parent-category pages
 *     that render category cards with "(N)" counts instead of real products)
 *   - double-render diagnostic (raw `data-product-id` regex count vs adapter
 *     deduped count — ratio > 1.5 signals BC Stencil quick-view shadow cards)
 *
 * Does NOT:
 *   - Decide adapter type (always uses GenericRetailAdapter — the most permissive
 *     selector set covers 95%+ of HTML storefronts; WooCommerce/Shopify API
 *     adapters are handled at a higher layer).
 *   - Run ID-jump sort verification (Module 8's job).
 *   - Test pagination zero-overlap (Module 9's job).
 *   - Follow pagination or walk the full catalog.
 *   - Rank candidates or pick a "best" URL.
 *
 * Key lesson encoded (Mistake 29 — BC Stencil double-render):
 *   The production `extractCatalogProducts` already dedupes via URL `Set` —
 *   that's the correct `productCount`. We ALSO emit the raw
 *   `data-product-id` regex count so the skill can diagnose "2× inflated"
 *   page-1 reports from older audits.
 *
 * Key lesson encoded (Mistake 38 — sub-category tile false positive):
 *   WooCommerce /product-category/firearms/ returns sub-category tiles with
 *   titles like "HANDGUNS (778)" and "RIFLES (1693)", no sort select, no real
 *   products. We emit `subcategoryTilesFound` so the skill can detect and
 *   walk deeper into a leaf category before reading sort/pagination.
 *
 * Cheerio is lazy-loaded INSIDE the function body — matching the probe-catalog-
 * urls.ts pattern. A top-level `import * as cheerio from 'cheerio'` breaks the
 * native-fetch HPE fallback path via some transitive dep's module-init side
 * effect on Node's HTTP parser.
 *
 * CLI:
 *   npx tsx scripts/probe-modules/probe-extraction.ts <catalogUrl>
 *     [--mode static|playwright|auto]
 *     [--ua desktop|iphone|custom:<string>]
 *     [--waf-suspected]
 *
 * Output: JSON to stdout. Progress to stderr.
 * Exit: 0 if fetch succeeded; 1 if fetch failed entirely; 2 on bad args.
 */

import { fetchForProbe, closePlaywrightIfUsed, UaMode, FetchMode } from './probe-fetch';

// Cheerio type alias — see note in probe-catalog-urls.ts for why we can't
// import it at module top.
type CheerioAPI = any;

// ── Types ────────────────────────────────────────────────────────────────────

export interface ExtractedProduct {
  title: string;
  url: string;
  price: number | null;
  sourceId: string | null;
}

export interface PaginationCandidate {
  href: string;
  text: string;
  rel: string | null;
}

export interface SortSelectOption {
  value: string;
  text: string;
}

export interface SortSelect {
  name: string | null;
  id: string | null;
  options: SortSelectOption[];
}

export interface ProbeExtractionResult {
  url: string;
  fetchMethod: 'axios' | 'native-fetch' | 'playwright' | null;
  status: number | null;
  bodyBytes: number;
  productsFound: ExtractedProduct[];
  productCount: number;
  productCountRaw: number;
  subcategoryTilesFound: number;
  hasSortSelect: boolean;
  hasPaginationMarker: boolean;
  paginationCandidates: PaginationCandidate[];
  sortSelects: SortSelect[];
  warnings: string[];
  wallMs: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const log = (m: string) => process.stderr.write(m + '\n');

/**
 * Raw count of `data-product-id` markers in the page HTML. Used as a
 * BC-Stencil double-render diagnostic — the production adapter's Set-based
 * dedup is authoritative, but if raw/dedup > 1.5 the skill knows to warn
 * about legacy page-1 counts that may be 2× inflated.
 */
function countRawProductIdMarkers(html: string): number {
  if (!html) return 0;
  const m = html.match(/data-product-id="\d+"/g);
  return m ? m.length : 0;
}

/**
 * Detect subcategory-tile pages. Heuristic:
 *   - >=5 anchors whose visible text matches `<name>(<N>)` counts
 *     (e.g. "HANDGUNS (778)", "Rifles (1,693)") — these are WooCommerce
 *     `.product-category` tiles, BC Stencil subcategory cards, Shopify
 *     collection tiles, etc. The "(N)" count is the canonical signature.
 *   - This heuristic is applied AFTER we know productCount is low (<3).
 *     We still always emit the raw count so the skill can decide.
 */
function countSubcategoryTiles($: CheerioAPI): number {
  let n = 0;
  $('a').each((_: any, el: any) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (!text) return;
    // Match "<something> (<number>)" — number can have commas.
    // Reject very long text (paragraphs), require the text to END with the
    // count pattern so we don't match "Order by 2 PM (Mon–Fri)" navigation.
    if (text.length > 80) return;
    if (/\(\s*\d[\d,]*\s*\)\s*$/.test(text)) n++;
  });
  return n;
}

/**
 * Extract raw sort <select> definitions. We emit EVERYTHING that looks like a
 * sort dropdown — Module 8 decides which one is the newest sort.
 * Heuristics for "looks like a sort dropdown":
 *   - <select> element with name/id matching /sort|order|orderby/i,
 *   - OR any <select> with >=2 options where option text contains
 *     /newest|latest|date|price|name|popular|featured|rating|alpha/i.
 */
function extractSortSelects($: CheerioAPI): SortSelect[] {
  const result: SortSelect[] = [];
  $('select').each((_: any, el: any) => {
    const $el = $(el);
    const name: string | null = $el.attr('name') || null;
    const id: string | null = $el.attr('id') || null;
    const nameOrId = `${name || ''} ${id || ''}`.toLowerCase();
    const options: SortSelectOption[] = [];
    $el.find('option').each((_i: any, optEl: any) => {
      const $opt = $(optEl);
      const value = ($opt.attr('value') || '').trim();
      const text = $opt.text().replace(/\s+/g, ' ').trim();
      if (!value && !text) return;
      options.push({ value, text });
    });
    if (options.length === 0) return;

    // Gate 1: name/id signals sort
    const isSortyName = /sort|order(by)?/i.test(nameOrId);
    // Gate 2: options mention known sort terms
    const sortTermRe =
      /newest|latest|date|price|name|popular|featured|rating|alpha|recent|created|published/i;
    const isSortyOptions =
      options.length >= 2 && options.some((o) => sortTermRe.test(o.text) || sortTermRe.test(o.value));

    if (!isSortyName && !isSortyOptions) return;
    result.push({ name, id, options });
  });
  return result;
}

/**
 * Extract raw pagination candidate anchors. Module 9 decides pagination
 * scheme — this module just surfaces any anchor that could plausibly be
 * part of pagination.
 * Heuristics:
 *   - <a rel="next">, <a rel="prev"> (W3C signal),
 *   - anchors inside common pagination containers: `.pagination`, `.pager`,
 *     `[class*="page-numbers"]`, `nav[aria-label*="pagination" i]`,
 *   - anchors whose text is a pure integer (page number),
 *   - anchors whose href matches common pagination URL patterns:
 *     `/page/\d+`, `?page=\d+`, `?p=\d+`, `page\d+.html`, `/start=\d+`,
 *     `?offset=\d+`, `?from=\d+`, `&sort=...page=...`.
 */
function extractPaginationCandidates($: CheerioAPI, baseUrl: string): PaginationCandidate[] {
  const candidates: PaginationCandidate[] = [];
  const seen = new Set<string>();

  // Pagination-ish containers
  const CONTAINER_SEL = [
    '.pagination',
    '.pager',
    '[class*="page-numbers"]',
    '[class*="pagination"]',
    'nav[aria-label*="pagination" i]',
    'ul[class*="pagination"]',
  ].join(', ');

  const pushCandidate = (href: string, text: string, rel: string | null) => {
    if (!href) return;
    let abs: string;
    try {
      abs = new URL(href, baseUrl).toString();
    } catch {
      return;
    }
    if (seen.has(abs)) return;
    seen.add(abs);
    candidates.push({ href: abs, text: text.replace(/\s+/g, ' ').trim().slice(0, 50), rel });
  };

  // 1. rel=next / rel=prev (authoritative W3C signal)
  $('a[rel]').each((_: any, el: any) => {
    const $el = $(el);
    const rel = ($el.attr('rel') || '').toLowerCase();
    if (!/\b(next|prev|previous)\b/.test(rel)) return;
    pushCandidate($el.attr('href') || '', $el.text(), rel);
  });

  // 2. Anchors in pagination containers
  $(CONTAINER_SEL).each((_: any, el: any) => {
    $(el)
      .find('a[href]')
      .each((_i: any, anchorEl: any) => {
        const $a = $(anchorEl);
        pushCandidate($a.attr('href') || '', $a.text(), $a.attr('rel') || null);
      });
  });

  // 3. Anchors whose href matches common pagination URL patterns
  const URL_PATTERNS =
    /(?:\/page\/\d+(?:\/|$|\?)|[?&]page=\d+|[?&]p=\d+|page\d+\.html|[?&]start=\d+|[?&]offset=\d+|[?&]from=\d+)/i;
  $('a[href]').each((_: any, el: any) => {
    const href = $(el).attr('href') || '';
    if (!URL_PATTERNS.test(href)) return;
    const text = $(el).text();
    pushCandidate(href, text, $(el).attr('rel') || null);
  });

  return candidates;
}

// ── Main public API ──────────────────────────────────────────────────────────

export interface RunProbeExtractionOpts {
  mode?: FetchMode;
  ua?: UaMode;
  wafSuspected?: boolean;
  timeoutMs?: number;
}

export async function runProbeExtraction(
  catalogUrl: string,
  opts: RunProbeExtractionOpts = {},
): Promise<ProbeExtractionResult> {
  const t0 = Date.now();
  const warnings: string[] = [];

  log(`[probe-extraction] fetching: ${catalogUrl} (ua=${opts.ua ?? 'desktop'} mode=${opts.mode ?? 'auto'})`);
  const fr = await fetchForProbe(catalogUrl, {
    ua: opts.ua ?? 'desktop',
    mode: opts.mode ?? 'auto',
    accept: 'html',
    timeoutMs: opts.timeoutMs ?? 25_000,
    wafSuspected: opts.wafSuspected,
    fullBody: true, // extraction needs the whole document, not just 8KB
  });

  if (fr.status === null) {
    warnings.push(
      `fetch failed: ${fr.errors.map((e) => e.message).join('; ').slice(0, 250)}`,
    );
    return {
      url: catalogUrl,
      fetchMethod: null,
      status: null,
      bodyBytes: 0,
      productsFound: [],
      productCount: 0,
      productCountRaw: 0,
      subcategoryTilesFound: 0,
      hasSortSelect: false,
      hasPaginationMarker: false,
      paginationCandidates: [],
      sortSelects: [],
      warnings,
      wallMs: Date.now() - t0,
    };
  }

  const html = fr.bodySample || '';
  const bodyBytes = fr.bodyBytes;

  // Lazy-load cheerio INSIDE the function — see probe-catalog-urls.ts comment.
  // By the time this line runs, the fetch() call in probe-fetch has already
  // completed, so any HTTP-parser monkey-patching from cheerio's transitive
  // deps can no longer corrupt ongoing native-fetch calls for this request.
  const { load: cheerioLoad } = await import('cheerio');
  const $ = cheerioLoad(html);

  // Lazy-load the production adapter. Same reasoning as cheerio — we don't
  // want any adapter-layer module init firing before probe-fetch's retry paths
  // have completed. Also sidesteps CJS/ESM import timing on `npx tsx`.
  const { GenericRetailAdapter } = await import(
    '../../src/services/scraper/adapters/generic-retail'
  );
  const adapter = new GenericRetailAdapter();

  // ── Run the production extractor ───────────────────────────────────────────
  let catalogProducts: Array<{
    url: string;
    title: string;
    price?: number;
    sourceId?: string;
  }> = [];
  try {
    catalogProducts = adapter.extractCatalogProducts($, catalogUrl) as any[];
  } catch (e: any) {
    warnings.push(`extractCatalogProducts threw: ${e?.message || e}`);
    catalogProducts = [];
  }

  const productsFound: ExtractedProduct[] = catalogProducts.map((p) => ({
    title: p.title,
    url: p.url,
    price: typeof p.price === 'number' ? p.price : null,
    sourceId: p.sourceId ? String(p.sourceId) : null,
  }));

  const productCount = productsFound.length;
  const productCountRaw = countRawProductIdMarkers(html);

  // ── Subcategory-tile heuristic ─────────────────────────────────────────────
  const subcategoryTilesFound = countSubcategoryTiles($);

  // ── Sort <select> extraction ───────────────────────────────────────────────
  const sortSelects = extractSortSelects($);

  // ── Pagination candidates ──────────────────────────────────────────────────
  const paginationCandidates = extractPaginationCandidates($, catalogUrl);

  // ── Diagnostic warnings (non-blocking) ─────────────────────────────────────
  if (productCount > 0 && productCountRaw / productCount > 1.5) {
    warnings.push(
      `raw data-product-id count (${productCountRaw}) exceeds deduped count (${productCount}) by ${(productCountRaw / productCount).toFixed(2)}× — possible BC Stencil double-render (Mistake 29)`,
    );
  }
  if (productCount < 3 && subcategoryTilesFound >= 5) {
    warnings.push(
      `only ${productCount} products extracted but ${subcategoryTilesFound} subcategory tiles detected — likely parent-category-only page, skill should walk deeper (Mistake 38)`,
    );
  }

  // Self-consistency check — productsFound.length must equal productCount.
  if (productsFound.length !== productCount) {
    warnings.push(
      `self-consistency violation: productsFound.length=${productsFound.length} != productCount=${productCount}`,
    );
  }

  return {
    url: catalogUrl,
    fetchMethod: fr.method,
    status: fr.status,
    bodyBytes,
    productsFound,
    productCount,
    productCountRaw,
    subcategoryTilesFound,
    hasSortSelect: sortSelects.length > 0,
    hasPaginationMarker: paginationCandidates.length > 0,
    paginationCandidates,
    sortSelects,
    warnings,
    wallMs: Date.now() - t0,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { url: string; opts: RunProbeExtractionOpts } | null {
  const positional: string[] = [];
  const opts: RunProbeExtractionOpts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode') {
      const v = argv[++i];
      if (v === 'static' || v === 'playwright' || v === 'auto') opts.mode = v;
      else return null;
    } else if (a === '--ua') {
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
      'usage: probe-extraction.ts <catalogUrl> [--mode static|playwright|auto] [--ua desktop|iphone|custom:<string>] [--waf-suspected] [--timeout <ms>]\n',
    );
    return 2;
  }
  const result = await runProbeExtraction(parsed.url, parsed.opts);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  await closePlaywrightIfUsed();
  // Exit 0 if we got a status; exit 1 only if the fetch failed entirely.
  return result.status === null ? 1 : 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`probe-extraction crashed: ${e?.stack || e?.message || e}\n`);
      process.exit(1);
    });
}
