/**
 * Debug: fetch alflahertys /categories.php with Playwright and check what elements are present.
 */
(async () => {
  const { fetchWithPlaywright } = require('../dist/services/scraper/playwright-fetcher');
  const cheerio = require('cheerio');

  const url = 'https://www.alflahertys.com/categories.php';
  console.log('Fetching', url, 'with Playwright...');

  const result = await fetchWithPlaywright(url, { timeout: 45000 });
  console.log('HTML length:', result.html.length);

  const $ = cheerio.load(result.html);

  // Check what elements exist
  const checks = [
    '.card',
    '[data-product-id]',
    'li.product',
    '[class*="product-card"]',
    '[class*="product-item"]',
    '.productborder',
    '[class*="product"]',
    '.category',
    '[class*="category"]',
    '.navList-item',
    '.navList-action',
    'a[href*="/categories"]',
    'article',
    '.listItem',
    '[class*="listItem"]',
    'h1, h2, h3',
  ];

  console.log('\n=== ELEMENT COUNTS ===');
  for (const sel of checks) {
    const count = $(sel).length;
    if (count > 0) {
      console.log(`${sel}: ${count}`);
      // Show first example
      const first = $(sel).first();
      const text = first.text().trim().replace(/\s+/g, ' ').slice(0, 100);
      const cls = first.attr('class') || '';
      const href = first.attr('href') || first.find('a').first().attr('href') || '';
      console.log(`  class="${cls.slice(0, 80)}" text="${text}" href="${href.slice(0, 80)}"`);
    }
  }

  // Also check the page title
  console.log('\nPage title:', $('title').text());

  // Check for subcategory links
  console.log('\n=== SUBCATEGORY LINKS (first 20) ===');
  const links = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim().replace(/\s+/g, ' ');
    if (text.length > 2 && text.length < 60 && href.includes('alflahertys.com') && !href.includes('#')) {
      links.push({ text, href });
    }
  });
  // Deduplicate by href
  const seen = new Set();
  const unique = links.filter(l => { if (seen.has(l.href)) return false; seen.add(l.href); return true; });
  unique.slice(0, 30).forEach(l => console.log(`  "${l.text}" -> ${l.href}`));

  // Now try /firearms-and-ammunition/
  console.log('\n\n=== TRYING /firearms-and-ammunition/ ===');
  const result2 = await fetchWithPlaywright('https://www.alflahertys.com/firearms-and-ammunition/', { timeout: 45000 });
  console.log('HTML length:', result2.html.length);
  const $2 = cheerio.load(result2.html);
  console.log('.card count:', $2('.card').length);
  console.log('[class*="product"] count:', $2('[class*="product"]').length);
  console.log('h3 count:', $2('h3').length);

  // Show first few cards
  $2('.card').slice(0, 3).each((i, el) => {
    const card = $2(el);
    const title = card.find('[class*="title"], h3, h4').first().text().trim().replace(/\s+/g, ' ');
    const link = card.find('a[href]').first().attr('href') || '';
    console.log(`  Card ${i}: "${title.slice(0, 80)}" -> ${link.slice(0, 80)}`);
  });

  process.exit(0);
})();
