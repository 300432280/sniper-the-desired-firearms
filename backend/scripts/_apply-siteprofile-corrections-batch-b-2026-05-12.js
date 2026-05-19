// One-shot: apply siteProfile corrections to the 10 sites from the 4-round adversarial
// audit (Batch B: bullseyenorth, londerosports, northprosports, precisionoptics,
// reliablegun, lockharttactical, outfitters.goldnloan, liangjian, surplusherbys,
// truenortharms). Per-site values are derived from Round 4 synthesis (R1 + R2 + R3).
//
// Run with `--dry-run` (default) to preview diffs; `--apply` to commit.

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

const CORRECTIONS = {
  'bullseyenorth.com': {
    expectedProductCount: 3343,
    productCountMethod: {
      method: 'html-pagination',
      url: '/all-products/browse/orderby/new-arrivals/perpage/36',
      selector: '#paginTotals',
      regex: 'of (\\d+) total',
      perPage: 1,
    },
    wafWorkaround: {
      method: 'curl-spawn',
      reason: 'X-Frame-Options has space before colon (Celerant ColdFusion). Node 24 axios/undici/fetch all fail HPE_INVALID_HEADER_TOKEN.',
    },
    productUrlSchemes: {
      canonical: '/shop/<slug>-<id>',
      sitemapForm: '/<brand>/<slug>-<id>',
      joinOn: 'numeric-id-suffix',
    },
    searchUrl: '/all-products/browse/keyword/{keyword}',
  },
  'londerosports.com': {
    // IP-dependent fields (hasWaf, needsPlaywright, wafType) intentionally LEFT AS-IS in DB —
    // R2 saw CF block from one IP, R3 saw clean 200 from another. Operator re-verifies from
    // production crawler's IP before changing defensive defaults.
    catalogUrls: [
      '/en/firearms',
      '/en/air-guns',
      '/en/optics',
      '/en/reloading',
    ],
    expectedProductCount: 8332,
    perPage: 80,
    productCountMethod: {
      method: 'generic-product-sitemap',
      url: '/sitemap.xml',
      pattern: '^https://[^/]+/[a-z]{2}/[^/]+/[^/]+$',
    },
    sortParam: '?product_list_order=new',
  },
  'northprosports.com': {
    catalogUrls: [
      '/index.php?route=product/category&path=28',
      '/index.php?route=product/category&path=766',
      '/index.php?route=product/category&path=267',
      '/index.php?route=product/category&path=552',
      '/index.php?route=product/category&path=45',
      '/index.php?route=product/category&path=400',
      '/index.php?route=product/category&path=425',
      '/index.php?route=product/category&path=666',
    ],
    expectedProductCount: 2617,
    productCountMethod: { method: 'stream-page-count' },
    paginationPattern: {
      type: 'query',
      template: 'page',
      perPage: 100,
      startPage: 1,
      firstPageHasParam: false,
      zeroIndexed: false,
    },
  },
  'precisionoptics.net': {
    hasWaf: false,
    perPage: 90,
    productCountMethod: {
      method: 'generic-product-sitemap',
      url: '/sitemap.xml',
      pattern: '_p/[^/]+\\.htm(?:$|[?#])',
    },
    sortParam: 'searching=Y&sort=3',
    expectedProductCount: 6049,
    'catalogUrls.addUrl': '/Outlet_Firearms_Packages_s/1266.htm',
  },
  'reliablegun.com': {
    needsPlaywright: false,
    sortParam: '?orderby=15&pagesize=48',
    expectedProductCount: 5672,
  },
  'lockharttactical.com': {
    hasWaf: false,
    expectedProductCount: 2452,
    perPage: 40,
    paginationPattern: {
      type: 'offset-query',
      template: 'limitstart',
      perPage: 40,
      startPage: 0,
      firstPageHasParam: false,
      zeroIndexed: true,
    },
    productCountMethod: {
      method: 'html-pagination',
      url: '/recent?limit=40&limitstart=0',
      selector: '.hikashop_results_counter',
      regex: 'of\\s+(\\d+)',
      perPage: 1,
    },
  },
  'outfitters.goldnloan.com': {
    hasWaf: false,
    perPage: 80,
    expectedProductCount: 1880,
    productCountMethod: { method: 'stream-page-count' },
    catalogUrls: [
      '/shop/category/firearms-42',
      '/shop/category/ammunition-39',
      '/shop/category/optics-45',
      '/shop/category/accessories-35',
      '/shop/category/archery-131',
      '/shop/category/hunting-86',
      '/shop/category/reloading-supplies-52',
      '/shop/category/air-rifle-171',
      '/shop/category/camping-gear-135',
      '/shop/category/clothing-91',
    ],
  },
  'liangjian.ca': {
    needsPlaywright: false,
    perPage: 500,
    expectedProductCount: 1952,
    productCountMethod: {
      method: 'generic-product-sitemap',
      url: '/sitemap.ols.xml',
      pattern: '[^/?#]+$',
    },
    catalogUrls: ['/shop/ols/products'],
    sortParam: '?sortOption=descend_by_created_at',
    'apiAlternative.sortParam': 'q[descend_by_created_at]=true',
    'paginationPattern.type': 'api-page',
  },
  'surplusherbys.com': {
    platform: 'wix-thunderbolt',
    expectedProductCount: 158,
    productCountMethod: { method: 'sitemap', url: '/store-products-sitemap.xml' },
    'paginationPattern.template': 'page',
  },
  'truenortharms.com': {
    platform: 'bigcommerce-stencil',
    hasWaf: false,
    perPage: 24,
    productCountMethod: { method: 'sitemap-index', urls: ['/xmlsitemap.php?type=products&page=1'] },
    'catalogUrls.removeUrl': '/firearms/ar-15-ar-308/ar-15-parts/muzzle-devices/brakes.html',
    expectedProductCount: 1264,
  },
};

function setNested(obj, dottedKey, value) {
  if (!dottedKey.includes('.')) {
    obj[dottedKey] = value;
    return;
  }
  const parts = dottedKey.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
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

function jsonEq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
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
    if (!site) {
      skipped.push(`${domain}: NOT FOUND in DB`);
      continue;
    }

    const profile = JSON.parse(JSON.stringify(site.siteProfile || {}));
    const diffs = [];

    for (const [key, value] of Object.entries(patches)) {
      if (key === 'catalogUrls.removeUrl') {
        const before = Array.isArray(profile.catalogUrls) ? [...profile.catalogUrls] : [];
        profile.catalogUrls = before.filter(u => !u.includes(value));
        if (before.length !== profile.catalogUrls.length) {
          diffs.push(`catalogUrls: removed URLs containing "${value}" (${before.length} -> ${profile.catalogUrls.length})`);
        }
        continue;
      }
      if (key === 'catalogUrls.addUrl') {
        const before = Array.isArray(profile.catalogUrls) ? [...profile.catalogUrls] : [];
        if (!before.includes(value)) {
          profile.catalogUrls = [...before, value];
          diffs.push(`catalogUrls: added "${value}" (${before.length} -> ${profile.catalogUrls.length})`);
        }
        continue;
      }
      const old = getNested(profile, key);
      if (jsonEq(old, value)) continue;
      setNested(profile, key, value);
      const oldStr = JSON.stringify(old);
      const newStr = JSON.stringify(value);
      const oldShort = oldStr && oldStr.length > 80 ? oldStr.slice(0, 77) + '...' : oldStr;
      const newShort = newStr && newStr.length > 80 ? newStr.slice(0, 77) + '...' : newStr;
      diffs.push(`${key}: ${oldShort} -> ${newShort}`);
    }

    const columnDiffs = [];
    if (Object.prototype.hasOwnProperty.call(patches, 'hasWaf') && site.hasWaf !== patches.hasWaf) {
      columnDiffs.push(`COLUMN hasWaf: ${site.hasWaf} -> ${patches.hasWaf}`);
    }
    if (Object.prototype.hasOwnProperty.call(patches, 'hasCaptcha') && site.hasCaptcha !== patches.hasCaptcha) {
      columnDiffs.push(`COLUMN hasCaptcha: ${site.hasCaptcha} -> ${patches.hasCaptcha}`);
    }

    if (diffs.length === 0 && columnDiffs.length === 0) continue;
    totalDiffs += diffs.length;

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
        console.log(`  WROTE (${diffs.length} JSON field${diffs.length === 1 ? '' : 's'}${columnDiffs.length ? `, ${columnDiffs.length} column${columnDiffs.length === 1 ? '' : 's'}` : ''})`);
      } catch (e) {
        skipped.push(`${domain}: ${e.message}`);
        console.log(`  WRITE FAILED: ${e.message}`);
      }
    }
  }

  console.log('');
  console.log(`Total JSON diffs across ${Object.keys(CORRECTIONS).length} sites: ${totalDiffs}`);
  if (APPLY) {
    console.log(`Sites updated: ${totalWrites}`);
    if (skipped.length) {
      console.log(`Skipped (errors): ${skipped.length}`);
      skipped.forEach(m => console.log('  ' + m));
    }
  } else {
    console.log('(dry-run; pass --apply to commit)');
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
