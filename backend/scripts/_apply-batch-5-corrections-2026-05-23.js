// Batch-5 R4 corrections (2026-05-22 audit, 10 sites).
// Default dry-run; pass --apply to commit.
//
// CRITICAL: gagnonsports.com gets a DOMAIN rename (gagnonsports.com → www.gagnonsports.com)
// — apex returns 403/404 on every production UA, only www host serves traffic.
// Both R1 and R2 audited the wrong host; R3 caught it.
//
// Cross-cutting fixes:
//   - hasWaf flip BOTH column AND siteProfile.hasWaf JSON field (batch-4 lesson: JSON drift)
//   - non-canonical productCountMethod.method names replaced with VALID_METHOD_NAMES entries
//   - thegundealer WAF migration (siteground-sgcaptcha → cloudflare-passive, 43d stale)

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const DELETE_SENTINEL = '_DELETE_FIELD_';

const TGD_CATS = [
  'https://thegundealer.ca/product-category/new-guns/',
  'https://thegundealer.ca/product-category/accessories/',
  'https://thegundealer.ca/product-category/ammunition/',
  'https://thegundealer.ca/product-category/optics/',
  'https://thegundealer.ca/product-category/parts/',
  'https://thegundealer.ca/product-category/reloading-components/',
  'https://thegundealer.ca/product-category/used-items/',
  'https://thegundealer.ca/product-category/tgd-promo-1/',
  'https://thegundealer.ca/product-category/draws/',
  'https://thegundealer.ca/product-category/new-arrivals/',
  'https://thegundealer.ca/product-category/fine-guns/',
  'https://thegundealer.ca/product-category/special-savage-clearance/',
  'https://thegundealer.ca/product-category/category-caesar-guerini/',
  'https://thegundealer.ca/product-category/sales-promotions/',
  'https://thegundealer.ca/product-category/special-browning-gear-clearance/',
  'https://thegundealer.ca/product-category/tgd-promo4/',
  'https://thegundealer.ca/product-category/browning-gear-clearance/',
  'https://thegundealer.ca/product-category/special-norma-ammo-sale/',
  'https://thegundealer.ca/product-category/great-discounts/',
  'https://thegundealer.ca/product-category/special-fierce-clearance/',
  'https://thegundealer.ca/product-category/auctions/',
  'https://thegundealer.ca/product-category/tgd-promo-wetrhgf/',
  'https://thegundealer.ca/product-category/john-m-browning-collection/',
  'https://thegundealer.ca/product-category/special-browning-bar-sale/',
  'https://thegundealer.ca/product-category/tgd-sale/',
];

const CORRECTIONS = {
  'aagcanada.ca': {
    hasWaf: false,
    'siteProfile.hasWaf': false,
    expectedProductCount: 565,
    productCountMethod: { method: 'shopify-products-walk', endpoint: '/products.json', perPage: 250 },
    catalogUrls: ['/collections/all'],
    perPage: 250,
    searchUrl: '/search?q={keyword}&type=product',
  },

  'durhamoutdoors.ca': {
    hasWaf: false,
    'siteProfile.hasWaf': false,
    expectedProductCount: 389,
    searchUrl: DELETE_SENTINEL,
  },

  'frontierfirearms.ca': {
    hasWaf: false,
    'siteProfile.hasWaf': false,
    productCountMethod: { method: 'sitemap', url: '/xmlsitemap.php?type=products&page=1' },
    expectedProductCount: 1281,
    searchUrl: '/search.php?search_query={keyword}',
  },

  // BLOCKING domain rename + full re-config
  'gagnonsports.com': {
    _domain: 'www.gagnonsports.com',
    hasWaf: false,
    'siteProfile.hasWaf': false,
    userAgentOverride: DELETE_SENTINEL,
    wafWorkaround: DELETE_SENTINEL,
    perPage: 100,
    productCountMethod: { method: 'html-pagination', selector: '.showing_result', perPage: 1 },
    expectedProductCount: 2706,
  },

  'irunguns.ca': {
    hasWaf: false,
    'siteProfile.hasWaf': false,
    catalogUrls: ['/product.php'],
    searchUrl: DELETE_SENTINEL,
    productCountMethod: { method: 'html-pagination', selector: '.showing_result', perPage: 1 },
    expectedProductCount: 104,
  },

  // NO hasWaf flip — DB defensive true is operationally correct on this site
  'jobrookoutdoors.com': {
    perPage: 100,
    'crawlers.maintain.verifyMethod': 'detail-page',
  },

  'rdsc.ca': {
    hasWaf: false,
    'siteProfile.hasWaf': false,
    perPage: 48,
    'paginationPattern.perPage': 48,
    expectedProductCount: 9343,
    productCountMethod: { method: 'html-pagination', selector: '.toolbar-number', perPage: 1 },
  },

  'store.prophetriver.com': {
    hasWaf: false,
    'siteProfile.hasWaf': false,
    productCountMethod: { method: 'sitemap-index', urls: ['/xmlsitemap.php?type=products&page=1', '/xmlsitemap.php?type=products&page=2'] },
    expectedProductCount: 13974,
    searchUrl: '/search.php?search_query={keyword}',
    perPage: 100,
    wafWorkaround: DELETE_SENTINEL,
  },

  'tacord.com': {
    'crawlers.watermark.method': 'api-date-since-watermark',
    expectedProductCount: 206,
    'productCountMethod.endpoint': '/wp-json/wc/store/v1/products',
  },

  // WAF MIGRATION: siteground-sgcaptcha → cloudflare-passive
  'thegundealer.ca': {
    hasWaf: false,
    'siteProfile.hasWaf': false,
    wafType: 'cloudflare-passive',
    userAgentOverride: DELETE_SENTINEL,
    needsPlaywright: false,
    catalogUrls: TGD_CATS,
    productCountMethod: { method: 'wp-rest-header', endpoint: '/wp-json/wc/store/v1/products', header: 'x-wp-total' },
    expectedProductCount: 11230,
    'crawlers.maintain.verifyMethod': 'store-api',
    'crawlers.maintain.verifyEndpoint': '/wp-json/wc/store/v1/products',
    'crawlers.watermark.method': 'api-date-since-watermark',
    wafWorkaround: DELETE_SENTINEL,
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
  for (const p of parts) { if (cur == null) return undefined; cur = cur[p]; }
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
    const columnDiffs = [];

    if (patches._domain && site.domain !== patches._domain) {
      columnDiffs.push(`COLUMN domain: ${site.domain} -> ${patches._domain}`);
    }

    for (const [key, value] of Object.entries(patches)) {
      if (key === '_domain') continue;
      if (key === 'hasWaf') {
        if (site.hasWaf !== value) columnDiffs.push(`COLUMN hasWaf: ${site.hasWaf} -> ${value}`);
        continue;
      }
      if (key === 'hasCaptcha') {
        if (site.hasCaptcha !== value) columnDiffs.push(`COLUMN hasCaptcha: ${site.hasCaptcha} -> ${value}`);
        continue;
      }
      const profileKey = key.startsWith('siteProfile.') ? key.slice('siteProfile.'.length) : key;

      if (value === DELETE_SENTINEL) {
        const before = getNested(profile, profileKey);
        if (before === undefined) continue;
        if (deleteNested(profile, profileKey)) diffs.push(`${profileKey}: DELETE (was ${shortJson(before)})`);
        continue;
      }
      const old = getNested(profile, profileKey);
      if (jsonEq(old, value)) continue;
      setNested(profile, profileKey, value);
      diffs.push(`${profileKey}: ${shortJson(old)} -> ${shortJson(value)}`);
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
        if (patches._domain) updateData.domain = patches._domain;
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
  console.log(`Sites in CORRECTIONS: ${Object.keys(CORRECTIONS).length} | total diffs: ${totalDiffs}`);
  if (APPLY) {
    console.log(`Sites updated: ${totalWrites}`);
    if (skipped.length) { console.log(`Skipped: ${skipped.length}`); skipped.forEach(m => console.log('  ' + m)); }
  } else {
    console.log('(dry-run; pass --apply to commit)');
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
