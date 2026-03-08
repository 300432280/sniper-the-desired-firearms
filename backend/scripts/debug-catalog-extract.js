/**
 * Debug: run extractCatalogProducts on a catalog page and check thumbnails.
 */
(async () => {
  const { fetchWithPlaywright } = require('../dist/services/scraper/playwright-fetcher');
  const { GenericRetailAdapter } = require('../dist/services/scraper/adapters/generic-retail');
  const cheerio = require('cheerio');

  const adapter = new GenericRetailAdapter();
  const url = 'https://alflahertys.com/shooting-supplies-firearms-ammunition/firearms/rifles/';
  console.log('Fetching', url);
  const result = await fetchWithPlaywright(url, { timeout: 60000 });
  const $ = cheerio.load(result.html);

  const products = adapter.extractCatalogProducts($, url);
  console.log(`extractCatalogProducts found ${products.length} products`);

  const withThumb = products.filter(p => p.thumbnail);
  const noThumb = products.filter(p => !p.thumbnail);
  console.log(`With thumbnail: ${withThumb.length}`);
  console.log(`Without thumbnail: ${noThumb.length}`);

  console.log('\nProducts WITHOUT thumbnail:');
  noThumb.slice(0, 10).forEach(p =>
    console.log(`  "${p.title.slice(0, 60)}" | ${p.url.replace('https://alflahertys.com', '').slice(0, 50)}`)
  );

  console.log('\nProducts WITH thumbnail (sample):');
  withThumb.slice(0, 5).forEach(p =>
    console.log(`  "${p.title.slice(0, 60)}" | thumb=${(p.thumbnail || '').slice(0, 70)}`)
  );

  process.exit(0);
})();
