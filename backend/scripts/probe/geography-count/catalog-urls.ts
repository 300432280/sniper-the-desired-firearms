/**
 * @deprecated 2026-04-27 — Generic discovery superseded by AI-driven per-site audit.
 * See `_DEPRECATED.md` in this folder and `docs/superpowers/plans/2026-04-27-pivot-to-ai-audit.md`.
 * Do not import from this file in new code.
 */
// backend/scripts/probe/geography-count/catalog-urls.ts
// Step 2 of the Geography & Count stage: multi-source candidate generation.
// Per spec §4.3 step 1 + playbook Phase 3 + feedback_catalog_urls_full_coverage.md.
//
// Sources (in order):
//   1. Platform taxonomy API (WC product_cat, Shopify collections.json, etc.)
//   2. Homepage nav crawl (existing)
//   3. Common "view all" URL probes (/shop, /all-products, /collections/all, etc.)
//   4. Drupal Views form-based + path-probe discovery
//   5. Breadcrumb fallback: pick random products from sitemap, fetch detail, extract breadcrumb cats
//
// Output: Array<CatalogCandidate> with per-candidate page-1 product count + sample URLs.
// The caller (index.ts) passes these to select-catalog-set.ts for set-cover against sitemap.

import * as cheerio from 'cheerio';
import { fetchUrl } from '../shared/fetch';
import { isLikelyNavUrl } from '../shared/url-utils';
import { extractProducts } from '../shared/extract';
import { hasChallengeMarkers } from '../access-identity/canonical-host';
import type { AccessIdentityState } from '../shared/types';
import type { CatalogCandidate } from './select-catalog-set';

export type CatalogUrlsResult = {
  candidates: CatalogCandidate[];
  source: 'nav' | 'taxonomy-api' | 'taxonomy-api+nav-merge' | 'category-tree-walk' | 'multi-source' | 'manual';
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function dedupeByUrl(candidates: CatalogCandidate[]): CatalogCandidate[] {
  const seen = new Set<string>();
  const result: CatalogCandidate[] = [];
  for (const c of candidates) {
    const key = c.url.replace(/\/$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(c);
  }
  return result;
}

async function probeUrl(
  url: string,
  state: AccessIdentityState,
  ctx: { hasWaf: boolean; wafType?: typeof state.wafType; ua?: string },
): Promise<CatalogCandidate | null> {
  try {
    // Try axios first for speed. If WAF challenges, fall back to Playwright.
    const r = await fetchUrl(url, { hasWaf: false, ua: ctx.ua, timeoutMs: 15000 });
    if (r.status >= 400) return null;

    // Check for WAF challenge body — if so, retry with Playwright
    if (r.body && hasChallengeMarkers(r.body)) {
      const r2 = await fetchUrl(url, { ...ctx, timeoutMs: 20000 });
      if (r2.status >= 400) return null;
      const products = extractProducts(r2.body, url, state.platform);
      if (products.length === 0) return null;
      return {
        url,
        page1ProductCount: products.length,
        sampleProductUrls: products.map(p => p.url),
      };
    }

    const products = extractProducts(r.body, url, state.platform);
    if (products.length === 0) return null;
    return {
      url,
      page1ProductCount: products.length,
      sampleProductUrls: products.map(p => p.url),
    };
  } catch {
    return null;
  }
}

// ─── WooCommerce subcategory recursion ──────────────────────────────────────

type WcCategory = {
  id: number;
  slug: string;
  count: number;
  parent: number;
  link: string;
  name: string;
};

/**
 * Recursively discover WooCommerce categories.
 * For each top-level category, probe page 1. Three cases:
 *   (a) 0 products → sub-category tile page (Mistake 38), recurse into children
 *   (b) products found, count matches API count → parent includes children, use parent only
 *   (c) products found, but API count >> page1 × estimated pages → parent doesn't include
 *       all children. Include BOTH the parent AND its children (per feedback_full_coverage.md:
 *       "NEVER drop categories for being too small").
 *
 * The key insight: WooCommerce parent pages MAY or MAY NOT include child products
 * depending on the theme (Minimog themes show sub-category tiles instead of all
 * products for large categories). We can't know which behavior the theme uses
 * without empirical check. So we use the API `count` field: if page-1 products
 * × estimated pages << API count, the parent is NOT inclusive and children are needed.
 */
async function discoverWcCategories(
  cats: WcCategory[],
  state: AccessIdentityState,
  ctx: { hasWaf: boolean; wafType?: typeof state.wafType; ua?: string },
): Promise<CatalogCandidate[]> {
  const result: CatalogCandidate[] = [];
  const childrenOf = new Map<number, WcCategory[]>();

  // Build parent-child map
  for (const cat of cats) {
    if (!childrenOf.has(cat.parent)) childrenOf.set(cat.parent, []);
    childrenOf.get(cat.parent)!.push(cat);
  }

  const topLevel = cats.filter(c => c.parent === 0 && c.count > 0 && c.link);

  async function processCategory(cat: WcCategory, depth: number): Promise<void> {
    if (depth > 3) return;
    if (!cat.link) return;

    const children = childrenOf.get(cat.id) || [];
    const childrenWithProducts = children.filter(c => c.count > 0 && c.link);

    if (childrenWithProducts.length > 0) {
      // Parent HAS children with products. Include BOTH the parent and children.
      // WooCommerce parent pages may include child products (theme-dependent),
      // so including the parent ensures products aren't missed if it IS inclusive.
      // If the parent shows tiles instead of products, the walk will get 0 and
      // the walk just moves on (covered by children).
      // Per feedback_full_coverage.md: "NEVER drop categories for being too small."
      result.push({
        url: cat.link,
        page1ProductCount: cat.count,
        sampleProductUrls: [],
      });
      for (const child of childrenWithProducts) {
        await processCategory(child, depth + 1);
      }
    } else {
      // Leaf category — no children. Trust the API count.
      if (cat.count > 0) {
        result.push({
          url: cat.link,
          page1ProductCount: cat.count,
          sampleProductUrls: [],
        });
      }
    }
  }

  for (const cat of topLevel) {
    await processCategory(cat, 0);
  }

  return result;
}

// ─── Shopify "all" collection ───────────────────────────────────────────────

const SHOPIFY_ALL_HANDLES = ['all', 'all-products', 'products'];

// ─── BC Stencil deep category tree discovery ──────────────────────────────

/**
 * BC Stencil category tree recursion.
 * BC Stencil mega-menus dump 1000+ links into <nav>. Many are caliber-specific
 * or brand-specific pages with 1-5 products each. The production catalogUrls
 * target ~20-30 "leaf" categories (e.g. /modern-sporting-rifles/, /shotguns-hunting/).
 *
 * Strategy:
 * 1. From nav links, identify top-level categories (1-segment paths, typical of
 *    BC Stencil main menu: /firearms/, /ammunition/, /accessories/, /archery/, etc.)
 * 2. For each top-level category, fetch its page HTML
 * 3. Extract subcategory links from the page body (BC Stencil renders subcategory
 *    tiles or sidebar links like /modern-sporting-rifles/, /rimfire-rifles/, etc.)
 * 4. Probe each subcategory. If it has real products (not more sub-cat tiles), include it.
 * 5. Recurse one more level if a subcategory itself is a tile page.
 * 6. Max depth 3, max 100 probes total to stay within request budget.
 */
async function discoverBcStencilCategories(
  state: AccessIdentityState,
  origin: string,
  allNavLinks: string[],
  existingUrls: Set<string>,
  ctx: { hasWaf: boolean; wafType?: typeof state.wafType; ua?: string },
): Promise<CatalogCandidate[]> {
  const results: CatalogCandidate[] = [];
  const probed = new Set<string>();
  let probeCount = 0;
  const MAX_PROBES = 120;

  // Identify top-level category links: 1-segment paths in nav
  const topLevel = new Set<string>();
  for (const navUrl of allNavLinks) {
    try {
      const u = new URL(navUrl);
      const segments = u.pathname.split('/').filter(Boolean);
      if (segments.length === 1 && !u.search && !u.hash) {
        topLevel.add(u.pathname);
      }
    } catch { /* skip */ }
  }

  // Also look for 2-segment paths that are children of top-level (e.g. /firearms/subcategory/)
  // These are the most common leaf categories on BC Stencil sites.
  const twoSegment = new Map<string, string[]>(); // parent → [child paths]
  for (const navUrl of allNavLinks) {
    try {
      const u = new URL(navUrl);
      const segments = u.pathname.split('/').filter(Boolean);
      if (segments.length === 2 && !u.search && !u.hash) {
        const parent = '/' + segments[0] + '/';
        if (topLevel.has(parent) || topLevel.has('/' + segments[0])) {
          if (!twoSegment.has(parent)) twoSegment.set(parent, []);
          twoSegment.get(parent)!.push(u.pathname);
        }
      }
    } catch { /* skip */ }
  }

  process.stderr.write(
    `  [catalog-urls] BC Stencil: ${topLevel.size} top-level, ${[...twoSegment.values()].reduce((s, v) => s + v.length, 0)} 2-segment children in nav\n`
  );

  // BC Stencil URL structure is often FLAT — leaf categories like
  // /modern-sporting-rifles/ are single-segment paths, not /firearms/modern-sporting-rifles/.
  // So "top-level" in URL terms includes both actual parent categories (/firearms/)
  // and leaf categories (/modern-sporting-rifles/). We must probe single-segment
  // paths before 2-segment paths because they're more likely to be real product
  // categories, and we have a limited probe budget.

  // Filter out top-level paths that are clearly NOT product categories
  // (calibers, brands, utility pages) to reduce probe count.
  const NON_CATEGORY_RE = /^\/(contact|about|privacy|terms|shipping|returns|warranty|faq|blog|news|cart|account|login|search|brands|gift|gift-card|sale|new|featured|movie|vehicles|warranty-services|privacy-policy|terms-conditions|shipping-returns|GOC-store)/i;

  // BC Stencil sites like theammosource.com have 800+ single-segment paths in the nav,
  // including caliber-specific pages (/10mm/, /12-gauge/, /223-rem-5-56-nato/) and
  // brand pages (/browning/, /remington/). These overwhelm the probe budget before
  // reaching actual product category pages (/modern-sporting-rifles/, /air-guns/).
  //
  // Strategy: sort candidates by likelihood of being a real product category:
  // 1. Multi-word slugs with no numbers (high: /modern-sporting-rifles/, /air-guns/)
  // 2. Multi-word slugs with numbers at end (medium: /bipods-2/, /gsg-4/)
  // 3. Numeric/caliber-looking slugs (low: /10mm/, /12-gauge/, /223-rem-5-56-nato/)
  // 4. Single-word brand slugs (low: /browning/, /remington/)
  function categoryPriority(path: string): number {
    const slug = path.replace(/^\/|\/$/g, '');
    // Single word but common category names → top priority
    if (/^(firearms|ammunition|accessories|archery|camping|clothing|hunting|optics|scopes|reloading|knives|fishing|holsters|magazines|slings|stocks|bipods|cleaning|targets|surplus)$/i.test(slug)) return 0;
    // Multi-word slugs with letters (e.g. modern-sporting-rifles, air-guns, bipods-2)
    // These are likely real category names, not caliber codes.
    if (slug.includes('-') && /[a-z].*-.*[a-z]/i.test(slug) && !/^\d/.test(slug)) return 1;
    // Numeric-start slugs are almost always caliber codes (10mm, 12-gauge, 223-rem)
    if (/^\d/.test(slug)) return 3;
    // Single-word slugs without hyphens → brand pages or misc (browning, remington)
    return 2;
  }

  // Phase 1: Probe ALL single-segment (top-level) paths.
  // Sort by priority (category-like first, caliber/brand last).
  const topLevelSorted = [...topLevel].sort((a, b) => {
    const pa = categoryPriority(a);
    const pb = categoryPriority(b);
    if (pa !== pb) return pa - pb;
    return a.localeCompare(b);
  });

  // Platform-aware listing-suffix fallbacks: when a bare top-level path returns
  // 0 products (typical for Celerant which renders tile pages on bare paths),
  // try common path-suffix listing patterns to get the actual product listing URL.
  function listingSuffixesForPlatform(platform: string): string[] {
    if (platform.includes('celerant')) {
      // Celerant convention: /<category>/browse/orderby/<sort>/perpage/<N>.
      // We bake /orderby/new-arrivals/ into the suffix so the resulting
      // catalogUrls (a) have a path-form sort that sort-detect can verify via
      // counter-control swap (Mistake 36), and (b) match the operator's runtime
      // convention (newest-first sort baked into the URL).
      return ['/browse/orderby/new-arrivals/perpage/36', '/browse/perpage/36'];
    }
    return [];
  }
  const suffixes = listingSuffixesForPlatform(state.platform);

  for (const path of topLevelSorted) {
    if (probeCount >= 200) break;
    const fullPath = path.endsWith('/') ? path : path + '/';
    if (NON_CATEGORY_RE.test(fullPath)) continue;

    const url = `${origin}${fullPath}`;
    const normalized = url.replace(/\/$/, '').toLowerCase();
    if (existingUrls.has(normalized) || probed.has(normalized)) continue;
    probed.add(normalized);

    let result = await probeUrl(url, state, ctx);
    probeCount++;

    // If bare path has 0 products (tile page on Celerant etc.), try platform suffixes.
    if ((!result || result.page1ProductCount < 1) && suffixes.length > 0) {
      for (const suffix of suffixes) {
        if (probeCount >= 200) break;
        const suffixUrl = url.replace(/\/$/, '') + suffix;
        const suffixNormalized = suffixUrl.replace(/\/$/, '').toLowerCase();
        if (existingUrls.has(suffixNormalized) || probed.has(suffixNormalized)) continue;
        probed.add(suffixNormalized);
        result = await probeUrl(suffixUrl, state, ctx);
        probeCount++;
        if (result && result.page1ProductCount >= 1) break;
      }
    }

    if (result && result.page1ProductCount >= 1) {
      results.push(result);
    }
  }

  process.stderr.write(
    `  [catalog-urls] BC Stencil Phase 1: ${probeCount} top-level probes, ${results.length} productive\n`
  );

  // Phase 2: Probe 2-segment children (sub-categories under parents).
  // These catch categories nested under parents like /ammunition/pellets-bbs-airsoft-rubber-ball-co2/.
  // Only probe children of parents that were productive in Phase 1 or are common
  // category parents. Cap at total 300 probes.
  const productiveParents = new Set(results.map(r => {
    const u = new URL(r.url);
    return u.pathname.split('/').filter(Boolean)[0];
  }));

  for (const [parent, children] of twoSegment) {
    if (probeCount >= 300) break;
    const parentSlug = parent.replace(/\//g, '');
    // Only probe children of parents that were productive or are known category parents
    if (!productiveParents.has(parentSlug) && results.length > 5) continue;

    for (const childPath of children) {
      if (probeCount >= 300) break;
      const url = `${origin}${childPath.endsWith('/') ? childPath : childPath + '/'}`;
      const normalized = url.replace(/\/$/, '').toLowerCase();
      if (existingUrls.has(normalized) || probed.has(normalized)) continue;
      probed.add(normalized);

      const result = await probeUrl(url, state, ctx);
      probeCount++;
      if (result && result.page1ProductCount >= 1) {
        results.push(result);
      }
    }
  }

  process.stderr.write(
    `  [catalog-urls] BC Stencil: ${probeCount} total probes, ${results.length} productive categories\n`
  );

  return results;
}

// ─── Common "view all" URL probes ──────────────────────────────────────────

const VIEW_ALL_PATHS = [
  '/shop', '/shop/', '/shop-2/', '/all-products', '/all-products/',
  '/catalog', '/catalog/', '/store', '/store/',
  '/products', '/products/', '/inventory', '/inventory/',
];

// ─── Drupal Views discovery ─────────────────────────────────────────────────

/**
 * Drupal Views exposed-form discovery.
 * Detects <form> elements containing canonical Drupal Views exposed-input pair
 * (select[name="sort_by"] + select[name="sort_order"]), extracts form action URL,
 * and builds canonical catalog URL with date-style sort option.
 */
function discoverDrupalViewsCatalogs($: cheerio.CheerioAPI, origin: string): string[] {
  const found = new Set<string>();
  $('form').each((_, formEl) => {
    const $form = $(formEl);
    const sortBySelect = $form.find('select[name="sort_by"]');
    const sortOrderSelect = $form.find('select[name="sort_order"]');
    if (sortBySelect.length === 0 || sortOrderSelect.length === 0) return;

    let action = $form.attr('action') || '';
    if (!action) return;
    let actionUrl: string;
    try { actionUrl = new URL(action, origin).toString(); }
    catch { return; }
    actionUrl = actionUrl.replace(/\/$/, '');

    let dateValue: string | null = null;
    sortBySelect.find('option').each((_, optEl) => {
      const $opt = $(optEl);
      const value = ($opt.attr('value') || '').trim();
      const label = $opt.text().trim();
      if (!value || dateValue) return;
      if (/(date|created|posted|published|updated|new|recent|added|pub)/i.test(label) ||
          /(date|created|posted|published|updated|added|pub)/i.test(value)) {
        dateValue = value;
      }
    });
    if (!dateValue) {
      const firstVal = sortBySelect.find('option').toArray()
        .map(o => ($(o).attr('value') || '').trim())
        .find(v => v.length > 0);
      if (!firstVal) return;
      dateValue = firstVal;
    }

    const canonical = `${actionUrl}?sort_by=${encodeURIComponent(dateValue)}&sort_order=DESC`;
    found.add(canonical);
  });
  return Array.from(found).slice(0, 4);
}

/**
 * Drupal Views facet URL discovery.
 * For Drupal classifieds (gunpost.ca pattern), scan the catalog page for
 * facet filter links like `?f[0]=c:1`, `?f[0]=c:12`, etc.
 * These correspond to product categories (Firearms, Ammunition, etc.)
 * and must be included in catalogUrls for full coverage.
 *
 * Bug B7 fix: this was missing from the modular rewrite — the original
 * probe's Phase 4 discovered 26 such URLs on gunpost.ca.
 */
async function discoverDrupalFacetUrls(
  state: AccessIdentityState,
  origin: string,
  baseCatalogUrl: string,
): Promise<CatalogCandidate[]> {
  const ctx = { hasWaf: state.hasWaf, wafType: state.wafType, ua: state.userAgentOverride ?? undefined };
  const results: CatalogCandidate[] = [];

  try {
    const r = await fetchUrl(baseCatalogUrl, { ...ctx, timeoutMs: 20000 });
    if (r.status >= 400) return results;

    const $ = cheerio.load(r.body);
    const facetLinks = new Set<string>();

    // Drupal facet URLs use f[0]=c:N, f[0]=type:value patterns
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      // Match facet filter patterns: ?f[0]=c:N or /ads?f[0]=...
      if (/[?&]f(?:\[|%5B)\d+(?:\]|%5D)=/i.test(href)) {
        try {
          const fullUrl = new URL(href, origin).toString();
          // Only keep facet links from the same catalog path
          const catalogPath = new URL(baseCatalogUrl).pathname;
          const facetPath = new URL(fullUrl).pathname;
          if (facetPath === catalogPath || facetPath.startsWith(catalogPath)) {
            facetLinks.add(fullUrl);
          }
        } catch { /* skip malformed */ }
      }
    });

    // Probe each facet URL to verify it returns products
    for (const facetUrl of facetLinks) {
      const probed = await probeUrl(facetUrl, state, ctx);
      if (probed && probed.page1ProductCount >= 3) {
        results.push(probed);
        process.stderr.write(`  [catalog-urls] drupal facet: ${facetUrl} (${probed.page1ProductCount} products)\n`);
      }
    }
  } catch (e) {
    process.stderr.write(`  [catalog-urls] drupal facet discovery failed: ${(e as Error).message}\n`);
  }

  return results;
}

/**
 * Drupal Views catalog path-probe fallback.
 * Tries common Drupal Views catalog paths with universal sort fields.
 */
async function probeDrupalCatalogPaths(state: AccessIdentityState, origin: string): Promise<CatalogCandidate[]> {
  const ctx = { hasWaf: state.hasWaf, wafType: state.wafType, ua: state.userAgentOverride ?? undefined };
  const PATHS = ['/ads', '/listings', '/products', '/shop', '/inventory', '/catalog'];
  const SORT_FIELDS = ['date_pub', 'created', 'field_post_date_value', 'changed'];
  const found: CatalogCandidate[] = [];

  for (const path of PATHS) {
    let bestForPath: CatalogCandidate | null = null;
    for (const sortField of SORT_FIELDS) {
      const url = `${origin}${path}?sort_by=${sortField}&sort_order=DESC`;
      const probed = await probeUrl(url, state, ctx);
      if (probed && probed.page1ProductCount >= 3) {
        if (!bestForPath || probed.page1ProductCount > bestForPath.page1ProductCount) {
          bestForPath = probed;
        }
        if (probed.page1ProductCount >= 10) break;
      }
    }
    if (bestForPath) found.push(bestForPath);
  }

  return found;
}

// ─── Breadcrumb fallback ────────────────────────────────────────────────────

/**
 * Pick N random product URLs from the sitemap, fetch their detail pages,
 * extract breadcrumb category links. Returns unique category URLs that
 * return products. This catches categories not in the nav or taxonomy API.
 *
 * Only called when set-cover coverage < COVERAGE_TARGET_PCT after primary sources.
 */
export async function discoverBreadcrumbCategories(
  state: AccessIdentityState,
  sitemapProductUrls: string[],
  existingCandidateUrls: Set<string>,
): Promise<CatalogCandidate[]> {
  const ctx = { hasWaf: state.hasWaf, wafType: state.wafType, ua: state.userAgentOverride ?? undefined };
  const origin = state.canonicalOrigin;
  const results: CatalogCandidate[] = [];

  // Pick up to 5 random products spread across the sitemap
  const sampleIndices: number[] = [];
  const total = sitemapProductUrls.length;
  if (total === 0) return results;

  const step = Math.max(1, Math.floor(total / 5));
  for (let i = 0; i < total && sampleIndices.length < 5; i += step) {
    sampleIndices.push(i);
  }

  const categoryLinks = new Set<string>();

  for (const idx of sampleIndices) {
    const productUrl = sitemapProductUrls[idx];
    try {
      const r = await fetchUrl(productUrl, { ...ctx, timeoutMs: 15000 });
      if (r.status >= 400) continue;

      const $ = cheerio.load(r.body);

      // Extract breadcrumb links — common selectors across platforms
      const breadcrumbSelectors = [
        '.breadcrumb a', '.breadcrumbs a', '[class*="breadcrumb"] a',
        'nav[aria-label="breadcrumb"] a', '.woocommerce-breadcrumb a',
        '.product-breadcrumb a', '#breadcrumbs a', '.bc-breadcrumb a',
      ];

      for (const sel of breadcrumbSelectors) {
        $(sel).each((_, el) => {
          const href = $(el).attr('href');
          if (!href) return;
          try {
            const fullUrl = new URL(href, origin).toString();
            const u = new URL(fullUrl);
            if (u.hostname !== new URL(origin).hostname) return;
            if (u.pathname === '/') return; // homepage
            if (isLikelyNavUrl(fullUrl)) return;
            const normalized = fullUrl.replace(/\/$/, '').toLowerCase();
            if (!existingCandidateUrls.has(normalized)) {
              categoryLinks.add(fullUrl);
            }
          } catch { /* skip */ }
        });
      }
    } catch { /* skip */ }
  }

  // Probe discovered category links
  for (const catUrl of categoryLinks) {
    const probed = await probeUrl(catUrl, state, ctx);
    if (probed && probed.page1ProductCount >= 1) {
      results.push(probed);
      process.stderr.write(`  [catalog-urls] breadcrumb discovery: ${catUrl} (${probed.page1ProductCount} products)\n`);
    }
  }

  return results;
}

// ─── Main ───────────────────────────────────────────────────────────────────

export async function discoverCatalogUrls(
  state: AccessIdentityState,
  sitemapProductUrls?: string[],
): Promise<CatalogUrlsResult> {
  const origin = state.canonicalOrigin;
  const ctx = { hasWaf: state.hasWaf, wafType: state.wafType, ua: state.userAgentOverride ?? undefined };
  const apiCtx = { hasWaf: false as const, ua: state.userAgentOverride ?? undefined };

  const allCandidates: CatalogCandidate[] = [];
  let primarySource: CatalogUrlsResult['source'] = 'manual';

  // ───────────────────────────────────────────────────────────────────────
  // Source 1: Platform taxonomy APIs (most reliable for category enumeration)
  // ───────────────────────────────────────────────────────────────────────

  if (/woocommerce/.test(state.platform)) {
    const r = await fetchUrl(`${origin}/wp-json/wp/v2/product_cat?per_page=100&hide_empty=false`, apiCtx);
    if (r.status === 200) {
      try {
        const cats = JSON.parse(r.body) as WcCategory[];
        const wcCandidates = await discoverWcCategories(cats, state, ctx);
        if (wcCandidates.length > 0) {
          allCandidates.push(...wcCandidates);
          primarySource = 'taxonomy-api';
          process.stderr.write(`  [catalog-urls] WC taxonomy: ${wcCandidates.length} categories\n`);
        }
      } catch { /* fall through */ }
    }
  }

  if (/shopify/.test(state.platform)) {
    const r = await fetchUrl(`${origin}/collections.json?limit=250`, apiCtx);
    if (r.status === 200) {
      try {
        const json = JSON.parse(r.body) as { collections: Array<{ handle: string; products_count?: number }> };
        const visible = json.collections.filter(c => (c.products_count ?? 1) > 0);
        for (const coll of visible) {
          const url = `${origin}/collections/${coll.handle}`;
          const probed = await probeUrl(url, state, ctx);
          if (probed) {
            allCandidates.push(probed);
          }
        }
        if (allCandidates.length > 0) {
          primarySource = 'taxonomy-api';
          process.stderr.write(`  [catalog-urls] Shopify collections: ${allCandidates.length} productive\n`);
        }

        // Check for /collections/all (Shopify "all products" aggregator)
        const hasAll = visible.some(c => SHOPIFY_ALL_HANDLES.includes(c.handle));
        if (!hasAll) {
          for (const handle of SHOPIFY_ALL_HANDLES) {
            const probed = await probeUrl(`${origin}/collections/${handle}`, state, ctx);
            if (probed && probed.page1ProductCount >= 3) {
              allCandidates.push(probed);
              process.stderr.write(`  [catalog-urls] Shopify all-collection: /collections/${handle} (${probed.page1ProductCount} products)\n`);
              break;
            }
          }
        }
      } catch { /* fall through */ }
    }
  }

  // Wix Stores: single /shop URL (Mistake 27 — sub-category pagination leaks)
  if (/wix/.test(state.platform)) {
    const probed = await probeUrl(`${origin}/shop`, state, ctx);
    if (probed) {
      return { candidates: [probed], source: 'taxonomy-api' };
    }
    return { candidates: [], source: 'manual' };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Source 2: Homepage nav crawl
  // ───────────────────────────────────────────────────────────────────────

  const home = await fetchUrl(`${origin}/`, ctx);
  const $ = cheerio.load(home.body);

  // Source 2a: Drupal Views catalog discovery
  if (/drupal/.test(state.platform)) {
    const drupalFormUrls = discoverDrupalViewsCatalogs($, origin);
    for (const url of drupalFormUrls) {
      const probed = await probeUrl(url, state, ctx);
      if (probed) {
        allCandidates.push(probed);
        primarySource = 'taxonomy-api';
      }
    }

    const drupalPathUrls = await probeDrupalCatalogPaths(state, origin);
    if (drupalPathUrls.length > 0) {
      allCandidates.push(...drupalPathUrls);
      if (primarySource === 'manual') primarySource = 'category-tree-walk';
    }

    // For Drupal classifieds: if we found a canonical sort URL (e.g. /ads?sort_by=date_pub&sort_order=DESC)
    // that returns many products, it covers ALL listings. Skip facet URL discovery — facets
    // are category subsets that cause over-discovery (21 URLs vs the 1 canonical needed).
    // Threshold: if the canonical URL returns >= 15 products on page 1, treat as view-all.
    const drupalCanonical = [...allCandidates].find(c =>
      /\?sort_by=/.test(c.url) && c.page1ProductCount >= 15
    );

    if (drupalCanonical) {
      process.stderr.write(
        `  [catalog-urls] drupal canonical sort URL found: ${drupalCanonical.url} (${drupalCanonical.page1ProductCount} products) — using as sole catalog URL\n`
      );
      // For Drupal classifieds, the canonical sort URL covers ALL listings.
      // No need for additional nav/category URLs — return immediately.
      return { candidates: [drupalCanonical], source: 'taxonomy-api' };
    } else if (allCandidates.length > 0) {
      // Bug B7: Drupal facet URL discovery — find f[0]=c:N links on catalog pages
      // Only if no canonical sort URL was found (facets are needed for partial coverage).
      const baseCatalogUrl = allCandidates[0].url;
      const facetCandidates = await discoverDrupalFacetUrls(state, origin, baseCatalogUrl);
      if (facetCandidates.length > 0) {
        allCandidates.push(...facetCandidates);
        process.stderr.write(`  [catalog-urls] drupal facets: ${facetCandidates.length} facet URLs discovered\n`);
      }
    }
  }

  // Nav-link extraction from homepage.
  // Broad: ALL anchors anywhere on the page. Prior selector (nav/header/.menu/.mega-menu)
  // missed Celerant-style menus that use custom containers (e.g. .cf-menu, .dropdown-list).
  // The spine walker below applies its own category-shape filter (single-segment paths,
  // priority sort, NON_CATEGORY exclusion) so casting a wide net here is safe and necessary.
  const navAnchors = $('a[href]').map((_, el) => $(el).attr('href')).get();
  // Normalize hostname comparison to ignore "www." prefix — many sites link to
  // categories with absolute URLs (e.g. href="https://www.bullseyenorth.com/firearms")
  // even when the canonical origin is apex. Strict equality drops these silently.
  const stripWww = (h: string) => h.replace(/^www\./i, '');
  const originHostNorm = stripWww(new URL(origin).hostname);
  const navCandidates = navAnchors
    .filter((h): h is string => Boolean(h))
    .map(h => { try { return new URL(h, origin).toString(); } catch { return null; } })
    .filter((u): u is string => Boolean(u))
    .filter(u => {
      const p = new URL(u);
      return stripWww(p.hostname) === originHostNorm
        && !(p.pathname === '/' && p.search === '')
        && !p.hash;
    })
    .filter(u => !isLikelyNavUrl(u));

  const uniqueNav = [...new Set(navCandidates)];
  const existingUrls = new Set(allCandidates.map(c => c.url.replace(/\/$/, '').toLowerCase()));

  // Spine walker: enumerate top-level category paths from nav (single-segment paths
  // sorted by category-shape priority), probe each, then recurse into 2-segment
  // children of productive parents. Produces the per-category catalogUrls spine
  // for platforms whose bare category paths render listings (BigCommerce Stencil,
  // most Magento, OpenCart, LightSpeed). Used for any platform without a dedicated
  // taxonomy-API handler above.
  const navSpineCandidates = await discoverBcStencilCategories(state, origin, uniqueNav, existingUrls, ctx);
  if (navSpineCandidates.length > 0) {
    allCandidates.push(...navSpineCandidates);
    if (primarySource === 'manual') primarySource = 'category-tree-walk';
    process.stderr.write(`  [catalog-urls] nav spine walker: ${navSpineCandidates.length} productive categories\n`);
  }

  // Multi-segment probe: catches platform-specific convenience URLs that aren't
  // single-segment paths. Examples:
  //   - Celerant: /all-products/browse/orderby/new-arrivals/perpage/36
  //   - Some BC: /collections/all
  //   - Some sites with /shop?orderby=... query-style listings
  // Bare category paths on Celerant render subcategory tiles, not products — the
  // spine walker yields 0 productive candidates there, so this multi-segment
  // probe is the actual catalog-URL source for Celerant-like platforms.
  //
  // Filter out noise BEFORE probing:
  //   - Product detail URLs (last segment is a slug + numeric id) — Celerant /shop/<slug>-<id>,
  //     WC /product/<slug>, etc. They're not catalog pages even though "related products"
  //     widgets give them 3+ products on the page.
  //   - Filtered-subset URLs (/brand/*, /sale/yes, /clearance/*, /keyword/*, /search/*,
  //     /tag/*, /filter/*) — these are subsets of the parent catalog and create overlap
  //     without adding coverage.
  // Probe budget capped at 30 to stay respectful.
  const probedUrls = new Set([
    ...allCandidates.map(c => c.url.replace(/\/$/, '').toLowerCase()),
    ...existingUrls,
  ]);

  function isProductDetailUrl(u: string): boolean {
    try {
      const segs = new URL(u).pathname.split('/').filter(Boolean);
      if (segs.length === 0) return false;
      const last = segs[segs.length - 1];
      // Long slug ending in numeric id (3+ digits): canonical product detail pattern.
      // Allow optional leading dash (some Celerant slugs leak a leading hyphen,
      // e.g. /shop/-umarex-n2-regulator-adapter-5-8th-thread-35902).
      if (/^-?[a-z0-9][a-z0-9-]*-\d{3,}$/i.test(last)) return true;
      // /shop/<slug>, /product/<slug>, /products/<slug> with long slug
      if ((segs.includes('shop') || segs.includes('product') || segs.includes('products'))
          && /^-?[a-z0-9][a-z0-9-]+$/i.test(last)
          && last.length > 20) return true;
      return false;
    } catch { return false; }
  }

  function isFilteredSubsetUrl(u: string): boolean {
    try {
      const path = new URL(u).pathname;
      // Filtered-subset patterns that create overlap without adding coverage
      return /\/(brand|sale|clearance|keyword|search|tag|filter)\//i.test(path)
          || /\/(brand|sale|clearance|keyword|tag)$/i.test(path);
    } catch { return false; }
  }

  function isAggregatorUrl(u: string): boolean {
    try {
      const path = new URL(u).pathname.toLowerCase();
      // Aggregator URLs (the "all products in one view" convenience pages) — these
      // overlap entirely with the per-category spine. Excluding them ensures
      // catalogUrls reflects the spine, not the convenience aggregator.
      // Patterns: /all-products, /shop-all, /products-all, /everything, /full-catalog,
      // and their first-segment variants.
      const firstSeg = path.split('/').filter(Boolean)[0] || '';
      return /^(all-products|all_products|shop-all|shop_all|products-all|everything|full-catalog|all)$/i.test(firstSeg);
    } catch { return false; }
  }

  const multiSegCandidates = uniqueNav.filter(u => {
    const p = new URL(u);
    const segs = p.pathname.split('/').filter(Boolean);
    if (segs.length < 2) return false;
    if (probedUrls.has(u.replace(/\/$/, '').toLowerCase())) return false;
    if (isProductDetailUrl(u)) return false;
    if (isFilteredSubsetUrl(u)) return false;
    if (isAggregatorUrl(u)) return false;  // /all-products/* etc. — overlap entirely with spine
    return true;
  });
  // Probe ALL filtered candidates (not slice(0,30)) — the noise filter has already
  // narrowed the list; cutting at 30 risks missing the canonical sorted URL if it
  // appears later in homepage anchor order. With strict noise filter the filtered
  // list is typically 5-20 URLs.
  const multiSegProductive: CatalogCandidate[] = [];
  for (const url of multiSegCandidates) {
    const probed = await probeUrl(url, state, ctx);
    if (probed && probed.page1ProductCount >= 3) {
      multiSegProductive.push(probed);
    }
  }
  // Rank by page1ProductCount DESC and bias toward "canonical sorted" URLs (those
  // containing /orderby/ or /sort=, which signal an explicit sort that the operator
  // typically picks as the runtime catalogUrl). Keep top-5 — anything beyond that
  // is almost certainly a subset already covered by the leaders.
  multiSegProductive.sort((a, b) => {
    const aIsSorted = /\/orderby\/|[?&]sort/i.test(a.url) ? 1 : 0;
    const bIsSorted = /\/orderby\/|[?&]sort/i.test(b.url) ? 1 : 0;
    if (aIsSorted !== bIsSorted) return bIsSorted - aIsSorted;
    return b.page1ProductCount - a.page1ProductCount;
  });
  const TOP_N = 5;
  const kept = multiSegProductive.slice(0, TOP_N);
  allCandidates.push(...kept);
  if (multiSegCandidates.length > 0) {
    process.stderr.write(`  [catalog-urls] multi-segment probe: ${multiSegCandidates.length} URLs probed (after noise filter), ${multiSegProductive.length} productive, kept top-${kept.length} (sorted-canonical first)\n`);
    if (kept.length > 0) {
      process.stderr.write(`  [catalog-urls] top picks: ${kept.map(c => `${c.page1ProductCount}=${new URL(c.url).pathname}`).join(' | ')}\n`);
    }
  }

  if (allCandidates.length > 0 && primarySource === 'manual') {
    primarySource = 'nav';
  }

  // ───────────────────────────────────────────────────────────────────────
  // Source 3: Common "view all" URL probes
  // ───────────────────────────────────────────────────────────────────────

  const currentUrls = new Set(allCandidates.map(c => c.url.replace(/\/$/, '').toLowerCase()));
  for (const path of VIEW_ALL_PATHS) {
    const url = `${origin}${path}`;
    if (currentUrls.has(url.replace(/\/$/, '').toLowerCase())) continue;
    const probed = await probeUrl(url, state, ctx);
    if (probed && probed.page1ProductCount >= 10) {
      allCandidates.push(probed);
      process.stderr.write(`  [catalog-urls] view-all probe: ${url} (${probed.page1ProductCount} products)\n`);
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Source 4: Breadcrumb fallback (only if sitemap available and we have few candidates)
  // ───────────────────────────────────────────────────────────────────────

  if (sitemapProductUrls && sitemapProductUrls.length > 0 && allCandidates.length < 5) {
    const existingForBreadcrumb = new Set(allCandidates.map(c => c.url.replace(/\/$/, '').toLowerCase()));
    const breadcrumbCandidates = await discoverBreadcrumbCategories(state, sitemapProductUrls, existingForBreadcrumb);
    if (breadcrumbCandidates.length > 0) {
      allCandidates.push(...breadcrumbCandidates);
      process.stderr.write(`  [catalog-urls] breadcrumb fallback: ${breadcrumbCandidates.length} new categories\n`);
    }
  }

  // Dedupe and finalize
  const deduped = dedupeByUrl(allCandidates);
  const source: CatalogUrlsResult['source'] = deduped.length > 0
    ? (primarySource !== 'manual' ? primarySource : 'multi-source')
    : 'manual';

  process.stderr.write(`  [catalog-urls] total: ${deduped.length} unique candidates (source: ${source})\n`);

  return { candidates: deduped, source };
}
