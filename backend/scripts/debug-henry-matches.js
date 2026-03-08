const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
(async () => {
  const site = await db.monitoredSite.findFirst({ where: { url: { contains: 'alflahertys' } } });

  // How many Henry products in ProductIndex?
  const piHenry = await db.productIndex.findMany({
    where: { siteId: site.id, isActive: true, title: { contains: 'henry', mode: 'insensitive' } },
    select: { title: true, thumbnail: true, url: true, price: true, stockStatus: true },
  });
  console.log(`ProductIndex "henry" products: ${piHenry.length}`);
  const withThumb = piHenry.filter(p => p.thumbnail);
  console.log(`  With thumbnails: ${withThumb.length}`);
  piHenry.slice(0, 5).forEach(p =>
    console.log(`  ${p.thumbnail ? 'IMG' : '---'} | $${p.price} | ${p.title?.slice(0, 60)}`)
  );

  // What searches exist for henry on alflahertys?
  const searches = await db.search.findMany({
    where: { keyword: { contains: 'henry', mode: 'insensitive' }, websiteUrl: { contains: 'alflahertys' } },
    select: { id: true, keyword: true, websiteUrl: true, inStockOnly: true },
  });
  console.log(`\nSearches for "henry" on alflahertys: ${searches.length}`);
  searches.forEach(s => console.log(`  id=${s.id} keyword="${s.keyword}" url=${s.websiteUrl} inStockOnly=${s.inStockOnly}`));

  // How many Match records for each search?
  for (const s of searches) {
    const matchCount = await db.match.count({ where: { searchId: s.id } });
    console.log(`  Matches for ${s.id}: ${matchCount}`);

    const matches = await db.match.findMany({
      where: { searchId: s.id },
      select: { title: true, thumbnail: true, url: true, price: true },
      orderBy: { foundAt: 'desc' },
      take: 5,
    });
    matches.forEach(m =>
      console.log(`    ${m.thumbnail ? 'IMG' : '---'} | $${m.price} | ${m.title?.slice(0, 60)}`)
    );
  }

  await db.$disconnect();
})();
