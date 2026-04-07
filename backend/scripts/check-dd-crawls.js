require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const s = await p.monitoredSite.findUnique({ where: { domain: 'doctordeals.ca' } });
  if (!s) { console.log('NOT FOUND'); process.exit(1); }
  console.log('Site:', s.domain);
  console.log('lastCrawlAt:', s.lastCrawlAt);
  console.log('avgResponseTimeMs:', s.avgResponseTimeMs);
  console.log('successRate:', s.successRate);
  console.log('totalCrawls:', s.totalCrawls);
  console.log('failedCrawls:', s.failedCrawls);

  // Recent crawl events
  const events = await p.crawlEvent.findMany({
    where: { siteId: s.id },
    orderBy: { crawledAt: 'desc' },
    take: 15,
    select: { crawledAt: true, status: true, jobType: true, tier: true, matchesFound: true, pagesScanned: true, errorMessage: true },
  });
  console.log('\nLast 15 crawl events:');
  for (const e of events) {
    console.log(`  ${e.crawledAt.toISOString()} ${e.jobType} T${e.tier} ${e.status} matches=${e.matchesFound} pages=${e.pagesScanned} err=${e.errorMessage?.slice(0, 50) || ''}`);
  }

  // Most recent product
  const recentProd = await p.productIndex.findFirst({
    where: { siteId: s.id, isActive: true },
    orderBy: { lastSeenAt: 'desc' },
    select: { url: true, title: true, lastSeenAt: true, firstSeenAt: true, stockStatus: true },
  });
  console.log('\nMost recent product (by lastSeenAt):');
  console.log(' ', recentProd);

  // Cookie cache check via Redis would need separate query
  console.log('\nTo check cached WAF cookies, query Redis: GET waf-cookies:doctordeals.ca');

  await p.$disconnect();
})();
