const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const SITE_ID = 'cmltxz6fp000289xar53h1vkf';

(async () => {
  // 1. Current site state
  const site = await p.monitoredSite.findFirst({ where: { id: SITE_ID } });
  console.log('=== SITE STATE ===');
  console.log('Tier state:', JSON.stringify(site.tierState, null, 2));
  console.log('Last crawl:', site.lastCrawlAt);
  console.log('Next crawl:', site.nextCrawlAt);
  console.log('Crawl interval:', site.crawlIntervalMin, 'min');
  console.log('Difficulty:', site.difficultyScore);
  console.log('Traffic class:', site.trafficClass);

  // 2. Product counts - active vs inactive
  const active = await p.productIndex.count({ where: { siteId: SITE_ID, isActive: true } });
  const inactive = await p.productIndex.count({ where: { siteId: SITE_ID, isActive: false } });
  console.log('\n=== PRODUCT INDEX ===');
  console.log('Active:', active);
  console.log('Inactive (deactivated):', inactive);
  console.log('Total ever indexed:', active + inactive);

  // 3. Recent crawl events with more detail
  const events = await p.crawlEvent.findMany({
    where: { siteId: SITE_ID },
    orderBy: { crawledAt: 'desc' },
    take: 20,
    select: { status: true, crawledAt: true, matchesFound: true, responseTimeMs: true, statusCode: true, errorMessage: true }
  });
  console.log('\n=== LAST 20 CRAWL EVENTS ===');
  events.forEach(e => {
    const date = e.crawledAt.toISOString().slice(0, 19);
    const ms = e.responseTimeMs ? `${e.responseTimeMs}ms` : 'N/A';
    const err = e.errorMessage ? ` | ${e.errorMessage.slice(0, 80)}` : '';
    console.log(`${e.status} | ${date} | ${ms} | products: ${e.matchesFound}${err}`);
  });

  // 4. When were products first seen?
  const firstProducts = await p.productIndex.findMany({
    where: { siteId: SITE_ID },
    orderBy: { firstSeenAt: 'asc' },
    take: 5,
    select: { title: true, firstSeenAt: true, isActive: true }
  });
  const latestProducts = await p.productIndex.findMany({
    where: { siteId: SITE_ID },
    orderBy: { firstSeenAt: 'desc' },
    take: 5,
    select: { title: true, firstSeenAt: true, isActive: true }
  });
  console.log('\n=== FIRST INDEXED PRODUCTS ===');
  firstProducts.forEach(pr => console.log(`${pr.firstSeenAt.toISOString().slice(0, 19)} | ${pr.isActive ? 'active' : 'INACTIVE'} | ${pr.title.slice(0, 60)}`));
  console.log('\n=== LATEST INDEXED PRODUCTS ===');
  latestProducts.forEach(pr => console.log(`${pr.firstSeenAt.toISOString().slice(0, 19)} | ${pr.isActive ? 'active' : 'INACTIVE'} | ${pr.title.slice(0, 60)}`));

  await p.$disconnect();
})();
