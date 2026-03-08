const axios = require('axios');

(async () => {
  // Compare search results: Store API vs WP REST for 'remington'
  const store = await axios.get('https://alsimmonsgunshop.com/wp-json/wc/store/v1/products', {
    params: { search: 'remington', per_page: 100 }, timeout: 15000
  });
  console.log('Store API search "remington":', store.data.length, 'results');

  const wp = await axios.get('https://alsimmonsgunshop.com/wp-json/wp/v2/product', {
    params: { search: 'remington', per_page: 100 }, timeout: 15000
  });
  console.log('WP REST search "remington":', wp.data.length, 'results (total:', wp.headers['x-wp-total'] + ')');

  // Show WP REST titles not in Store API
  const storeNames = new Set(store.data.map(p => (p.name || '').toLowerCase()));
  const wpOnly = wp.data.filter(p => {
    const t = (p.title && p.title.rendered || '').toLowerCase();
    return !storeNames.has(t);
  });
  console.log('\nIn WP REST but NOT in Store API (likely out-of-stock):', wpOnly.length);
  wpOnly.slice(0, 15).forEach(p => {
    const title = p.title && p.title.rendered || 'N/A';
    console.log('  ', title.slice(0, 70), '| status:', p.status);
  });

  // Also check SKS
  const storeSks = await axios.get('https://alsimmonsgunshop.com/wp-json/wc/store/v1/products', {
    params: { search: 'sks', per_page: 100 }, timeout: 15000
  });
  const wpSks = await axios.get('https://alsimmonsgunshop.com/wp-json/wp/v2/product', {
    params: { search: 'sks', per_page: 100 }, timeout: 15000
  });
  console.log('\n--- SKS ---');
  console.log('Store API search "sks":', storeSks.data.length);
  console.log('WP REST search "sks":', wpSks.data.length, '(total:', wpSks.headers['x-wp-total'] + ')');
  wpSks.data.forEach(p => {
    const title = p.title && p.title.rendered || 'N/A';
    console.log('  ', title.slice(0, 70));
  });

  // Check magazine counts
  const storeMag = await axios.get('https://alsimmonsgunshop.com/wp-json/wc/store/v1/products', {
    params: { search: 'magazine', per_page: 100 }, timeout: 15000
  });
  const wpMag = await axios.get('https://alsimmonsgunshop.com/wp-json/wp/v2/product', {
    params: { search: 'magazine', per_page: 100 }, timeout: 15000
  });
  console.log('\n--- MAGAZINE ---');
  console.log('Store API search "magazine":', storeMag.data.length);
  console.log('WP REST search "magazine":', wpMag.data.length, '(total:', wpMag.headers['x-wp-total'] + ')');

  // Check glock
  const storeGlock = await axios.get('https://alsimmonsgunshop.com/wp-json/wc/store/v1/products', {
    params: { search: 'glock', per_page: 100 }, timeout: 15000
  });
  const wpGlock = await axios.get('https://alsimmonsgunshop.com/wp-json/wp/v2/product', {
    params: { search: 'glock', per_page: 100 }, timeout: 15000
  });
  console.log('\n--- GLOCK ---');
  console.log('Store API search "glock":', storeGlock.data.length);
  console.log('WP REST search "glock":', wpGlock.data.length, '(total:', wpGlock.headers['x-wp-total'] + ')');
})().catch(e => console.error(e.message));
