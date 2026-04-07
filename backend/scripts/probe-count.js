/**
 * Run the actual product-count-probe for a site (same code the crawler uses).
 * Usage: node scripts/probe-count.js <domain>
 */
require('dotenv').config();
require('ts-node').register({ transpileOnly: true, project: require('path').join(__dirname, '..', 'tsconfig.json') });

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  const domain = process.argv[2];
  if (!domain) { console.log('Usage: node probe-count.js <domain>'); process.exit(1); }

  const site = await p.monitoredSite.findUnique({ where: { domain } });
  if (!site) { console.log('Site not found:', domain); process.exit(1); }

  const profile = site.siteProfile || {};
  const dbActive = await p.productIndex.count({ where: { siteId: site.id, isActive: true } });

  console.log(`=== Probe Count: ${domain} ===`);
  console.log(`Platform: ${profile.platform || '?'} | CatalogUrls: ${(profile.catalogUrls || []).length}`);
  console.log(`DB active: ${dbActive} | Stored expected: ${profile.expectedProductCount || 'none'}`);
  console.log(`Method: ${profile.productCountMethod?.method || 'none'}`);

  if (!profile.productCountMethod) {
    console.log('No productCountMethod in profile — cannot probe.');
    await p.$disconnect();
    return;
  }

  const { probeExpectedProductCount } = require('../src/services/product-count-probe');
  console.log('\nProbing...');

  const count = await probeExpectedProductCount(site.url, profile.productCountMethod, {
    hasWaf: site.hasWaf,
    siteId: site.id,
  });

  console.log(`\nProbe result: ${count}`);
  if (count !== null) {
    const ratio = Math.round(dbActive / count * 100);
    console.log(`Coverage: ${dbActive}/${count} = ${ratio}%`);
    if (profile.expectedProductCount && Math.abs(count - profile.expectedProductCount) > profile.expectedProductCount * 0.05) {
      console.log(`*** MISMATCH: stored=${profile.expectedProductCount}, probed=${count} ***`);
    }
  } else {
    console.log('Probe returned null (failed or 0 products found)');
  }

  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
