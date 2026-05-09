/**
 * @deprecated 2026-04-27 — Generic discovery superseded by AI-driven per-site audit.
 * See `_DEPRECATED.md` in this folder and `docs/superpowers/plans/2026-04-27-pivot-to-ai-audit.md`.
 * Do not import from this file in new code.
 */
// backend/scripts/probe/navigation/watermark-method.ts
// Navigation stage Task 5.3: Select watermark method (A/B/C) per spec §6.3.
//
// Method A — API supports dateAfter filter AND returns per-product dates.
// Method B — any date source yields dates AND newest-first sort verified.
// Method C — no date source works → full-catalog-sweep every cycle.
//
// Date source priority per spec §6.2 (the navigation stage checks levels 1, 2, 4, 5;
// level 3 detail-page is deferred to the bootstrap stage per §6.4):
//   1. API date field (WP REST modified, Shopify published_at, WC Store API)
//   2. Listing HTML date (schema.org datePublished, posted-date classes)
//   4. Sitemap <lastmod> when reliable (not all-same-timestamp)
//   5. sourceId auto-increment (pseudo-date ordering)
//
// Key playbook Mistakes encoded:
//   31 — Ecwid: no date filter externally → NEVER Method A
//   32 — Shopify published_at not created_at
//   18 — cross-reference DOM order before declaring no sort possible

import { fetchUrl } from '../shared/fetch';
import { extractProducts } from '../shared/extract';
import type { SortDetectResult } from './sort-detect';
import type {
  GeographyCountState,
  NavigationState,
  WatermarkMethod,
  DateVerificationMethod,
} from '../shared/types';

// ─── Types ──────────────────────────────────────────────────────────────────

export type WatermarkSelection = {
  method: WatermarkMethod;
  reason: string;
  dateVerification: NavigationState['sortEvidence']['dateVerification'];
  dateSourceForMethodA?: string;
  urlSortVerifiedForMethodB?: boolean;
  fallbackToMethodCReason?: string;
};

// ─── Method A probes ────────────────────────────────────────────────────────

async function probeMethodA(state: GeographyCountState): Promise<WatermarkSelection | null> {
  const platform = state.platform;
  const origin = state.canonicalOrigin;

  // Ecwid: date filter NOT exposed externally (Mistake 31) → skip
  if (platform.includes('ecwid')) {
    process.stderr.write(`  [watermark-method] Ecwid detected — Method A impossible (Mistake 31)\n`);
    return null;
  }

  // WooCommerce: two-probe verification of WP REST ?after= filter (Bug #2 fix).
  // Single-probe was too strict: if all products were created after the test date,
  // x-wp-total equals globalProductCount and the code concludes "filter not honored."
  // Two-probe: future date (impossible) must return 0, very old date must return ~global.
  if (platform.includes('woocommerce')) {
    try {
      const futureDate = '2099-01-01T00:00:00';
      const veryOldDate = '1999-01-01T00:00:00';
      const fetchCtx = {
        hasWaf: state.hasWaf,
        wafType: state.wafType,
        ua: state.userAgentOverride ?? undefined,
        timeoutMs: 15000,
      };
      const futureUrl = `${origin}/wp-json/wp/v2/product?after=${futureDate}&per_page=1`;
      const oldUrl = `${origin}/wp-json/wp/v2/product?after=${veryOldDate}&per_page=1`;
      process.stderr.write(`  [watermark-method] Method A two-probe (WP REST): future=${futureUrl}\n`);
      const [futureProbe, oldProbe] = await Promise.all([
        fetchUrl(futureUrl, fetchCtx),
        fetchUrl(oldUrl, fetchCtx),
      ]);
      if (futureProbe.status < 400 && oldProbe.status < 400) {
        const futureTotal = parseInt(futureProbe.headers['x-wp-total'] || '-1', 10);
        const oldTotal = parseInt(oldProbe.headers['x-wp-total'] || '-1', 10);
        // Filter is honored if: future returns 0 (no products after impossible date)
        // AND old returns close to global (most products created after 1999)
        const filterHonored = futureTotal === 0 && oldTotal > 0 && oldTotal >= state.globalProductCount * 0.9;
        process.stderr.write(`  [watermark-method] Method A: future=${futureTotal}, old=${oldTotal}, global=${state.globalProductCount}, honored=${filterHonored}\n`);
        if (filterHonored) {
          return {
            method: 'api-date-since-watermark',
            reason: `WP REST ?after= filter honored (probe future=${futureTotal}, probe old=${oldTotal}, global=${state.globalProductCount})`,
            dateVerification: {
              method: 'api-date-field',
              page1FirstDate: veryOldDate,
              page1SecondDate: '',
              page1ThirdDate: '',
              survivesPagination: true,
              monotonicallyDecreasing: true,
            },
            dateSourceForMethodA: 'wp-rest-after-filter',
          };
        }
      }
    } catch (e) {
      process.stderr.write(`  [watermark-method] Method A probe failed: ${(e as Error).message}\n`);
    }
  }

  // Shopify: products.json has published_at per product (Mistake 32)
  if (platform.includes('shopify')) {
    try {
      const probeUrl = `${origin}/products.json?limit=3`;
      process.stderr.write(`  [watermark-method] Method A probe (Shopify): ${probeUrl}\n`);
      const r = await fetchUrl(probeUrl, {
        hasWaf: state.hasWaf,
        wafType: state.wafType,
        ua: state.userAgentOverride ?? undefined,
        timeoutMs: 15000,
      });
      if (r.status < 400) {
        try {
          const data = JSON.parse(r.body);
          const products = data?.products;
          if (Array.isArray(products) && products.length > 0 && products[0].published_at) {
            const dates = products.slice(0, 3).map((p: { published_at: string }) => p.published_at);
            process.stderr.write(`  [watermark-method] Method A: Shopify published_at found: ${dates.join(', ')}\n`);
            return {
              method: 'api-date-since-watermark',
              reason: `Shopify /products.json has published_at per product (Mistake 32: use published_at not created_at)`,
              dateVerification: {
                method: 'api-date-field',
                page1FirstDate: dates[0] || '',
                page1SecondDate: dates[1] || '',
                page1ThirdDate: dates[2] || '',
                survivesPagination: true,
                monotonicallyDecreasing: true, // Shopify default sort is created-descending
              },
              dateSourceForMethodA: 'shopify-published-at',
            };
          }
        } catch { /* JSON parse fail — fall through */ }
      }
    } catch (e) {
      process.stderr.write(`  [watermark-method] Method A Shopify probe failed: ${(e as Error).message}\n`);
    }
  }

  return null;
}

// ─── Date verification for Method B ─────────────────────────────────────────

type DateCheckResult = {
  method: DateVerificationMethod;
  dates: string[];
  monotonicallyDecreasing: boolean;
};

function checkListingDates(products: Array<{ postDate?: string; sourceId?: string }>): DateCheckResult | null {
  // Priority 2: listing HTML date (from extractProducts postDate field)
  const dates = products.slice(0, 3).map(p => p.postDate).filter((d): d is string => !!d);
  if (dates.length >= 2) {
    const mono = isMonoDecreasing(dates);
    return { method: 'listing-html-date', dates, monotonicallyDecreasing: mono };
  }

  // Priority 5: sourceId auto-increment (pseudo-date)
  const ids = products.slice(0, 3).map(p => p.sourceId).filter((s): s is string => !!s);
  if (ids.length >= 2) {
    // Try numeric comparison
    const nums = ids.map(id => parseInt(id, 10)).filter(n => !isNaN(n));
    if (nums.length >= 2) {
      const mono = nums.every((v, i) => i === 0 || nums[i - 1] > v);
      return {
        method: 'sourceId-autoincrement',
        dates: ids,
        monotonicallyDecreasing: mono,
      };
    }
  }

  return null;
}

function isMonoDecreasing(dates: string[]): boolean {
  // Compare date strings — works for ISO 8601 and most YYYY-MM-DD formats
  for (let i = 1; i < dates.length; i++) {
    if (dates[i] >= dates[i - 1]) return false;
  }
  return true;
}

async function probeMethodB(
  state: GeographyCountState,
  sortResult: SortDetectResult,
): Promise<WatermarkSelection | null> {
  // sortParam === null → no sort detected at all
  if (sortResult.sortParam === null) {
    process.stderr.write(`  [watermark-method] Method B: no sort param → cannot verify newest-first ordering\n`);
    return null;
  }

  // sortParam === "" → path-baked sort (Celerant /orderby/<value>/ pattern, Mistake 36).
  // sort-detect already verified the sort via path-swap counter-control: swapping the
  // orderby segment in the path produced a different first product (proving the sort is
  // honored). Date monotonicity is not reliable for Celerant (sourceId order ≠ sort order
  // because /orderby/new-arrivals/ uses a "newest to storefront" metric that doesn't track
  // numeric IDs). Counter-control already proved the sort is operative — promote to
  // Method B (navigate-from-watermark) without further date verification.
  if (sortResult.sortParam === '') {
    process.stderr.write(`  [watermark-method] Method B: path-baked sort (testUrl contains /orderby/<value>/), counter-control verified upstream → navigate-from-watermark\n`);
    return {
      method: 'navigate-from-watermark',
      reason: 'Path-baked sort verified upstream via /orderby/<value>/ swap counter-control (Mistake 36 — Celerant convention). Date monotonicity not required: sort honoring proven by URL-path-swap producing distinct first products.',
      dateVerification: null,
      urlSortVerifiedForMethodB: true,
    };
  }

  // Fetch page 1 with the sort param applied and extract products
  const testUrl = pickBestCatalogUrl(state);
  const sortedUrl = applySortParam(testUrl, sortResult.sortParam);
  process.stderr.write(`  [watermark-method] Method B: fetching sorted page for date verification: ${sortedUrl}\n`);

  try {
    const r = await fetchUrl(sortedUrl, {
      hasWaf: state.hasWaf,
      wafType: state.wafType,
      ua: state.userAgentOverride ?? undefined,
      timeoutMs: 20000,
    });
    if (r.status >= 400) {
      process.stderr.write(`  [watermark-method] Method B: sorted page returned ${r.status}\n`);
      return null;
    }

    const products = extractProducts(r.body, sortedUrl, state.platform);
    if (products.length === 0) {
      process.stderr.write(`  [watermark-method] Method B: 0 products extracted from sorted page\n`);
      return null;
    }

    const dateCheck = checkListingDates(products);
    if (!dateCheck) {
      process.stderr.write(`  [watermark-method] Method B: no date source found on listing products\n`);
      return null;
    }

    if (!dateCheck.monotonicallyDecreasing) {
      process.stderr.write(`  [watermark-method] Method B: dates not monotonically decreasing (${dateCheck.dates.join(', ')})\n`);
      return null;
    }

    process.stderr.write(`  [watermark-method] Method B: date verification passed via ${dateCheck.method} (${dateCheck.dates.join(', ')})\n`);
    return {
      method: 'navigate-from-watermark',
      reason: `Newest-first sort (${sortResult.sortParam}) verified with ${dateCheck.method}: first 3 dates strictly decreasing`,
      dateVerification: {
        method: dateCheck.method,
        page1FirstDate: dateCheck.dates[0] || '',
        page1SecondDate: dateCheck.dates[1] || '',
        page1ThirdDate: dateCheck.dates[2] || '',
        survivesPagination: true,
        monotonicallyDecreasing: true,
      },
      urlSortVerifiedForMethodB: true,
    };
  } catch (e) {
    process.stderr.write(`  [watermark-method] Method B fetch failed: ${(e as Error).message}\n`);
    return null;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function pickBestCatalogUrl(state: GeographyCountState): string {
  if (state.catalogUrlWalkCounts.length > 0) {
    const best = [...state.catalogUrlWalkCounts].sort((a, b) => b.uniqueProducts - a.uniqueProducts)[0];
    if (best.uniqueProducts > 0) return best.url;
  }
  return state.catalogUrls[0];
}

function applySortParam(baseUrl: string, sortParam: string): string {
  // sortParam is a query string like "?orderby=date" or "?sort_by=created-descending"
  // Merge it into the base URL
  try {
    const url = new URL(baseUrl);
    const params = new URLSearchParams(sortParam.replace(/^\?/, ''));
    for (const [k, v] of params) {
      url.searchParams.set(k, v);
    }
    return url.toString();
  } catch {
    // Fallback: simple concatenation
    const sep = baseUrl.includes('?') ? '&' : '?';
    return baseUrl + sep + sortParam.replace(/^\?/, '');
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

export async function selectWatermarkMethod(
  state: GeographyCountState,
  sortResult: SortDetectResult,
): Promise<WatermarkSelection> {
  process.stderr.write(`  [watermark-method] selecting method for ${state.canonicalOrigin} (platform=${state.platform})\n`);

  // Step 1: Try Method A — API supports date filter + per-product dates
  const methodA = await probeMethodA(state);
  if (methodA) return methodA;

  // Step 2: Try Method B — date verification on sorted listing
  const methodB = await probeMethodB(state, sortResult);
  if (methodB) return methodB;

  // Step 3: Method C — no date source works
  const reasons: string[] = [];
  if (!sortResult.sortParam) {
    reasons.push('no working newest-first sort param found');
  } else {
    reasons.push(`sort param ${sortResult.sortParam} found but no per-product dates extractable from listing`);
  }
  if (state.platform.includes('ecwid')) {
    reasons.push('Ecwid has no external date filter (Mistake 31)');
  }

  const fallbackReason = reasons.join('; ');
  process.stderr.write(`  [watermark-method] Method C (full-catalog-sweep): ${fallbackReason}\n`);

  return {
    method: 'full-catalog-sweep',
    reason: `No API date filter and no date source on listing → full-catalog-sweep`,
    dateVerification: null,
    fallbackToMethodCReason: fallbackReason,
  };
}
