/**
 * Backfill sourceId on existing ProductIndex rows.
 *
 * Shopify sites  — fetch /products.json, match by URL handle
 * WooCommerce    — fetch /wp-json/wp/v2/product, match by link URL
 * Gunpost        — skipped (Cloudflare; crawler backfills on next pass)
 *
 * After backfill, deduplicates: if two rows share the same (siteId, sourceId),
 * keeps the one with the most recent lastSeenAt and deactivates the other.
 *
 * Usage: node scripts/backfill-sourceId.js
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');

const prisma = new PrismaClient();

const RATE_LIMIT_MS = 500;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Accept: 'application/json',
};

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

// ── Shopify backfill ────────────────────────────────────────────────────────

async function backfillShopify(site) {
  var origin = site.url.replace(/\/$/, '');
  var domain = site.domain;

  // Load all active products missing sourceId, index by URL
  var rows = await prisma.productIndex.findMany({
    where: { siteId: site.id, isActive: true, sourceId: null },
    select: { id: true, url: true },
  });
  if (rows.length === 0) {
    console.log('[' + domain + '] No products missing sourceId — skipping');
    return { domain: domain, total: 0, filled: 0 };
  }

  // Build a map: normalised URL -> row
  var byUrl = new Map();
  for (var r = 0; r < rows.length; r++) {
    byUrl.set(rows[r].url.replace(/\/$/, '').toLowerCase(), rows[r]);
  }
  var totalMissing = rows.length;
  var filled = 0;

  console.log('[' + domain + '] ' + totalMissing + ' products missing sourceId');

  var page = 1;
  while (true) {
    var products;
    try {
      var resp = await axios.get(origin + '/products.json', {
        params: { limit: 250, page: page },
        headers: HEADERS,
        timeout: 30000,
        validateStatus: function (s) { return s === 200; },
      });
      products = resp.data && resp.data.products;
    } catch (err) {
      console.log('[' + domain + '] Error on page ' + page + ': ' + err.message);
      break;
    }

    if (!Array.isArray(products) || products.length === 0) break;

    for (var i = 0; i < products.length; i++) {
      var p = products[i];
      var handle = p.handle;
      if (!handle) continue;
      var expectedUrl = (origin + '/products/' + handle).toLowerCase();
      var row = byUrl.get(expectedUrl);
      if (!row) continue;

      await prisma.productIndex.update({
        where: { id: row.id },
        data: { sourceId: String(p.id) },
      });
      filled++;
      byUrl.delete(expectedUrl);

      if (filled % 100 === 0) {
        console.log('[' + domain + '] Backfilled ' + filled + '/' + totalMissing + ' products');
      }
    }

    if (byUrl.size === 0) break;
    page++;
    await sleep(RATE_LIMIT_MS);
  }

  console.log('[' + domain + '] Backfilled ' + filled + '/' + totalMissing + ' products (done)');
  return { domain: domain, total: totalMissing, filled: filled };
}

// ── WooCommerce backfill ────────────────────────────────────────────────────

async function backfillWooCommerce(site) {
  var origin = site.url.replace(/\/$/, '');
  var domain = site.domain;

  var rows = await prisma.productIndex.findMany({
    where: { siteId: site.id, isActive: true, sourceId: null },
    select: { id: true, url: true },
  });
  if (rows.length === 0) {
    console.log('[' + domain + '] No products missing sourceId — skipping');
    return { domain: domain, total: 0, filled: 0 };
  }

  // Build map: normalised URL -> row
  var byUrl = new Map();
  for (var r = 0; r < rows.length; r++) {
    // Normalise: strip trailing slash, lowercase
    byUrl.set(rows[r].url.replace(/\/$/, '').toLowerCase(), rows[r]);
  }
  var totalMissing = rows.length;
  var filled = 0;

  console.log('[' + domain + '] ' + totalMissing + ' products missing sourceId');

  var page = 1;
  while (true) {
    var products;
    try {
      var resp = await axios.get(origin + '/wp-json/wp/v2/product', {
        params: { per_page: 100, page: page, orderby: 'date', order: 'desc' },
        headers: HEADERS,
        timeout: 20000,
        validateStatus: function (s) { return s === 200; },
      });
      products = resp.data;
      if (page === 1) {
        var totalPages = parseInt(resp.headers['x-wp-totalpages'] || '0', 10);
        console.log('[' + domain + '] WP REST API: ~' + totalPages + ' pages');
      }
    } catch (err) {
      console.log('[' + domain + '] WP REST API error on page ' + page + ': ' + err.message);
      break;
    }

    if (!Array.isArray(products) || products.length === 0) break;

    for (var i = 0; i < products.length; i++) {
      var p = products[i];
      var link = (p.link || '').replace(/\/$/, '').toLowerCase();
      if (!link) continue;

      var row = byUrl.get(link);
      if (!row) continue;

      await prisma.productIndex.update({
        where: { id: row.id },
        data: { sourceId: String(p.id) },
      });
      filled++;
      byUrl.delete(link);

      if (filled % 100 === 0) {
        console.log('[' + domain + '] Backfilled ' + filled + '/' + totalMissing + ' products');
      }
    }

    if (byUrl.size === 0) break;
    page++;
    await sleep(RATE_LIMIT_MS);
  }

  console.log('[' + domain + '] Backfilled ' + filled + '/' + totalMissing + ' products (done)');
  return { domain: domain, total: totalMissing, filled: filled };
}

// ── Deduplication ───────────────────────────────────────────────────────────

async function deduplicateSite(site) {
  var domain = site.domain;

  // Find all sourceIds that appear more than once for this site
  var dupes = await prisma.$queryRaw`
    SELECT "sourceId", COUNT(*)::int AS cnt
    FROM product_index
    WHERE "siteId" = ${site.id}
      AND "sourceId" IS NOT NULL
      AND "isActive" = true
    GROUP BY "sourceId"
    HAVING COUNT(*) > 1
  `;

  if (dupes.length === 0) {
    console.log('[' + domain + '] No duplicates found');
    return 0;
  }

  var deactivated = 0;
  for (var d = 0; d < dupes.length; d++) {
    var sourceId = dupes[d].sourceId;
    var rows = await prisma.productIndex.findMany({
      where: { siteId: site.id, sourceId: sourceId, isActive: true },
      select: { id: true, lastSeenAt: true, url: true },
      orderBy: { lastSeenAt: 'desc' },
    });

    // Keep the first (most recent lastSeenAt), deactivate the rest
    for (var i = 1; i < rows.length; i++) {
      await prisma.productIndex.update({
        where: { id: rows[i].id },
        data: { isActive: false },
      });
      deactivated++;
      console.log('[' + domain + '] Deactivated duplicate: ' + rows[i].url + ' (sourceId=' + sourceId + ')');
    }
  }

  console.log('[' + domain + '] Deactivated ' + deactivated + ' duplicates');
  return deactivated;
}

// ── Coverage report ─────────────────────────────────────────────────────────

async function reportCoverage(site) {
  var total = await prisma.productIndex.count({
    where: { siteId: site.id, isActive: true },
  });
  var withSourceId = await prisma.productIndex.count({
    where: { siteId: site.id, isActive: true, sourceId: { not: null } },
  });
  var pct = total > 0 ? Math.round((withSourceId / total) * 100) : 0;
  console.log('[' + site.domain + '] Coverage: ' + withSourceId + '/' + total + ' (' + pct + '%)');
  return { domain: site.domain, total: total, withSourceId: withSourceId, pct: pct };
}

// ── Main ────────────────────────────────────────────────────────────────────

var SHOPIFY_DOMAINS = [
  'aagcanada.ca',
  'fishingworldgc.ca',
  'jobrookoutdoors.com',
  'groupepronature.ca',
];

var WOO_DOMAINS = [
  'alsimmonsgunshop.com',
  'budgetshootersupply.ca',
  'canadafirstammo.ca',
];

var SKIP_DOMAINS = ['gunpost.ca'];

async function main() {
  console.log('=== sourceId Backfill ===\n');
  console.log('Skipping: ' + SKIP_DOMAINS.join(', ') + ' (Cloudflare — crawler will backfill)\n');

  var allDomains = SHOPIFY_DOMAINS.concat(WOO_DOMAINS);
  var results = [];

  for (var d = 0; d < allDomains.length; d++) {
    var domain = allDomains[d];
    var site = await prisma.monitoredSite.findFirst({
      where: { domain: domain, isEnabled: true },
      select: { id: true, domain: true, url: true, adapterType: true },
    });
    if (!site) {
      console.log('[' + domain + '] Site not found or disabled — skipping');
      continue;
    }

    try {
      var result;
      if (SHOPIFY_DOMAINS.indexOf(domain) >= 0) {
        result = await backfillShopify(site);
      } else {
        result = await backfillWooCommerce(site);
      }
      results.push(result);

      // Deduplicate after backfill
      await deduplicateSite(site);
    } catch (err) {
      console.log('[' + domain + '] FAILED: ' + err.message);
      console.log(err.stack);
    }

    console.log('');
  }

  // Final coverage report
  console.log('\n=== sourceId Coverage Report ===\n');

  var allSites = await prisma.monitoredSite.findMany({
    where: { domain: { in: allDomains.concat(SKIP_DOMAINS) }, isEnabled: true },
    select: { id: true, domain: true },
  });
  for (var s = 0; s < allSites.length; s++) {
    await reportCoverage(allSites[s]);
  }

  await prisma.$disconnect();
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
