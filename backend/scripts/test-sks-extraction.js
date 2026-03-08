/**
 * Test: simulate what extractMatches does for SKS on alflahertys search page.
 * Uses the actual compiled adapter to test thumbnail extraction end-to-end.
 */
(async () => {
  const { fetchWithPlaywright } = require('../dist/services/scraper/playwright-fetcher');
  const { GenericRetailAdapter } = require('../dist/services/scraper/adapters/generic-retail');
  const cheerio = require('cheerio');

  const adapter = new GenericRetailAdapter();
  const url = 'https://alflahertys.com/search.php?search_query=sks';
  console.log('Fetching', url);
  const result = await fetchWithPlaywright(url, { timeout: 60000 });
  const $ = cheerio.load(result.html);
  console.log('HTML length:', result.html.length);

  // Run the actual extractMatches
  const matches = adapter.extractMatches($, 'sks', url, { inStockOnly: false });
  console.log(`\nextractMatches found ${matches.length} results:`);
  matches.forEach((m, i) => {
    console.log(`  [${i}] "${m.title?.slice(0, 60)}" thumb=${m.thumbnail ? m.thumbnail.slice(0, 80) : 'null'} price=${m.price}`);
  });

  // Also test extractCatalogProducts on a category page
  const catUrl = 'https://alflahertys.com/shooting-supplies-firearms-ammunition/firearms/rifles/';
  console.log('\n\nFetching', catUrl);
  const catResult = await fetchWithPlaywright(catUrl, { timeout: 60000 });
  const $cat = cheerio.load(catResult.html);

  const catProducts = adapter.extractCatalogProducts($cat, catUrl);
  console.log(`\nextractCatalogProducts found ${catProducts.length} products`);
  const withThumb = catProducts.filter(p => p.thumbnail);
  console.log(`With thumbnails: ${withThumb.length}`);
  withThumb.slice(0, 3).forEach((p, i) => {
    console.log(`  [${i}] "${p.title?.slice(0, 50)}" thumb=${p.thumbnail?.slice(0, 80)}`);
  });
  const noThumb = catProducts.filter(p => !p.thumbnail);
  console.log(`Without thumbnails: ${noThumb.length}`);
  noThumb.slice(0, 3).forEach((p, i) => {
    console.log(`  [${i}] "${p.title?.slice(0, 50)}" url=${p.url?.slice(0, 60)}`);
  });

  process.exit(0);
})();
