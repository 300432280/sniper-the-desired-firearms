/**
 * One-time cleanup for alflahertys ProductIndex:
 * 1. Run existing dirty-data fixes (junk entries, dirty titles, wrong stock status)
 * 2. Backfill thumbnails from live catalog pages for products missing them
 * 3. Fix suspicious prices that are actually barrel lengths or calibers
 */
const { PrismaClient } = require('@prisma/client');
const { fetchWithPlaywright } = require('../dist/services/scraper/playwright-fetcher');
const { GenericRetailAdapter } = require('../dist/services/scraper/adapters/generic-retail');
const cheerio = require('cheerio');

const db = new PrismaClient();
const adapter = new GenericRetailAdapter();

const CATALOG_URLS = [
  'https://alflahertys.com/shooting-supplies-firearms-ammunition/firearms/rifles/',
  'https://alflahertys.com/shooting-supplies-firearms-and-ammunition/firearms/shotguns/',
  'https://alflahertys.com/shooting-supplies-firearms-ammunition/firearms/handguns/',
  'https://alflahertys.com/shooting-supplies-firearms-ammunition/ammunition/centerfire-ammunition/',
  'https://alflahertys.com/shooting-supplies-firearms-ammunition/ammunition/rimfire-ammunition/',
  'https://alflahertys.com/shooting-supplies-firearms-ammunition/ammunition/shotgun-ammunition/',
  'https://alflahertys.com/shooting-supplies-firearms-ammunition/optics/riflescopes/',
  'https://alflahertys.com/als-bargains/',
];

(async () => {
  const site = await db.monitoredSite.findFirst({ where: { url: { contains: 'alflahertys' } } });
  if (!site) { console.log('Site not found'); process.exit(1); }

  // ═══════════════════════════════════════════════════════════════════
  // Step 1: Thumbnail backfill from live catalog pages
  // ═══════════════════════════════════════════════════════════════════
  console.log('=== Step 1: Thumbnail backfill from catalog pages ===');
  const thumbMap = new Map(); // url -> thumbnail

  for (const url of CATALOG_URLS) {
    const path = url.split('.com')[1];
    console.log(`Fetching ${path}...`);
    try {
      const result = await fetchWithPlaywright(url, { timeout: 60000 });
      const $ = cheerio.load(result.html);
      const products = adapter.extractCatalogProducts($, url);
      let added = 0;
      for (const p of products) {
        if (p.thumbnail && p.url && !thumbMap.has(p.url)) {
          thumbMap.set(p.url, p.thumbnail);
          added++;
        }
      }
      console.log(`  ${products.length} products, ${added} new thumbnails`);
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
    }
  }
  console.log(`Total unique thumbnails collected: ${thumbMap.size}`);

  // Update ProductIndex records missing thumbnails
  let thumbUpdated = 0;
  for (const [url, thumbnail] of thumbMap) {
    const result = await db.productIndex.updateMany({
      where: { siteId: site.id, url, thumbnail: null },
      data: { thumbnail },
    });
    if (result.count > 0) thumbUpdated += result.count;
  }
  console.log(`ProductIndex thumbnails backfilled: ${thumbUpdated}`);

  // Also update Match records missing thumbnails
  let matchThumbUpdated = 0;
  for (const [url, thumbnail] of thumbMap) {
    const result = await db.match.updateMany({
      where: { url, thumbnail: null },
      data: { thumbnail },
    });
    if (result.count > 0) matchThumbUpdated += result.count;
  }
  console.log(`Match thumbnails backfilled: ${matchThumbUpdated}`);

  // ═══════════════════════════════════════════════════════════════════
  // Step 2: Fix suspicious prices (barrel lengths / calibers)
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== Step 2: Fix suspicious prices ===');
  const suspectPrices = await db.productIndex.findMany({
    where: { siteId: site.id, isActive: true, price: { lt: 25 }, stockStatus: 'out_of_stock' },
    select: { id: true, title: true, price: true, url: true },
  });

  let priceFixed = 0;
  for (const p of suspectPrices) {
    const priceStr = p.price.toFixed(2).replace(/\.?0+$/, '');
    // Check if the "price" appears as a measurement in the title
    const isMeasurement =
      p.title.includes(priceStr + '"') ||   // barrel length: 19.75"
      p.title.includes(priceStr + ' ') ||   // caliber: 5.56 NATO
      p.title.includes('/' + priceStr) ||   // caliber: 223/5.56
      p.title.includes(priceStr + 'mm');    // metric caliber
    if (isMeasurement) {
      console.log(`  Nullifying $${p.price} for "${p.title.slice(0, 70)}"`);
      await db.productIndex.update({
        where: { id: p.id },
        data: { price: null },
      });
      // Also fix in Match table
      await db.match.updateMany({
        where: { url: p.url, price: p.price },
        data: { price: null },
      });
      priceFixed++;
    }
  }
  console.log(`Suspicious prices nullified: ${priceFixed}`);

  await db.$disconnect();
  console.log('\nDone!');
  process.exit(0);
})();
