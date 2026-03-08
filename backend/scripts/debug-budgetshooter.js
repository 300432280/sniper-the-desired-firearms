const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const p = new PrismaClient();

const DOMAIN = 'budgetshootersupply.ca';
const ORIGIN = 'https://' + DOMAIN;

async function main() {
  const site = await p.monitoredSite.findFirst({ where: { domain: DOMAIN } });

  // 1. Check how many "mauser" products exist on the live site
  console.log('=== Live site mauser search ===');
  let liveMatches = [];
  let wpPage = 1;
  let wpTotalPages = 1;
  while (wpPage <= wpTotalPages) {
    const resp = await axios.get(`${ORIGIN}/wp-json/wp/v2/product`, {
      params: { per_page: 100, page: wpPage, search: 'mauser' },
      timeout: 15000,
      validateStatus: (s) => s === 200,
    });
    if (wpPage === 1) {
      wpTotalPages = parseInt(resp.headers['x-wp-totalpages'] || '1', 10);
      console.log('WP REST API search "mauser": total=' + resp.headers['x-wp-total']);
    }
    for (const prod of resp.data) {
      liveMatches.push({ title: prod.title?.rendered, url: prod.link });
    }
    wpPage++;
    await new Promise(r => setTimeout(r, 1000));
  }

  // 2. Check our matches
  const searches = await p.search.findMany({
    where: { keyword: { contains: 'mauser', mode: 'insensitive' }, websiteUrl: { contains: DOMAIN } },
  });
  let ourMatches = [];
  for (const s of searches) {
    const matches = await p.match.findMany({
      where: { searchId: s.id },
      select: { title: true, url: true, price: true },
    });
    ourMatches.push(...matches);
  }
  console.log('Our matches:', ourMatches.length);

  // 3. Find what's in live but not in our matches
  const ourUrls = new Set(ourMatches.map(m => m.url));
  const ourUrlsTrimmed = new Set(ourMatches.map(m => m.url.replace(/\/$/, '')));
  console.log('\n=== Missing from our matches ===');
  let missing = 0;
  for (const live of liveMatches) {
    if (!ourUrls.has(live.url) && !ourUrlsTrimmed.has(live.url) && !ourUrls.has(live.url + '/') && !ourUrlsTrimmed.has(live.url.replace(/\/$/, ''))) {
      // Check if it's in ProductIndex
      const pi = await p.productIndex.findFirst({ where: { url: live.url } });
      const piTrim = !pi ? await p.productIndex.findFirst({ where: { url: live.url.replace(/\/$/, '') } }) : null;
      const inIdx = pi || piTrim;
      console.log('MISSING: ' + (live.title || '').slice(0, 60));
      console.log('  URL: ' + live.url);
      console.log('  In ProductIndex: ' + (inIdx ? 'YES (stock: ' + inIdx.stockStatus + ')' : 'NO'));
      missing++;
    }
  }
  if (missing === 0) console.log('None missing from WP search results');

  // 4. Check prices - sample some out-of-stock products with missing prices
  console.log('\n=== Out-of-stock products missing prices ===');
  const noPrice = await p.productIndex.findMany({
    where: { siteId: site.id, price: null, stockStatus: 'out_of_stock', title: { contains: 'mauser', mode: 'insensitive' } },
    select: { id: true, url: true, title: true },
    take: 3,
  });
  for (const prod of noPrice) {
    // Check the actual product page for price
    try {
      const resp = await axios.get(prod.url, { timeout: 15000 });
      const priceMatch = resp.data.match(/class="[^"]*woocommerce-Price-amount[^"]*"[^>]*>.*?(\d[\d,.]+)/s);
      const metaPrice = resp.data.match(/property="product:price:amount"\s+content="([^"]+)"/);
      console.log(prod.title.slice(0, 50));
      console.log('  HTML price:', priceMatch?.[1] || 'NONE');
      console.log('  meta price:', metaPrice?.[1] || 'NONE');
    } catch (err) {
      console.log(prod.title.slice(0, 50) + ' - fetch error: ' + err.message);
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  // 5. Check WooCommerce REST API for price info
  console.log('\n=== WP REST API product price check ===');
  if (noPrice.length > 0) {
    const slug = noPrice[0].url.replace(/\/$/, '').split('/').pop();
    const resp = await axios.get(`${ORIGIN}/wp-json/wp/v2/product`, {
      params: { slug },
      timeout: 15000,
    });
    const prod = resp.data[0];
    if (prod) {
      console.log('WP REST fields available:', Object.keys(prod).join(', '));
      // Check if there's any price-related field
      for (const key of Object.keys(prod)) {
        const val = JSON.stringify(prod[key]);
        if (val && val.toLowerCase().includes('price')) {
          console.log('  ' + key + ': ' + val.slice(0, 200));
        }
      }
    }
  }

  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
