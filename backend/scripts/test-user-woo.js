/**
 * Test 3 WooCommerce sites from a USER's perspective.
 * For each of 30 keywords × 3 sites:
 *   1. Query ProductIndex WHERE siteId AND isActive AND title ILIKE '%keyword%' (first 10)
 *   2. Validate: title not empty, price not null, thumbnail not null, sourceId not null
 *   3. Fetch first 2 URLs per keyword×site, verify HTTP 200 (rate limit 500ms)
 *   4. Produce per-site per-keyword summary + overall report
 *
 * Usage: node scripts/test-user-woo.js
 */
require('dotenv').config();
const axios = require('axios');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const TIMEOUT = 15000;

const SITES = [
  'alsimmonsgunshop.com',
  'budgetshootersupply.ca',
  'canadafirstammo.ca',
];

const KEYWORDS = [
  'SKS', '9mm', '.308', '.22 LR', '7.62x39',
  'Ruger 10/22', 'AR-15', 'tikka t3x', 'GSG-16', 'magazine',
  'shotgun', 'surplus', 'scope', 'Federal', 'FMJ',
  'primer', 'holster', 'Glock 19', '12 gauge', 'used rifle',
  'Savage 110 Ultralite .308', 'Winchester SXP 12ga pump',
  'Vortex Crossfire II 4-12x44', 'CCI Blazer 9mm 115gr FMJ',
  'Remington 870 Express 12 gauge pump shotgun',
  'norinco type 97', 'stripped lower receiver',
  '10 round magazine .223', '$500 rifle', 'mauser 270 win bolt action',
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  // Resolve site IDs
  const siteRows = await prisma.monitoredSite.findMany({
    where: { domain: { in: SITES } },
    select: { id: true, domain: true },
  });
  const siteMap = {};
  for (const s of siteRows) siteMap[s.domain] = s.id;

  const missingSites = SITES.filter(d => !siteMap[d]);
  if (missingSites.length) {
    console.error('ERROR: Sites not found in MonitoredSite:', missingSites);
    process.exit(1);
  }
  console.log('Sites resolved:', Object.keys(siteMap).join(', '));

  // Overall stats
  const overallReport = {};

  for (const domain of SITES) {
    const siteId = siteMap[domain];
    console.log(`\n${'='.repeat(70)}`);
    console.log(`SITE: ${domain}  (siteId: ${siteId})`);
    console.log('='.repeat(70));

    const siteStats = {
      totalKeywords: KEYWORDS.length,
      keywordsWithResults: 0,
      keywordsWithZeroResults: 0,
      totalProducts: 0,
      missingPrice: 0,
      missingThumbnail: 0,
      missingSourceId: 0,
      emptyTitle: 0,
      urlChecks: 0,
      urlOk: 0,
      urlFail: 0,
      keywordDetails: [],
    };

    for (const keyword of KEYWORDS) {
      // Query ProductIndex with ILIKE
      const products = await prisma.$queryRaw`
        SELECT id, title, price, thumbnail, "sourceId", url, "stockStatus"
        FROM product_index
        WHERE "siteId" = ${siteId}
          AND "isActive" = true
          AND title ILIKE ${'%' + keyword + '%'}
        LIMIT 10
      `;

      const count = products.length;
      const detail = {
        keyword,
        results: count,
        missingPrice: 0,
        missingThumbnail: 0,
        missingSourceId: 0,
        emptyTitle: 0,
        urlResults: [],
      };

      if (count === 0) {
        siteStats.keywordsWithZeroResults++;
        console.log(`  [${keyword}] — 0 results`);
      } else {
        siteStats.keywordsWithResults++;
        siteStats.totalProducts += count;

        for (const p of products) {
          if (!p.title || p.title.trim() === '') {
            detail.emptyTitle++;
            siteStats.emptyTitle++;
          }
          if (p.price === null || p.price === undefined) {
            // canadafirstammo OOS items may lack price — note but still count
            detail.missingPrice++;
            siteStats.missingPrice++;
          }
          if (!p.thumbnail) {
            detail.missingThumbnail++;
            siteStats.missingThumbnail++;
          }
          if (!p.sourceId) {
            detail.missingSourceId++;
            siteStats.missingSourceId++;
          }
        }

        // Check first 2 URLs
        const urlsToCheck = products.slice(0, 2);
        for (const p of urlsToCheck) {
          siteStats.urlChecks++;
          try {
            const resp = await axios.get(p.url, {
              headers: { 'User-Agent': UA },
              timeout: TIMEOUT,
              maxRedirects: 5,
              validateStatus: () => true,
            });
            const ok = resp.status >= 200 && resp.status < 400;
            detail.urlResults.push({ url: p.url, status: resp.status, ok });
            if (ok) siteStats.urlOk++;
            else siteStats.urlFail++;
          } catch (err) {
            detail.urlResults.push({ url: p.url, status: 'ERR', ok: false, error: err.message.slice(0, 80) });
            siteStats.urlFail++;
          }
          await sleep(500);
        }

        // Print keyword summary
        const issues = [];
        if (detail.missingPrice > 0) issues.push(`missingPrice=${detail.missingPrice}`);
        if (detail.missingThumbnail > 0) issues.push(`missingThumb=${detail.missingThumbnail}`);
        if (detail.missingSourceId > 0) issues.push(`missingSourceId=${detail.missingSourceId}`);
        if (detail.emptyTitle > 0) issues.push(`emptyTitle=${detail.emptyTitle}`);
        const urlSummary = detail.urlResults.map(u => `${u.status}${u.ok ? '' : '!'}`).join(', ');
        const issueStr = issues.length ? `  ISSUES: ${issues.join(', ')}` : '';
        console.log(`  [${keyword}] — ${count} results | URLs: [${urlSummary}]${issueStr}`);
      }

      siteStats.keywordDetails.push(detail);
    }

    // Print site summary
    console.log(`\n  --- ${domain} SUMMARY ---`);
    console.log(`  Keywords with results: ${siteStats.keywordsWithResults}/${siteStats.totalKeywords}`);
    console.log(`  Keywords with 0 results: ${siteStats.keywordsWithZeroResults}`);
    console.log(`  Total products returned: ${siteStats.totalProducts}`);
    console.log(`  Missing price: ${siteStats.missingPrice}  |  Missing thumbnail: ${siteStats.missingThumbnail}`);
    console.log(`  Missing sourceId: ${siteStats.missingSourceId}  |  Empty title: ${siteStats.emptyTitle}`);
    console.log(`  URL checks: ${siteStats.urlOk}/${siteStats.urlChecks} OK, ${siteStats.urlFail} failed`);

    overallReport[domain] = siteStats;
  }

  // Overall report
  console.log(`\n${'='.repeat(70)}`);
  console.log('OVERALL REPORT');
  console.log('='.repeat(70));

  let grandProducts = 0, grandMissingPrice = 0, grandMissingThumb = 0;
  let grandMissingSrcId = 0, grandEmptyTitle = 0;
  let grandUrlOk = 0, grandUrlChecks = 0, grandUrlFail = 0;
  let grandKeywordsHit = 0, grandKeywordsMiss = 0;

  for (const domain of SITES) {
    const s = overallReport[domain];
    grandProducts += s.totalProducts;
    grandMissingPrice += s.missingPrice;
    grandMissingThumb += s.missingThumbnail;
    grandMissingSrcId += s.missingSourceId;
    grandEmptyTitle += s.emptyTitle;
    grandUrlOk += s.urlOk;
    grandUrlChecks += s.urlChecks;
    grandUrlFail += s.urlFail;
    grandKeywordsHit += s.keywordsWithResults;
    grandKeywordsMiss += s.keywordsWithZeroResults;
  }

  console.log(`Total keyword×site combos: ${SITES.length * KEYWORDS.length}`);
  console.log(`Combos with results: ${grandKeywordsHit}  |  Combos with 0 results: ${grandKeywordsMiss}`);
  console.log(`Total products returned: ${grandProducts}`);
  console.log(`Missing price: ${grandMissingPrice}  |  Missing thumbnail: ${grandMissingThumb}`);
  console.log(`Missing sourceId: ${grandMissingSrcId}  |  Empty title: ${grandEmptyTitle}`);
  console.log(`URL checks: ${grandUrlOk}/${grandUrlChecks} OK, ${grandUrlFail} failed`);

  // List keywords with 0 results on ALL 3 sites
  const universalMisses = KEYWORDS.filter(kw =>
    SITES.every(d => {
      const det = overallReport[d].keywordDetails.find(x => x.keyword === kw);
      return det && det.results === 0;
    })
  );
  if (universalMisses.length) {
    console.log(`\nKeywords with 0 results on ALL sites (${universalMisses.length}):`);
    universalMisses.forEach(k => console.log(`  - ${k}`));
  }

  // List keywords that have issues on any site
  const issueKeywords = [];
  for (const kw of KEYWORDS) {
    for (const domain of SITES) {
      const det = overallReport[domain].keywordDetails.find(x => x.keyword === kw);
      if (det && det.results > 0) {
        const issues = [];
        if (det.missingPrice > 0) issues.push(`${domain}: missingPrice=${det.missingPrice}`);
        if (det.missingSourceId > 0) issues.push(`${domain}: missingSourceId=${det.missingSourceId}`);
        if (det.urlResults.some(u => !u.ok)) issues.push(`${domain}: URL fail`);
        if (issues.length) issueKeywords.push({ keyword: kw, issues });
      }
    }
  }
  if (issueKeywords.length) {
    console.log(`\nKeyword issues across sites:`);
    for (const ik of issueKeywords) {
      console.log(`  [${ik.keyword}] ${ik.issues.join(' | ')}`);
    }
  }

  await prisma.$disconnect();
  console.log('\nDone.');
}

main().catch(err => {
  console.error('FATAL:', err);
  prisma.$disconnect();
  process.exit(1);
});
