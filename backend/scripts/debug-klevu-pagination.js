/**
 * Debug: check Klevu pagination mechanism on search page.
 */
(async () => {
  const { fetchWithPlaywright } = require('../dist/services/scraper/playwright-fetcher');
  const { GenericRetailAdapter } = require('../dist/services/scraper/adapters/generic-retail');
  const cheerio = require('cheerio');

  const adapter = new GenericRetailAdapter();
  const url = 'https://alflahertys.com/search.php?search_query=henry';
  console.log('Fetching', url);
  const result = await fetchWithPlaywright(url, { timeout: 60000 });
  const $ = cheerio.load(result.html);

  // What does getNextPageUrl return?
  const nextUrl = adapter.getNextPageUrl($, url);
  console.log('getNextPageUrl returns:', nextUrl);

  // Show the Klevu pagination HTML
  const paginationEl = $('[class*="kuPaginat"], [class*="klevuPaginat"]');
  console.log('\nKlevu pagination HTML:', paginationEl.length ? paginationEl.html()?.replace(/\s+/g, ' ').trim() : '(not found)');

  // Show BigCommerce-style pagination
  const bcPagination = $('.pagination, [class*="pagination"]');
  console.log('BC pagination elements:', bcPagination.length);
  bcPagination.each((i, el) => {
    console.log(`  [${i}] class="${($(el).attr('class') || '').slice(0, 60)}" html="${$(el).html()?.replace(/\s+/g, ' ').slice(0, 200)}"`);
  });

  // Count total products on this page
  const matches = adapter.extractMatches($, 'henry', url, { inStockOnly: false });
  console.log('\nPage 1 matches:', matches.length);

  // Check: Klevu pagination uses data-offset attribute
  const klevuPageLinks = $('a.klevuPaginate, [class*="klevuPaginate"]');
  console.log('\nKlevu page links:');
  klevuPageLinks.each((_, el) => {
    const a = $(el);
    console.log(`  text="${a.text().trim()}" offset="${a.attr('data-offset')}" class="${a.attr('class')}"`);
  });

  process.exit(0);
})();
