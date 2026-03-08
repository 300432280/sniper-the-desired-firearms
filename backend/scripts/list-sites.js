const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const sites = await p.monitoredSite.findMany({
    select: { id: true, name: true, domain: true, adapterType: true, siteType: true, isEnabled: true, hasWaf: true, notes: true },
    orderBy: { name: 'asc' },
  });

  for (const s of sites) {
    const count = await p.productIndex.count({ where: { siteId: s.id, isActive: true } });
    const inStock = await p.productIndex.count({ where: { siteId: s.id, isActive: true, stockStatus: 'in_stock' } });
    const searches = await p.search.count({ where: { websiteUrl: { contains: s.domain } } });
    const status = s.isEnabled ? 'ON' : 'OFF';
    console.log(`[${status}] ${s.name.padEnd(30)} | ${(s.adapterType || '?').padEnd(15)} | ${count} products (${inStock} in stock) | ${searches} searches | ${s.domain}`);
  }

  console.log(`\nTotal: ${sites.length} sites`);
  await p.$disconnect();
})();
