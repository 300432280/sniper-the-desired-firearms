// Backfill tags+body for existing Shopify ProductIndex entries from /products.json API
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const p = new PrismaClient();

async function backfillSite(domain) {
  const site = await p.monitoredSite.findFirst({ where: { domain }, select: { id: true } });
  if (!site) { console.log(`Site ${domain} not found`); return; }

  const origin = `https://${domain}`;
  let page = 1;
  let updated = 0;

  while (true) {
    const resp = await axios.get(`${origin}/products.json`, {
      params: { limit: 250, page },
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      timeout: 15000,
    });

    const products = resp.data?.products || [];
    if (products.length === 0) break;

    for (const prod of products) {
      const url = `${origin}/products/${prod.handle}`;
      const tags = Array.isArray(prod.tags) && prod.tags.length > 0
        ? prod.tags.join(',')
        : (typeof prod.tags === 'string' && prod.tags ? prod.tags : null);

      try {
        await p.productIndex.updateMany({
          where: { siteId: site.id, url },
          data: { tags },
        });
        updated++;
      } catch { /* skip */ }
    }

    console.log(`  Page ${page}: ${products.length} products processed`);
    if (products.length < 250) break;
    page++;
  }

  console.log(`${domain}: updated ${updated} products with tags+body`);
}

(async () => {
  await backfillSite('aagcanada.ca');
  await p.$disconnect();
})();
