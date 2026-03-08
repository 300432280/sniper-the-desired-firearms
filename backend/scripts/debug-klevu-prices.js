/**
 * Debug: check why some Klevu products have no price (sold out items).
 */
(async () => {
  const { fetchWithPlaywright } = require('../dist/services/scraper/playwright-fetcher');
  const cheerio = require('cheerio');

  const url = 'https://alflahertys.com/search.php?search_query=henry';
  console.log('Fetching', url);
  const result = await fetchWithPlaywright(url, { timeout: 60000 });
  const $ = cheerio.load(result.html);

  // Find Klevu products and check their price structure
  const klevuProducts = $('[class*="klevuProduct"]');
  let withPrice = 0, noPrice = 0;

  klevuProducts.each((_, el) => {
    const product = $(el);
    const text = product.text().trim().replace(/\s+/g, ' ');
    if (text.length < 10) return; // skip empty containers
    if (!/henry/i.test(text)) return;

    const priceEl = product.find('[class*="kuPrice"], [class*="kuSalePrice"], [class*="price"]');
    const priceText = priceEl.text().trim();
    const hasStock = /out of stock|sold out/i.test(text);
    const title = product.find('.kuName a, [class*="kuName"]').first().text().trim().slice(0, 50);

    if (/\$\s*[\d,]+/.test(priceText)) {
      withPrice++;
    } else {
      noPrice++;
      console.log(`NO PRICE: "${title}" | priceEl="${priceText}" | OOS=${hasStock}`);
      // Show the full price area HTML
      const priceHtml = product.find('[class*="kuPrice"], .kuProdBottom').first().html();
      console.log(`  price HTML: ${(priceHtml || '').replace(/\s+/g, ' ').slice(0, 200)}`);
      // Show full product bottom HTML
      const bottomHtml = product.find('.kuProdBottom, footer').first().html();
      console.log(`  bottom HTML: ${(bottomHtml || '').replace(/\s+/g, ' ').slice(0, 300)}`);
    }
  });

  console.log(`\nWith price: ${withPrice}, No price: ${noPrice}`);

  process.exit(0);
})();
