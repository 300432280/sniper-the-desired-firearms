/**
 * Backfill thumbnails for products missing them by looking up each product
 * individually via WP REST API slug search with _embed.
 */
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const p = new PrismaClient();

const ORIGIN = 'https://alsimmonsgunshop.com';

(async () => {
  const site = await p.monitoredSite.findFirst({ where: { domain: 'alsimmonsgunshop.com' } });
  if (!site) { console.log('Site not found'); process.exit(1); }

  const missing = await p.productIndex.findMany({
    where: { siteId: site.id, thumbnail: null },
    select: { id: true, url: true, title: true },
  });
  console.log(`Products missing thumbnails: ${missing.length}`);

  let updated = 0;
  let notFound = 0;
  let noImage = 0;
  let errors = 0;

  for (let i = 0; i < missing.length; i++) {
    const prod = missing[i];
    // Extract slug from URL: /product/some-slug/ → some-slug
    const slug = prod.url.replace(/\/$/, '').split('/').pop();
    if (!slug) { notFound++; continue; }

    try {
      const resp = await axios.get(`${ORIGIN}/wp-json/wp/v2/product`, {
        params: { slug, _embed: 'wp:featuredmedia' },
        timeout: 15000,
        validateStatus: (s) => s === 200,
      });

      const wpProd = resp.data?.[0];
      if (!wpProd) { notFound++; continue; }

      const embedded = wpProd._embedded?.['wp:featuredmedia']?.[0];
      const thumb = embedded?.media_details?.sizes?.thumbnail?.source_url
        || embedded?.media_details?.sizes?.medium?.source_url
        || embedded?.source_url;

      if (thumb) {
        await p.productIndex.update({
          where: { id: prod.id },
          data: { thumbnail: thumb },
        });
        updated++;
      } else {
        noImage++;
      }
    } catch (err) {
      errors++;
    }

    if ((i + 1) % 20 === 0 || i === missing.length - 1) {
      process.stdout.write(`  ${i + 1}/${missing.length}: ${updated} updated, ${noImage} no image, ${notFound} not found, ${errors} errors\r`);
    }

    // Rate limit: ~1 req/sec to be gentle on the site
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`\n\nDone: ${updated} updated, ${noImage} no featured image, ${notFound} not found, ${errors} errors`);

  const stillMissing = await p.productIndex.count({ where: { siteId: site.id, thumbnail: null } });
  console.log(`Still missing: ${stillMissing}`);

  await p.$disconnect();
})();
