import { fetchWithPlaywright } from '../src/services/scraper/playwright-fetcher';
import * as cheerio from 'cheerio';

async function main() {
  console.log('=== Testing GunPost /ads via Playwright ===');
  try {
    const result = await fetchWithPlaywright('https://www.gunpost.ca/ads', { timeout: 30000 });
    console.log(`  HTML: ${result.html.length} bytes`);

    const $ = cheerio.load(result.html);

    // Check GunPost adapter selectors
    const selectors = [
      '[class*="node--type-classified"]',
      '[class*="gunpost-teaser"]',
      '[class*="node--type-"][class*="teaser"]',
      'article[class*="classified"]',
      'article',
      '[class*="views-row"]',
    ];

    console.log('\n  Selector matches:');
    for (const sel of selectors) {
      const count = $(sel).length;
      if (count > 0) console.log(`    ${sel}: ${count} elements`);
    }

    // Show first 3 article classes
    $('article').slice(0, 3).each((i, el) => {
      const cls = $(el).attr('class')?.slice(0, 150) || 'no class';
      const title = $(el).find('h1,h2,h3,h4').first().text().trim().slice(0, 80);
      console.log(`    article[${i}] class="${cls}" title="${title}"`);
    });

    // Count links to /ad/ pages
    const adLinks = $('a[href*="/ad/"]').length;
    console.log(`\n  Links to /ad/ pages: ${adLinks}`);

  } catch (err: any) {
    console.log(`  Playwright FAILED: ${err.message}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
