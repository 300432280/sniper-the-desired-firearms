/**
 * User Flow Simulation & Data Accuracy Test
 *
 * Simulates real user experiences end-to-end and verifies data quality:
 *   Flow 1: Search for "mauser 270" on gunpost.ca — match accuracy + URL resolution
 *   Flow 2: Cross-site keyword "SKS" — coverage across all 7 sites + URL verification
 *   Flow 3: Notification landing page — staleness check vs current ProductIndex
 *   Flow 4: Data completeness — per-site field coverage for 5 random products
 *   Flow 5: Edge case keywords — tricky patterns that stress search logic
 *
 * Usage:
 *   cd backend && node scripts/test-user-flows.js
 *   cd backend && node scripts/test-user-flows.js --flow 2    # run specific flow only
 *   cd backend && node scripts/test-user-flows.js --json       # JSON output
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');

const prisma = new PrismaClient();

// ── Colors ──────────────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  magenta: '\x1b[35m',
};

const PASS = `${C.green}PASS${C.reset}`;
const FAIL = `${C.red}FAIL${C.reset}`;
const WARN = `${C.yellow}WARN${C.reset}`;
const SKIP = `${C.dim}SKIP${C.reset}`;

// ── HTTP helpers ────────────────────────────────────────────────────────────

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch a URL and return { status, ok, redirectUrl, error }.
 * Follows redirects. 500ms rate-limit is enforced by caller.
 */
async function fetchUrl(url, method = 'GET') {
  try {
    const resp = await axios({
      method,
      url,
      headers: { 'User-Agent': USER_AGENT },
      timeout: 15000,
      maxRedirects: 5,
      validateStatus: () => true, // don't throw on non-2xx
    });
    return {
      status: resp.status,
      ok: resp.status >= 200 && resp.status < 400,
      finalUrl: resp.request?.res?.responseUrl || url,
      html: method === 'GET' ? (typeof resp.data === 'string' ? resp.data : '') : null,
      error: null,
    };
  } catch (err) {
    return {
      status: null,
      ok: false,
      finalUrl: null,
      html: null,
      error: err.code || err.message,
    };
  }
}

/**
 * Check if a string appears in HTML (case-insensitive, normalized whitespace).
 */
function htmlContains(html, text) {
  if (!html || !text) return false;
  const normalize = s => s.toLowerCase().replace(/\s+/g, ' ').trim();
  return normalize(html).includes(normalize(text));
}

// ── Report accumulator ──────────────────────────────────────────────────────

const report = {
  flows: [],
  summary: { total: 0, passed: 0, failed: 0, warned: 0, skipped: 0 },
};

function addResult(flowName, testName, status, evidence = '') {
  report.flows.push({ flow: flowName, test: testName, status, evidence });
  report.summary.total++;
  if (status === 'PASS') report.summary.passed++;
  else if (status === 'FAIL') report.summary.failed++;
  else if (status === 'WARN') report.summary.warned++;
  else if (status === 'SKIP') report.summary.skipped++;
}

// ── Flow 1: Search for "mauser 270" on gunpost.ca ──────────────────────────

async function flow1() {
  console.log(`\n${C.bold}${C.cyan}══════════════════════════════════════════════════════════════${C.reset}`);
  console.log(`${C.bold}  Flow 1: Search "mauser 270" on gunpost.ca${C.reset}`);
  console.log(`${C.cyan}══════════════════════════════════════════════════════════════${C.reset}\n`);

  const FLOW = 'Flow 1';

  // 1a. Find matches via Search -> Match for "mauser 270" on gunpost.ca
  const searches = await prisma.search.findMany({
    where: {
      keyword: { contains: 'mauser 270', mode: 'insensitive' },
      websiteUrl: { contains: 'gunpost' },
    },
    include: {
      matches: {
        include: { productIndex: true },
        orderBy: { foundAt: 'desc' },
      },
    },
  });

  const allMatches = searches.flatMap(s => s.matches);
  console.log(`  Found ${searches.length} search(es), ${allMatches.length} total match(es)\n`);

  if (allMatches.length === 0) {
    addResult(FLOW, 'Matches exist', 'FAIL', 'No matches found for "mauser 270" on gunpost.ca');
    return;
  }
  addResult(FLOW, 'Matches exist', 'PASS', `${allMatches.length} matches found`);

  // 1b. For each match, verify URL resolves and page content
  let urlPassCount = 0;
  let titleFoundCount = 0;
  let priceFoundCount = 0;
  let staleCount = 0;

  // Limit to 10 matches to be respectful of rate limits
  const sampled = allMatches.slice(0, 10);

  for (const match of sampled) {
    await sleep(500);
    const result = await fetchUrl(match.url);
    const urlOk = result.ok;
    if (urlOk) urlPassCount++;

    console.log(`  ${urlOk ? PASS : FAIL} URL: ${match.url} (${result.status || result.error})`);

    if (result.html) {
      // Check title presence (use first ~50 chars of title to handle truncation)
      const titleSnippet = match.title.substring(0, 50);
      const titleFound = htmlContains(result.html, titleSnippet);
      if (titleFound) titleFoundCount++;
      console.log(`       Title in page: ${titleFound ? 'yes' : 'NO'} ("${titleSnippet}...")`);

      // Check price presence
      if (match.price) {
        const priceStr = match.price.toFixed(2);
        const priceAlt = match.price.toFixed(0);
        const priceFound = htmlContains(result.html, priceStr) || htmlContains(result.html, priceAlt)
          || htmlContains(result.html, '$' + priceStr) || htmlContains(result.html, '$' + priceAlt)
          || result.html.includes(priceStr.replace('.', ','));
        if (priceFound) priceFoundCount++;
        console.log(`       Price in page: ${priceFound ? 'yes' : 'NO'} ($${priceStr})`);
      }
    }

    // 1c. Compare Match data vs ProductIndex data (staleness check)
    if (match.productIndex) {
      const pi = match.productIndex;
      const titleDiff = match.title !== pi.title;
      const priceDiff = match.price !== pi.price;
      if (titleDiff || priceDiff) {
        staleCount++;
        console.log(`       ${WARN} Stale data: Match vs ProductIndex differ`);
        if (titleDiff) console.log(`         Title: Match="${match.title}" vs PI="${pi.title}"`);
        if (priceDiff) console.log(`         Price: Match=$${match.price} vs PI=$${pi.price}`);
      }
    }
    console.log('');
  }

  addResult(FLOW, 'URLs resolve', urlPassCount === sampled.length ? 'PASS' : 'FAIL',
    `${urlPassCount}/${sampled.length} URLs returned 200/3xx`);
  addResult(FLOW, 'Titles on page', titleFoundCount >= sampled.length * 0.5 ? 'PASS' : 'WARN',
    `${titleFoundCount}/${sampled.length} titles found in page HTML`);
  addResult(FLOW, 'Prices on page', priceFoundCount >= sampled.filter(m => m.price).length * 0.5 ? 'PASS' : 'WARN',
    `${priceFoundCount}/${sampled.filter(m => m.price).length} prices found in page HTML`);
  addResult(FLOW, 'Match-PI freshness', staleCount === 0 ? 'PASS' : 'WARN',
    staleCount === 0 ? 'All matches agree with ProductIndex' : `${staleCount} matches have stale data vs ProductIndex`);
}

// ── Flow 2: Cross-site keyword "SKS" ───────────────────────────────────────

async function flow2() {
  console.log(`\n${C.bold}${C.cyan}══════════════════════════════════════════════════════════════${C.reset}`);
  console.log(`${C.bold}  Flow 2: Cross-site keyword "SKS"${C.reset}`);
  console.log(`${C.cyan}══════════════════════════════════════════════════════════════${C.reset}\n`);

  const FLOW = 'Flow 2';

  const sites = await prisma.monitoredSite.findMany({
    where: { isEnabled: true },
    select: { id: true, domain: true, name: true, siteCategory: true },
  });

  console.log(`  Checking ${sites.length} enabled sites for "SKS" products\n`);

  if (sites.length === 0) {
    addResult(FLOW, 'Sites exist', 'FAIL', 'No enabled sites found');
    return;
  }

  let sitesWithResults = 0;
  const allResults = [];
  const perSiteReport = [];

  for (const site of sites) {
    const products = await prisma.productIndex.findMany({
      where: {
        siteId: site.id,
        isActive: true,
        title: { contains: 'SKS', mode: 'insensitive' },
      },
      select: { id: true, url: true, title: true, price: true },
    });

    const priceRange = products.filter(p => p.price != null).map(p => p.price);
    const minPrice = priceRange.length > 0 ? Math.min(...priceRange) : null;
    const maxPrice = priceRange.length > 0 ? Math.max(...priceRange) : null;

    const status = products.length > 0 ? PASS : `${C.dim}none${C.reset}`;
    const priceStr = priceRange.length > 0 ? `$${minPrice.toFixed(0)}-$${maxPrice.toFixed(0)}` : 'n/a';
    console.log(`  ${status} ${site.domain.padEnd(30)} ${String(products.length).padStart(4)} results  ${priceStr}`);

    if (products.length > 0) {
      sitesWithResults++;
      allResults.push(...products.map(p => ({ ...p, domain: site.domain })));
    }

    perSiteReport.push({
      domain: site.domain,
      count: products.length,
      priceRange: priceRange.length > 0 ? `$${minPrice}-$${maxPrice}` : null,
    });
  }

  console.log('');
  addResult(FLOW, 'SKS coverage', sitesWithResults >= 1 ? 'PASS' : 'FAIL',
    `${sitesWithResults}/${sites.length} sites have SKS results`);

  // Pick 2 random results and verify URLs
  if (allResults.length >= 2) {
    const shuffled = allResults.sort(() => Math.random() - 0.5);
    const sample = shuffled.slice(0, 2);
    let urlOk = 0;

    for (const product of sample) {
      await sleep(500);
      const result = await fetchUrl(product.url);
      const ok = result.ok;
      if (ok) urlOk++;
      console.log(`  ${ok ? PASS : FAIL} ${product.domain}: ${product.url} (${result.status || result.error})`);
    }

    addResult(FLOW, 'Random URL spot-check', urlOk === 2 ? 'PASS' : 'FAIL',
      `${urlOk}/2 random SKS product URLs resolved`);
  } else if (allResults.length > 0) {
    await sleep(500);
    const result = await fetchUrl(allResults[0].url);
    addResult(FLOW, 'Random URL spot-check', result.ok ? 'PASS' : 'FAIL',
      `Only ${allResults.length} result(s) available. URL ${result.ok ? 'OK' : 'failed'}: ${result.status || result.error}`);
  } else {
    addResult(FLOW, 'Random URL spot-check', 'SKIP', 'No SKS results to verify');
  }
}

// ── Flow 3: Notification landing page staleness ────────────────────────────

async function flow3() {
  console.log(`\n${C.bold}${C.cyan}══════════════════════════════════════════════════════════════${C.reset}`);
  console.log(`${C.bold}  Flow 3: Notification landing page check${C.reset}`);
  console.log(`${C.cyan}══════════════════════════════════════════════════════════════${C.reset}\n`);

  const FLOW = 'Flow 3';

  // Find a recent notification with linked matches
  const recentNotification = await prisma.notification.findFirst({
    orderBy: { sentAt: 'desc' },
    include: {
      matches: {
        include: {
          match: {
            include: { productIndex: true },
          },
        },
      },
      search: { select: { keyword: true, websiteUrl: true } },
    },
  });

  if (!recentNotification) {
    addResult(FLOW, 'Recent notification exists', 'FAIL', 'No notifications found in DB');
    return;
  }

  const sentAgo = Math.round((Date.now() - recentNotification.sentAt.getTime()) / (1000 * 60 * 60));
  console.log(`  Most recent notification:`);
  console.log(`    ID: ${recentNotification.id}`);
  console.log(`    Keyword: "${recentNotification.search.keyword}" on ${recentNotification.search.websiteUrl}`);
  console.log(`    Sent: ${recentNotification.sentAt.toISOString()} (${sentAgo}h ago)`);
  console.log(`    Linked matches: ${recentNotification.matches.length}\n`);

  addResult(FLOW, 'Recent notification exists', 'PASS',
    `Notification from ${sentAgo}h ago with ${recentNotification.matches.length} matches`);

  if (recentNotification.matches.length === 0) {
    addResult(FLOW, 'Notification has matches', 'FAIL', 'Notification has 0 linked matches via NotificationMatch');
    return;
  }
  addResult(FLOW, 'Notification has matches', 'PASS',
    `${recentNotification.matches.length} matches linked`);

  // Compare match data vs current ProductIndex
  let staleCount = 0;
  let currentCount = 0;
  let noIndexCount = 0;

  for (const nm of recentNotification.matches) {
    const match = nm.match;
    if (!match.productIndex) {
      noIndexCount++;
      console.log(`  ${WARN} Match "${match.title.substring(0, 50)}" — no ProductIndex link`);
      continue;
    }

    const pi = match.productIndex;
    const titleMatch = match.title === pi.title;
    const priceMatch = match.price === pi.price;

    if (titleMatch && priceMatch) {
      currentCount++;
    } else {
      staleCount++;
      console.log(`  ${WARN} Stale: "${match.title.substring(0, 40)}"`);
      if (!titleMatch) console.log(`         Title changed: "${pi.title.substring(0, 40)}"`);
      if (!priceMatch) console.log(`         Price changed: $${match.price} -> $${pi.price}`);
    }
  }

  const total = recentNotification.matches.length;
  console.log(`\n  Summary: ${currentCount} current, ${staleCount} stale, ${noIndexCount} unlinked (of ${total})`);

  addResult(FLOW, 'Notification data freshness',
    staleCount === 0 ? 'PASS' : (staleCount / total > 0.5 ? 'FAIL' : 'WARN'),
    `${currentCount}/${total} current, ${staleCount} stale, ${noIndexCount} unlinked`);
}

// ── Flow 4: Data completeness check ────────────────────────────────────────

async function flow4() {
  console.log(`\n${C.bold}${C.cyan}══════════════════════════════════════════════════════════════${C.reset}`);
  console.log(`${C.bold}  Flow 4: Data completeness check (5 random products/site)${C.reset}`);
  console.log(`${C.cyan}══════════════════════════════════════════════════════════════${C.reset}\n`);

  const FLOW = 'Flow 4';

  const sites = await prisma.monitoredSite.findMany({
    where: { isEnabled: true },
    select: { id: true, domain: true, siteCategory: true },
  });

  const fields = ['title', 'price', 'thumbnail', 'stockStatus', 'sourceId', 'productType'];
  const siteResults = [];

  for (const site of sites) {
    // Get total count first
    const totalActive = await prisma.productIndex.count({
      where: { siteId: site.id, isActive: true },
    });

    if (totalActive === 0) {
      console.log(`  ${FAIL} ${site.domain.padEnd(30)} — 0 active products`);
      addResult(FLOW, `${site.domain} completeness`, 'FAIL', 'No active products');
      continue;
    }

    // Sample 5 random products using skip with random offset
    const skip = Math.max(0, Math.floor(Math.random() * (totalActive - 5)));
    const products = await prisma.productIndex.findMany({
      where: { siteId: site.id, isActive: true },
      take: 5,
      skip,
      select: {
        title: true,
        price: true,
        thumbnail: true,
        stockStatus: true,
        sourceId: true,
        productType: true,
        url: true,
      },
    });

    const fieldCounts = {};
    for (const f of fields) fieldCounts[f] = 0;

    for (const product of products) {
      if (product.title && product.title.trim() !== '') fieldCounts.title++;
      if (product.price != null) fieldCounts.price++;
      if (product.thumbnail && product.thumbnail.trim() !== '') fieldCounts.thumbnail++;
      if (product.stockStatus && product.stockStatus.trim() !== '') fieldCounts.stockStatus++;
      if (product.sourceId && product.sourceId.trim() !== '') fieldCounts.sourceId++;
      if (product.productType && product.productType.trim() !== '') fieldCounts.productType++;
    }

    const n = products.length;
    const percentages = {};
    for (const f of fields) percentages[f] = Math.round((fieldCounts[f] / n) * 100);

    // Retailers should have prices; classifieds may not
    const isRetailer = site.siteCategory === 'retailer';
    const priceExpected = isRetailer;

    const allGood = percentages.title === 100
      && (!priceExpected || percentages.price >= 80)
      && percentages.thumbnail >= 60;

    const status = allGood ? PASS : WARN;
    const fieldStr = fields.map(f => {
      const pct = percentages[f];
      const color = pct === 100 ? C.green : pct >= 60 ? C.yellow : C.red;
      return `${f}:${color}${pct}%${C.reset}`;
    }).join('  ');

    console.log(`  ${status} ${site.domain.padEnd(30)} (${totalActive} active, sampled ${n})`);
    console.log(`       ${fieldStr}`);

    // Thumbnail spot-check: try HEAD request on first thumbnail
    if (products[0]?.thumbnail) {
      await sleep(500);
      const thumbResult = await fetchUrl(products[0].thumbnail, 'HEAD');
      const thumbOk = thumbResult.ok;
      console.log(`       Thumbnail loads: ${thumbOk ? 'yes' : 'NO'} (${thumbResult.status || thumbResult.error})`);
    }

    console.log('');

    const overallPct = Math.round(Object.values(percentages).reduce((a, b) => a + b, 0) / fields.length);
    addResult(FLOW, `${site.domain} completeness`,
      overallPct >= 70 ? 'PASS' : (overallPct >= 40 ? 'WARN' : 'FAIL'),
      `${overallPct}% avg field completeness (${totalActive} products). ` +
      fields.map(f => `${f}:${percentages[f]}%`).join(', '));

    siteResults.push({ domain: site.domain, totalActive, percentages });
  }
}

// ── Flow 5: Edge case keywords ─────────────────────────────────────────────

async function flow5() {
  console.log(`\n${C.bold}${C.cyan}══════════════════════════════════════════════════════════════${C.reset}`);
  console.log(`${C.bold}  Flow 5: Edge case keywords${C.reset}`);
  console.log(`${C.cyan}══════════════════════════════════════════════════════════════${C.reset}\n`);

  const FLOW = 'Flow 5';

  const sites = await prisma.monitoredSite.findMany({
    where: { isEnabled: true },
    select: { id: true, domain: true },
  });

  const edgeCases = [
    { keyword: 'Ruger 10/22', note: 'slash in keyword' },
    { keyword: '.308', note: 'dot prefix' },
    { keyword: '7.62x39', note: 'dot + x format' },
    { keyword: 'AR-15', note: 'hyphen' },
    { keyword: '$500 rifle', note: 'dollar sign — should NOT match on price' },
  ];

  for (const { keyword, note } of edgeCases) {
    console.log(`  ${C.bold}Keyword: "${keyword}"${C.reset} (${note})`);

    let totalResults = 0;
    let sitesWithResults = 0;
    const perSite = [];

    for (const site of sites) {
      // For "$500 rifle", search only for "rifle" to see if results accidentally match on "$500"
      // The dollar sign keyword test: we search title ILIKE '%$500 rifle%' — should find nothing
      // because "$500" is a price, not a product name
      const products = await prisma.productIndex.findMany({
        where: {
          siteId: site.id,
          isActive: true,
          title: { contains: keyword, mode: 'insensitive' },
        },
        select: { id: true, title: true, price: true },
        take: 20,
      });

      if (products.length > 0) {
        sitesWithResults++;
        totalResults += products.length;
      }

      perSite.push({ domain: site.domain, count: products.length, sample: products.slice(0, 2) });
    }

    // Display results
    for (const s of perSite) {
      if (s.count > 0) {
        console.log(`    ${C.green}${s.domain.padEnd(30)}${C.reset} ${s.count} results`);
        for (const p of s.sample) {
          console.log(`      ${C.dim}→ ${p.title.substring(0, 60)} ($${p.price || 'n/a'})${C.reset}`);
        }
      }
    }
    if (sitesWithResults === 0) {
      console.log(`    ${C.dim}No results on any site${C.reset}`);
    }

    // Evaluate results
    if (keyword === '$500 rifle') {
      // This SHOULD return no results (or very few). If it matches, it's likely a false positive
      // where the title literally contains "$500 rifle"
      const status = totalResults === 0 ? 'PASS' : 'WARN';
      const evidence = totalResults === 0
        ? 'No false positives — "$500 rifle" correctly returns no title matches'
        : `${totalResults} results contain "$500 rifle" in title — review for false positives`;
      addResult(FLOW, `Edge: "${keyword}"`, status, evidence);
    } else {
      // For legitimate firearms keywords, we expect at least some results
      const status = totalResults > 0 ? 'PASS' : 'WARN';
      addResult(FLOW, `Edge: "${keyword}"`, status,
        `${totalResults} results across ${sitesWithResults} sites`);

      // Sanity check: are results actually relevant?
      if (totalResults > 0) {
        const allSamples = perSite.flatMap(s => s.sample);
        const relevant = allSamples.filter(p =>
          p.title.toLowerCase().includes(keyword.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 3))
        );
        if (relevant.length < allSamples.length * 0.5) {
          console.log(`    ${WARN} Only ${relevant.length}/${allSamples.length} sampled titles seem relevant`);
        }
      }
    }

    console.log('');
  }
}

// ── Final report ────────────────────────────────────────────────────────────

function printReport(jsonMode) {
  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`\n${C.bold}${C.magenta}╔══════════════════════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.bold}${C.magenta}║              USER FLOW TEST REPORT                           ║${C.reset}`);
  console.log(`${C.bold}${C.magenta}╚══════════════════════════════════════════════════════════════╝${C.reset}\n`);

  // Group by flow
  const grouped = {};
  for (const r of report.flows) {
    if (!grouped[r.flow]) grouped[r.flow] = [];
    grouped[r.flow].push(r);
  }

  for (const [flow, tests] of Object.entries(grouped)) {
    const flowPassed = tests.every(t => t.status === 'PASS' || t.status === 'SKIP');
    const icon = flowPassed ? PASS : (tests.some(t => t.status === 'FAIL') ? FAIL : WARN);
    console.log(`  ${icon} ${C.bold}${flow}${C.reset}`);
    for (const t of tests) {
      const statusStr = t.status === 'PASS' ? PASS : t.status === 'FAIL' ? FAIL : t.status === 'WARN' ? WARN : SKIP;
      console.log(`       ${statusStr} ${t.test}`);
      if (t.evidence) console.log(`            ${C.dim}${t.evidence}${C.reset}`);
    }
    console.log('');
  }

  const { total, passed, failed, warned, skipped } = report.summary;
  console.log(`${C.bold}  Summary: ${total} tests — ${C.green}${passed} passed${C.reset}${C.bold}, ${C.red}${failed} failed${C.reset}${C.bold}, ${C.yellow}${warned} warned${C.reset}${C.bold}, ${C.dim}${skipped} skipped${C.reset}`);
  console.log('');
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const flowArg = args.find((_, i) => args[i - 1] === '--flow');
  const specificFlow = flowArg ? parseInt(flowArg, 10) : null;

  console.log(`${C.bold}${C.magenta}`);
  console.log(`  ╔══════════════════════════════════════════════════════════════╗`);
  console.log(`  ║          FirearmAlert — User Flow Simulation Test           ║`);
  console.log(`  ╚══════════════════════════════════════════════════════════════╝${C.reset}`);
  console.log(`  ${C.dim}${new Date().toISOString()}${C.reset}\n`);

  const flows = [
    { num: 1, fn: flow1 },
    { num: 2, fn: flow2 },
    { num: 3, fn: flow3 },
    { num: 4, fn: flow4 },
    { num: 5, fn: flow5 },
  ];

  for (const { num, fn } of flows) {
    if (specificFlow && specificFlow !== num) continue;
    try {
      await fn();
    } catch (err) {
      console.error(`\n  ${FAIL} Flow ${num} crashed: ${err.message}`);
      addResult(`Flow ${num}`, 'Execution', 'FAIL', `Crashed: ${err.message}`);
    }
  }

  printReport(jsonMode);
  await prisma.$disconnect();
}

main().catch(err => {
  console.error('Fatal error:', err);
  prisma.$disconnect();
  process.exit(1);
});
