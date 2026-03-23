require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
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
  '10 round magazine .223', '$500 rifle', 'mauser 270 win bolt action'
];

const RATE_LIMIT_MS = 500;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function checkUrl(url) {
  try {
    const resp = await axios.get(url, {
      timeout: 10000,
      maxRedirects: 5,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      validateStatus: s => s < 400 // accept 2xx and 3xx
    });
    return { status: resp.status, ok: true };
  } catch (err) {
    const status = err.response?.status || 0;
    return { status, ok: false, error: err.message };
  }
}

async function main() {
  // 1. Find AAG site
  const site = await prisma.monitoredSite.findFirst({
    where: { domain: 'aagcanada.ca' }
  });
  if (!site) {
    console.error('ERROR: aagcanada.ca not found in MonitoredSite');
    process.exit(1);
  }
  console.log(`Site: ${site.name} (${site.id}), siteType=${site.siteType}, adapter=${site.adapterType}`);

  // Total active products for context
  const totalActive = await prisma.productIndex.count({
    where: { siteId: site.id, isActive: true }
  });
  console.log(`Total active products in index: ${totalActive}\n`);

  const results = [];
  let totalProducts = 0;
  let totalMissingPrice = 0;
  let totalMissingThumb = 0;
  let totalMissingSourceId = 0;
  let totalMissingTitle = 0;
  let totalUrlChecks = 0;
  let totalUrlOk = 0;
  let totalUrlFail = 0;
  let keywordsWithZero = [];

  for (const keyword of KEYWORDS) {
    // Query with ILIKE
    const products = await prisma.$queryRaw`
      SELECT id, title, price, "regularPrice", thumbnail, "sourceId", url, "stockStatus"
      FROM product_index
      WHERE "siteId" = ${site.id}
        AND "isActive" = true
        AND title ILIKE ${'%' + keyword + '%'}
      LIMIT 10
    `;

    const count = products.length;
    const missingPrice = products.filter(p => p.price == null).length;
    const missingThumb = products.filter(p => p.thumbnail == null).length;
    const missingSourceId = products.filter(p => p.sourceId == null || p.sourceId === '').length;
    const missingTitle = products.filter(p => !p.title || p.title.trim() === '').length;

    totalProducts += count;
    totalMissingPrice += missingPrice;
    totalMissingThumb += missingThumb;
    totalMissingSourceId += missingSourceId;
    totalMissingTitle += missingTitle;

    // URL checks for first 2 results
    const urlResults = [];
    const toCheck = products.slice(0, 2);
    for (const p of toCheck) {
      const res = await checkUrl(p.url);
      urlResults.push({ url: p.url, ...res });
      totalUrlChecks++;
      if (res.ok) totalUrlOk++;
      else totalUrlFail++;
      await sleep(RATE_LIMIT_MS);
    }

    if (count === 0) keywordsWithZero.push(keyword);

    // Per-keyword summary
    const issues = [];
    if (count === 0) issues.push('NO RESULTS');
    if (missingPrice > 0) issues.push(`${missingPrice} missing price`);
    if (missingThumb > 0) issues.push(`${missingThumb} missing thumbnail`);
    if (missingSourceId > 0) issues.push(`${missingSourceId} missing sourceId`);
    if (missingTitle > 0) issues.push(`${missingTitle} empty title`);
    const failedUrls = urlResults.filter(u => !u.ok);
    if (failedUrls.length > 0) issues.push(`${failedUrls.length} URL(s) returned error`);

    const status = issues.length === 0 ? 'PASS' : (count === 0 ? 'MISS' : 'WARN');
    const tag = status === 'PASS' ? '[PASS]' : status === 'MISS' ? '[MISS]' : '[WARN]';

    console.log(`${tag} "${keyword}" — ${count} results${issues.length ? ' | ' + issues.join(', ') : ''}`);

    // Show sample products if any
    if (count > 0 && count <= 3) {
      products.forEach(p => {
        console.log(`       ${p.title.substring(0, 70)} | $${p.price ?? 'NULL'} | src=${p.sourceId ? 'Y' : 'N'} | thumb=${p.thumbnail ? 'Y' : 'N'}`);
      });
    }

    // Show URL check details for failures
    for (const u of failedUrls) {
      console.log(`       URL FAIL (${u.status}): ${u.url} — ${u.error}`);
    }

    results.push({ keyword, count, missingPrice, missingThumb, missingSourceId, missingTitle, urlResults, status });
  }

  // ============ OVERALL REPORT ============
  console.log('\n' + '='.repeat(70));
  console.log('OVERALL REPORT — aagcanada.ca (Shopify)');
  console.log('='.repeat(70));
  console.log(`Total keywords tested: ${KEYWORDS.length}`);
  console.log(`Keywords with results: ${KEYWORDS.length - keywordsWithZero.length}`);
  console.log(`Keywords with ZERO results: ${keywordsWithZero.length}`);
  if (keywordsWithZero.length > 0) {
    console.log(`  → ${keywordsWithZero.join(', ')}`);
  }
  console.log(`Total products returned (across all queries): ${totalProducts}`);
  console.log(`\nData quality (Shopify — price, sourceId, thumbnail expected):`);
  console.log(`  Missing price:    ${totalMissingPrice}`);
  console.log(`  Missing thumbnail:${totalMissingThumb}`);
  console.log(`  Missing sourceId: ${totalMissingSourceId}`);
  console.log(`  Empty title:      ${totalMissingTitle}`);
  console.log(`\nURL checks: ${totalUrlChecks} total, ${totalUrlOk} OK, ${totalUrlFail} failed`);

  const passCount = results.filter(r => r.status === 'PASS').length;
  const warnCount = results.filter(r => r.status === 'WARN').length;
  const missCount = results.filter(r => r.status === 'MISS').length;
  console.log(`\nVerdict: ${passCount} PASS, ${warnCount} WARN, ${missCount} MISS out of ${KEYWORDS.length}`);

  if (missCount === 0 && warnCount === 0) {
    console.log('\n✓ All keywords have results with complete data and reachable URLs.');
  } else if (missCount > 0) {
    console.log(`\n⚠ ${missCount} keyword(s) returned zero results — may be expected if AAG doesn't carry those items.`);
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
