/**
 * Update expectedProductCount for a single site.
 * Usage: node scripts/update-expected-count.js <domain> <count>
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  const domain = process.argv[2];
  const count = parseInt(process.argv[3]);
  if (!domain || isNaN(count)) { console.log('Usage: node update-expected-count.js <domain> <count>'); process.exit(1); }

  const site = await p.monitoredSite.findUnique({ where: { domain } });
  if (!site) { console.log('Site not found:', domain); process.exit(1); }

  const profile = site.siteProfile || {};
  const old = profile.expectedProductCount;
  profile.expectedProductCount = count;

  await p.monitoredSite.update({
    where: { id: site.id },
    data: { siteProfile: profile },
  });

  console.log(`${domain}: expectedProductCount ${old || 'none'} → ${count}`);
  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
