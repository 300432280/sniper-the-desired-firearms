const axios = require('axios');
const ORIGIN = 'https://alsimmonsgunshop.com';

(async () => {
  for (const slug of ['mauser-m954-30-06springfield-12425n', 'cz-brno-mauser-22lr-12686nc']) {
    const resp = await axios.get(`${ORIGIN}/wp-json/wp/v2/product`, {
      params: { slug, _embed: 'wp:featuredmedia' }, timeout: 15000,
    });
    const p = resp.data[0];
    const embedded = p._embedded?.['wp:featuredmedia']?.[0];
    console.log(slug);
    console.log('  featured_media:', p.featured_media);
    console.log('  has embedded source_url:', Boolean(embedded?.source_url));

    const page = await axios.get(p.link, { timeout: 15000 });
    const og = page.data.match(/property="og:image"\s+content="([^"]+)"/);
    console.log('  og:image:', og?.[1]?.slice(0, 100) || 'NONE');
    await new Promise(r => setTimeout(r, 2000));
  }
})();
