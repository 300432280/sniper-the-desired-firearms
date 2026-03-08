/**
 * Debug: check image attributes on BigCommerce catalog pages (not Klevu search).
 */
(async () => {
  const { fetchWithPlaywright } = require('../dist/services/scraper/playwright-fetcher');
  const cheerio = require('cheerio');

  const url = 'https://alflahertys.com/shooting-supplies-firearms-ammunition/firearms/rifles/';
  console.log('Fetching', url);
  const result = await fetchWithPlaywright(url, { timeout: 60000 });
  const $ = cheerio.load(result.html);

  // Check .card elements (BigCommerce product cards)
  const cards = $('.card');
  console.log(`Found ${cards.length} .card elements`);

  cards.each((i, el) => {
    if (i >= 5) return; // Just show first 5
    const card = $(el);
    const title = card.find('.card-title').text().trim().replace(/\s+/g, ' ').slice(0, 50);
    const img = card.find('img').first();
    if (!img.length) {
      console.log(`\n[${i}] "${title}" — NO IMG FOUND`);
      return;
    }
    console.log(`\n[${i}] "${title}"`);
    console.log(`  src="${(img.attr('src') || '').slice(0, 100)}"`);
    console.log(`  data-src="${(img.attr('data-src') || '').slice(0, 100)}"`);
    console.log(`  data-lazy-src="${(img.attr('data-lazy-src') || '').slice(0, 100)}"`);
    console.log(`  data-original="${(img.attr('data-original') || '').slice(0, 100)}"`);
    console.log(`  origin="${(img.attr('origin') || '').slice(0, 100)}"`);
    console.log(`  loading="${img.attr('loading') || ''}"`);
    // Show ALL attributes
    const attrs = img[0].attribs || {};
    console.log(`  all attrs: ${Object.keys(attrs).join(', ')}`);
  });

  // Also check Klevu results on the same page
  const klevuProducts = $('[class*="klevuProduct"]');
  console.log(`\nKlevu products on catalog page: ${klevuProducts.length}`);
  klevuProducts.each((i, el) => {
    if (i >= 3) return;
    const prod = $(el);
    const img = prod.find('img').first();
    const title = prod.find('.kuName a, [class*="kuName"]').first().text().trim().slice(0, 50);
    if (!img.length) {
      console.log(`  Klevu [${i}] "${title}" — NO IMG`);
      return;
    }
    console.log(`  Klevu [${i}] "${title}"`);
    console.log(`    src="${(img.attr('src') || '').slice(0, 80)}"`);
    console.log(`    origin="${(img.attr('origin') || '').slice(0, 80)}"`);
    console.log(`    all attrs: ${Object.keys(img[0].attribs || {}).join(', ')}`);
  });

  process.exit(0);
})();
