import { PrismaClient } from '@prisma/client';

async function main() {
  const p = new PrismaClient();

  // Check for fulcrum-outdoors URLs in matches
  const fulcrumMatches = await p.match.findMany({
    where: { url: { contains: 'fulcrum' } },
    take: 10,
    select: {
      title: true,
      url: true,
      foundAt: true,
      search: { select: { keyword: true, websiteUrl: true } },
    },
  });

  console.log(`=== Fulcrum URLs in matches: ${fulcrumMatches.length} ===`);
  for (const m of fulcrumMatches) {
    console.log(`[Search: ${m.search.websiteUrl}] ${m.title}`);
    console.log(`  URL: ${m.url}`);
    console.log();
  }

  // Check for cross-site contamination: matches where URL domain != search websiteUrl domain
  const allMatches = await p.match.findMany({
    where: { search: { keyword: { contains: 'sks', mode: 'insensitive' } } },
    select: {
      title: true,
      url: true,
      foundAt: true,
      search: { select: { websiteUrl: true } },
    },
    orderBy: { foundAt: 'desc' },
    take: 50,
  });

  console.log(`\n=== Cross-site contamination check (SKS matches) ===`);
  let contaminatedCount = 0;
  for (const m of allMatches) {
    const searchDomain = new URL(m.search.websiteUrl).hostname.replace('www.', '');
    const matchDomain = (() => { try { return new URL(m.url).hostname.replace('www.', ''); } catch { return 'INVALID'; } })();
    if (searchDomain !== matchDomain) {
      contaminatedCount++;
      console.log(`MISMATCH: Search on [${searchDomain}] has match URL from [${matchDomain}]`);
      console.log(`  Title: ${m.title}`);
      console.log(`  URL: ${m.url}`);
      console.log();
    }
  }
  console.log(`Total contaminated: ${contaminatedCount} out of ${allMatches.length}`);

  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
