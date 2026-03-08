const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const p = new PrismaClient();

const ORIGIN = 'https://alsimmonsgunshop.com';

(async () => {
  const site = await p.monitoredSite.findFirst({ where: { domain: 'alsimmonsgunshop.com' } });

  // Check the specific mauser matches missing thumbnails
  const matchUrls = [
    'https://alsimmonsgunshop.com/product/mauser-m18-savanna-300winmag-11907n/',
    'https://alsimmonsgunshop.com/product/zastava-m48-8mm-mauser-13901nc/',
    'https://alsimmonsgunshop.com/product/spanish-mauser-kar-98-8mm-mauser-14025nc/',
    'https://alsimmonsgunshop.com/product/mauser-kar98-8mm-mauser-14048n/',
    'https://alsimmonsgunshop.com/product/yugo-mauser-m98-48-30-06sprg-14049nc/',
    'https://alsimmonsgunshop.com/product/alpine-mauser-243win-14118n/',
  ];

  console.log('=== Products missing thumbnails in screenshot ===');
  for (const url of matchUrls) {
    const pi = await p.productIndex.findFirst({
      where: { url },
      select: { url: true, thumbnail: true, title: true, firstSeenAt: true },
    });
    if (pi) {
      console.log(`${pi.title}`);
      console.log(`  thumb: ${pi.thumbnail || 'NULL'}`);
      console.log(`  firstSeen: ${pi.firstSeenAt}`);
    } else {
      console.log(`NOT IN INDEX: ${url}`);
    }
  }

  // Overall count
  const total = await p.productIndex.count({ where: { siteId: site.id } });
  const noThumb = await p.productIndex.count({ where: { siteId: site.id, thumbnail: null } });
  console.log(`\n=== Overall: ${noThumb}/${total} products missing thumbnails ===`);

  // Check WP REST API for one of these to see if it has a featured image
  console.log('\n=== Checking WP REST API for featured images ===');
  for (const url of matchUrls.slice(0, 3)) {
    const slug = url.replace(/\/$/, '').split('/').pop();
    try {
      const resp = await axios.get(`${ORIGIN}/wp-json/wp/v2/product`, {
        params: { slug, _embed: 'wp:featuredmedia' },
        timeout: 15000,
        validateStatus: (s) => s === 200,
      });
      const prod = resp.data[0];
      if (prod) {
        const embedded = prod._embedded?.['wp:featuredmedia']?.[0];
        const featuredMediaId = prod.featured_media;
        const thumb = embedded?.media_details?.sizes?.thumbnail?.source_url
          || embedded?.media_details?.sizes?.medium?.source_url
          || embedded?.source_url;
        console.log(`${slug}: featured_media=${featuredMediaId}, thumb=${thumb || 'NONE'}`);
      } else {
        console.log(`${slug}: NOT FOUND in WP API`);
      }
    } catch (err) {
      console.log(`${slug}: API error - ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  await p.$disconnect();
})();
