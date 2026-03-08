/**
 * Debug: check what HTML structure alflahertys search page produces for SKS products.
 * Look for ANY img elements near the product links.
 */
(async () => {
  const { fetchWithPlaywright } = require('../dist/services/scraper/playwright-fetcher');
  const cheerio = require('cheerio');

  const url = 'https://alflahertys.com/search.php?search_query=sks';
  console.log('Fetching', url);
  const result = await fetchWithPlaywright(url, { timeout: 60000 });
  const $ = cheerio.load(result.html);
  console.log('HTML length:', result.html.length);

  // Find all <a> tags containing "sks" (case insensitive)
  console.log('\n=== Links containing "sks" ===');
  $('a[href]').each((_, el) => {
    const a = $(el);
    const text = a.text().trim().replace(/\s+/g, ' ');
    if (!/sks/i.test(text)) return;
    if (text.length < 5 || text.length > 200) return;
    const href = a.attr('href') || '';
    console.log(`\n  text: "${text.slice(0, 100)}"`);
    console.log(`  href: "${href.slice(0, 100)}"`);

    // Walk up to find any img nearby
    let parent = a.parent();
    for (let i = 0; i < 5 && parent.length; i++) {
      const imgs = parent.find('img');
      if (imgs.length > 0) {
        const img = imgs.first();
        console.log(`  img found at level ${i}:`);
        const attrs = img[0].attribs || {};
        for (const [key, value] of Object.entries(attrs)) {
          console.log(`    ${key} = "${String(value).slice(0, 120)}"`);
        }
        break;
      }
      parent = parent.parent();
    }
  });

  // Check if there are .klevuProduct elements with actual content (wait longer?)
  console.log('\n=== Klevu products with content ===');
  const klevuProducts = $('[class*="klevuProduct"]');
  let withContent = 0;
  klevuProducts.each((_, el) => {
    const text = $(el).text().trim();
    if (text.length > 5) withContent++;
  });
  console.log(`Total: ${klevuProducts.length}, with content: ${withContent}`);

  // Show first Klevu product with content
  klevuProducts.each((_, el) => {
    const e = $(el);
    const text = e.text().trim().replace(/\s+/g, ' ');
    if (text.length > 5 && /sks/i.test(text)) {
      console.log(`\nKlevu product with SKS:`);
      console.log(`  text: "${text.slice(0, 150)}"`);
      const img = e.find('img');
      console.log(`  img count: ${img.length}`);
      if (img.length) {
        const attrs = img.first()[0].attribs || {};
        for (const [key, value] of Object.entries(attrs)) {
          console.log(`    ${key} = "${String(value).slice(0, 120)}"`);
        }
      }
      return false; // break
    }
  });

  process.exit(0);
})();
