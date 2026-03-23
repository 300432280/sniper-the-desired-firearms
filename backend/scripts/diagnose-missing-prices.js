/**
 * Diagnose Missing Prices across 7 test sites
 *
 * For each site:
 *  1. Count active products WITH vs WITHOUT price, report percentage
 *  2. Sample 5 products WITHOUT price — show title, URL, stockStatus
 *  3. For sites with >10% missing: check OOS correlation, category/productType patterns, stream patterns
 *  4. For canadafirstammo.ca: check NULL vs 0 price breakdown
 *  5. Produce per-site recommendations
 *
 * Usage: cd backend && node scripts/diagnose-missing-prices.js
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const TEST_SITES = [
  'aagcanada.ca',
  'alflahertys.com',
  'alsimmonsgunshop.com',
  'budgetshootersupply.ca',
  'bullseyenorth.com',
  'canadafirstammo.ca',
  'gunpost.ca',
];

const SEP = '='.repeat(80);
const THIN = '-'.repeat(80);

function pct(n, total) {
  if (total === 0) return '0.0%';
  return (n / total * 100).toFixed(1) + '%';
}

function pad(str, len) {
  str = String(str);
  return str.length >= len ? str : str + ' '.repeat(len - str.length);
}

async function getSiteRecord(domain) {
  return prisma.monitoredSite.findFirst({
    where: { domain: { contains: domain.replace('.ca', '').replace('.com', '').split('.')[0] } },
    select: { id: true, domain: true, name: true, adapterType: true, streamState: true },
  });
}

async function basicCounts(siteId) {
  var [total, withPrice, withoutPrice, oos, inStock, unknownStock] = await Promise.all([
    prisma.productIndex.count({ where: { siteId: siteId, isActive: true } }),
    prisma.productIndex.count({ where: { siteId: siteId, isActive: true, price: { not: null } } }),
    prisma.productIndex.count({ where: { siteId: siteId, isActive: true, price: null } }),
    prisma.productIndex.count({ where: { siteId: siteId, isActive: true, stockStatus: 'out_of_stock' } }),
    prisma.productIndex.count({ where: { siteId: siteId, isActive: true, stockStatus: 'in_stock' } }),
    prisma.productIndex.count({ where: { siteId: siteId, isActive: true, OR: [{ stockStatus: null }, { stockStatus: 'unknown' }] } }),
  ]);
  return { total, withPrice, withoutPrice, oos, inStock, unknownStock };
}

async function sampleMissing(siteId, limit) {
  return prisma.productIndex.findMany({
    where: { siteId: siteId, isActive: true, price: null },
    select: { title: true, url: true, stockStatus: true, category: true, productType: true, tags: true },
    take: limit,
    orderBy: { lastSeenAt: 'desc' },
  });
}

async function deepAnalysis(siteId, domain) {
  var results = {};

  // 1. OOS correlation: how many missing-price products are OOS?
  var [missingPriceOOS, missingPriceInStock, missingPriceUnknown] = await Promise.all([
    prisma.productIndex.count({ where: { siteId: siteId, isActive: true, price: null, stockStatus: 'out_of_stock' } }),
    prisma.productIndex.count({ where: { siteId: siteId, isActive: true, price: null, stockStatus: 'in_stock' } }),
    prisma.productIndex.count({ where: { siteId: siteId, isActive: true, price: null, OR: [{ stockStatus: null }, { stockStatus: 'unknown' }] } }),
  ]);
  results.oosCorrelation = { missingPriceOOS, missingPriceInStock, missingPriceUnknown };

  // 2. Category breakdown of missing-price products
  var missingByCategory = await prisma.productIndex.groupBy({
    by: ['category'],
    where: { siteId: siteId, isActive: true, price: null },
    _count: true,
    orderBy: { _count: { category: 'desc' } },
  });
  results.missingByCategory = missingByCategory.map(function(r) {
    return { category: r.category || '(null)', count: r._count };
  });

  // 3. ProductType breakdown of missing-price products
  var missingByType = await prisma.productIndex.groupBy({
    by: ['productType'],
    where: { siteId: siteId, isActive: true, price: null },
    _count: true,
    orderBy: { _count: { productType: 'desc' } },
  });
  results.missingByType = missingByType.map(function(r) {
    return { productType: r.productType || '(null)', count: r._count };
  });

  // 4. Check if missing-price products cluster by URL pattern (stream/category page)
  //    Extract path segments from URLs to see if they share a common prefix
  var missingUrls = await prisma.productIndex.findMany({
    where: { siteId: siteId, isActive: true, price: null },
    select: { url: true },
    take: 200,
  });

  var pathCounts = {};
  missingUrls.forEach(function(p) {
    try {
      var u = new URL(p.url);
      // Get first 2 path segments as a grouping key
      var parts = u.pathname.split('/').filter(Boolean);
      var key = '/' + (parts.slice(0, 2).join('/') || '(root)');
      pathCounts[key] = (pathCounts[key] || 0) + 1;
    } catch (e) { /* skip bad URLs */ }
  });

  // Sort by count descending
  results.urlPatterns = Object.entries(pathCounts)
    .sort(function(a, b) { return b[1] - a[1]; })
    .slice(0, 10)
    .map(function(e) { return { path: e[0], count: e[1] }; });

  return results;
}

async function canadaFirstAmmoSpecial(siteId) {
  // Check NULL vs price=0 breakdown
  var [priceNull, priceZero, pricePositive] = await Promise.all([
    prisma.productIndex.count({ where: { siteId: siteId, isActive: true, price: null } }),
    prisma.productIndex.count({ where: { siteId: siteId, isActive: true, price: 0 } }),
    prisma.productIndex.count({ where: { siteId: siteId, isActive: true, price: { gt: 0 } } }),
  ]);

  // Of those with price=0, what's their stock status?
  var zeroByStock = await prisma.productIndex.groupBy({
    by: ['stockStatus'],
    where: { siteId: siteId, isActive: true, price: 0 },
    _count: true,
  });

  // Of those with price=null, what's their stock status?
  var nullByStock = await prisma.productIndex.groupBy({
    by: ['stockStatus'],
    where: { siteId: siteId, isActive: true, price: null },
    _count: true,
  });

  return {
    priceNull, priceZero, pricePositive,
    zeroByStock: zeroByStock.map(function(r) { return { stock: r.stockStatus || '(null)', count: r._count }; }),
    nullByStock: nullByStock.map(function(r) { return { stock: r.stockStatus || '(null)', count: r._count }; }),
  };
}

function generateRecommendation(domain, counts, deep, cfaSpecial) {
  var missingPct = counts.total > 0 ? counts.withoutPrice / counts.total : 0;
  var lines = [];

  if (counts.total === 0) {
    lines.push('NO ACTIVE PRODUCTS — site may not be crawled yet or all products deactivated.');
    return lines.join('\n');
  }

  if (missingPct === 0) {
    lines.push('CLEAN — no missing prices.');
    return lines.join('\n');
  }

  if (missingPct <= 0.05) {
    lines.push('LOW (<5%) — minor gap, likely edge cases.');
  } else if (missingPct <= 0.15) {
    lines.push('MODERATE (5-15%) — worth investigating.');
  } else {
    lines.push('HIGH (>15%) — significant data quality issue.');
  }

  if (deep) {
    var oosRatio = counts.withoutPrice > 0 ? deep.oosCorrelation.missingPriceOOS / counts.withoutPrice : 0;
    if (oosRatio > 0.8) {
      lines.push('ROOT CAUSE: ' + pct(deep.oosCorrelation.missingPriceOOS, counts.withoutPrice) +
        ' of missing-price products are out-of-stock.');
      lines.push('DIAGNOSIS: Source data issue — site does not expose price for OOS items.');
      lines.push('ACTION: This is expected behavior. Consider marking OOS products with a "price unavailable" flag.');
    } else if (oosRatio > 0.5) {
      lines.push('PARTIAL OOS CORRELATION: ' + pct(deep.oosCorrelation.missingPriceOOS, counts.withoutPrice) +
        ' of missing-price are OOS, but ' + deep.oosCorrelation.missingPriceInStock +
        ' in-stock products also lack price.');
      lines.push('ACTION: Investigate the in-stock products — adapter may be failing to extract price for some pages.');
    } else {
      lines.push('NOT OOS-RELATED: Only ' + pct(deep.oosCorrelation.missingPriceOOS, counts.withoutPrice) +
        ' of missing-price products are OOS.');
      lines.push('DIAGNOSIS: Likely adapter extraction issue — price selector may not match all product layouts.');
      lines.push('ACTION: Sample in-stock products with missing price and check the page HTML for price elements.');
    }

    // Check if products cluster in a specific category/type
    if (deep.missingByType.length > 0 && deep.missingByType[0].count > counts.withoutPrice * 0.6) {
      lines.push('CLUSTER: ' + pct(deep.missingByType[0].count, counts.withoutPrice) +
        ' of missing-price products have productType="' + deep.missingByType[0].productType + '"');
    }

    if (deep.urlPatterns.length > 0 && deep.urlPatterns[0].count > counts.withoutPrice * 0.4) {
      lines.push('URL CLUSTER: ' + deep.urlPatterns[0].count + ' products share path prefix "' +
        deep.urlPatterns[0].path + '"');
    }
  }

  // canadafirstammo special
  if (cfaSpecial) {
    lines.push('');
    lines.push('canadafirstammo.ca SPECIAL ANALYSIS:');
    lines.push('  price=NULL: ' + cfaSpecial.priceNull + ', price=0: ' + cfaSpecial.priceZero +
      ', price>0: ' + cfaSpecial.pricePositive);
    lines.push('  NULL-price by stock: ' + cfaSpecial.nullByStock.map(function(r) {
      return r.stock + '=' + r.count;
    }).join(', '));
    if (cfaSpecial.priceZero > 0) {
      lines.push('  $0-price by stock: ' + cfaSpecial.zeroByStock.map(function(r) {
        return r.stock + '=' + r.count;
      }).join(', '));
      lines.push('  NOTE: WooCommerce returns $0 for OOS items. Earlier fix script nulled these. $0 → NULL is correct.');
    } else {
      lines.push('  No price=$0 products remain — earlier fix script already converted them to NULL.');
    }
  }

  return lines.join('\n');
}

async function main() {
  console.log(SEP);
  console.log('  MISSING PRICE DIAGNOSTIC REPORT');
  console.log('  Generated: ' + new Date().toISOString());
  console.log(SEP);

  // ── Phase 1: Overview table ──
  console.log('\n[PHASE 1] Per-site price coverage overview\n');
  console.log(pad('Site', 30) + pad('Total', 8) + pad('HasPrice', 10) + pad('NoPrice', 10) + pad('Missing%', 10) + pad('OOS', 8) + pad('InStock', 8));
  console.log(THIN);

  var siteData = [];

  for (var i = 0; i < TEST_SITES.length; i++) {
    var domain = TEST_SITES[i];
    var site = await getSiteRecord(domain);

    if (!site) {
      console.log(pad(domain, 30) + '** SITE NOT FOUND IN DB **');
      siteData.push({ domain: domain, site: null, counts: null });
      continue;
    }

    var counts = await basicCounts(site.id);
    console.log(
      pad(site.domain, 30) +
      pad(counts.total, 8) +
      pad(counts.withPrice, 10) +
      pad(counts.withoutPrice, 10) +
      pad(pct(counts.withoutPrice, counts.total), 10) +
      pad(counts.oos, 8) +
      pad(counts.inStock, 8)
    );

    siteData.push({ domain: domain, site: site, counts: counts });
  }

  // Grand totals
  var grandTotal = 0, grandMissing = 0;
  siteData.forEach(function(s) {
    if (s.counts) {
      grandTotal += s.counts.total;
      grandMissing += s.counts.withoutPrice;
    }
  });
  console.log(THIN);
  console.log(pad('TOTAL', 30) + pad(grandTotal, 8) + pad(grandTotal - grandMissing, 10) +
    pad(grandMissing, 10) + pad(pct(grandMissing, grandTotal), 10));

  // ── Phase 2: Sample missing-price products ──
  console.log('\n' + SEP);
  console.log('[PHASE 2] Sample products WITHOUT price (up to 5 per site)');
  console.log(SEP);

  for (var i = 0; i < siteData.length; i++) {
    var sd = siteData[i];
    if (!sd.site || !sd.counts || sd.counts.withoutPrice === 0) continue;

    console.log('\n  ' + sd.site.domain + ' (' + sd.counts.withoutPrice + ' missing)');
    console.log('  ' + THIN.slice(0, 76));

    var samples = await sampleMissing(sd.site.id, 5);
    for (var j = 0; j < samples.length; j++) {
      var p = samples[j];
      console.log('  ' + (j + 1) + '. ' + (p.title || '(no title)').slice(0, 70));
      console.log('     URL: ' + p.url);
      console.log('     stockStatus: ' + (p.stockStatus || 'null') +
        ' | category: ' + (p.category || 'null') +
        ' | productType: ' + (p.productType || 'null'));
    }
  }

  // ── Phase 3: Deep analysis for sites >10% missing ──
  console.log('\n' + SEP);
  console.log('[PHASE 3] Deep analysis (sites with >10% missing prices)');
  console.log(SEP);

  var deepResults = {};

  for (var i = 0; i < siteData.length; i++) {
    var sd = siteData[i];
    if (!sd.site || !sd.counts) continue;
    var missingPct = sd.counts.total > 0 ? sd.counts.withoutPrice / sd.counts.total : 0;
    if (missingPct <= 0.10 && sd.counts.withoutPrice < 10) continue;

    // Also run deep analysis for any site with 10+ missing even if % is low
    if (missingPct <= 0.10 && sd.counts.withoutPrice < 10) continue;

    console.log('\n  ' + sd.site.domain + ' — ' + pct(sd.counts.withoutPrice, sd.counts.total) + ' missing');
    console.log('  ' + THIN.slice(0, 76));

    var deep = await deepAnalysis(sd.site.id, sd.domain);
    deepResults[sd.domain] = deep;

    // OOS correlation
    console.log('  OOS correlation:');
    console.log('    Missing-price + OOS:      ' + deep.oosCorrelation.missingPriceOOS +
      ' (' + pct(deep.oosCorrelation.missingPriceOOS, sd.counts.withoutPrice) + ')');
    console.log('    Missing-price + InStock:   ' + deep.oosCorrelation.missingPriceInStock +
      ' (' + pct(deep.oosCorrelation.missingPriceInStock, sd.counts.withoutPrice) + ')');
    console.log('    Missing-price + Unknown:   ' + deep.oosCorrelation.missingPriceUnknown +
      ' (' + pct(deep.oosCorrelation.missingPriceUnknown, sd.counts.withoutPrice) + ')');

    // Category breakdown
    if (deep.missingByCategory.length > 0) {
      console.log('  By category:');
      deep.missingByCategory.forEach(function(c) {
        console.log('    ' + pad(c.category, 25) + c.count);
      });
    }

    // ProductType breakdown
    if (deep.missingByType.length > 0) {
      console.log('  By productType:');
      deep.missingByType.forEach(function(t) {
        console.log('    ' + pad(t.productType, 25) + t.count);
      });
    }

    // URL patterns
    if (deep.urlPatterns.length > 0) {
      console.log('  URL path clusters (top 10):');
      deep.urlPatterns.forEach(function(u) {
        console.log('    ' + pad(u.path, 40) + u.count);
      });
    }
  }

  // ── Phase 3b: canadafirstammo.ca special ──
  var cfaSite = siteData.find(function(s) { return s.domain === 'canadafirstammo.ca'; });
  var cfaSpecial = null;
  if (cfaSite && cfaSite.site) {
    console.log('\n' + SEP);
    console.log('[PHASE 3b] canadafirstammo.ca — NULL vs $0 price analysis');
    console.log(SEP);

    cfaSpecial = await canadaFirstAmmoSpecial(cfaSite.site.id);

    console.log('  price=NULL:  ' + cfaSpecial.priceNull);
    console.log('  price=$0:    ' + cfaSpecial.priceZero);
    console.log('  price>$0:    ' + cfaSpecial.pricePositive);
    console.log('');
    console.log('  NULL-price products by stock status:');
    cfaSpecial.nullByStock.forEach(function(r) {
      console.log('    ' + pad(r.stock, 20) + r.count);
    });
    if (cfaSpecial.priceZero > 0) {
      console.log('  $0-price products by stock status:');
      cfaSpecial.zeroByStock.forEach(function(r) {
        console.log('    ' + pad(r.stock, 20) + r.count);
      });
    }
    console.log('');
    console.log('  Context: WooCommerce API returns price="0" or price="" for OOS items.');
    console.log('  An earlier fix script converted $0 → NULL (correct — no real price to show).');
  }

  // ── Phase 4: Recommendations ──
  console.log('\n' + SEP);
  console.log('[PHASE 4] Per-site recommendations');
  console.log(SEP);

  for (var i = 0; i < siteData.length; i++) {
    var sd = siteData[i];
    console.log('\n  ' + (sd.site ? sd.site.domain : sd.domain) +
      (sd.site ? ' [' + sd.site.adapterType + ']' : ''));
    console.log('  ' + THIN.slice(0, 76));

    if (!sd.counts) {
      console.log('  SITE NOT FOUND — cannot diagnose.');
      continue;
    }

    var deep = deepResults[sd.domain] || null;
    var cfa = (sd.domain === 'canadafirstammo.ca') ? cfaSpecial : null;
    var rec = generateRecommendation(sd.domain, sd.counts, deep, cfa);
    rec.split('\n').forEach(function(line) {
      console.log('  ' + line);
    });
  }

  console.log('\n' + SEP);
  console.log('  DONE — ' + grandMissing + ' / ' + grandTotal + ' products (' +
    pct(grandMissing, grandTotal) + ') across ' + TEST_SITES.length + ' sites have no price.');
  console.log(SEP);

  await prisma.$disconnect();
}

main().catch(function(err) {
  console.error('FATAL:', err);
  process.exit(1);
});
