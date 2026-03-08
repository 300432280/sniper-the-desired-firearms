/**
 * verify-site.js — Universal site verification for firearm-alert.
 *
 * Usage: node scripts/verify-site.js <domain-or-name>
 * Example: node scripts/verify-site.js alsimmonsgunshop.com
 *          node scripts/verify-site.js budgetshootersupply
 *          node scripts/verify-site.js alflahertys
 *
 * Runs all data quality checks + live API cross-checks (WooCommerce).
 * Outputs severity-rated summary at the end.
 */
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const p = new PrismaClient();

const query = process.argv[2];
if (!query) {
  console.log('Usage: node verify-site.js <domain-or-name>');
  process.exit(1);
}

const issues = [];
function warn(msg) { issues.push({ sev: 'WARN', msg }); console.log('  [WARN] ' + msg); }
function fail(msg, count, examples) {
  issues.push({ sev: 'FAIL', msg });
  console.log('  [FAIL] ' + msg + (count != null ? ` (${count} found)` : ''));
  if (examples) {
    examples.slice(0, 5).forEach(e => console.log('    - ' + e));
    if (examples.length > 5) console.log(`    ... and ${examples.length - 5} more`);
  }
}
function ok(msg) { console.log('  [OK]   ' + msg); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  // ═══════════════════════════════════════════════════════════════════════════
  // 1. SITE CONFIG
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n=== 1. SITE CONFIG ===');
  const site = await p.monitoredSite.findFirst({
    where: { OR: [
      { domain: { contains: query, mode: 'insensitive' } },
      { name: { contains: query, mode: 'insensitive' } },
      { url: { contains: query, mode: 'insensitive' } },
    ] },
  });
  if (!site) { console.log('Site not found for:', query); await p.$disconnect(); process.exit(1); }

  const ORIGIN = 'https://' + site.domain;
  const isWoo = (site.adapterType || '').toLowerCase().includes('woo');

  ok(`${site.name} — ${site.domain}`);
  ok(`Adapter: ${site.adapterType || 'N/A'} | Type: ${site.siteType || 'N/A'} | WAF: ${site.hasWaf} | Enabled: ${site.isEnabled}`);
  if (site.notes) ok(`Notes: ${site.notes}`);
  if (!site.isEnabled) warn('Site is DISABLED');
  if (!site.adapterType) warn('No adapter type set');

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. PRODUCT INDEX HEALTH
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n=== 2. PRODUCT INDEX HEALTH ===');
  const all = await p.productIndex.findMany({
    where: { siteId: site.id, isActive: true },
    select: { id: true, title: true, url: true, price: true, stockStatus: true, tags: true, thumbnail: true },
  });
  const total = all.length;
  const inStock = all.filter(a => a.stockStatus === 'in_stock');
  const outStock = all.filter(a => a.stockStatus === 'out_of_stock');
  const unknownStock = all.filter(a => a.stockStatus === 'unknown');
  const nullStock = all.filter(a => !a.stockStatus);
  const noPrice = all.filter(a => a.price === null);
  const noThumb = all.filter(a => !a.thumbnail);

  ok(`Total active: ${total}`);
  ok(`In stock: ${inStock.length} | Out of stock: ${outStock.length} | Unknown: ${unknownStock.length} | Null: ${nullStock.length}`);
  ok(`Missing price: ${noPrice.length} | Missing thumbnail: ${noThumb.length}`);

  if (total === 0) fail('No products in index');
  if (unknownStock.length > 0) warn(`${unknownStock.length} products with "unknown" stock status`);
  if (nullStock.length > 0) warn(`${nullStock.length} products with NULL stock status`);

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. LIVE API COMPARISON (WooCommerce)
  // ═══════════════════════════════════════════════════════════════════════════
  let liveInStockCount = null;
  let liveTotal = null;
  if (isWoo) {
    console.log('\n=== 3. LIVE API COMPARISON (WooCommerce) ===');

    // WP REST API — total products
    try {
      const resp = await axios.get(`${ORIGIN}/wp-json/wp/v2/product`, {
        params: { per_page: 1 },
        timeout: 15000,
        validateStatus: (s) => s === 200,
      });
      liveTotal = parseInt(resp.headers['x-wp-total'] || '0', 10);
      ok(`WP REST API total: ${liveTotal} | DB total: ${total}`);
      if (Math.abs(liveTotal - total) > liveTotal * 0.15) {
        warn(`Product count mismatch: DB=${total} vs live=${liveTotal} (diff: ${total - liveTotal})`);
      }
    } catch (err) {
      warn('WP REST API check failed: ' + err.message);
    }
    await sleep(1000);

    // Store API — in-stock count + prices
    try {
      const resp = await axios.get(`${ORIGIN}/wp-json/wc/store/v1/products`, {
        params: { per_page: 1 },
        timeout: 15000,
        validateStatus: (s) => s === 200,
      });
      liveInStockCount = parseInt(resp.headers['x-wp-total'] || '0', 10);
      ok(`Store API in-stock: ${liveInStockCount} | DB in_stock: ${inStock.length}`);
      if (Math.abs(liveInStockCount - inStock.length) > 5) {
        warn(`In-stock mismatch: DB=${inStock.length} vs live=${liveInStockCount} (diff: ${inStock.length - liveInStockCount})`);
      }
    } catch (err) {
      warn('Store API check failed: ' + err.message);
    }
    await sleep(1000);
  } else {
    console.log('\n=== 3. LIVE API COMPARISON (skipped — not WooCommerce) ===');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. STOCK ACCURACY SPOT-CHECK
  // WooCommerce Store API only returns in-stock items with prices.
  // Cross-check: items in Store API should be in_stock in our DB.
  // ═══════════════════════════════════════════════════════════════════════════
  if (isWoo && liveInStockCount !== null) {
    console.log('\n=== 4. STOCK ACCURACY SPOT-CHECK ===');
    try {
      const resp = await axios.get(`${ORIGIN}/wp-json/wc/store/v1/products`, {
        params: { per_page: 50 },
        timeout: 15000,
        validateStatus: (s) => s === 200,
      });
      let correct = 0, wrongStock = 0, missingFromDb = 0, priceMismatch = 0;
      for (const prod of resp.data) {
        const url = prod.permalink || '';
        const dbProd = await p.productIndex.findFirst({
          where: { siteId: site.id, OR: [{ url }, { url: url.replace(/\/$/, '') }, { url: url + '/' }] },
          select: { stockStatus: true, price: true },
        });
        if (!dbProd) { missingFromDb++; continue; }
        if (dbProd.stockStatus === 'in_stock') correct++;
        else wrongStock++;
        // Check price
        const livePrice = prod.prices?.price ? parseInt(prod.prices.price, 10) / 100 : null;
        if (livePrice && dbProd.price === null) priceMismatch++;
      }
      ok(`Spot-check 50 in-stock: ${correct} correct, ${wrongStock} wrong stock, ${missingFromDb} not in DB, ${priceMismatch} missing price in DB`);
      if (wrongStock > 0) fail(`${wrongStock} products marked wrong stock status in DB`);
      if (missingFromDb > 0) warn(`${missingFromDb} in-stock products not found in DB`);
      if (priceMismatch > 0) warn(`${priceMismatch} in-stock products missing price in DB (Store API has price)`);
    } catch (err) {
      warn('Stock spot-check failed: ' + err.message);
    }
    await sleep(1000);
  } else {
    console.log('\n=== 4. STOCK ACCURACY (skipped) ===');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. MATCH COUNTS vs LIVE SEARCH
  // WP REST API search matches against full product content (title + description).
  // Our keyword matcher checks title + URL slug + tags.
  // Gap = products where keyword only appears in description.
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n=== 5. MATCH COUNTS ===');
  const searches = await p.search.findMany({
    where: { websiteUrl: { contains: site.domain } },
    select: { id: true, keyword: true },
  });
  ok(`Active searches: ${searches.length}`);

  for (const s of searches) {
    const matchCount = await p.match.count({ where: { searchId: s.id } });

    if (isWoo) {
      try {
        const resp = await axios.get(`${ORIGIN}/wp-json/wp/v2/product`, {
          params: { search: s.keyword, per_page: 1 },
          timeout: 15000,
          validateStatus: (st) => st === 200,
        });
        const liveCount = parseInt(resp.headers['x-wp-total'] || '0', 10);
        const diff = liveCount - matchCount;
        if (diff > 0) {
          warn(`"${s.keyword}": live=${liveCount} vs db=${matchCount} (missing ${diff})`);
        } else {
          ok(`"${s.keyword}": live=${liveCount} vs db=${matchCount}`);
        }
        await sleep(1500);
      } catch {
        console.log(`  "${s.keyword}": ${matchCount} matches (live check failed)`);
      }
    } else {
      console.log(`  "${s.keyword}": ${matchCount} matches`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. DATA QUALITY CHECKS
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n=== 6. DATA QUALITY CHECKS ===');

  // ── Dirty titles ────────────────────────────────────────────────────────
  // Happens on BigCommerce/Magento/generic-retail where HTML scraper grabs
  // sibling elements (price labels, buttons, stock badges) in the title.
  console.log('\n[6a] Dirty titles');
  const dirtyTitles = all.filter(a =>
    /Add\s+to\s+Cart/i.test(a.title) ||
    /Choose\s+options?/i.test(a.title) ||
    /Quick\s+view/i.test(a.title) ||
    /Buy\s+Now$/i.test(a.title) ||
    /(Temporarily\s+)?Out[- ]of[- ]Stock/i.test(a.title) ||
    /Sold\s+Out$/i.test(a.title)
  );
  if (dirtyTitles.length === 0) ok('No dirty titles');
  else fail('Dirty titles found', dirtyTitles.length, dirtyTitles.map(d => `"${d.title.slice(0, 80)}"`));

  // ── Category pages indexed as products ──────────────────────────────────
  // Happens on BigCommerce where category pages use .card CSS class.
  console.log('\n[6b] Category pages indexed as products');
  const CATEGORY_NAMES = /^(ammunition|firearms|rifles?|shotguns?|handguns?|pistols?|scopes?|optics?|accessories|storage|knives|clearance|sale|new products?|apparel|clothing|archery|camping|hunting|fishing)$/i;
  const categories = all.filter(a =>
    (a.price === null && CATEGORY_NAMES.test(a.title.trim())) ||
    (a.price === null && a.title.trim().length < 40 && /\/$/.test(a.url) && !/\d/.test(a.title))
  );
  if (categories.length === 0) ok('No category pages indexed');
  else fail('Category pages indexed', categories.length, categories.map(c => `"${c.title}" | ${c.url}`));

  // ── Junk entries ────────────────────────────────────────────────────────
  console.log('\n[6c] Junk entries');
  const junk = all.filter(a => {
    if (/\/search\.php|\/search\?q=/i.test(a.url)) return true;
    if (/\/giftcertificates/i.test(a.url)) return true;
    try { if (new URL(a.url).pathname === '/' || new URL(a.url).pathname === '') return true; } catch {}
    if (a.title.trim().length < 3) return true;
    return false;
  });
  if (junk.length === 0) ok('No junk entries');
  else fail('Junk entries found', junk.length, junk.map(j => `"${j.title.slice(0, 50)}" | ${j.url}`));

  // ── Stock status mismatch (title says OOS but DB says in_stock) ─────────
  console.log('\n[6d] Stock status mismatch (title says OOS but DB says in_stock)');
  const stockMismatch = all.filter(a =>
    a.stockStatus === 'in_stock' &&
    /(out[- ]of[- ]stock|temporarily out|sold out)/i.test(a.title)
  );
  if (stockMismatch.length === 0) ok('No stock status mismatches');
  else fail('Stock status mismatches', stockMismatch.length, stockMismatch.map(s => `"${s.title.slice(0, 60)}"`));

  // ── URL duplicates ──────────────────────────────────────────────────────
  // Encoding-based dupes (e.g. Unicode chars in Shopify handles).
  console.log('\n[6e] URL duplicates');
  const urlCounts = new Map();
  for (const a of all) {
    const norm = a.url.replace(/\/$/, '');
    urlCounts.set(norm, (urlCounts.get(norm) || 0) + 1);
  }
  const dupes = [...urlCounts.entries()].filter(([, c]) => c > 1);
  if (dupes.length === 0) ok('No URL duplicates');
  else fail('URL duplicates found', dupes.length, dupes.slice(0, 5).map(([url, cnt]) => `${url} (${cnt}x)`));

  // ── Tags data quality ──────────────────────────────────────────────────
  console.log('\n[6f] Tags data quality');
  const longTags = all.filter(a => a.tags && a.tags.length > 200);
  if (longTags.length === 0) ok('No suspiciously long tags');
  else fail('Suspiciously long tags (body_html contamination?)', longTags.length,
    longTags.map(t => `[${t.tags.length} chars] "${t.title.slice(0, 50)}"`));

  // ── Prices ──────────────────────────────────────────────────────────────
  // WooCommerce: WP REST API doesn't expose prices. Store API only has in-stock.
  // Out-of-stock prices must be scraped from product page HTML.
  console.log('\n[6g] Price coverage');
  const noPriceInStock = noPrice.filter(a => a.stockStatus === 'in_stock');
  const noPriceOos = noPrice.filter(a => a.stockStatus === 'out_of_stock');
  if (noPrice.length === 0) {
    ok('All products have prices');
  } else if (noPriceInStock.length === 0) {
    ok(`${noPrice.length} without price — all OOS (normal for WooCommerce)`);
  } else {
    const pct = inStock.length > 0 ? (noPriceInStock.length / inStock.length * 100).toFixed(1) : 0;
    if (pct > 10) {
      fail(`${pct}% in-stock without price`, noPriceInStock.length,
        noPriceInStock.slice(0, 5).map(n => `"${n.title.slice(0, 60)}" | ${n.url}`));
    } else {
      ok(`${noPriceInStock.length} in-stock without price (${pct}%), ${noPriceOos.length} OOS without price`);
    }
  }

  // ── Thumbnails ──────────────────────────────────────────────────────────
  // WooCommerce: WP REST API needs _embed=wp:featuredmedia for thumbnails.
  // CRITICAL: _fields parameter strips _embedded data — never use both together.
  console.log('\n[6h] Thumbnail coverage');
  const thumbPct = total > 0 ? ((total - noThumb.length) / total * 100).toFixed(1) : 0;
  const placeholders = all.filter(a =>
    a.thumbnail && /place-?holder|blank\.(gif|png|jpg)/i.test(a.thumbnail)
  );
  if (placeholders.length > 0) {
    fail('Placeholder thumbnails in DB', placeholders.length,
      placeholders.map(t => `"${t.title.slice(0, 50)}" → ${t.thumbnail.slice(0, 80)}`));
  } else if (noThumb.length === 0) {
    ok('All products have thumbnails');
  } else if (thumbPct >= 70) {
    ok(`${thumbPct}% thumbnail coverage (${noThumb.length} missing)`);
  } else {
    fail(`Low thumbnail coverage: ${thumbPct}%`, noThumb.length,
      noThumb.slice(0, 5).map(n => `"${n.title.slice(0, 60)}" | ${n.url}`));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. CRAWL HEALTH
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n=== 7. CRAWL HEALTH ===');
  const recentCrawls = await p.crawlEvent.findMany({
    where: { siteId: site.id },
    orderBy: { crawledAt: 'desc' },
    take: 10,
    select: { crawledAt: true, tier: true, newProducts: true, updatedProducts: true, totalProducts: true, error: true },
  });
  if (recentCrawls.length === 0) {
    fail('No crawl events found');
  } else {
    const latest = recentCrawls[0];
    const ageMin = Math.round((Date.now() - new Date(latest.crawledAt).getTime()) / 60000);
    ok(`Latest crawl: ${ageMin}min ago — tier ${latest.tier}, +${latest.newProducts} new, ~${latest.updatedProducts} updated, ${latest.totalProducts} total`);
    if (ageMin > 120) warn(`Last crawl was ${ageMin}min ago (>2 hours)`);

    const errorCrawls = recentCrawls.filter(c => c.error);
    if (errorCrawls.length > 0) {
      warn(`${errorCrawls.length}/10 recent crawls had errors`);
      for (const e of errorCrawls) {
        console.log(`    Tier ${e.tier} @ ${e.crawledAt.toISOString().slice(0, 16)}: ${(e.error || '').slice(0, 100)}`);
      }
    } else {
      ok('No errors in last 10 crawls');
    }

    // Tier coverage
    const tiers = recentCrawls.map(c => c.tier);
    for (let t = 1; t <= 4; t++) {
      if (!tiers.includes(t)) warn(`No Tier ${t} crawl in last 10 events`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. SAMPLE MISSING DATA
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n=== 8. SAMPLE MISSING DATA ===');
  if (noThumb.length > 0) {
    console.log(`  Missing thumbnails (${Math.min(3, noThumb.length)}/${noThumb.length}):`);
    noThumb.slice(0, 3).forEach(s => console.log(`    ${(s.title || '').slice(0, 50)} — ${s.url}`));
  }
  if (noPrice.length > 0) {
    console.log(`  Missing prices (${Math.min(3, noPrice.length)}/${noPrice.length}):`);
    noPrice.slice(0, 3).forEach(s =>
      console.log(`    [${s.stockStatus || 'null'}] ${(s.title || '').slice(0, 50)} — ${s.url}`)
    );
  }
  if (noThumb.length === 0 && noPrice.length === 0) ok('No missing data to sample');

  // ═══════════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(60));
  console.log('VERIFICATION SUMMARY: ' + site.domain);
  console.log('='.repeat(60));

  const fails = issues.filter(i => i.sev === 'FAIL');
  const warns = issues.filter(i => i.sev === 'WARN');

  if (fails.length === 0 && warns.length === 0) {
    console.log('\nALL CLEAR — no issues found');
  } else {
    if (fails.length > 0) {
      console.log(`\nFAILURES (${fails.length}):`);
      fails.forEach(f => console.log('  [FAIL] ' + f.msg));
    }
    if (warns.length > 0) {
      console.log(`\nWARNINGS (${warns.length}):`);
      warns.forEach(w => console.log('  [WARN] ' + w.msg));
    }
  }

  console.log('\nStats: ' + JSON.stringify({
    total, inStock: inStock.length, outStock: outStock.length,
    unknownStock: unknownStock.length, nullStock: nullStock.length,
    noPrice: noPrice.length, noThumb: noThumb.length,
    ...(liveTotal != null ? { liveTotal } : {}),
    ...(liveInStockCount != null ? { liveInStock: liveInStockCount } : {}),
  }));

  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
