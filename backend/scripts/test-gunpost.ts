import axios from 'axios';
import * as cheerio from 'cheerio';

async function main() {
  // Test 1: Can we fetch /ads with regular HTTP?
  console.log('=== Test 1: Regular HTTP fetch of gunpost.ca/ads ===');
  try {
    const resp = await axios.get('https://www.gunpost.ca/ads', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 15000,
      validateStatus: () => true,
    });
    console.log(`  Status: ${resp.status}, HTML: ${resp.data.length} bytes`);

    const html = resp.data as string;
    // Check for WAF indicators
    if (html.includes('_Incapsula_Resource') || html.includes('Access Denied') || html.includes('403 Forbidden')) {
      console.log('  ⚠ WAF detected!');
    }

    const $ = cheerio.load(html);

    // Try GunPost adapter selectors
    const selectors = [
      '[class*="node--type-classified"]',
      '[class*="gunpost-teaser"]',
      '[class*="node--type-"][class*="teaser"]',
      '[class*="classified-ad"]',
      '[class*="classified-item"]',
      '[class*="listing-card"]',
      '[class*="listing-item"]',
      'article[class*="classified"]',
      'article[class*="listing"]',
    ];

    console.log('\n  Selector matches:');
    for (const sel of selectors) {
      const count = $(sel).length;
      if (count > 0) console.log(`    ${sel}: ${count} elements`);
    }

    // Also try broader selectors
    console.log('\n  Broader selectors:');
    console.log(`    article: ${$('article').length}`);
    console.log(`    [class*="node"]: ${$('[class*="node"]').length}`);
    console.log(`    [class*="teaser"]: ${$('[class*="teaser"]').length}`);
    console.log(`    [class*="views-row"]: ${$('[class*="views-row"]').length}`);

    // Show first few article/node classes to understand the structure
    console.log('\n  First 5 article/node class names:');
    $('article, [class*="node"]').slice(0, 5).each((i, el) => {
      console.log(`    [${i}] class="${$(el).attr('class')?.slice(0, 120)}"`);
    });

    // Show first 5 links that look like ads
    console.log('\n  First 5 links containing "/ad/":');
    $('a[href*="/ad/"], a[href*="/ads/"]').slice(0, 5).each((i, el) => {
      const href = $(el).attr('href');
      const text = $(el).text().trim().slice(0, 80);
      console.log(`    [${i}] ${href} — "${text}"`);
    });

  } catch (err: any) {
    console.log(`  ERROR: ${err.message}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
