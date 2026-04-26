// backend/scripts/probe/room4-navigation/pagination-detect.ts
// Room 4 Task 5.1: Detect pagination pattern (query / path / offset-query / suffix-replace)
// and verify via 4 tests (A: silent-ignore, B: clamp-to-last, C: wrap-around, D: perPage-sanity).
// See spec §4.4, playbook Mistake 14 (template formats), Mistake 15 (jPages null pattern).

import * as cheerio from 'cheerio';
import { fetchUrl } from '../shared/fetch';
import { extractProducts, type ExtractedProduct } from '../shared/extract';
import { detectTotalPagesFromHtml } from '../../../src/services/catalog-crawler';
import type { GeographyCountState, PaginationPattern, NavigationState } from '../shared/types';

// ─── Types ──────────────────────────────────────────────────────────────────

export type PaginationDetectResult = {
  pattern: PaginationPattern;
  evidence: NavigationState['paginationEvidence'];
};

type PageData = { products: ExtractedProduct[]; html: string };

// ─── URL builders — MUST match production buildPaginatedUrl (catalog-crawler.ts:118-166) ──

function buildPagedUrl(baseUrl: string, pageN: number, pattern: PaginationPattern): string {
  if (pageN <= 1) return baseUrl;

  if (pattern.type === 'path') {
    const template = pattern.template || '/page/{N}';
    const stripped = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    return `${stripped}${template.replace('{N}', String(pageN))}`;
  }

  if (pattern.type === 'suffix-replace') {
    const match = pattern.match || '.html';
    const template = pattern.template || '-{N}.html';
    if (!baseUrl.endsWith(match)) {
      return baseUrl + template.replace('{N}', String(pageN));
    }
    const withoutSuffix = baseUrl.slice(0, baseUrl.length - match.length);
    return withoutSuffix + template.replace('{N}', String(pageN));
  }

  if (pattern.type === 'offset-query') {
    const paramName = pattern.template || 'offset';
    if (!pattern.perPage) {
      const sep = baseUrl.includes('?') ? '&' : '?';
      return `${baseUrl}${sep}${paramName}=${pageN}`;
    }
    const offset = (pageN - 1) * pattern.perPage;
    const sep = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${sep}${paramName}=${offset}`;
  }

  // Default: query type
  const paramName = pattern.template || 'page';
  try {
    const url = new URL(baseUrl);
    url.searchParams.set(paramName, String(pageN));
    return url.toString();
  } catch {
    const re = new RegExp(`([?&])${paramName}=\\d+`);
    if (re.test(baseUrl)) {
      return baseUrl.replace(re, `$1${paramName}=${pageN}`);
    }
    const sep = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${sep}${paramName}=${pageN}`;
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

async function fetchAndExtract(url: string, state: GeographyCountState): Promise<PageData> {
  // Retry once on transient network errors (Celerant HPE sites are intermittent)
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
      // Second attempt failed — return empty rather than throwing
      return { products: [], html: '' };
    }
  }
  return { products: [], html: '' };  // unreachable, satisfies TS
}

function pickBestCatalogUrl(state: GeographyCountState): string {
  // Pick the catalogUrl with the highest product count from walkCounts.
  // Fallback to first catalogUrl.
  if (state.catalogUrlWalkCounts.length > 0) {
    const best = [...state.catalogUrlWalkCounts].sort((a, b) => b.uniqueProducts - a.uniqueProducts)[0];
    if (best.uniqueProducts > 0) return best.url;
  }
  return state.catalogUrls[0];
}

function widgetTotalPages(html: string): number {
  const $ = cheerio.load(html);
  // Reuse production logic — takes ($, currentUrl) but currentUrl is only used
  // for logging, so passing '' is safe.
  const detected = detectTotalPagesFromHtml($, '');
  return detected ?? 0;
}

function estimateTotalPages(widget: number, globalCount: number, perPage: number): number {
  if (widget > 0) return widget;
  if (globalCount > 0 && perPage > 0) return Math.ceil(globalCount / perPage);
  return 5;
}

// ─── Candidate patterns ─────────────────────────────────────────────────────

function candidatePatterns(perPage: number): PaginationPattern[] {
  const base = { perPage, firstPageHasParam: false, startPage: 1 };
  return [
    { type: 'query',          template: 'page',  ...base },
    { type: 'query',          template: 'p',     ...base },
    { type: 'path',           template: '/page/{N}', ...base },
    { type: 'offset-query',   template: 'offset', ...base },  // production buildPaginatedUrl default param
    { type: 'offset-query',   template: 'top',    ...base },
    { type: 'offset-query',   template: 'start',  ...base },
    { type: 'suffix-replace', match: '.html', template: '-{N}.html', ...base },
    { type: 'suffix-replace', match: '.html', template: 'page{N}.html', ...base },
  ];
}

// ─── Main ───────────────────────────────────────────────────────────────────

const NULL_EVIDENCE: NavigationState['paginationEvidence'] = {
  testA_page1_vs_page2: { passed: false, sample: [] },
  testB_pageN_vs_pageN_1: { passed: false, sample: [] },
  testC_overflow_vs_page1: { passed: false, sample: [] },
  testD_perPage_sanity: { passed: false, observedPerPage: 0, expectedPerPage: 0 },
  totalPagesEstimate: 1,
  totalPagesSource: 'walk-to-empty',
};

export async function detectPagination(state: GeographyCountState): Promise<PaginationDetectResult> {
  const candidate = pickBestCatalogUrl(state);
  process.stderr.write(`  [pagination-detect] testing ${candidate}\n`);

  // Fetch page 1 baseline
  const page1 = await fetchAndExtract(candidate, state);
  const observedPerPage = page1.products.length;

  if (observedPerPage === 0) {
    // No products on page 1 — cannot detect pagination
    return {
      pattern: { type: null, perPage: 0, firstPageHasParam: false, startPage: 1 },
      evidence: NULL_EVIDENCE,
    };
  }

  const widget = widgetTotalPages(page1.html);
  const totalPages = estimateTotalPages(widget, state.globalProductCount, observedPerPage);
  const totalPagesSource: NavigationState['paginationEvidence']['totalPagesSource'] =
    widget > 0 ? 'widget-markup' : (state.globalProductCount > 0 ? 'sitemap-math' : 'walk-to-empty');

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

    // Test A passed — this pattern works for page 2. Run B/C/D if totalPages >= 3.
    let testB = { passed: false, sample: [] as string[] };
    let testC = { passed: false, sample: [] as string[] };
    let testD = { passed: false, observedPerPage, expectedPerPage: observedPerPage };

    if (totalPages >= 3) {
      try {
        // Test B: page N-1 vs page N — must differ (no clamp-to-last)
        const pNm1 = await fetchAndExtract(buildPagedUrl(candidate, totalPages - 1, pattern), state);
        const pN = await fetchAndExtract(buildPagedUrl(candidate, totalPages, pattern), state);
        const sameLast = arraysEqual(first3Urls(pNm1.products), first3Urls(pN.products));
        testB = { passed: pN.products.length > 0 && !sameLast, sample: first3Urls(pN.products) };
        // Test D: page N-1 should have exactly perPage products
        testD = {
          passed: pNm1.products.length === observedPerPage,
          observedPerPage: pNm1.products.length,
          expectedPerPage: observedPerPage,
        };

        // Test C: page N+2 should NOT wrap to page 1
        const pOver = await fetchAndExtract(buildPagedUrl(candidate, totalPages + 2, pattern), state);
        const wrappedToP1 = pOver.products.length > 0 && arraysEqual(first3Urls(pOver.products), first3p1);
        testC = { passed: !wrappedToP1, sample: first3Urls(pOver.products) };
      } catch {
        // Network failures on deep pages — tests remain false but pattern still wins on Test A
      }
    }

    return {
      pattern: { ...pattern, perPage: observedPerPage },
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
