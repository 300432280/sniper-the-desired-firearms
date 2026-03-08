const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  const site = await p.monitoredSite.findFirst({ where: { domain: 'alsimmonsgunshop.com' } });
  if (!site) { console.log('Site not found'); process.exit(1); }

  const fakes = ['New Non Restricted', 'New Restricted', 'Used Non Restricted', 'Used Restricted', 'Magazines', 'Collectable 22s'];
  for (const title of fakes) {
    const found = await p.productIndex.findFirst({ where: { siteId: site.id, title } });
    if (found) {
      const matchDel = await p.match.deleteMany({ where: { url: found.url } });
      const prodDel = await p.productIndex.delete({ where: { id: found.id } });
      console.log('DELETED:', title, '| matches removed:', matchDel.count);
    } else {
      console.log('NOT FOUND:', title);
    }
  }
  const remaining = await p.productIndex.count({ where: { siteId: site.id } });
  console.log('\nRemaining products:', remaining);
  await p.$disconnect();
})();
