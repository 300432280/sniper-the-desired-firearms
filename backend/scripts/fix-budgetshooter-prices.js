/**
 * Fix missing prices for budgetshootersupply.ca by scraping product pages.
 * WP REST API doesn't expose prices, and Store API only has in-stock items.
 */
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const p = new PrismaClient();

const DOMAIN = 'budgetshootersupply.ca';

async function main() {
  const site = await p.monitoredSite.findFirst({ where: { domain: DOMAIN } });
  if (!site) { console.log('Site not found'); process.exit(1); }

  const noPrice = await p.productIndex.findMany({
    where: { siteId: site.id, price: null },
    select: { id: true, url: true, title: true },
  });
  console.log(`Products missing price: ${noPrice.length}`);

  let updated = 0;
  let notFound = 0;
  let errors = 0;

  for (let i = 0; i < noPrice.length; i++) {
    const prod = noPrice[i];
    try {
      const resp = await axios.get(prod.url, { timeout: 15000, validateStatus: (s) => s === 200 });
      const html = resp.data;

      // Try multiple patterns to extract price
      // Pattern 1: <bdi> with woocommerce price amount
      let price = null;
      const bdiMatch = html.match(/<bdi[^>]*>\s*\$?\s*([\d,]+\.?\d*)\s*<\/bdi>/);
      if (bdiMatch) {
        price = parseFloat(bdiMatch[1].replace(/,/g, ''));
      }

      // Pattern 2: meta tag
      if (!price) {
        const metaMatch = html.match(/property="product:price:amount"\s+content="([^"]+)"/);
        if (metaMatch) price = parseFloat(metaMatch[1]);
      }

      // Pattern 3: woocommerce-Price-amount
      if (!price) {
        const wcMatch = html.match(/woocommerce-Price-amount[^>]*>.*?\$([\d,]+\.?\d*)/s);
        if (wcMatch) price = parseFloat(wcMatch[1].replace(/,/g, ''));
      }

      // Pattern 4: JSON-LD
      if (!price) {
        const ldMatch = html.match(/"price"\s*:\s*"?([\d.]+)"?/);
        if (ldMatch) price = parseFloat(ldMatch[1]);
      }

      if (price && price > 0) {
        await p.productIndex.update({ where: { id: prod.id }, data: { price } });
        updated++;
      } else {
        notFound++;
      }
    } catch {
      errors++;
    }

    if ((i + 1) % 50 === 0 || i === noPrice.length - 1) {
      process.stdout.write(`  ${i + 1}/${noPrice.length}: ${updated} priced, ${notFound} no price, ${errors} errors\r`);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n\nDone: ${updated} prices set, ${notFound} no price found, ${errors} errors`);
  const stillMissing = await p.productIndex.count({ where: { siteId: site.id, price: null } });
  console.log(`Still missing price: ${stillMissing}`);

  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
