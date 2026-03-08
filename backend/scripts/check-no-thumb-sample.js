const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const p = new PrismaClient();
const domain = process.argv[2] || 'budgetshootersupply.ca';

async function main() {
  const site = await p.monitoredSite.findFirst({ where: { domain } });
  const noThumb = await p.productIndex.findMany({
    where: { siteId: site.id, thumbnail: null, isActive: true },
    select: { url: true, title: true },
    take: 5,
  });
  console.log(`Sampling ${noThumb.length} products still missing thumbnails...\n`);
  for (const prod of noThumb) {
    try {
      const resp = await axios.get(prod.url, { timeout: 15000 });
      const html = resp.data;
      const og = html.match(/property="og:image"\s+content="([^"]+)"/);
      const gallery = html.match(/data-large_image="([^"]+)"/);
      const anyImg = html.match(/wp-post-image[^>]*src="([^"]+)"/);
      console.log(prod.title.slice(0, 60));
      console.log('  og:image:', og?.[1]?.slice(0, 100) || 'NONE');
      console.log('  gallery:', gallery?.[1]?.slice(0, 100) || 'NONE');
      console.log('  wp-post-image:', anyImg?.[1]?.slice(0, 100) || 'NONE');
      console.log();
    } catch (e) { console.log(prod.title.slice(0, 50) + ' - error: ' + e.message + '\n'); }
    await new Promise(r => setTimeout(r, 1500));
  }
  await p.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
