// Batch-4 R4 corrections (2026-05-19 audit, 10 sites).
// Default dry-run; pass --apply to commit.
//
// Coverage rule applied: smallest URL set with 100% customer-facing coverage,
// minimum overlap (token parallelism doesn't help — per-site hourly budget is
// the binding ceiling, overlap wastes budget).
//
// Single-URL confirmed safe (5): gotenda, g4cgunstore, greatnorthgunco,
//                                nordicmarksman, canadasgunstore.
// Multi-URL required (5): alflahertys, canadafirstammo, doctordeals, hical,
//                          wolverinesupplies (firearm-only via /firearms/).

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const DELETE_SENTINEL = '_DELETE_FIELD_';

const SAFARI17_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15';

const CORRECTIONS = {
  // gotenda.com — collapse 8 per-category to single /shop/. R3 verified
  // page 693 last, page 694 = 404; 16,615 products via /shop/ alone.
  // DB's /firearms/ etc. slugs are real 404s (merchant SEO rename).
  'gotenda.com': {
    catalogUrls: ['/shop/'],
    expectedProductCount: 16615,
    productCountMethod: { method: 'wp-rest-header', endpoint: '/wp-json/wp/v2/product', header: 'x-wp-total' },
    perPage: 24,
    'paginationPattern.perPage': 24,
  },

  // wolverinesupplies.com — column hasWaf flip (passive CF, no rules);
  // structured productCountMethod (bare-string broken via validateMethod throw);
  // verifyMethod=detail-page (currently MISSING — verify worker no-ops);
  // sitemap count: 8193 (today's count, R5-verified).
  // Note: /firearms/ remains the catalogUrl (firearm-only crawl is the project's
  // target for this BC site with 8193 total mixed products — clothing/etc filtered).
  'wolverinesupplies.com': {
    hasWaf: false,
    productCountMethod: { method: 'sitemap', url: '/xmlsitemap.php?type=products&page=1' },
    expectedProductCount: 8193,
    'crawlers.maintain.verifyMethod': 'detail-page',
  },

  // alflahertys.com — column hasWaf flip (passive CF, no Sucuri);
  // remove stale wafWorkaround block; sortParam null (Klevu rejects every
  // date sort with HTTP 500); perPage=20 (operator preference).
  // klevuCategoryPaths field retained per existing DB shape; runtime ignores
  // (_resolveKlevuCategoryPath is dead code — Phase 3b deletes it).
  'alflahertys.com': {
    hasWaf: false,
    wafWorkaround: DELETE_SENTINEL,
    sortParam: null,
    perPage: 20,
  },

  // nordicmarksman.com — single /categories.php URL with limit=2500 covers
  // 98.8% of catalog across 2 pages (4679 union, page 3 terminates clean).
  // sitemap-derived total today = 4761 (3023 + 1738). hasWaf=false (passive).
  // sort=newest is functionally required (default order is curated, not newest).
  // productCountMethod shape fix: `sitemap-index` reads `urls[]`, not scalar `url`.
  'nordicmarksman.com': {
    hasWaf: false,
    catalogUrls: ['/categories.php'],
    perPage: 2500,
    'paginationPattern.perPage': 2500,
    expectedProductCount: 4761,
    productCountMethod: { method: 'sitemap-index', urls: ['/xmlsitemap.php?type=products&page=1', '/xmlsitemap.php?type=products&page=2'] },
    sortParam: '?sort=newest',
    sortVerified: true,
    searchUrl: '/search.php?search_query={keyword}',
  },

  // greatnorthgunco.ca — single /shop/ URL (532 visible verified at page 23
  // last, page 24 = 404). verifyMethod=detail-page because Store API drops
  // 3778 catalog_visibility=hidden products (2026-04-03 incident). WP REST
  // x-wp-total=4312 includes hidden (matches detail-page tolerance).
  'greatnorthgunco.ca': {
    catalogUrls: ['/shop/'],
    'crawlers.maintain.verifyMethod': 'detail-page',
    expectedProductCount: 4312,
    productCountMethod: { method: 'wp-rest-header', endpoint: '/wp-json/wp/v2/product', header: 'x-wp-total' },
    searchUrl: '/?s={keyword}&post_type=product',
  },

  // canadasgunstore.ca — single umbrella URL covers all 2384 products
  // (R2 walk: 12 SKUs in archery/crossbow/CZ-mag/freight exist ONLY in
  // umbrella, NOT in the 7 subclass URLs). Pipe character is literal.
  'canadasgunstore.ca': {
    catalogUrls: ['/departments/outdoors---hunting-etc--|30.html'],
    expectedProductCount: 2384,
    searchUrl: '/inet/storefront/store.php?mode=searchstore&search[searchfor]={keyword}',
    platform: 'activant-inet',
  },

  // hical.ca — R2's 23-URL list (replaces DB's dead /firearms/ slug with
  // /firearms-canada/). Sum of top-level firearm-relevant counts = 1799;
  // global X-WP-Total = 1676 (7.3% overlap). Multi-URL required — no
  // single umbrella exists. productCountMethod shape fix.
  // verifyMethod stays at operator's existing 'store-api' choice (per
  // R2's verifyMethodPolicy note + DB precedent).
  'hical.ca': {
    catalogUrls: [
      'https://hical.ca/product-category/firearm-accessories/',
      'https://hical.ca/product-category/firearm-parts/',
      'https://hical.ca/product-category/firearms-canada/',
      'https://hical.ca/product-category/optics-mounts/',
      'https://hical.ca/product-category/tactical-accessories/',
      'https://hical.ca/product-category/cleaning-maintenance/',
      'https://hical.ca/product-category/all-products/',
      'https://hical.ca/product-category/uncategorized/',
      'https://hical.ca/product-category/optics-2/',
      'https://hical.ca/product-category/night-vision-accessories/',
      'https://hical.ca/product-category/storage-cases-transport/',
      'https://hical.ca/product-category/shooting-accessories-misc/',
      'https://hical.ca/product-category/hunting-survival-gear/',
      'https://hical.ca/product-category/handguards/',
      'https://hical.ca/product-category/shotgun/',
      'https://hical.ca/product-category/courses-training/',
      'https://hical.ca/product-category/raffle/',
      'https://hical.ca/product-category/clearance/',
      'https://hical.ca/product-category/draws/',
      'https://hical.ca/product-category/gun-smith-services/',
      'https://hical.ca/product-category/new-arrivals/',
      'https://hical.ca/product-category/scopes/',
      'https://hical.ca/product-category/range-finder/',
    ],
    expectedProductCount: 1676,
    productCountMethod: { method: 'wp-rest-header', endpoint: '/wp-json/wp/v2/product', header: 'x-wp-total' },
    'crawlers.watermark.method': 'api-date-since-watermark',
  },

  // g4cgunstore.com — single /shop/ URL (page 245 last, page 246 = 404,
  // 5863 products). userAgentOverride to Safari 17 because deterministic
  // Chrome 120 UA (md5 idx 0) gets 403 after ~60s of crawling (R3-verified).
  // Edge 120 also 403; Safari/Firefox stay 200.
  'g4cgunstore.com': {
    catalogUrls: ['/shop/'],
    userAgentOverride: SAFARI17_UA,
    expectedProductCount: 5863,
    needsPlaywright: false,
    wafType: 'cloudflare-passive',
  },

  // canadafirstammo.ca — BIG fix: expectedProductCount 962 -> 132. At ratio
  // 132/962 = 13.7%, verifyBootstrapCoverage at product-count-probe.ts:521-525
  // would keep bootstrap stuck forever. Switch to Store API (visible) endpoint.
  // sortVerified shape: boolean (DB had object that fails === true strict check).
  // hasWaf=false (CF bot rule fires only on sqlmap/python UAs, not production rotation).
  // catalogUrls unchanged here — R2/R3 found no single umbrella (shop-all
  // only has 109 of 132). Existing per-category list operates correctly.
  'canadafirstammo.ca': {
    expectedProductCount: 132,
    productCountMethod: { method: 'wc-store-api-header', endpoint: '/wp-json/wc/store/v1/products', header: 'x-wp-total' },
    hasWaf: false,
    sortVerified: true,
    searchUrl: '/?s={keyword}&post_type=product',
  },

  // doctordeals.ca — 6-URL canonical spine WITHOUT gun-shop/ prefix
  // (R3-verified: gun-shop is a permalink-rewrite prefix, NOT a real WP term;
  // 0 of 54 product_cat terms contain it). verifyMethod=detail-page
  // (runtime-equivalent to DB's json-ld; only worker.ts:397 literal-checks
  // for 'store-api'). perPage=12 (boundary math 8x12+11=107).
  'doctordeals.ca': {
    catalogUrls: [
      '/product-category/firearms/',
      '/product-category/parts/',
      '/product-category/accessories/',
      '/product-category/mags-barrels/',
      '/product-category/clothing-gun-related/',
      '/product-category/defense/',
    ],
    'crawlers.maintain.verifyMethod': 'detail-page',
    perPage: 12,
    searchUrl: '/?s={keyword}&post_type=product',
  },
};

function setNested(obj, dottedKey, value) {
  if (!dottedKey.includes('.')) { obj[dottedKey] = value; return; }
  const parts = dottedKey.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function deleteNested(obj, dottedKey) {
  if (!dottedKey.includes('.')) {
    if (Object.prototype.hasOwnProperty.call(obj, dottedKey)) { delete obj[dottedKey]; return true; }
    return false;
  }
  const parts = dottedKey.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur == null || typeof cur !== 'object') return false;
    cur = cur[parts[i]];
  }
  if (cur == null || typeof cur !== 'object') return false;
  const last = parts[parts.length - 1];
  if (Object.prototype.hasOwnProperty.call(cur, last)) { delete cur[last]; return true; }
  return false;
}

function getNested(obj, dottedKey) {
  if (!dottedKey.includes('.')) return obj?.[dottedKey];
  const parts = dottedKey.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function jsonEq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function shortJson(v) {
  const s = JSON.stringify(v);
  if (s === undefined) return 'undefined';
  return s.length > 100 ? s.slice(0, 97) + '...' : s;
}

async function main() {
  let totalDiffs = 0;
  let totalWrites = 0;
  const skipped = [];

  for (const [domain, patches] of Object.entries(CORRECTIONS)) {
    const site = await prisma.monitoredSite.findFirst({
      where: { domain },
      select: { id: true, domain: true, hasWaf: true, hasCaptcha: true, siteProfile: true },
    });
    if (!site) { skipped.push(`${domain}: NOT FOUND in DB`); continue; }

    const profile = JSON.parse(JSON.stringify(site.siteProfile || {}));
    const diffs = [];

    for (const [key, value] of Object.entries(patches)) {
      if (key === 'hasWaf' || key === 'hasCaptcha') continue;
      if (value === DELETE_SENTINEL) {
        const before = getNested(profile, key);
        if (before === undefined) continue;
        if (deleteNested(profile, key)) diffs.push(`${key}: DELETE (was ${shortJson(before)})`);
        continue;
      }
      const old = getNested(profile, key);
      if (jsonEq(old, value)) continue;
      setNested(profile, key, value);
      diffs.push(`${key}: ${shortJson(old)} -> ${shortJson(value)}`);
    }

    const columnDiffs = [];
    if (Object.prototype.hasOwnProperty.call(patches, 'hasWaf') && site.hasWaf !== patches.hasWaf) {
      columnDiffs.push(`COLUMN hasWaf: ${site.hasWaf} -> ${patches.hasWaf}`);
    }
    if (Object.prototype.hasOwnProperty.call(patches, 'hasCaptcha') && site.hasCaptcha !== patches.hasCaptcha) {
      columnDiffs.push(`COLUMN hasCaptcha: ${site.hasCaptcha} -> ${patches.hasCaptcha}`);
    }

    if (diffs.length === 0 && columnDiffs.length === 0) continue;
    totalDiffs += diffs.length + columnDiffs.length;

    console.log(`\n=== ${domain} ===`);
    diffs.forEach(d => console.log(`  ${d}`));
    columnDiffs.forEach(d => console.log(`  ${d}`));

    if (APPLY) {
      try {
        const updateData = { siteProfile: profile };
        if (Object.prototype.hasOwnProperty.call(patches, 'hasWaf')) updateData.hasWaf = patches.hasWaf;
        if (Object.prototype.hasOwnProperty.call(patches, 'hasCaptcha')) updateData.hasCaptcha = patches.hasCaptcha;
        await prisma.monitoredSite.update({ where: { id: site.id }, data: updateData });
        totalWrites++;
        console.log(`  WROTE (${diffs.length} JSON, ${columnDiffs.length} column)`);
      } catch (e) {
        skipped.push(`${domain}: ${e.message}`);
        console.log(`  WRITE FAILED: ${e.message}`);
      }
    }
  }

  console.log('');
  console.log(`Sites in CORRECTIONS: ${Object.keys(CORRECTIONS).length} | total diffs (JSON+column): ${totalDiffs}`);
  if (APPLY) {
    console.log(`Sites updated: ${totalWrites}`);
    if (skipped.length) { console.log(`Skipped: ${skipped.length}`); skipped.forEach(m => console.log('  ' + m)); }
  } else {
    console.log('(dry-run; pass --apply to commit)');
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
