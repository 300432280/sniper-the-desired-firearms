// backend/scripts/probe/room3-geography-count/catalog-urls.ts
// Discover minimum catalogUrls covering 100% of products with minimum overlap.
// Per spec §4.3 step 1 + playbook Phase 3.

import * as cheerio from 'cheerio';
import { fetchUrl } from '../shared/fetch';
import { isLikelyNavUrl } from '../shared/url-utils';
import { extractProducts } from '../shared/extract';
import type { AccessIdentityState } from '../shared/types';

export type CatalogUrlsResult = {
  catalogUrls: string[];
  source: 'nav' | 'taxonomy-api' | 'category-tree-walk' | 'manual';
};

export async function discoverCatalogUrls(state: AccessIdentityState): Promise<CatalogUrlsResult> {
  const origin = state.canonicalOrigin;
  const ctx = { hasWaf: state.hasWaf, wafType: state.wafType, ua: state.userAgentOverride ?? undefined };
  // API calls need to bypass Playwright (which wraps JSON in HTML and strips headers).
  // Same pattern as Task 4.2: hasWaf: false + pick UA for WAF type.
  const apiCtx = { hasWaf: false as const, ua: state.userAgentOverride ?? undefined };

  // 1. Try platform-specific taxonomy APIs first (most reliable)
  if (/woocommerce/.test(state.platform)) {
    const r = await fetchUrl(`${origin}/wp-json/wp/v2/product_cat?per_page=100&hide_empty=false`, apiCtx);
    if (r.status === 200) {
      try {
        const cats = JSON.parse(r.body) as Array<{ slug: string; count: number; parent: number; link: string }>;
        // Top-level non-empty categories. Use the API-provided `link` field
        // — WooCommerce permalink base is configurable (Settings > Permalinks);
        // hardcoding `/product-category/<slug>/` breaks any site using `/shop/`,
        // `/categories/`, or a custom base. The link field is authoritative.
        const tops = cats.filter(c => c.parent === 0 && c.count > 0 && c.link);
        return {
          catalogUrls: tops.map(c => c.link),
          source: 'taxonomy-api',
        };
      } catch { /* fall through */ }
    }
  }
  if (/shopify/.test(state.platform)) {
    const r = await fetchUrl(`${origin}/collections.json?limit=250`, apiCtx);
    if (r.status === 200) {
      try {
        const json = JSON.parse(r.body) as { collections: Array<{ handle: string; published_at?: string; products_count?: number }> };
        const visible = json.collections.filter(c => (c.products_count ?? 1) > 0);
        return {
          catalogUrls: visible.map(c => `${origin}/collections/${c.handle}`),
          source: 'taxonomy-api',
        };
      } catch { /* fall through */ }
    }
  }

  // 2. Nav-link discovery from homepage HTML
  const home = await fetchUrl(`${origin}/`, ctx);
  const $ = cheerio.load(home.body);

  // 2a. Drupal Views catalog discovery (generic — any Drupal site whose catalog
  // is rendered by Views with `?sort_by=*&sort_order=*` exposed-form OR
  // anchor-based sort UI). Two-step:
  //   (i)  Form-based: scan homepage <form> elements for the canonical exposed
  //        Drupal Views inputs (select[name="sort_by"] + select[name="sort_order"]);
  //        works on Drupal sites that render the exposed-filter form server-side.
  //   (ii) Path-probe fallback: when form-based fails (anchor-only sort UI, or
  //        catalog path absent from homepage forms), try common Drupal Views
  //        catalog paths (/ads, /listings, /products, /shop, /inventory, /catalog)
  //        with Drupal's standard `created` sort_by field, empirically test via
  //        extractor (extract.ts dispatches drupal-commerce → GunpostAdapter
  //        whose selectors are Drupal-classifieds-generic). Pick paths that
  //        return >=3 products. Reference: playbook Mistake 37, persona Mistake 37.
  if (/drupal/.test(state.platform)) {
    const drupalUrls = discoverDrupalViewsCatalogs($, origin);
    if (drupalUrls.length > 0) {
      return { catalogUrls: drupalUrls, source: 'taxonomy-api' };
    }
    const probedDrupal = await probeDrupalCatalogPaths(state, origin);
    if (probedDrupal.length > 0) {
      return { catalogUrls: probedDrupal, source: 'category-tree-walk' };
    }
  }

  const navAnchors = $('nav a, header a, .menu a, [class*="nav"] a').map((_, el) => $(el).attr('href')).get();
  const candidates = navAnchors
    .filter((h): h is string => Boolean(h))
    .map(h => {
      try { return new URL(h, origin).toString(); } catch { return null; }
    })
    .filter((u): u is string => Boolean(u))
    .filter(u => {
      const p = new URL(u);
      return p.hostname === new URL(origin).hostname
          // Reject homepage and fragment-only URLs — empirical filter passes
          // them when the homepage has a "featured products" section, but
          // walking the homepage as a "catalog" produces duplicates with no
          // pagination. Same for `/#` (fragment routes).
          && !(p.pathname === '/' && p.search === '')
          && !p.hash;
    })
    .filter(u => !isLikelyNavUrl(u));

  const unique = [...new Set(candidates)];

  // 3. Empirical filter: keep candidates that actually return products via production extractor
  const probed: Array<{ url: string; productCount: number }> = [];
  for (const url of unique.slice(0, 30)) {
    try {
      const r = await fetchUrl(url, { ...ctx, timeoutMs: 12000 });
      const products = extractProducts(r.body, url, state.platform);
      probed.push({ url, productCount: products.length });
    } catch { /* skip */ }
  }
  probed.sort((a, b) => b.productCount - a.productCount);
  const productive = probed.filter(p => p.productCount >= 3).map(p => p.url);

  return {
    catalogUrls: productive,
    source: productive.length > 0 ? 'nav' : 'manual',
  };
}

/**
 * Drupal Views catalog path-probe fallback.
 * Tries common Drupal Views catalog paths with the universal `created` sort
 * field. For each candidate, fetches via the WAF-aware ctx (so CF-active sites
 * route through Playwright) and runs extractProducts with the platform tag
 * (which dispatches to GunpostAdapter for drupal-commerce, recognizing
 * `node--type-classified` / `gunpost-teaser` / `listing-item` markup).
 *
 * Returns paths that yield >=3 products via extraction. Multiple try-orders
 * for the sort_by field name (Drupal sites use different conventions:
 * `created` is core/universal, `date_pub` / `field_post_date_value` are
 * common content-type-specific names, `nid` is the node ID fallback).
 *
 * Reference: persona Mistake 37 (gunpost canonical URL is
 * `/ads?sort_by=date_pub&sort_order=DESC`; bare `/ads` is CF-challenged but
 * sort-param URLs pass through).
 */
async function probeDrupalCatalogPaths(state: AccessIdentityState, origin: string): Promise<string[]> {
  const ctx = { hasWaf: state.hasWaf, wafType: state.wafType, ua: state.userAgentOverride ?? undefined };
  const PATHS = ['/ads', '/listings', '/products', '/shop', '/inventory', '/catalog'];
  const SORT_FIELDS = ['created', 'date_pub', 'field_post_date_value', 'changed'];
  const found: Array<{ url: string; productCount: number }> = [];

  for (const path of PATHS) {
    let bestForPath: { url: string; productCount: number } | null = null;
    for (const sortField of SORT_FIELDS) {
      const url = `${origin}${path}?sort_by=${sortField}&sort_order=DESC`;
      try {
        const r = await fetchUrl(url, { ...ctx, timeoutMs: 20000 });
        if (r.status >= 400) continue;
        const products = extractProducts(r.body, url, state.platform);
        if (products.length >= 3) {
          if (!bestForPath || products.length > bestForPath.productCount) {
            bestForPath = { url, productCount: products.length };
          }
          // Heuristic: if the FIRST sort_field tried gives strong results
          // (≥10 products), assume it's the right one for this path and
          // stop probing other field names for this path.
          if (products.length >= 10) break;
        }
      } catch { /* skip */ }
    }
    if (bestForPath) found.push(bestForPath);
  }

  found.sort((a, b) => b.productCount - a.productCount);
  return found.map(f => f.url);
}

/**
 * Generic Drupal Views exposed-form discovery.
 * Detects <form> elements containing the canonical Drupal Views exposed-input
 * pair (`<select name="sort_by">` + `<select name="sort_order">`), extracts the
 * form action URL, and builds the canonical catalog URL with the date-style
 * sort option. Returns up to 4 candidate URLs (one per matching form) — usually
 * the same form repeated, deduped to one canonical form-action URL.
 *
 * Reference: persona Mistake 37 (Drupal Views exposed-form pattern).
 */
function discoverDrupalViewsCatalogs($: cheerio.CheerioAPI, origin: string): string[] {
  const found = new Set<string>();
  $('form').each((_, formEl) => {
    const $form = $(formEl);
    const sortBySelect = $form.find('select[name="sort_by"]');
    const sortOrderSelect = $form.find('select[name="sort_order"]');
    if (sortBySelect.length === 0 || sortOrderSelect.length === 0) return;

    // Form action — Drupal Views uses GET; action is the catalog path.
    let action = $form.attr('action') || '';
    if (!action) return;
    let actionUrl: string;
    try { actionUrl = new URL(action, origin).toString(); }
    catch { return; }
    // Strip trailing slash for cleaner URL building
    actionUrl = actionUrl.replace(/\/$/, '');

    // Find the date-style sort_by option value (e.g. "date_pub", "created",
    // "field_post_date_value"). Drupal Views exposes the column name as the
    // option value; the label is human text we can grep for date-style words.
    let dateValue: string | null = null;
    sortBySelect.find('option').each((_, optEl) => {
      const $opt = $(optEl);
      const value = ($opt.attr('value') || '').trim();
      const label = $opt.text().trim();
      if (!value) return;  // skip the empty/default option
      if (dateValue) return;  // already found
      if (/(date|created|posted|published|updated|new|recent|added|pub)/i.test(label) ||
          /(date|created|posted|published|updated|added|pub)/i.test(value)) {
        dateValue = value;
      }
    });
    if (!dateValue) {
      // Fallback: first non-empty option
      const firstVal = sortBySelect.find('option').toArray()
        .map(o => ($(o).attr('value') || '').trim())
        .find(v => v.length > 0);
      if (!firstVal) return;
      dateValue = firstVal;
    }

    // Build canonical URL — sort_order=DESC is the universal newest-first
    // convention for Drupal Views; if the form's exposed sort_order select
    // only has ASC (rare), the eventual walk will still extract products,
    // just oldest-first. Room 4 sort detection will reconcile.
    const canonical = `${actionUrl}?sort_by=${encodeURIComponent(dateValue)}&sort_order=DESC`;
    found.add(canonical);
  });
  return Array.from(found).slice(0, 4);
}
