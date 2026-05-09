/**
 * @deprecated 2026-04-27 — Generic discovery superseded by AI-driven per-site audit.
 * See `_DEPRECATED.md` in this folder and `docs/superpowers/plans/2026-04-27-pivot-to-ai-audit.md`.
 * Do not import from this file in new code.
 */
// backend/scripts/probe/geography-count/pagination-detect.ts
// Moved from the navigation stage → geography-count stage so walk-verify can use the discovered pattern.
// Detects pagination pattern (query / path / offset-query / suffix-replace)
// and verifies via 4 tests (A: silent-ignore, B: clamp-to-last, C: wrap-around, D: perPage-sanity).
// See spec §4.3 (now owns pagination), playbook Mistake 14 (template formats), Mistake 15 (jPages null pattern).

import * as cheerio from 'cheerio';
import { fetchUrl } from '../shared/fetch';
import { extractProducts, type ExtractedProduct } from '../shared/extract';
import { detectTotalPagesFromHtml } from '../../../src/services/catalog-crawler';
import type { AccessIdentityState, PaginationPattern, GeographyCountState } from '../shared/types';

// ─── Types ──────────────────────────────────────────────────────────────────

export type PaginationDetectInput = AccessIdentityState & { catalogUrls: string[] };

export type PaginationDetectResult = {
  pattern: PaginationPattern;
  evidence: GeographyCountState['paginationEvidence'];
};

type PageData = { products: ExtractedProduct[]; html: string };

// ─── URL builders — MUST match production buildPaginatedUrl (catalog-crawler.ts:118-166) ──

export function buildPagedUrl(baseUrl: string, pageN: number, pattern: PaginationPattern): string {
  // For zero-indexed pagination, page 1 in our logic = page 0 in the URL,
  // page 2 = page 1, etc. Adjust the actual page number sent to the URL.
  const actualPage = pattern.zeroIndexed ? pageN - 1 : pageN;

  // For zero-indexed: actualPage=0 is the first page, which should use the base URL
  // (if firstPageHasParam is false). For 1-indexed: pageN<=1 uses base URL.
  if (pattern.zeroIndexed) {
    if (actualPage <= 0 && !pattern.firstPageHasParam) return baseUrl;
  } else {
    if (pageN <= 1) return baseUrl;
  }

  if (pattern.type === 'path') {
    const template = pattern.template || '/page/{N}';
    const stripped = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    return `${stripped}${template.replace('{N}', String(actualPage))}`;
  }

  if (pattern.type === 'suffix-replace') {
    const match = pattern.match || '.html';
    const template = pattern.template || '-{N}.html';
    if (!baseUrl.endsWith(match)) {
      return baseUrl + template.replace('{N}', String(actualPage));
    }
    const withoutSuffix = baseUrl.slice(0, baseUrl.length - match.length);
    return withoutSuffix + template.replace('{N}', String(actualPage));
  }

  if (pattern.type === 'offset-query') {
    const paramName = pattern.template || 'offset';
    if (!pattern.perPage) {
      const sep = baseUrl.includes('?') ? '&' : '?';
      return `${baseUrl}${sep}${paramName}=${actualPage}`;
    }
    // For offset-query, zero-indexed adjustment already applied via actualPage.
    // offset = actualPage * perPage (when zero-indexed) or (pageN-1) * perPage (when 1-indexed)
    const offset = pattern.zeroIndexed ? actualPage * pattern.perPage : (pageN - 1) * pattern.perPage;
    const sep = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${sep}${paramName}=${offset}`;
  }

  // Default: query type
  const paramName = pattern.template || 'page';
  try {
    const url = new URL(baseUrl);
    url.searchParams.set(paramName, String(actualPage));
    return url.toString();
  } catch {
    const re = new RegExp(`([?&])${paramName}=\\d+`);
    if (re.test(baseUrl)) {
      return baseUrl.replace(re, `$1${paramName}=${actualPage}`);
    }
    const sep = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${sep}${paramName}=${actualPage}`;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function first3Urls(products: ExtractedProduct[]): string[] {
  return products.slice(0, 3).map(p => p.url);
}

async function fetchAndExtract(url: string, state: PaginationDetectInput): Promise<PageData> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetchUrl(url, {
        hasWaf: state.hasWaf,
        wafType: state.wafType,
        ua: state.userAgentOverride ?? undefined,
        timeoutMs: 20000,
      });
      const products = (r.status < 400) ? extractProducts(r.body, url, state.platform) : [];
      return { products, html: r.body };
    } catch (e) {
      if (attempt === 0) {
        process.stderr.write(`  [pagination-detect] fetch retry for ${url}: ${(e as Error).message}\n`);
        continue;
      }
      return { products: [], html: '' };
    }
  }
  return { products: [], html: '' };  // unreachable, satisfies TS
}

function pickBestCatalogUrl(catalogUrls: string[]): string {
  // Prefer real category URLs over "shop-all" pages for pagination testing.
  // Shop-all/featured pages often have curated content without standard pagination.
  // The caller (index.ts) sorts candidates by product count with category URLs first.
  // Just return the first URL (respecting the caller's ordering).
  return catalogUrls[0];
}

function widgetTotalPages(html: string): number {
  const $ = cheerio.load(html);
  const detected = detectTotalPagesFromHtml($, '');
  return detected ?? 0;
}

function estimateTotalPages(widget: number, perPage: number): number {
  if (widget > 0) return widget;
  // Without global count at this stage, use a conservative estimate
  return 5;
}

// ─── Candidate patterns ─────────────────────────────────────────────────────

function candidatePatterns(perPage: number): PaginationPattern[] {
  const base = { perPage, firstPageHasParam: false, startPage: 1 };
  return [
    { type: 'query',          template: 'page',  ...base },
    { type: 'query',          template: 'p',     ...base },
    { type: 'path',           template: '/page/{N}', ...base },
    { type: 'offset-query',   template: 'offset', ...base },
    { type: 'offset-query',   template: 'top',    ...base },
    { type: 'offset-query',   template: 'start',  ...base },
    { type: 'suffix-replace', match: '.html', template: '-{N}.html', ...base },
    { type: 'suffix-replace', match: '.html', template: 'page{N}.html', ...base },
  ];
}

// ─── Main ───────────────────────────────────────────────────────────────────

const NULL_EVIDENCE: GeographyCountState['paginationEvidence'] = {
  testA_page1_vs_page2: { passed: false, sample: [] },
  testB_pageN_vs_pageN_1: { passed: false, sample: [] },
  testC_overflow_vs_page1: { passed: false, sample: [] },
  testD_perPage_sanity: { passed: false, observedPerPage: 0, expectedPerPage: 0 },
  totalPagesEstimate: 1,
  totalPagesSource: 'walk-to-empty',
};

export async function detectPagination(state: PaginationDetectInput): Promise<PaginationDetectResult> {
  const candidate = pickBestCatalogUrl(state.catalogUrls);
  process.stderr.write(`  [pagination-detect] testing ${candidate}\n`);

  // Fetch page 1 baseline
  const page1 = await fetchAndExtract(candidate, state);
  const observedPerPage = page1.products.length;

  if (observedPerPage === 0) {
    return {
      pattern: { type: null, perPage: 0, firstPageHasParam: false, startPage: 1 },
      evidence: NULL_EVIDENCE,
    };
  }

  const widget = widgetTotalPages(page1.html);
  const totalPages = estimateTotalPages(widget, observedPerPage);
  const totalPagesSource: GeographyCountState['paginationEvidence']['totalPagesSource'] =
    widget > 0 ? 'widget-markup' : 'walk-to-empty';

  const first3p1 = first3Urls(page1.products);
  const patterns = candidatePatterns(observedPerPage);

  for (const pattern of patterns) {
    const page2Url = buildPagedUrl(candidate, 2, pattern);
    process.stderr.write(`  [pagination-detect] trying ${pattern.type}/${pattern.template} → ${page2Url}\n`);

    let page2: PageData;
    try {
      page2 = await fetchAndExtract(page2Url, state);
    } catch { continue; }

    const first3p2 = first3Urls(page2.products);
    const testAPassed = page2.products.length > 0 && !arraysEqual(first3p1, first3p2);
    if (!testAPassed) continue;

    // Test A passed — this pattern works for page 2.
    // Zero-indexed detection for query-type pagination.
    // Two heuristics, either is sufficient:
    // (A) Fetch page=0 — if its products match the base URL products, zero-indexed.
    //     NOTE: on live classifieds sites, products change between fetches, so
    //     "match" means significant overlap (>= 50% shared URLs), not exact equality.
    // (B) Check the page-1 HTML for pagination widget links containing "page=0" —
    //     if the pagination widget's first page link uses page=0, the site is zero-indexed.
    //     This is more reliable than content comparison for live/dynamic sites.
    let isZeroIndexed = false;
    if (pattern.type === 'query') {
      const paramName = pattern.template || 'page';

      // Heuristic B: check pagination links in page-1 HTML for page=0
      const paginationLinkRe = new RegExp(`[?&]${paramName}=0(?:&|$|"|\')`, 'i');
      const pagerRe = /class="[^"]*pager[^"]*"/i;
      if (pagerRe.test(page1.html) && paginationLinkRe.test(page1.html)) {
        isZeroIndexed = true;
        process.stderr.write(`  [pagination-detect] zero-indexed detected: pagination widget contains ${paramName}=0 link\n`);
      }

      // Heuristic A: fetch page=0 and compare products (fallback for sites without pager widget)
      if (!isZeroIndexed) {
        try {
          const page0Url = (() => {
            try {
              const u = new URL(candidate);
              u.searchParams.set(paramName, '0');
              return u.toString();
            } catch {
              const sep = candidate.includes('?') ? '&' : '?';
              return `${candidate}${sep}${paramName}=0`;
            }
          })();
          const page0 = await fetchAndExtract(page0Url, state);
          const first3p0 = first3Urls(page0.products);

          if (page0.products.length > 0 && arraysEqual(first3p1, first3p0)) {
            // page=0 returns same products as base URL → zero-indexed
            isZeroIndexed = true;
            process.stderr.write(`  [pagination-detect] zero-indexed detected: page=0 matches base URL products\n`);
          } else if (page0.products.length > 0) {
            // Products differ — check overlap (for live sites where content shifts between fetches)
            const baseUrls = new Set(page1.products.map(p => p.url));
            const overlapCount = page0.products.filter(p => baseUrls.has(p.url)).length;
            const overlapPct = page0.products.length > 0 ? overlapCount / page0.products.length : 0;
            if (overlapPct >= 0.5) {
              isZeroIndexed = true;
              process.stderr.write(`  [pagination-detect] zero-indexed detected: page=0 has ${(overlapPct * 100).toFixed(0)}% overlap with base URL\n`);
            } else {
              process.stderr.write(`  [pagination-detect] page=0 has only ${(overlapPct * 100).toFixed(0)}% overlap with base — keeping 1-indexed\n`);
            }
          }
        } catch {
          // page=0 probe failed — keep 1-indexed (safe default)
        }
      }
    }

    // Run B/C/D if totalPages >= 3.
    let testB = { passed: false, sample: [] as string[] };
    let testC = { passed: false, sample: [] as string[] };
    let testD = { passed: false, observedPerPage, expectedPerPage: observedPerPage };

    if (totalPages >= 3) {
      try {
        const pNm1 = await fetchAndExtract(buildPagedUrl(candidate, totalPages - 1, pattern), state);
        const pN = await fetchAndExtract(buildPagedUrl(candidate, totalPages, pattern), state);
        const sameLast = arraysEqual(first3Urls(pNm1.products), first3Urls(pN.products));
        testB = { passed: pN.products.length > 0 && !sameLast, sample: first3Urls(pN.products) };
        testD = {
          passed: pNm1.products.length === observedPerPage,
          observedPerPage: pNm1.products.length,
          expectedPerPage: observedPerPage,
        };

        const pOver = await fetchAndExtract(buildPagedUrl(candidate, totalPages + 2, pattern), state);
        const wrappedToP1 = pOver.products.length > 0 && arraysEqual(first3Urls(pOver.products), first3p1);
        testC = { passed: !wrappedToP1, sample: first3Urls(pOver.products) };
      } catch {
        // Network failures on deep pages — tests remain false but pattern still wins on Test A
      }
    }

    return {
      pattern: { ...pattern, perPage: observedPerPage, zeroIndexed: isZeroIndexed },
      evidence: {
        testA_page1_vs_page2: { passed: true, sample: first3p2 },
        testB_pageN_vs_pageN_1: testB,
        testC_overflow_vs_page1: testC,
        testD_perPage_sanity: testD,
        totalPagesEstimate: totalPages,
        totalPagesSource,
      },
    };
  }

  // No pattern passed Test A — single-page catalog or jPages client-side (Mistake 15)
  return {
    pattern: { type: null, perPage: observedPerPage, firstPageHasParam: false, startPage: 1 },
    evidence: {
      ...NULL_EVIDENCE,
      testD_perPage_sanity: { passed: true, observedPerPage, expectedPerPage: observedPerPage },
      totalPagesEstimate: totalPages,
      totalPagesSource,
    },
  };
}
