/**
 * Deep diagnostic for fixable sites:
 * 1. WORKING sites — test the actual watermark URL (not homepage)
 * 2. SELECTOR_CLOSE sites — show actual HTML structure to fix selectors
 * 3. LINKS_ONLY sites — test catalog/shop URLs
 * 4. NO_PRODUCTS sites — test shop/product pages
 */
import axios from 'axios';
import * as cheerio from 'cheerio';
import { getAdapterByType } from '../src/services/scraper/adapter-registry';

const { fetchWithPlaywright } = require('../src/services/scraper/playwright-fetcher');

interface TestCase {
  domain: string;
  adapterType: string;
  urls: string[]; // URLs to test in order
  category: string;
}

const SITES: TestCase[] = [
  // WORKING but 0 in ProductIndex — test the watermark URL the crawler would use
  { domain: 'triggersandbows.com', adapterType: 'woocommerce', category: 'WORKING',
    urls: ['https://www.triggersandbows.com/shop/?orderby=date', 'https://www.triggersandbows.com/?post_type=product&orderby=date&order=desc'] },
  { domain: 'sail.ca', adapterType: 'generic-retail', category: 'WORKING',
    urls: ['https://www.sail.ca/en/new-arrivals', 'https://www.sail.ca/en/search?sort=newest', 'https://www.sail.ca/en/'] },
  { domain: 'londerosports.com', adapterType: 'generic-retail', category: 'WORKING',
    urls: ['https://www.londerosports.com/en/new-arrivals', 'https://www.londerosports.com/en/'] },
  { domain: 'canadiangunnutz.com', adapterType: 'forum-xenforo', category: 'WORKING',
    urls: ['https://www.canadiangunnutz.com/forum/whats-new/posts/', 'https://www.canadiangunnutz.com/forum/'] },

  // SELECTOR_CLOSE — show HTML structure so we can fix selectors
  { domain: 'jobrookoutdoors.com', adapterType: 'shopify', category: 'SELECTOR_CLOSE',
    urls: ['https://www.jobrookoutdoors.com/collections/all?sort_by=created-descending'] },
  { domain: 'northprosports.com', adapterType: 'woocommerce', category: 'SELECTOR_CLOSE',
    urls: ['https://northprosports.com'] },  // Test OpenCart homepage
  { domain: 'lockharttactical.com', adapterType: 'generic-retail', category: 'SELECTOR_CLOSE',
    urls: ['https://www.lockharttactical.com'] },
  { domain: 'millerandmillerauctions.com', adapterType: 'auction-generic', category: 'SELECTOR_CLOSE',
    urls: ['https://www.millerandmillerauctions.com', 'https://live.millerandmillerauctions.com/auctions/current'] },
  { domain: 'switzersauction.com', adapterType: 'auction-generic', category: 'SELECTOR_CLOSE',
    urls: ['https://www.switzersauction.com'] },

  // LINKS_ONLY — test catalog/shop URLs
  { domain: 'canada.hibid.com', adapterType: 'auction-hibid', category: 'LINKS_ONLY',
    urls: ['https://canada.hibid.com/auctions/current', 'https://canada.hibid.com/lots'] },
  { domain: 'liangjian.ca', adapterType: 'generic-retail', category: 'LINKS_ONLY',
    urls: ['https://liangjian.ca/shop', 'https://liangjian.ca/shop/ols/categories/firearms'] },
  { domain: 'townpost.ca', adapterType: 'generic', category: 'LINKS_ONLY',
    urls: ['https://www.townpost.ca/ads', 'https://www.townpost.ca/ads?category=firearms'] },

  // NO_PRODUCTS — test shop/product pages
  { domain: 'canadasgunstore.ca', adapterType: 'woocommerce', category: 'NO_PRODUCTS',
    urls: ['https://www.canadasgunstore.ca/shop/?orderby=date', 'https://www.canadasgunstore.ca/?post_type=product&orderby=date&order=desc'] },
  { domain: 'irunguns.ca', adapterType: 'generic-retail', category: 'NO_PRODUCTS',
    urls: ['https://www.irunguns.ca/products.php', 'https://www.irunguns.ca/firearms.php'] },
];

async function testUrl(url: string, adapterType: string): Promise<void> {
  console.log(`  URL: ${url}`);

  let html = '';
  // Try Playwright for all (most reliable)
  try {
    const result = await fetchWithPlaywright(url, { timeout: 30000 });
    html = result.html;
    console.log(`    Playwright: ${html.length}b`);
  } catch (err: any) {
    console.log(`    Playwright FAIL: ${err.message?.slice(0, 80)}`);
    // Try static as fallback for non-WAF sites
    try {
      const resp = await axios.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        timeout: 15000, validateStatus: () => true,
      });
      html = typeof resp.data === 'string' ? resp.data : '';
      console.log(`    Static fallback: ${resp.status}, ${html.length}b`);
    } catch (err2: any) {
      console.log(`    Static also FAIL: ${err2.message?.slice(0, 80)}`);
      return;
    }
  }

  if (html.length < 500) {
    console.log(`    HTML too small to analyze`);
    return;
  }

  const $ = cheerio.load(html);
  const adapter = getAdapterByType(adapterType);

  // Run extractCatalogProducts
  let catalogProducts = 0;
  if (adapter.extractCatalogProducts) {
    const products = adapter.extractCatalogProducts($, url);
    catalogProducts = products.length;
    console.log(`    extractCatalogProducts: ${products.length}`);
    if (products.length > 0) {
      for (const p of products.slice(0, 3)) {
        console.log(`      → ${p.title.slice(0, 60)} [$${p.price ?? '?'}] ${p.url?.slice(0, 50)}`);
      }
    }
  }

  // If 0 products, show what's actually in the HTML
  if (catalogProducts === 0) {
    console.log(`    --- HTML STRUCTURE ANALYSIS ---`);

    // Show elements with product-like classes
    const productElements: string[] = [];
    $('[class]').each((_, el) => {
      const cls = $(el).attr('class') || '';
      if (/product|item|card|lot|listing|result|teaser|node|tile|thumb/i.test(cls)) {
        const tag = el.tagName || (el as any).name || '?';
        const text = $(el).text().trim().slice(0, 40);
        const key = `<${tag} class="${cls.slice(0, 80)}">${text ? ` → "${text}"` : ''}`;
        if (!productElements.includes(key)) productElements.push(key);
      }
    });

    if (productElements.length > 0) {
      console.log(`    Product-like elements (${productElements.length}):`);
      for (const el of productElements.slice(0, 8)) {
        console.log(`      ${el}`);
      }
    } else {
      console.log(`    No product-like class names found!`);
      // Show top-level structure
      console.log(`    Top-level structure:`);
      $('body > *').slice(0, 5).each((_, el) => {
        const tag = el.tagName || (el as any).name || '?';
        const cls = $(el).attr('class')?.slice(0, 80) || 'no-class';
        const childCount = $(el).children().length;
        console.log(`      <${tag} class="${cls}"> (${childCount} children)`);
      });
    }

    // Show links that look like products
    const prodLinks = $('a[href]').filter((_, el) => {
      const href = $(el).attr('href') || '';
      return /\/(product|item|ad|lot|listing|p\/|shop\/ols)/i.test(href);
    });
    if (prodLinks.length > 0) {
      console.log(`    Product-like links (${prodLinks.length}):`);
      prodLinks.slice(0, 5).each((_, el) => {
        const href = $(el).attr('href')?.slice(0, 80);
        const text = $(el).text().trim().slice(0, 50);
        console.log(`      "${text}" → ${href}`);
      });
    }
  }

  // Check pagination
  if (adapter.getNextPageUrl) {
    const nextPage = adapter.getNextPageUrl($, url);
    console.log(`    Next page: ${nextPage || 'none'}`);
  }
}

async function main() {
  console.log('=== Deep Diagnostic for Fixable Sites ===\n');

  for (const site of SITES) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`${site.domain} [${site.adapterType}] — ${site.category}`);
    console.log('='.repeat(70));

    for (const url of site.urls) {
      await testUrl(url, site.adapterType);
      console.log();
    }
  }

  // Cleanup
  try {
    const { closeBrowser } = await import('../src/services/scraper/playwright-fetcher');
    await closeBrowser();
  } catch {}
}

main().catch(e => { console.error(e); process.exit(1); });
