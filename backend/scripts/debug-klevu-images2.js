/**
 * Debug: dump raw HTML of Klevu product containers and check what extractCatalogProducts actually finds.
 */
(async () => {
  const { fetchWithPlaywright } = require('../dist/services/scraper/playwright-fetcher');
  const cheerio = require('cheerio');

  const url = 'https://alflahertys.com/shooting-supplies-firearms-ammunition/firearms/rifles/';
  console.log('Fetching', url);
  const result = await fetchWithPlaywright(url, { timeout: 60000 });
  const $ = cheerio.load(result.html);

  // Show raw HTML of first 2 klevuProduct elements
  console.log('\n=== First 2 [class*="klevuProduct"] raw HTML ===');
  $('[class*="klevuProduct"]').slice(0, 2).each((i, el) => {
    console.log(`\n--- klevuProduct[${i}] ---`);
    console.log($(el).html()?.replace(/\s+/g, ' ').slice(0, 500) || '(empty)');
  });

  // Show raw HTML of first 2 .kuResultsListing li
  console.log('\n=== First 2 .kuResultsListing li raw HTML ===');
  $('.kuResultsListing li').slice(0, 2).each((i, el) => {
    console.log(`\n--- kuResultsListing li[${i}] ---`);
    console.log($(el).html()?.replace(/\s+/g, ' ').slice(0, 500) || '(empty)');
  });

  // What does extractCatalogProducts actually match? Try ALL selectors
  const SELECTORS = [
    '[data-product-id]', 'li.product', 'li[class*="product"]',
    '[class*="product-card"]', '[class*="product-item"]', '[class*="product-tile"]',
    '[class*="ProductItem"]', '[class*="item-card"]', '[data-product]',
    'article[class*="product"]', '.card',
    '.productborder', '.product-thumb', '.product-layout', 'div.product',
    '[class*="klevuProduct"]', '.kuResultsListing li',
  ];
  console.log('\n=== Selector match counts ===');
  for (const sel of SELECTORS) {
    const count = $(sel).length;
    if (count > 0) {
      const first = $(sel).first();
      const text = first.text().trim().replace(/\s+/g, ' ').slice(0, 80);
      const imgs = first.find('img').length;
      console.log(`${sel}: ${count} (imgs: ${imgs}, text: "${text}")`);
    }
  }

  // Check for any img with src containing product image URLs
  console.log('\n=== All img tags with interesting src ===');
  let imgCount = 0;
  $('img').each((_, el) => {
    if (imgCount >= 10) return false;
    const img = $(el);
    const src = img.attr('src') || '';
    const dataSrc = img.attr('data-src') || '';
    const origin = img.attr('origin') || '';
    // Skip tiny icons, SVGs, tracking pixels
    if (/\.svg|1x1|pixel|tracking|logo|icon|favicon/i.test(src + dataSrc)) return;
    if (src.length < 10 && !dataSrc && !origin) return;
    console.log(`  src="${src.slice(0, 100)}" data-src="${dataSrc.slice(0, 100)}" origin="${origin.slice(0, 100)}" class="${(img.attr('class') || '').slice(0, 40)}"`);
    imgCount++;
  });

  // Check: are product images loaded via CSS background-image?
  console.log('\n=== Elements with background-image style (first 5) ===');
  let bgCount = 0;
  $('[style*="background-image"]').each((_, el) => {
    if (bgCount >= 5) return false;
    const style = $(el).attr('style') || '';
    console.log(`  tag=${el.tagName} class="${($(el).attr('class') || '').slice(0, 60)}" style="${style.slice(0, 150)}"`);
    bgCount++;
  });

  // What about the actual search page? The keyword crawl goes through search.php
  console.log('\n\n========== SEARCH PAGE ==========');
  const result2 = await fetchWithPlaywright('https://alflahertys.com/search.php?search_query=sks', { timeout: 60000 });
  const $2 = cheerio.load(result2.html);

  // Check BigCommerce native search results (not Klevu overlay)
  console.log('.productGrid:', $2('.productGrid').length);
  console.log('.productGrid .product:', $2('.productGrid .product').length);
  console.log('[data-product-id]:', $2('[data-product-id]').length);

  // Show first product card from search results with its img
  const searchCard = $2('.card').first();
  if (searchCard.length) {
    console.log('\nFirst .card HTML:');
    console.log(searchCard.html()?.replace(/\s+/g, ' ').slice(0, 800) || '(empty)');
  }

  // Check for product cards in search results
  const prodCards = $2('[class*="product"]');
  console.log('\n[class*="product"] count:', prodCards.length);
  prodCards.slice(0, 3).each((i, el) => {
    const e = $2(el);
    const cls = e.attr('class') || '';
    const img = e.find('img').first();
    const imgSrc = img.attr('src') || img.attr('data-src') || '';
    console.log(`  [${i}] class="${cls.slice(0, 80)}" img="${imgSrc.slice(0, 100)}"`);
  });

  process.exit(0);
})();
