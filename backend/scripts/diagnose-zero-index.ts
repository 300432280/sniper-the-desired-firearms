import { PrismaClient } from '@prisma/client';

async function main() {
  const p = new PrismaClient();

  const sites = await p.monitoredSite.findMany({
    where: { isEnabled: true },
    select: { id: true, domain: true, adapterType: true, hasWaf: true },
    orderBy: { domain: 'asc' },
  });

  console.log('=== Zero-product sites: WHY? ===\n');

  for (const site of sites) {
    const productCount = await p.productIndex.count({ where: { siteId: site.id } });
    if (productCount > 0) continue; // Skip sites that already have products

    // Check if any active searches target this site
    const searchCount = await p.search.count({
      where: { websiteUrl: { contains: site.domain }, isActive: true },
    });

    // Check recent crawl events
    const recentCrawls = await p.crawlEvent.findMany({
      where: { siteId: site.id },
      orderBy: { crawledAt: 'desc' },
      take: 5,
      select: { status: true, matchesFound: true, crawledAt: true },
    });

    const lastCrawl = recentCrawls[0];
    const lastCrawlInfo = lastCrawl
      ? `${lastCrawl.status} (${lastCrawl.matchesFound} products) ${Math.round((Date.now() - lastCrawl.crawledAt.getTime()) / 60000)}m ago`
      : 'NEVER CRAWLED';

    console.log(`${site.domain} (${site.adapterType}) WAF=${site.hasWaf}`);
    console.log(`  Active searches: ${searchCount}`);
    console.log(`  Last crawl: ${lastCrawlInfo}`);

    if (searchCount === 0) {
      console.log(`  ⚠ NO SEARCHES → crawl-site skips this site entirely`);
    }
    if (site.hasWaf) {
      console.log(`  ⚠ WAF → watermark/catalog likely blocked`);
    }
    console.log();
  }

  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
