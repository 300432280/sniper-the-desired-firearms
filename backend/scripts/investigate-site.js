/**
 * Site Investigation & Verification Script v3 (merged)
 *
 * Comprehensive daily health check for each monitored site.
 * Merges all probes from investigate-site.js (14 probes) and verify-site.js (9 tests).
 *
 * 18 probes across 4 categories:
 *   Category A (DB State):
 *     A1 Stream State Health — tier partitioning, stuck/expired cooldowns
 *     A2 Crawl Event Pattern — success rate, phantom analysis, response time, error clustering
 *     A3 Product Index Health — counts, freshness distribution, price/stock/thumbnail rates
 *     A4 Watermark State — watermark URL validity, product age, schedule
 *     A5 sourceId Coverage — per-adapter expected coverage
 *     A6 Schema Validation — URL format, title/price/stock/tag validity, duplicate URLs, date consistency
 *     A7 Data Quality Scoring — price/tags/thumbnail/stock/productType completeness percentages
 *     A8 Match Freshness — Match table vs ProductIndex title/price divergence
 *     A9 Duplicate Detection — sourceId duplicates via raw SQL
 *
 *   Category B (Live Site):
 *     B1 Platform Detection — WP/Shopify/BigCommerce API probes + HTML signatures + WAF detection
 *     B2 API Health Check — endpoint availability + anti-bot UA rotation + rate limit burst
 *     B3 Pagination Discovery — HTML pagination detection vs stored totalPages
 *
 *   Category C (End-to-End Simulation):
 *     C1 Keyword Search Comparison — DB vs live site (52 keywords, alias-expanded, API/HTML)
 *     C2 Stock Accuracy Spot-Check — DB vs live WooCommerce/Shopify stock status
 *     C3 Data Accuracy — 15 product sample, 9 issue types + live page comparison
 *     C4 Product Spot-Check — 5 random URLs, fetch + title match
 *     C5 Thumbnail Validation — coverage + HEAD on 30 samples + placeholder + HTTPS check
 *
 *   Category D (Coverage):
 *     D1 DB Count vs Live Site Count — compare our product count against live site total
 *
 * Usage:
 *   node scripts/investigate-site.js <domain>              # full investigation (all probes)
 *   node scripts/investigate-site.js --all                  # all enabled sites
 *   node scripts/investigate-site.js <domain> --quick       # quick mode (12 keywords instead of 52)
 *   node scripts/investigate-site.js <domain> --db-only     # Category A only (fast, no HTTP)
 *   node scripts/investigate-site.js <domain> --probe A1    # specific probe only
 *   node scripts/investigate-site.js <domain> --json        # JSON output
 */

require('dotenv').config();
require('ts-node').register({ transpileOnly: true, project: require('path').join(__dirname, '..', 'tsconfig.json') });
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');

const prisma = new PrismaClient();

// ── Colors ──────────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  cyan: '\x1b[36m', white: '\x1b[37m', magenta: '\x1b[35m',
};

function pass(msg) { return `${C.green}PASS${C.reset} ${msg}`; }
function warn(msg) { return `${C.yellow}WARN${C.reset} ${msg}`; }
function fail(msg) { return `${C.red}FAIL${C.reset} ${msg}`; }
function info(msg) { return `${C.cyan}INFO${C.reset} ${msg}`; }

function pct(n, total) { return total === 0 ? '0%' : Math.round(n / total * 100) + '%'; }
/** Decode common HTML entities so DB text matches page text */
function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&#8211;/g, '–').replace(/&#8212;/g, '—').replace(/&#8217;/g, '\u2019')
    .replace(/&#8220;/g, '\u201C').replace(/&#8221;/g, '\u201D')
    .replace(/&#038;/g, '&').replace(/&#8243;/g, '\u2033').replace(/&#8242;/g, '\u2032')
    .replace(/&#(\d+);/g, function(_, n) { return String.fromCharCode(parseInt(n, 10)); })
    .replace(/&#x([0-9a-fA-F]+);/g, function(_, h) { return String.fromCharCode(parseInt(h, 16)); });
}
function pctNum(n, total) { return total === 0 ? 0 : Math.round(n / total * 100); }
function ago(date) {
  if (!date) return 'never';
  var ms = Date.now() - new Date(date).getTime();
  if (ms < 60000) return Math.round(ms / 1000) + 's ago';
  if (ms < 3600000) return Math.round(ms / 60000) + 'm ago';
  if (ms < 86400000) return Math.round(ms / 3600000) + 'h ago';
  return Math.round(ms / 86400000) + 'd ago';
}

function makeIssue(code, description, evidence, severity, fixable, suggestedFix) {
  return { code, description, evidence, severity: severity || 'medium', fixable: fixable !== false, suggestedFix: suggestedFix || null };
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

async function safeFetch(url, timeout) {
  try {
    var resp = await axios.get(url, {
      headers: { 'User-Agent': UA },
      timeout: timeout || 10000,
      maxRedirects: 5,
      validateStatus: function() { return true; },
    });
    return { status: resp.status, data: typeof resp.data === 'string' ? resp.data : '', headers: resp.headers };
  } catch (err) {
    return { status: 0, data: '', error: err.message };
  }
}

async function safeHeadImage(url) {
  if (!url) return { ok: false, reason: 'null' };
  try {
    var resp = await axios.head(url, {
      headers: { 'User-Agent': UA },
      timeout: 10000, maxRedirects: 5,
      validateStatus: function() { return true; },
    });
    var ct = (resp.headers['content-type'] || '').toLowerCase();
    if (resp.status === 200 && ct.startsWith('image/')) return { ok: true };
    if (resp.status !== 200) return { ok: false, reason: 'HTTP ' + resp.status };
    return { ok: false, reason: 'content-type: ' + ct };
  } catch (err) { return { ok: false, reason: err.message.substring(0, 80) }; }
}

async function safeHeadUrl(url) {
  if (!url) return { ok: false, reason: 'null' };
  try {
    var resp = await axios.head(url, {
      headers: { 'User-Agent': UA },
      timeout: 10000, maxRedirects: 5,
      validateStatus: function() { return true; },
    });
    if (resp.status >= 200 && resp.status < 400) return { ok: true, status: resp.status };
    if (resp.status === 403) return { ok: true, status: resp.status }; // WAF
    if (resp.status === 405) {
      var getResp = await axios.get(url, {
        headers: { 'User-Agent': UA }, timeout: 10000, maxRedirects: 5,
        validateStatus: function() { return true; },
      });
      if (getResp.status >= 200 && getResp.status < 400) return { ok: true, status: getResp.status };
      return { ok: false, reason: 'HTTP ' + getResp.status };
    }
    if (resp.status === 404) return { ok: false, reason: 'HTTP 404' };
    return { ok: false, reason: 'HTTP ' + resp.status };
  } catch (err) { return { ok: false, reason: err.message.substring(0, 80) }; }
}

async function delay(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

// ── WAF-aware infrastructure (uses app's Playwright fetcher + cookie manager) ──
var _playwrightFetcher = null;
var _wafCookieManager = null;

function getPlaywrightFetcher() {
  if (!_playwrightFetcher) _playwrightFetcher = require('../src/services/scraper/playwright-fetcher');
  return _playwrightFetcher;
}
function getWafCookieManager() {
  if (!_wafCookieManager) _wafCookieManager = require('../src/services/scraper/waf-cookie-manager');
  return _wafCookieManager;
}

/** WAF-aware page fetch. Uses Playwright for WAF sites, plain HTTP otherwise. */
async function wafFetch(url, site, timeout) {
  if (site && site.hasWaf) {
    try {
      var pw = getPlaywrightFetcher();
      var result = await pw.fetchWithPlaywright(url, { timeout: timeout || 30000 });
      return { status: 200, data: result.html, headers: {}, wafBypassed: true };
    } catch (err) {
      return { status: 0, data: '', error: 'Playwright: ' + err.message };
    }
  }
  return safeFetch(url, timeout);
}

/** WAF-aware API GET. Uses WAF cookies for WooCommerce sites behind Sucuri. */
async function wafApiGet(url, params, site, timeout) {
  if (site && site.hasWaf && site.adapterType === 'woocommerce') {
    try {
      var origin = site.url.replace(/\/$/, '');
      var domain = new URL(origin).hostname;
      var wcm = getWafCookieManager();
      var creds = await wcm.ensureCookies(domain, origin);
      return await axios.get(url, {
        params: params || {},
        headers: { 'User-Agent': creds.userAgent, Cookie: creds.cookies, Accept: 'application/json' },
        timeout: timeout || 15000,
        validateStatus: function(s) { return s < 500; },
      });
    } catch (err) { return apiGet(url, params, timeout); }
  }
  return apiGet(url, params, timeout);
}

/** WAF-aware URL liveness check. Uses Playwright for WAF sites. */
async function wafHeadUrl(url, site) {
  if (site && site.hasWaf) {
    try {
      var pw = getPlaywrightFetcher();
      var result = await pw.fetchWithPlaywright(url, { timeout: 20000 });
      var h1Match = result.html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
      var h1Text = h1Match ? h1Match[1].replace(/<[^>]+>/g, '').trim().toLowerCase() : '';
      if (h1Text.includes('not found') || h1Text === '404') return { ok: false, reason: 'HTTP 404' };
      if (result.html.length < 1000) return { ok: false, reason: 'Empty page' };
      return { ok: true, status: 200 };
    } catch (err) { return { ok: false, reason: 'Playwright: ' + err.message.substring(0, 60) }; }
  }
  return safeHeadUrl(url);
}

// ── Test Keywords ───────────────────────────────────────────────────────────
// Quick: 12 representative keywords. Full: 52 keywords across every category.

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
  // Calibers
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
  // Edge cases (from plan's 30-keyword patterns)
  { keyword: 'mauser 270 win bolt action', category: 'Multi-attribute' },
  { keyword: 'norinco type 97', category: 'Foreign brand' },
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

// ── Search URL builder ──────────────────────────────────────────────────────
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
var PRODUCT_URL_RE = /href=["'](https?:\/\/[^"']*\/(?:product|products|shop|item|p|listing|lot|ads|ad|classified)s?\/[^"'#?]+)/gi;
var RELATIVE_PRODUCT_RE = /href=["'](\/(?:product|products|shop|item|p|listing|lot|ads|ad|classified)s?\/[^"'#?]+)/gi;

function extractProductUrls(html, origin) {
  var urls = new Set();
  var siteDomain = new URL(origin).hostname.replace('www.', '');
  var match;
  while ((match = PRODUCT_URL_RE.exec(html)) !== null) {
    try {
      var u = new URL(match[1]);
      if (u.hostname.replace('www.', '').includes(siteDomain)) {
        urls.add(u.origin + u.pathname.replace(/\/$/, ''));
      }
    } catch { /* skip */ }
  }
  while ((match = RELATIVE_PRODUCT_RE.exec(html)) !== null) {
    urls.add(origin + match[1].replace(/\/$/, ''));
  }
  PRODUCT_URL_RE.lastIndex = 0;
  RELATIVE_PRODUCT_RE.lastIndex = 0;
  return Array.from(urls);
}


// ═══════════════════════════════════════════════════════════════════════════
// CATEGORY A: DB STATE ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════

// ── A1: Stream State Health ───────────────────────────────────────────────
async function probeA1_StreamState(site) {
  var results = [];
  var issues = [];
  var ss = site.streamState;

  if (!ss || !ss.streams || ss.streams.length === 0) {
    issues.push(makeIssue('NO_STREAM_STATE', 'No stream state — site never had a successful catalog crawl or streams not initialized', null, 'high'));
    return { probe: 'A1-stream-state', verdict: 'FAIL', issues, details: [fail('No stream state')] };
  }

  results.push(info(`${ss.streams.length} stream(s): ${ss.streams.map(s => `${s.id}(${s.type})`).join(', ')}`));

  if (!ss.tiers || Object.keys(ss.tiers).length === 0) {
    issues.push(makeIssue('NO_TIER_STATE', 'Stream state has streams but no tier entries', null, 'high'));
    return { probe: 'A1-stream-state', verdict: 'FAIL', issues, details: [...results, fail('No tier state')] };
  }

  var now = Date.now();
  var allHtmlPage1 = true;
  var hasHtmlStreams = ss.streams.some(s => s.type === 'html');
  var stuckCount = 0;
  var expiredCooldowns = 0;

  var streamTypeMap = {};
  ss.streams.forEach(s => { streamTypeMap[s.id] = s.type; });

  for (var key of Object.keys(ss.tiers)) {
    var ts = ss.tiers[key];
    var streamId = key.split(':')[0];
    var streamType = streamTypeMap[streamId] || 'html';

    if (streamType === 'html') {
      if (ts.pageRangeEnd != null || ts.pageRangeStart !== 1) allHtmlPage1 = false;
    }

    if (ts.status === 'in_progress' && ts.cycleStartedAt) {
      var stuckMs = now - new Date(ts.cycleStartedAt).getTime();
      if (stuckMs > 15 * 60 * 1000) {
        stuckCount++;
        issues.push(makeIssue('TIER_STUCK_IN_PROGRESS',
          `${key} stuck in in_progress for ${Math.round(stuckMs / 60000)}min`,
          { key, status: ts.status, cycleStartedAt: ts.cycleStartedAt },
          'high', true, 'Reset tier status to idle'));
      }
    }

    if (ts.status === 'cooldown' && ts.cooldownEndsAt) {
      if (new Date(ts.cooldownEndsAt).getTime() < now) {
        expiredCooldowns++;
        issues.push(makeIssue('COOLDOWN_EXPIRED',
          `${key} cooldown expired ${ago(ts.cooldownEndsAt)} but not reset`,
          { key, cooldownEndsAt: ts.cooldownEndsAt },
          'medium', true, 'Reset tier status to idle'));
      }
    }

    var range = ts.pageRangeEnd ? `[${ts.pageRangeStart}-${ts.pageRangeEnd}]` : `[${ts.pageRangeStart}+]`;
    results.push(info(`  ${key}: ${ts.status} page=${ts.currentPage} range=${range} refreshed=${ago(ts.lastRefreshedAt)}`));
  }

  // API vs HTML check
  for (var stream of ss.streams) {
    if (stream.type === 'api') {
      for (var tier of [2, 3, 4]) {
        var tk = `${stream.id}:${tier}`;
        var t = ss.tiers[tk];
        if (t && !t.dateRangeStart && !t.dateRangeEnd && t.pageRangeEnd) {
          issues.push(makeIssue('API_STREAM_HAS_PAGE_RANGES',
            `API stream ${tk} has page ranges instead of date ranges`,
            { key: tk, type: stream.type }, 'medium'));
        }
      }
    }
  }

  if (hasHtmlStreams && allHtmlPage1 && Object.keys(ss.tiers).length >= 3) {
    issues.push(makeIssue('TIERS_NOT_PARTITIONED',
      'All HTML tiers pageRangeStart=1 with no end — triplicating work',
      { tierCount: Object.keys(ss.tiers).length },
      'high', true, 'Need totalPages discovery to partition ranges'));
    results.push(fail('All HTML tiers crawling same range [1+]'));
  } else if (!hasHtmlStreams) {
    results.push(pass('API-only streams — page ranges N/A'));
  } else {
    results.push(pass('HTML tiers have distinct page ranges'));
  }

  if (stuckCount > 0) results.push(fail(`${stuckCount} tier(s) stuck in in_progress`));
  if (expiredCooldowns > 0) results.push(warn(`${expiredCooldowns} expired cooldown(s)`));

  var streamsWithPages = ss.streams.filter(s => s.totalPages && s.totalPages > 0);
  results.push(info(`${streamsWithPages.length}/${ss.streams.length} streams have totalPages discovered`));

  var hasFail = issues.some(i => i.severity === 'high');
  var hasWarn = issues.some(i => i.severity === 'medium');
  return { probe: 'A1-stream-state', verdict: hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS', issues, details: results };
}

// ── A2: Crawl Event Pattern Analysis ──────────────────────────────────────
async function probeA2_CrawlEvents(site) {
  var results = [];
  var issues = [];

  var events = await prisma.crawlEvent.findMany({
    where: { siteId: site.id },
    orderBy: { crawledAt: 'desc' },
    take: 50,
    select: { status: true, matchesFound: true, responseTimeMs: true, errorMessage: true, crawledAt: true },
  });

  if (events.length === 0) {
    issues.push(makeIssue('NO_CRAWL_EVENTS', 'No crawl events — crawler may never have run', null, 'high'));
    return { probe: 'A2-crawl-events', verdict: 'FAIL', issues, details: [fail('No crawl events')] };
  }

  var total = events.length;
  var successes = events.filter(e => e.status === 'success').length;
  var failures = events.filter(e => e.status !== 'success').length;
  var phantoms = events.filter(e => e.status === 'success' && e.matchesFound === 0).length;
  var successRate = Math.round(successes / total * 100);

  results.push(info(`${total} events: ${successes} success, ${failures} fail (${successRate}%)`));
  results.push(info(`Last event: ${events[0].status} ${ago(events[0].crawledAt)} — ${events[0].matchesFound} products`));

  // Phantom analysis — only flag if ALL recent events have 0 products
  if (phantoms > 0) {
    var phantomRate = Math.round(phantoms / successes * 100);
    var recentWithProducts = events.slice(0, 10).filter(e => e.status === 'success' && e.matchesFound > 0).length;

    if (phantomRate === 100 && recentWithProducts === 0) {
      issues.push(makeIssue('WATERMARK_NEVER_FINDS_PRODUCTS',
        'All crawl events found 0 products — watermark may be stuck',
        { phantoms, successes }, 'high'));
      results.push(fail(`All ${successes} events found 0 products`));
    } else if (phantomRate > 80 && recentWithProducts === 0) {
      issues.push(makeIssue('WATERMARK_RARELY_FINDS_PRODUCTS',
        `${phantomRate}% found 0, none in last 10`,
        { phantoms, successes, phantomRate }, 'medium'));
      results.push(warn(`${phantomRate}% of crawls found 0 products`));
    } else {
      results.push(info(`${phantomRate}% watermark crawls found 0 new products (normal for low-turnover sites)`));
    }
  }

  // Success rate
  if (successRate < 50) {
    issues.push(makeIssue('LOW_SUCCESS_RATE', `${successRate}% success rate`, { successRate }, 'high'));
    results.push(fail(`Success rate: ${successRate}%`));
  } else if (successRate < 80) {
    issues.push(makeIssue('MODERATE_SUCCESS_RATE', `${successRate}% success rate`, { successRate }, 'medium'));
    results.push(warn(`Success rate: ${successRate}%`));
  } else {
    results.push(pass(`Success rate: ${successRate}%`));
  }

  // Response time trend
  var recentTimes = events.slice(0, 10).filter(e => e.responseTimeMs).map(e => e.responseTimeMs);
  var olderTimes = events.slice(-10).filter(e => e.responseTimeMs).map(e => e.responseTimeMs);
  if (recentTimes.length >= 3 && olderTimes.length >= 3) {
    var recentAvg = recentTimes.reduce((a, b) => a + b, 0) / recentTimes.length;
    var olderAvg = olderTimes.reduce((a, b) => a + b, 0) / olderTimes.length;
    results.push(info(`Response time: recent ${Math.round(recentAvg)}ms, older ${Math.round(olderAvg)}ms`));
    if (recentAvg > olderAvg * 2) {
      issues.push(makeIssue('RESPONSE_TIME_DEGRADING',
        `${Math.round(olderAvg)}ms → ${Math.round(recentAvg)}ms`,
        { recentAvg: Math.round(recentAvg), olderAvg: Math.round(olderAvg) }, 'medium'));
    }
  }

  // Error clustering
  var errorCounts = {};
  events.filter(e => e.errorMessage).forEach(e => {
    var key = (e.errorMessage || '').substring(0, 60);
    errorCounts[key] = (errorCounts[key] || 0) + 1;
  });
  var repeatingErrors = Object.entries(errorCounts).filter(([, count]) => count >= 3);
  for (var [msg, count] of repeatingErrors) {
    issues.push(makeIssue('REPEATING_ERROR', `Error repeated ${count}x: "${msg}"`, { error: msg, count }, 'medium'));
    results.push(warn(`Repeating error (${count}x): ${msg}`));
  }

  // Crawl gap
  if (events.length >= 2) {
    var gaps = [];
    for (var i = 0; i < events.length - 1; i++) {
      gaps.push(new Date(events[i].crawledAt).getTime() - new Date(events[i + 1].crawledAt).getTime());
    }
    var maxGapHrs = Math.round(Math.max(...gaps) / 3600000);
    if (maxGapHrs > 6) {
      issues.push(makeIssue('CRAWL_GAP', `Largest gap: ${maxGapHrs}h`, { maxGapHrs }, maxGapHrs > 24 ? 'high' : 'low'));
      results.push(maxGapHrs > 24 ? fail(`${maxGapHrs}h gap`) : warn(`${maxGapHrs}h gap`));
    }
  }

  var hasFail = issues.some(i => i.severity === 'high');
  var hasWarn = issues.some(i => i.severity === 'medium');
  return { probe: 'A2-crawl-events', verdict: hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS', issues, details: results };
}

// ── A3: Product Index Health ──────────────────────────────────────────────
async function probeA3_ProductIndex(site) {
  var results = [];
  var issues = [];

  var total = await prisma.productIndex.count({ where: { siteId: site.id } });
  var active = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true } });
  var inactive = total - active;

  if (total === 0) {
    issues.push(makeIssue('NO_PRODUCTS', 'Zero products indexed', null, 'high'));
    return { probe: 'A3-product-index', verdict: 'FAIL', issues, details: [fail('No products')] };
  }

  results.push(info(`${total} products (${active} active, ${inactive} inactive)`));

  // ── Estimate expected full crawl cycle time ──
  // Instead of hardcoded 7 days, compute from site's actual page count and budget.
  // A site with 1700 pages and 60 tokens/hr budget: ~1700 pages / (60/3 tokens per tier per hr) = 85 hours
  // We use 2x cycle time as the "freshness window" (at least one full pass should have happened).
  // Minimum 3 days, maximum 30 days, default 7 days if we can't estimate.
  var now = new Date();
  var ss = site.streamState;
  var totalPages = 0;
  var budget = site.baseBudget || 60;
  if (ss && ss.streams) {
    ss.streams.forEach(function(s) { totalPages += (s.totalPages || 0); });
  }
  // For API sites without totalPages, estimate from product count (assume ~100 products per page)
  if (totalPages === 0 && active > 0) {
    totalPages = Math.ceil(active / 100);
  }
  // Full cycle = totalPages / (budget/3) hours (3 tiers share budget)
  // Freshness window = 2x cycle time (tolerant — crawler may not run 24/7)
  var estCycleHrs = totalPages > 0 ? totalPages * 3 / budget : 0;
  var freshnessWindowDays = estCycleHrs > 0 ? Math.max(3, Math.min(30, Math.ceil(estCycleHrs * 2 / 24))) : 7;
  var freshnessMs = freshnessWindowDays * 24 * 3600000;
  var dWindow = new Date(now - freshnessMs);

  results.push(info(`Crawl cycle: ~${Math.round(estCycleHrs)}h (${totalPages} pages, ${budget} tokens/hr) → freshness window: ${freshnessWindowDays}d`));

  // ── Crawler Coverage Rate ──
  // This measures how well the crawler is keeping up with the catalog.
  // Low coverage means the crawler needs more budget or time, NOT that the products are bad.
  // Old listings are valid — they only become stale if confirmed 404 (see probe D2).
  var d1 = new Date(now - 24 * 3600000);
  var seen24h = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true, lastSeenAt: { gte: d1 } } });
  var seenInWindow = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true, lastSeenAt: { gte: dWindow } } });

  results.push(info(`Crawler coverage — 24h: ${seen24h}/${active} (${pct(seen24h, active)}) | ${freshnessWindowDays}d: ${seenInWindow}/${active} (${pct(seenInWindow, active)})`));

  if (seenInWindow < active * 0.5) {
    issues.push(makeIssue('LOW_CRAWLER_COVERAGE', `Crawler only reached ${pct(seenInWindow, active)} of products in ${freshnessWindowDays}d — may need higher budget`, { seenInWindow, active, windowDays: freshnessWindowDays, budget }, 'medium'));
    results.push(warn(`Crawler coverage low (${pct(seenInWindow, active)} in ${freshnessWindowDays}d) — consider increasing budget from ${budget}`));
  } else if (seenInWindow < active * 0.8) {
    results.push(warn(`Crawler coverage moderate (${pct(seenInWindow, active)} in ${freshnessWindowDays}d)`));
  } else {
    results.push(pass(`Crawler coverage good (${pct(seenInWindow, active)} in ${freshnessWindowDays}d)`));
  }

  // New product discovery
  var newInWindow = await prisma.productIndex.count({ where: { siteId: site.id, firstSeenAt: { gte: dWindow } } });
  results.push(info(`New products in ${freshnessWindowDays}d: ${newInWindow}`));

  // Coverage rates
  var noPrice = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true, price: null } });
  var noThumb = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true, thumbnail: null } });
  var pricePct = active > 0 ? Math.round((active - noPrice) / active * 100) : 0;
  var thumbPct = active > 0 ? Math.round((active - noThumb) / active * 100) : 0;

  results.push(info(`Price: ${pricePct}% | Thumbnail: ${thumbPct}%`));

  if (pricePct < 50) {
    issues.push(makeIssue('LOW_PRICE_COVERAGE', `${pricePct}% price coverage`, { pricePct }, 'high'));
  } else if (pricePct < 80) {
    issues.push(makeIssue('MODERATE_PRICE_COVERAGE', `${pricePct}% price coverage`, { pricePct }, 'medium'));
  }
  if (thumbPct < 50) {
    issues.push(makeIssue('LOW_THUMBNAIL_COVERAGE', `${thumbPct}% thumbnail coverage`, { thumbPct }, 'high'));
  }

  var hasFail = issues.some(i => i.severity === 'high');
  var hasWarn = issues.some(i => i.severity === 'medium');
  return { probe: 'A3-product-index', verdict: hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS', issues, details: results };
}

// ── A4: Watermark State ───────────────────────────────────────────────────
async function probeA4_Watermark(site) {
  var results = [];
  var issues = [];

  if (!site.lastWatermarkUrl) {
    issues.push(makeIssue('NO_WATERMARK', 'No watermark URL', null, 'high'));
    results.push(fail('No watermark URL'));
  } else {
    results.push(info(`Watermark: ${site.lastWatermarkUrl.substring(0, 80)}...`));
    var wmProduct = await prisma.productIndex.findFirst({
      where: { siteId: site.id, url: site.lastWatermarkUrl },
      select: { firstSeenAt: true, lastSeenAt: true, isActive: true, title: true },
    });
    if (!wmProduct) {
      issues.push(makeIssue('WATERMARK_PRODUCT_MISSING', 'Watermark URL not in ProductIndex', { url: site.lastWatermarkUrl }, 'medium'));
      results.push(warn('Watermark product not in index'));
    } else {
      var wmAge = Math.round((Date.now() - new Date(wmProduct.firstSeenAt).getTime()) / 86400000);
      results.push(info(`Watermark: "${wmProduct.title}" — ${wmAge}d old, active=${wmProduct.isActive}`));
      if (wmAge > 14) {
        issues.push(makeIssue('WATERMARK_OLD', `Watermark ${wmAge}d old`, { wmAge }, 'medium'));
      }
    }
  }

  results.push(info(`Last crawl: ${ago(site.lastCrawlAt)} | Next: ${site.nextCrawlAt ? ago(site.nextCrawlAt) : 'not scheduled'}`));

  var hasFail = issues.some(i => i.severity === 'high');
  var hasWarn = issues.some(i => i.severity === 'medium');
  return { probe: 'A4-watermark', verdict: hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS', issues, details: results };
}

// ── A5: sourceId Coverage ─────────────────────────────────────────────────
async function probeA5_SourceIdCoverage(site) {
  var results = [];
  var issues = [];

  var total = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true } });
  var withSourceId = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true, sourceId: { not: null } } });
  var coverage = total === 0 ? 0 : Math.round(withSourceId / total * 100);

  if (total === 0) return { probe: 'A5-sourceid', verdict: 'SKIP', issues, details: [info('No active products')] };

  var sourceIdAdapters = ['shopify', 'woocommerce', 'classifieds-gunpost', 'auction-icollector', 'auction-hibid', 'forum-xenforo'];
  var shouldHave = sourceIdAdapters.includes(site.adapterType);

  results.push(info(`sourceId: ${withSourceId}/${total} (${coverage}%)`));

  if (shouldHave) {
    if (coverage < 50) {
      issues.push(makeIssue('LOW_SOURCEID_COVERAGE', `${coverage}% — ${site.adapterType} should have near 100%`, { coverage }, 'high'));
      results.push(fail(`${coverage}% sourceId — expected near 100% for ${site.adapterType}`));
    } else if (coverage < 90) {
      issues.push(makeIssue('PARTIAL_SOURCEID_COVERAGE', `${coverage}% — expected >90%`, { coverage }, 'medium'));
      results.push(warn(`${coverage}% sourceId — expected >90% for ${site.adapterType}`));
    } else {
      results.push(pass(`${coverage}% sourceId (${site.adapterType})`));
    }
  } else if (site.adapterType === 'generic-retail') {
    results.push(coverage > 0 ? pass(`${coverage}% (generic-retail)`) : info('No sourceId (generic-retail — may not support)'));
  } else {
    results.push(coverage > 0 ? info(`${coverage}% (unexpected for ${site.adapterType})`) : pass(`No sourceId expected for ${site.adapterType}`));
  }

  var hasFail = issues.some(i => i.severity === 'high');
  var hasWarn = issues.some(i => i.severity === 'medium');
  return { probe: 'A5-sourceid', verdict: hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS', issues, details: results };
}

// ── A6: Schema Validation (from verify Test 1) ──────────────────────────
async function probeA6_SchemaValidation(site) {
  var results = [];
  var issues = [];

  var products = await prisma.productIndex.findMany({
    where: { siteId: site.id },
    select: { id: true, url: true, title: true, price: true, stockStatus: true, tags: true, firstSeenAt: true, lastSeenAt: true, isActive: true },
  });
  var total = products.length;
  if (total === 0) return { probe: 'A6-schema', verdict: 'FAIL', issues: [makeIssue('NO_PRODUCTS', 'No products', null, 'high')], details: [fail('No products')] };

  // URL validation
  var badUrls = 0, domainMismatch = 0;
  for (var i = 0; i < products.length; i++) {
    try {
      var u = new URL(products[i].url);
      if (!u.hostname.includes(site.domain.replace('www.', ''))) domainMismatch++;
    } catch { badUrls++; }
  }
  if (badUrls > 0) { results.push(fail(badUrls + ' invalid URLs')); issues.push(makeIssue('BAD_URLS', badUrls + ' invalid URLs', { badUrls }, 'high')); }
  else results.push(pass('All URLs valid'));
  if (domainMismatch > 0) results.push(warn(domainMismatch + ' URLs don\'t match domain'));

  // Title check
  var missingTitle = products.filter(p => !p.title || p.title.trim() === '').length;
  if (missingTitle > total * 0.01) { results.push(fail(missingTitle + ' missing titles')); issues.push(makeIssue('MISSING_TITLES', missingTitle + ' missing', { missingTitle }, 'high')); }
  else if (missingTitle > 0) results.push(warn(missingTitle + ' missing titles'));
  else results.push(pass('All have titles'));

  // Price range
  var badPrice = products.filter(p => p.price !== null && (p.price <= 0 || p.price > 99999)).length;
  if (badPrice > 0) results.push(warn(badPrice + ' prices outside $0.01-$99,999'));

  // Stock status
  var validStock = ['in_stock', 'out_of_stock', 'unknown', null];
  var badStock = products.filter(p => validStock.indexOf(p.stockStatus) === -1).length;
  if (badStock > 0) { results.push(fail(badStock + ' invalid stock status')); issues.push(makeIssue('BAD_STOCK', badStock + ' invalid', { badStock }, 'high')); }
  else results.push(pass('Stock statuses valid'));

  // Duplicate URLs
  var urlSet = new Set(), dupes = 0;
  for (var j = 0; j < products.length; j++) {
    if (urlSet.has(products[j].url)) dupes++;
    urlSet.add(products[j].url);
  }
  if (dupes > 0) { results.push(fail(dupes + ' duplicate URLs')); issues.push(makeIssue('DUPLICATE_URLS', dupes + ' duplicates', { dupes }, 'high')); }
  else results.push(pass('No duplicate URLs'));

  // Date consistency
  var badDates = products.filter(p => p.lastSeenAt < p.firstSeenAt).length;
  if (badDates > 0) results.push(fail(badDates + ' with lastSeen < firstSeen'));

  var hasFail = issues.some(i => i.severity === 'high');
  var hasWarn = issues.some(i => i.severity === 'medium');
  return { probe: 'A6-schema', verdict: hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS', issues, details: results };
}

// ── A7: Data Quality Scoring (from verify Test 2) ────────────────────────
async function probeA7_DataQuality(site) {
  var results = [];
  var issues = [];
  var total = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true } });
  if (total === 0) return { probe: 'A7-quality', verdict: 'FAIL', issues: [makeIssue('NO_PRODUCTS', 'No active products', null, 'high')], details: [fail('No active products')] };

  var withPrice = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true, price: { not: null } } });
  var withTags = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true, tags: { not: null } } });
  var withThumb = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true, thumbnail: { not: null } } });
  var withType = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true, productType: { not: null } } });
  var knownStock = await prisma.productIndex.count({
    where: { siteId: site.id, isActive: true, stockStatus: { in: ['in_stock', 'out_of_stock'] } },
  });

  function score(name, count, warnThresh, failThresh) {
    var p = pctNum(count, total);
    var msg = name + ': ' + count + '/' + total + ' (' + p + '%)';
    if (p >= warnThresh) results.push(pass(msg));
    else if (p >= failThresh) { results.push(warn(msg)); issues.push(makeIssue('LOW_' + name.toUpperCase().replace(/\s/g, '_'), msg, { pct: p }, 'medium')); }
    else { results.push(fail(msg)); issues.push(makeIssue('VERY_LOW_' + name.toUpperCase().replace(/\s/g, '_'), msg, { pct: p }, 'high')); }
  }

  score('Price', withPrice, 90, 50);
  score('Tags', withTags, 90, 50);
  score('Thumbnail', withThumb, 90, 70);
  score('Stock known', knownStock, 95, 80);
  score('ProductType', withType, 80, 50);

  // Stock breakdown
  var inStock = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true, stockStatus: 'in_stock' } });
  var oos = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true, stockStatus: 'out_of_stock' } });
  results.push(info(`Stock: ${inStock} in_stock, ${oos} out_of_stock, ${total - inStock - oos} unknown`));

  var withRegPrice = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true, regularPrice: { not: null } } });
  if (withRegPrice > 0) results.push(info(`Sale items (regularPrice): ${withRegPrice}`));

  var hasFail = issues.some(i => i.severity === 'high');
  var hasWarn = issues.some(i => i.severity === 'medium');
  return { probe: 'A7-quality', verdict: hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS', issues, details: results };
}

// ── A8: Match Freshness (from verify Test 9) ─────────────────────────────
async function probeA8_MatchFreshness(site) {
  var results = [];
  var issues = [];

  var matches = await prisma.match.findMany({
    where: { search: { websiteUrl: { contains: site.domain } } },
    select: { id: true, title: true, price: true, url: true },
    orderBy: { foundAt: 'desc' },
    take: 20,
  });

  if (matches.length === 0) return { probe: 'A8-match-freshness', verdict: 'PASS', issues, details: [info('No matches to check')] };

  var staleCount = 0, checkedCount = 0, staleExamples = [];
  for (var i = 0; i < matches.length; i++) {
    var m = matches[i];
    var product = await prisma.productIndex.findFirst({
      where: { siteId: site.id, url: m.url },
      select: { title: true, price: true },
    });
    if (!product) continue;
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

  if (checkedCount === 0) return { probe: 'A8-match-freshness', verdict: 'PASS', issues, details: [info('No matches in ProductIndex')] };

  var stalePct = Math.round(staleCount / checkedCount * 100);
  results.push(info(`Checked ${checkedCount} matches: ${staleCount} stale (${stalePct}%)`));

  if (stalePct > 50) {
    results.push(fail(`${stalePct}% stale`));
    issues.push(makeIssue('HIGH_MATCH_STALENESS', `${stalePct}% stale`, { stalePct }, 'high'));
  } else if (stalePct > 30) {
    results.push(warn(`${stalePct}% stale`));
    issues.push(makeIssue('MODERATE_MATCH_STALENESS', `${stalePct}% stale`, { stalePct }, 'medium'));
  } else if (staleCount > 0) {
    results.push(pass(`${stalePct}% stale — acceptable`));
  } else {
    results.push(pass('All matches current'));
  }

  for (var j = 0; j < staleExamples.length; j++) results.push(info(`  ${staleExamples[j]}`));

  var hasFail = issues.some(i => i.severity === 'high');
  var hasWarn = issues.some(i => i.severity === 'medium');
  return { probe: 'A8-match-freshness', verdict: hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS', issues, details: results };
}

// ── A9: Duplicate Detection ──────────────────────────────────────────────
async function probeA9_DuplicateDetection(site) {
  var results = [];
  var issues = [];

  var dupes = await prisma.$queryRaw`
    SELECT "sourceId", COUNT(*) as cnt
    FROM product_index
    WHERE "siteId" = ${site.id} AND "sourceId" IS NOT NULL AND "isActive" = true
    GROUP BY "sourceId"
    HAVING COUNT(*) > 1
    ORDER BY COUNT(*) DESC
    LIMIT 20
  `;

  if (dupes.length === 0) {
    results.push(pass('No duplicate sourceIds'));
    return { probe: 'A9-duplicates', verdict: 'PASS', issues, details: results };
  }

  var totalDupes = dupes.reduce(function(sum, d) { return sum + Number(d.cnt); }, 0);
  results.push(fail(`${dupes.length} sourceId(s) with duplicates (${totalDupes} total rows)`));

  for (var i = 0; i < Math.min(dupes.length, 5); i++) {
    results.push(info(`  sourceId="${dupes[i].sourceId}" → ${dupes[i].cnt} active products`));
  }

  issues.push(makeIssue('DUPLICATE_SOURCEIDS', `${dupes.length} duplicated sourceIds`, { duplicateCount: dupes.length, totalExtraRows: totalDupes }, 'high'));

  return { probe: 'A9-duplicates', verdict: 'FAIL', issues, details: results };
}


// ═══════════════════════════════════════════════════════════════════════════
// CATEGORY B: LIVE SITE BEHAVIOR
// ═══════════════════════════════════════════════════════════════════════════

// ── B1: Platform Detection + WAF ─────────────────────────────────────────
async function probeB1_PlatformDetect(site) {
  var results = [];
  var issues = [];
  var origin = site.url.replace(/\/$/, '');

  var wpResp = await safeFetch(origin + '/wp-json/wp/v2/product?per_page=1', 5000);
  await delay(300);
  var storeResp = await safeFetch(origin + '/wp-json/wc/store/v1/products?per_page=1', 5000);
  await delay(300);
  var shopifyResp = await safeFetch(origin + '/products.json?limit=1', 5000);
  await delay(300);
  var homeResp = await safeFetch(origin, 10000);

  var detected = null;
  var signals = [];

  if (wpResp.status === 200) { signals.push('WP REST API'); detected = 'woocommerce'; }
  if (storeResp.status === 200) { signals.push('WC Store API'); detected = 'woocommerce'; }
  if (shopifyResp.status === 200 && shopifyResp.data.includes('"products"')) { signals.push('Shopify products.json'); detected = 'shopify'; }

  var html = homeResp.data || '';
  if (html.includes('wp-content') || html.includes('woocommerce')) signals.push('WP/WooCommerce HTML');
  if (html.includes('cdn.shopify.com') || html.includes('Shopify.theme')) signals.push('Shopify HTML');
  if (html.includes('data-product-id')) signals.push('BigCommerce');
  if (html.includes('drupalSettings') || html.includes('Drupal')) signals.push('Drupal HTML');

  if (!detected && html.includes('wp-content')) detected = 'woocommerce';
  if (!detected && html.includes('cdn.shopify.com')) detected = 'shopify';

  results.push(info(`Adapter: ${site.adapterType} | Detected: ${detected || 'none'}`));
  results.push(info(`Signals: ${signals.length > 0 ? signals.join(', ') : 'none'}`));

  var specializedAdapters = ['classifieds-gunpost', 'forum-xenforo', 'forum-vbulletin', 'auction-hibid', 'auction-icollector', 'auction-generic'];
  if (detected && detected !== site.adapterType && !specializedAdapters.includes(site.adapterType)) {
    issues.push(makeIssue('WRONG_ADAPTER_TYPE', `Detected "${detected}" but using "${site.adapterType}"`, { detected, current: site.adapterType }, 'high'));
    results.push(fail(`Adapter mismatch: ${site.adapterType} vs detected ${detected}`));
  } else if (detected) {
    results.push(pass(`Adapter matches: ${detected}`));
  }

  // WAF detection
  if (html.includes('_Incapsula_Resource') && !site.hasWaf) {
    issues.push(makeIssue('UNDETECTED_WAF', 'Incapsula WAF but hasWaf=false', null, 'medium'));
  }
  if ((html.includes('cf-browser-verification') || html.includes('Just a moment')) && !site.hasWaf) {
    issues.push(makeIssue('UNDETECTED_WAF', 'Cloudflare challenge but hasWaf=false', null, 'medium'));
  }
  if (homeResp.status === 200 && homeResp.data.length < 2000) {
    issues.push(makeIssue('POSSIBLE_SILENT_BLOCK', `Homepage only ${homeResp.data.length} bytes`, { bodySize: homeResp.data.length }, 'medium'));
    results.push(warn(`Homepage ${homeResp.data.length} bytes — possible block`));
  }

  var hasFail = issues.some(i => i.severity === 'high');
  var hasWarn = issues.some(i => i.severity === 'medium');
  return { probe: 'B1-platform', verdict: hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS', issues, details: results };
}

// ── B2: API Health Check (from verify Test 6) ────────────────────────────
async function probeB2_ApiHealth(site) {
  var results = [];
  var issues = [];
  var origin = site.url.replace(/\/$/, '');

  if (site.adapterType === 'woocommerce') {
    try {
      var t0 = Date.now();
      var r1 = await wafApiGet(origin + '/wp-json/wp/v2/product', { per_page: 1 }, site);
      if (r1.status === 200) results.push(pass('WP REST API: ' + (Date.now() - t0) + 'ms' + (site.hasWaf ? ' (cookies)' : '')));
      else results.push(fail('WP REST API: HTTP ' + r1.status));
    } catch (e) { results.push(fail('WP REST API: ' + e.message)); }
    try {
      var t1 = Date.now();
      var r2 = await wafApiGet(origin + '/wp-json/wc/store/v1/products', { per_page: 1 }, site);
      if (r2.status === 200) results.push(pass('Store API: ' + (Date.now() - t1) + 'ms' + (site.hasWaf ? ' (cookies)' : '')));
      else results.push(fail('Store API: HTTP ' + r2.status));
    } catch (e) { results.push(fail('Store API: ' + e.message)); }
  } else if (site.adapterType === 'shopify') {
    try {
      var t2 = Date.now();
      var r3 = await apiGet(origin + '/products.json', { limit: 1 });
      if (r3.status === 200) results.push(pass('/products.json: ' + (Date.now() - t2) + 'ms'));
      else results.push(fail('/products.json: HTTP ' + r3.status));
    } catch (e) { results.push(fail('/products.json: ' + e.message)); }
  } else {
    try {
      var t3 = Date.now();
      var r4 = await wafFetch(origin, site, 15000);
      if (r4.status === 200 && r4.data.length > 1000) results.push(pass('Homepage: ' + (Date.now() - t3) + 'ms' + (r4.wafBypassed ? ' (Playwright)' : '')));
      else results.push(warn('Homepage: HTTP ' + r4.status));
    } catch (e) { results.push(fail('Homepage: ' + e.message)); }
  }

  // Anti-bot check
  var uas = [UA, UA_ALT1, UA_ALT2];
  var uaLabels = ['Chrome/Win', 'Chrome/Mac', 'Firefox/Linux'];
  var blocked = 0;
  for (var i = 0; i < uas.length; i++) {
    try {
      var resp = await axios.get(origin, {
        headers: { 'User-Agent': uas[i], Accept: 'text/html' },
        timeout: 10000, validateStatus: function() { return true; },
      });
      if (resp.status === 403 || resp.status === 429) blocked++;
      else {
        var body = typeof resp.data === 'string' ? resp.data.slice(0, 5000) : '';
        if (/captcha|challenge-platform|cf-browser-verification|please verify/i.test(body)) blocked++;
      }
    } catch { blocked++; }
  }
  if (blocked === 0) results.push(pass('Anti-bot: 3/3 UAs accepted'));
  else if (blocked < 3) results.push(warn(`Anti-bot: ${blocked}/3 blocked`));
  else { results.push(fail('Anti-bot: All blocked')); issues.push(makeIssue('ALL_UAS_BLOCKED', 'All UAs blocked', null, 'high')); }

  // Rate limit check (3 requests with 200ms gaps — NOT a burst)
  var rateLimited = 0;
  for (var j = 0; j < 3; j++) {
    try {
      var resp2 = await axios.get(origin, {
        headers: { 'User-Agent': UA }, timeout: 10000, validateStatus: function() { return true; },
      });
      if (resp2.status === 429) rateLimited++;
      await delay(200);
    } catch { /* ignore */ }
  }
  if (rateLimited > 0) results.push(warn(`Rate limit: ${rateLimited}/3 got 429`));
  else results.push(pass('No 429s on 3 requests'));

  var hasFail = issues.some(i => i.severity === 'high') || results.some(r => r.includes('FAIL'));
  var hasWarn = issues.some(i => i.severity === 'medium') || results.some(r => r.includes('WARN'));
  return { probe: 'B2-api-health', verdict: hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS', issues, details: results };
}

// ── B3: Pagination Discovery ─────────────────────────────────────────────
async function probeB3_Pagination(site) {
  var results = [];
  var issues = [];
  var ss = site.streamState;

  if (!ss || !ss.streams || ss.streams.length === 0) {
    return { probe: 'B3-pagination', verdict: 'SKIP', issues, details: [info('No streams')] };
  }

  var htmlStreams = ss.streams.filter(s => s.type === 'html');
  if (htmlStreams.length === 0) {
    return { probe: 'B3-pagination', verdict: 'PASS', issues, details: [info('No HTML streams — API only')] };
  }

  var toCheck = htmlStreams.slice(0, 3);
  for (var stream of toCheck) {
    await delay(500);
    var resp = await wafFetch(stream.url, site, 10000);
    if (resp.status !== 200 || resp.data.length < 500) {
      results.push(warn(`${stream.id}: HTTP ${resp.status}, ${resp.data.length} bytes`));
      continue;
    }
    var pageLinks = [];
    var pageRegex = /[?&]page=(\d+)|\/page\/(\d+)/gi;
    var match;
    while ((match = pageRegex.exec(resp.data)) !== null) {
      var num = parseInt(match[1] || match[2], 10);
      if (num > 0 && num < 100000) pageLinks.push(num);
    }
    var maxPage = pageLinks.length > 0 ? Math.max(...pageLinks) : 0;
    var storedPages = stream.totalPages || 0;

    if (maxPage > 0) {
      results.push(info(`${stream.id}: ${maxPage} pages (stored: ${storedPages || 'none'})`));
      if (storedPages === 0) {
        issues.push(makeIssue('TOTAL_PAGES_NOT_STORED', `"${stream.id}" has ${maxPage} pages but not stored`, { streamId: stream.id, detectedPages: maxPage }, 'medium'));
      }
    } else {
      results.push(info(`${stream.id}: No pagination detected`));
    }
  }

  var hasFail = issues.some(i => i.severity === 'high');
  var hasWarn = issues.some(i => i.severity === 'medium');
  return { probe: 'B3-pagination', verdict: hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS', issues, details: results };
}


// ═══════════════════════════════════════════════════════════════════════════
// CATEGORY C: END-TO-END SIMULATION
// ═══════════════════════════════════════════════════════════════════════════

// ── C1: Keyword Search Comparison (from verify Test 3 — alias-expanded, DB vs live) ──
async function probeC1_KeywordSearch(site, opts) {
  var results = [];
  var issues = [];
  var origin = site.url.replace(/\/$/, '');
  var totalKeywords = 0, matchedKeywords = 0, missingOnSite = 0;
  var totalDbResults = 0, totalLiveResults = 0;

  var isQuick = opts && opts.quick;
  var keywords = isQuick ? QUICK_KEYWORDS : FULL_KEYWORDS;
  results.push(info(`Mode: ${isQuick ? 'QUICK (12)' : 'FULL (' + keywords.length + ')'} keywords`));

  var useApi = (site.adapterType === 'woocommerce' || site.adapterType === 'shopify');
  results.push(info(`Search: ${useApi ? 'API' : 'HTML'} (${site.adapterType})`));

  for (var i = 0; i < keywords.length; i++) {
    var kw = keywords[i];
    totalKeywords++;

    var dbResults = await searchProductIndex(kw.keyword, site.id);
    var liveResults = [];

    try {
      if (site.adapterType === 'woocommerce') {
        var resp = await wafApiGet(origin + '/wp-json/wc/store/v1/products', { search: kw.keyword, per_page: 100 }, site);
        if (resp.status === 200 && Array.isArray(resp.data)) {
          liveResults = resp.data.map(function(p) { return { title: p.name, url: p.permalink }; });
        }
      } else if (site.adapterType === 'shopify') {
        var resp2 = await apiGet(origin + '/search/suggest.json', { q: kw.keyword, 'resources[type]': 'product', 'resources[limit]': 100 });
        if (resp2.status === 200) {
          var prods = (resp2.data && resp2.data.resources && resp2.data.resources.results && resp2.data.resources.results.products) || [];
          liveResults = prods.map(function(p) { return { title: p.title, url: p.url ? (p.url.startsWith('http') ? p.url : origin + p.url) : '' }; });
        }
      } else {
        var searchUrl = buildSearchUrl(origin, kw.keyword, site);
        var resp3 = await axios.get(searchUrl, {
          headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
          timeout: 15000, maxRedirects: 5,
          validateStatus: function(s) { return s < 500; },
        });
        if (resp3.status === 200 && typeof resp3.data === 'string') {
          liveResults = extractProductUrls(resp3.data, origin).map(function(u) { return { title: '', url: u }; });
        }
      }
    } catch { /* search unavailable */ }

    totalDbResults += dbResults.length;
    totalLiveResults += liveResults.length;
    if (dbResults.length > 0) matchedKeywords++;

    var flag = '';
    if (liveResults.length > 0 && dbResults.length === 0) {
      flag = ' <- MISSING (site has ' + liveResults.length + ')';
      missingOnSite++;
    } else if (liveResults.length > 0 && dbResults.length > 0 && dbResults.length / liveResults.length < 0.5) {
      flag = ' <- LOW (site:' + liveResults.length + ' db:' + dbResults.length + ')';
    }

    results.push('  ' + kw.keyword.padEnd(30) + String(dbResults.length).padStart(5) + ' db  ' +
      String(liveResults.length).padStart(5) + ' live' + flag);

    await delay(300);
  }

  var summary = `${matchedKeywords}/${totalKeywords} keywords matched, ${totalDbResults} DB / ${totalLiveResults} live`;

  if (missingOnSite > totalKeywords * 0.1) {
    results.unshift(fail(summary));
    issues.push(makeIssue('MANY_MISSING_KEYWORDS', `${missingOnSite} keywords exist on site but not in DB`, { missingOnSite }, 'high'));
    return { probe: 'C1-keyword-search', verdict: 'FAIL', issues, details: results };
  }
  if (missingOnSite > 0) {
    results.unshift(warn(summary));
    issues.push(makeIssue('SOME_MISSING_KEYWORDS', `${missingOnSite} keywords missing`, { missingOnSite }, 'medium'));
    return { probe: 'C1-keyword-search', verdict: 'WARN', issues, details: results };
  }
  results.unshift(pass(summary));
  return { probe: 'C1-keyword-search', verdict: 'PASS', issues, details: results };
}

// ── C2: Stock Accuracy Spot-Check (from verify Test 4) ───────────────────
async function probeC2_StockAccuracy(site) {
  var results = [];
  var issues = [];
  var origin = site.url.replace(/\/$/, '');

  if (site.adapterType !== 'woocommerce' && site.adapterType !== 'shopify') {
    return { probe: 'C2-stock', verdict: 'SKIP', issues, details: [info('Stock check N/A for ' + site.adapterType)] };
  }

  var dbInStock = await prisma.productIndex.findMany({
    where: { siteId: site.id, isActive: true, stockStatus: 'in_stock' },
    select: { id: true, url: true, title: true },
  });
  var dbOosCount = await prisma.productIndex.count({
    where: { siteId: site.id, isActive: true, stockStatus: 'out_of_stock' },
  });
  results.push(info(`DB: ${dbInStock.length} in_stock, ${dbOosCount} out_of_stock`));

  var mismatches = [];
  if (site.adapterType === 'woocommerce') {
    var actuallyInStock = new Set();
    var page = 1;
    while (page <= 50) {
      try {
        var resp = await wafApiGet(origin + '/wp-json/wc/store/v1/products', { per_page: 100, page: page }, site);
        if (resp.status !== 200 || !Array.isArray(resp.data) || resp.data.length === 0) break;
        resp.data.forEach(function(p) { if (p.is_in_stock) actuallyInStock.add(p.permalink); });
        page++;
        await delay(200);
      } catch { break; }
    }
    results.push(info(`Store API: ${actuallyInStock.size} in stock`));
    var sample = dbInStock.slice(0, 200);
    for (var j = 0; j < sample.length; j++) {
      if (!actuallyInStock.has(sample[j].url)) mismatches.push(sample[j].title.slice(0, 60) + ' -> OOS');
    }
  } else if (site.adapterType === 'shopify') {
    try {
      var resp2 = await apiGet(origin + '/products.json', { limit: 250 });
      if (resp2.status === 200 && resp2.data && resp2.data.products) {
        var byHandle = {};
        resp2.data.products.forEach(function(sp) {
          byHandle[origin + '/products/' + sp.handle] = sp.variants && sp.variants.some(function(v) { return v.available; });
        });
        var sample2 = dbInStock.slice(0, 200);
        for (var l = 0; l < sample2.length; l++) {
          var url = sample2[l].url.replace(/\?.*$/, '');
          if (byHandle.hasOwnProperty(url) && !byHandle[url]) mismatches.push(sample2[l].title.slice(0, 60) + ' -> OOS');
        }
      }
    } catch { results.push(warn('Could not fetch /products.json')); }
  }

  if (mismatches.length > 5) {
    mismatches.slice(0, 10).forEach(function(m) { results.push('  ' + m); });
    results.push(fail(mismatches.length + ' stock mismatches'));
    issues.push(makeIssue('STOCK_MISMATCHES', mismatches.length + ' mismatches', { count: mismatches.length }, 'high'));
    return { probe: 'C2-stock', verdict: 'FAIL', issues, details: results };
  }
  if (mismatches.length > 0) {
    mismatches.forEach(function(m) { results.push('  ' + m); });
    results.push(warn(mismatches.length + ' stock mismatches'));
    return { probe: 'C2-stock', verdict: 'WARN', issues, details: results };
  }
  results.push(pass('0 stock mismatches'));
  return { probe: 'C2-stock', verdict: 'PASS', issues, details: results };
}

// ── C3: Data Accuracy (enhanced — 9 issue types + live comparison) ───────
async function probeC3_DataAccuracy(site, opts) {
  var dbOnly = opts && opts.dbOnly;
  var results = [];
  var issues = [];

  var siteRecord = await prisma.monitoredSite.findUnique({
    where: { id: site.id },
    select: { siteCategory: true, adapterType: true },
  });
  var adapterType = siteRecord ? siteRecord.adapterType : 'generic';
  var isClassified = siteRecord && (siteRecord.siteCategory === 'classified' || siteRecord.siteCategory === 'forum' || siteRecord.siteCategory === 'auction');

  var sourceIdAdapters = ['shopify', 'woocommerce', 'classifieds-gunpost', 'auction-icollector', 'auction-hibid', 'forum-xenforo'];
  var expectsSourceId = sourceIdAdapters.includes(adapterType);

  var products = await prisma.productIndex.findMany({
    where: { siteId: site.id, isActive: true },
    select: { id: true, url: true, title: true, price: true, thumbnail: true, sourceId: true, stockStatus: true },
    take: 200,
  });

  if (products.length < 3) return { probe: 'C3-accuracy', verdict: 'SKIP', issues, details: [info('Too few products')] };

  var shuffled = products.sort(function() { return 0.5 - Math.random(); });
  var sample = shuffled.slice(0, 15);

  var titleMismatches = 0, priceMismatches = 0, checked = 0;
  var thumbMissing = 0, thumbBroken = 0, priceMissing = 0, sourceIdMissing = 0;
  var urlDead = 0, titleEmpty = 0, matchStale = 0;

  for (var product of sample) {
    var label = '"' + (product.title || '(no title)').substring(0, 45) + '"';

    // Title empty/URL check
    if (!product.title || product.title.trim() === '' || /^https?:\/\//i.test(product.title.trim())) {
      titleEmpty++;
      issues.push(makeIssue('TITLE_EMPTY', 'Empty/URL title: ' + label, { id: product.id }, 'high'));
      if (titleEmpty <= 3) results.push(fail('TITLE_EMPTY: ' + label));
    }

    // Price missing (retailers only)
    if (product.price == null && !isClassified) {
      priceMissing++;
      if (priceMissing <= 3) results.push(fail('PRICE_MISSING: ' + label));
    }

    // Thumbnail missing
    if (!product.thumbnail) {
      thumbMissing++;
      if (thumbMissing <= 3) results.push(warn('THUMB_MISSING: ' + label));
    } else if (!dbOnly) {
      await delay(500);
      var thumbOk = await safeHeadImage(product.thumbnail);
      if (!thumbOk.ok) {
        thumbBroken++;
        if (thumbBroken <= 3) results.push(warn('THUMB_BROKEN: ' + label + ' — ' + thumbOk.reason));
      }
    }

    // sourceId missing
    if (expectsSourceId && !product.sourceId) {
      sourceIdMissing++;
      if (sourceIdMissing <= 3) results.push(info('SOURCEID_MISSING: ' + label));
    }

    // URL check
    var urlCheck = { ok: true };
    if (!dbOnly) {
      await delay(500);
      urlCheck = await wafHeadUrl(product.url, site);
      if (!urlCheck.ok && urlCheck.reason === 'HTTP 404') {
        urlDead++;
        if (urlDead <= 3) results.push(fail('URL_DEAD: ' + label));
      }
    }

    // Match consistency
    var linkedMatches = await prisma.match.findMany({
      where: { productIndexId: product.id },
      select: { id: true, title: true, price: true },
      take: 3,
    });
    for (var m of linkedMatches) {
      var staleFields = [];
      if (m.title !== product.title) staleFields.push('title');
      if (m.price !== product.price) staleFields.push('price');
      if (staleFields.length > 0) {
        matchStale++;
        if (matchStale <= 3) results.push(fail('MATCH_STALE: ' + staleFields.join(',') + ' for ' + label));
      }
    }

    // Live page comparison
    if (!dbOnly && urlCheck.ok) {
      await delay(500);
      var resp = await wafFetch(product.url, site, 10000);
      if (resp.status === 200 && resp.data.length >= 500) {
        checked++;
        var html = resp.data;
        var pageTitleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
        var pageTitle = pageTitleMatch ? pageTitleMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : null;
        if (pageTitle) {
          // Decode HTML entities before comparison (DB stores decoded text, page has entities)
          var dbNorm = decodeEntities(product.title).replace(/\s+/g, ' ').trim().toLowerCase();
          var pageNorm = decodeEntities(pageTitle).toLowerCase();
          if (dbNorm !== pageNorm && !pageNorm.startsWith(dbNorm) && !dbNorm.startsWith(pageNorm)) {
            titleMismatches++;
            results.push(warn('Title mismatch: DB="' + product.title.substring(0, 40) + '" vs Page="' + pageTitle.substring(0, 40) + '"'));
          }
        }
        if (product.price) {
          var priceStr = product.price.toFixed(2);
          var priceInt = Math.round(product.price).toString();
          if (!html.includes(priceStr) && !html.includes(priceInt + '.') && !html.includes('$' + priceStr)) {
            priceMismatches++;
            var prices = (html.match(/\$[\d,]+\.\d{2}/g) || []).slice(0, 5);
            results.push(fail('Price mismatch: DB=$' + priceStr + '. Page: ' + (prices.join(', ') || 'none')));
          }
        }
      }
    }
  }

  results.push(info(`Checked ${sample.length} (${checked} live): ${titleMismatches} title, ${priceMismatches} price mismatches`));
  results.push(info(`${thumbMissing} thumb_miss, ${thumbBroken} thumb_broken, ${priceMissing} price_miss, ${sourceIdMissing} srcId_miss, ${urlDead} url_dead, ${titleEmpty} title_empty, ${matchStale} match_stale`));

  // Systematic detection
  var checks = [
    { count: priceMismatches, code: 'SYSTEMATIC_PRICE_ERRORS', label: 'wrong prices' },
    { count: titleMismatches, code: 'SYSTEMATIC_TITLE_ERRORS', label: 'wrong titles' },
    { count: thumbMissing, code: 'SYSTEMATIC_THUMB_MISSING', label: 'missing thumbnails' },
    { count: priceMissing, code: 'SYSTEMATIC_PRICE_MISSING', label: 'missing prices' },
    { count: urlDead, code: 'SYSTEMATIC_URL_DEAD', label: 'dead URLs' },
    { count: matchStale, code: 'SYSTEMATIC_MATCH_STALE', label: 'stale matches' },
  ];
  for (var sc of checks) {
    if (sc.count >= 3) {
      issues.push(makeIssue(sc.code, sc.count + '/' + sample.length + ' ' + sc.label, { count: sc.count, sample: sample.length }, 'high'));
      results.push(fail('SYSTEMATIC: ' + sc.count + ' ' + sc.label));
    }
  }

  var hasFail = issues.some(i => i.severity === 'high');
  var hasWarn = issues.some(i => i.severity === 'medium');
  return { probe: 'C3-accuracy', verdict: hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS', issues, details: results };
}

// ── C4: Product Spot-Check (from investigate C2) ─────────────────────────
async function probeC4_ProductSpotCheck(site) {
  var results = [];
  var issues = [];

  var products = await prisma.productIndex.findMany({
    where: { siteId: site.id, isActive: true },
    select: { url: true, title: true, price: true },
    take: 100,
  });
  if (products.length === 0) return { probe: 'C4-spot-check', verdict: 'FAIL', issues: [makeIssue('NO_PRODUCTS', 'No products', null, 'high')], details: [fail('No products')] };

  var sample = products.sort(function() { return 0.5 - Math.random(); }).slice(0, 5);
  var alive = 0, dead = 0;

  for (var product of sample) {
    await delay(500);
    var resp = await wafFetch(product.url, site, 8000);
    if (resp.status === 200 && resp.data.length > 1000) {
      alive++;
      var titleWords = product.title.split(/\s+/).slice(0, 3).join(' ');
      if (resp.data.toLowerCase().includes(titleWords.toLowerCase())) {
        results.push(pass(`"${product.title.substring(0, 50)}" — exists, title matches`));
      } else {
        results.push(warn(`"${product.title.substring(0, 50)}" — exists but title not in HTML`));
      }
    } else if (resp.status === 404) {
      dead++;
      results.push(fail(`"${product.title.substring(0, 50)}" — 404`));
    } else {
      results.push(warn(`"${product.title.substring(0, 50)}" — HTTP ${resp.status}`));
    }
  }

  if (dead >= 3) issues.push(makeIssue('MANY_DEAD_PRODUCTS', `${dead}/5 are 404`, { dead }, 'high'));
  else if (dead >= 1) issues.push(makeIssue('SOME_DEAD_PRODUCTS', `${dead}/5 are 404`, { dead }, 'medium'));

  var hasFail = issues.some(i => i.severity === 'high');
  var hasWarn = issues.some(i => i.severity === 'medium');
  return { probe: 'C4-spot-check', verdict: hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS', issues, details: results };
}

// ── C5: Thumbnail Validation (from verify Test 5) ────────────────────────
async function probeC5_ThumbnailValidation(site) {
  var results = [];
  var issues = [];

  var total = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true } });
  var withThumb = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true, thumbnail: { not: null } } });
  var coverage = pctNum(withThumb, total);

  if (coverage >= 95) results.push(pass(`Thumbnail: ${withThumb}/${total} (${coverage}%)`));
  else if (coverage >= 80) results.push(warn(`Thumbnail: ${withThumb}/${total} (${coverage}%)`));
  else { results.push(fail(`Thumbnail: ${withThumb}/${total} (${coverage}%)`)); issues.push(makeIssue('LOW_THUMB_COVERAGE', `${coverage}%`, { coverage }, 'high')); }

  // Sample HEAD checks (skip for WAF-protected sites — HEAD requests get blocked, causing false alarms)
  if (site.hasWaf) {
    results.push(info('Skipping HEAD checks (WAF-protected site — browser loads thumbnails fine)'));
  } else {
    var thumbnails = await prisma.productIndex.findMany({
      where: { siteId: site.id, isActive: true, thumbnail: { not: null } },
      select: { thumbnail: true, title: true },
      take: 30, orderBy: { lastSeenAt: 'desc' },
    });

    var accessible = 0, broken = 0, placeholder = 0;
    var brokenSamples = [];
    var PLACEHOLDER_RE = /place-?holder|no-image|woocommerce-placeholder|default-product|blank\.(gif|png|jpg)|product-image-coming/i;

    for (var i = 0; i < thumbnails.length; i++) {
      var thumb = thumbnails[i].thumbnail;
      if (PLACEHOLDER_RE.test(thumb)) { placeholder++; continue; }
      try {
        await axios.head(thumb, {
          headers: { 'User-Agent': UA }, timeout: 8000, maxRedirects: 3,
          validateStatus: function(s) { return s < 400; },
        });
        accessible++;
      } catch {
        broken++;
        if (brokenSamples.length < 5) brokenSamples.push(thumbnails[i].title.slice(0, 40) + ' -> ' + thumb.slice(0, 60));
      }
    }

    if (thumbnails.length > 0) {
      results.push(info(`Checked ${accessible + broken + placeholder}: ${accessible} OK, ${broken} broken, ${placeholder} placeholder`));
    }
    brokenSamples.forEach(function(s) { results.push('  ' + s); });
  }

  // HTTPS check
  var httpThumbs = await prisma.productIndex.count({
    where: { siteId: site.id, isActive: true, thumbnail: { startsWith: 'http://' } },
  });
  if (httpThumbs > 0) results.push(warn(httpThumbs + ' HTTP (not HTTPS) thumbnails'));

  if (!site.hasWaf && typeof broken !== 'undefined' && broken > 5) issues.push(makeIssue('MANY_BROKEN_THUMBS', `${broken} broken`, { broken }, 'high'));

  var hasFail = issues.some(i => i.severity === 'high') || results.some(r => r.includes('FAIL'));
  var hasWarn = issues.some(i => i.severity === 'medium') || results.some(r => r.includes('WARN'));
  return { probe: 'C5-thumbnails', verdict: hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS', issues, details: results };
}


// ═══════════════════════════════════════════════════════════════════════════
// CATEGORY D: COVERAGE COMPARISON
// ═══════════════════════════════════════════════════════════════════════════

// ── D1: DB Count vs Live Site Count ──────────────────────────────────────
async function probeD1_DbVsLiveCount(site) {
  var results = [];
  var issues = [];
  var origin = site.url.replace(/\/$/, '');

  var dbCount = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true } });
  results.push(info(`DB active products: ${dbCount}`));

  var liveCount = null;
  var method = 'unknown';

  try {
    if (site.adapterType === 'shopify') {
      // Shopify: paginate /products.json to count all
      method = 'Shopify API';
      var total = 0;
      for (var page = 1; page <= 100; page++) {
        var resp = await apiGet(origin + '/products.json', { limit: 250, page: page });
        if (resp.status !== 200 || !resp.data || !resp.data.products || resp.data.products.length === 0) break;
        total += resp.data.products.length;
        if (resp.data.products.length < 250) break;
        await delay(300);
      }
      liveCount = total;
    } else if (site.adapterType === 'woocommerce') {
      // WooCommerce: WP REST API returns ALL products (inc. out-of-stock)
      // Store API only returns in-stock — wrong for total count comparison
      method = 'WooCommerce WP REST API';
      var resp3 = await wafApiGet(origin + '/wp-json/wp/v2/product', { per_page: 1 }, site);
      if (resp3.status === 200 && resp3.headers) {
        var totalHeader2 = resp3.headers['x-wp-total'];
        if (totalHeader2) liveCount = parseInt(totalHeader2, 10);
      }
      // Fallback: Store API (in-stock only — will be flagged as estimate)
      if (liveCount === null) {
        method = 'WooCommerce Store API (in-stock only)';
        var resp2 = await wafApiGet(origin + '/wp-json/wc/store/v1/products', { per_page: 1 }, site);
        if (resp2.status === 200 && resp2.headers) {
          var totalHeader = resp2.headers['x-wp-total'];
          if (totalHeader) liveCount = parseInt(totalHeader, 10);
        }
      }
    } else {
      // HTML sites: estimate from pagination
      method = 'HTML pagination';
      var ss = site.streamState;
      if (ss && ss.streams && ss.streams.length > 0) {
        var totalEstimate = 0;
        for (var stream of ss.streams) {
          if (stream.totalPages && stream.totalPages > 0) {
            // Fetch first page to count products per page
            await delay(500);
            var pageResp = await wafFetch(stream.url, site, 10000);
            if (pageResp.status === 200) {
              var productLinks = extractProductUrls(pageResp.data, origin);
              var perPage = productLinks.length || 24; // default assumption
              totalEstimate += stream.totalPages * perPage;
            }
          }
        }
        if (totalEstimate > 0) liveCount = totalEstimate;
      }
    }
  } catch (err) {
    results.push(warn(`Could not fetch live count: ${err.message.substring(0, 60)}`));
  }

  if (liveCount === null) {
    results.push(info(`Live count: unavailable (${method})`));
    return { probe: 'D1-db-vs-live', verdict: 'SKIP', issues, details: results };
  }

  results.push(info(`Live count: ~${liveCount} (${method})`));

  if (dbCount === 0 && liveCount > 0) {
    issues.push(makeIssue('DB_EMPTY', `0 products in DB but ~${liveCount} on live site`, { dbCount, liveCount }, 'high'));
    results.push(fail(`DB empty but site has ~${liveCount} products`));
  } else if (liveCount > 0) {
    var ratio = dbCount / liveCount;
    results.push(info(`Coverage ratio: ${Math.round(ratio * 100)}% (DB/live)`));

    if (ratio < 0.5) {
      issues.push(makeIssue('LOW_DB_COVERAGE', `Only ${Math.round(ratio * 100)}% of live products in DB`, { dbCount, liveCount, ratio: Math.round(ratio * 100) }, 'high'));
      results.push(fail(`Only ${Math.round(ratio * 100)}% coverage — missing ~${liveCount - dbCount} products`));
    } else if (ratio < 0.8) {
      issues.push(makeIssue('MODERATE_DB_COVERAGE', `${Math.round(ratio * 100)}% coverage`, { dbCount, liveCount }, 'medium'));
      results.push(warn(`${Math.round(ratio * 100)}% coverage — missing ~${liveCount - dbCount} products`));
    } else {
      results.push(pass(`${Math.round(ratio * 100)}% coverage`));
    }

    // Flag if we have significantly MORE than live (stale products?)
    if (ratio > 1.5 && dbCount > liveCount + 100) {
      issues.push(makeIssue('DB_EXCEEDS_LIVE', `DB has ${dbCount} but live has ~${liveCount} — ${dbCount - liveCount} may be stale`, { dbCount, liveCount }, 'medium'));
      results.push(warn(`DB exceeds live by ${dbCount - liveCount} — possible stale products`));
    }
  }

  var hasFail = issues.some(i => i.severity === 'high');
  var hasWarn = issues.some(i => i.severity === 'medium');
  return { probe: 'D1-db-vs-live', verdict: hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS', issues, details: results };
}


// ── D2: Stale Product 404 Check & Deactivation ──────────────────────────
// Checks the oldest-unseen active products for confirmed 404s.
// Products confirmed dead are deactivated (isActive=false) but NOT deleted —
// Match records, price history, and all data remain in DB for reports.
// Only deactivates when --fix flag is passed.
async function probeD2_Stale404Check(site, opts) {
  var results = [];
  var issues = [];
  var canFix = opts && opts.fix;

  // Find products not seen in a long time (oldest lastSeenAt)
  var staleWindow = new Date(Date.now() - 14 * 24 * 3600000); // 14 days minimum
  var staleProducts = await prisma.productIndex.findMany({
    where: { siteId: site.id, isActive: true, lastSeenAt: { lt: staleWindow } },
    select: { id: true, url: true, title: true, lastSeenAt: true },
    orderBy: { lastSeenAt: 'asc' },
    take: 50, // Check up to 50 oldest products
  });

  if (staleProducts.length === 0) {
    results.push(pass('No products unseen for >14 days'));
    return { probe: 'D2-stale-404', verdict: 'PASS', issues, details: results };
  }

  results.push(info(`${staleProducts.length} products unseen >14d — spot-checking for 404s and sold items`));

  var confirmed404 = [];
  var confirmedSold = [];
  var alive = 0;
  var errors = 0;
  var checked = 0;

  // Sample up to 20 (to limit HTTP requests)
  var toCheck = staleProducts.slice(0, 20);
  for (var product of toCheck) {
    checked++;
    await delay(500);
    // First try HEAD for 404
    var resp = await wafHeadUrl(product.url, site);

    if (!resp.ok && resp.reason === 'HTTP 404') {
      confirmed404.push(product);
      if (confirmed404.length <= 5) {
        results.push(fail(`404: "${product.title.substring(0, 50)}" (unseen ${ago(product.lastSeenAt)})`));
      }
    } else if (resp.ok) {
      // Fetch the full page to check for soft-404 AND sold status
      await delay(300);
      var getResp = await wafFetch(product.url, site, 8000);
      if (getResp.status === 200 && getResp.data.length > 0) {
        var pageHtml = getResp.data;
        var h1Match = pageHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
        var h1Text = h1Match ? h1Match[1].replace(/<[^>]+>/g, '').trim().toLowerCase() : '';

        // Check soft-404
        var isSoft404 = h1Text.includes('not found') || h1Text.includes('page introuvable') ||
          h1Text === '404' || pageHtml.includes('The page you requested does not exist');

        // Check sold status (gunpost uses class="sold Yes", class="field-sold Yes", or SOLD text near image)
        var isSold = /class="[^"]*\bsold\b[^"]*"/i.test(pageHtml) ||
          /class="field-sold\s+Yes"/i.test(pageHtml) ||
          />\s*SOLD\s*</.test(pageHtml);

        if (isSoft404) {
          confirmed404.push(product);
          if (confirmed404.length <= 5) {
            results.push(fail(`Soft-404: "${product.title.substring(0, 50)}" (h1: "${h1Text.substring(0, 30)}")`));
          }
        } else if (isSold) {
          confirmedSold.push(product);
          if (confirmedSold.length <= 5) {
            results.push(warn(`SOLD: "${product.title.substring(0, 50)}" (unseen ${ago(product.lastSeenAt)})`));
          }
        } else {
          alive++;
        }
      } else {
        alive++;
      }
    } else {
      errors++; // Timeout, WAF, etc. — don't deactivate
    }
  }

  results.push(info(`Checked ${checked}: ${alive} alive, ${confirmed404.length} dead (404), ${confirmedSold.length} sold, ${errors} errors/blocked`));

  if (confirmed404.length > 0) {
    issues.push(makeIssue('CONFIRMED_404_PRODUCTS',
      `${confirmed404.length} products confirmed deleted (404)`,
      { count: confirmed404.length },
      'high', false, 'stale-detector.ts handles this automatically after tier cycle completion'));
    results.push(warn(`${confirmed404.length} deleted products — stale-detector will auto-deactivate after next full sweep`));
  }

  if (confirmedSold.length > 0) {
    issues.push(makeIssue('CONFIRMED_SOLD_PRODUCTS',
      `${confirmedSold.length} products confirmed sold`,
      { count: confirmedSold.length },
      'medium', false, 'stale-detector.ts handles this automatically after tier cycle completion'));
    results.push(warn(`${confirmedSold.length} sold products — stale-detector will auto-mark after next full sweep`));
  }

  // Estimate totals from sample
  var totalDead = confirmed404.length + confirmedSold.length;
  if (checked >= 10 && totalDead > 0) {
    var rateRemoved = Math.round(totalDead / checked * 100);
    var estTotalRemoved = Math.round(staleProducts.length * rateRemoved / 100);
    results.push(info(`Estimated ~${estTotalRemoved} total dead/sold among ${staleProducts.length} stale products (${rateRemoved}% sample rate)`));
  }

  var hasFail = issues.some(function(i) { return i.severity === 'high'; });
  return { probe: 'D2-stale-404', verdict: hasFail ? 'FAIL' : 'PASS', issues, details: results };
}


// ═══════════════════════════════════════════════════════════════════════════
// MAIN RUNNER
// ═══════════════════════════════════════════════════════════════════════════

var ALL_PROBES = [
  // Category A: DB State
  { id: 'A1', name: 'Stream State', fn: function(s, o) { return probeA1_StreamState(s); }, category: 'A', dbOnly: true },
  { id: 'A2', name: 'Crawl Events', fn: function(s, o) { return probeA2_CrawlEvents(s); }, category: 'A', dbOnly: true },
  { id: 'A3', name: 'Product Index', fn: function(s, o) { return probeA3_ProductIndex(s); }, category: 'A', dbOnly: true },
  { id: 'A4', name: 'Watermark', fn: function(s, o) { return probeA4_Watermark(s); }, category: 'A', dbOnly: true },
  { id: 'A5', name: 'sourceId Coverage', fn: function(s, o) { return probeA5_SourceIdCoverage(s); }, category: 'A', dbOnly: true },
  { id: 'A6', name: 'Schema Validation', fn: function(s, o) { return probeA6_SchemaValidation(s); }, category: 'A', dbOnly: true },
  { id: 'A7', name: 'Data Quality', fn: function(s, o) { return probeA7_DataQuality(s); }, category: 'A', dbOnly: true },
  { id: 'A8', name: 'Match Freshness', fn: function(s, o) { return probeA8_MatchFreshness(s); }, category: 'A', dbOnly: true },
  { id: 'A9', name: 'Duplicates', fn: function(s, o) { return probeA9_DuplicateDetection(s); }, category: 'A', dbOnly: true },
  // Category B: Live Site
  { id: 'B1', name: 'Platform Detection', fn: function(s, o) { return probeB1_PlatformDetect(s); }, category: 'B', dbOnly: false },
  { id: 'B2', name: 'API Health', fn: function(s, o) { return probeB2_ApiHealth(s); }, category: 'B', dbOnly: false },
  { id: 'B3', name: 'Pagination', fn: function(s, o) { return probeB3_Pagination(s); }, category: 'B', dbOnly: false },
  // Category C: Simulation
  { id: 'C1', name: 'Keyword Search', fn: function(s, o) { return probeC1_KeywordSearch(s, o); }, category: 'C', dbOnly: false },
  { id: 'C2', name: 'Stock Accuracy', fn: function(s, o) { return probeC2_StockAccuracy(s); }, category: 'C', dbOnly: false },
  { id: 'C3', name: 'Data Accuracy', fn: function(s, o) { return probeC3_DataAccuracy(s, o); }, category: 'C', dbOnly: false },
  { id: 'C4', name: 'Product Spot-Check', fn: function(s, o) { return probeC4_ProductSpotCheck(s); }, category: 'C', dbOnly: false },
  { id: 'C5', name: 'Thumbnail Validation', fn: function(s, o) { return probeC5_ThumbnailValidation(s); }, category: 'C', dbOnly: false },
  // Category D: Coverage
  { id: 'D1', name: 'DB vs Live Count', fn: function(s, o) { return probeD1_DbVsLiveCount(s); }, category: 'D', dbOnly: false },
  { id: 'D2', name: 'Stale 404 Check', fn: function(s, o) { return probeD2_Stale404Check(s, o); }, category: 'D', dbOnly: false },
];

var CATEGORY_LABELS = {
  A: 'DB STATE',
  B: 'LIVE SITE',
  C: 'SIMULATION',
  D: 'COVERAGE',
};

async function runSite(domain, options) {
  var site = await prisma.monitoredSite.findFirst({
    where: domain.includes('.') ? { domain: domain } : { domain: { contains: domain } },
    select: {
      id: true, domain: true, name: true, url: true,
      adapterType: true, siteType: true, siteCategory: true,
      isEnabled: true, isPaused: true, hasWaf: true,
      consecutiveFailures: true, searchUrlPattern: true,
      lastWatermarkUrl: true, lastCrawlAt: true, nextCrawlAt: true,
      streamState: true, baseBudget: true, tierState: true,
    },
  });

  if (!site) {
    console.error(`Site not found: ${domain}`);
    return null;
  }

  var totalProducts = await prisma.productIndex.count({ where: { siteId: site.id } });
  var activeProducts = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true } });

  // Select probes to run
  var probes = ALL_PROBES;
  if (options.dbOnly) probes = probes.filter(function(p) { return p.dbOnly; });
  if (options.probeId) probes = probes.filter(function(p) { return p.id.toUpperCase() === options.probeId.toUpperCase(); });

  // Header
  if (!options.json) {
    var mode = options.dbOnly ? 'DB-ONLY' : options.quick ? 'QUICK' : 'FULL';
    console.log(`\n${C.bold}${C.white}${'='.repeat(65)}${C.reset}`);
    console.log(`${C.bold}  SITE INVESTIGATION (${mode}): ${site.domain}${C.reset}`);
    console.log(`${C.dim}  Adapter: ${site.adapterType} | Products: ${totalProducts} | Active: ${activeProducts}${C.reset}`);
    console.log(`${C.bold}${C.white}${'='.repeat(65)}${C.reset}`);
  }

  var report = {
    domain: site.domain,
    adapter: site.adapterType,
    products: totalProducts,
    active: activeProducts,
    probes: {},
    allIssues: [],
    summary: { PASS: 0, WARN: 0, FAIL: 0, SKIP: 0 },
  };

  var lastCategory = null;
  for (var probe of probes) {
    // Category header
    if (!options.json && probe.category !== lastCategory) {
      lastCategory = probe.category;
      console.log(`\n${C.bold}${C.cyan}--- ${CATEGORY_LABELS[probe.category] || probe.category} ---${C.reset}`);
    }

    try {
      var result = await probe.fn(site, options);
      report.probes[result.probe] = result;
      report.summary[result.verdict] = (report.summary[result.verdict] || 0) + 1;
      report.allIssues.push(...(result.issues || []));

      if (!options.json) {
        var verdictColor = result.verdict === 'PASS' ? C.green : result.verdict === 'FAIL' ? C.red : result.verdict === 'WARN' ? C.yellow : C.dim;
        var label = `[${probe.id}] ${probe.name}`;
        console.log(`\n${C.bold}${label}${C.reset} ${'.'.repeat(Math.max(1, 50 - label.length))} ${verdictColor}${result.verdict}${C.reset}`);
        (result.details || []).forEach(function(d) { console.log('  ' + d); });
      }
    } catch (err) {
      report.summary.FAIL++;
      if (!options.json) {
        console.log(`\n${C.bold}[${probe.id}] ${probe.name}${C.reset} ${'.'.repeat(Math.max(1, 40))} ${C.red}ERROR${C.reset}`);
        console.log(`  ${err.message}`);
      }
      report.probes[probe.id] = { probe: probe.id, verdict: 'ERROR', error: err.message, issues: [], details: [] };
    }
  }

  // Summary
  if (!options.json) {
    console.log(`\n${C.bold}${C.magenta}${'='.repeat(65)}${C.reset}`);
    console.log(`${C.bold}  SUMMARY: ${site.domain}${C.reset}`);
    console.log(`  ${C.green}PASS: ${report.summary.PASS}${C.reset} | ${C.yellow}WARN: ${report.summary.WARN}${C.reset} | ${C.red}FAIL: ${report.summary.FAIL}${C.reset} | ${C.dim}SKIP: ${report.summary.SKIP || 0}${C.reset}`);
    console.log(`  Total issues: ${report.allIssues.length}`);
    var high = report.allIssues.filter(i => i.severity === 'high');
    var medium = report.allIssues.filter(i => i.severity === 'medium');
    if (high.length) console.log(`  ${C.red}HIGH: ${high.length}${C.reset} — ${high.map(i => i.code).join(', ')}`);
    if (medium.length) console.log(`  ${C.yellow}MEDIUM: ${medium.length}${C.reset} — ${medium.map(i => i.code).join(', ')}`);
    console.log(`${C.bold}${C.magenta}${'='.repeat(65)}${C.reset}`);
  }

  return report;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
async function main() {
  var args = process.argv.slice(2);
  var domain = null;
  var runAll = false;
  var options = { quick: false, dbOnly: false, json: false, probeId: null, fix: false };

  for (var i = 0; i < args.length; i++) {
    if (args[i] === '--all') runAll = true;
    else if (args[i] === '--quick') options.quick = true;
    else if (args[i] === '--db-only') options.dbOnly = true;
    else if (args[i] === '--json') options.json = true;
    else if (args[i] === '--fix') options.fix = true;
    else if (args[i] === '--probe' && args[i + 1]) options.probeId = args[++i];
    else if (!args[i].startsWith('-')) domain = args[i];
  }

  if (!domain && !runAll) {
    console.log('Usage: node scripts/investigate-site.js <domain> [options]');
    console.log('       node scripts/investigate-site.js --all [options]');
    console.log('');
    console.log('Options:');
    console.log('  --quick     Use 12 keywords instead of 52');
    console.log('  --db-only   Category A only (no HTTP requests)');
    console.log('  --probe X   Run specific probe (e.g., A1, B2, C3, D1, D2)');
    console.log('  --fix       Auto-fix issues (D2: deactivate confirmed 404 products)');
    console.log('  --json      JSON output');
    console.log('  --all       Run on all enabled sites');
    console.log('');
    console.log('Probes:');
    ALL_PROBES.forEach(function(p) {
      console.log(`  ${p.id.padEnd(4)} ${p.name.padEnd(25)} [${p.category}] ${p.dbOnly ? '(db-only)' : ''}`);
    });
    process.exit(1);
  }

  var allResults = [];

  if (runAll) {
    var sites = await prisma.monitoredSite.findMany({
      where: { isEnabled: true },
      select: { domain: true },
      orderBy: { domain: 'asc' },
    });
    if (sites.length === 0) { console.log('No enabled sites'); process.exit(1); }

    for (var j = 0; j < sites.length; j++) {
      var result = await runSite(sites[j].domain, options);
      if (result) allResults.push(result);
    }
  } else {
    var result = await runSite(domain, options);
    if (result) allResults.push(result);
  }

  // Multi-site summary
  if (allResults.length > 1 && !options.json) {
    console.log(`\n${C.bold}${'='.repeat(65)}${C.reset}`);
    console.log(`${C.bold}  ALL SITES SUMMARY (${allResults.length} sites)${C.reset}`);
    console.log(`${C.bold}${'='.repeat(65)}${C.reset}`);
    for (var k = 0; k < allResults.length; k++) {
      var r = allResults[k];
      var overall = r.summary.FAIL > 0 ? C.red + 'FAIL' : r.summary.WARN > 0 ? C.yellow + 'WARN' : C.green + 'PASS';
      var issueCount = r.allIssues.filter(i => i.severity === 'high').length;
      console.log(`  ${r.domain.padEnd(35)} ${overall}${C.reset} (${r.summary.PASS}/${r.summary.WARN}/${r.summary.FAIL})` +
        (issueCount > 0 ? ` ${C.red}${issueCount} HIGH${C.reset}` : ''));
    }
  }

  if (options.json) {
    console.log(JSON.stringify(allResults.length === 1 ? allResults[0] : allResults, null, 2));
  }

  await prisma.$disconnect();
  // Close shared Playwright browser if it was started
  try { if (_playwrightFetcher) await _playwrightFetcher.closeBrowser(); } catch (e) { /* ignore */ }
}

main().catch(function(err) { console.error(err); process.exit(1); });
