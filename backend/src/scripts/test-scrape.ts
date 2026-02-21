import axios from 'axios';
import * as cheerio from 'cheerio';
import { pickUserAgent } from '../services/scraper/http-client';

async function testUrl(url: string) {
  const ua = pickUserAgent();
  try {
    const resp = await axios.get(url, {
      headers: { 'User-Agent': ua },
      timeout: 15000,
      maxRedirects: 5,
      validateStatus: () => true,
    });
    const html: string = typeof resp.data === 'string' ? resp.data : '';
    const $ = cheerio.load(html);
    const refs = (html.match(/tm22|TM22|tm-22|TM-22/gi) || []).length;
    const title = $('title').text().trim().slice(0, 50);

    // Count product links
    let productLinks = 0;
    $('a[href*="product_detail"]').each((_: number, el: any) => {
      const text = $(el).text().trim();
      if (text.toLowerCase().includes('tm22') || $(el).attr('href')?.toLowerCase().includes('tm22')) {
        productLinks++;
        if (productLinks <= 5) {
          console.log(`    "${text.slice(0, 60)}" → ${$(el).attr('href')?.slice(0, 80)}`);
        }
      }
    });

    console.log(`  ${url.replace('https://www.irunguns.ca', '').padEnd(60)} ${resp.status} refs:${refs} tm22-links:${productLinks} "${title}"`);
  } catch (e: any) {
    console.log(`  ERR: ${e.message.slice(0, 40)}`);
  }
}

async function main() {
  console.log('=== irunguns.ca: Testing search URL patterns ===\n');
  const patterns = [
    'https://www.irunguns.ca/product.php?search_term=tm22',
    'https://www.irunguns.ca/product.php?product_name=tm22',
    'https://www.irunguns.ca/product.php?q=tm22',
    'https://www.irunguns.ca/product.php?keyword=tm22',
    'https://www.irunguns.ca/product.php?s=tm22',
    'https://www.irunguns.ca/subcategory.php?parent=Firearms&search_term=tm22',
    'https://www.irunguns.ca/product.php?departments=Rifles&search_term=tm22',
    'https://www.irunguns.ca/product.php?type=featured&search_term=tm22',
  ];

  for (const url of patterns) {
    await testUrl(url);
  }

  // Also try POST-based search
  console.log('\n=== POST-based search ===');
  const ua = pickUserAgent();
  for (const [formUrl, body] of [
    ['https://www.irunguns.ca/product.php', 'product_name=tm22'],
    ['https://www.irunguns.ca/product.php', 'search_term=tm22'],
    ['https://www.irunguns.ca/index.php', 'product_name=tm22'],
  ] as const) {
    try {
      const resp = await axios.post(formUrl, body, {
        headers: {
          'User-Agent': ua,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 15000,
        maxRedirects: 5,
        validateStatus: () => true,
      });
      const html: string = typeof resp.data === 'string' ? resp.data : '';
      const $ = cheerio.load(html);
      const refs = (html.match(/tm22|TM22/gi) || []).length;
      let tm22Links = 0;
      $('a[href*="tm22"], a[href*="TM22"]').each(() => { tm22Links++; });
      console.log(`  POST ${formUrl.replace('https://www.irunguns.ca', '')} [${body}]  ${resp.status} refs:${refs} links:${tm22Links}`);
    } catch (e: any) {
      console.log(`  POST ERR: ${e.message.slice(0, 40)}`);
    }
  }

  process.exit(0);
}

main().catch(console.error);
