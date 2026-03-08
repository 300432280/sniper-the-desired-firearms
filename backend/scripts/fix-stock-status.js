/**
 * Fix stock status: fetch all in-stock product URLs from Store API,
 * then mark everything else as out_of_stock.
 */
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const p = new PrismaClient();

const ORIGIN = 'https://alsimmonsgunshop.com';

(async () => {
  const site = await p.monitoredSite.findFirst({ where: { domain: 'alsimmonsgunshop.com' } });
  if (!site) { console.log('Site not found'); process.exit(1); }

  // 1. Fetch all in-stock product URLs from Store API
  const inStockUrls = new Set();
  let page = 1;
  let totalPages = 1;

  console.log('Fetching Store API (in-stock products)...');
  while (page <= totalPages) {
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
      const url = prod.permalink || `${ORIGIN}/?p=${prod.id}`;
      inStockUrls.add(url);
    }
    page++;
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log(`In-stock URLs collected: ${inStockUrls.size}`);

  // 2. Update all products: in Store API = in_stock, not = out_of_stock
  const allProducts = await p.productIndex.findMany({
    where: { siteId: site.id },
    select: { id: true, url: true, stockStatus: true },
  });

  let setInStock = 0;
  let setOutOfStock = 0;
  let unchanged = 0;

  for (const prod of allProducts) {
    const shouldBe = inStockUrls.has(prod.url) ? 'in_stock' : 'out_of_stock';
    if (prod.stockStatus !== shouldBe) {
      await p.productIndex.update({
        where: { id: prod.id },
        data: { stockStatus: shouldBe },
      });
      if (shouldBe === 'in_stock') setInStock++;
      else setOutOfStock++;
    } else {
      unchanged++;
    }
  }

  console.log(`\n=== RESULTS ===`);
  console.log(`Set to in_stock:     ${setInStock}`);
  console.log(`Set to out_of_stock: ${setOutOfStock}`);
  console.log(`Unchanged:           ${unchanged}`);
  console.log(`Total:               ${allProducts.length}`);

  // Verify
  const inStock = await p.productIndex.count({ where: { siteId: site.id, stockStatus: 'in_stock' } });
  const outStock = await p.productIndex.count({ where: { siteId: site.id, stockStatus: 'out_of_stock' } });
  const unknown = await p.productIndex.count({ where: { siteId: site.id, stockStatus: 'unknown' } });
  console.log(`\nFinal: ${inStock} in_stock, ${outStock} out_of_stock, ${unknown} unknown`);

  await p.$disconnect();
})();
