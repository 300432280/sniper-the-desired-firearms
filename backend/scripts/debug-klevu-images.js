/**
 * Debug: inspect actual img attributes inside Klevu product elements on alflahertys.
 */
(async () => {
  const { fetchWithPlaywright } = require('../dist/services/scraper/playwright-fetcher');
  const cheerio = require('cheerio');

  // Test both: search results page and a category page
  const urls = [
    'https://alflahertys.com/search.php?search_query=sks',
    'https://alflahertys.com/shooting-supplies-firearms-ammunition/firearms/rifles/',
  ];

  for (const url of urls) {
    console.log(`\n========== ${url.split('.com')[1]} ==========`);
    const result = await fetchWithPlaywright(url, { timeout: 60000 });
    const $ = cheerio.load(result.html);

    // Find all img tags inside Klevu product containers
    const klevuProducts = $('[class*="klevuProduct"], .kuResultsListing li');
    console.log(`Klevu product elements: ${klevuProducts.length}`);

    // Show ALL attributes of the first 3 product images
    klevuProducts.slice(0, 3).each((i, el) => {
      const product = $(el);
      const imgs = product.find('img');
      console.log(`\n--- Product ${i} (${imgs.length} img tags) ---`);
      const title = product.find('.kuName a, [class*="kuName"]').first().text().trim().slice(0, 60);
      console.log(`Title: "${title}"`);

      imgs.each((j, imgEl) => {
        const img = $(imgEl);
        console.log(`  img[${j}] attributes:`);
        const attrs = imgEl.attribs || {};
        for (const [key, value] of Object.entries(attrs)) {
          const val = String(value).slice(0, 150);
          console.log(`    ${key} = "${val}"`);
        }
      });
    });

    // Also check: are there any non-Klevu product elements with images?
    console.log('\n--- Non-Klevu .card images ---');
    const cards = $('.card');
    console.log(`BigCommerce .card elements: ${cards.length}`);
    cards.slice(0, 2).each((i, el) => {
      const card = $(el);
      const img = card.find('img').first();
      if (img.length) {
        const attrs = img[0].attribs || {};
        console.log(`  card[${i}] img attrs:`, JSON.stringify(attrs).slice(0, 300));
      }
    });
  }

  process.exit(0);
})();
