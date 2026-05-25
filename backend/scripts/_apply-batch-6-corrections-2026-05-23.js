// Batch-6 R4 corrections (2026-05-23 audit, 3 sites).
// Default dry-run; pass --apply to commit.
//
// basspro.ca: platform misclassified (IBM/HCL WebSphere Commerce). LEAVE
//   catalogUrls/perPage/paginationPattern/sortParam UNTOUCHED (untested-by-Akamai).
// townpost.ca: many DB fields wrong (perPage, pinnedAds, expectedProductCount,
//   lastPage). Adapter stays `generic` (DB correct); runtime gap fixed in
//   parallel via generic.ts selector port.
// www.gobles.ca: DB's 9-parent spine returns 0 products at runtime → 16% catalog
//   loss. Replace with R3-refined 84-URL list. Flip hasWaf (column+JSON).

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const DELETE_SENTINEL = '_DELETE_FIELD_';

const GOBLES_CATALOG_URLS = [
  'https://www.gobles.ca/firearms/adler/',
  'https://www.gobles.ca/firearms/anschutz/',
  'https://www.gobles.ca/firearms/benelli/',
  'https://www.gobles.ca/firearms/beretta/',
  'https://www.gobles.ca/firearms/black-creek-labs/',
  'https://www.gobles.ca/firearms/browning/',
  'https://www.gobles.ca/firearms/cadex/',
  'https://www.gobles.ca/firearms/caesar-guerini/',
  'https://www.gobles.ca/firearms/canuck/',
  'https://www.gobles.ca/firearms/charles-daly/',
  'https://www.gobles.ca/firearms/chiappa/',
  'https://www.gobles.ca/firearms/churchill/',
  'https://www.gobles.ca/firearms/cva/',
  'https://www.gobles.ca/firearms/cz/',
  'https://www.gobles.ca/firearms/derya/',
  'https://www.gobles.ca/firearms/diana/',
  'https://www.gobles.ca/firearms/federation-firearms/',
  'https://www.gobles.ca/firearms/franchi/',
  'https://www.gobles.ca/firearms/gamo/',
  'https://www.gobles.ca/firearms/gsg/',
  'https://www.gobles.ca/firearms/henry/',
  'https://www.gobles.ca/firearms/iga-stoeger/',
  'https://www.gobles.ca/firearms/kriss/',
  'https://www.gobles.ca/firearms/left-hand-firearms/',
  'https://www.gobles.ca/firearms/lever-action/',
  'https://www.gobles.ca/firearms/marlin/',
  'https://www.gobles.ca/firearms/mossberg/',
  'https://www.gobles.ca/firearms/muzzleloading-rifles/',
  'https://www.gobles.ca/firearms/norinco/',
  'https://www.gobles.ca/firearms/pellet-pal-needed/',
  'https://www.gobles.ca/firearms/remington/',
  'https://www.gobles.ca/firearms/ruger/',
  'https://www.gobles.ca/firearms/sako/',
  'https://www.gobles.ca/firearms/savage-stevens/',
  'https://www.gobles.ca/firearms/smith-wesson/',
  'https://www.gobles.ca/firearms/surplus/',
  'https://www.gobles.ca/firearms/thompson-center/',
  'https://www.gobles.ca/firearms/tikka/',
  'https://www.gobles.ca/firearms/traditions/',
  'https://www.gobles.ca/firearms/troy/',
  'https://www.gobles.ca/firearms/weatherby/',
  'https://www.gobles.ca/firearms/winchester/',
  'https://www.gobles.ca/firearms/zastava/',
  'https://www.gobles.ca/firearms/centerfire-rifles/bolt-action/',
  'https://www.gobles.ca/firearms/centerfire-rifles/break-action/',
  'https://www.gobles.ca/firearms/centerfire-rifles/lever-action/',
  'https://www.gobles.ca/firearms/centerfire-rifles/semi-auto/',
  'https://www.gobles.ca/firearms/combination/rimfire-shotgun/',
  'https://www.gobles.ca/firearms/rimfire-rifles/bolt-action/',
  'https://www.gobles.ca/firearms/rimfire-rifles/break-action/',
  'https://www.gobles.ca/firearms/rimfire-rifles/lever-action/',
  'https://www.gobles.ca/firearms/rimfire-rifles/semi-auto/',
  'https://www.gobles.ca/firearms/shotguns/bolt-action/',
  'https://www.gobles.ca/firearms/shotguns/break-action/',
  'https://www.gobles.ca/firearms/shotguns/pump-action/',
  'https://www.gobles.ca/firearms/shotguns/revolver-action/',
  'https://www.gobles.ca/firearms/shotguns/semi-auto/',
  'https://www.gobles.ca/ammunition/',
  'https://www.gobles.ca/accessories/',
  'https://www.gobles.ca/optics/',
  'https://www.gobles.ca/reloading/',
  'https://www.gobles.ca/field-gear/',
  'https://www.gobles.ca/maintenance-storage/',
  'https://www.gobles.ca/excalibur-archery/',
  'https://www.gobles.ca/knives/boker-4908434/',
  'https://www.gobles.ca/knives/browning-4908428/',
  'https://www.gobles.ca/knives/buck/',
  'https://www.gobles.ca/knives/camillus/',
  'https://www.gobles.ca/knives/cold-steel/',
  'https://www.gobles.ca/knives/crkt/',
  'https://www.gobles.ca/knives/grohmann/',
  'https://www.gobles.ca/knives/ka-bar/',
  'https://www.gobles.ca/knives/kershaw/',
  'https://www.gobles.ca/knives/lansky/',
  'https://www.gobles.ca/knives/leatherman/',
  'https://www.gobles.ca/knives/miscellaneous/',
  'https://www.gobles.ca/knives/morakniv/',
  'https://www.gobles.ca/knives/old-timer/',
  'https://www.gobles.ca/knives/outdoor-edge/',
  'https://www.gobles.ca/knives/remington/',
  'https://www.gobles.ca/knives/spyderco/',
  'https://www.gobles.ca/knives/uncle-henry/',
  'https://www.gobles.ca/knives/victorinox/',
  'https://www.gobles.ca/knives/zero-tolerance/',
];

const CORRECTIONS = {
  'basspro.ca': {
    platform: 'ibm-websphere-commerce',
    wafType: 'akamai',
    expectedProductCount: 16543,
    productCountMethod: {
      method: 'generic-product-sitemap',
      url: '/webapp/wcs/stores/servlet/sitemap_10151.xml.gz',
      pattern: '/p/[a-z0-9-]+',
    },
    searchUrl: '/webapp/wcs/stores/servlet/SearchDisplay?storeId=10151&catalogId=10052&langId=-1&searchTerm={keyword}',
    'crawlers.watermark.method': 'full-catalog-sweep',
    'crawlers.watermark.reason': 'Akamai Bot Manager blocks paginated /l/ category fetches from non-production IPs; no exposed JSON product-list API. Sitemap walk via .gz fetch is the only complete-catalog discovery path.',
  },

  'townpost.ca': {
    platform: 'nextjs-custom-classifieds',
    expectedProductCount: 8889,
    expectedProductCountSource: 'pagination-walk',
    productCountMethod: {
      method: 'html-pagination',
      selector: 'a[href*="/marketplace/"]',
      perPage: 21,
      totalPages: 424,
      lastPagePartial: 6,
    },
    perPage: 21,
    pinnedAds: 0,
    sortParam: null,
    sortVerified: false,
    sortNote: 'Default sort is bump/renew date NOT creation date. R2: ?sort=newest, ?sort=date, ?orderBy=date, ?order=newest, ?sort=oldest ALL return identical results (sort UI is client-side). Within-page IDs NOT monotonic. Watermark must track URL/activity, NOT numeric-ID-descent.',
    paginationPattern: {
      type: 'query',
      template: 'page',
      perPage: 21,
      firstPageHasParam: false,
      startPage: 1,
      zeroIndexed: false,
      wrapBehavior: 'page>=425 silently returns page-1 content (max_id=1171326, byte-identical). Crawler must stop at lastPage=424 or detect wrap by content fingerprint.',
    },
    searchUrl: '/search?q={keyword}',
    searchUrlVerified: true,
    'crawlers.watermark.method': 'navigate-from-watermark',
    'crawlers.watermark.reason': 'Page 1 = newest (bump-date). No explicit sort param. Watermark must track URL/lastSeenAt, NOT numeric-ID descent.',
    classifiedRules: {
      soldDetection: ['Sold ~', '<title>Sold '],
      soldDetectionConfidence: 'low',
      soldDetectionNote: 'R1 speculative; not re-verified in R2/R3. Confirm against a known-sold listing before relying.',
    },
    productUrlSchemes: {
      canonical: '/marketplace/<city>/<urlCategory>/<slug>/<numericId>',
      joinOn: 'numeric-id-suffix',
    },
  },

  'www.gobles.ca': {
    hasWaf: false,
    'siteProfile.hasWaf': false,
    platform: 'lightspeed-ecom',
    expectedProductCount: 3770,
    productCountMethod: {
      method: 'generic-product-sitemap',
      url: '/sitemap.xml',
      pattern: '\\.html$',
    },
    catalogUrls: GOBLES_CATALOG_URLS,
    perPage: 100,
    sortParam: '?sort=newest',
    paginationPattern: {
      type: 'suffix-replace',
      template: 'pageN.html?sort=newest',
      perPage: 100,
      firstPageHasParam: false,
      startPage: 1,
      zeroIndexed: false,
    },
    searchUrl: '/search?q={keyword}',
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

    for (const [key, value] of Object.entries(patches)) {
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
