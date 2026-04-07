import 'dotenv/config';
import * as cheerio from 'cheerio';
import { fetchWithPlaywright } from '../src/services/scraper/playwright-fetcher';

async function main() {
  const ORIGIN = 'https://doctordeals.ca';
  const url = ORIGIN + '/product-category/gun-shop/firearms/rifles/';

  console.log(`Fetching ${url} ...`);
  const r = await fetchWithPlaywright(url, { timeout: 60000 });
  const html = r.html || '';
  console.log(`HTML length: ${html.length}`);
  console.log(`First 800 chars: ${html.slice(0, 800)}`);

  const $ = cheerio.load(html);

  console.log(`\n=== Title ===`);
  console.log($('title').text().slice(0, 100));

  console.log(`\n=== H1 / H2 (first 5 each) ===`);
  $('h1').slice(0, 5).each((_, el) => console.log(`  h1: ${$(el).text().trim().slice(0, 80)}`));
  $('h2').slice(0, 5).each((_, el) => console.log(`  h2: ${$(el).text().trim().slice(0, 80)}`));

  console.log(`\n=== Body class ===`);
  console.log(`  body class: ${$('body').attr('class') || ''}`);

  console.log(`\n=== All <a href> link patterns (first 30) ===`);
  const linkPatterns = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (href.startsWith('/') || href.startsWith('https://doctordeals.ca')) {
      const path = href.startsWith('http') ? new URL(href).pathname : href;
      const segments = path.split('/').slice(0, 4).join('/');
      if (segments) linkPatterns.add(segments);
    }
  });
  for (const p of Array.from(linkPatterns).slice(0, 30)) console.log(`  ${p}`);

  console.log(`\n=== Element counts ===`);
  console.log(`  total <a>: ${$('a').length}`);
  console.log(`  a[href*="/product/"]: ${$('a[href*="/product/"]').length}`);
  console.log(`  a[href*="/shop/"]: ${$('a[href*="/shop/"]').length}`);
  console.log(`  li.product: ${$('li.product').length}`);
  console.log(`  .product: ${$('.product').length}`);
  console.log(`  [class*=product-card]: ${$('[class*="product-card"]').length}`);
  console.log(`  .wd-product: ${$('.wd-product').length}`);
  console.log(`  .product-small: ${$('.product-small').length}`);
  console.log(`  div[class*=type-product]: ${$('div[class*="type-product"]').length}`);
  console.log(`  [data-product-id]: ${$('[data-product-id]').length}`);

  // Check for any "challenge" or "blocked" markers
  const lowerHtml = html.toLowerCase();
  console.log(`\n=== WAF markers ===`);
  console.log(`  contains "sucuri": ${lowerHtml.includes('sucuri')}`);
  console.log(`  contains "cloudflare": ${lowerHtml.includes('cloudflare')}`);
  console.log(`  contains "just a moment": ${lowerHtml.includes('just a moment')}`);
  console.log(`  contains "checking your browser": ${lowerHtml.includes('checking your browser')}`);
  console.log(`  contains "access denied": ${lowerHtml.includes('access denied')}`);
  console.log(`  contains "403 forbidden": ${lowerHtml.includes('403 forbidden')}`);
  console.log(`  contains "error 1020": ${lowerHtml.includes('error 1020')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
