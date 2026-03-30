require('dotenv').config();
var p = new (require('@prisma/client').PrismaClient)();
async function main() {
  var site = await p.monitoredSite.findUnique({ where: { domain: 'gotenda.com' }, select: { siteProfile: true } });
  var profile = site.siteProfile;
  profile.perPage = 5;
  profile.notes = 'WooCommerce behind Sucuri WAF. perPage=5 required - Sucuri rate-limits Store API enrichment bursts. 3x retry + 800ms delay between chunks.';
  await p.monitoredSite.update({ where: { domain: 'gotenda.com' }, data: { siteProfile: profile, nextCrawlAt: new Date() } });
  console.log('Set gotenda perPage=5, forced due now');
  await p['$disconnect']();
}
main();
