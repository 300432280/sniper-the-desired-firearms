const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
(async () => {
  const site = await db.monitoredSite.findFirst({ where: { url: { contains: 'alflahertys' } } });
  const total = await db.productIndex.count({ where: { siteId: site.id } });
  const active = await db.productIndex.count({ where: { siteId: site.id, isActive: true } });
  const inStock = await db.productIndex.count({ where: { siteId: site.id, isActive: true, stockStatus: 'in_stock' } });
  console.log('Total:', total, 'Active:', active, 'In stock:', inStock);

  // Show some recent products
  const recent = await db.productIndex.findMany({
    where: { siteId: site.id, isActive: true },
    orderBy: { lastSeenAt: 'desc' },
    take: 10,
    select: { title: true, price: true, stockStatus: true, url: true, lastSeenAt: true }
  });
  recent.forEach(p => console.log(' ', p.lastSeenAt?.toISOString().slice(0,16), '|', p.title?.slice(0, 55), '|', p.price, '|', p.stockStatus));

  await db.$disconnect();
})();
