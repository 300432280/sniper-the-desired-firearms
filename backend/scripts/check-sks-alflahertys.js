const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const SITE_ID = 'cmltxz6fp000289xar53h1vkf';

(async () => {
  // All active products with SKS in title
  const sksProducts = await p.productIndex.findMany({
    where: { siteId: SITE_ID, isActive: true, title: { contains: 'sks', mode: 'insensitive' } },
    select: { id: true, title: true, url: true, price: true, stockStatus: true, thumbnail: true }
  });
  console.log('=== SKS products in ProductIndex (active) ===');
  console.log('Count:', sksProducts.length);
  sksProducts.forEach((s, i) => console.log(`${i+1}. ${s.title} | $${s.price} | ${s.stockStatus} | thumb: ${s.thumbnail ? s.thumbnail.slice(0, 60) : 'NONE'}`));

  // Also check inactive (deactivated) ones
  const inactive = await p.productIndex.findMany({
    where: { siteId: SITE_ID, isActive: false, title: { contains: 'sks', mode: 'insensitive' } },
    select: { title: true, url: true }
  });
  console.log('\n=== SKS products DEACTIVATED ===');
  console.log('Count:', inactive.length);
  inactive.forEach(s => console.log(' -', s.title.slice(0, 80), '|', s.url));

  // Check all products for thumbnail presence
  const allActive = await p.productIndex.findMany({
    where: { siteId: SITE_ID, isActive: true },
    select: { thumbnail: true }
  });
  const withThumb = allActive.filter(a => a.thumbnail);
  console.log('\n=== THUMBNAIL STATS ===');
  console.log('Total active:', allActive.length);
  console.log('With thumbnail:', withThumb.length);
  console.log('Without thumbnail:', allActive.length - withThumb.length);

  await p.$disconnect();
})();
