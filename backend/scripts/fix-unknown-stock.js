/**
 * Fix remaining 'unknown' stock: check each product URL against the Store API
 * by searching for the product name, since URL matching has mismatches.
 */
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const p = new PrismaClient();

const ORIGIN = 'https://alsimmonsgunshop.com';

(async () => {
  const site = await p.monitoredSite.findFirst({ where: { domain: 'alsimmonsgunshop.com' } });
  if (!site) { console.log('Site not found'); process.exit(1); }

  // Build a complete set of in-stock product URLs from Store API
  // Use BOTH permalink AND search to handle URL mismatches
  const inStockUrls = new Set();
  const inStockTitles = new Set();
  let page = 1;
  let totalPages = 1;

  console.log('Building in-stock lookup from Store API...');
  while (page <= totalPages) {
    const resp = await axios.get(`${ORIGIN}/wp-json/wc/store/v1/products`, {
      params: { per_page: 100, page },
      timeout: 20000,
      validateStatus: (s) => s === 200,
    });
    if (page === 1) {
      totalPages = parseInt(resp.headers['x-wp-totalpages'] || '1', 10);
      console.log(`${resp.headers['x-wp-total']} in-stock products`);
    }
    for (const prod of resp.data) {
      const url = prod.permalink || '';
      inStockUrls.add(url);
      // Normalize URL: remove trailing slash, lowercase
      inStockUrls.add(url.replace(/\/$/, ''));
      // Also store title for fuzzy matching
      const name = (prod.name || '').toLowerCase().trim();
      if (name) inStockTitles.add(name);
    }
    page++;
    await new Promise(r => setTimeout(r, 2000));
  }

  // Get all products with unknown or null stock
  const unknowns = await p.productIndex.findMany({
    where: { siteId: site.id, stockStatus: { in: ['unknown'] } },
    select: { id: true, url: true, title: true, stockStatus: true },
  });
  console.log(`\n${unknowns.length} products with unknown stock status`);

  const nullStock = await p.productIndex.findMany({
    where: { siteId: site.id, stockStatus: null },
    select: { id: true, url: true, title: true },
  });
  console.log(`${nullStock.length} products with null stock status`);

  const allToFix = [...unknowns, ...nullStock];
  let setInStock = 0;
  let setOutOfStock = 0;

  for (const prod of allToFix) {
    const urlMatch = inStockUrls.has(prod.url) || inStockUrls.has(prod.url.replace(/\/$/, ''));
    const titleMatch = inStockTitles.has((prod.title || '').toLowerCase().trim());
    const isInStock = urlMatch || titleMatch;

    const newStatus = isInStock ? 'in_stock' : 'out_of_stock';
    await p.productIndex.update({
      where: { id: prod.id },
      data: { stockStatus: newStatus },
    });

    if (isInStock) setInStock++;
    else setOutOfStock++;
  }

  console.log(`\nFixed: ${setInStock} → in_stock, ${setOutOfStock} → out_of_stock`);

  // Final counts
  const inStock = await p.productIndex.count({ where: { siteId: site.id, stockStatus: 'in_stock' } });
  const outStock = await p.productIndex.count({ where: { siteId: site.id, stockStatus: 'out_of_stock' } });
  const unknown = await p.productIndex.count({ where: { siteId: site.id, stockStatus: 'unknown' } });
  const nullCount = await p.productIndex.count({ where: { siteId: site.id, stockStatus: null } });
  console.log(`\nFinal: ${inStock} in_stock, ${outStock} out_of_stock, ${unknown} unknown, ${nullCount} null`);

  await p.$disconnect();
})();
