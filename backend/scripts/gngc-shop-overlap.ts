/**
 * Check if /shop/ on greatnorthgunco.ca overlaps with the 13 firearm sub-categories.
 * Walk /shop/ fully and walk each sub-category, then compute set intersections.
 */
import 'dotenv/config';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { buildPaginatedUrl } from '../src/services/catalog-crawler';
import { WooCommerceAdapter } from '../src/services/scraper/adapters/woocommerce';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0';
const ORIGIN = 'https://greatnorthgunco.ca';
const adapter = new WooCommerceAdapter();

async function get(url: string) {
  const r = await axios.get(url, { headers: { 'User-Agent': UA }, timeout: 25000, validateStatus: () => true, maxRedirects: 5 });
  return { status: r.status, html: typeof r.data === 'string' ? r.data : '' };
}

async function walkAll(path: string, maxPages = 50): Promise<Set<string>> {
  const pattern = { type: 'path' as const, template: '/page/{N}', perPage: 24 };
  const all = new Set<string>();
  let pageNum = 1;
  let firstUrls: string[] = [];
  while (pageNum <= maxPages) {
    const url = pageNum === 1 ? `${ORIGIN}${path}` : buildPaginatedUrl(`${ORIGIN}${path}`, pageNum, pattern);
    const r = await get(url);
    if (r.status !== 200 || r.html.length < 1000) break;
    const $ = cheerio.load(r.html);
    const products = adapter.extractCatalogProducts ? adapter.extractCatalogProducts($, url) : [];
    if (products.length === 0) break;
    const urls = products.map(p => { try { return new URL(p.url).pathname; } catch { return p.url; } });
    if (pageNum > 1 && JSON.stringify(urls.slice(0, 3)) === JSON.stringify(firstUrls.slice(0, 3))) break;
    if (pageNum === 1) firstUrls = urls;
    const before = all.size;
    for (const u of urls) all.add(u);
    if (all.size === before && pageNum > 1) break;
    pageNum++;
  }
  return all;
}

async function main() {
  console.log('Walking /shop/ ...');
  const shop = await walkAll('/shop/');
  console.log(`  /shop/ unique: ${shop.size}`);

  const subcats = [
    '/product-category/used-firearms/',
    '/product-category/new-firearms/',
    '/product-category/new-shotguns/',
    '/product-category/surplus/',
    '/product-category/new-scopes/',
    '/product-category/used-scopes/',
    '/product-category/accessories-parts/',
    '/product-category/accessoriesparts/',
    '/product-category/new-knives/',
    '/product-category/bayonets/',
    '/product-category/lee-enfield-parts/',
    '/product-category/mauser-parts/',
    '/product-category/ljungman-parts/',
  ];

  console.log('\nWalking 13 sub-categories...');
  const subcatUnion = new Set<string>();
  const perCat: { path: string; size: number; inShop: number }[] = [];
  for (const path of subcats) {
    const urls = await walkAll(path);
    for (const u of urls) subcatUnion.add(u);
    const inShop = [...urls].filter(u => shop.has(u)).length;
    perCat.push({ path, size: urls.size, inShop });
    console.log(`  ${path}: ${urls.size} products, ${inShop} also in /shop/`);
  }

  console.log(`\n=== ANALYSIS ===`);
  console.log(`/shop/ unique:        ${shop.size}`);
  console.log(`13 sub-cats union:    ${subcatUnion.size}`);
  // Set intersection
  const inBoth = [...shop].filter(u => subcatUnion.has(u)).length;
  const onlyShop = [...shop].filter(u => !subcatUnion.has(u));
  const onlySubcats = [...subcatUnion].filter(u => !shop.has(u));
  console.log(`In BOTH /shop/ and sub-cat union: ${inBoth}`);
  console.log(`Only in /shop/ (NOT in any sub-cat): ${onlyShop.length}`);
  console.log(`Only in sub-cats (NOT in /shop/):    ${onlySubcats.length}`);

  if (onlyShop.length > 0 && onlyShop.length < 30) {
    console.log(`\n  /shop/ products NOT in any sub-cat:`);
    for (const u of onlyShop.slice(0, 20)) console.log(`    ${u}`);
  }
  if (onlySubcats.length > 0 && onlySubcats.length < 30) {
    console.log(`\n  Sub-cat products NOT in /shop/:`);
    for (const u of onlySubcats.slice(0, 20)) console.log(`    ${u}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
