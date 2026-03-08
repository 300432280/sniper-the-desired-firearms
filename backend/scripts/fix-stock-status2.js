/**
 * Re-run stock status fix for alsimmonsgunshop: fetch all in-stock URLs
 * from Store API, then set null/unknown entries to in_stock or out_of_stock.
 */
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const p = new PrismaClient();

const ORIGIN = 'https://alsimmonsgunshop.com';

(async () => {
  const site = await p.monitoredSite.findFirst({ where: { domain: 'alsimmonsgunshop.com' } });
  if (!site) { console.log('Site not found'); process.exit(1); }

  // Build in-stock lookup from Store API
  const inStockUrls = new Set();
  const inStockTitles = new Set();
  let page = 1;
  let totalPages = 1;

  console.log('Fetching Store API...');
  while (page <= totalPages) {
    const resp = await axios.get(`${ORIGIN}/wp-json/wc/store/v1/products`, {
      params: { per_page: 100, page },
      timeout: 20000,
      validateStatus: (s) => s === 200,
    });
    if (page === 1) {
      totalPages = parseInt(resp.headers['x-wp-totalpages'] || '1', 10);
      console.log(`${resp.headers['x-wp-total']} in-stock products, ${totalPages} pages`);
    }
    for (const prod of resp.data) {
      const url = prod.permalink || '';
      inStockUrls.add(url);
      inStockUrls.add(url.replace(/\/$/, ''));
      const name = (prod.name || '').toLowerCase().trim();
      if (name) inStockTitles.add(name);
    }
    page++;
    await new Promise(r => setTimeout(r, 2000));
  }

  // Fix null and unknown stock status
  const toFix = await p.productIndex.findMany({
    where: { siteId: site.id, OR: [{ stockStatus: null }, { stockStatus: 'unknown' }] },
    select: { id: true, url: true, title: true, stockStatus: true },
  });
  console.log(`\n${toFix.length} products with null/unknown stock`);

  let setIn = 0, setOut = 0;
  for (const prod of toFix) {
    const urlMatch = inStockUrls.has(prod.url) || inStockUrls.has(prod.url.replace(/\/$/, ''));
    const titleMatch = inStockTitles.has((prod.title || '').toLowerCase().trim());
    const newStatus = (urlMatch || titleMatch) ? 'in_stock' : 'out_of_stock';
    await p.productIndex.update({ where: { id: prod.id }, data: { stockStatus: newStatus } });
    if (newStatus === 'in_stock') setIn++;
    else setOut++;
  }

  console.log(`Fixed: ${setIn} → in_stock, ${setOut} → out_of_stock`);

  // Final counts
  const inStock = await p.productIndex.count({ where: { siteId: site.id, stockStatus: 'in_stock' } });
  const outStock = await p.productIndex.count({ where: { siteId: site.id, stockStatus: 'out_of_stock' } });
  const unknown = await p.productIndex.count({ where: { siteId: site.id, stockStatus: 'unknown' } });
  const nullC = await p.productIndex.count({ where: { siteId: site.id, stockStatus: null } });
  console.log(`\nFinal: ${inStock} in_stock, ${outStock} out_of_stock, ${unknown} unknown, ${nullC} null`);

  await p.$disconnect();
})();
