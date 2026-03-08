const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
(async () => {
  const site = await db.monitoredSite.findFirst({ where: { url: { contains: 'alflahertys' } } });

  // Check if any ProductIndex entries have thumbnails
  const withThumb = await db.productIndex.count({ where: { siteId: site.id, thumbnail: { not: null } } });
  const total = await db.productIndex.count({ where: { siteId: site.id, isActive: true } });
  console.log(`ProductIndex: ${withThumb}/${total} have thumbnails`);

  // Check SKS products specifically
  const sksProducts = await db.productIndex.findMany({
    where: { siteId: site.id, title: { contains: 'SKS', mode: 'insensitive' } },
    select: { title: true, thumbnail: true, url: true },
  });
  console.log(`\nSKS products in ProductIndex (${sksProducts.length}):`);
  sksProducts.forEach(p => console.log(`  thumb=${p.thumbnail ? 'YES' : 'NO'} | ${p.title?.slice(0,60)} | ${(p.thumbnail || '').slice(0,80)}`));

  // Check Match records for SKS
  const sksMatches = await db.match.findMany({
    where: { search: { keyword: 'sks', websiteUrl: { contains: 'alflahertys' } } },
    select: { title: true, thumbnail: true, url: true },
  });
  console.log(`\nSKS matches in Match table (${sksMatches.length}):`);
  sksMatches.forEach(m => console.log(`  thumb=${m.thumbnail ? 'YES' : 'NO'} | ${m.title?.slice(0,60)} | ${(m.thumbnail || '').slice(0,80)}`));

  // Check a sample of ProductIndex thumbnails
  const samplesWithThumb = await db.productIndex.findMany({
    where: { siteId: site.id, thumbnail: { not: null } },
    take: 3,
    select: { title: true, thumbnail: true },
  });
  console.log(`\nSample ProductIndex thumbnails:`);
  samplesWithThumb.forEach(p => console.log(`  ${p.title?.slice(0,40)} → ${p.thumbnail?.slice(0,100)}`));

  await db.$disconnect();
})();
