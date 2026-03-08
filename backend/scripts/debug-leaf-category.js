/**
 * Debug: check if alflahertys leaf category pages have product cards.
 */
(async () => {
  const { fetchWithPlaywright } = require('../dist/services/scraper/playwright-fetcher');
  const cheerio = require('cheerio');

  const urls = [
    'https://alflahertys.com/shooting-supplies-firearms-ammunition/firearms/rifles/',
    'https://alflahertys.com/shooting-supplies-firearms-and-ammunition/firearms/shotguns/',
    'https://alflahertys.com/shooting-supplies-firearms-ammunition/ammunition/centerfire-ammunition/',
    'https://alflahertys.com/als-bargains/',
  ];

  for (const url of urls) {
    console.log(`\n=== ${url.split('.com')[1]} ===`);
    try {
      const result = await fetchWithPlaywright(url, { timeout: 45000 });
      const $ = cheerio.load(result.html);
      console.log('HTML:', result.html.length, 'bytes');
      console.log('.card:', $('card').length);
      console.log('.card (class):', $('[class*="card"]').length);
      console.log('.productCard:', $('[class*="productCard"]').length);
      console.log('.product:', $('[class*="product"]').length);
      console.log('article.card:', $('article.card').length);
      console.log('[data-product-id]:', $('[data-product-id]').length);

      // Try to find product-like elements
      const cards = $('.card');
      if (cards.length > 0) {
        console.log('First card:');
        const first = cards.first();
        console.log('  class:', first.attr('class'));
        console.log('  text:', first.text().trim().replace(/\s+/g, ' ').slice(0, 120));
      }

      // Check for listItem (BigCommerce uses .listItem for category product grids sometimes)
      console.log('.listItem:', $('.listItem').length);
      console.log('[class*="listItem"]:', $('[class*="listItem"]').length);

      // Check pagination
      const pagination = $('[class*="pagination"]');
      console.log('Pagination elements:', pagination.length);
      if (pagination.length) {
        const nextLink = pagination.find('a').last();
        console.log('Last pagination link:', nextLink.attr('href'), nextLink.text().trim());
      }
    } catch (e) {
      console.log('Error:', e.message);
    }
  }

  process.exit(0);
})();
