/**
 * Reset alflahertys tier state so catalog tiers (2-4) start fresh.
 * Run after fixing catalog crawler URL generation.
 */
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const SITE_ID = 'cmltxz6fp000289xar53h1vkf';

(async () => {
  const freshState = {
    tier2: { status: 'idle', currentPage: 0 },
    tier3: { status: 'idle', currentPage: 0 },
    tier4: { status: 'idle', currentPage: 0 },
  };

  await p.monitoredSite.update({
    where: { id: SITE_ID },
    data: { tierState: freshState },
  });

  console.log('Reset alflahertys tier state to idle (all tiers)');
  console.log('Next scheduler tick will start fresh catalog crawl with correct URLs');

  // Verify
  const site = await p.monitoredSite.findFirst({ where: { id: SITE_ID } });
  console.log('New tier state:', JSON.stringify(site.tierState, null, 2));

  await p.$disconnect();
})();
