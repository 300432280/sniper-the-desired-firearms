/**
 * Transition sites from bootstrap to maintain phase.
 * Usage: node scripts/transition-to-maintain.js <domain1> <domain2> ...
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  const domains = process.argv.slice(2);
  if (domains.length === 0) { console.log('Usage: node transition-to-maintain.js <domain1> <domain2> ...'); process.exit(1); }

  for (const domain of domains) {
    const site = await p.monitoredSite.findUnique({ where: { domain } });
    if (!site) { console.log(`${domain}: not found`); continue; }

    if (site.crawlPhase === 'maintain') {
      console.log(`${domain}: already in maintain`);
      continue;
    }

    const dbActive = await p.productIndex.count({ where: { siteId: site.id, isActive: true } });
    const profile = site.siteProfile || {};
    const expected = profile.expectedProductCount;
    const ratio = expected ? Math.round(dbActive / expected * 100) : '?';

    console.log(`${domain}: DB=${dbActive}/${expected} (${ratio}%) — transitioning to maintain`);

    await p.monitoredSite.update({
      where: { id: site.id },
      data: {
        crawlPhase: 'maintain',
        bootstrapCompletedAt: new Date(),
      },
    });

    console.log(`  ✓ Transitioned to maintain`);
  }

  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
