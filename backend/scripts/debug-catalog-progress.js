const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
(async () => {
  const site = await db.monitoredSite.findFirst({ where: { url: { contains: 'alflahertys' } } });
  console.log('Tier state:', JSON.stringify(site.tierState, null, 2));
  console.log('Total products:', await db.productIndex.count({ where: { siteId: site.id, isActive: true } }));

  // Check how many Henry products exist on the actual search page
  const { fetchWithPlaywright } = require('../dist/services/scraper/playwright-fetcher');
  const { GenericRetailAdapter } = require('../dist/services/scraper/adapters/generic-retail');
  const cheerio = require('cheerio');
  const adapter = new GenericRetailAdapter();

  // Check Klevu search for "henry" — how many results?
  console.log('\nFetching search page for "henry"...');
  const result = await fetchWithPlaywright('https://alflahertys.com/search.php?search_query=henry', { timeout: 60000 });
  const $ = cheerio.load(result.html);

  // Count Klevu products with actual content
  const klevuProducts = $('[class*="klevuProduct"]');
  let withContent = 0;
  klevuProducts.each((_, el) => {
    if ($(el).text().trim().length > 10) withContent++;
  });
  console.log(`Klevu products on search page: ${klevuProducts.length} total, ${withContent} with content`);

  // Check for Klevu result count indicator
  const resultCount = $('.kuResultCount, [class*="kuResultCount"], .klevuResultCount').text().trim();
  console.log('Klevu result count text:', resultCount || '(not found)');

  // Extract matches with adapter
  const matches = adapter.extractMatches($, 'henry', 'https://alflahertys.com/search.php?search_query=henry', { inStockOnly: false });
  console.log(`extractMatches found: ${matches.length}`);

  // Check for Klevu pagination
  const klevuPagination = $('[class*="kuPagination"], .kuPagination, [class*="klevuPagination"]');
  console.log('Klevu pagination elements:', klevuPagination.length);
  if (klevuPagination.length) {
    console.log('Pagination HTML:', klevuPagination.first().html()?.replace(/\s+/g, ' ').slice(0, 300));
  }

  // Check how many pages of results Klevu has
  const pageLinks = $('[class*="kuPagination"] a, .kuPagination a');
  console.log('Page links:', pageLinks.length);
  pageLinks.each((_, el) => {
    const a = $(el);
    console.log(`  "${a.text().trim()}" href="${(a.attr('href') || '').slice(0, 50)}" data-page="${a.attr('data-page') || ''}"`);
  });

  await db.$disconnect();
  process.exit(0);
})();
