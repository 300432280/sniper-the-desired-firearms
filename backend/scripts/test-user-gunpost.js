/**
 * test-user-gunpost.js
 *
 * Tests ALL 30 keywords against gunpost.ca from a user's perspective.
 * For each keyword: queries ProductIndex, checks data quality, spot-checks URLs.
 * Special deep-check on "mauser 270" comparing Match vs ProductIndex.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');
const https = require('https');
const http = require('http');

const prisma = new PrismaClient();

const KEYWORDS = [
  'SKS', '9mm', '.308', '.22 LR', '7.62x39',
  'Ruger 10/22', 'AR-15', 'tikka t3x', 'GSG-16', 'magazine',
  'shotgun', 'surplus', 'scope', 'Federal', 'FMJ',
  'primer', 'holster', 'Glock 19', '12 gauge', 'used rifle',
  'Savage 110 Ultralite .308', 'Winchester SXP 12ga pump',
  'Vortex Crossfire II 4-12x44', 'CCI Blazer 9mm 115gr FMJ',
  'Remington 870 Express 12 gauge pump shotgun',
  'norinco type 97', 'stripped lower receiver',
  '10 round magazine .223', '$500 rifle',
  'mauser 270 win bolt action',
];

const RATE_LIMIT_MS = 500;

// ── Helpers ──

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** HTTP GET with redirect-follow, returns { status, finalUrl, error } */
function httpGet(url) {
  return new Promise(resolve => {
    const timeout = setTimeout(() => resolve({ status: null, finalUrl: url, error: 'timeout' }), 10000);
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (FirearmAlert test)' } }, res => {
      clearTimeout(timeout);
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve({ status: res.statusCode, finalUrl: res.headers.location, error: null });
      } else {
        resolve({ status: res.statusCode, finalUrl: url, error: null });
      }
      res.resume(); // drain
    });
    req.on('error', err => {
      clearTimeout(timeout);
      resolve({ status: null, finalUrl: url, error: err.message });
    });
  });
}

// ── Main ──

async function main() {
  // 1. Find gunpost site
  const site = await prisma.monitoredSite.findUnique({
    where: { domain: 'gunpost.ca' },
    select: { id: true, domain: true, name: true },
  });

  if (!site) {
    console.error('ERROR: gunpost.ca not found in MonitoredSite table.');
    process.exit(1);
  }
  console.log(`\nSite: ${site.name || site.domain} (id: ${site.id})\n`);

  // Total product count for context
  const totalProducts = await prisma.productIndex.count({
    where: { siteId: site.id, isActive: true },
  });
  console.log(`Total active products in ProductIndex for gunpost.ca: ${totalProducts}\n`);
  console.log('='.repeat(80));

  // Per-keyword results
  const results = [];
  let totalUrlChecks = 0;
  let totalUrlPasses = 0;

  for (const keyword of KEYWORDS) {
    console.log(`\n>> Keyword: "${keyword}"`);

    // Build where clause — for multi-word keywords, require ALL words present
    const words = keyword
      .replace(/\$/g, '')  // strip $ sign
      .split(/\s+/)
      .filter(w => w.length > 0);

    // Use AND of contains for each word
    const whereClause = {
      siteId: site.id,
      isActive: true,
      AND: words.map(w => ({
        title: { contains: w, mode: 'insensitive' },
      })),
    };

    const products = await prisma.productIndex.findMany({
      where: whereClause,
      select: {
        id: true,
        title: true,
        price: true,
        thumbnail: true,
        sourceId: true,
        url: true,
      },
      take: 10,
      orderBy: { lastSeenAt: 'desc' },
    });

    const count = products.length;
    let issues = [];

    // Check data quality
    let noTitle = 0, noPrice = 0, noThumb = 0, noSourceId = 0;
    for (const p of products) {
      if (!p.title || p.title.trim() === '') noTitle++;
      if (p.price === null || p.price === undefined) noPrice++;
      if (!p.thumbnail) noThumb++;
      if (!p.sourceId) noSourceId++;
    }

    if (noTitle > 0) issues.push(`${noTitle} missing title`);
    if (noPrice > 0) issues.push(`${noPrice} missing price (classifieds may omit)`);
    if (noThumb > 0) issues.push(`${noThumb} missing thumbnail`);
    if (noSourceId > 0) issues.push(`${noSourceId} missing sourceId`);

    // Show first few results
    if (count === 0) {
      console.log(`   No results found.`);
      issues.push('ZERO RESULTS');
    } else {
      for (let i = 0; i < Math.min(3, count); i++) {
        const p = products[i];
        console.log(`   ${i + 1}. ${p.title}`);
        console.log(`      Price: ${p.price !== null ? '$' + p.price : 'N/A'} | Thumb: ${p.thumbnail ? 'yes' : 'NO'} | SourceId: ${p.sourceId || 'NO'}`);
      }
      if (count > 3) console.log(`   ... and ${count - 3} more`);
    }

    // URL spot-check (first 2 products)
    const urlResults = [];
    const toCheck = products.slice(0, 2);
    for (const p of toCheck) {
      const result = await httpGet(p.url);
      totalUrlChecks++;
      const ok = result.status === 200 || (result.status >= 300 && result.status < 400);
      if (ok) totalUrlPasses++;
      urlResults.push({ url: p.url, status: result.status, error: result.error, ok });
      if (!ok) {
        console.log(`   URL FAIL: ${p.url} => ${result.status || result.error}`);
        issues.push(`URL ${result.status || result.error}: ${p.url.substring(0, 60)}...`);
      } else {
        console.log(`   URL OK: ${result.status} ${p.url.substring(0, 70)}`);
      }
      await sleep(RATE_LIMIT_MS);
    }

    if (issues.length > 0) {
      console.log(`   Issues: ${issues.join('; ')}`);
    } else {
      console.log(`   All checks passed.`);
    }

    results.push({ keyword, count, issues, noPrice, noThumb, noSourceId, noTitle, urlResults });
  }

  // ── Special: "mauser 270" Match vs ProductIndex comparison ──
  console.log('\n' + '='.repeat(80));
  console.log('\n>> SPECIAL CHECK: "mauser 270" — Match vs ProductIndex comparison\n');

  const mauserSearches = await prisma.search.findMany({
    where: {
      keyword: { contains: 'mauser', mode: 'insensitive' },
      websiteUrl: { contains: 'gunpost' },
    },
    select: { id: true, keyword: true, websiteUrl: true },
  });

  if (mauserSearches.length === 0) {
    console.log('   No searches found for "mauser" on gunpost. Skipping Match comparison.');
  } else {
    for (const search of mauserSearches) {
      console.log(`   Search: "${search.keyword}" => ${search.websiteUrl}`);

      const matches = await prisma.match.findMany({
        where: { searchId: search.id },
        select: {
          id: true,
          title: true,
          price: true,
          url: true,
          productIndexId: true,
          productIndex: {
            select: { id: true, title: true, price: true, url: true, isActive: true },
          },
        },
        orderBy: { foundAt: 'desc' },
        take: 20,
      });

      console.log(`   Total matches: ${matches.length}`);
      let noFk = 0, priceMismatch = 0, titleMismatch = 0;

      for (const m of matches) {
        const hasFK = !!m.productIndexId;
        if (!hasFK) noFk++;

        if (m.productIndex) {
          const pi = m.productIndex;
          const pMatch = m.price !== null ? m.price : null;
          const pIndex = pi.price !== null ? pi.price : null;
          const priceOk = pMatch === pIndex;
          const titleOk = m.title === pi.title;

          if (!priceOk) priceMismatch++;
          if (!titleOk) titleMismatch++;

          console.log(`   ${hasFK ? 'FK' : 'NO-FK'} | Match: "${m.title.substring(0, 50)}" $${m.price || 'N/A'}`);
          if (!priceOk || !titleOk) {
            console.log(`         PI:    "${pi.title.substring(0, 50)}" $${pi.price || 'N/A'} ${pi.isActive ? '' : '(INACTIVE)'}`);
            if (!priceOk) console.log(`         ^^ PRICE MISMATCH`);
            if (!titleOk) console.log(`         ^^ TITLE MISMATCH`);
          }
        } else {
          console.log(`   ${hasFK ? 'FK(dangling)' : 'NO-FK'} | Match: "${m.title.substring(0, 50)}" $${m.price || 'N/A'}`);
        }
      }

      console.log(`\n   Summary: ${noFk} without productIndexId, ${priceMismatch} price mismatches, ${titleMismatch} title mismatches`);
    }
  }

  // ── Overall Report ──
  console.log('\n' + '='.repeat(80));
  console.log('\n========== OVERALL REPORT ==========\n');

  const withResults = results.filter(r => r.count > 0);
  const withoutResults = results.filter(r => r.count === 0);
  const withIssues = results.filter(r => r.issues.length > 0 && r.count > 0);

  console.log(`Keywords tested:       ${results.length}`);
  console.log(`Keywords with results: ${withResults.length}`);
  console.log(`Keywords with 0 hits:  ${withoutResults.length}`);
  console.log(`Keywords with issues:  ${withIssues.length}`);
  console.log(`URL checks:            ${totalUrlChecks} total, ${totalUrlPasses} passed, ${totalUrlChecks - totalUrlPasses} failed`);

  if (withoutResults.length > 0) {
    console.log(`\nZERO-RESULT keywords:`);
    for (const r of withoutResults) {
      console.log(`   - "${r.keyword}"`);
    }
  }

  if (withIssues.length > 0) {
    console.log(`\nKeywords with data issues:`);
    for (const r of withIssues) {
      console.log(`   - "${r.keyword}" (${r.count} results): ${r.issues.join('; ')}`);
    }
  }

  // Aggregate data quality
  const totalMissingPrice = results.reduce((s, r) => s + r.noPrice, 0);
  const totalMissingThumb = results.reduce((s, r) => s + r.noThumb, 0);
  const totalMissingSourceId = results.reduce((s, r) => s + r.noSourceId, 0);
  const totalMissingTitle = results.reduce((s, r) => s + r.noTitle, 0);
  const totalResultsChecked = results.reduce((s, r) => s + r.count, 0);

  console.log(`\nData quality across ${totalResultsChecked} products checked:`);
  console.log(`   Missing title:    ${totalMissingTitle}`);
  console.log(`   Missing price:    ${totalMissingPrice} (classifieds often omit price)`);
  console.log(`   Missing thumbnail:${totalMissingThumb}`);
  console.log(`   Missing sourceId: ${totalMissingSourceId}`);

  console.log('\n' + '='.repeat(80));
  console.log('Done.\n');

  await prisma.$disconnect();
}

main().catch(e => {
  console.error(e);
  prisma.$disconnect();
  process.exit(1);
});
