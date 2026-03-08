/**
 * Test: verify Playwright paginated search for henry on alflahertys.
 */
(async () => {
  const { fetchWithPlaywrightPaginated } = require('../dist/services/scraper/playwright-fetcher');
  const { GenericRetailAdapter } = require('../dist/services/scraper/adapters/generic-retail');
  const cheerio = require('cheerio');

  const adapter = new GenericRetailAdapter();
  const url = 'https://alflahertys.com/search.php?search_query=henry';
  console.log('Fetching with paginated Playwright:', url);

  const result = await fetchWithPlaywrightPaginated(url, { timeout: 60000, maxPages: 3 });
  console.log(`Got ${result.pages.length} pages in ${result.responseTimeMs}ms`);

  let totalMatches = 0;
  const allMatches = [];
  for (let i = 0; i < result.pages.length; i++) {
    const $ = cheerio.load(result.pages[i]);
    const matches = adapter.extractMatches($, 'henry', url, { inStockOnly: false });
    console.log(`  Page ${i + 1}: ${matches.length} matches, HTML ${result.pages[i].length} bytes`);
    totalMatches += matches.length;
    allMatches.push(...matches);
  }
  console.log(`\nTotal: ${totalMatches} matches across ${result.pages.length} pages`);
  console.log(`With thumbnails: ${allMatches.filter(m => m.thumbnail).length}`);
  console.log(`With prices: ${allMatches.filter(m => m.price).length}`);

  // Show a few from page 2+ to verify they're different products
  if (result.pages.length > 1) {
    const page2$ = cheerio.load(result.pages[1]);
    const page2Matches = adapter.extractMatches(page2$, 'henry', url, { inStockOnly: false });
    console.log('\nSample from page 2:');
    page2Matches.slice(0, 5).forEach(m =>
      console.log(`  ${m.title?.slice(0, 55)} | $${m.price} | thumb=${m.thumbnail ? 'YES' : 'NO'}`)
    );
  }

  process.exit(0);
})();
