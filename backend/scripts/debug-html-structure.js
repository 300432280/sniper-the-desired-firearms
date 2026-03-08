/**
 * Debug: inspect what HTML structure alflahertys category pages use for products.
 */
(async () => {
  const { fetchWithPlaywright } = require('../dist/services/scraper/playwright-fetcher');
  const cheerio = require('cheerio');

  const url = 'https://alflahertys.com/shooting-supplies-firearms-ammunition/firearms/rifles/';
  console.log('Fetching', url);

  const result = await fetchWithPlaywright(url, { timeout: 60000 });
  const $ = cheerio.load(result.html);
  console.log('HTML length:', result.html.length);

  // Check the 3 [class*="product"] elements
  console.log('\n=== [class*="product"] elements ===');
  $('[class*="product"]').each((i, el) => {
    const e = $(el);
    console.log(`${i}: tag=${el.tagName} class="${(e.attr('class') || '').slice(0, 120)}"`);
    console.log(`   text: "${e.text().trim().replace(/\s+/g, ' ').slice(0, 150)}"`);
  });

  // Look for common price indicators ($)
  console.log('\n=== Elements containing "$" (price indicators, first 10) ===');
  let priceCount = 0;
  $('*').each((_, el) => {
    if (priceCount >= 10) return false;
    const e = $(el);
    const ownText = e.clone().children().remove().end().text().trim();
    if (/\$\s*\d/.test(ownText) && ownText.length < 30) {
      console.log(`  tag=${el.tagName} class="${(e.attr('class') || '').slice(0, 80)}" text="${ownText}"`);
      // Show parent hierarchy
      let parent = e.parent();
      for (let i = 0; i < 3 && parent.length; i++) {
        console.log(`    parent[${i}]: tag=${parent[0]?.tagName} class="${(parent.attr('class') || '').slice(0, 80)}"`);
        parent = parent.parent();
      }
      priceCount++;
    }
  });

  // Check for "Add to Cart" buttons
  console.log('\n=== "Add to Cart" or "Choose options" buttons ===');
  $('button, [class*="button"], input[type="submit"]').each((i, el) => {
    const e = $(el);
    const text = e.text().trim();
    if (/add to cart|choose option|buy now/i.test(text) && i < 5) {
      console.log(`  ${el.tagName} class="${(e.attr('class') || '').slice(0, 80)}" text="${text.slice(0, 60)}"`);
    }
  });

  // Check for img tags (product thumbnails)
  console.log('\n=== img tags count ===');
  console.log('Total img:', $('img').length);
  console.log('img with src containing "product":', $('img[src*="product"]').length);
  console.log('img with data-src:', $('img[data-src]').length);

  // Look for common grid/listing patterns
  console.log('\n=== Grid/listing patterns ===');
  const patterns = [
    'ul.productGrid', '.productGrid', '[class*="productGrid"]',
    'ul.productList', '.productList', '[class*="productList"]',
    '.grid', '[class*="grid"]',
    '.products', '#product-listing',
    '[class*="listing"]', '[class*="catalog"]',
    '.category-products', '#main-content',
  ];
  for (const sel of patterns) {
    const count = $(sel).length;
    if (count > 0) {
      const first = $(sel).first();
      const children = first.children().length;
      console.log(`${sel}: ${count} (first has ${children} children, class="${(first.attr('class') || '').slice(0, 80)}")`);
    }
  }

  // Dump a section of the HTML around any price-like text
  const html = result.html;
  const priceIdx = html.indexOf('$');
  if (priceIdx > 0) {
    // Find the next price after the main content starts
    const mainIdx = html.indexOf('main-content') || html.indexOf('body');
    let searchFrom = mainIdx > 0 ? mainIdx : html.length / 3;
    let idx = html.indexOf('$', searchFrom);
    // Find a price that looks like a product price (not just $0 or currency selector)
    for (let tries = 0; tries < 20 && idx > 0; tries++) {
      const context = html.slice(idx, idx + 20);
      if (/\$\s*\d{2,}/.test(context)) {
        console.log('\n=== HTML context around first product price ===');
        console.log(html.slice(Math.max(0, idx - 500), idx + 500));
        break;
      }
      idx = html.indexOf('$', idx + 1);
    }
  }

  process.exit(0);
})();
