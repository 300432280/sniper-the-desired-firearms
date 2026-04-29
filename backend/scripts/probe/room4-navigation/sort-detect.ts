/**
 * @deprecated 2026-04-27 — Generic discovery superseded by AI-driven per-site audit.
 * See `_DEPRECATED.md` in this folder and `docs/superpowers/plans/2026-04-27-pivot-to-ai-audit.md`.
 * Do not import from this file in new code.
 */
// backend/scripts/probe/room4-navigation/sort-detect.ts
// Room 4 Task 5.2: Detect sort param by reading <select> HTML, filtering newest-style
// candidates, and verifying via 3-outcome ID-jump + counter-control (Mistake 29).
//
// Key playbook Mistakes encoded:
//   2  — never guess param names, READ <select> name/id attr
//   18 — "no sort UI" ≠ "no sort possible" — probe platform-known params directly
//   20 — Magento merchant-customizable: read each install's <select id="sorter">
//   21 — OpenCart visible dropdown incomplete: also probe p.date_added
//   24 — Volusion needs searching=Y activation flag
//   25 — Searchspring hijacks sort into hash fragment (detect + return null with evidence)
//   29 — 3-outcome: honored / honored-default-is-newest / noop
//   31 — Ecwid sort is JSON POST body, not URL param (detect + return null with evidence)

import * as cheerio from 'cheerio';
import { fetchUrl } from '../shared/fetch';
import { extractProducts, type ExtractedProduct } from '../shared/extract';
import type { GeographyCountState, NavigationState } from '../shared/types';

// ─── Types ──────────────────────────────────────────────────────────────────

export type SortDetectResult = {
  sortParam: string | null;
  evidence: NavigationState['sortEvidence'];
};

type SelectInfo = {
  name: string;       // the <select>'s name attr (or id as fallback) — this IS the URL param per Mistake 2
  id: string;
  options: Array<{ value: string; text: string }>;
};

type PageData = { products: ExtractedProduct[]; html: string };

// ─── Regexes ────────────────────────────────────────────────────────────────

const NEWEST_REGEX = /\b(new|latest|recent|date|created|published|added|posted|pub|newest)\b/i;
const COUNTER_REGEX_ALPHA = /\b(name|alpha|title|a[\s-]?z)\b/i;
const COUNTER_REGEX_PRICE = /\b(price|low.*high|cheapest)\b/i;
const COUNTER_REGEX_POP = /\b(popular|rating|bestsell|best.sell|relevance)\b/i;

// ─── Helpers ────────────────────────────────────────────────────────────────

function pickBestCatalogUrl(state: GeographyCountState): string {
  if (state.catalogUrlWalkCounts.length > 0) {
    const best = [...state.catalogUrlWalkCounts].sort((a, b) => b.uniqueProducts - a.uniqueProducts)[0];
    if (best.uniqueProducts > 0) return best.url;
  }
  return state.catalogUrls[0];
}

function first3Urls(products: ExtractedProduct[]): string[] {
  return products.slice(0, 3).map(p => p.url);
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

async function fetchAndExtract(url: string, state: GeographyCountState): Promise<PageData> {
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
        process.stderr.write(`  [sort-detect] fetch retry for ${url}: ${(e as Error).message}\n`);
        continue;
      }
      return { products: [], html: '' };
    }
  }
  return { products: [], html: '' };
}

// ─── <select> parser (Mistake 2: READ the HTML) ────────────────────────────

function parseSortSelects(html: string): SelectInfo[] {
  const $ = cheerio.load(html);
  const results: SelectInfo[] = [];
  const seen = new Set<string>();

  // Broad selector: any <select> whose name/id/class contains sort or order
  const selectors = [
    'select[name*="sort" i]', 'select[id*="sort" i]', 'select[class*="sort" i]',
    'select[name*="order" i]', 'select[id*="order" i]', 'select[class*="order" i]',
    // Magento 1.x / 2.x: <select id="sorter">
    'select#sorter',
    // Searchspring / custom: data-ss-sort
    'select[data-ss-sort]',
  ];

  for (const sel of selectors) {
    $(sel).each((_, el) => {
      const $el = $(el);
      const name = $el.attr('name') || '';
      const id = $el.attr('id') || '';
      const key = name || id;
      if (!key || seen.has(key)) return;
      seen.add(key);

      const options: SelectInfo['options'] = [];
      $el.find('option').each((__, opt) => {
        const $opt = $(opt);
        const value = $opt.attr('value') || '';
        const text = $opt.text().trim();
        if (value) options.push({ value, text });
      });

      if (options.length > 0) {
        results.push({ name, id, options });
      }
    });
  }

  return results;
}

// ─── Searchspring / Ecwid detection ─────────────────────────────────────────

function hasSearchspring(html: string): boolean {
  return /cdn\.searchspring\.net\/search\/v3\/js\/searchspring/i.test(html);
}

function hasEcwid(html: string): boolean {
  return /app\.ecwid\.com\/script\.js/i.test(html);
}

// ─── Candidate filtering ────────────────────────────────────────────────────

type SortCandidate = {
  selectName: string;  // the URL param name (Mistake 2)
  value: string;
  text: string;
};

function filterNewestCandidates(selects: SelectInfo[]): SortCandidate[] {
  const candidates: SortCandidate[] = [];
  for (const sel of selects) {
    for (const opt of sel.options) {
      if (NEWEST_REGEX.test(opt.text) || NEWEST_REGEX.test(opt.value)) {
        candidates.push({
          selectName: sel.name || sel.id,
          value: opt.value,
          text: opt.text,
        });
      }
    }
  }
  return candidates;
}

function findCounterControl(selects: SelectInfo[]): SortCandidate | null {
  // 4-tier cascade per implementation notes: alpha → price → popularity → any non-newest
  for (const sel of selects) {
    for (const opt of sel.options) {
      if (COUNTER_REGEX_ALPHA.test(opt.text) || COUNTER_REGEX_ALPHA.test(opt.value)) {
        return { selectName: sel.name || sel.id, value: opt.value, text: opt.text };
      }
    }
  }
  for (const sel of selects) {
    for (const opt of sel.options) {
      if (COUNTER_REGEX_PRICE.test(opt.text) || COUNTER_REGEX_PRICE.test(opt.value)) {
        return { selectName: sel.name || sel.id, value: opt.value, text: opt.text };
      }
    }
  }
  for (const sel of selects) {
    for (const opt of sel.options) {
      if (COUNTER_REGEX_POP.test(opt.text) || COUNTER_REGEX_POP.test(opt.value)) {
        return { selectName: sel.name || sel.id, value: opt.value, text: opt.text };
      }
    }
  }
  // Last resort: any option that is NOT a newest candidate
  for (const sel of selects) {
    for (const opt of sel.options) {
      if (!NEWEST_REGEX.test(opt.text) && !NEWEST_REGEX.test(opt.value)) {
        return { selectName: sel.name || sel.id, value: opt.value, text: opt.text };
      }
    }
  }
  return null;
}

// ─── URL builders ───────────────────────────────────────────────────────────

function buildSortedUrl(baseUrl: string, candidate: SortCandidate, platform: string): string {
  const url = new URL(baseUrl);

  // Volusion: needs searching=Y activation flag (Mistake 24)
  if (platform.includes('volusion')) {
    url.searchParams.set('searching', 'Y');
  }

  // Magento M2 convention: <select id="sorter" name="product_list_order">
  // Magento M1: name="order" or name="dir" paired with order
  // Generic: use select name as param name, option value as param value
  // Per Mistake 2: the select's NAME is the URL param.
  url.searchParams.set(candidate.selectName, candidate.value);

  return url.toString();
}

// ─── Platform-specific direct probes (Mistake 18/21) ────────────────────────

type DirectProbe = { param: string; value: string; extraParams?: Record<string, string> };

function platformDirectProbes(platform: string): DirectProbe[] {
  const probes: DirectProbe[] = [];

  // OpenCart: visible dropdown may lack date_added, but the controller accepts it (Mistake 21)
  if (platform.includes('opencart')) {
    probes.push({ param: 'sort', value: 'p.date_added', extraParams: { order: 'DESC' } });
    probes.push({ param: 'sort', value: 'p.product_id', extraParams: { order: 'DESC' } });
  }

  // WooCommerce: standard is ?orderby=date
  if (platform.includes('woocommerce')) {
    probes.push({ param: 'orderby', value: 'date' });
  }

  // Shopify: ?sort_by=created-descending
  if (platform.includes('shopify')) {
    probes.push({ param: 'sort_by', value: 'created-descending' });
  }

  // BigCommerce: ?sort=newest
  if (platform.includes('bigcommerce')) {
    probes.push({ param: 'sort', value: 'newest' });
  }

  // LightSpeed: ?sort=newest
  if (platform.includes('lightspeed')) {
    probes.push({ param: 'sort', value: 'newest' });
  }

  return probes;
}

function buildDirectProbeUrl(baseUrl: string, probe: DirectProbe, platform: string): string {
  const url = new URL(baseUrl);
  if (platform.includes('volusion')) {
    url.searchParams.set('searching', 'Y');
  }
  url.searchParams.set(probe.param, probe.value);
  if (probe.extraParams) {
    for (const [k, v] of Object.entries(probe.extraParams)) {
      url.searchParams.set(k, v);
    }
  }
  return url.toString();
}

// ─── 3-outcome verdict (Mistake 29) ────────────────────────────────────────

type SortVerdict = 'honored' | 'honored-default-is-newest' | 'noop' | 'noop-small';

function threeOutcomeVerdict(
  defaultFirst3: string[],
  sortedFirst3: string[],
  counterFirst3: string[] | null,
  totalProducts: number,
): SortVerdict {
  if (totalProducts <= 1) return 'noop-small';

  const sortMatchesDefault = arraysEqual(sortedFirst3, defaultFirst3);

  if (!sortMatchesDefault) return 'honored';

  // Sort matches default — need counter-control to distinguish
  if (counterFirst3 && !arraysEqual(counterFirst3, defaultFirst3)) {
    // Counter differs from default → default IS newest-sorted → sort works
    return 'honored-default-is-newest';
  }

  return 'noop';
}

// ─── Main ───────────────────────────────────────────────────────────────────

const NULL_EVIDENCE: NavigationState['sortEvidence'] = {
  selectHtml: '',
  candidateParams: [],
  dateVerification: null,
  idJumpBefore: '',
  idJumpAfter: '',
};

export async function detectSort(state: GeographyCountState): Promise<SortDetectResult> {
  const testUrl = pickBestCatalogUrl(state);
  process.stderr.write(`  [sort-detect] testing ${testUrl}\n`);

  // 1. Fetch default page (no sort)
  const defaultPage = await fetchAndExtract(testUrl, state);
  const defaultFirst3 = first3Urls(defaultPage.products);

  if (defaultPage.products.length === 0) {
    process.stderr.write(`  [sort-detect] 0 products on default page — cannot detect sort\n`);
    return { sortParam: null, evidence: { ...NULL_EVIDENCE, selectHtml: '(0 products on page)' } };
  }

  // 2. Check for SPA overlays that hijack URL sort (detect + defer)
  if (hasSearchspring(defaultPage.html)) {
    process.stderr.write(`  [sort-detect] Searchspring overlay detected — sort lives in hash fragment, deferring\n`);
    return {
      sortParam: null,
      evidence: {
        ...NULL_EVIDENCE,
        selectHtml: '(Searchspring overlay — sort is #/sort:created_at:desc hash fragment, needs Playwright)',
      },
    };
  }
  if (hasEcwid(defaultPage.html)) {
    process.stderr.write(`  [sort-detect] Ecwid SPA detected — sort is JSON POST body field, deferring\n`);
    return {
      sortParam: null,
      evidence: {
        ...NULL_EVIDENCE,
        selectHtml: '(Ecwid SPA — sort via POST body sortBy:addedTimeDesc, not URL param)',
      },
    };
  }

  // 3. Parse <select> elements for sort options
  const selects = parseSortSelects(defaultPage.html);
  const selectHtml = selects.length > 0
    ? selects.map(s => `<select name="${s.name}" id="${s.id}"> ${s.options.map(o => `[${o.value}="${o.text}"]`).join(' ')}`).join('\n')
    : '(no sort <select> found)';

  process.stderr.write(`  [sort-detect] found ${selects.length} sort select(s) with ${selects.reduce((n, s) => n + s.options.length, 0)} total options\n`);

  // 4. Filter newest-style candidates from <select>
  let candidates = filterNewestCandidates(selects);
  const candidateParams: string[] = [];

  // 5. If no <select> found, try platform-specific direct probes (Mistake 18/21)
  const directProbes = platformDirectProbes(state.platform);

  // 6. Find counter-control option for 3-outcome test
  const counter = findCounterControl(selects);
  let counterFirst3: string[] | null = null;

  if (counter) {
    const counterUrl = buildSortedUrl(testUrl, counter, state.platform);
    process.stderr.write(`  [sort-detect] fetching counter-control: ${counterUrl}\n`);
    const counterPage = await fetchAndExtract(counterUrl, state);
    counterFirst3 = first3Urls(counterPage.products);
  }

  // 7. Test each candidate from <select>
  for (const cand of candidates) {
    const sortedUrl = buildSortedUrl(testUrl, cand, state.platform);
    const paramStr = new URL(sortedUrl).search;  // e.g. ?orderby=date
    candidateParams.push(paramStr);
    process.stderr.write(`  [sort-detect] testing candidate: ${paramStr} (${cand.text})\n`);

    const sortedPage = await fetchAndExtract(sortedUrl, state);
    const sortedFirst3 = first3Urls(sortedPage.products);

    if (sortedPage.products.length === 0) {
      process.stderr.write(`  [sort-detect] candidate ${paramStr} returned 0 products — skip\n`);
      continue;
    }

    const verdict = threeOutcomeVerdict(defaultFirst3, sortedFirst3, counterFirst3, state.walkedUniqueCount || defaultPage.products.length);
    process.stderr.write(`  [sort-detect] verdict: ${verdict} (default=${defaultFirst3[0]?.split('/').pop()}, sorted=${sortedFirst3[0]?.split('/').pop()})\n`);

    if (verdict === 'honored' || verdict === 'honored-default-is-newest') {
      return {
        sortParam: paramStr,
        evidence: {
          selectHtml,
          candidateParams,
          dateVerification: null,  // deferred to watermark-method (Task 5.3) / Method C safety net
          idJumpBefore: defaultFirst3[0] || '',
          idJumpAfter: sortedFirst3[0] || '',
        },
      };
    }
  }

  // 8. No <select> candidate worked — try platform direct probes (Mistake 18/21)
  for (const probe of directProbes) {
    // Skip if we already tested this via <select>
    const probeUrl = buildDirectProbeUrl(testUrl, probe, state.platform);
    const probeSearch = new URL(probeUrl).search;
    if (candidateParams.includes(probeSearch)) continue;

    candidateParams.push(probeSearch);
    process.stderr.write(`  [sort-detect] direct probe: ${probeSearch}\n`);

    const probePage = await fetchAndExtract(probeUrl, state);
    const probeFirst3 = first3Urls(probePage.products);

    if (probePage.products.length === 0) continue;

    const verdict = threeOutcomeVerdict(defaultFirst3, probeFirst3, counterFirst3, state.walkedUniqueCount || defaultPage.products.length);
    process.stderr.write(`  [sort-detect] direct probe verdict: ${verdict}\n`);

    if (verdict === 'honored' || verdict === 'honored-default-is-newest') {
      return {
        sortParam: probeSearch,
        evidence: {
          selectHtml,
          candidateParams,
          dateVerification: null,
          idJumpBefore: defaultFirst3[0] || '',
          idJumpAfter: probeFirst3[0] || '',
        },
      };
    }
  }

  // 9. Nothing worked — return null with diagnostic evidence
  process.stderr.write(`  [sort-detect] no working sort param found\n`);
  return {
    sortParam: null,
    evidence: {
      selectHtml,
      candidateParams,
      dateVerification: null,
      idJumpBefore: defaultFirst3[0] || '',
      idJumpAfter: '',
    },
  };
}
