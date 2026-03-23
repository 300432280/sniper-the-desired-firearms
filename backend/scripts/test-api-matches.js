/**
 * test-api-matches.js
 *
 * Comprehensive API data quality test for sourceId-based enrichment.
 * Tests ProductIndex data quality across 7 sites, validates Match->ProductIndex
 * FK integrity, and detects stale match snapshots.
 *
 * Usage: cd backend && node scripts/test-api-matches.js
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ── Config ──────────────────────────────────────────────────────────────────

const TARGET_SITES = [
  'aagcanada.ca',
  'alflahertys.com',
  'alsimmonsgunshop.com',
  'budgetshootersupply.ca',
  'bullseyenorth.com',
  'canadafirstammo.ca',
  'gunpost.ca',
];

const TEST_KEYWORDS = [
  'SKS',
  '9mm',
  '.308',
  'Ruger 10/22',
  'AR-15',
  'magazine',
  'shotgun',
  'Federal',
  'scope',
  'tikka t3x',
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function pct(n, total) {
  if (total === 0) return 'N/A';
  return ((n / total) * 100).toFixed(1) + '%';
}

function divider(label) {
  console.log('\n' + '='.repeat(70));
  console.log(`  ${label}`);
  console.log('='.repeat(70));
}

// ── Phase 1: Keyword x Site ProductIndex quality ────────────────────────────

async function testKeywordSiteMatrix(siteMap) {
  divider('PHASE 1: Keyword x Site ProductIndex Quality');

  // Per-site accumulators
  const siteStats = {};
  for (const domain of TARGET_SITES) {
    siteStats[domain] = {
      totalResults: 0,
      keywordsWithHits: 0,
      sourceIdCount: 0,
      priceCount: 0,
      thumbnailCount: 0,
      stockStatusCount: 0,
      badTitles: [],
    };
  }

  for (const domain of TARGET_SITES) {
    const site = siteMap[domain];
    if (!site) {
      console.log(`\n  [SKIP] ${domain} — not found in MonitoredSite table`);
      continue;
    }

    console.log(`\n  --- ${domain} (siteId: ${site.id.slice(0, 8)}...) ---`);

    for (const kw of TEST_KEYWORDS) {
      const products = await prisma.productIndex.findMany({
        where: {
          siteId: site.id,
          isActive: true,
          title: { contains: kw, mode: 'insensitive' },
        },
        select: {
          id: true,
          title: true,
          price: true,
          sourceId: true,
          thumbnail: true,
          stockStatus: true,
          url: true,
        },
        take: 50,
      });

      const count = products.length;
      if (count > 0) siteStats[domain].keywordsWithHits++;
      siteStats[domain].totalResults += count;

      for (const p of products) {
        if (p.sourceId) siteStats[domain].sourceIdCount++;
        if (p.price != null) siteStats[domain].priceCount++;
        if (p.thumbnail) siteStats[domain].thumbnailCount++;
        if (p.stockStatus) siteStats[domain].stockStatusCount++;

        // Title quality checks
        const t = p.title;
        const isBad =
          t.length < 5 ||
          t.length > 300 ||
          t.startsWith('http') ||
          t.includes('<!') ||
          /^[A-Z0-9\-_]+$/.test(t); // looks like a slug/SKU only
        if (isBad) {
          siteStats[domain].badTitles.push({ title: t, url: p.url });
        }
      }

      if (count > 0) {
        const srcPct = pct(products.filter(p => p.sourceId).length, count);
        console.log(`    "${kw}" => ${count} results (sourceId: ${srcPct})`);
      }
    }
  }

  return siteStats;
}

// ── Phase 2: gunpost.ca "mauser 270" Match analysis ────────────────────────

async function testGunpostMauserMatches(siteMap) {
  divider('PHASE 2: gunpost.ca "mauser 270" Match Analysis');

  const searches = await prisma.search.findMany({
    where: {
      keyword: { contains: 'mauser 270', mode: 'insensitive' },
      websiteUrl: { contains: 'gunpost' },
    },
    select: { id: true, keyword: true, websiteUrl: true },
  });

  if (searches.length === 0) {
    console.log('  No searches found for "mauser 270" on gunpost.');
    console.log('  (This is expected if no user has that alert configured.)');
    return { matchCount: 0, withPiId: 0, staleMatches: [] };
  }

  console.log(`  Found ${searches.length} search(es) for "mauser 270" on gunpost:\n`);

  let matchCount = 0;
  let withPiId = 0;
  const staleMatches = [];

  for (const search of searches) {
    const matches = await prisma.match.findMany({
      where: { searchId: search.id },
      select: {
        id: true,
        title: true,
        price: true,
        url: true,
        productIndexId: true,
        foundAt: true,
      },
      orderBy: { foundAt: 'desc' },
    });

    console.log(`  Search "${search.keyword}" => ${matches.length} matches`);
    matchCount += matches.length;

    for (const m of matches) {
      const hasPi = !!m.productIndexId;
      if (hasPi) withPiId++;
      console.log(`    ${hasPi ? '[FK]' : '[--]'} ${m.title}`);
      console.log(`         Price: $${m.price ?? 'null'} | URL: ${m.url}`);
    }
  }

  console.log(`\n  Summary: ${matchCount} matches, ${withPiId} have productIndexId`);
  return { matchCount, withPiId, staleMatches };
}

// ── Phase 3: Stale snapshot detection (Match vs ProductIndex) ──────────────

async function testStaleSnapshots() {
  divider('PHASE 3: Stale Snapshot Detection (Match vs ProductIndex)');

  // Find all matches that have a productIndexId set
  const matchesWithPi = await prisma.match.findMany({
    where: { productIndexId: { not: null } },
    select: {
      id: true,
      title: true,
      price: true,
      url: true,
      productIndexId: true,
      foundAt: true,
      search: { select: { keyword: true, websiteUrl: true } },
    },
    take: 500, // cap for performance
  });

  console.log(`  Total matches with productIndexId: ${matchesWithPi.length}`);

  if (matchesWithPi.length === 0) {
    console.log('  No matches have productIndexId set yet — FK enrichment may not be deployed.');
    return { total: 0, staleTitle: 0, stalePrice: 0, staleUrl: 0, examples: [] };
  }

  // Batch-fetch all referenced ProductIndex rows
  const piIds = [...new Set(matchesWithPi.map(m => m.productIndexId))];
  const piRows = await prisma.productIndex.findMany({
    where: { id: { in: piIds } },
    select: { id: true, title: true, price: true, url: true },
  });
  const piMap = Object.fromEntries(piRows.map(p => [p.id, p]));

  let staleTitle = 0;
  let stalePrice = 0;
  let staleUrl = 0;
  const examples = [];

  for (const m of matchesWithPi) {
    const pi = piMap[m.productIndexId];
    if (!pi) continue; // ProductIndex row was deleted

    const titleDiff = m.title !== pi.title;
    const priceDiff = m.price !== pi.price;
    const urlDiff = m.url !== pi.url;

    if (titleDiff) staleTitle++;
    if (priceDiff) stalePrice++;
    if (urlDiff) staleUrl++;

    if ((titleDiff || priceDiff || urlDiff) && examples.length < 10) {
      examples.push({
        matchId: m.id.slice(0, 8),
        keyword: m.search.keyword,
        site: m.search.websiteUrl,
        diffs: {
          ...(titleDiff ? { title: { match: m.title, pi: pi.title } } : {}),
          ...(priceDiff ? { price: { match: m.price, pi: pi.price } } : {}),
          ...(urlDiff ? { url: { match: m.url, pi: pi.url } } : {}),
        },
      });
    }
  }

  console.log(`  Stale titles: ${staleTitle}/${matchesWithPi.length}`);
  console.log(`  Stale prices: ${stalePrice}/${matchesWithPi.length}`);
  console.log(`  Stale URLs:   ${staleUrl}/${matchesWithPi.length}`);

  if (examples.length > 0) {
    console.log(`\n  First ${examples.length} stale examples:`);
    for (const ex of examples) {
      console.log(`\n    Match ${ex.matchId}... | keyword: "${ex.keyword}" | site: ${ex.site}`);
      for (const [field, vals] of Object.entries(ex.diffs)) {
        console.log(`      ${field}:`);
        console.log(`        Match:        ${vals.match}`);
        console.log(`        ProductIndex: ${vals.pi}`);
      }
    }
  }

  return { total: matchesWithPi.length, staleTitle, stalePrice, staleUrl, examples };
}

// ── Phase 4: Summary report ────────────────────────────────────────────────

function printSummaryReport(siteStats, gunpostResult, staleResult) {
  divider('SUMMARY REPORT');

  // Per-site table
  console.log('\n  Per-Site Data Quality:\n');
  console.log(
    '  ' +
      'Site'.padEnd(30) +
      'Results'.padEnd(10) +
      'KW Hits'.padEnd(10) +
      'sourceId%'.padEnd(12) +
      'Price%'.padEnd(10) +
      'Thumb%'.padEnd(10) +
      'BadTitles'
  );
  console.log('  ' + '-'.repeat(92));

  let totalResults = 0;
  let totalSourceId = 0;
  let totalPrice = 0;
  let totalThumb = 0;
  let totalBadTitles = 0;
  let anyFail = false;

  for (const domain of TARGET_SITES) {
    const s = siteStats[domain];
    totalResults += s.totalResults;
    totalSourceId += s.sourceIdCount;
    totalPrice += s.priceCount;
    totalThumb += s.thumbnailCount;
    totalBadTitles += s.badTitles.length;

    console.log(
      '  ' +
        domain.padEnd(30) +
        String(s.totalResults).padEnd(10) +
        `${s.keywordsWithHits}/${TEST_KEYWORDS.length}`.padEnd(10) +
        pct(s.sourceIdCount, s.totalResults).padEnd(12) +
        pct(s.priceCount, s.totalResults).padEnd(10) +
        pct(s.thumbnailCount, s.totalResults).padEnd(10) +
        String(s.badTitles.length)
    );

    // Flag sites with zero results or very low sourceId coverage
    if (s.totalResults === 0) {
      console.log(`    ^ WARNING: Zero results across all keywords!`);
      anyFail = true;
    }
  }

  console.log('  ' + '-'.repeat(92));
  console.log(
    '  ' +
      'TOTAL'.padEnd(30) +
      String(totalResults).padEnd(10) +
      ''.padEnd(10) +
      pct(totalSourceId, totalResults).padEnd(12) +
      pct(totalPrice, totalResults).padEnd(10) +
      pct(totalThumb, totalResults).padEnd(10) +
      String(totalBadTitles)
  );

  // Bad title examples
  if (totalBadTitles > 0) {
    console.log(`\n  Bad title examples (first 5):`);
    let shown = 0;
    for (const domain of TARGET_SITES) {
      for (const bt of siteStats[domain].badTitles) {
        if (shown >= 5) break;
        console.log(`    [${domain}] "${bt.title}" => ${bt.url}`);
        shown++;
      }
    }
  }

  // Gunpost mauser 270 summary
  console.log(`\n  Gunpost "mauser 270":`);
  console.log(`    Matches: ${gunpostResult.matchCount}`);
  console.log(`    With productIndexId: ${gunpostResult.withPiId}`);
  console.log(`    FK coverage: ${pct(gunpostResult.withPiId, gunpostResult.matchCount)}`);

  // Stale snapshot summary
  console.log(`\n  Stale Snapshots (Match vs ProductIndex):`);
  console.log(`    Matches with FK: ${staleResult.total}`);
  console.log(`    Stale titles: ${staleResult.staleTitle}`);
  console.log(`    Stale prices: ${staleResult.stalePrice}`);
  console.log(`    Stale URLs:   ${staleResult.staleUrl}`);

  // Verdict
  console.log('\n');
  divider('VERDICT');

  const issues = [];

  if (totalResults === 0) issues.push('CRITICAL: Zero ProductIndex results across all sites');
  if (totalSourceId === 0 && totalResults > 0)
    issues.push('CRITICAL: Zero sourceId values — backfill may not have run');

  const sourceIdPct = totalResults > 0 ? (totalSourceId / totalResults) * 100 : 0;
  if (sourceIdPct > 0 && sourceIdPct < 50)
    issues.push(`WARNING: Low sourceId coverage (${sourceIdPct.toFixed(1)}%)`);

  const pricePct = totalResults > 0 ? (totalPrice / totalResults) * 100 : 0;
  if (pricePct < 50 && totalResults > 0)
    issues.push(`WARNING: Low price coverage (${pricePct.toFixed(1)}%)`);

  if (totalBadTitles > 5)
    issues.push(`WARNING: ${totalBadTitles} bad titles detected (truncated/slug/HTML)`);

  if (staleResult.staleTitle > 10)
    issues.push(`INFO: ${staleResult.staleTitle} stale title snapshots — FK enrichment will fix on next serve`);
  if (staleResult.stalePrice > 10)
    issues.push(`INFO: ${staleResult.stalePrice} stale price snapshots — FK enrichment will fix on next serve`);

  for (const domain of TARGET_SITES) {
    if (siteStats[domain].totalResults === 0)
      issues.push(`FAIL: ${domain} returned zero results for all keywords`);
  }

  if (issues.length === 0) {
    console.log('\n  STATUS: PASS');
    console.log('  All sites have product data. sourceId, price, and thumbnail coverage looks healthy.');
  } else {
    const hasCritical = issues.some(i => i.startsWith('CRITICAL'));
    const hasFail = issues.some(i => i.startsWith('FAIL'));
    console.log(`\n  STATUS: ${hasCritical || hasFail ? 'FAIL' : 'PASS WITH WARNINGS'}`);
    console.log('  Issues:');
    for (const issue of issues) {
      console.log(`    - ${issue}`);
    }
  }

  console.log('\n' + '='.repeat(70) + '\n');
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('FirearmAlert API Match & Enrichment Test');
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Sites: ${TARGET_SITES.length} | Keywords: ${TEST_KEYWORDS.length}`);

  // Resolve site domains to IDs
  const sites = await prisma.monitoredSite.findMany({
    where: { domain: { in: TARGET_SITES } },
    select: { id: true, domain: true, name: true, siteType: true, isEnabled: true },
  });

  const siteMap = {};
  for (const s of sites) {
    siteMap[s.domain] = s;
  }

  console.log(`\nResolved ${sites.length}/${TARGET_SITES.length} sites from MonitoredSite table:`);
  for (const domain of TARGET_SITES) {
    const s = siteMap[domain];
    if (s) {
      console.log(`  [OK] ${domain} (${s.siteType}, enabled=${s.isEnabled})`);
    } else {
      console.log(`  [MISSING] ${domain}`);
    }
  }

  // Phase 1
  const siteStats = await testKeywordSiteMatrix(siteMap);

  // Phase 2
  const gunpostResult = await testGunpostMauserMatches(siteMap);

  // Phase 3
  const staleResult = await testStaleSnapshots();

  // Phase 4
  printSummaryReport(siteStats, gunpostResult, staleResult);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('Test script failed:', e);
  await prisma.$disconnect();
  process.exit(1);
});
