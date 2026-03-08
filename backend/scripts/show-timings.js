const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const sites = await p.monitoredSite.findMany({
    where: { isEnabled: true },
    select: { name: true, siteCategory: true, adapterType: true, crawlIntervalMin: true, overrideInterval: true, baseBudget: true, capacity: true, pressure: true, hasWaf: true },
    orderBy: { name: 'asc' },
  });
  console.log(
    'Site'.padEnd(30),
    'Category'.padEnd(12),
    'Adapter'.padEnd(18),
    'WAF',
    'Override'.padEnd(10),
    'Actual'.padEnd(8),
    'Budget',
    'Cap%'.padStart(5),
    'Press%'.padStart(7),
  );
  console.log('-'.repeat(120));
  for (const s of sites) {
    const override = s.overrideInterval != null ? s.overrideInterval + 'min' : '-';
    const actual = s.crawlIntervalMin ? s.crawlIntervalMin + 'min' : '?';
    const cap = ((s.capacity || 0) * 100).toFixed(0);
    const press = ((s.pressure || 0) * 100).toFixed(0);
    console.log(
      s.name.padEnd(30),
      (s.siteCategory || 'retailer').padEnd(12),
      (s.adapterType || '?').padEnd(18),
      s.hasWaf ? 'Y' : 'N',
      override.padEnd(10),
      actual.padEnd(8),
      String(s.baseBudget || 60).padEnd(6),
      (cap + '%').padStart(5),
      (press + '%').padStart(7),
    );
  }

  console.log('\n=== TIER 1 BASE RATES (from priority-engine.ts) ===');
  console.log('  retailer:   2/hr (every 30 min) — scaled by capacity');
  console.log('  forum:      4/hr (every 15 min) — scaled by capacity');
  console.log('  classified: 4/hr (every 15 min) — scaled by capacity');
  console.log('  auction:    0.17/hr (every ~6 hr) — scaled by capacity');

  console.log('\n=== CATALOG TIER COOLDOWNS (from catalog-crawler.ts) ===');
  console.log('  Tier 2 (last 7 days):   5 hour cooldown');
  console.log('  Tier 3 (8-21 days):     9 hour cooldown');
  console.log('  Tier 4 (22+ days):     17 hour cooldown');

  await p.$disconnect();
})();
