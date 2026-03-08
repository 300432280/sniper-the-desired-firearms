const axios = require('axios');
const ORIGIN = 'https://alsimmonsgunshop.com';

(async () => {
  // WITH _fields (like fix-thumbnails2.js uses)
  const resp1 = await axios.get(`${ORIGIN}/wp-json/wp/v2/product`, {
    params: { slug: 'mauser-m18-savanna-300winmag-11907n', _embed: 'wp:featuredmedia', _fields: 'id,slug,_embedded' },
    timeout: 15000,
  });
  const e1 = resp1.data[0]._embedded?.['wp:featuredmedia']?.[0];
  console.log('WITH _fields:');
  console.log('  _embedded exists:', !!resp1.data[0]._embedded);
  console.log('  featuredmedia:', !!e1);
  console.log('  media_details:', !!e1?.media_details);
  console.log('  thumb:', e1?.media_details?.sizes?.thumbnail?.source_url || 'NONE');
  console.log('  source_url:', e1?.source_url || 'NONE');

  await new Promise(r => setTimeout(r, 2000));

  // WITHOUT _fields
  const resp2 = await axios.get(`${ORIGIN}/wp-json/wp/v2/product`, {
    params: { slug: 'mauser-m18-savanna-300winmag-11907n', _embed: 'wp:featuredmedia' },
    timeout: 15000,
  });
  const e2 = resp2.data[0]._embedded?.['wp:featuredmedia']?.[0];
  console.log('\nWITHOUT _fields:');
  console.log('  _embedded exists:', !!resp2.data[0]._embedded);
  console.log('  featuredmedia:', !!e2);
  console.log('  media_details:', !!e2?.media_details);
  console.log('  thumb:', e2?.media_details?.sizes?.thumbnail?.source_url || 'NONE');
  console.log('  source_url:', e2?.source_url || 'NONE');
})();
