/**
 * Backfill thumbnails for alsimmonsgunshop products using WP REST API with _embed.
 */
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const p = new PrismaClient();

const ORIGIN = 'https://alsimmonsgunshop.com';

(async () => {
  const site = await p.monitoredSite.findFirst({ where: { domain: 'alsimmonsgunshop.com' } });
  if (!site) { console.log('Site not found'); process.exit(1); }

  const noThumb = await p.productIndex.count({ where: { siteId: site.id, thumbnail: null } });
  console.log(`Products missing thumbnails: ${noThumb}`);

  // Fetch all products from WP REST API with _embed to get featured images
  const urlToThumb = new Map();
  let page = 1;
  let totalPages = 1;

  console.log('Fetching WP REST API with _embed for thumbnails...');
  while (page <= totalPages) {
    try {
      const resp = await axios.get(`${ORIGIN}/wp-json/wp/v2/product`, {
        params: { per_page: 100, page, _embed: 'wp:featuredmedia', _fields: 'id,link,featured_media,_links' },
        timeout: 30000,
        validateStatus: (s) => s === 200,
      });
      if (page === 1) {
        totalPages = parseInt(resp.headers['x-wp-totalpages'] || '1', 10);
        console.log(`Total pages: ${totalPages}`);
      }

      for (const prod of resp.data) {
        const url = prod.link;
        const embedded = prod._embedded?.['wp:featuredmedia']?.[0];
        const thumb = embedded?.media_details?.sizes?.thumbnail?.source_url
          || embedded?.media_details?.sizes?.medium?.source_url
          || embedded?.source_url;
        if (url && thumb) {
          urlToThumb.set(url, thumb);
        }
      }

      process.stdout.write(`  Page ${page}/${totalPages}: ${urlToThumb.size} thumbnails found\r`);
      page++;
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      console.log(`\n  Error on page ${page}: ${err.message}`);
      break;
    }
  }
  console.log(`\nThumbnails found from API: ${urlToThumb.size}`);

  // Update products missing thumbnails
  const missing = await p.productIndex.findMany({
    where: { siteId: site.id, thumbnail: null },
    select: { id: true, url: true },
  });

  let updated = 0;
  for (const prod of missing) {
    const thumb = urlToThumb.get(prod.url) || urlToThumb.get(prod.url.replace(/\/$/, ''));
    if (thumb) {
      await p.productIndex.update({
        where: { id: prod.id },
        data: { thumbnail: thumb },
      });
      updated++;
    }
  }

  const stillMissing = await p.productIndex.count({ where: { siteId: site.id, thumbnail: null } });
  console.log(`\nUpdated: ${updated} thumbnails`);
  console.log(`Still missing: ${stillMissing}`);

  await p.$disconnect();
})();
