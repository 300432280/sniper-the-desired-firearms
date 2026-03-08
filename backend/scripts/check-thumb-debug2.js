const axios = require('axios');
const ORIGIN = 'https://alsimmonsgunshop.com';

(async () => {
  const resp = await axios.get(`${ORIGIN}/wp-json/wp/v2/product`, {
    params: { slug: 'mauser-m18-savanna-300winmag-11907n', _embed: 'wp:featuredmedia' },
    timeout: 15000,
  });
  const embedded = resp.data[0]._embedded['wp:featuredmedia'][0];
  console.log('source_url:', embedded.source_url);
  console.log('media_details keys:', embedded.media_details ? Object.keys(embedded.media_details) : 'NO media_details');
  if (embedded.media_details?.sizes) {
    console.log('sizes keys:', Object.keys(embedded.media_details.sizes));
    console.log('thumbnail:', embedded.media_details.sizes.thumbnail?.source_url);
    console.log('medium:', embedded.media_details.sizes.medium?.source_url);
  }
  // Check all top-level keys
  console.log('\nAll embedded keys:', Object.keys(embedded));
})();
