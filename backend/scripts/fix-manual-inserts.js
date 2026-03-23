/**
 * Fix products that were manually inserted without full field extraction.
 * Finds products with null thumbnail or null sourceId, fetches their live pages,
 * and updates with extracted data.
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const p = new PrismaClient();

async function main() {
  // Find products missing thumbnails across the 7 test sites
  const sites = await p.monitoredSite.findMany({
    where: {
      domain: { in: ['aagcanada.ca', 'alflahertys.com', 'alsimmonsgunshop.com', 'budgetshootersupply.ca', 'bullseyenorth.com', 'canadafirstammo.ca', 'gunpost.ca'] },
    },
    select: { id: true, domain: true },
  });

  for (const site of sites) {
    const noThumb = await p.productIndex.findMany({
      where: { siteId: site.id, isActive: true, thumbnail: null },
      select: { id: true, url: true, title: true },
      take: 20,
    });

    if (noThumb.length === 0) continue;

    console.log(`\n[${site.domain}] ${noThumb.length} products missing thumbnails`);

    for (const product of noThumb.slice(0, 10)) {
      try {
        const resp = await axios.get(product.url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          timeout: 10000,
          maxRedirects: 5,
          validateStatus: () => true,
        });

        if (resp.status !== 200 || typeof resp.data !== 'string') {
          console.log(`  [SKIP] ${product.title.substring(0, 40)} — HTTP ${resp.status}`);
          continue;
        }

        const html = resp.data;

        // Extract og:image (most reliable thumbnail source)
        let thumbnail = null;
        const ogMatch = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i)
          || html.match(/<meta\s+content="([^"]+)"\s+property="og:image"/i);
        if (ogMatch) thumbnail = ogMatch[1];

        // Fallback: first product image in the page
        if (!thumbnail) {
          const imgMatch = html.match(/<img[^>]+src="([^"]+)"[^>]*class="[^"]*product[^"]*"/i)
            || html.match(/<img[^>]+class="[^"]*product[^"]*"[^>]*src="([^"]+)"/i);
          if (imgMatch) thumbnail = imgMatch[1];
        }

        // Fallback: first large image
        if (!thumbnail) {
          const imgMatch = html.match(/<img[^>]+src="(https?:\/\/[^"]+\.(jpg|jpeg|png|webp)[^"]*)"/i);
          if (imgMatch) thumbnail = imgMatch[1];
        }

        if (thumbnail) {
          await p.productIndex.update({
            where: { id: product.id },
            data: { thumbnail },
          });
          console.log(`  [FIX] ${product.title.substring(0, 40)} — thumbnail set`);
        } else {
          console.log(`  [MISS] ${product.title.substring(0, 40)} — no thumbnail found on page`);
        }

        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        console.log(`  [ERR] ${product.title.substring(0, 40)} — ${err.message}`);
      }
    }
  }

  // Also fix the backfill-match-fk for any unlinked matches
  const unlinked = await p.match.findMany({
    where: { productIndexId: null },
    select: { id: true, url: true },
  });
  let linked = 0;
  for (const match of unlinked) {
    const pi = await p.productIndex.findFirst({
      where: { url: match.url },
      select: { id: true },
    });
    if (pi) {
      await p.match.update({ where: { id: match.id }, data: { productIndexId: pi.id } });
      linked++;
    }
  }
  console.log(`\nLinked ${linked}/${unlinked.length} remaining unlinked matches`);

  await p.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
