const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  const sites = await p.monitoredSite.findMany({
    where: { domain: { in: ['lockharttactical.com', 'theammosource.com', 'store.theshootingcentre.com', 'truenortharms.com', 'gagnonsports.com'] } },
    select: { id: true, domain: true, name: true, siteProfile: true, adapterType: true }
  });
  for (const s of sites) {
    const profile = s.siteProfile || {};
    const urls = profile.catalogUrls || [];
    console.log(`\n=== ${s.domain} (id=${s.id}, adapter=${s.adapterType}) === ${urls.length} URLs`);
    urls.forEach((u, i) => console.log(`  ${i+1}. ${u}`));
  }
  await p.$disconnect();
}
main();
