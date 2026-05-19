// Extension to _apply-batch-3-corrections-2026-05-19.js — covers items missed
// in the first pass after honest re-reading of R4 Part 1 against actual DB state.
// Same dry-run-by-default convention; pass `--apply` to commit.

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

const CORRECTIONS = {
  // budgetshootersupply.ca — R4 specified hasWaf=false (column). Wordfence
  // installed-but-only-fires-on-attack-payloads; crawler URL space unobstructed.
  'budgetshootersupply.ca': {
    hasWaf: false,
  },

  // fishingworldgc.ca — top-level perPage is API perPage for /products.json
  // walk per product-count-probe.ts:276. R4 specified 250. hasWaf=false (col)
  // confirmed by R2's 30-burst test + body scan (passive CF only).
  'fishingworldgc.ca': {
    perPage: 250,
    hasWaf: false,
  },

  // oleysarmoury.com — JWT served site-wide (3 catalog pages return identical
  // byte-for-byte JWT per R2). tokenScrapeUrl='/' more durable than
  // '/firearms/'. hasWaf=false (col) per R2 heavy probe.
  'oleysarmoury.com': {
    'apiAlternative.bigcommerce-graphql.tokenScrapeUrl': '/',
    hasWaf: false,
  },

  // leverarms.com — CRITICAL: paginationPattern.template currently "page/{N}/"
  // (missing leading slash). Per R2 code-simulation: buildPaginatedUrl at
  // catalog-crawler.ts:121-125 strips baseUrl trailing slash then concatenates
  // template raw → produces "gunspage/2/" (404). Correct form "/page/{N}/"
  // → "guns/page/2/" (200). expectedProductCount per 5-method R3 confirmation
  // (instock 351 + onbackorder 6 + outofstock 615 = 972 = wp/v2 admin total).
  // hasWaf=false (col) per R2 + R3 rapid-burst + body scan.
  'leverarms.com': {
    'paginationPattern.template': '/page/{N}/',
    expectedProductCount: 972,
    hasWaf: false,
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

function shortJson(v) {
  const s = JSON.stringify(v);
  if (s === undefined) return 'undefined';
  return s.length > 80 ? s.slice(0, 77) + '...' : s;
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
      if (key === 'hasWaf' || key === 'hasCaptcha') continue;
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
  console.log(`Sites in extension: ${Object.keys(CORRECTIONS).length} | total diffs (JSON+column): ${totalDiffs}`);
  if (APPLY) {
    console.log(`Sites updated: ${totalWrites}`);
    if (skipped.length) {
      console.log(`Skipped: ${skipped.length}`);
      skipped.forEach(m => console.log('  ' + m));
    }
  } else {
    console.log('(dry-run; pass --apply to commit)');
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
