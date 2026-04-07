/**
 * Investigate doctordeals.ca for:
 * 1. WAF type (Sucuri vs Cloudflare)
 * 2. WP REST API count via x-wp-total header
 * 3. Existing catalogUrls work (with proper WAF handling)
 * 4. Date-sortable URL pattern (?orderby=date)
 * 5. Newest-first verification on category page
 * 6. Discover any missing categories
 * 7. Sitemap availability (often /product-sitemap.xml on WooCommerce)
 */
import 'dotenv/config';
import * as cheerio from 'cheerio';
import axios from 'axios';
import { fetchPageWithMeta } from '../src/services/scraper/http-client';
import { fetchWithPlaywright } from '../src/services/scraper/playwright-fetcher';

const ORIGIN = 'https://doctordeals.ca';

async function get(url: string) {
  // Try HTTP first
  try {
    const r = await fetchPageWithMeta(url, undefined, { timeout: 25000 });
    const status = r.statusCode || 0;
    const html = r.html || '';
    // Real success → return immediately
    if (status === 200 && html.length > 1000 && !html.includes('Just a moment') && !html.includes('Sucuri')) {
      return { status, html, via: 'http' };
    }
    // Otherwise (403, WAF challenge, empty) fall through to Playwright
  } catch {}
  // Playwright fallback
  try {
    const r = await fetchWithPlaywright(url, { timeout: 45000 });
    return { status: 200, html: r.html || '', via: 'playwright' };
  } catch (e: any) {
    return { status: 0, html: '', via: 'failed', err: e.message };
  }
}

async function rawAxios(url: string) {
  try {
    const r = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 15000,
      validateStatus: () => true,
      maxRedirects: 5,
    });
    return { status: r.status, headers: r.headers, body: typeof r.data === 'string' ? r.data : '' };
  } catch (e: any) { return { status: 0, headers: {}, body: '', err: e.message }; }
}

async function main() {
  // 1. Detect WAF type via raw GET (look at body and headers)
  console.log('[1] Raw fetch to detect WAF...');
  const raw = await rawAxios(ORIGIN);
  console.log(`  status=${raw.status}`);
  const headers = raw.headers || {};
  const wafHints: string[] = [];
  if (headers.server) wafHints.push(`server=${headers.server}`);
  if (headers['cf-ray']) wafHints.push('cloudflare (cf-ray)');
  if (headers['x-sucuri-id']) wafHints.push('sucuri (x-sucuri-id)');
  if (headers['x-sucuri-cache']) wafHints.push('sucuri (x-sucuri-cache)');
  if (raw.body.includes('Sucuri') || raw.body.includes('sucuri')) wafHints.push('sucuri (body)');
  if (raw.body.includes('Cloudflare') || raw.body.includes('cloudflare')) wafHints.push('cloudflare (body)');
  if (raw.body.includes('Just a moment')) wafHints.push('cloudflare-challenge');
  if (raw.body.includes('cloudflare-static')) wafHints.push('cloudflare-static');
  if (raw.body.includes('cf-mitigated')) wafHints.push('cloudflare-mitigated');
  if (raw.body.includes('sucuri_cloudproxy_js')) wafHints.push('sucuri-cloudproxy');
  console.log(`  WAF hints: ${wafHints.join(', ') || 'none detected'}`);
  console.log(`  All response headers (relevant):`);
  for (const [k, v] of Object.entries(headers)) {
    if (/^(server|x-|cf-|via|powered)/i.test(k)) console.log(`    ${k}: ${v}`);
  }

  // 2. WP REST API for product count
  console.log('\n[2] WP REST API: x-wp-total ...');
  const wp = await rawAxios(`${ORIGIN}/wp-json/wp/v2/product?per_page=1`);
  console.log(`  status=${wp.status}`);
  if (wp.headers && wp.headers['x-wp-total']) {
    console.log(`  x-wp-total = ${wp.headers['x-wp-total']}`);
    console.log(`  x-wp-totalpages = ${wp.headers['x-wp-totalpages']}`);
  } else if (wp.status === 200) {
    console.log(`  Headers present: ${Object.keys(wp.headers).filter(k => k.startsWith('x-wp')).join(', ') || 'none x-wp-*'}`);
  }

  // 3. WC Store API
  console.log('\n[3] WC Store API public endpoint...');
  const wc = await rawAxios(`${ORIGIN}/wp-json/wc/store/v1/products?per_page=1`);
  console.log(`  status=${wc.status}`);
  if (wc.status === 200 && wc.body) {
    try {
      const data = JSON.parse(wc.body);
      if (Array.isArray(data) && data.length > 0) console.log(`  first product: ${data[0].name?.slice(0, 50)} (id=${data[0].id})`);
    } catch {}
    if (wc.headers['x-wp-total']) console.log(`  x-wp-total = ${wc.headers['x-wp-total']}`);
  }

  // 4. Sitemap.xml
  console.log('\n[4] Sitemap discovery...');
  for (const path of ['/sitemap.xml', '/product-sitemap.xml', '/sitemap_index.xml', '/wp-sitemap-posts-product-1.xml']) {
    const r = await rawAxios(`${ORIGIN}${path}`);
    if (r.status === 200 && r.body.includes('<')) {
      const isIndex = r.body.includes('<sitemapindex');
      const isUrlSet = r.body.includes('<urlset');
      if (isIndex || isUrlSet) {
        const locs = (r.body.match(/<loc>/g) || []).length;
        const hasLastmod = (r.body.match(/<lastmod>/g) || []).length > 0;
        console.log(`  ${path}: ${isIndex ? 'INDEX' : 'URLSET'} ${locs} locs, lastmod=${hasLastmod}`);
        // If index, look for product sitemap entries
        if (isIndex) {
          const productSm = (r.body.match(/<loc>([^<]*product[^<]*)<\/loc>/gi) || []).slice(0, 3);
          for (const m of productSm) console.log(`    -> ${m.replace(/<\/?loc>/g, '')}`);
        }
      } else {
        console.log(`  ${path}: status=${r.status} (not XML, ${r.body.length} bytes)`);
      }
    } else {
      console.log(`  ${path}: status=${r.status}`);
    }
  }

  // 5. Test existing catalog URL with WAF handling
  console.log('\n[5] Testing existing catalogUrl with WAF handling...');
  const testUrl = ORIGIN + '/product-category/gun-shop/firearms/rifles/';
  const r = await get(testUrl);
  console.log(`  status=${r.status} html=${r.html.length} via=${r.via}`);
  if (r.html.length > 1000) {
    const $ = cheerio.load(r.html);
    const products = $('li.product, .product, [class*="product-item"]').length;
    const productLinks = new Set<string>();
    $('a[href*="/product/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      productLinks.add(href.split('?')[0]);
    });
    console.log(`  product elements: ${products}`);
    console.log(`  unique /product/ links: ${productLinks.size}`);
  }

  // 6. Test orderby=date sort
  console.log('\n[6] Testing ?orderby=date sort (should put newest first)...');
  const baseline = await get(testUrl);
  const sorted = await get(testUrl + '?orderby=date');
  const altSorted = await get(testUrl + '?orderby=date&order=desc');

  if (baseline.html.length > 1000 && sorted.html.length > 1000) {
    const $b = cheerio.load(baseline.html);
    const $s = cheerio.load(sorted.html);
    const $a = cheerio.load(altSorted.html);
    const baseLinks = $b('a[href*="/product/"]').slice(0, 3).map((_, el) => $b(el).attr('href') || '').get().map(h => h.split('?')[0]);
    const sortLinks = $s('a[href*="/product/"]').slice(0, 3).map((_, el) => $s(el).attr('href') || '').get().map(h => h.split('?')[0]);
    const altLinks = $a('a[href*="/product/"]').slice(0, 3).map((_, el) => $a(el).attr('href') || '').get().map(h => h.split('?')[0]);
    console.log(`  baseline first 3: ${baseLinks.map(s => s.slice(-30)).join(', ')}`);
    console.log(`  ?orderby=date first 3: ${sortLinks.map(s => s.slice(-30)).join(', ')}`);
    console.log(`  ?orderby=date&order=desc first 3: ${altLinks.map(s => s.slice(-30)).join(', ')}`);
    console.log(`  baseline === orderby=date? ${JSON.stringify(baseLinks) === JSON.stringify(sortLinks)}`);
    console.log(`  baseline === order=desc? ${JSON.stringify(baseLinks) === JSON.stringify(altLinks)}`);
  }

  // 7. Discover navigation from homepage / shop
  console.log('\n[7] Discovering category navigation...');
  const home = await get(ORIGIN + '/shop/');
  if (home.html.length > 1000) {
    const $ = cheerio.load(home.html);
    const cats = new Set<string>();
    $('a[href*="/product-category/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const text = $(el).text().trim().slice(0, 40);
      if (href && text) {
        const path = href.startsWith('http') ? new URL(href).pathname : href;
        cats.add(`${text.padEnd(40)} ${path}`);
      }
    });
    console.log(`  Found ${cats.size} unique /product-category/ links:`);
    for (const c of Array.from(cats).slice(0, 30)) console.log(`    ${c}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
