/**
 * Debug: find the exact Klevu product container structure on alflahertys.
 */
(async () => {
  const { fetchWithPlaywright } = require('../dist/services/scraper/playwright-fetcher');
  const cheerio = require('cheerio');

  const url = 'https://alflahertys.com/shooting-supplies-firearms-ammunition/firearms/rifles/';
  console.log('Fetching', url);

  const result = await fetchWithPlaywright(url, { timeout: 60000 });
  const $ = cheerio.load(result.html);

  // Find all elements with ku- prefixed classes
  console.log('=== Elements with ku* classes ===');
  const kuSelectors = [
    '[class*="klevuProduct"]', '[class*="kuProduct"]',
    '[class*="kuResult"]', '.kuResultsListing',
    '.kuResultsListing li', '[class*="klevuLanding"]',
    '.klevuLanding', '[class*="kuLandingProducts"]',
    '.kuElement', '[class*="kuElement"]',
    '[ku-block]', '[data-block-id]',
  ];
  for (const sel of kuSelectors) {
    const count = $(sel).length;
    if (count > 0) {
      console.log(`${sel}: ${count}`);
      const first = $(sel).first();
      console.log(`  class: "${(first.attr('class') || '').slice(0, 100)}"`);
      console.log(`  tag: ${first[0]?.tagName}, children: ${first.children().length}`);
    }
  }

  // Walk UP from a price element to find the product container
  console.log('\n=== Walking up from .kuSalePrice to find product container ===');
  const priceEl = $('.kuSalePrice').first();
  if (priceEl.length) {
    let current = priceEl;
    for (let i = 0; i < 8 && current.length; i++) {
      const tag = current[0]?.tagName || '?';
      const cls = (current.attr('class') || '').slice(0, 120);
      const children = current.children().length;
      const siblings = current.siblings().length;
      console.log(`  Level ${i}: <${tag}> class="${cls}" children=${children} siblings=${siblings}`);
      current = current.parent();
    }
  }

  // Find the product grid container (parent of all products)
  console.log('\n=== Looking for product grid/list container ===');
  const productList = $('.productList').first();
  if (productList.length) {
    console.log('productList class:', productList.attr('class'));
    console.log('productList children:', productList.children().length);
    // Show first child's structure
    const firstChild = productList.children().first();
    console.log('First child tag:', firstChild[0]?.tagName, 'class:', (firstChild.attr('class') || '').slice(0, 100));
    console.log('First child children:', firstChild.children().length);

    // Go deeper
    const deeper = firstChild.children().first();
    if (deeper.length) {
      console.log('  > tag:', deeper[0]?.tagName, 'class:', (deeper.attr('class') || '').slice(0, 100));
      console.log('  > children:', deeper.children().length);

      // Show first product-like element
      deeper.children().slice(0, 3).each((i, el) => {
        const e = $(el);
        console.log(`  >> [${i}] tag:${el.tagName} class:"${(e.attr('class') || '').slice(0, 100)}" children:${e.children().length}`);
        // Show its children
        e.children().slice(0, 5).each((j, child) => {
          const c = $(child);
          console.log(`     [${j}] <${child.tagName}> class:"${(c.attr('class') || '').slice(0, 80)}" text:"${c.text().trim().replace(/\s+/g, ' ').slice(0, 80)}"`);
        });
      });
    }
  }

  // Count total kuSalePrice elements (= product count)
  console.log('\n=== Product count estimate ===');
  console.log('.kuSalePrice count:', $('.kuSalePrice').length);
  console.log('.kuProdBottom count:', $('.kuProdBottom').length);

  // Extract HTML around the first product
  console.log('\n=== Raw HTML of first Klevu product (around kuSalePrice) ===');
  const firstPrice = $('.kuSalePrice').first();
  if (firstPrice.length) {
    // Walk up to find the product container (usually ~4 levels up)
    let container = firstPrice;
    for (let i = 0; i < 5; i++) container = container.parent();
    // Show a cleaned snippet
    const html = container.html() || '';
    console.log('Container tag:', container[0]?.tagName, 'class:', (container.attr('class') || ''));
    console.log('Container HTML (first 2000 chars):');
    console.log(html.replace(/\s+/g, ' ').slice(0, 2000));
  }

  process.exit(0);
})();
