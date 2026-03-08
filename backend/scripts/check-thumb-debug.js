/**
 * Debug: check why specific products aren't getting thumbnails.
 * Look at the raw WP REST API response more carefully.
 */
const axios = require('axios');
const ORIGIN = 'https://alsimmonsgunshop.com';

const slugs = [
  'mauser-m18-savanna-300winmag-11907n',
  'zastava-m48-8mm-mauser-13901nc',
  'alpine-mauser-243win-14118n',
];

(async () => {
  for (const slug of slugs) {
    console.log(`\n=== ${slug} ===`);
    try {
      const resp = await axios.get(`${ORIGIN}/wp-json/wp/v2/product`, {
        params: { slug, _embed: 'wp:featuredmedia' },
        timeout: 15000,
        validateStatus: (s) => s === 200,
      });
      const prod = resp.data?.[0];
      if (!prod) { console.log('NOT FOUND'); continue; }

      console.log('featured_media:', prod.featured_media);
      const embedded = prod._embedded?.['wp:featuredmedia'];
      console.log('_embedded wp:featuredmedia:', JSON.stringify(embedded, null, 2)?.slice(0, 500));

      // Also check if product page HTML has an og:image or product image
      const pageResp = await axios.get(prod.link, { timeout: 15000 });
      const html = pageResp.data;
      const ogMatch = html.match(/property="og:image"\s+content="([^"]+)"/);
      const imgMatch = html.match(/class="[^"]*woocommerce-product-gallery__image[^"]*"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"/);
      console.log('og:image:', ogMatch?.[1] || 'NONE');
      console.log('gallery img:', imgMatch?.[1] || 'NONE');
    } catch (err) {
      console.log('Error:', err.message);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
})();
