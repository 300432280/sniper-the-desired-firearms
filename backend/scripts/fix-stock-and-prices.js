/**
 * Fix stock status and prices for budgetshootersupply.ca:
 * 1. Cross-check all in_stock items against Store API, flip incorrect ones
 * 2. Fix null stock status items using Store API
 * 3. Scrape prices for remaining out-of-stock items missing prices
 */
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const p = new PrismaClient();

const DOMAIN = 'budgetshootersupply.ca';
const ORIGIN = 'https://' + DOMAIN;

async function main() {
  const site = await p.monitoredSite.findFirst({ where: { domain: DOMAIN } });
  if (!site) { console.log('Site not found'); process.exit(1); }

  // Phase 1: Build Store API in-stock set with prices
  console.log('=== Phase 1: Build Store API index ===');
  const storeData = new Map(); // url -> { price }
  let page = 1, pages = 1;
  while (page <= pages) {
    const resp = await axios.get(`${ORIGIN}/wp-json/wc/store/v1/products`, {
      params: { per_page: 100, page },
      timeout: 20000,
      validateStatus: (s) => s === 200,
    });
    if (page === 1) {
      pages = parseInt(resp.headers['x-wp-totalpages'] || '1', 10);
      console.log(`Store API: ${resp.headers['x-wp-total']} in-stock, ${pages} pages`);
    }
    for (const prod of resp.data) {
      const url = prod.permalink || '';
      const price = prod.prices?.price ? parseInt(prod.prices.price, 10) / 100 : null;
      storeData.set(url, { price });
      storeData.set(url.replace(/\/$/, ''), { price });
    }
    page++;
    await new Promise(r => setTimeout(r, 800));
  }

  // Phase 2: Fix stock status
  console.log('\n=== Phase 2: Fix stock status ===');
  const allProducts = await p.productIndex.findMany({
    where: { siteId: site.id, isActive: true },
    select: { id: true, url: true, stockStatus: true, price: true },
  });

  let stockFixed = 0, priceFixed = 0, nullFixed = 0;
  for (const prod of allProducts) {
    const inStore = storeData.has(prod.url) || storeData.has(prod.url.replace(/\/$/, ''));
    const storeInfo = storeData.get(prod.url) || storeData.get(prod.url.replace(/\/$/, ''));
    const updates = {};

    // Fix wrong stock status
    if (prod.stockStatus === 'in_stock' && !inStore) {
      updates.stockStatus = 'out_of_stock';
      stockFixed++;
    } else if (inStore && prod.stockStatus !== 'in_stock') {
      updates.stockStatus = 'in_stock';
      if (prod.stockStatus === null) nullFixed++;
      stockFixed++;
    } else if (!inStore && !prod.stockStatus) {
      updates.stockStatus = 'out_of_stock';
      nullFixed++;
    }

    // Fix missing price from Store API
    if (prod.price === null && storeInfo?.price) {
      updates.price = storeInfo.price;
      priceFixed++;
    }

    if (Object.keys(updates).length > 0) {
      await p.productIndex.update({ where: { id: prod.id }, data: updates });
    }
  }
  console.log(`Stock fixed: ${stockFixed} (${nullFixed} were null) | Prices from Store API: ${priceFixed}`);

  // Phase 3: Scrape prices for remaining OOS items without price
  console.log('\n=== Phase 3: Scrape prices for OOS items ===');
  const oosNoPrice = await p.productIndex.findMany({
    where: { siteId: site.id, stockStatus: 'out_of_stock', price: null, isActive: true },
    select: { id: true, url: true, title: true },
  });
  console.log(`OOS items still missing price: ${oosNoPrice.length}`);

  let scraped = 0, noPrice = 0, errors = 0;
  for (let i = 0; i < oosNoPrice.length; i++) {
    const prod = oosNoPrice[i];
    try {
      const resp = await axios.get(prod.url, { timeout: 15000, validateStatus: (s) => s === 200 });
      const html = resp.data;
      let price = null;

      const bdi = html.match(/<bdi[^>]*>\s*\$?\s*([\d,]+\.?\d*)\s*<\/bdi>/);
      if (bdi) price = parseFloat(bdi[1].replace(/,/g, ''));

      if (!price) {
        const meta = html.match(/property="product:price:amount"\s+content="([^"]+)"/);
        if (meta) price = parseFloat(meta[1]);
      }

      if (!price) {
        const wc = html.match(/woocommerce-Price-amount[^>]*>.*?\$([\d,]+\.?\d*)/s);
        if (wc) price = parseFloat(wc[1].replace(/,/g, ''));
      }

      if (!price) {
        const ld = html.match(/"price"\s*:\s*"?([\d.]+)"?/);
        if (ld) price = parseFloat(ld[1]);
      }

      if (price && price > 0) {
        await p.productIndex.update({ where: { id: prod.id }, data: { price } });
        scraped++;
      } else {
        noPrice++;
      }
    } catch {
      errors++;
    }
    if ((i + 1) % 10 === 0 || i === oosNoPrice.length - 1) {
      process.stdout.write(`  ${i + 1}/${oosNoPrice.length}: ${scraped} priced, ${noPrice} no price, ${errors} errors\r`);
    }
    await new Promise(r => setTimeout(r, 600));
  }

  // Final counts
  console.log('\n\n=== FINAL ===');
  const finalNoPrice = await p.productIndex.count({ where: { siteId: site.id, price: null, isActive: true } });
  const finalNullStock = await p.productIndex.count({ where: { siteId: site.id, stockStatus: null, isActive: true } });
  const finalInStock = await p.productIndex.count({ where: { siteId: site.id, stockStatus: 'in_stock', isActive: true } });
  const finalOos = await p.productIndex.count({ where: { siteId: site.id, stockStatus: 'out_of_stock', isActive: true } });
  console.log(`In stock: ${finalInStock} | Out of stock: ${finalOos} | Null stock: ${finalNullStock} | Missing price: ${finalNoPrice}`);

  await p.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
