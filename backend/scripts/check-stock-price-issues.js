const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const p = new PrismaClient();

async function main() {
  const site = await p.monitoredSite.findFirst({ where: { domain: 'budgetshootersupply.ca' } });

  // 1. Check the specific product user reported
  console.log('=== Specific product: lee-7x57-mauser-collet-neck-die ===');
  const prod = await p.productIndex.findFirst({
    where: { siteId: site.id, url: { contains: 'lee-7x57-mauser-collet-neck-die' } },
    select: { id: true, title: true, url: true, price: true, stockStatus: true, thumbnail: true },
  });
  if (prod) {
    console.log('DB:', JSON.stringify({ title: prod.title, price: prod.price, stock: prod.stockStatus }));
  } else {
    console.log('Not found in DB');
  }

  // Check live status
  try {
    const resp = await axios.get('https://budgetshootersupply.ca/product/lee-7x57-mauser-collet-neck-die/', { timeout: 15000 });
    const html = resp.data;
    const ogPrice = html.match(/property="product:price:amount"\s+content="([^"]+)"/);
    const bdiPrice = html.match(/<bdi[^>]*>\s*\$?\s*([\d,]+\.?\d*)\s*<\/bdi>/);
    const stockBadge = html.match(/class="[^"]*stock[^"]*"[^>]*>([^<]+)</i);
    const outOfStock = /out[- ]of[- ]stock|sold[- ]out|unavailable/i.test(html);
    const cartBtn = html.match(/add[_-]to[_-]cart|type="submit"[^>]*>([^<]*)</i);
    console.log('Live: ogPrice=' + (ogPrice?.[1] || 'NONE') + ', bdiPrice=' + (bdiPrice?.[1] || 'NONE'));
    console.log('Live: stockBadge=' + (stockBadge?.[1]?.trim() || 'NONE') + ', outOfStockSignal=' + outOfStock);
    console.log('Live: cartButton=' + (cartBtn?.[1]?.trim() || 'check HTML'));
  } catch (e) { console.log('Fetch error:', e.message); }

  // 2. Check how many in_stock items are actually sold out on website
  console.log('\n=== Spot-check: DB says in_stock but website says sold out ===');
  const inStockProducts = await p.productIndex.findMany({
    where: { siteId: site.id, stockStatus: 'in_stock', isActive: true },
    select: { id: true, url: true, title: true, price: true },
    take: 30, // sample
    orderBy: { lastSeenAt: 'desc' },
  });

  // Cross-check with Store API (which only returns truly in-stock items)
  const storeUrls = new Set();
  let page = 1;
  let pages = 1;
  while (page <= pages) {
    const resp = await axios.get('https://budgetshootersupply.ca/wp-json/wc/store/v1/products', {
      params: { per_page: 100, page },
      timeout: 20000,
      validateStatus: (s) => s === 200,
    });
    if (page === 1) pages = parseInt(resp.headers['x-wp-totalpages'] || '1', 10);
    for (const p2 of resp.data) {
      storeUrls.add(p2.permalink);
      storeUrls.add((p2.permalink || '').replace(/\/$/, ''));
    }
    page++;
    await new Promise(r => setTimeout(r, 800));
  }
  console.log('Store API total in-stock URLs:', storeUrls.size / 2);

  const allInStock = await p.productIndex.findMany({
    where: { siteId: site.id, stockStatus: 'in_stock', isActive: true },
    select: { id: true, url: true, title: true },
  });

  let wrongStock = 0;
  const wrongList = [];
  for (const p2 of allInStock) {
    if (!storeUrls.has(p2.url) && !storeUrls.has(p2.url.replace(/\/$/, ''))) {
      wrongStock++;
      if (wrongList.length < 10) wrongList.push(p2.title.slice(0, 60) + ' | ' + p2.url);
    }
  }
  console.log(`\nDB in_stock: ${allInStock.length} | Actually in stock (Store API): ${storeUrls.size / 2}`);
  console.log(`Wrong stock status (DB=in_stock, not in Store API): ${wrongStock}`);
  for (const w of wrongList) console.log('  ' + w);

  // 3. Check sold-out items missing prices
  console.log('\n=== Out-of-stock items missing price ===');
  const oosNoPrice = await p.productIndex.count({
    where: { siteId: site.id, stockStatus: 'out_of_stock', price: null, isActive: true },
  });
  const oosWithPrice = await p.productIndex.count({
    where: { siteId: site.id, stockStatus: 'out_of_stock', price: { not: null }, isActive: true },
  });
  console.log(`OOS with price: ${oosWithPrice} | OOS without price: ${oosNoPrice}`);

  await p.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
