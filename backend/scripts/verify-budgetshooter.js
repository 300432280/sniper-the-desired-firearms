/**
 * Verification script for budgetshootersupply.ca
 */
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const p = new PrismaClient();

const DOMAIN = 'budgetshootersupply.ca';

async function main() {
  console.log('=== VERIFICATION: ' + DOMAIN + ' ===\n');

  // 1. Find site in DB
  const site = await p.monitoredSite.findFirst({ where: { domain: DOMAIN } });
  if (!site) {
    console.log('Site not found in DB!');
    return;
  }
  console.log('Site ID:', site.id);
  console.log('Adapter:', site.adapterType || site.siteType);
  console.log('Enabled:', site.isEnabled, '| Paused:', site.isPaused);
  console.log('Last crawl:', site.lastCrawlAt);
  console.log('Has WAF:', site.hasWaf);
  console.log('Tier state:', JSON.stringify(site.tierState)?.slice(0, 200));
  console.log('Crawl tuning:', JSON.stringify(site.crawlTuning));

  // 2. Product index counts
  const total = await p.productIndex.count({ where: { siteId: site.id } });
  const active = await p.productIndex.count({ where: { siteId: site.id, isActive: true } });
  const inStock = await p.productIndex.count({ where: { siteId: site.id, stockStatus: 'in_stock' } });
  const outStock = await p.productIndex.count({ where: { siteId: site.id, stockStatus: 'out_of_stock' } });
  const unknown = await p.productIndex.count({ where: { siteId: site.id, stockStatus: 'unknown' } });
  const nullStock = await p.productIndex.count({ where: { siteId: site.id, stockStatus: null } });
  const noThumb = await p.productIndex.count({ where: { siteId: site.id, thumbnail: null } });
  const noPrice = await p.productIndex.count({ where: { siteId: site.id, price: null } });

  console.log('\n--- ProductIndex ---');
  console.log('Total:', total, '| Active:', active);
  console.log('In stock:', inStock, '| Out of stock:', outStock, '| Unknown:', unknown, '| Null:', nullStock);
  console.log('Missing thumbnails:', noThumb);
  console.log('Missing price:', noPrice);

  // 3. Detect site type and check live API
  const origin = 'https://' + DOMAIN;
  console.log('\n--- Live API Check ---');

  // Try Shopify
  let shopifyTotal = 0;
  try {
    const resp = await axios.get(origin + '/products.json', {
      params: { limit: 1 },
      timeout: 10000,
      validateStatus: (s) => s === 200,
    });
    if (resp.data?.products) {
      console.log('Shopify API: accessible');
      // Count all products
      let page = 1;
      let count = 0;
      let url = origin + '/products.json?limit=250';
      while (url) {
        const r = await axios.get(url, { timeout: 15000 });
        count += r.data.products.length;
        // Check Link header for next page
        const linkHeader = r.headers['link'] || '';
        const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
        url = nextMatch ? nextMatch[1] : null;
        if (!nextMatch && r.data.products.length === 250) {
          page++;
          url = origin + '/products.json?limit=250&page=' + page;
        } else if (!nextMatch) {
          url = null;
        }
        await new Promise(r => setTimeout(r, 500));
      }
      shopifyTotal = count;
      console.log('Shopify total products:', count);
    }
  } catch {
    console.log('Shopify API: not available');
  }

  // Try WooCommerce WP REST API
  try {
    const resp = await axios.get(origin + '/wp-json/wp/v2/product', {
      params: { per_page: 1, page: 1 },
      timeout: 10000,
      validateStatus: (s) => s === 200,
    });
    console.log('WooCommerce WP REST API: accessible, total:', resp.headers['x-wp-total']);
  } catch {
    console.log('WooCommerce WP REST API: not available');
  }

  // Try WooCommerce Store API
  try {
    const resp = await axios.get(origin + '/wp-json/wc/store/v1/products', {
      params: { per_page: 1, page: 1 },
      timeout: 10000,
      validateStatus: (s) => s === 200,
    });
    console.log('WooCommerce Store API: accessible, total:', resp.headers['x-wp-total']);
  } catch {
    console.log('WooCommerce Store API: not available');
  }

  // 4. Compare counts
  console.log('\n--- Count Comparison ---');
  if (shopifyTotal > 0) {
    const diff = shopifyTotal - total;
    console.log('Shopify API:', shopifyTotal, '| Our DB:', total, '| Diff:', diff);
    if (diff > 0) console.log('WARNING: Missing ' + diff + ' products!');
    else if (diff < 0) console.log('NOTE: We have ' + Math.abs(diff) + ' extra (deactivated/old products)');
    else console.log('OK: Counts match');
  }

  // 5. Sample products (newest 5)
  console.log('\n--- Newest 5 Products ---');
  const newest = await p.productIndex.findMany({
    where: { siteId: site.id },
    orderBy: { firstSeenAt: 'desc' },
    take: 5,
    select: { title: true, price: true, stockStatus: true, thumbnail: true, firstSeenAt: true, url: true },
  });
  for (const prod of newest) {
    console.log(
      (prod.stockStatus || 'null').padEnd(13) +
      (prod.price != null ? '$' + prod.price : 'no price').padEnd(12) +
      (prod.thumbnail ? 'thumb' : 'NO THUMB').padEnd(10) +
      prod.title.slice(0, 50)
    );
  }

  // 6. Check matches for active searches on this site
  console.log('\n--- Active Searches ---');
  const searches = await p.search.findMany({
    where: {
      isActive: true,
      OR: [
        { websiteUrl: { contains: DOMAIN } },
        { websiteUrl: 'ALL' },
      ],
    },
    select: { id: true, keyword: true, websiteUrl: true, _count: { select: { matches: true } } },
  });
  for (const s of searches) {
    const siteMatches = await p.match.count({
      where: {
        searchId: s.id,
        url: { contains: DOMAIN },
      },
    });
    console.log(
      s.keyword.padEnd(20) +
      (s.websiteUrl === 'ALL' ? 'ALL' : DOMAIN).padEnd(30) +
      siteMatches + ' matches on this site'
    );
  }

  // 7. Check for URL duplicates
  console.log('\n--- Duplicate Check ---');
  const allUrls = await p.productIndex.findMany({
    where: { siteId: site.id },
    select: { url: true },
  });
  const urlCounts = new Map();
  for (const { url } of allUrls) {
    const decoded = decodeURIComponent(url);
    urlCounts.set(decoded, (urlCounts.get(decoded) || 0) + 1);
  }
  const dupes = [...urlCounts.entries()].filter(([, c]) => c > 1);
  if (dupes.length > 0) {
    console.log('WARNING: ' + dupes.length + ' duplicate URLs');
    for (const [url, count] of dupes.slice(0, 5)) {
      console.log('  ' + count + 'x ' + url.slice(0, 80));
    }
  } else {
    console.log('OK: No duplicate URLs');
  }

  // 8. Recent crawl events
  console.log('\n--- Recent Crawl Events ---');
  const events = await p.crawlEvent.findMany({
    where: { siteId: site.id },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { createdAt: true, eventType: true, message: true },
  });
  for (const e of events) {
    console.log(e.createdAt.toISOString().slice(0, 19) + ' ' + e.eventType.padEnd(12) + ' ' + (e.message || '').slice(0, 80));
  }

  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
