/**
 * Fix stock status, prices, and thumbnails for budgetshootersupply.ca
 * using Store API (stock+price) and WP REST API with _embed (thumbnails).
 */
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const p = new PrismaClient();

const DOMAIN = 'budgetshootersupply.ca';
const ORIGIN = 'https://' + DOMAIN;

async function main() {
  const site = await p.monitoredSite.findFirst({ where: { domain: DOMAIN } });
  if (!site) { console.log('Site not found'); process.exit(1); }

  // ── PHASE 1: Stock + Price from Store API ──────────────────────────────────
  console.log('=== PHASE 1: Stock & Price from Store API ===');
  const inStockMap = new Map(); // url → { price, name }
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    try {
      const resp = await axios.get(`${ORIGIN}/wp-json/wc/store/v1/products`, {
        params: { per_page: 100, page },
        timeout: 20000,
        validateStatus: (s) => s === 200,
      });
      if (page === 1) {
        totalPages = parseInt(resp.headers['x-wp-totalpages'] || '1', 10);
        console.log(`Store API: ${resp.headers['x-wp-total']} in-stock products, ${totalPages} pages`);
      }
      for (const prod of resp.data) {
        const url = prod.permalink || '';
        const price = prod.prices?.price ? parseInt(prod.prices.price, 10) / 100 : null;
        const name = (prod.name || '').toLowerCase().trim();
        inStockMap.set(url, { price, name });
        inStockMap.set(url.replace(/\/$/, ''), { price, name });
        if (name) inStockMap.set('title:' + name, { price });
      }
      process.stdout.write(`  Page ${page}/${totalPages}\r`);
      page++;
      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      console.log(`\nError on page ${page}: ${err.message}`);
      break;
    }
  }
  console.log(`\nIn-stock products found: ${Math.floor(inStockMap.size / 3)}`);

  // Update stock status and price for all products
  const allProducts = await p.productIndex.findMany({
    where: { siteId: site.id },
    select: { id: true, url: true, title: true, stockStatus: true, price: true },
  });

  let stockFixed = 0;
  let priceFixed = 0;
  for (const prod of allProducts) {
    const match = inStockMap.get(prod.url) || inStockMap.get(prod.url.replace(/\/$/, ''))
      || inStockMap.get('title:' + (prod.title || '').toLowerCase().trim());
    const newStock = match ? 'in_stock' : 'out_of_stock';
    const newPrice = match?.price ?? prod.price;

    const updates = {};
    if (prod.stockStatus !== newStock) {
      updates.stockStatus = newStock;
      stockFixed++;
    }
    if (newPrice != null && prod.price == null) {
      updates.price = newPrice;
      priceFixed++;
    }
    if (Object.keys(updates).length > 0) {
      await p.productIndex.update({ where: { id: prod.id }, data: updates });
    }
  }
  console.log(`Stock fixed: ${stockFixed} | Price fixed: ${priceFixed}`);

  // ── PHASE 2: Thumbnails from WP REST API with _embed ──────────────────────
  console.log('\n=== PHASE 2: Thumbnails from WP REST API ===');
  const noThumb = await p.productIndex.findMany({
    where: { siteId: site.id, thumbnail: null },
    select: { id: true, url: true },
  });
  console.log(`Products missing thumbnails: ${noThumb.length}`);

  let thumbUpdated = 0;
  let noImage = 0;
  let errors = 0;

  for (let i = 0; i < noThumb.length; i++) {
    const prod = noThumb[i];
    const slug = prod.url.replace(/\/$/, '').split('/').pop();
    if (!slug) continue;

    try {
      const resp = await axios.get(`${ORIGIN}/wp-json/wp/v2/product`, {
        params: { slug, _embed: 'wp:featuredmedia' },
        timeout: 15000,
        validateStatus: (s) => s === 200,
      });
      const wpProd = resp.data?.[0];
      if (!wpProd) { noImage++; continue; }

      const embedded = wpProd._embedded?.['wp:featuredmedia']?.[0];
      const thumb = embedded?.media_details?.sizes?.thumbnail?.source_url
        || embedded?.media_details?.sizes?.medium?.source_url
        || embedded?.source_url;

      if (thumb) {
        await p.productIndex.update({ where: { id: prod.id }, data: { thumbnail: thumb } });
        thumbUpdated++;
      } else {
        noImage++;
      }
    } catch {
      errors++;
    }

    if ((i + 1) % 50 === 0 || i === noThumb.length - 1) {
      process.stdout.write(`  ${i + 1}/${noThumb.length}: ${thumbUpdated} updated, ${noImage} no image, ${errors} errors\r`);
    }
    await new Promise(r => setTimeout(r, 800));
  }

  // ── Final Summary ──────────────────────────────────────────────────────────
  console.log('\n\n=== FINAL COUNTS ===');
  const counts = {
    inStock: await p.productIndex.count({ where: { siteId: site.id, stockStatus: 'in_stock' } }),
    outStock: await p.productIndex.count({ where: { siteId: site.id, stockStatus: 'out_of_stock' } }),
    unknown: await p.productIndex.count({ where: { siteId: site.id, stockStatus: 'unknown' } }),
    nullStock: await p.productIndex.count({ where: { siteId: site.id, stockStatus: null } }),
    noThumb: await p.productIndex.count({ where: { siteId: site.id, thumbnail: null } }),
    noPrice: await p.productIndex.count({ where: { siteId: site.id, price: null } }),
  };
  console.log(`In stock: ${counts.inStock} | Out of stock: ${counts.outStock} | Unknown: ${counts.unknown} | Null: ${counts.nullStock}`);
  console.log(`Missing thumbnails: ${counts.noThumb} | Missing price: ${counts.noPrice}`);

  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
