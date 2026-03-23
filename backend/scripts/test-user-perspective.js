/**
 * User-Perspective Verification Script
 *
 * Tests the app from a user's point of view: every product the user sees
 * must have title, price, thumbnail, and a working URL. Any missing field
 * is a failure.
 *
 * Usage:
 *   node scripts/test-user-perspective.js
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');

const prisma = new PrismaClient();

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── Colors ──────────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  cyan: '\x1b[36m', white: '\x1b[37m', magenta: '\x1b[35m',
};

function pass(msg) { return `  ${C.green}PASS${C.reset} ${msg}`; }
function fail(msg) { return `  ${C.red}FAIL${C.reset} ${msg}`; }
function info(msg) { return `  ${C.cyan}INFO${C.reset} ${msg}`; }
function warn(msg) { return `  ${C.yellow}WARN${C.reset} ${msg}`; }

function delay(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

// ── HTTP helpers ────────────────────────────────────────────────────────────

async function checkThumbnail(url) {
  if (!url) return { ok: false, reason: 'null' };
  try {
    var resp = await axios.head(url, {
      headers: { 'User-Agent': UA },
      timeout: 10000,
      maxRedirects: 5,
      validateStatus: function() { return true; },
    });
    var ct = (resp.headers['content-type'] || '').toLowerCase();
    var isImage = ct.startsWith('image/');
    if (resp.status === 200 && isImage) return { ok: true };
    if (resp.status !== 200) return { ok: false, reason: 'HTTP ' + resp.status };
    return { ok: false, reason: 'content-type: ' + ct };
  } catch (err) {
    return { ok: false, reason: err.message.substring(0, 80) };
  }
}

async function checkUrl(url) {
  if (!url) return { ok: false, reason: 'null' };
  try {
    var resp = await axios.head(url, {
      headers: { 'User-Agent': UA },
      timeout: 10000,
      maxRedirects: 5,
      validateStatus: function() { return true; },
    });
    // 200, 301, 302 are acceptable
    if (resp.status >= 200 && resp.status < 400) return { ok: true, status: resp.status };
    if (resp.status === 403) return { ok: true, status: resp.status }; // WAF — not a dead link
    if (resp.status === 405) {
      // Some servers reject HEAD, try GET
      var getResp = await axios.get(url, {
        headers: { 'User-Agent': UA },
        timeout: 10000,
        maxRedirects: 5,
        validateStatus: function() { return true; },
      });
      if (getResp.status >= 200 && getResp.status < 400) return { ok: true, status: getResp.status };
      return { ok: false, reason: 'HTTP ' + getResp.status };
    }
    return { ok: false, reason: 'HTTP ' + resp.status };
  } catch (err) {
    return { ok: false, reason: err.message.substring(0, 80) };
  }
}

// ── Part 1: Match-level verification (keyword × site from user's searches) ──

var MATCH_TEST_CASES = [
  { keyword: 'mauser 270', site: 'gunpost.ca' },
  { keyword: 'SKS', site: 'gunpost.ca' },
  { keyword: '9mm', site: 'alsimmonsgunshop.com' },
  { keyword: 'Ruger 10/22', site: 'aagcanada.ca' },
  { keyword: 'shotgun', site: 'bullseyenorth.com' },
  { keyword: '.308', site: 'budgetshootersupply.ca' },
  { keyword: 'Federal', site: 'canadafirstammo.ca' },
  { keyword: 'scope', site: 'alflahertys.com' },
];

async function testMatchesForSearch(keyword, siteDomain) {
  console.log(`\n${C.bold}${C.cyan}── Matches: "${keyword}" on ${siteDomain} ──${C.reset}`);

  // Find searches matching this keyword+site
  var searches = await prisma.search.findMany({
    where: {
      keyword: { equals: keyword, mode: 'insensitive' },
      websiteUrl: { contains: siteDomain },
    },
    select: { id: true, keyword: true, websiteUrl: true },
  });

  if (searches.length === 0) {
    console.log(warn(`No search found for "${keyword}" on ${siteDomain} — skipping`));
    return { keyword: keyword, site: siteDomain, total: 0, pass: 0, fail: 0, skipped: true, failures: [] };
  }

  var searchIds = searches.map(function(s) { return s.id; });

  var matches = await prisma.match.findMany({
    where: { searchId: { in: searchIds } },
    include: { productIndex: true },
  });

  console.log(info(`Found ${matches.length} match(es) across ${searches.length} search(es)`));

  var passCount = 0;
  var failCount = 0;
  var failures = [];

  for (var match of matches) {
    var problems = [];

    // (a) Title: not empty and not a URL
    if (!match.title || match.title.trim() === '') {
      problems.push('TITLE_EMPTY');
    } else if (/^https?:\/\//.test(match.title.trim())) {
      problems.push('TITLE_IS_URL: "' + match.title.substring(0, 60) + '"');
    }

    // (b) Price: not null and > 0
    if (match.price == null) {
      problems.push('PRICE_NULL');
    } else if (match.price <= 0) {
      problems.push('PRICE_ZERO_OR_NEGATIVE: ' + match.price);
    }

    // (c) Thumbnail: not null, URL returns 200 with image content-type
    if (!match.thumbnail) {
      problems.push('THUMBNAIL_MISSING');
    } else {
      await delay(500);
      var thumbResult = await checkThumbnail(match.thumbnail);
      if (!thumbResult.ok) {
        problems.push('THUMBNAIL_BROKEN: ' + thumbResult.reason);
      }
    }

    // (d) productIndexId set
    if (!match.productIndexId) {
      problems.push('PRODUCT_INDEX_FK_MISSING');
    }

    // (e) & (f) Compare Match vs ProductIndex if FK exists
    if (match.productIndexId && match.productIndex) {
      var pi = match.productIndex;
      if (match.title !== pi.title) {
        problems.push('MATCH_TITLE_DIFFERS_FROM_PI: Match="' + match.title.substring(0, 40) + '" vs PI="' + pi.title.substring(0, 40) + '"');
      }
      if (match.price !== pi.price) {
        problems.push('MATCH_PRICE_DIFFERS_FROM_PI: Match=$' + match.price + ' vs PI=$' + pi.price);
      }
    }

    // (g) Product URL resolves
    await delay(500);
    var urlResult = await checkUrl(match.url);
    if (!urlResult.ok) {
      problems.push('URL_DEAD: ' + urlResult.reason);
    }

    // Report
    var label = '"' + (match.title || '(no title)').substring(0, 50) + '"';
    if (problems.length === 0) {
      passCount++;
      console.log(pass(label + ' — $' + (match.price || '?') + ' — OK'));
    } else {
      failCount++;
      failures.push({ matchId: match.id, title: match.title, problems: problems });
      console.log(fail(label));
      problems.forEach(function(p) { console.log('      ' + C.red + p + C.reset); });
    }
  }

  var total = passCount + failCount;
  var verdict = failCount === 0 ? C.green + 'ALL PASS' : C.red + failCount + '/' + total + ' FAILED';
  console.log(`  ${C.bold}Result: ${verdict}${C.reset}`);

  return { keyword: keyword, site: siteDomain, total: total, pass: passCount, fail: failCount, skipped: false, failures: failures };
}

// ── Part 2: ProductIndex-level verification (keyword ILIKE on site) ─────────

var PI_TEST_CASES = [
  { keyword: 'mauser 270', site: 'gunpost.ca' },
  { keyword: 'SKS', site: 'gunpost.ca' },
  { keyword: '9mm', site: 'alsimmonsgunshop.com' },
  { keyword: 'Ruger 10/22', site: 'aagcanada.ca' },
  { keyword: 'shotgun', site: 'bullseyenorth.com' },
  { keyword: '.308', site: 'budgetshootersupply.ca' },
  { keyword: 'Federal', site: 'canadafirstammo.ca' },
  { keyword: 'scope', site: 'alflahertys.com' },
];

async function testProductIndexForSite(keyword, siteDomain) {
  console.log(`\n${C.bold}${C.magenta}── ProductIndex: "${keyword}" on ${siteDomain} ──${C.reset}`);

  var site = await prisma.monitoredSite.findUnique({
    where: { domain: siteDomain },
    select: { id: true, siteCategory: true },
  });

  if (!site) {
    console.log(warn('Site not found in MonitoredSite: ' + siteDomain));
    return { keyword: keyword, site: siteDomain, total: 0, pass: 0, fail: 0, skipped: true, failures: [] };
  }

  // For multi-word keywords, search with contains for each word
  var words = keyword.split(/\s+/);
  var titleFilter;
  if (words.length > 1) {
    titleFilter = { AND: words.map(function(w) { return { title: { contains: w, mode: 'insensitive' } }; }) };
  } else {
    titleFilter = { title: { contains: keyword, mode: 'insensitive' } };
  }

  var products = await prisma.productIndex.findMany({
    where: Object.assign({ siteId: site.id, isActive: true }, titleFilter),
    take: 5,
    orderBy: { lastSeenAt: 'desc' },
  });

  if (products.length === 0) {
    console.log(warn('No active products matching "' + keyword + '" on ' + siteDomain));
    return { keyword: keyword, site: siteDomain, total: 0, pass: 0, fail: 0, skipped: true, failures: [] };
  }

  console.log(info('Checking ' + products.length + ' product(s)'));

  var passCount = 0;
  var failCount = 0;
  var failures = [];

  for (var product of products) {
    var problems = [];

    // Title not empty
    if (!product.title || product.title.trim() === '') {
      problems.push('TITLE_EMPTY');
    }

    // Price not null (for ProductIndex)
    if (product.price == null) {
      problems.push('PRICE_NULL');
    }

    // Thumbnail not null
    if (!product.thumbnail) {
      problems.push('THUMBNAIL_MISSING');
    } else {
      await delay(500);
      var thumbResult = await checkThumbnail(product.thumbnail);
      if (!thumbResult.ok) {
        problems.push('THUMBNAIL_BROKEN: ' + thumbResult.reason);
      }
    }

    // sourceId not null
    if (!product.sourceId) {
      problems.push('SOURCEID_MISSING');
    }

    // URL resolves
    await delay(500);
    var urlResult = await checkUrl(product.url);
    if (!urlResult.ok) {
      problems.push('URL_DEAD: ' + urlResult.reason);
    }

    var label = '"' + product.title.substring(0, 50) + '"';
    if (problems.length === 0) {
      passCount++;
      console.log(pass(label + ' — $' + (product.price || '?') + ' — OK'));
    } else {
      failCount++;
      failures.push({ productId: product.id, title: product.title, url: product.url, problems: problems });
      console.log(fail(label));
      problems.forEach(function(p) { console.log('      ' + C.red + p + C.reset); });
    }
  }

  var total = passCount + failCount;
  var verdict = failCount === 0 ? C.green + 'ALL PASS' : C.red + failCount + '/' + total + ' FAILED';
  console.log(`  ${C.bold}Result: ${verdict}${C.reset}`);

  return { keyword: keyword, site: siteDomain, total: total, pass: passCount, fail: failCount, skipped: false, failures: failures };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`${C.bold}${C.white}╔═══════════════════════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.bold}${C.white}║  USER-PERSPECTIVE VERIFICATION TEST                         ║${C.reset}`);
  console.log(`${C.bold}${C.white}╚═══════════════════════════════════════════════════════════════╝${C.reset}`);

  // ── Part 1: Match verification ──
  console.log(`\n${C.bold}${C.white}══════════════════════════════════════════════════════════════${C.reset}`);
  console.log(`${C.bold}${C.white}  PART 1: MATCH TABLE VERIFICATION                           ${C.reset}`);
  console.log(`${C.bold}${C.white}══════════════════════════════════════════════════════════════${C.reset}`);

  var matchResults = [];
  for (var tc of MATCH_TEST_CASES) {
    var result = await testMatchesForSearch(tc.keyword, tc.site);
    matchResults.push(result);
  }

  // ── Part 2: ProductIndex verification ──
  console.log(`\n${C.bold}${C.white}══════════════════════════════════════════════════════════════${C.reset}`);
  console.log(`${C.bold}${C.white}  PART 2: PRODUCT INDEX VERIFICATION                         ${C.reset}`);
  console.log(`${C.bold}${C.white}══════════════════════════════════════════════════════════════${C.reset}`);

  var piResults = [];
  for (var tc2 of PI_TEST_CASES) {
    var result2 = await testProductIndexForSite(tc2.keyword, tc2.site);
    piResults.push(result2);
  }

  // ── Final Summary ──
  console.log(`\n${C.bold}${C.magenta}═══════════════════════════════════════════════════════════════${C.reset}`);
  console.log(`${C.bold}${C.magenta}  FINAL SUMMARY                                               ${C.reset}`);
  console.log(`${C.bold}${C.magenta}═══════════════════════════════════════════════════════════════${C.reset}`);

  var totalPass = 0;
  var totalFail = 0;
  var totalSkipped = 0;

  console.log(`\n  ${C.bold}Match Tests:${C.reset}`);
  matchResults.forEach(function(r) {
    if (r.skipped) {
      totalSkipped++;
      console.log(`    ${C.dim}SKIP${C.reset} "${r.keyword}" on ${r.site} (no search found)`);
    } else {
      totalPass += r.pass;
      totalFail += r.fail;
      var color = r.fail === 0 ? C.green : C.red;
      console.log(`    ${color}${r.pass}/${r.total} pass${C.reset} "${r.keyword}" on ${r.site}${r.fail > 0 ? ' — ' + C.red + r.fail + ' FAILED' + C.reset : ''}`);
    }
  });

  console.log(`\n  ${C.bold}ProductIndex Tests:${C.reset}`);
  piResults.forEach(function(r) {
    if (r.skipped) {
      totalSkipped++;
      console.log(`    ${C.dim}SKIP${C.reset} "${r.keyword}" on ${r.site} (no data)`);
    } else {
      totalPass += r.pass;
      totalFail += r.fail;
      var color = r.fail === 0 ? C.green : C.red;
      console.log(`    ${color}${r.pass}/${r.total} pass${C.reset} "${r.keyword}" on ${r.site}${r.fail > 0 ? ' — ' + C.red + r.fail + ' FAILED' + C.reset : ''}`);
    }
  });

  console.log(`\n  ${C.bold}Totals:${C.reset}`);
  console.log(`    ${C.green}PASS: ${totalPass}${C.reset}`);
  console.log(`    ${C.red}FAIL: ${totalFail}${C.reset}`);
  console.log(`    ${C.dim}SKIP: ${totalSkipped}${C.reset}`);

  // Collect all failures for final report
  var allFailures = [];
  matchResults.concat(piResults).forEach(function(r) {
    if (r.failures) allFailures = allFailures.concat(r.failures);
  });

  if (allFailures.length > 0) {
    console.log(`\n  ${C.bold}${C.red}FAILURE DETAILS:${C.reset}`);
    allFailures.forEach(function(f) {
      console.log(`    ${C.red}${f.title ? f.title.substring(0, 60) : f.matchId || f.productId}${C.reset}`);
      f.problems.forEach(function(p) { console.log(`      - ${p}`); });
    });
  }

  var exitCode = totalFail > 0 ? 1 : 0;
  console.log(`\n  ${C.bold}Exit code: ${exitCode}${C.reset}`);

  await prisma.$disconnect();
  process.exit(exitCode);
}

main().catch(function(err) {
  console.error(err);
  prisma.$disconnect();
  process.exit(1);
});
