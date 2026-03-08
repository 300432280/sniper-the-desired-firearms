/**
 * One-time: backfill thumbnails for alflahertys SKS matches by re-extracting from the search page.
 */
(async () => {
  const { fetchWithPlaywright } = require('../dist/services/scraper/playwright-fetcher');
  const { GenericRetailAdapter } = require('../dist/services/scraper/adapters/generic-retail');
  const { PrismaClient } = require('@prisma/client');
  const cheerio = require('cheerio');
  const db = new PrismaClient();

  const adapter = new GenericRetailAdapter();
  const url = 'https://alflahertys.com/search.php?search_query=sks';
  console.log('Fetching', url);
  const result = await fetchWithPlaywright(url, { timeout: 60000 });
  const $ = cheerio.load(result.html);

  const matches = adapter.extractMatches($, 'sks', url, { inStockOnly: false });
  console.log(`Extracted ${matches.length} matches`);

  // Build URL → thumbnail map
  const thumbMap = new Map();
  for (const m of matches) {
    if (m.thumbnail && m.url) thumbMap.set(m.url, m.thumbnail);
  }
  console.log(`${thumbMap.size} have thumbnails`);

  // Update Match records
  let updated = 0;
  for (const [matchUrl, thumbnail] of thumbMap) {
    const result = await db.match.updateMany({
      where: { url: matchUrl, thumbnail: null },
      data: { thumbnail },
    });
    if (result.count > 0) {
      updated += result.count;
      console.log(`  Updated ${result.count} match(es) for ${matchUrl.split('.com')[1]?.slice(0, 60)}`);
    }
  }
  console.log(`\nTotal updated: ${updated} Match records`);

  // Also update ProductIndex
  let piUpdated = 0;
  for (const [matchUrl, thumbnail] of thumbMap) {
    const result = await db.productIndex.updateMany({
      where: { url: matchUrl, thumbnail: null },
      data: { thumbnail },
    });
    if (result.count > 0) {
      piUpdated += result.count;
    }
  }
  console.log(`Updated ${piUpdated} ProductIndex records`);

  await db.$disconnect();
  process.exit(0);
})();
