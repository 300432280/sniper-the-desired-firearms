const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const SITE_ID = 'cmltxz6fp000289xar53h1vkf';

(async () => {
  await p.monitoredSite.update({
    where: { id: SITE_ID },
    data: { nextCrawlAt: new Date() }
  });
  console.log('Set nextCrawlAt to now — scheduler will pick it up on next 2-min tick');

  const site = await p.monitoredSite.findFirst({ where: { id: SITE_ID } });
  console.log('Next crawl:', site.nextCrawlAt);
  console.log('Tier state:', JSON.stringify(site.tierState, null, 2));

  await p.$disconnect();
})();
