const axios = require('axios');

async function checkSite(domain) {
  const origin = 'https://' + domain;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`SITE: ${domain}`);
  console.log('='.repeat(60));

  // 1. Check Store API — are there any non-purchasable or out-of-stock items?
  console.log('\n--- Store API analysis ---');
  let storeProducts = [];
  let page = 1, pages = 1;
  try {
    while (page <= Math.min(pages, 3)) { // sample first 3 pages
      const resp = await axios.get(`${origin}/wp-json/wc/store/v1/products`, {
        params: { per_page: 100, page },
        timeout: 15000,
        validateStatus: (s) => s === 200,
      });
      if (page === 1) {
        pages = parseInt(resp.headers['x-wp-totalpages'] || '1', 10);
        console.log(`Total in Store API: ${resp.headers['x-wp-total']} (${pages} pages)`);
      }
      storeProducts.push(...resp.data);
      page++;
      await new Promise(r => setTimeout(r, 1000));
    }

    // Q1: Any product in Store API that is NOT purchasable?
    const notPurchasable = storeProducts.filter(p => p.is_purchasable === false);
    console.log(`Not purchasable (in Store API but can't buy): ${notPurchasable.length}`);
    for (const p of notPurchasable.slice(0, 3)) {
      console.log(`  "${p.name?.slice(0, 50)}" is_purchasable=${p.is_purchasable} stock_status=${p.stock_status}`);
    }

    // Check is_in_stock field
    const notInStock = storeProducts.filter(p => p.is_in_stock === false);
    console.log(`is_in_stock=false (in Store API but marked OOS): ${notInStock.length}`);
    for (const p of notInStock.slice(0, 3)) {
      console.log(`  "${p.name?.slice(0, 50)}" is_in_stock=${p.is_in_stock} is_purchasable=${p.is_purchasable}`);
    }

    // Check for backorder items
    const onBackorder = storeProducts.filter(p =>
      p.is_on_backorder === true || (p.add_to_cart?.text || '').toLowerCase().includes('backorder')
    );
    console.log(`On backorder: ${onBackorder.length}`);
    for (const p of onBackorder.slice(0, 3)) {
      console.log(`  "${p.name?.slice(0, 50)}" backorder=${p.is_on_backorder} btn="${p.add_to_cart?.text}"`);
    }

    // Show all unique field combos for stock-related fields
    const combos = new Map();
    for (const p of storeProducts) {
      const key = `purchasable=${p.is_purchasable} in_stock=${p.is_in_stock} backorder=${p.is_on_backorder} btn="${p.add_to_cart?.text}"`;
      if (!combos.has(key)) combos.set(key, { count: 0, example: p.name?.slice(0, 40) });
      combos.get(key).count++;
    }
    console.log('\nUnique stock field combinations:');
    for (const [key, val] of combos) {
      console.log(`  [${val.count}x] ${key} — e.g. "${val.example}"`);
    }

  } catch (e) {
    console.log('Store API not available:', e.message);
  }

  // 2. Q2: Check WP REST API for products NOT in Store API
  console.log('\n--- WP REST API: products NOT in Store API ---');
  try {
    const storeUrls = new Set(storeProducts.map(p => p.permalink).filter(Boolean));
    const storeUrlsTrimmed = new Set(storeProducts.map(p => (p.permalink || '').replace(/\/$/, '')));

    const wpResp = await axios.get(`${origin}/wp-json/wp/v2/product`, {
      params: { per_page: 100, page: 1 },
      timeout: 15000,
      validateStatus: (s) => s === 200,
    });
    const wpTotal = parseInt(wpResp.headers['x-wp-total'] || '0', 10);
    console.log(`WP REST total: ${wpTotal} | Store API total sampled: ${storeProducts.length}`);

    let notInStore = 0;
    for (const p of wpResp.data) {
      const url = p.link || '';
      if (!storeUrls.has(url) && !storeUrlsTrimmed.has(url.replace(/\/$/, ''))) {
        notInStore++;
        if (notInStore <= 5) {
          console.log(`  NOT in Store API: "${(p.title?.rendered || '').slice(0, 50)}" — ${url}`);
          // Check status field
          console.log(`    WP status=${p.status} type=${p.type}`);
        }
      }
    }
    console.log(`Page 1: ${notInStore}/${wpResp.data.length} not found in Store API`);

  } catch (e) {
    console.log('WP REST check failed:', e.message);
  }
}

async function main() {
  // Check budgetshootersupply.ca and alsimmonsgunshop.com
  await checkSite('budgetshootersupply.ca');
  await checkSite('alsimmonsgunshop.com');
}

main().catch(e => { console.error(e); process.exit(1); });
