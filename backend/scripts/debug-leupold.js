const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const site = await p.monitoredSite.findFirst({ where: { url: { contains: 'alflahertys' } } });

  // Check ProductIndex for leupold items
  const products = await p.productIndex.findMany({
    where: { siteId: site.id, isActive: true, title: { contains: 'leupold', mode: 'insensitive' } },
    select: { title: true, price: true, stockStatus: true, url: true, thumbnail: true },
  });
  console.log(`ProductIndex leupold items: ${products.length}`);
  let noPrice = 0, noStock = 0;
  for (const m of products) {
    const flag = (!m.price ? 'NO PRICE' : '') + (!m.stockStatus ? ' NO STATUS' : '');
    if (flag) {
      console.log(`  [${m.stockStatus || 'null'}] $${m.price || 'null'} | ${m.title.slice(0, 60)}`);
      if (!m.price) noPrice++;
      if (!m.stockStatus) noStock++;
    }
  }
  console.log(`No price: ${noPrice} | No stock status: ${noStock}`);

  // Check Match table
  const matches = await p.match.findMany({
    where: { search: { keyword: { equals: 'leupold', mode: 'insensitive' } } },
    select: { title: true, price: true, url: true, thumbnail: true },
    orderBy: { foundAt: 'desc' },
  });
  console.log(`\nMatch table leupold items: ${matches.length}`);
  const matchNoPrice = matches.filter(m => !m.price);
  const matchNoThumb = matches.filter(m => !m.thumbnail);
  console.log(`No price: ${matchNoPrice.length} | No thumbnail: ${matchNoThumb.length}`);
  matchNoPrice.forEach(m => console.log(`  $null | ${m.title.slice(0, 60)}`));

  await p.$disconnect();
})();
