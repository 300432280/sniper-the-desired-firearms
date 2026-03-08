const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const site = await p.monitoredSite.findFirst({ where: { url: { contains: 'alflahertys' } } });

  const noThumb = await p.productIndex.findMany({
    where: { siteId: site.id, isActive: true, thumbnail: null },
    select: { title: true, url: true, price: true },
    take: 15,
  });
  console.log('Products without thumbnails (' + noThumb.length + ' shown):');
  noThumb.forEach(p => console.log('  ' + p.url.replace('https://alflahertys.com', '').slice(0, 80)));

  const withThumb = await p.productIndex.findMany({
    where: { siteId: site.id, isActive: true, NOT: { thumbnail: null } },
    select: { title: true, url: true, thumbnail: true },
    take: 5,
  });
  console.log('\nProducts WITH thumbnails (5 samples):');
  withThumb.forEach(p => console.log('  ' + p.url.replace('https://alflahertys.com', '').slice(0, 60) + ' | ' + (p.thumbnail || '').slice(0, 80)));

  await p.$disconnect();
})();
