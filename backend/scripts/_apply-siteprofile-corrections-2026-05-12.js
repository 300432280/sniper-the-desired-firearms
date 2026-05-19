// One-shot: apply siteProfile corrections to 11 sites from the 2026-05-11/12 strict verification round.
// Run with `--dry-run` to preview diffs; `--apply` to commit.
// Per-site changes were derived from live walk evidence collected by 11 verification agents.
//
// catalogUrls changes are EXCLUDED from this script for most sites — they require operator review
// of full walk evidence. Only conclusive scalar / object field corrections are applied here.

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

const CORRECTIONS = {
  'sail.ca': {
    hasCaptcha: false, // no CAPTCHA on crawl path — operational
    expectedProductCount: 18944,
    productCountMethod: {
      method: 'sitemap-index',
      urls: [
        '/media/sitemaps/sitemap_sail_en_product_001.xml',
        '/media/sitemaps/sitemap_sail_en_product_002.xml',
      ],
    },
    perPage: 100,
    'paginationPattern.type': 'api-page',
    sortParam: '&sort.created_at=desc',
  },
  'ellwoodepps.com': {
    hasWaf: false, // cf-passive does not actively block — operational definition
    wafType: 'cloudflare-passive',
    perPage: 100,
    productCountMethod: { method: 'generic-product-sitemap', url: '/sitemap.xml' },
  },
  'westernmetal.ca': {
    hasCaptcha: false, // CF7-only reCAPTCHA does not gate crawler — operational
    expectedProductCount: 7381,
  },
  'rangeviewsports.ca': {
    hasCaptcha: false, // CF7-only — operational
    expectedProductCount: 5407,
    perPage: 500, // verified silent cap
  },
  'doubletapsports.com': {
    hasCaptcha: false, // CF7-only — operational
    expectedProductCount: 1855,
    productCountMethod: {
      method: 'wp-rest-header',
      endpoint: '/wp-json/wc/store/v1/products',
      header: 'x-wp-total',
    },
  },
  'groupepronature.ca': {
    hasCaptcha: false, // no CAPTCHA on crawl path — operational
    expectedProductCount: 1509,
    productCountMethod: { method: 'shopify-products-walk' },
  },
  'corwin-arms.com': {
    hasWaf: false, // LiteSpeed ModSecurity is origin-app filter, not CDN WAF
    hasCaptcha: false, // CPFence is admin-login-only, not crawl path
    expectedProductCount: 16,
    productCountMethod: {
      method: 'wp-rest-header',
      endpoint: '/wp-json/wc/store/v1/products',
      header: 'x-wp-total',
    },
    paginationPattern: {
      type: 'path',
      template: '/page/{N}/',
      perPage: 50,
      firstPageHasParam: false,
      startPage: 1,
      zeroIndexed: false,
    },
  },
  'marstar.ca': {
    hasWaf: false, // cf-passive does not actively block — operational
    wafType: 'cloudflare-passive',
    hasCaptcha: false, // reCAPTCHA-v3 is on order-tracking form, not crawl path
    expectedProductCount: 5840,
    perPage: 999, // theme hardcodes 999/page
    paginationPattern: {
      type: 'path',
      template: '/page/{N}/',
      perPage: 999,
      firstPageHasParam: false,
      startPage: 1,
      zeroIndexed: false,
    },
    sortParam: null, // Shoptimizer theme NOOPs ?orderby — counter-control proved
    sortVerified: false,
  },
  'dlaskarms.com': {
    hasCaptcha: false, // no CAPTCHA on crawl path — operational
    expectedProductCount: 241,
    catalogUrls: ['/shop/'], // walk proved /shop/=241 covers 100%
  },
  'triggersandbows.com': {
    hasCaptcha: false, // reCAPTCHA-v3 site-wide via CF7 but Ecwid POST API doesn't trip it — operational
    needsPlaywright: false, // sustained-walk proved plain Node POST works at scale
    expectedProductCount: 4908,
    productCountMethod: {
      method: 'ecwid-storefront-search',
      endpoint: 'https://us-vir2-storefront-api.ecwid.com/storefront/api/v1/92697308/catalog/search',
      field: 'totalProductsCount',
      lang: 'en',
    },
  },
  'fulcrum-outdoors.shoplightspeed.com': {
    hasWaf: false, // cf-passive does not actively block — operational
    wafType: 'cloudflare-passive',
    expectedProductCount: 3651,
    productCountMethod: { method: 'generic-product-sitemap', url: '/sitemap.xml' },
    perPage: 100, // ?limit=100 verified honored; default 12
    'catalogUrls.removeUrl': '/fire-arm-accessories/', // returns 404 today — dead URL
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
      const old = getNested(profile, key);
      if (jsonEq(old, value)) continue;
      setNested(profile, key, value);
      const oldStr = JSON.stringify(old);
      const newStr = JSON.stringify(value);
      const oldShort = oldStr && oldStr.length > 80 ? oldStr.slice(0, 77) + '...' : oldStr;
      const newShort = newStr && newStr.length > 80 ? newStr.slice(0, 77) + '...' : newStr;
      diffs.push(`${key}: ${oldShort} -> ${newShort}`);
    }

    if (diffs.length === 0 && !Object.prototype.hasOwnProperty.call(patches, 'hasWaf') && !Object.prototype.hasOwnProperty.call(patches, 'hasCaptcha')) continue;
    totalDiffs += diffs.length;

    console.log(`\n=== ${domain} ===`);
    diffs.forEach(d => console.log(`  ${d}`));

    // Also report column-vs-JSON drift on hasWaf / hasCaptcha so the operator sees what the column write will do.
    const columnDiffs = [];
    if (Object.prototype.hasOwnProperty.call(patches, 'hasWaf') && site.hasWaf !== patches.hasWaf) {
      columnDiffs.push(`COLUMN hasWaf: ${site.hasWaf} -> ${patches.hasWaf}`);
    }
    if (Object.prototype.hasOwnProperty.call(patches, 'hasCaptcha') && site.hasCaptcha !== patches.hasCaptcha) {
      columnDiffs.push(`COLUMN hasCaptcha: ${site.hasCaptcha} -> ${patches.hasCaptcha}`);
    }
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
  console.log(`Total diffs across ${Object.keys(CORRECTIONS).length} sites: ${totalDiffs}`);
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
