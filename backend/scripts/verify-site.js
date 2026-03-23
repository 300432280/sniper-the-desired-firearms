/**
 * Site Verification Script v2
 *
 * 9 test suites for comprehensive per-site data quality verification:
 *   1. Data Schema Validation
 *   2. Data Quality Scoring
 *   3. Keyword Search Comparison (DB vs live site API)
 *   4. Stock Accuracy Spot-Check (DB vs live API)
 *   5. Thumbnail Validation
 *   6. API Health Check
 *   7. Catalog Freshness
 *   8. sourceId Coverage
 *   9. Match Freshness
 *
 * Usage:
 *   node scripts/verify-site.js <domain>              # full verification (all 9 tests, all 52 keywords)
 *   node scripts/verify-site.js --all                  # full verification, all enabled sites
 *   node scripts/verify-site.js <domain> --quick       # quick verification (all 9 tests, 12 representative keywords)
 *   node scripts/verify-site.js --all --quick          # quick verification, all enabled sites
 *   node scripts/verify-site.js <domain> --test 3      # specific test only
 *   node scripts/verify-site.js <domain> --json        # JSON output
 */

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
};

function pass(msg) { return `${C.green}PASS${C.reset} ${msg}`; }
function warn(msg) { return `${C.yellow}WARN${C.reset} ${msg}`; }
function fail(msg) { return `${C.red}FAIL${C.reset} ${msg}`; }

function pct(n, total) {
  if (total === 0) return '0%';
  return Math.round(n / total * 100) + '%';
}

function pctNum(n, total) {
  if (total === 0) return 0;
  return Math.round(n / total * 100);
}

// ── Test Keywords ───────────────────────────────────────────────────────────
// Quick: 1 representative keyword per category (12 keywords, fast)
// Full: all keywords across every category (52 keywords, thorough)

var QUICK_KEYWORDS = [
  { keyword: 'SKS', category: 'NR Rifles' },
  { keyword: 'shotgun', category: 'Shotguns' },
  { keyword: '9mm', category: 'Calibers' },
  { keyword: '.308', category: 'Calibers' },
  { keyword: '.22 LR', category: 'Calibers' },
  { keyword: 'Federal', category: 'Ammo Brands' },
  { keyword: 'FMJ', category: 'Ammo Types' },
  { keyword: 'scope', category: 'Optics' },
  { keyword: 'magazine', category: 'Accessories' },
  { keyword: 'surplus', category: 'Milsurp' },
  { keyword: 'primer', category: 'Reloading' },
  { keyword: 'Ruger 10/22', category: 'Brand+Model' },
];

var FULL_KEYWORDS = [
  // Canadian NR Rifles
  { keyword: 'GSG-16', category: 'NR Rifles' },
  { keyword: 'WK180C', category: 'NR Rifles' },
  { keyword: 'SKS', category: 'NR Rifles' },
  { keyword: 'Type 81', category: 'NR Rifles' },
  { keyword: 'Ruger PC Carbine', category: 'NR Rifles' },
  { keyword: 'Tikka T3x', category: 'NR Rifles' },
  // Shotguns
  { keyword: 'Mossberg 500', category: 'Shotguns' },
  { keyword: 'Canuck Defender', category: 'Shotguns' },
  { keyword: 'shotgun', category: 'Shotguns' },
  // Calibers (with format variants)
  { keyword: '9mm', category: 'Calibers' },
  { keyword: '.223', category: 'Calibers' },
  { keyword: '5.56', category: 'Calibers' },
  { keyword: '7.62x39', category: 'Calibers' },
  { keyword: '.308', category: 'Calibers' },
  { keyword: '12 gauge', category: 'Calibers' },
  { keyword: '.22 LR', category: 'Calibers' },
  { keyword: '6.5 Creedmoor', category: 'Calibers' },
  { keyword: '.300 Blackout', category: 'Calibers' },
  { keyword: '.45 ACP', category: 'Calibers' },
  // Ammo brands
  { keyword: 'Federal', category: 'Ammo Brands' },
  { keyword: 'Hornady', category: 'Ammo Brands' },
  { keyword: 'Winchester', category: 'Ammo Brands' },
  { keyword: 'CCI', category: 'Ammo Brands' },
  { keyword: 'Barnaul', category: 'Ammo Brands' },
  // Ammo types
  { keyword: 'FMJ', category: 'Ammo Types' },
  { keyword: 'hollow point', category: 'Ammo Types' },
  { keyword: 'subsonic', category: 'Ammo Types' },
  { keyword: 'bulk ammo', category: 'Ammo Types' },
  // Optics
  { keyword: 'Vortex', category: 'Optics' },
  { keyword: 'Holosun', category: 'Optics' },
  { keyword: 'red dot', category: 'Optics' },
  { keyword: 'scope', category: 'Optics' },
  { keyword: 'LPVO', category: 'Optics' },
  // Accessories
  { keyword: 'magazine', category: 'Accessories' },
  { keyword: 'sling', category: 'Accessories' },
  { keyword: 'bipod', category: 'Accessories' },
  { keyword: 'muzzle brake', category: 'Accessories' },
  // Milsurp
  { keyword: 'surplus', category: 'Milsurp' },
  { keyword: 'Mosin Nagant', category: 'Milsurp' },
  { keyword: 'Lee Enfield', category: 'Milsurp' },
  // Reloading
  { keyword: 'primer', category: 'Reloading' },
  { keyword: 'brass', category: 'Reloading' },
  { keyword: 'reloading press', category: 'Reloading' },
  // Storage & Safety
  { keyword: 'gun safe', category: 'Storage' },
  { keyword: 'trigger lock', category: 'Storage' },
  { keyword: 'gun case', category: 'Storage' },
  // Cleaning
  { keyword: 'cleaning kit', category: 'Cleaning' },
  { keyword: 'bore snake', category: 'Cleaning' },
  // Brand + Model combos
  { keyword: 'Ruger 10/22', category: 'Brand+Model' },
  { keyword: 'Savage 110', category: 'Brand+Model' },
  { keyword: 'Remington 700', category: 'Brand+Model' },
  { keyword: 'Henry lever action', category: 'Brand+Model' },
];

// ── Keyword matcher (replicated from keyword-matcher.ts) ────────────────────

async function expandKeyword(keyword) {
  var normalized = keyword.toLowerCase().trim();
  var alias = await prisma.keywordAlias.findUnique({
    where: { alias: normalized },
    include: { group: { include: { aliases: true } } },
  });
  if (alias) return alias.group.aliases.map(function(a) { return a.alias; });
  return [normalized];
}

function matchesKeyword(title, keyword) {
  var titleLower = title.toLowerCase();
  var kw = keyword.toLowerCase();
  var idx = titleLower.indexOf(kw);
  if (idx === -1) return false;
  var charBefore = idx > 0 ? titleLower[idx - 1] : ' ';
  return !/[a-z0-9]/i.test(charBefore);
}

function matchesMultiWord(title, keyword, extras) {
  var combined = [title, extras.tags || '', extras.urlSlug || ''].join(' ');
  if (matchesKeyword(combined, keyword)) return true;
  var words = keyword.toLowerCase().split(/\s+/).filter(function(w) { return w.length >= 2; });
  if (words.length <= 1) return false;
  return words.every(function(word) { return matchesKeyword(combined, word); });
}

async function searchProductIndex(keyword, siteId) {
  var aliases = await expandKeyword(keyword);
  var sqlTerms = new Set(aliases);
  for (var i = 0; i < aliases.length; i++) {
    var alias = aliases[i];
    var words = alias.split(/\s+/).filter(function(w) { return w.length >= 2; });
    if (words.length > 1) {
      for (var j = 0; j < words.length; j++) {
        sqlTerms.add(words[j]);
        var wordAliases = await expandKeyword(words[j]);
        for (var k = 0; k < wordAliases.length; k++) sqlTerms.add(wordAliases[k]);
      }
    }
  }

  var products = await prisma.productIndex.findMany({
    where: {
      isActive: true,
      siteId: siteId,
      OR: Array.from(sqlTerms).flatMap(function(term) {
        return [
          { title: { contains: term, mode: 'insensitive' } },
          { tags: { contains: term, mode: 'insensitive' } },
          { url: { contains: term, mode: 'insensitive' } },
        ];
      }),
    },
    orderBy: { firstSeenAt: 'desc' },
    take: 500,
  });

  return products.filter(function(prod) {
    var urlSlug = (prod.url.split('/').pop() || '').replace(/-/g, ' ');
    return aliases.some(function(alias) {
      return matchesMultiWord(prod.title, alias, { tags: prod.tags, urlSlug: urlSlug });
    });
  });
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
var UA_ALT1 = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
var UA_ALT2 = 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0';

function apiGet(url, params, timeout) {
  return axios.get(url, {
    params: params || {},
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    timeout: timeout || 15000,
    validateStatus: function(s) { return s < 500; },
  });
}

// ── Test 1: Data Schema Validation ──────────────────────────────────────────

async function testSchemaValidation(site) {
  var results = [];
  var products = await prisma.productIndex.findMany({
    where: { siteId: site.id },
    select: {
      id: true, url: true, title: true, price: true, stockStatus: true,
      tags: true, firstSeenAt: true, lastSeenAt: true, isActive: true,
    },
  });

  var total = products.length;
  if (total === 0) return { verdict: 'FAIL', details: ['No products in index'], results: results };

  // URL validation
  var badUrls = 0;
  var domainMismatch = 0;
  for (var i = 0; i < products.length; i++) {
    try {
      var u = new URL(products[i].url);
      if (!u.hostname.includes(site.domain.replace('www.', ''))) domainMismatch++;
    } catch { badUrls++; }
  }
  if (badUrls > 0) results.push(fail(badUrls + ' products with invalid URLs'));
  else results.push(pass('All URLs valid'));
  if (domainMismatch > 0) results.push(warn(domainMismatch + ' URLs don\'t match site domain'));

  // Title check
  var missingTitle = products.filter(function(p) { return !p.title || p.title.trim() === ''; }).length;
  if (missingTitle > total * 0.01) results.push(fail(missingTitle + ' products missing title'));
  else if (missingTitle > 0) results.push(warn(missingTitle + ' products missing title'));
  else results.push(pass('All products have titles'));

  // Price range
  var badPrice = products.filter(function(p) {
    return p.price !== null && (p.price <= 0 || p.price > 99999);
  }).length;
  if (badPrice > 0) results.push(warn(badPrice + ' products with price outside $0.01-$99,999'));
  else results.push(pass('All prices in valid range'));

  // Stock status values
  var validStock = ['in_stock', 'out_of_stock', 'unknown', null];
  var badStock = products.filter(function(p) { return validStock.indexOf(p.stockStatus) === -1; }).length;
  if (badStock > 0) results.push(fail(badStock + ' products with invalid stock status'));
  else results.push(pass('All stock statuses valid'));

  // Duplicate URLs
  var urlSet = new Set();
  var dupes = 0;
  for (var j = 0; j < products.length; j++) {
    if (urlSet.has(products[j].url)) dupes++;
    urlSet.add(products[j].url);
  }
  if (dupes > 0) results.push(fail(dupes + ' duplicate URLs'));
  else results.push(pass('No duplicate URLs'));

  // Date consistency
  var badDates = products.filter(function(p) {
    return p.lastSeenAt < p.firstSeenAt;
  }).length;
  if (badDates > 0) results.push(fail(badDates + ' products with lastSeen < firstSeen'));
  else results.push(pass('All dates consistent'));

  // Tags format
  var badTags = products.filter(function(p) {
    if (!p.tags) return false;
    return p.tags.split(',').some(function(t) { return t.trim() === ''; });
  }).length;
  if (badTags > 0) results.push(warn(badTags + ' products with malformed tags'));

  var hasFail = results.some(function(r) { return r.includes('FAIL'); });
  var hasWarn = results.some(function(r) { return r.includes('WARN'); });
  return { verdict: hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS', details: results };
}

// ── Test 2: Data Quality Scoring ────────────────────────────────────────────

async function testDataQuality(site) {
  var results = [];
  var total = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true } });
  if (total === 0) return { verdict: 'FAIL', details: ['No active products'], results: results };

  var withPrice = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true, price: { not: null } } });
  var withTags = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true, tags: { not: null } } });
  var withThumb = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true, thumbnail: { not: null } } });
  var withType = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true, productType: { not: null } } });
  var knownStock = await prisma.productIndex.count({
    where: { siteId: site.id, isActive: true, stockStatus: { in: ['in_stock', 'out_of_stock'] } },
  });
  var allFields = await prisma.productIndex.count({
    where: {
      siteId: site.id, isActive: true,
      price: { not: null }, tags: { not: null },
      thumbnail: { not: null }, stockStatus: { in: ['in_stock', 'out_of_stock'] },
    },
  });

  function score(name, count, warnThresh, failThresh) {
    var p = pctNum(count, total);
    var msg = name + ': ' + count + '/' + total + ' (' + p + '%)';
    if (p >= warnThresh) { results.push(pass(msg)); return 'PASS'; }
    if (p >= failThresh) { results.push(warn(msg)); return 'WARN'; }
    results.push(fail(msg)); return 'FAIL';
  }

  score('Price coverage', withPrice, 90, 50);
  score('Tags coverage', withTags, 90, 50);
  score('Thumbnail coverage', withThumb, 90, 70);
  score('Stock known', knownStock, 95, 80);
  score('ProductType', withType, 80, 50);
  score('All fields complete', allFields, 80, 50);

  // Stock breakdown
  var inStock = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true, stockStatus: 'in_stock' } });
  var oos = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true, stockStatus: 'out_of_stock' } });
  var unknown = total - inStock - oos;
  results.push(pass('Stock: ' + inStock + ' in_stock, ' + oos + ' out_of_stock, ' + unknown + ' unknown'));

  // Regular price (sale items)
  var withRegPrice = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true, regularPrice: { not: null } } });
  if (withRegPrice > 0) results.push(pass('Sale items (regularPrice): ' + withRegPrice));

  var hasFail = results.some(function(r) { return r.includes('FAIL'); });
  var hasWarn = results.some(function(r) { return r.includes('WARN'); });
  return { verdict: hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS', details: results };
}

// ── Search URL builder ──────────────────────────────────────────────────────
// Builds the live search URL for any site type.
// Priority: searchUrlPattern from DB > adapter-type default > generic fallback

var ADAPTER_SEARCH_DEFAULTS = {
  'woocommerce':         '/?s={keyword}&post_type=product',
  'shopify':             '/search?q={keyword}&type=product',
  'generic-retail':      '/?s={keyword}',
  'forum-xenforo':       '/search/?q={keyword}&t=post',
  'forum-vbulletin':     '/search.php?do=process&query={keyword}',
  'classifieds-gunpost': '/ads?key={keyword}',
  'auction-hibid':       '/search?searchPhrase={keyword}',
  'auction-icollector':  '/search?q={keyword}',
  'auction-generic':     '/search?q={keyword}',
  'generic':             '/?s={keyword}',
};

function buildSearchUrl(origin, keyword, site) {
  var pattern = site.searchUrlPattern || ADAPTER_SEARCH_DEFAULTS[site.adapterType] || '/?s={keyword}';
  return origin + pattern.replace('{keyword}', encodeURIComponent(keyword));
}

// ── HTML product link extraction ────────────────────────────────────────────
// Extracts product-like URLs from HTML search results page.
// Matches <a href="..."> where URL looks like a product page.

var PRODUCT_URL_RE = /href=["'](https?:\/\/[^"']*\/(?:product|products|shop|item|p|listing|lot|ads|ad|classified)s?\/[^"'#?]+)/gi;
var RELATIVE_PRODUCT_RE = /href=["'](\/(?:product|products|shop|item|p|listing|lot|ads|ad|classified)s?\/[^"'#?]+)/gi;

function extractProductUrls(html, origin) {
  var urls = new Set();
  var siteDomain = new URL(origin).hostname.replace('www.', '');

  // Absolute URLs
  var match;
  while ((match = PRODUCT_URL_RE.exec(html)) !== null) {
    try {
      var u = new URL(match[1]);
      if (u.hostname.replace('www.', '').includes(siteDomain)) {
        urls.add(u.origin + u.pathname.replace(/\/$/, ''));
      }
    } catch { /* skip bad URLs */ }
  }

  // Relative URLs
  while ((match = RELATIVE_PRODUCT_RE.exec(html)) !== null) {
    urls.add(origin + match[1].replace(/\/$/, ''));
  }

  // Reset regex lastIndex for next call
  PRODUCT_URL_RE.lastIndex = 0;
  RELATIVE_PRODUCT_RE.lastIndex = 0;

  return Array.from(urls);
}

// ── Test 3: Keyword Search Comparison ───────────────────────────────────────

async function testKeywordSearch(site, opts) {
  var results = [];
  var origin = site.url.replace(/\/$/, '');
  var totalKeywords = 0;
  var matchedKeywords = 0;
  var missingOnSite = 0;
  var totalDbResults = 0;
  var totalLiveResults = 0;

  var isQuick = opts && opts.quick;
  var keywords = isQuick ? QUICK_KEYWORDS : FULL_KEYWORDS;
  results.push(pass('Mode: ' + (isQuick ? 'QUICK (12 keywords)' : 'FULL (52 keywords)')));

  // Determine search method
  var useApi = (site.adapterType === 'woocommerce' || site.adapterType === 'shopify');
  var method = useApi ? 'API' : 'HTML';
  results.push(pass('Search method: ' + method + ' (' + site.adapterType + ')'));

  for (var i = 0; i < keywords.length; i++) {
    var kw = keywords[i];
    totalKeywords++;

    // DB search
    var dbResults = await searchProductIndex(kw.keyword, site.id);

    // Live site search
    var liveResults = [];
    try {
      if (site.adapterType === 'woocommerce') {
        // WooCommerce: Store API JSON search
        var resp = await apiGet(origin + '/wp-json/wc/store/v1/products', { search: kw.keyword, per_page: 100 });
        if (resp.status === 200 && Array.isArray(resp.data)) {
          liveResults = resp.data.map(function(p) { return { title: p.name, url: p.permalink }; });
        }
      } else if (site.adapterType === 'shopify') {
        // Shopify: suggest API JSON search
        var resp2 = await apiGet(origin + '/search/suggest.json', {
          q: kw.keyword, 'resources[type]': 'product', 'resources[limit]': 100,
        });
        if (resp2.status === 200) {
          var prods = (resp2.data && resp2.data.resources && resp2.data.resources.results && resp2.data.resources.results.products) || [];
          liveResults = prods.map(function(p) {
            return { title: p.title, url: p.url ? (p.url.startsWith('http') ? p.url : origin + p.url) : '' };
          });
        }
      } else {
        // All other adapters: HTML search page scraping
        var searchUrl = buildSearchUrl(origin, kw.keyword, site);
        var resp3 = await axios.get(searchUrl, {
          headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
          timeout: 15000,
          maxRedirects: 5,
          validateStatus: function(s) { return s < 500; },
        });
        if (resp3.status === 200 && typeof resp3.data === 'string') {
          var foundUrls = extractProductUrls(resp3.data, origin);
          liveResults = foundUrls.map(function(u) { return { title: '', url: u }; });
        }
      }
    } catch (err) { /* search unavailable */ }

    totalDbResults += dbResults.length;
    totalLiveResults += liveResults.length;

    // Compare
    if (dbResults.length > 0) matchedKeywords++;

    var flag = '';
    if (liveResults.length > 0 && dbResults.length === 0) {
      flag = ' ← MISSING (site has ' + liveResults.length + ')';
      missingOnSite++;
    } else if (liveResults.length > 0 && dbResults.length > 0) {
      var ratio = dbResults.length / liveResults.length;
      if (ratio < 0.5) flag = ' ← LOW (site:' + liveResults.length + ' db:' + dbResults.length + ')';
    }

    results.push('  ' + kw.keyword.padEnd(22) + String(dbResults.length).padStart(5) + ' db  ' +
      String(liveResults.length).padStart(5) + ' live' + flag);

    // Rate limit between live requests
    await new Promise(function(r) { setTimeout(r, 300); });
  }

  // Summary
  var summary = matchedKeywords + '/' + totalKeywords + ' keywords have DB results, ' +
    totalDbResults + ' total DB matches, ' + totalLiveResults + ' total live matches';

  if (missingOnSite > totalKeywords * 0.1) {
    results.unshift(fail(summary));
    return { verdict: 'FAIL', details: results };
  }
  if (missingOnSite > 0) {
    results.unshift(warn(summary));
    return { verdict: 'WARN', details: results };
  }
  results.unshift(pass(summary));
  return { verdict: 'PASS', details: results };
}

// ── Test 4: Stock Accuracy Spot-Check ───────────────────────────────────────

async function testStockAccuracy(site) {
  var results = [];
  var origin = site.url.replace(/\/$/, '');

  if (site.adapterType !== 'woocommerce' && site.adapterType !== 'shopify') {
    results.push(warn('Stock check not supported for adapter: ' + site.adapterType));
    return { verdict: 'WARN', details: results };
  }

  // Get our in_stock products
  var dbInStock = await prisma.productIndex.findMany({
    where: { siteId: site.id, isActive: true, stockStatus: 'in_stock' },
    select: { id: true, url: true, title: true },
  });
  var dbInStockCount = dbInStock.length;

  // Get our out_of_stock products
  var dbOosCount = await prisma.productIndex.count({
    where: { siteId: site.id, isActive: true, stockStatus: 'out_of_stock' },
  });

  results.push(pass('DB stock: ' + dbInStockCount + ' in_stock, ' + dbOosCount + ' out_of_stock'));

  var mismatches = [];

  if (site.adapterType === 'woocommerce') {
    // Build set of actually in-stock URLs from Store API
    var actuallyInStock = new Set();
    var page = 1;
    var totalLiveInStock = 0;
    while (page <= 50) {
      try {
        var resp = await apiGet(origin + '/wp-json/wc/store/v1/products', { per_page: 100, page: page });
        if (resp.status !== 200 || !Array.isArray(resp.data) || resp.data.length === 0) break;
        for (var i = 0; i < resp.data.length; i++) {
          if (resp.data[i].is_in_stock) {
            actuallyInStock.add(resp.data[i].permalink);
            totalLiveInStock++;
          }
        }
        page++;
        await new Promise(function(r) { setTimeout(r, 200); });
      } catch { break; }
    }

    results.push(pass('Store API: ' + totalLiveInStock + ' actually in stock'));

    // Check sample of our in_stock products
    var sample = dbInStock.slice(0, 200);
    for (var j = 0; j < sample.length; j++) {
      if (!actuallyInStock.has(sample[j].url)) {
        mismatches.push(sample[j].title.slice(0, 60) + ' → should be OOS');
      }
    }
  } else if (site.adapterType === 'shopify') {
    // Shopify: check products.json for stock info
    try {
      var resp2 = await apiGet(origin + '/products.json', { limit: 250 });
      if (resp2.status === 200 && resp2.data && resp2.data.products) {
        var shopifyProducts = resp2.data.products;
        var shopifyByHandle = {};
        for (var k = 0; k < shopifyProducts.length; k++) {
          var sp = shopifyProducts[k];
          var handle = origin + '/products/' + sp.handle;
          shopifyByHandle[handle] = sp.variants && sp.variants.some(function(v) { return v.available; });
        }
        var sample2 = dbInStock.slice(0, 200);
        for (var l = 0; l < sample2.length; l++) {
          var url = sample2[l].url.replace(/\?.*$/, '');
          if (shopifyByHandle.hasOwnProperty(url) && !shopifyByHandle[url]) {
            mismatches.push(sample2[l].title.slice(0, 60) + ' → should be OOS');
          }
        }
      }
    } catch { results.push(warn('Could not fetch /products.json')); }
  }

  if (mismatches.length > 5) {
    for (var m = 0; m < Math.min(mismatches.length, 10); m++) results.push('  ' + mismatches[m]);
    results.push(fail(mismatches.length + ' stock mismatches found'));
    return { verdict: 'FAIL', details: results };
  }
  if (mismatches.length > 0) {
    for (var n = 0; n < mismatches.length; n++) results.push('  ' + mismatches[n]);
    results.push(warn(mismatches.length + ' stock mismatches found'));
    return { verdict: 'WARN', details: results };
  }
  results.push(pass('0 stock mismatches in sample'));
  return { verdict: 'PASS', details: results };
}

// ── Test 5: Thumbnail Validation ────────────────────────────────────────────

async function testThumbnails(site) {
  var results = [];
  var total = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true } });
  var withThumb = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true, thumbnail: { not: null } } });
  var coverage = pctNum(withThumb, total);

  if (coverage >= 95) results.push(pass('Thumbnail coverage: ' + withThumb + '/' + total + ' (' + coverage + '%)'));
  else if (coverage >= 80) results.push(warn('Thumbnail coverage: ' + withThumb + '/' + total + ' (' + coverage + '%)'));
  else results.push(fail('Thumbnail coverage: ' + withThumb + '/' + total + ' (' + coverage + '%)'));

  // Sample check: HEAD request on 30 thumbnails
  var thumbnails = await prisma.productIndex.findMany({
    where: { siteId: site.id, isActive: true, thumbnail: { not: null } },
    select: { thumbnail: true, title: true },
    take: 30,
    orderBy: { lastSeenAt: 'desc' },
  });

  var accessible = 0;
  var broken = 0;
  var placeholder = 0;
  var brokenSamples = [];
  var PLACEHOLDER_RE = /place-?holder|no-image|woocommerce-placeholder|default-product|blank\.(gif|png|jpg)|product-image-coming/i;

  for (var i = 0; i < thumbnails.length; i++) {
    var thumb = thumbnails[i].thumbnail;

    // Check for placeholder patterns in URL
    if (PLACEHOLDER_RE.test(thumb)) {
      placeholder++;
      continue;
    }

    try {
      var resp = await axios.head(thumb, {
        headers: { 'User-Agent': UA },
        timeout: 8000,
        maxRedirects: 3,
        validateStatus: function(s) { return s < 400; },
      });
      accessible++;
    } catch {
      broken++;
      if (brokenSamples.length < 5) {
        brokenSamples.push(thumbnails[i].title.slice(0, 40) + ' → ' + thumb.slice(0, 60));
      }
    }
  }

  var checked = accessible + broken + placeholder;
  if (checked > 0) {
    results.push(pass('Checked ' + checked + ' thumbnails: ' + accessible + ' OK, ' + broken + ' broken, ' + placeholder + ' placeholder'));
  }
  for (var j = 0; j < brokenSamples.length; j++) results.push('  ' + brokenSamples[j]);

  // HTTPS check
  var httpThumbs = await prisma.productIndex.count({
    where: { siteId: site.id, isActive: true, thumbnail: { startsWith: 'http://' } },
  });
  if (httpThumbs > 0) results.push(warn(httpThumbs + ' thumbnails use HTTP (not HTTPS)'));

  var hasFail = results.some(function(r) { return r.includes('FAIL'); });
  var hasWarn = results.some(function(r) { return r.includes('WARN'); });
  return { verdict: hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS', details: results };
}

// ── Test 6: API Health Check ────────────────────────────────────────────────

async function testApiHealth(site) {
  var results = [];
  var origin = site.url.replace(/\/$/, '');

  if (site.adapterType === 'woocommerce') {
    // WP REST API
    try {
      var t0 = Date.now();
      var r1 = await apiGet(origin + '/wp-json/wp/v2/product', { per_page: 1 });
      var ms1 = Date.now() - t0;
      if (r1.status === 200) results.push(pass('WP REST API: ' + ms1 + 'ms'));
      else results.push(fail('WP REST API: HTTP ' + r1.status));
    } catch (e) { results.push(fail('WP REST API: ' + e.message)); }

    // Store API (in-stock)
    try {
      var t1 = Date.now();
      var r2 = await apiGet(origin + '/wp-json/wc/store/v1/products', { per_page: 1 });
      var ms2 = Date.now() - t1;
      if (r2.status === 200) results.push(pass('Store API: ' + ms2 + 'ms'));
      else results.push(fail('Store API: HTTP ' + r2.status));
    } catch (e) { results.push(fail('Store API: ' + e.message)); }

    // Store API (OOS filter)
    try {
      var t2 = Date.now();
      var r3 = await apiGet(origin + '/wp-json/wc/store/v1/products', { per_page: 1, stock_status: 'outofstock' });
      var ms3 = Date.now() - t2;
      if (r3.status === 200) results.push(pass('Store API OOS filter: ' + ms3 + 'ms'));
      else results.push(warn('Store API OOS filter: HTTP ' + r3.status));
    } catch (e) { results.push(warn('Store API OOS filter: ' + e.message)); }

  } else if (site.adapterType === 'shopify') {
    try {
      var t3 = Date.now();
      var r4 = await apiGet(origin + '/products.json', { limit: 1 });
      var ms4 = Date.now() - t3;
      if (r4.status === 200) results.push(pass('/products.json: ' + ms4 + 'ms'));
      else results.push(fail('/products.json: HTTP ' + r4.status));
    } catch (e) { results.push(fail('/products.json: ' + e.message)); }

    try {
      var t4 = Date.now();
      var r5 = await apiGet(origin + '/search/suggest.json', { q: 'test', 'resources[type]': 'product', 'resources[limit]': 1 });
      var ms5 = Date.now() - t4;
      if (r5.status === 200) results.push(pass('/search/suggest.json: ' + ms5 + 'ms'));
      else results.push(warn('/search/suggest.json: HTTP ' + r5.status));
    } catch (e) { results.push(warn('/search/suggest.json: ' + e.message)); }

  } else {
    // Generic: just check homepage
    try {
      var t5 = Date.now();
      var r6 = await axios.get(origin, {
        headers: { 'User-Agent': UA },
        timeout: 15000,
        validateStatus: function(s) { return s < 500; },
      });
      var ms6 = Date.now() - t5;
      if (r6.status === 200) results.push(pass('Homepage: ' + ms6 + 'ms'));
      else results.push(warn('Homepage: HTTP ' + r6.status));
    } catch (e) { results.push(fail('Homepage: ' + e.message)); }
  }

  // Anti-block check: 3 User-Agents
  var uas = [UA, UA_ALT1, UA_ALT2];
  var uaLabels = ['Chrome/Win', 'Chrome/Mac', 'Firefox/Linux'];
  var blocked = 0;
  for (var i = 0; i < uas.length; i++) {
    try {
      var resp = await axios.get(origin, {
        headers: { 'User-Agent': uas[i], Accept: 'text/html' },
        timeout: 10000,
        validateStatus: function(s) { return true; },
      });
      if (resp.status === 403 || resp.status === 429) {
        results.push(warn('Anti-block: ' + uaLabels[i] + ' → HTTP ' + resp.status));
        blocked++;
      } else {
        // Check for CAPTCHA / Cloudflare in response body
        var body = typeof resp.data === 'string' ? resp.data.slice(0, 5000) : '';
        if (/captcha|challenge-platform|cf-browser-verification|please verify/i.test(body)) {
          results.push(warn('Anti-block: ' + uaLabels[i] + ' → CAPTCHA/challenge detected'));
          blocked++;
        }
      }
    } catch { blocked++; }
  }
  if (blocked === 0) results.push(pass('Anti-block: All 3 User-Agents accepted'));
  else if (blocked < 3) results.push(warn('Anti-block: ' + blocked + '/3 User-Agents blocked'));
  else results.push(fail('Anti-block: All User-Agents blocked'));

  // Rate limit burst: 5 rapid requests
  var rateLimited = 0;
  for (var j = 0; j < 5; j++) {
    try {
      var resp2 = await axios.get(origin, {
        headers: { 'User-Agent': UA, Accept: 'text/html' },
        timeout: 10000,
        validateStatus: function(s) { return true; },
      });
      if (resp2.status === 429) rateLimited++;
    } catch { /* ignore */ }
  }
  if (rateLimited > 0) results.push(warn('Rate limit: ' + rateLimited + '/5 rapid requests got 429'));
  else results.push(pass('Rate limit: No 429s on 5 rapid requests'));

  var hasFail = results.some(function(r) { return r.includes('FAIL'); });
  var hasWarn = results.some(function(r) { return r.includes('WARN'); });
  return { verdict: hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS', details: results };
}

// ── Test 7: Catalog Freshness ───────────────────────────────────────────────

async function testCatalogFreshness(site) {
  var results = [];
  var now = new Date();

  // Newest product lastSeen
  var newest = await prisma.productIndex.findFirst({
    where: { siteId: site.id, isActive: true },
    orderBy: { lastSeenAt: 'desc' },
    select: { lastSeenAt: true, title: true },
  });

  if (!newest) return { verdict: 'FAIL', details: [fail('No active products')] };

  var newestAge = (now - newest.lastSeenAt) / (1000 * 60 * 60); // hours
  if (newestAge < 24) results.push(pass('Newest product seen ' + Math.round(newestAge) + 'h ago'));
  else if (newestAge < 48) results.push(warn('Newest product seen ' + Math.round(newestAge) + 'h ago'));
  else results.push(fail('Newest product seen ' + Math.round(newestAge) + 'h ago'));

  // % products seen in last 7 days
  var sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  var activeTotal = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true } });
  var seenRecently = await prisma.productIndex.count({
    where: { siteId: site.id, isActive: true, lastSeenAt: { gte: sevenDaysAgo } },
  });
  var recentPct = pctNum(seenRecently, activeTotal);
  if (recentPct >= 80) results.push(pass('Seen in 7d: ' + seenRecently + '/' + activeTotal + ' (' + recentPct + '%)'));
  else if (recentPct >= 50) results.push(warn('Seen in 7d: ' + seenRecently + '/' + activeTotal + ' (' + recentPct + '%)'));
  else results.push(fail('Seen in 7d: ' + seenRecently + '/' + activeTotal + ' (' + recentPct + '%)'));

  // Tier completion from tierState
  var tierState = site.tierState || {};
  for (var tier = 1; tier <= 4; tier++) {
    var key = 'tier' + tier;
    var ts = tierState[key];
    if (ts && ts.lastCompletedAt) {
      var age = (now - new Date(ts.lastCompletedAt)) / (1000 * 60 * 60);
      var maxAge = tier === 1 ? 6 : tier === 2 ? 12 : tier === 3 ? 24 : 48;
      var warnAge = tier === 1 ? 12 : tier === 2 ? 24 : tier === 3 ? 48 : 96;
      var msg = 'Tier ' + tier + ' last completed ' + Math.round(age) + 'h ago';
      if (age < maxAge) results.push(pass(msg));
      else if (age < warnAge) results.push(warn(msg));
      else results.push(fail(msg));
    }
  }

  // New products discovered in last 7 days
  var newProducts = await prisma.productIndex.count({
    where: { siteId: site.id, firstSeenAt: { gte: sevenDaysAgo } },
  });
  if (newProducts > 0) results.push(pass(newProducts + ' new products discovered in last 7d'));
  else {
    var threeDaysAgo = new Date(now - 3 * 24 * 60 * 60 * 1000);
    var newIn3d = await prisma.productIndex.count({
      where: { siteId: site.id, firstSeenAt: { gte: threeDaysAgo } },
    });
    if (newIn3d > 0) results.push(pass(newIn3d + ' new products in last 3d'));
    else results.push(warn('No new products discovered in 7 days'));
  }

  // Last crawl event
  var lastEvent = await prisma.crawlEvent.findFirst({
    where: { siteId: site.id },
    orderBy: { crawledAt: 'desc' },
    select: { status: true, crawledAt: true, errorMessage: true },
  });
  if (lastEvent) {
    var eventAge = (now - lastEvent.crawledAt) / (1000 * 60 * 60);
    var eventMsg = 'Last crawl: ' + lastEvent.status + ' ' + Math.round(eventAge) + 'h ago';
    if (lastEvent.status === 'success' && eventAge < 6) results.push(pass(eventMsg));
    else if (lastEvent.status === 'success') results.push(warn(eventMsg));
    else results.push(fail(eventMsg + (lastEvent.errorMessage ? ' — ' + lastEvent.errorMessage.slice(0, 60) : '')));
  }

  var hasFail = results.some(function(r) { return r.includes('FAIL'); });
  var hasWarn = results.some(function(r) { return r.includes('WARN'); });
  return { verdict: hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS', details: results };
}

// ── Test 8: sourceId Coverage ────────────────────────────────────────────

async function testSourceIdCoverage(site) {
  var results = [];

  var total = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true } });
  var withSourceId = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true, sourceId: { not: null } } });
  var coverage = total === 0 ? 0 : Math.round(withSourceId / total * 100);

  if (total === 0) return { verdict: 'PASS', details: ['No active products to check'] };

  var sourceIdAdapters = ['shopify', 'woocommerce', 'classifieds-gunpost', 'auction-icollector', 'auction-hibid', 'forum-xenforo'];
  var shouldHaveSourceId = sourceIdAdapters.includes(site.adapterType);
  var isGenericRetail = site.adapterType === 'generic-retail';

  results.push('sourceId: ' + withSourceId + '/' + total + ' active products (' + coverage + '%)');

  if (shouldHaveSourceId) {
    if (coverage < 50) results.push(fail(coverage + '% coverage — ' + site.adapterType + ' should have near 100%'));
    else if (coverage < 90) results.push(warn(coverage + '% coverage — expected >90% for ' + site.adapterType));
    else results.push(pass(coverage + '% coverage (' + site.adapterType + ')'));
  } else if (isGenericRetail) {
    if (coverage > 0) results.push(pass(coverage + '% coverage (generic-retail — some sources support it)'));
    else results.push(pass('No sourceId expected for generic-retail (may not support it)'));
  } else {
    results.push(pass('No sourceId expected for ' + site.adapterType + ' adapter'));
  }

  var hasFail = results.some(function(r) { return r.includes('FAIL'); });
  var hasWarn = results.some(function(r) { return r.includes('WARN'); });
  return { verdict: hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS', details: results };
}

// ── Test 9: Match Freshness ─────────────────────────────────────────────

async function testMatchFreshness(site) {
  var results = [];

  // Sample up to 20 matches for this site (Search has websiteUrl, not siteId)
  var matches = await prisma.match.findMany({
    where: {
      search: { websiteUrl: { contains: site.domain } },
    },
    select: { id: true, title: true, price: true, url: true },
    orderBy: { foundAt: 'desc' },
    take: 20,
  });

  if (matches.length === 0) return { verdict: 'PASS', details: ['No matches to check'] };

  var staleCount = 0;
  var checkedCount = 0;
  var staleExamples = [];

  for (var i = 0; i < matches.length; i++) {
    var m = matches[i];
    var product = await prisma.productIndex.findFirst({
      where: { siteId: site.id, url: m.url },
      select: { title: true, price: true },
    });

    if (!product) continue; // Product not in index (might be removed)
    checkedCount++;

    var titleDiffers = product.title && m.title && product.title !== m.title;
    var priceDiffers = product.price !== null && m.price !== null && product.price !== m.price;

    if (titleDiffers || priceDiffers) {
      staleCount++;
      if (staleExamples.length < 3) {
        var diff = [];
        if (titleDiffers) diff.push('title: "' + m.title.slice(0, 40) + '" vs "' + product.title.slice(0, 40) + '"');
        if (priceDiffers) diff.push('price: $' + m.price + ' vs $' + product.price);
        staleExamples.push(diff.join(', '));
      }
    }
  }

  if (checkedCount === 0) return { verdict: 'PASS', details: ['No matches found in ProductIndex for comparison'] };

  var stalePct = Math.round(staleCount / checkedCount * 100);
  results.push('Checked ' + checkedCount + ' matches against ProductIndex: ' + staleCount + ' stale (' + stalePct + '%)');

  if (stalePct > 50) {
    results.push(fail(stalePct + '% of matches have stale data vs ProductIndex'));
  } else if (stalePct > 30) {
    results.push(warn(stalePct + '% of matches have stale data vs ProductIndex'));
  } else if (staleCount > 0) {
    results.push(pass(stalePct + '% stale — within acceptable range'));
  } else {
    results.push(pass('All match data matches ProductIndex'));
  }

  for (var j = 0; j < staleExamples.length; j++) {
    results.push('  Stale: ' + staleExamples[j]);
  }

  var hasFail = results.some(function(r) { return r.includes('FAIL'); });
  var hasWarn = results.some(function(r) { return r.includes('WARN'); });
  return { verdict: hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS', details: results };
}

// ── Test Runner ─────────────────────────────────────────────────────────────

var ALL_TESTS = [
  { name: 'Schema Validation', fn: testSchemaValidation },
  { name: 'Data Quality Scoring', fn: testDataQuality },
  { name: 'Keyword Search Comparison', fn: testKeywordSearch },
  { name: 'Stock Accuracy', fn: testStockAccuracy },
  { name: 'Thumbnail Validation', fn: testThumbnails },
  { name: 'API Health Check', fn: testApiHealth },
  { name: 'Catalog Freshness', fn: testCatalogFreshness },
  { name: 'sourceId Coverage', fn: testSourceIdCoverage },
  { name: 'Match Freshness', fn: testMatchFreshness },
];

async function runSite(site, testsToRun, opts) {
  var totalProducts = await prisma.productIndex.count({ where: { siteId: site.id } });
  var activeProducts = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true } });

  console.log('\n' + C.bold + '═'.repeat(60) + C.reset);
  var mode = opts && opts.quick ? 'QUICK' : 'FULL';
  console.log(C.bold + '  SITE VERIFICATION (' + mode + '): ' + site.domain + C.reset);
  console.log(C.dim + '  Adapter: ' + site.adapterType + ' | Products: ' + totalProducts + ' | Active: ' + activeProducts + C.reset);
  console.log(C.bold + '═'.repeat(60) + C.reset);

  var verdicts = { PASS: 0, WARN: 0, FAIL: 0 };
  var jsonResults = {};

  for (var i = 0; i < testsToRun.length; i++) {
    var test = testsToRun[i];
    var label = '[' + (i + 1) + '/' + testsToRun.length + '] ' + test.name;

    try {
      var result = await test.fn(site, opts);
      var verdictColor = result.verdict === 'PASS' ? C.green : result.verdict === 'WARN' ? C.yellow : C.red;
      console.log('\n' + C.bold + label + C.reset + ' ' + '.'.repeat(Math.max(1, 45 - label.length)) + ' ' + verdictColor + result.verdict + C.reset);

      for (var j = 0; j < (result.details || []).length; j++) {
        console.log('  ' + result.details[j]);
      }

      verdicts[result.verdict]++;
      jsonResults[test.name] = { verdict: result.verdict, details: result.details };
    } catch (err) {
      console.log('\n' + C.bold + label + C.reset + ' ' + '.'.repeat(Math.max(1, 45 - label.length)) + ' ' + C.red + 'ERROR' + C.reset);
      console.log('  ' + err.message);
      verdicts.FAIL++;
      jsonResults[test.name] = { verdict: 'ERROR', error: err.message };
    }
  }

  // Summary
  console.log('\n' + C.dim + '─'.repeat(60) + C.reset);
  console.log('  OVERALL: ' + C.green + verdicts.PASS + ' PASS' + C.reset +
    ' | ' + C.yellow + verdicts.WARN + ' WARN' + C.reset +
    ' | ' + C.red + verdicts.FAIL + ' FAIL' + C.reset);
  console.log(C.dim + '─'.repeat(60) + C.reset);

  return { domain: site.domain, verdicts: verdicts, tests: jsonResults };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  var args = process.argv.slice(2);
  var domain = null;
  var runAll = false;
  var quick = false;
  var testNum = null;
  var jsonOutput = false;

  for (var i = 0; i < args.length; i++) {
    if (args[i] === '--all') runAll = true;
    else if (args[i] === '--quick') quick = true;
    else if (args[i] === '--json') jsonOutput = true;
    else if (args[i] === '--test' && args[i + 1]) { testNum = parseInt(args[++i], 10); }
    else if (!args[i].startsWith('-')) domain = args[i];
  }

  if (!domain && !runAll) {
    console.log('Usage: node verify-site.js <domain> [--quick] [--test N] [--json]');
    console.log('       node verify-site.js --all [--quick] [--test N] [--json]');
    process.exit(1);
  }

  var where = { isEnabled: true };
  if (domain) where.domain = { contains: domain };

  var sites = await prisma.monitoredSite.findMany({ where: where, orderBy: { domain: 'asc' } });
  if (sites.length === 0) {
    console.log(domain ? 'Site "' + domain + '" not found or not enabled' : 'No enabled sites');
    process.exit(1);
  }

  // Select tests — quick mode still runs all 9 tests but with fewer keywords
  var testsToRun = ALL_TESTS;
  if (testNum) testsToRun = ALL_TESTS[testNum - 1] ? [ALL_TESTS[testNum - 1]] : ALL_TESTS;

  var opts = { quick: quick };

  var allResults = [];
  for (var j = 0; j < sites.length; j++) {
    var result = await runSite(sites[j], testsToRun, opts);
    allResults.push(result);
  }

  // Multi-site summary
  if (sites.length > 1) {
    console.log('\n' + C.bold + '═'.repeat(60) + C.reset);
    console.log(C.bold + '  SUMMARY: ' + sites.length + ' SITES' + C.reset);
    console.log(C.bold + '═'.repeat(60) + C.reset);
    for (var k = 0; k < allResults.length; k++) {
      var r = allResults[k];
      var overall = r.verdicts.FAIL > 0 ? C.red + 'FAIL' : r.verdicts.WARN > 0 ? C.yellow + 'WARN' : C.green + 'PASS';
      console.log('  ' + r.domain.padEnd(35) + overall + C.reset +
        ' (' + r.verdicts.PASS + '/' + r.verdicts.WARN + '/' + r.verdicts.FAIL + ')');
    }
  }

  if (jsonOutput) {
    console.log('\n--- JSON ---');
    console.log(JSON.stringify(allResults, null, 2));
  }

  await prisma.$disconnect();
}

main().catch(function(err) { console.error(err); process.exit(1); });
