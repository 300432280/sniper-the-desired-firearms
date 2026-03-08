const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  const site = await p.monitoredSite.findFirst({ where: { domain: 'alsimmonsgunshop.com' } });
  if (!site) { console.log('Site not found'); process.exit(1); }

  console.log('BEFORE:', JSON.stringify(site.tierState, null, 2));

  // Reset all tiers to idle so they start fresh with the new WP REST API code
  await p.monitoredSite.update({
    where: { id: site.id },
    data: {
      tierState: {
        tier2: { status: 'idle', currentPage: 0 },
        tier3: { status: 'idle', currentPage: 0 },
        tier4: { status: 'idle', currentPage: 0 },
      },
    },
  });

  const updated = await p.monitoredSite.findFirst({ where: { domain: 'alsimmonsgunshop.com' } });
  console.log('\nAFTER:', JSON.stringify(updated.tierState, null, 2));
  console.log('\nAll tiers reset to idle. They will start fresh on the next scheduler tick.');
  await p.$disconnect();
})();
