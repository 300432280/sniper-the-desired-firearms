import { PrismaClient } from '@prisma/client';
import axios from 'axios';

async function main() {
  const p = new PrismaClient();

  // 1. Count products per site in ProductIndex
  const sites = await p.monitoredSite.findMany({
    where: { isEnabled: true },
    select: { id: true, domain: true, url: true, adapterType: true, lastWatermarkUrl: true },
    orderBy: { domain: 'asc' },
  });

  console.log('=== ProductIndex counts per enabled site ===');
  let zeroCount = 0;
  let totalProducts = 0;
  for (const site of sites) {
    const count = await p.productIndex.count({ where: { siteId: site.id } });
    totalProducts += count;
    if (count === 0) {
      zeroCount++;
      console.log(`  [0 products] ${site.domain} (${site.adapterType}) watermark=${site.lastWatermarkUrl ? 'SET' : 'NONE'}`);
    } else {
      console.log(`  [${count} products] ${site.domain} (${site.adapterType}) watermark=${site.lastWatermarkUrl ? 'SET' : 'NONE'}`);
    }
  }
  console.log(`\nTotal: ${totalProducts} products across ${sites.length} sites (${zeroCount} have 0 products)\n`);

  // 2. Check recent crawl events to see watermark crawl results
  const recentEvents = await p.crawlEvent.findMany({
    orderBy: { crawledAt: 'desc' },
    take: 50,
    select: {
      siteId: true,
      status: true,
      matchesFound: true,
      errorMessage: true,
      crawledAt: true,
      site: { select: { domain: true } },
    },
  });

  console.log('=== Last 50 crawl events ===');
  for (const e of recentEvents) {
    const domain = e.site?.domain ?? 'unknown';
    const time = e.crawledAt.toISOString().slice(0, 19);
    console.log(`  [${time}] ${domain} — ${e.status} — ${e.matchesFound} products${e.errorMessage ? ` — ERR: ${e.errorMessage.slice(0, 80)}` : ''}`);
  }

  // 3. Test WooCommerce API on durhamoutdoors.ca specifically
  console.log('\n=== Testing WooCommerce Store API on durhamoutdoors.ca ===');
  try {
    const resp = await axios.get('https://durhamoutdoors.ca/wp-json/wc/store/v1/products', {
      params: { per_page: 5, page: 1, orderby: 'date', order: 'desc' },
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible)', Accept: 'application/json' },
      timeout: 15000,
      validateStatus: () => true,
    });
    console.log(`  Status: ${resp.status}`);
    console.log(`  Data type: ${typeof resp.data}, isArray: ${Array.isArray(resp.data)}`);
    if (Array.isArray(resp.data) && resp.data.length > 0) {
      console.log(`  Products returned: ${resp.data.length}`);
      for (const p of resp.data.slice(0, 3)) {
        console.log(`    - ${p.name || 'no name'} | ${p.permalink || 'no url'}`);
      }
    } else {
      console.log(`  Response body (first 500 chars): ${JSON.stringify(resp.data).slice(0, 500)}`);
    }
  } catch (err: any) {
    console.log(`  API error: ${err.message}`);
  }

  // 4. Test WP REST API on durhamoutdoors.ca
  console.log('\n=== Testing WP REST API on durhamoutdoors.ca ===');
  try {
    const resp = await axios.get('https://durhamoutdoors.ca/wp-json/wp/v2/product', {
      params: { per_page: 5, page: 1, orderby: 'date', order: 'desc' },
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible)', Accept: 'application/json' },
      timeout: 15000,
      validateStatus: () => true,
    });
    console.log(`  Status: ${resp.status}`);
    console.log(`  Data type: ${typeof resp.data}, isArray: ${Array.isArray(resp.data)}`);
    if (Array.isArray(resp.data) && resp.data.length > 0) {
      console.log(`  Products returned: ${resp.data.length}`);
      for (const p of resp.data.slice(0, 3)) {
        console.log(`    - ${(p.title?.rendered || p.name || 'no title')} | ${p.link || 'no url'}`);
      }
    } else {
      console.log(`  Response body (first 500 chars): ${JSON.stringify(resp.data).slice(0, 500)}`);
    }
  } catch (err: any) {
    console.log(`  API error: ${err.message}`);
  }

  // 5. Test HTML fallback — fetch shop page and count product elements
  console.log('\n=== Testing HTML extraction on durhamoutdoors.ca/shop/?orderby=date ===');
  try {
    const resp = await axios.get('https://durhamoutdoors.ca/shop/?orderby=date', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 15000,
      validateStatus: () => true,
    });
    console.log(`  Status: ${resp.status}`);
    console.log(`  HTML length: ${resp.data.length}`);

    const html: string = resp.data;
    // Quick check for product elements
    const liProductCount = (html.match(/class="[^"]*product[^"]*"/g) || []).length;
    console.log(`  Elements with "product" in class: ${liProductCount}`);

    // Check for WAF/block indicators
    if (html.includes('_Incapsula_Resource') || html.includes('Access Denied') || html.includes('403 Forbidden')) {
      console.log('  ⚠ WAF/block detected in HTML');
    }
    if (html.length < 2000) {
      console.log('  ⚠ HTML too small — likely blocked');
    }
  } catch (err: any) {
    console.log(`  Fetch error: ${err.message}`);
  }

  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
