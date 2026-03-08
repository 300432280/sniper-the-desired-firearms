/**
 * One-time backfill: fetch all products from alsimmonsgunshop.com
 * via WP REST API + Store API enrichment, insert into ProductIndex.
 */
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const p = new PrismaClient();

const ORIGIN = 'https://alsimmonsgunshop.com';
const PER_PAGE = 100;

function decodeHtml(str) {
  return str
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#8243;/g, '"')
    .replace(/&#8220;/g, '\u201C').replace(/&#8221;/g, '\u201D')
    .replace(/&rsquo;/g, '\u2019').replace(/&lsquo;/g, '\u2018')
    .replace(/&ndash;/g, '\u2013').replace(/&mdash;/g, '\u2014');
}

(async () => {
  const site = await p.monitoredSite.findFirst({ where: { domain: 'alsimmonsgunshop.com' } });
  if (!site) { console.log('Site not found'); process.exit(1); }

  console.log('=== Backfill alsimmonsgunshop.com ===');
  console.log('Site ID:', site.id);

  // 1. Fetch ALL products from WP REST API
  const allProducts = new Map(); // URL → product data
  let page = 1;
  let totalPages = 1;

  console.log('\n--- Fetching WP REST API (all published products) ---');
  while (page <= totalPages) {
    try {
      const resp = await axios.get(`${ORIGIN}/wp-json/wp/v2/product`, {
        params: { per_page: PER_PAGE, page, orderby: 'date', order: 'desc' },
        timeout: 20000,
        validateStatus: (s) => s === 200,
      });

      if (page === 1) {
        totalPages = parseInt(resp.headers['x-wp-totalpages'] || '1', 10);
        console.log(`Total pages: ${totalPages}, Total products: ${resp.headers['x-wp-total']}`);
      }

      for (const prod of resp.data) {
        const url = prod.link || `${ORIGIN}/?p=${prod.id}`;
        if (/\/product-category\//i.test(url)) continue;
        allProducts.set(url, {
          url,
          title: decodeHtml(prod.title?.rendered || '').slice(0, 160),
          price: undefined,
          stockStatus: 'unknown',
          thumbnail: undefined,
        });
      }

      process.stdout.write(`  Page ${page}/${totalPages}: ${allProducts.size} products so far\r`);
      page++;

      // Small delay to be polite
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.log(`\n  Error on page ${page}: ${err.message}`);
      break;
    }
  }
  console.log(`\nWP REST API: ${allProducts.size} products from ${page - 1} pages`);

  // 2. Fetch Store API products for enrichment (prices, thumbnails, stock)
  console.log('\n--- Fetching Store API (in-stock enrichment) ---');
  let storePage = 1;
  let storeTotal = 1;
  let enriched = 0;

  while (storePage <= storeTotal) {
    try {
      const resp = await axios.get(`${ORIGIN}/wp-json/wc/store/v1/products`, {
        params: { per_page: PER_PAGE, page: storePage, orderby: 'date', order: 'desc' },
        timeout: 20000,
        validateStatus: (s) => s === 200,
      });

      if (storePage === 1) {
        storeTotal = parseInt(resp.headers['x-wp-totalpages'] || '1', 10);
        console.log(`Store API pages: ${storeTotal}`);
      }

      for (const prod of resp.data) {
        const url = prod.permalink || `${ORIGIN}/?p=${prod.id}`;
        if (/\/product-category\//i.test(url)) continue;

        const existing = allProducts.get(url);
        const price = prod.prices?.price ? parseInt(prod.prices.price, 10) / 100 : undefined;
        const thumbnail = prod.images?.[0]?.src || prod.images?.[0]?.thumbnail || undefined;
        const stockStatus = prod.is_purchasable !== false ? 'in_stock' : 'out_of_stock';

        allProducts.set(url, {
          url,
          title: decodeHtml(prod.name || '').slice(0, 160),
          price,
          stockStatus,
          thumbnail,
          ...(existing ? {} : {}), // Store API data takes priority
        });
        enriched++;
      }

      process.stdout.write(`  Store page ${storePage}/${storeTotal}: ${enriched} enriched\r`);
      storePage++;
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.log(`\n  Store API error on page ${storePage}: ${err.message}`);
      break;
    }
  }
  console.log(`\nStore API: ${enriched} products enriched with prices/thumbnails/stock`);

  // 3. Upsert all products into ProductIndex
  console.log(`\n--- Inserting ${allProducts.size} products into ProductIndex ---`);
  let inserted = 0;
  let updated = 0;
  let errors = 0;

  for (const [url, prod] of allProducts) {
    try {
      const result = await p.productIndex.upsert({
        where: { siteId_url: { siteId: site.id, url } },
        update: {
          title: prod.title,
          price: prod.price ?? null,
          stockStatus: prod.stockStatus ?? null,
          thumbnail: prod.thumbnail ?? null,
          lastSeenAt: new Date(),
          isActive: true,
        },
        create: {
          siteId: site.id,
          url,
          title: prod.title,
          price: prod.price ?? null,
          stockStatus: prod.stockStatus ?? null,
          thumbnail: prod.thumbnail ?? null,
        },
      });

      if (result.firstSeenAt.getTime() === result.lastSeenAt.getTime()) {
        inserted++;
      } else {
        updated++;
      }
    } catch (err) {
      errors++;
    }

    if ((inserted + updated + errors) % 100 === 0) {
      process.stdout.write(`  Progress: ${inserted} new, ${updated} updated, ${errors} errors\r`);
    }
  }

  console.log(`\n\n=== RESULTS ===`);
  console.log(`New products inserted: ${inserted}`);
  console.log(`Existing products updated: ${updated}`);
  console.log(`Errors: ${errors}`);

  const finalCount = await p.productIndex.count({ where: { siteId: site.id } });
  console.log(`Total products in DB: ${finalCount}`);

  await p.$disconnect();
})();
