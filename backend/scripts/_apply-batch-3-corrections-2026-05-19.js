// One-shot: apply siteProfile corrections from the batch-3 R4 synthesis
// (docs/site-audit/2026-05-15-R4-synthesis.md). 10 sites audited 2026-05-13 + 2026-05-15.
//
// Run with `--dry-run` (default) to preview diffs; `--apply` to commit.
// `_DELETE_FIELD_` sentinel removes that nested field from the profile.

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const DELETE_SENTINEL = '_DELETE_FIELD_';

const CORRECTIONS = {
  // shooterschoice.com — fix runtime-broken pagination template; switch verifyMethod
  // off store-api (silent loss-of-signal on 6,877 OOS); fix count from 11411 (stale)
  // to live 11370; relabel wafType (Wordfence behind cf-passive).
  'shooterschoice.com': {
    'paginationPattern.template': '/page/{N}/',
    'crawlers.maintain.verifyMethod': 'json-ld',
    expectedProductCount: 11370,
    wafType: 'wordfence-on-cloudflare-passive',
  },

  // gunpost.ca — only ["field-sold Yes"] avoids the runtime regex false-positive
  // bug (matches both "sold Yes" and "sold No"). wantedDetection array form
  // is silently disabled at runtime (Array.toString coercion in new RegExp);
  // delete the field until product-verifier.ts is fixed and the value is rewritten
  // as a pipe-joined string. Count updated to live walk via 3-method cross-check.
  'gunpost.ca': {
    'classifiedRules.soldDetection': ['field-sold Yes'],
    'classifiedRules.wantedDetection': DELETE_SENTINEL,
    expectedProductCount: 25186,
  },

  // internationalshootingsupplies.com — keep verifyMethod=store-api (operator's
  // explicit 2026-04-03 incident decision). Remove dead crawlers.catalog field
  // (zero runtime consumers, internally inconsistent with adapterType).
  'internationalshootingsupplies.com': {
    'crawlers.catalog': DELETE_SENTINEL,
  },

  // budgetshootersupply.ca — five-method count consensus (WP REST x-wp-total,
  // Store API combined-stock-filter, sitemap union, WP REST id pagination, Store
  // API category-walk dedupe) all return 2809.
  'budgetshootersupply.ca': {
    expectedProductCount: 2809,
  },

  // dantesports.com — Wordfence plugin behind passive CF. perPage=100 verified
  // honored by runtime Store API (woocommerce.ts:293 clamps to min(perPage,100)).
  // NOTE: /en/ prefix in apiEndpoint URLs is decoration only (runtime uses bare
  // origin per WHATWG `new URL().origin`). Script does not auto-strip — operator
  // reviews dantesports's siteProfile manually for any /en/wp- prefix strings.
  'dantesports.com': {
    wafType: 'wordfence-on-cloudflare-passive',
    perPage: 100,
  },

  // fishingworldgc.ca — /collections/all is byte-equivalent global cover
  // (verified zero unique products outside across 3 fresh sub-collections).
  // perPage 24 (verified via div.product-card selector, 1992/24=83 pages exact).
  'fishingworldgc.ca': {
    catalogUrls: ['/collections/all'],
    'paginationPattern.perPage': 24,
  },

  // oleysarmoury.com — JWT TTL decoded from token (eat-iat=172800s=48h),
  // not the 1h default. 48x fewer wasted token re-scrapes.
  'oleysarmoury.com': {
    'apiAlternative.bigcommerce-graphql.tokenCacheTtlMs': 172800000,
  },

  // alsimmonsgunshop.com — no changes (R1 was correct).

  // pavillonchassepeche.ca — no auto-changes. Operator decides FR vs EN canonical
  // crawl path. verifyMethod 'json-ld' is correct (routes to Playwright via
  // worker.ts:769 else branch).

  // leverarms.com — drop crawlers.bootstrap.apiEndpoints (zero runtime consumers
  // confirmed across backend/src + frontend/src + prisma).
  'leverarms.com': {
    'crawlers.bootstrap.apiEndpoints': DELETE_SENTINEL,
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

function deleteNested(obj, dottedKey) {
  if (!dottedKey.includes('.')) {
    if (Object.prototype.hasOwnProperty.call(obj, dottedKey)) {
      delete obj[dottedKey];
      return true;
    }
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
  if (Object.prototype.hasOwnProperty.call(cur, last)) {
    delete cur[last];
    return true;
  }
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

function jsonEq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function shortJson(v) {
  const s = JSON.stringify(v);
  if (s === undefined) return 'undefined';
  return s.length > 80 ? s.slice(0, 77) + '...' : s;
}

// Walk profile recursively, find any string value containing /en/wp- and report it.
// (dantesports.com manual-review aid.)
function findEnPrefixedStrings(obj, path = '') {
  const hits = [];
  if (obj == null) return hits;
  if (typeof obj === 'string') {
    if (obj.includes('/en/wp-') || obj.includes('/en/wp-json')) hits.push({ path, value: obj });
    return hits;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => hits.push(...findEnPrefixedStrings(v, `${path}[${i}]`)));
    return hits;
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      hits.push(...findEnPrefixedStrings(v, path ? `${path}.${k}` : k));
    }
  }
  return hits;
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
      if (value === DELETE_SENTINEL) {
        const before = getNested(profile, key);
        if (before === undefined) continue;
        const deleted = deleteNested(profile, key);
        if (deleted) diffs.push(`${key}: DELETE (was ${shortJson(before)})`);
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

    // Manual-review hint for dantesports /en/ prefix strip
    let reviewNotes = [];
    if (domain === 'dantesports.com') {
      const hits = findEnPrefixedStrings(profile);
      if (hits.length > 0) {
        reviewNotes.push(`MANUAL REVIEW: ${hits.length} string(s) under siteProfile contain "/en/wp-" prefix (decoration only at runtime, operator decides whether to strip):`);
        hits.slice(0, 5).forEach(h => reviewNotes.push(`    ${h.path} = ${shortJson(h.value)}`));
        if (hits.length > 5) reviewNotes.push(`    ... and ${hits.length - 5} more`);
      }
    }

    if (diffs.length === 0 && columnDiffs.length === 0 && reviewNotes.length === 0) continue;
    totalDiffs += diffs.length;

    console.log(`\n=== ${domain} ===`);
    diffs.forEach(d => console.log(`  ${d}`));
    columnDiffs.forEach(d => console.log(`  ${d}`));
    reviewNotes.forEach(n => console.log(`  ${n}`));

    if (APPLY && (diffs.length > 0 || columnDiffs.length > 0)) {
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
  console.log(`Sites in CORRECTIONS: ${Object.keys(CORRECTIONS).length} | total JSON diffs: ${totalDiffs}`);
  if (APPLY) {
    console.log(`Sites updated: ${totalWrites}`);
    if (skipped.length) {
      console.log(`Skipped (errors): ${skipped.length}`);
      skipped.forEach(m => console.log('  ' + m));
    }
  } else {
    console.log('(dry-run; pass --apply to commit. Reminder: alsimmonsgunshop.com + pavillonchassepeche.ca intentionally have no auto-corrections.)');
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
