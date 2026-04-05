/**
 * Batch-enrich products missing prices by fetching individual product pages.
 *
 * Handles two sites:
 * 1. canadafirstammo.ca (WooCommerce + Sucuri WAF) — prices in &#036;XX.XX HTML entities
 * 2. frontierfirearms.ca (generic-retail + WAF) — prices in og:price:amount meta tags / JSON-LD
 *
 * Usage: node scripts/enrich-missing-prices.js [domain] [--dry-run] [--limit N]
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const cheerio = require('cheerio');

const prisma = new PrismaClient();

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitArg = args.find(a => a.startsWith('--limit'));
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1]) : 9999;
const targetDomain = args.find(a => !a.startsWith('--') && a.includes('.'));

const CONCURRENCY = 3;       // parallel requests
const DELAY_MS = 600;         // delay between batches (WAF-safe)
const TIMEOUT_MS = 15000;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Extract price from a product detail page HTML.
 * Tries multiple strategies in priority order.
 */
function extractPrice(html) {
  const $ = cheerio.load(html);

  // 1. meta product:price:amount
  const productPrice = $('meta[property="product:price:amount"]').attr('content');
  if (productPrice) {
    const p = parseFloat(productPrice.replace(/,/g, ''));
    if (!isNaN(p) && p > 0) return p;
  }

  // 2. meta og:price:amount
  const ogPrice = $('meta[property="og:price:amount"]').attr('content');
  if (ogPrice) {
    const p = parseFloat(ogPrice.replace(/,/g, ''));
    if (!isNaN(p) && p > 0) return p;
  }

  // 3. JSON-LD Product offers.price / offers.lowPrice
  let ldPrice;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (ldPrice) return;
    try {
      const data = JSON.parse($(el).html());
      const items = Array.isArray(data) ? data : data['@graph'] || [data];
      for (const item of items) {
        if (item['@type'] === 'Product' && item.offers) {
          const offers = Array.isArray(item.offers) ? item.offers : [item.offers];
          for (const o of offers) {
            const val = parseFloat(o.price || o.lowPrice || '0');
            if (val > 0) { ldPrice = val; return; }
          }
        }
      }
    } catch {}
  });
  if (ldPrice) return ldPrice;

  // 4. HTML entity prices (&#036; = $) — common on WooCommerce
  //    Look for sale price first (current price), then regular price
  const htmlStr = html;

  // WooCommerce sale pattern: "price was: &#036;XX.XX ... price is: &#036;XX.XX"
  const saleMatch = htmlStr.match(/price is:.*?&#036;([\d,]+\.\d{2})/);
  if (saleMatch) {
    const p = parseFloat(saleMatch[1].replace(/,/g, ''));
    if (p > 0) return p;
  }

  // WooCommerce <ins> (sale) or <bdi> price in product summary
  const summaryPriceMatch = htmlStr.match(/class="summary[^"]*"[\s\S]*?<ins[^>]*>[\s\S]*?&#036;([\d,]+\.\d{2})/);
  if (summaryPriceMatch) {
    const p = parseFloat(summaryPriceMatch[1].replace(/,/g, ''));
    if (p > 0) return p;
  }

  // Any &#036; price — take the first one in the price wrapper area
  const priceWrapperMatch = htmlStr.match(/class="price"[^>]*>[\s\S]*?&#036;([\d,]+\.\d{2})/);
  if (priceWrapperMatch) {
    const p = parseFloat(priceWrapperMatch[1].replace(/,/g, ''));
    if (p > 0) return p;
  }

  // Last resort: first &#036; price on the page
  const entityMatch = htmlStr.match(/&#036;([\d,]+\.\d{2})/);
  if (entityMatch) {
    const p = parseFloat(entityMatch[1].replace(/,/g, ''));
    if (p > 0) return p;
  }

  // 5. Dollar sign in text ($ followed by amount)
  const dollarMatch = htmlStr.match(/\$([\d,]+\.\d{2})/);
  if (dollarMatch) {
    const p = parseFloat(dollarMatch[1].replace(/,/g, ''));
    if (p > 0) return p;
  }

  return null;
}

async function fetchWithRetry(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const resp = await axios.get(url, {
        headers: { 'User-Agent': UA, Accept: 'text/html' },
        timeout: TIMEOUT_MS,
        maxRedirects: 5,
      });
      if (resp.status === 200 && resp.data.length > 5000) {
        return resp.data;
      }
      // Short response likely WAF block
      if (resp.data.length < 3000) {
        if (i < retries) await sleep(2000);
        continue;
      }
      return resp.data;
    } catch (e) {
      if (i < retries) await sleep(1000 * (i + 1));
    }
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function enrichSite(domain) {
  const site = await prisma.monitoredSite.findFirst({ where: { domain } });
  if (!site) { console.log(`Site ${domain} not found`); return; }

  const products = await prisma.productIndex.findMany({
    where: { siteId: site.id, isActive: true, price: null },
    select: { id: true, url: true, title: true, sourceId: true },
    take: LIMIT,
  });

  // Deduplicate by URL (frontierfirearms has dupes with ?searchid params)
  const byUrl = new Map();
  for (const p of products) {
    const cleanUrl = p.url.split('?')[0];
    if (!byUrl.has(cleanUrl)) {
      byUrl.set(cleanUrl, []);
    }
    byUrl.get(cleanUrl).push(p);
  }

  console.log(`\n=== ${domain} ===`);
  console.log(`Products missing price: ${products.length} (${byUrl.size} unique URLs)`);
  if (dryRun) console.log('DRY RUN — no DB updates');

  let enriched = 0, failed = 0, skipped = 0;
  const urls = [...byUrl.keys()];

  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (url) => {
        const html = await fetchWithRetry(url);
        if (!html) return { url, price: null, error: 'fetch_failed' };
        const price = extractPrice(html);
        return { url, price };
      })
    );

    for (const result of results) {
      if (result.status === 'rejected') { failed++; continue; }
      const { url, price, error } = result.value;
      const prods = byUrl.get(url);

      if (error) {
        failed += prods.length;
        continue;
      }

      if (!price) {
        skipped += prods.length;
        if (prods.length > 0) {
          console.log(`  NO PRICE: ${prods[0].title?.substring(0, 50)} (${url.substring(0, 60)})`);
        }
        continue;
      }

      enriched += prods.length;
      if (!dryRun) {
        await prisma.productIndex.updateMany({
          where: { id: { in: prods.map(p => p.id) } },
          data: { price },
        });
      }
      console.log(`  $${price.toFixed(2)} → ${prods[0].title?.substring(0, 45)} (x${prods.length})`);
    }

    // Progress
    const done = Math.min(i + CONCURRENCY, urls.length);
    if (done % 30 === 0 || done === urls.length) {
      console.log(`  Progress: ${done}/${urls.length} URLs | enriched: ${enriched} | failed: ${failed} | no price: ${skipped}`);
    }

    if (i + CONCURRENCY < urls.length) await sleep(DELAY_MS);
  }

  console.log(`\nDone: ${domain}`);
  console.log(`  Enriched: ${enriched} | Failed: ${failed} | No price found: ${skipped}`);

  // Verify
  if (!dryRun) {
    const remaining = await prisma.productIndex.count({
      where: { siteId: site.id, isActive: true, price: null },
    });
    const total = await prisma.productIndex.count({
      where: { siteId: site.id, isActive: true },
    });
    const pct = ((total - remaining) / total * 100).toFixed(1);
    console.log(`  After: ${total - remaining}/${total} with price (${pct}%)`);
  }
}

async function main() {
  try {
    const domains = targetDomain
      ? [targetDomain]
      : ['canadafirstammo.ca', 'frontierfirearms.ca'];

    for (const domain of domains) {
      await enrichSite(domain);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(console.error);
