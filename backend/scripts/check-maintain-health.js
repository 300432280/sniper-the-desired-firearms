require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  const sites = await p.monitoredSite.findMany({
    where: { crawlPhase: 'maintain', isEnabled: true },
    select: { id: true, domain: true, baseBudget: true, adapterType: true, crawlIntervalMin: true, nextCrawlAt: true, crawlLock: true, pressure: true, capacity: true, crawlPhase: true }
  });

  const now = Date.now();
  const h1 = new Date(now - 1 * 3600000);
  const h8 = new Date(now - 8 * 3600000);

  for (const site of sites) {
    const active = await p.productIndex.count({ where: { siteId: site.id, isActive: true } });
    const total = await p.productIndex.count({ where: { siteId: site.id } });
    const withPrice = await p.productIndex.count({ where: { siteId: site.id, isActive: true, price: { not: null } } });

    // 1h events
    const ev1h = await p.crawlEvent.findMany({
      where: { siteId: site.id, crawledAt: { gte: h1 } },
      select: { jobType: true, tier: true, matchesFound: true, crawledAt: true }
    });

    // 8h events
    const ev8h = await p.crawlEvent.findMany({
      where: { siteId: site.id, crawledAt: { gte: h8 } },
      select: { jobType: true, tier: true, matchesFound: true, crawledAt: true }
    });

    const t1_1h = ev1h.filter(e => e.tier === 1 || e.jobType === 'crawl-watermark');
    const verify_1h = ev1h.filter(e => e.jobType === 'crawl-verify');
    const verifyProd_1h = verify_1h.reduce((s, e) => s + (e.matchesFound || 0), 0);

    const t1_8h = ev8h.filter(e => e.tier === 1 || e.jobType === 'crawl-watermark');
    const verify_8h = ev8h.filter(e => e.jobType === 'crawl-verify');
    const verifyProd_8h = verify_8h.reduce((s, e) => s + (e.matchesFound || 0), 0);
    const t1matches_8h = t1_8h.reduce((s, e) => s + (e.matchesFound || 0), 0);

    // Last event time
    const lastEvent = ev8h.length > 0 ? ev8h[ev8h.length - 1].crawledAt : null;
    const firstEvent = ev8h.length > 0 ? ev8h[0].crawledAt : null;

    console.log('');
    console.log('═══════════════════════════════════════════════════');
    console.log(site.domain + ' | ' + site.adapterType + ' | budget:' + site.baseBudget);
    console.log('═══════════════════════════════════════════════════');
    console.log('  Products: ' + active + '/' + total + ' active | Price: ' + (active > 0 ? Math.round(withPrice / active * 100) : 0) + '%');
    console.log('  crawlIntervalMin: ' + site.crawlIntervalMin + ' | nextCrawlAt: ' + (site.nextCrawlAt ? site.nextCrawlAt.toISOString().substring(11, 19) : 'null'));
    console.log('  crawlLock: ' + (site.crawlLock ? 'LOCKED' : 'null') + ' | capacity: ' + site.capacity + ' | pressure: ' + site.pressure);
    console.log('');
    console.log('  ── LAST 1 HOUR ──');
    console.log('  T1 watermark: ' + t1_1h.length + ' runs');
    console.log('  Verify (T2-T4): ' + verify_1h.length + ' runs | ' + verifyProd_1h + ' products checked');
    console.log('  Total events: ' + ev1h.length);
    console.log('');
    console.log('  ── LAST 8 HOURS ──');
    console.log('  T1 watermark: ' + t1_8h.length + ' runs | ' + t1matches_8h + ' new products found');
    console.log('  Verify (T2-T4): ' + verify_8h.length + ' runs | ' + verifyProd_8h + ' products checked');
    console.log('  Total events: ' + ev8h.length);
    if (firstEvent) console.log('  Oldest event: ' + firstEvent.toISOString().substring(11, 19));
    if (lastEvent) console.log('  Newest event: ' + lastEvent.toISOString().substring(11, 19));
  }

  // Also check alsimmonsgunshop product history
  console.log('\n═══════════════════════════════════════════════════');
  console.log('ALSIMMONSGUNSHOP PRODUCT DROP INVESTIGATION');
  console.log('═══════════════════════════════════════════════════');
  const als = await p.monitoredSite.findFirst({ where: { domain: 'alsimmonsgunshop.com' } });
  const alsActive = await p.productIndex.count({ where: { siteId: als.id, isActive: true } });
  const alsInactive = await p.productIndex.count({ where: { siteId: als.id, isActive: false } });
  const alsDiscontinued = await p.productIndex.count({ where: { siteId: als.id, stockStatus: 'discontinued' } });
  const alsOOS = await p.productIndex.count({ where: { siteId: als.id, stockStatus: 'out_of_stock' } });
  const alsTotal = await p.productIndex.count({ where: { siteId: als.id } });

  // Check when products were deactivated (verifyErrors > 0)
  const highErrors = await p.productIndex.count({ where: { siteId: als.id, verifyErrors: { gte: 5 } } });
  const someErrors = await p.productIndex.count({ where: { siteId: als.id, verifyErrors: { gte: 1 } } });

  console.log('  Total: ' + alsTotal + ' | Active: ' + alsActive + ' | Inactive: ' + alsInactive);
  console.log('  Discontinued: ' + alsDiscontinued + ' | OOS: ' + alsOOS);
  console.log('  verifyErrors >= 1: ' + someErrors + ' | verifyErrors >= 5: ' + highErrors);

  // Sample recently deactivated
  const recentInactive = await p.productIndex.findMany({
    where: { siteId: als.id, isActive: false },
    orderBy: { lastSeenAt: 'desc' },
    take: 10,
    select: { title: true, stockStatus: true, verifyErrors: true, lastSeenAt: true, url: true }
  });
  console.log('  Sample inactive products:');
  recentInactive.forEach(pr => console.log('    ' + (pr.stockStatus || 'null') + ' | err:' + (pr.verifyErrors || 0) + ' | seen:' + (pr.lastSeenAt ? pr.lastSeenAt.toISOString().substring(0, 10) : 'never') + ' | ' + (pr.title || '').substring(0, 50)));

  await p.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
