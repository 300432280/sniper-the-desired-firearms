const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const p = new PrismaClient();

const URLS = [
  'https://budgetshootersupply.ca/product/rcbs-7mmx57-mauser-neck-sizer-die-group-a/',
  'https://budgetshootersupply.ca/product/lee-7x57-mauser-collet-neck-die/',
  'https://budgetshootersupply.ca/product/norma-brass-7x57-mauser-50-box/',
  'https://budgetshootersupply.ca/product/hornady-303-british-modified-case/',
  'https://budgetshootersupply.ca/product/lee-7mmx57-mauser-3-die-set-w-fact-crimp-s-h-2/',
  'https://budgetshootersupply.ca/product/rcbs-65-mm-55-swedish-mauser-fl-die-set-group-a-gently-used/',
  'https://budgetshootersupply.ca/product/previously-fired-mixed-headstamp-polished-8mm-mauser-20-bag/',
];

(async () => {
  const site = await p.monitoredSite.findFirst({ where: { domain: 'budgetshootersupply.ca' } });

  for (const url of URLS) {
    const pi = await p.productIndex.findFirst({
      where: { siteId: site.id, url },
      select: { id: true, price: true, thumbnail: true, stockStatus: true, title: true },
    });
    if (!pi) { console.log('NOT FOUND:', url); continue; }

    const updates = {};
    console.log(`\n${pi.title.slice(0, 55)}`);
    console.log(`  Before: price=${pi.price} thumb=${pi.thumbnail ? 'yes' : 'no'} stock=${pi.stockStatus}`);

    // Scrape product page for missing data
    if (!pi.price || !pi.thumbnail || !pi.stockStatus) {
      try {
        const resp = await axios.get(url, { timeout: 15000 });
        const html = resp.data;

        // Price
        if (!pi.price) {
          const bdi = html.match(/<bdi[^>]*>\s*\$?\s*([\d,]+\.?\d*)\s*<\/bdi>/);
          if (bdi) updates.price = parseFloat(bdi[1].replace(/,/g, ''));
          if (!updates.price) {
            const ld = html.match(/"price"\s*:\s*"?([\d.]+)"?/);
            if (ld) updates.price = parseFloat(ld[1]);
          }
        }

        // Thumbnail
        if (!pi.thumbnail) {
          const og = html.match(/property="og:image"\s+content="([^"]+)"/);
          if (og && !/logo|placeholder/i.test(og[1])) updates.thumbnail = og[1];
          if (!updates.thumbnail) {
            const gallery = html.match(/data-large_image="([^"]+)"/);
            if (gallery && !/logo|placeholder/i.test(gallery[1])) updates.thumbnail = gallery[1];
          }
        }

        // Stock
        if (!pi.stockStatus) {
          const oos = /out[- ]of[- ]stock|sold[- ]?out/i.test(html);
          const cartBtn = /add[_-]to[_-]cart/i.test(html);
          if (oos) updates.stockStatus = 'out_of_stock';
          else if (cartBtn) updates.stockStatus = 'in_stock';
          else updates.stockStatus = 'out_of_stock'; // default assumption
        }

        await new Promise(r => setTimeout(r, 1500));
      } catch (e) {
        console.log('  Fetch error:', e.message);
        if (!pi.stockStatus) updates.stockStatus = 'out_of_stock';
      }
    }

    if (Object.keys(updates).length > 0) {
      await p.productIndex.update({ where: { id: pi.id }, data: updates });
      console.log('  Updated:', JSON.stringify(updates).slice(0, 120));
    } else {
      console.log('  No updates needed');
    }
  }

  // Also update Match records with prices from ProductIndex where match has null price
  console.log('\n=== Updating Match prices from ProductIndex ===');
  const search = await p.search.findFirst({
    where: { websiteUrl: { contains: 'budgetshootersupply' }, keyword: { contains: 'mauser', mode: 'insensitive' } },
  });
  if (search) {
    const matches = await p.match.findMany({
      where: { searchId: search.id, price: null },
      select: { id: true, url: true, title: true },
    });
    let updated = 0;
    for (const m of matches) {
      const pi = await p.productIndex.findFirst({
        where: { siteId: site.id, url: m.url },
        select: { price: true },
      });
      if (pi?.price) {
        await p.match.update({ where: { id: m.id }, data: { price: pi.price } });
        console.log(`  ${m.title.slice(0, 50)}: price=${pi.price}`);
        updated++;
      }
    }
    console.log(`Updated ${updated} match prices`);
  }

  await p.$disconnect();
})();
