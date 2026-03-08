import { PrismaClient } from '@prisma/client';
import axios from 'axios';

async function main() {
  const p = new PrismaClient();

  // Get all sites with 0 products
  const sites = await p.monitoredSite.findMany({
    where: { isEnabled: true },
    select: { id: true, domain: true, url: true, adapterType: true, hasWaf: true },
    orderBy: { domain: 'asc' },
  });

  const zeroSites: typeof sites = [];
  for (const site of sites) {
    const count = await p.productIndex.count({ where: { siteId: site.id } });
    if (count === 0) zeroSites.push(site);
  }

  console.log(`=== Sites with 0 products (checking URLs) ===\n`);
  for (const site of zeroSites) {
    console.log(`${site.domain} (${site.adapterType}) hasWaf=${site.hasWaf}`);
    console.log(`  URL: ${site.url}`);

    // Quick HTTP check
    try {
      const resp = await axios.get(site.url, {
        timeout: 10000,
        maxRedirects: 5,
        validateStatus: () => true,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      });
      console.log(`  HTTP ${resp.status} — ${resp.data.length} bytes — final URL: ${resp.request?.res?.responseUrl || 'same'}`);
    } catch (err: any) {
      console.log(`  ERROR: ${err.message}`);
    }
    console.log();
  }

  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
