// Batch-4 validation follow-up fixes (2026-05-19 Phase 4).
// Fixes 2 issues surfaced by Phase 4 validation:
//   1. siteProfile.hasWaf JSON field drifts from DB column for 4 sites
//      (alflahertys, canadafirstammo, nordicmarksman, wolverinesupplies).
//      The Phase 2 correction script only flipped the DB column; runtime
//      code paths (generic-retail.ts:363, catalog-crawler.ts:293) read the
//      embedded siteProfile.hasWaf — so the column flip alone was partially
//      cosmetic. This script flips the embedded JSON value to match.
//   2. hical.ca has no `crawlers.maintain` block at all. C6 (the new
//      profile-validator required check on `crawlers.maintain.verifyMethod`)
//      would reject this profile on re-promote, and runtime worker.ts:769-772
//      logs `MISSING verifyMethod ...` and silently no-ops the verify worker.
//      Per R2's verifyMethodPolicy, operator's choice is 'store-api' — add it.
//
// Default dry-run; pass --apply to commit.

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

const CORRECTIONS = {
  // hasWaf JSON-field drift fixes — these all had column flipped to false in
  // Phase 2 but the JSON field stayed true.
  'alflahertys.com':       { hasWaf: false },
  'canadafirstammo.ca':    { hasWaf: false },
  'nordicmarksman.com':    { hasWaf: false },
  'wolverinesupplies.com': { hasWaf: false },

  // hical.ca — add the missing crawlers.maintain block. Operator's R2-documented
  // intent is 'store-api' (DB precedent + WC Store API standalone path applies).
  // verifyEndpoint follows the WC platform default per worker.ts and adapters.
  'hical.ca': {
    'crawlers.maintain.verifyMethod': 'store-api',
    'crawlers.maintain.verifyEndpoint': '/wp-json/wc/store/v1/products',
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
      select: { id: true, domain: true, siteProfile: true },
    });
    if (!site) { skipped.push(`${domain}: NOT FOUND in DB`); continue; }

    const profile = JSON.parse(JSON.stringify(site.siteProfile || {}));
    const diffs = [];

    for (const [key, value] of Object.entries(patches)) {
      const old = getNested(profile, key);
      if (jsonEq(old, value)) continue;
      setNested(profile, key, value);
      diffs.push(`${key}: ${shortJson(old)} -> ${shortJson(value)}`);
    }

    if (diffs.length === 0) continue;
    totalDiffs += diffs.length;

    console.log(`\n=== ${domain} ===`);
    diffs.forEach(d => console.log(`  ${d}`));

    if (APPLY) {
      try {
        await prisma.monitoredSite.update({ where: { id: site.id }, data: { siteProfile: profile } });
        totalWrites++;
        console.log(`  WROTE (${diffs.length} JSON fields)`);
      } catch (e) {
        skipped.push(`${domain}: ${e.message}`);
        console.log(`  WRITE FAILED: ${e.message}`);
      }
    }
  }

  console.log('');
  console.log(`Sites in CORRECTIONS: ${Object.keys(CORRECTIONS).length} | total JSON diffs: ${totalDiffs}`);
  if (APPLY) {
    console.log(`Sites updated: ${totalWrites}`);
    if (skipped.length) { console.log(`Skipped: ${skipped.length}`); skipped.forEach(m => console.log('  ' + m)); }
  } else {
    console.log('(dry-run; pass --apply to commit)');
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
