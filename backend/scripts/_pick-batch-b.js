// One-shot: list audit-eligible sites (have siteProfile, not auction, not forum, not in batch A)
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const AUDITED = new Set([
  'sail.ca','ellwoodepps.com','westernmetal.ca','rangeviewsports.ca',
  'doubletapsports.com','groupepronature.ca','corwin-arms.com','marstar.ca',
  'dlaskarms.com','triggersandbows.com','fulcrum-outdoors.shoplightspeed.com',
]);

async function main() {
  const rows = await prisma.monitoredSite.findMany({
    select: { domain: true, adapterType: true, siteProfile: true, updatedAt: true, isEnabled: true },
    orderBy: { domain: 'asc' },
  });
  const eligible = rows.filter(r =>
    r.siteProfile && r.adapterType &&
    !r.adapterType.startsWith('auction-') &&
    !r.adapterType.startsWith('forum-') &&
    r.adapterType !== 'classifieds-gunpost' &&
    !AUDITED.has(r.domain)
  );
  console.log(`Eligible total: ${eligible.length}`);
  console.log('');
  eligible.forEach(r => {
    const platform = r.siteProfile?.platform || '?';
    const enabled = r.isEnabled ? 'EN' : 'DIS';
    const lv = r.siteProfile?.lastVerified || '?';
    console.log(`${r.domain.padEnd(45)} | ${r.adapterType.padEnd(16)} | ${platform.padEnd(22)} | ${enabled} | lastVerified=${lv}`);
  });
  await prisma.$disconnect();
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
