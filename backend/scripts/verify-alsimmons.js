const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const p = new PrismaClient();

(async () => {
  const site = await p.monitoredSite.findFirst({ where: { domain: 'alsimmonsgunshop.com' } });
  if (!site) { console.log('Site not found'); process.exit(1); }

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║     ALSIMMONSGUNSHOP.COM — FULL VERIFICATION CHECKLIST      ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  // ── 1. Count comparison (DB vs live API) ──
  console.log('\n═══ 1. COUNT COMPARISON (DB vs Live API) ═══');
  const dbTotal = await p.productIndex.count({ where: { siteId: site.id } });

  let wpTotal = 0;
  try {
    const wpResp = await axios.get('https://alsimmonsgunshop.com/wp-json/wp/v2/product', {
      params: { per_page: 1 }, timeout: 15000
    });
    wpTotal = parseInt(wpResp.headers['x-wp-total'] || '0', 10);
  } catch (e) { console.log('  WP REST API error:', e.message); }

  let storeTotal = 0;
  try {
    const storeResp = await axios.get('https://alsimmonsgunshop.com/wp-json/wc/store/v1/products', {
      params: { per_page: 1 }, timeout: 15000
    });
    storeTotal = parseInt(storeResp.headers['x-wp-total'] || '0', 10);
  } catch (e) { console.log('  Store API error:', e.message); }

  console.log('  DB ProductIndex:        ', dbTotal);
  console.log('  WP REST API (all):      ', wpTotal);
  console.log('  Store API (in-stock):   ', storeTotal);
  console.log('  DB vs WP REST diff:     ', dbTotal - wpTotal, wpTotal > dbTotal ? '(need to crawl more)' : '(stale products in DB)');

  // ── 2. Data quality ──
  console.log('\n═══ 2. DATA QUALITY ═══');
  const noThumb = await p.productIndex.count({ where: { siteId: site.id, thumbnail: null } });
  const noPrice = await p.productIndex.count({ where: { siteId: site.id, price: null } });
  const noStock = await p.productIndex.count({ where: { siteId: site.id, stockStatus: null } });
  console.log('  Missing thumbnails:     ', noThumb, '/', dbTotal, `(${(noThumb/dbTotal*100).toFixed(1)}%)`);
  console.log('  Missing prices:         ', noPrice, '/', dbTotal, `(${(noPrice/dbTotal*100).toFixed(1)}%)`);
  console.log('  Missing stock status:   ', noStock, '/', dbTotal, `(${(noStock/dbTotal*100).toFixed(1)}%)`);

  // ── 3. Stock status distribution ──
  console.log('\n═══ 3. STOCK STATUS DISTRIBUTION ═══');
  const inStock = await p.productIndex.count({ where: { siteId: site.id, stockStatus: 'in_stock' } });
  const outStock = await p.productIndex.count({ where: { siteId: site.id, stockStatus: 'out_of_stock' } });
  const unknownStock = await p.productIndex.count({ where: { siteId: site.id, stockStatus: null } });
  console.log('  In stock:               ', inStock);
  console.log('  Out of stock:           ', outStock);
  console.log('  Unknown:                ', unknownStock);

  // ── 4. Check for fake/category products ──
  console.log('\n═══ 4. FAKE/CATEGORY PRODUCT CHECK ═══');
  const categoryUrls = await p.productIndex.findMany({
    where: { siteId: site.id, url: { contains: '/product-category/' } },
    select: { title: true, url: true }
  });
  console.log('  Category-page URLs in DB:', categoryUrls.length);
  categoryUrls.forEach(prod => console.log('    ', prod.title, '|', prod.url));

  const suspectFakes = await p.productIndex.findMany({
    where: { siteId: site.id, price: null, thumbnail: null },
    select: { title: true, url: true }
  });
  console.log('  No price + no thumbnail: ', suspectFakes.length);
  suspectFakes.forEach(prod => console.log('    ', prod.title));

  // ── 5. URL duplicates ──
  console.log('\n═══ 5. URL DUPLICATE CHECK ═══');
  const allProds = await p.productIndex.findMany({
    where: { siteId: site.id },
    select: { url: true, title: true }
  });
  const urlMap = new Map();
  for (const prod of allProds) {
    let decoded;
    try { decoded = decodeURIComponent(prod.url); } catch { decoded = prod.url; }
    if (!urlMap.has(decoded)) urlMap.set(decoded, []);
    urlMap.get(decoded).push(prod.title);
  }
  const dupes = [...urlMap.entries()].filter(([, titles]) => titles.length > 1);
  console.log('  Duplicate URLs found:   ', dupes.length);
  dupes.forEach(([url, titles]) => console.log('    ', url, '→', titles.join(' / ')));

  // ── 6. Keyword search tests ──
  console.log('\n═══ 6. KEYWORD SEARCH TESTS (DB) ═══');
  const keywords = ['sks', 'remington', 'glock', 'magazine', 'shotgun', 'rifle'];
  for (const kw of keywords) {
    const results = await p.productIndex.findMany({
      where: { siteId: site.id, title: { contains: kw, mode: 'insensitive' } },
      select: { title: true }
    });
    console.log(`  "${kw}":`.padEnd(20), results.length, 'results');
  }

  // ── 7. Sample products (latest) ──
  console.log('\n═══ 7. LATEST 10 PRODUCTS ═══');
  const latest = await p.productIndex.findMany({
    where: { siteId: site.id },
    orderBy: { firstSeenAt: 'desc' },
    take: 10,
    select: { title: true, price: true, stockStatus: true, thumbnail: true, firstSeenAt: true }
  });
  latest.forEach(prod => console.log(
    ' ',
    prod.firstSeenAt.toISOString().slice(0, 10),
    (prod.stockStatus || 'unknown').padEnd(12),
    prod.price ? ('$' + prod.price).padEnd(10) : 'no price  ',
    prod.thumbnail ? 'THUMB' : 'NO_TH',
    prod.title.slice(0, 55)
  ));

  // ── 8. Site config ──
  console.log('\n═══ 8. SITE CONFIGURATION ═══');
  console.log('  Domain:        ', site.domain);
  console.log('  Adapter:       ', site.adapter);
  console.log('  Category:      ', site.siteCategory);
  console.log('  Base budget:   ', site.baseBudget);
  console.log('  Pressure:      ', site.pressure);
  console.log('  Capacity:      ', site.capacity);
  console.log('  Active:        ', site.isActive);
  console.log('  Last crawl:    ', site.lastCrawledAt?.toISOString() || 'never');
  console.log('  Crawl tuning:  ', JSON.stringify(site.crawlTuning));

  // ── Summary ──
  console.log('\n═══ SUMMARY ═══');
  const issues = [];
  if (dbTotal < wpTotal * 0.5) issues.push(`DB has only ${dbTotal}/${wpTotal} products (${(dbTotal/wpTotal*100).toFixed(0)}% coverage) — WooCommerce adapter fix needed`);
  if (noThumb > dbTotal * 0.1) issues.push(`${noThumb} products missing thumbnails (${(noThumb/dbTotal*100).toFixed(0)}%)`);
  if (noPrice > dbTotal * 0.05) issues.push(`${noPrice} products missing prices (${(noPrice/dbTotal*100).toFixed(0)}%)`);
  if (categoryUrls.length > 0) issues.push(`${categoryUrls.length} category-page URLs still in DB`);
  if (dupes.length > 0) issues.push(`${dupes.length} duplicate URLs`);
  if (suspectFakes.length > 0) issues.push(`${suspectFakes.length} suspect fakes (no price + no thumbnail)`);

  if (issues.length === 0) {
    console.log('  ✓ All checks passed');
  } else {
    issues.forEach(issue => console.log('  ✗', issue));
  }

  await p.$disconnect();
})();
