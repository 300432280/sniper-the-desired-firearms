const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  const site = await p.monitoredSite.findFirst({ where: { domain: 'budgetshootersupply.ca' } });
  const searches = await p.search.findMany({
    where: { websiteUrl: { contains: 'budgetshootersupply' }, keyword: { contains: 'mauser', mode: 'insensitive' } },
  });
  if (!searches.length) { console.log('Search not found'); await p.$disconnect(); return; }

  for (const search of searches) {
    console.log('Search:', search.id, search.keyword);
    const matches = await p.match.findMany({
      where: { searchId: search.id },
      select: { url: true, title: true, price: true, thumbnail: true },
    });

    let noThumb = 0, noPrice = 0;
    for (const m of matches) {
      const pi = await p.productIndex.findFirst({
        where: { siteId: site.id, url: m.url },
        select: { price: true, thumbnail: true, stockStatus: true },
      });
      const hasThumb = m.thumbnail || pi?.thumbnail;
      const hasPrice = m.price || pi?.price;
      if (!hasThumb) noThumb++;
      if (!hasPrice) noPrice++;
      if (!hasThumb || !hasPrice) {
        console.log(`  ${m.title.slice(0, 55)}`);
        console.log(`    Match: price=${m.price} thumb=${m.thumbnail ? 'yes' : 'no'}`);
        console.log(`    PI:    price=${pi?.price} thumb=${pi?.thumbnail ? 'yes' : 'no'} stock=${pi?.stockStatus}`);
        console.log(`    URL:   ${m.url}`);
      }
    }
    console.log(`Total: ${matches.length} | No thumb (anywhere): ${noThumb} | No price (anywhere): ${noPrice}\n`);
  }
  await p.$disconnect();
})();
