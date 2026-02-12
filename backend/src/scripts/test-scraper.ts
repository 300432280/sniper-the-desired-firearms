/**
 * Quick scraper smoke-test — run without starting the full server.
 *
 * Usage:
 *   cd backend
 *   npx ts-node src/scripts/test-scraper.ts "SKS" "https://www.ellwoodepps.com/collections/rifles"
 *   npx ts-node src/scripts/test-scraper.ts "9mm" "https://www.wolverinesupplies.com/Ammo_1.html"
 */

import '../config'; // load .env and validate
import { scrapeForKeyword } from '../services/scraper';

const [, , keyword, url] = process.argv;

if (!keyword || !url) {
  console.error('Usage: ts-node test-scraper.ts <keyword> <url>');
  process.exit(1);
}

console.log(`\nScraping "${keyword}" from ${url}\n`);

scrapeForKeyword(url, keyword)
  .then((result) => {
    console.log(`Hash:       ${result.contentHash}`);
    console.log(`Scraped at: ${result.scrapedAt.toISOString()}`);
    console.log(`Matches:    ${result.matches.length}\n`);
    result.matches.forEach((m, i) => {
      console.log(`  [${i + 1}] ${m.title}`);
      if (m.price) console.log(`       Price: $${m.price.toFixed(2)}`);
      console.log(`       URL:   ${m.url}`);
      console.log(`       Stock: ${m.inStock ? 'In Stock' : 'Out / Unknown'}`);
      console.log();
    });
    process.exit(0);
  })
  .catch((err) => {
    console.error('Scrape failed:', err.message);
    process.exit(1);
  });
