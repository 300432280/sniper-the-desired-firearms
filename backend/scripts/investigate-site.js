/**
 * Site Investigation Script — Deep Behavioral Analysis
 *
 * 12 probes across 3 categories:
 *   Category A (DB State):  A1-StreamState, A2-CrawlEvents, A3-ProductIndex, A4-Watermark
 *   Category B (Live):      B1-PlatformDetect, B2-WAFDetect, B3-SelectorValidation, B4-Pagination
 *   Category C (Simulate):  C1-MultiKeywordSearch, C2-ProductSpotCheck, C3-WatermarkSim, C4-CategoryCoverage
 *
 * Usage:
 *   node scripts/investigate-site.js <domain>           # full investigation
 *   node scripts/investigate-site.js <domain> --json    # JSON output
 *   node scripts/investigate-site.js <domain> --db-only # Category A only (fast, no HTTP)
 */

require('dotenv').config();
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

// ── Test Keywords for Probe C1 ─────────────────────────────────────────────
const TEST_KEYWORDS = [
  { keyword: 'SKS', type: 'short' },
  { keyword: '9mm', type: 'caliber-short' },
  { keyword: '.308', type: 'caliber-dot' },
  { keyword: 'Ruger 10/22', type: 'brand-model-slash' },
  { keyword: 'magazine', type: 'ambiguous' },
  { keyword: 'shotgun', type: 'category' },
];

// ── Helpers ─────────────────────────────────────────────────────────────────
function pct(n, total) { return total === 0 ? '0%' : Math.round(n / total * 100) + '%'; }
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

// ═══════════════════════════════════════════════════════════════════════════
// CATEGORY A: DB STATE ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════

// ── Probe A1: Stream State Health ───────────────────────────────────────────
async function probeA1_StreamState(site) {
  var results = [];
  var issues = [];
  var ss = site.streamState;

  if (!ss || !ss.streams || ss.streams.length === 0) {
    issues.push(makeIssue('NO_STREAM_STATE', 'No stream state detected — site has never had a successful catalog crawl or streams not initialized', null, 'high'));
    return { probe: 'A1-stream-state', verdict: 'FAIL', issues, details: [fail('No stream state')] };
  }

  results.push(info(`${ss.streams.length} stream(s) detected: ${ss.streams.map(s => s.id).join(', ')}`));
  results.push(info(`Stream types: ${ss.streams.map(s => `${s.id}(${s.type})`).join(', ')}`));

  if (!ss.tiers || Object.keys(ss.tiers).length === 0) {
    issues.push(makeIssue('NO_TIER_STATE', 'Stream state has streams but no tier entries', null, 'high'));
    return { probe: 'A1-stream-state', verdict: 'FAIL', issues, details: [...results, fail('No tier state')] };
  }

  var now = Date.now();
  var allHtmlPage1 = true;
  var hasHtmlStreams = ss.streams.some(s => s.type === 'html');
  var stuckCount = 0;
  var expiredCooldowns = 0;

  // Build lookup of stream type by id
  var streamTypeMap = {};
  ss.streams.forEach(s => { streamTypeMap[s.id] = s.type; });

  for (var key of Object.keys(ss.tiers)) {
    var ts = ss.tiers[key];
    var streamId = key.split(':')[0];
    var streamType = streamTypeMap[streamId] || 'html';

    // Only check page range partitioning for HTML streams (API streams use date ranges)
    if (streamType === 'html') {
      if (ts.pageRangeEnd != null || ts.pageRangeStart !== 1) allHtmlPage1 = false;
    }

    // Check stuck in_progress
    if (ts.status === 'in_progress' && ts.cycleStartedAt) {
      var stuckMs = now - new Date(ts.cycleStartedAt).getTime();
      if (stuckMs > 15 * 60 * 1000) {
        stuckCount++;
        issues.push(makeIssue('TIER_STUCK_IN_PROGRESS',
          `${key} stuck in in_progress for ${Math.round(stuckMs / 60000)}min`,
          { key, status: ts.status, cycleStartedAt: ts.cycleStartedAt, stuckMinutes: Math.round(stuckMs / 60000) },
          'high', true, 'Reset tier status to idle'));
      }
    }

    // Check expired cooldowns
    if (ts.status === 'cooldown' && ts.cooldownEndsAt) {
      if (new Date(ts.cooldownEndsAt).getTime() < now) {
        expiredCooldowns++;
        issues.push(makeIssue('COOLDOWN_EXPIRED',
          `${key} cooldown expired ${ago(ts.cooldownEndsAt)} but not reset to idle`,
          { key, cooldownEndsAt: ts.cooldownEndsAt },
          'medium', true, 'Reset tier status to idle'));
      }
    }

    // Tier status summary
    var range = ts.pageRangeEnd ? `[${ts.pageRangeStart}-${ts.pageRangeEnd}]` : `[${ts.pageRangeStart}+]`;
    results.push(info(`  ${key}: ${ts.status} page=${ts.currentPage} range=${range} refreshed=${ago(ts.lastRefreshedAt)}`));
  }

  // Check API vs HTML tier config
  for (var stream of ss.streams) {
    if (stream.type === 'api') {
      // API streams should use date ranges, not page ranges
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

  // All HTML tiers at page 1 with no end = not partitioned (only check HTML streams)
  if (hasHtmlStreams && allHtmlPage1 && Object.keys(ss.tiers).length >= 3) {
    issues.push(makeIssue('TIERS_NOT_PARTITIONED',
      'All HTML tiers have pageRangeStart=1 with no pageRangeEnd — triplicating work',
      { tierCount: Object.keys(ss.tiers).length },
      'high', true, 'Need totalPages discovery to partition ranges'));
    results.push(fail('All HTML tiers crawling same range [1+]'));
  } else if (!hasHtmlStreams) {
    results.push(pass('API-only streams — page ranges N/A (uses date ranges)'));
  } else {
    results.push(pass('HTML tiers have distinct page ranges'));
  }

  if (stuckCount > 0) results.push(fail(`${stuckCount} tier(s) stuck in in_progress`));
  if (expiredCooldowns > 0) results.push(warn(`${expiredCooldowns} expired cooldown(s)`));

  // Check stream totalPages
  var streamsWithPages = ss.streams.filter(s => s.totalPages && s.totalPages > 0);
  results.push(info(`${streamsWithPages.length}/${ss.streams.length} streams have totalPages discovered`));

  var hasFail = issues.some(i => i.severity === 'high');
  var hasWarn = issues.some(i => i.severity === 'medium');
  return { probe: 'A1-stream-state', verdict: hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS', issues, details: results };
}

// ── Probe A2: Crawl Event Pattern Analysis ──────────────────────────────────
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
    issues.push(makeIssue('NO_CRAWL_EVENTS', 'No crawl events recorded — crawler may never have run', null, 'high'));
    return { probe: 'A2-crawl-events', verdict: 'FAIL', issues, details: [fail('No crawl events')] };
  }

  var total = events.length;
  var successes = events.filter(e => e.status === 'success').length;
  var failures = events.filter(e => e.status !== 'success').length;
  var phantoms = events.filter(e => e.status === 'success' && e.matchesFound === 0).length;
  var successRate = Math.round(successes / total * 100);

  results.push(info(`${total} events: ${successes} success, ${failures} fail (${successRate}% success rate)`));
  results.push(info(`Last event: ${events[0].status} ${ago(events[0].crawledAt)} — ${events[0].matchesFound} products`));

  // Phantom successes analysis
  // NOTE: CrawlEvents are only recorded by Tier 1 watermark crawls (onCrawlComplete).
  // Catalog crawls (T2-T4) do NOT create CrawlEvents. So "success with 0 products"
  // is NORMAL for watermark crawls when no new listings have been added since last check.
  // Only flag if ALL recent events have 0 products (watermark never finds anything).
  if (phantoms > 0) {
    var phantomRate = Math.round(phantoms / successes * 100);
    // Check if ANY recent event found products (healthy watermark)
    var recentWithProducts = events.slice(0, 10).filter(e => e.status === 'success' && e.matchesFound > 0).length;

    if (phantomRate === 100 && recentWithProducts === 0) {
      issues.push(makeIssue('WATERMARK_NEVER_FINDS_PRODUCTS',
        'Last 50 crawl events all found 0 products — watermark may be stuck or adapter broken',
        { phantoms, successes },
        'high'));
      results.push(fail(`All ${successes} crawl events found 0 products — watermark not working`));
    } else if (phantomRate > 80 && recentWithProducts === 0) {
      issues.push(makeIssue('WATERMARK_RARELY_FINDS_PRODUCTS',
        `${phantomRate}% of crawls found 0 products, none in last 10 — watermark may be degraded`,
        { phantoms, successes, phantomRate },
        'medium'));
      results.push(warn(`${phantomRate}% of crawls found 0 products`));
    } else {
      results.push(info(`${phantomRate}% of watermark crawls found 0 new products (normal if site has low turnover)`));
    }
  }

  // Success rate
  if (successRate < 50) {
    issues.push(makeIssue('LOW_SUCCESS_RATE', `Only ${successRate}% success rate`, { successRate }, 'high'));
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
    results.push(info(`Response time: recent avg ${Math.round(recentAvg)}ms, older avg ${Math.round(olderAvg)}ms`));
    if (recentAvg > olderAvg * 2) {
      issues.push(makeIssue('RESPONSE_TIME_DEGRADING',
        `Response time doubled: ${Math.round(olderAvg)}ms → ${Math.round(recentAvg)}ms`,
        { recentAvg: Math.round(recentAvg), olderAvg: Math.round(olderAvg) },
        'medium'));
      results.push(warn('Response times degrading'));
    }
  }

  // Error clustering
  var errorCounts = {};
  events.filter(e => e.errorMessage).forEach(e => {
    var key = (e.errorMessage || '').substring(0, 60);
    errorCounts[key] = (errorCounts[key] || 0) + 1;
  });
  var repeatingErrors = Object.entries(errorCounts).filter(([, count]) => count >= 3);
  if (repeatingErrors.length > 0) {
    for (var [msg, count] of repeatingErrors) {
      issues.push(makeIssue('REPEATING_ERROR',
        `Error repeated ${count}x: "${msg}"`,
        { error: msg, count },
        'medium'));
      results.push(warn(`Repeating error (${count}x): ${msg}`));
    }
  }

  // Crawl gap detection
  if (events.length >= 2) {
    var gaps = [];
    for (var i = 0; i < events.length - 1; i++) {
      var gapMs = new Date(events[i].crawledAt).getTime() - new Date(events[i + 1].crawledAt).getTime();
      gaps.push(gapMs);
    }
    var maxGapHrs = Math.round(Math.max(...gaps) / 3600000);
    if (maxGapHrs > 6) {
      issues.push(makeIssue('CRAWL_GAP',
        `Largest gap between crawls: ${maxGapHrs}h`,
        { maxGapHrs },
        maxGapHrs > 24 ? 'high' : 'low'));
      results.push(maxGapHrs > 24 ? fail(`${maxGapHrs}h gap in crawl history`) : warn(`${maxGapHrs}h gap in crawl history`));
    }
  }

  var hasFail = issues.some(i => i.severity === 'high');
  var hasWarn = issues.some(i => i.severity === 'medium');
  return { probe: 'A2-crawl-events', verdict: hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS', issues, details: results };
}

// ── Probe A3: Product Index Health ──────────────────────────────────────────
async function probeA3_ProductIndex(site) {
  var results = [];
  var issues = [];

  var total = await prisma.productIndex.count({ where: { siteId: site.id } });
  var active = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true } });
  var inactive = total - active;

  if (total === 0) {
    issues.push(makeIssue('NO_PRODUCTS', 'Zero products indexed', null, 'high'));
    return { probe: 'A3-product-index', verdict: 'FAIL', issues, details: [fail('No products indexed')] };
  }

  results.push(info(`${total} products (${active} active, ${inactive} inactive)`));

  // Freshness: lastSeenAt distribution
  var now = new Date();
  var d1 = new Date(now - 24 * 3600000);
  var d7 = new Date(now - 7 * 24 * 3600000);
  var d30 = new Date(now - 30 * 24 * 3600000);

  var seen24h = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true, lastSeenAt: { gte: d1 } } });
  var seen7d = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true, lastSeenAt: { gte: d7 } } });
  var seen30d = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true, lastSeenAt: { gte: d30 } } });

  results.push(info(`Active seen in 24h: ${seen24h}/${active} (${pct(seen24h, active)})`));
  results.push(info(`Active seen in 7d: ${seen7d}/${active} (${pct(seen7d, active)})`));
  results.push(info(`Active seen in 30d: ${seen30d}/${active} (${pct(seen30d, active)})`));

  if (seen7d < active * 0.5) {
    issues.push(makeIssue('STALE_PRODUCTS',
      `Only ${pct(seen7d, active)} of active products seen in last 7 days`,
      { seen7d, active, pct: Math.round(seen7d / active * 100) },
      'high'));
    results.push(fail(`Most active products are stale (${pct(seen7d, active)} seen in 7d)`));
  } else if (seen7d < active * 0.8) {
    issues.push(makeIssue('MODERATELY_STALE',
      `${pct(seen7d, active)} of active products seen in last 7 days`,
      { seen7d, active }, 'medium'));
    results.push(warn(`${pct(seen7d, active)} seen in 7d`));
  } else {
    results.push(pass(`${pct(seen7d, active)} seen in 7d`));
  }

  // New product discovery
  var newIn7d = await prisma.productIndex.count({ where: { siteId: site.id, firstSeenAt: { gte: d7 } } });
  results.push(info(`New products in 7d: ${newIn7d}`));
  if (newIn7d === 0) {
    issues.push(makeIssue('NO_NEW_PRODUCTS_7D',
      'No new products discovered in 7 days — watermark may be stuck',
      null, 'medium'));
    results.push(warn('No new products in 7 days'));
  }

  // Price/stock null rates
  var noPrice = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true, price: null } });
  var noStock = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true, stockStatus: null } });
  var noThumb = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true, thumbnail: null } });

  var pricePct = active > 0 ? Math.round((active - noPrice) / active * 100) : 0;
  var stockPct = active > 0 ? Math.round((active - noStock) / active * 100) : 0;
  var thumbPct = active > 0 ? Math.round((active - noThumb) / active * 100) : 0;

  results.push(info(`Price coverage: ${pricePct}% | Stock coverage: ${stockPct}% | Thumbnail coverage: ${thumbPct}%`));

  if (pricePct < 50) {
    issues.push(makeIssue('LOW_PRICE_COVERAGE', `Only ${pricePct}% of products have prices`, { pricePct }, 'high'));
    results.push(fail(`Price coverage: ${pricePct}%`));
  } else if (pricePct < 80) {
    issues.push(makeIssue('MODERATE_PRICE_COVERAGE', `${pricePct}% price coverage`, { pricePct }, 'medium'));
    results.push(warn(`Price coverage: ${pricePct}%`));
  }

  if (thumbPct < 50) {
    issues.push(makeIssue('LOW_THUMBNAIL_COVERAGE', `Only ${thumbPct}% of products have thumbnails`, { thumbPct }, 'high'));
  }

  // Stale active products (>14 days unseen)
  var d14 = new Date(now - 14 * 24 * 3600000);
  var staleActive = await prisma.productIndex.count({
    where: { siteId: site.id, isActive: true, lastSeenAt: { lt: d14 } },
  });
  if (staleActive > 0) {
    issues.push(makeIssue('STALE_ACTIVE_PRODUCTS',
      `${staleActive} active products not seen in >14 days — should be deactivated`,
      { staleActive },
      'low', true, 'Deactivate products where lastSeenAt < 14 days ago'));
    results.push(warn(`${staleActive} stale active products (>14d unseen)`));
  }

  var hasFail = issues.some(i => i.severity === 'high');
  var hasWarn = issues.some(i => i.severity === 'medium');
  return { probe: 'A3-product-index', verdict: hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS', issues, details: results };
}

// ── Probe A4: Watermark State ───────────────────────────────────────────────
async function probeA4_Watermark(site) {
  var results = [];
  var issues = [];

  if (!site.lastWatermarkUrl) {
    issues.push(makeIssue('NO_WATERMARK', 'No watermark URL set — watermark crawl may never have succeeded', null, 'high'));
    results.push(fail('No watermark URL'));
  } else {
    results.push(info(`Watermark: ${site.lastWatermarkUrl.substring(0, 80)}...`));

    // Check how old the watermark product is
    var wmProduct = await prisma.productIndex.findFirst({
      where: { siteId: site.id, url: site.lastWatermarkUrl },
      select: { firstSeenAt: true, lastSeenAt: true, isActive: true, title: true },
    });

    if (!wmProduct) {
      issues.push(makeIssue('WATERMARK_PRODUCT_MISSING',
        'Watermark URL not found in ProductIndex — product may have been removed from site',
        { url: site.lastWatermarkUrl },
        'medium', true, 'Reset lastWatermarkUrl to null'));
      results.push(warn('Watermark product not in our index'));
    } else {
      var wmAge = Math.round((Date.now() - new Date(wmProduct.firstSeenAt).getTime()) / 86400000);
      results.push(info(`Watermark product: "${wmProduct.title}" — first seen ${wmAge}d ago, active=${wmProduct.isActive}`));

      if (wmAge > 14) {
        issues.push(makeIssue('WATERMARK_OLD',
          `Watermark product is ${wmAge} days old — new arrivals page may have changed`,
          { wmAge, title: wmProduct.title },
          'medium'));
        results.push(warn(`Watermark is ${wmAge} days old`));
      }
    }
  }

  // Schedule info
  results.push(info(`Last crawl: ${ago(site.lastCrawlAt)}`));
  results.push(info(`Next crawl: ${site.nextCrawlAt ? ago(site.nextCrawlAt) : 'not scheduled'}`));

  var hasFail = issues.some(i => i.severity === 'high');
  var hasWarn = issues.some(i => i.severity === 'medium');
  return { probe: 'A4-watermark', verdict: hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS', issues, details: results };
}

// ═══════════════════════════════════════════════════════════════════════════
// CATEGORY B: LIVE BEHAVIOR (HTTP)
// ═══════════════════════════════════════════════════════════════════════════

var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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

async function delay(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

// ── Probe B1: Platform Detection ────────────────────────────────────────────
async function probeB1_PlatformDetect(site) {
  var results = [];
  var issues = [];
  var origin = site.url.replace(/\/$/, '');

  // Try WooCommerce WP REST API
  var wpResp = await safeFetch(origin + '/wp-json/wp/v2/product?per_page=1', 5000);
  await delay(300);

  // Try WooCommerce Store API
  var storeResp = await safeFetch(origin + '/wp-json/wc/store/v1/products?per_page=1', 5000);
  await delay(300);

  // Try Shopify
  var shopifyResp = await safeFetch(origin + '/products.json?limit=1', 5000);
  await delay(300);

  // Fetch homepage for platform signatures
  var homeResp = await safeFetch(origin, 10000);

  var detected = null;
  var signals = [];

  if (wpResp.status === 200) {
    signals.push('WP REST API responds (WooCommerce)');
    detected = 'woocommerce';
  }
  if (storeResp.status === 200) {
    signals.push('WC Store API responds (WooCommerce)');
    detected = 'woocommerce';
  }
  if (shopifyResp.status === 200 && shopifyResp.data.includes('"products"')) {
    signals.push('Shopify products.json responds');
    detected = 'shopify';
  }

  // HTML signatures
  var html = homeResp.data || '';
  if (html.includes('wp-content') || html.includes('woocommerce')) signals.push('WP/WooCommerce HTML signatures');
  if (html.includes('cdn.shopify.com') || html.includes('Shopify.theme')) signals.push('Shopify HTML signatures');
  if (html.includes('data-product-id')) signals.push('BigCommerce data-product-id');
  if (html.includes('Magento') || html.includes('mage-')) signals.push('Magento HTML signatures');
  if (html.includes('drupalSettings') || html.includes('Drupal')) signals.push('Drupal HTML signatures');

  if (!detected && html.includes('wp-content')) detected = 'woocommerce';
  if (!detected && html.includes('cdn.shopify.com')) detected = 'shopify';

  results.push(info(`Current adapter: ${site.adapterType}`));
  results.push(info(`Platform signals: ${signals.length > 0 ? signals.join(', ') : 'none detected'}`));

  // Only flag adapter mismatch if current adapter is generic (specialized adapters like classifieds-gunpost are intentional)
  var specializedAdapters = ['classifieds-gunpost', 'forum-xenforo', 'forum-vbulletin', 'auction-hibid', 'auction-icollector', 'auction-generic'];
  if (detected && detected !== site.adapterType && !specializedAdapters.includes(site.adapterType)) {
    issues.push(makeIssue('WRONG_ADAPTER_TYPE',
      `Detected platform "${detected}" but site uses "${site.adapterType}" adapter`,
      { detected, current: site.adapterType, signals },
      'high', true, `Change adapterType to "${detected}"`));
    results.push(fail(`Adapter mismatch: using ${site.adapterType} but detected ${detected}`));
  } else if (detected) {
    results.push(pass(`Adapter matches detected platform: ${detected}`));
  } else {
    results.push(info(`No specific platform detected — generic-retail may be correct`));
  }

  // WAF detection on homepage
  if (homeResp.data.includes('_Incapsula_Resource')) {
    signals.push('Incapsula WAF detected');
    if (!site.hasWaf) {
      issues.push(makeIssue('UNDETECTED_WAF', 'Incapsula WAF detected but hasWaf=false', null, 'medium', true, 'Set hasWaf=true'));
    }
  }
  if (homeResp.data.includes('sucuri_cloudproxy') || homeResp.data.includes('Sucuri Inc')) {
    signals.push('Sucuri WAF detected');
  }
  if (homeResp.data.includes('cf-browser-verification') || homeResp.data.includes('Just a moment')) {
    signals.push('Cloudflare challenge detected');
    if (!site.hasWaf) {
      issues.push(makeIssue('UNDETECTED_WAF', 'Cloudflare challenge detected but hasWaf=false', null, 'medium', true, 'Set hasWaf=true'));
    }
  }

  // Silent block detection: 200 but tiny body
  if (homeResp.status === 200 && homeResp.data.length < 2000) {
    issues.push(makeIssue('POSSIBLE_SILENT_BLOCK',
      `Homepage returns 200 but only ${homeResp.data.length} bytes — may be WAF block page`,
      { bodySize: homeResp.data.length },
      'medium'));
    results.push(warn(`Homepage body only ${homeResp.data.length} bytes`));
  }

  var hasFail = issues.some(i => i.severity === 'high');
  var hasWarn = issues.some(i => i.severity === 'medium');
  return { probe: 'B1-platform-detect', verdict: hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS', issues, details: results };
}

// ── Probe B4: Pagination Discovery ──────────────────────────────────────────
async function probeB4_Pagination(site) {
  var results = [];
  var issues = [];
  var ss = site.streamState;

  if (!ss || !ss.streams || ss.streams.length === 0) {
    results.push(info('No streams — skipping pagination check'));
    return { probe: 'B4-pagination', verdict: 'SKIP', issues, details: results };
  }

  var htmlStreams = ss.streams.filter(s => s.type === 'html');
  if (htmlStreams.length === 0) {
    results.push(info('No HTML streams — pagination check N/A (API streams use date ranges)'));
    return { probe: 'B4-pagination', verdict: 'PASS', issues, details: results };
  }

  // Check up to 3 streams
  var toCheck = htmlStreams.slice(0, 3);
  for (var stream of toCheck) {
    await delay(500);
    var resp = await safeFetch(stream.url, 10000);

    if (resp.status !== 200 || resp.data.length < 500) {
      results.push(warn(`${stream.id}: HTTP ${resp.status}, ${resp.data.length} bytes — may be blocked`));
      continue;
    }

    // Look for pagination patterns in HTML
    var html = resp.data;
    var pageLinks = [];
    var pageRegex = /[?&]page=(\d+)|\/page\/(\d+)/gi;
    var match;
    while ((match = pageRegex.exec(html)) !== null) {
      var num = parseInt(match[1] || match[2], 10);
      if (num > 0 && num < 100000) pageLinks.push(num);
    }

    var maxPage = pageLinks.length > 0 ? Math.max(...pageLinks) : 0;
    var storedPages = stream.totalPages || 0;

    if (maxPage > 0) {
      results.push(info(`${stream.id}: ${maxPage} pages detected from HTML (stored: ${storedPages || 'none'})`));
      if (storedPages === 0) {
        issues.push(makeIssue('TOTAL_PAGES_NOT_STORED',
          `Stream "${stream.id}" has ${maxPage} pages but totalPages not stored`,
          { streamId: stream.id, detectedPages: maxPage, storedPages },
          'medium', true, 'Update stream.totalPages and re-partition tier ranges'));
      }
    } else {
      results.push(info(`${stream.id}: No pagination detected (single page or JS-rendered)`));
    }
  }

  var hasFail = issues.some(i => i.severity === 'high');
  var hasWarn = issues.some(i => i.severity === 'medium');
  return { probe: 'B4-pagination', verdict: hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS', issues, details: results };
}

// ═══════════════════════════════════════════════════════════════════════════
// CATEGORY C: END-TO-END SIMULATION
// ═══════════════════════════════════════════════════════════════════════════

// ── Probe C1: Multi-Keyword Search ──────────────────────────────────────────
async function probeC1_MultiKeywordSearch(site) {
  var results = [];
  var issues = [];

  var totalDbResults = 0;
  var keywordsWithResults = 0;
  var keywordsWithZero = 0;

  for (var kw of TEST_KEYWORDS) {
    // Query our product index for this keyword on this site
    var dbProducts = await prisma.productIndex.findMany({
      where: {
        siteId: site.id,
        isActive: true,
        title: { contains: kw.keyword, mode: 'insensitive' },
      },
      select: { title: true, price: true, stockStatus: true },
      take: 20,
    });

    var count = dbProducts.length;
    totalDbResults += count;
    if (count > 0) keywordsWithResults++;
    else keywordsWithZero++;

    var priceRate = count > 0 ? Math.round(dbProducts.filter(p => p.price != null).length / count * 100) : 0;
    results.push(info(`"${kw.keyword}" (${kw.type}): ${count} results${count > 0 ? ` (${priceRate}% with price)` : ''}`));
  }

  results.push(info(`Summary: ${keywordsWithResults}/${TEST_KEYWORDS.length} keywords returned results, ${totalDbResults} total products`));

  if (keywordsWithResults === 0) {
    issues.push(makeIssue('NO_KEYWORD_MATCHES',
      'Zero of 6 test keywords matched any indexed products — site may not be crawled or adapter broken',
      { testedKeywords: TEST_KEYWORDS.map(k => k.keyword) },
      'high'));
    results.push(fail('No keyword matches at all'));
  } else if (keywordsWithResults <= 2) {
    issues.push(makeIssue('FEW_KEYWORD_MATCHES',
      `Only ${keywordsWithResults}/6 keywords matched — catalog coverage may be poor`,
      { keywordsWithResults },
      'medium'));
    results.push(warn(`Only ${keywordsWithResults}/6 keywords matched`));
  } else {
    results.push(pass(`${keywordsWithResults}/6 keywords matched`));
  }

  var hasFail = issues.some(i => i.severity === 'high');
  var hasWarn = issues.some(i => i.severity === 'medium');
  return { probe: 'C1-keyword-search', verdict: hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS', issues, details: results };
}

// ── Probe C2: Product Spot-Check ────────────────────────────────────────────
async function probeC2_ProductSpotCheck(site) {
  var results = [];
  var issues = [];

  // Get 5 random active products
  var products = await prisma.productIndex.findMany({
    where: { siteId: site.id, isActive: true },
    select: { url: true, title: true, price: true },
    take: 100,
  });

  if (products.length === 0) {
    results.push(fail('No active products to spot-check'));
    return { probe: 'C2-spot-check', verdict: 'FAIL', issues, details: results };
  }

  // Pick 5 random
  var sample = [];
  var shuffled = products.sort(function() { return 0.5 - Math.random(); });
  sample = shuffled.slice(0, 5);

  var alive = 0;
  var dead = 0;

  for (var product of sample) {
    await delay(500);
    var resp = await safeFetch(product.url, 8000);

    if (resp.status === 200 && resp.data.length > 1000) {
      alive++;
      // Check if title appears on page (rough check)
      var titleWords = product.title.split(/\s+/).slice(0, 3).join(' ');
      if (resp.data.toLowerCase().includes(titleWords.toLowerCase())) {
        results.push(pass(`"${product.title.substring(0, 50)}" — page exists, title matches`));
      } else {
        results.push(warn(`"${product.title.substring(0, 50)}" — page exists but title not found in HTML`));
      }
    } else if (resp.status === 404) {
      dead++;
      results.push(fail(`"${product.title.substring(0, 50)}" — 404 (product removed from site)`));
    } else {
      results.push(warn(`"${product.title.substring(0, 50)}" — HTTP ${resp.status} (${resp.data.length} bytes)`));
    }
  }

  if (dead >= 3) {
    issues.push(makeIssue('MANY_DEAD_PRODUCTS',
      `${dead}/5 spot-checked products returned 404 — catalog data is stale`,
      { dead, checked: 5 },
      'high'));
    results.push(fail(`${dead}/5 products are dead (404)`));
  } else if (dead >= 1) {
    issues.push(makeIssue('SOME_DEAD_PRODUCTS',
      `${dead}/5 spot-checked products returned 404`,
      { dead },
      'medium'));
  }

  var hasFail = issues.some(i => i.severity === 'high');
  var hasWarn = issues.some(i => i.severity === 'medium');
  return { probe: 'C2-spot-check', verdict: hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS', issues, details: results };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function investigateSite(domain, options) {
  var site = await prisma.monitoredSite.findUnique({
    where: { domain },
    select: {
      id: true, domain: true, name: true, url: true,
      adapterType: true, siteType: true,
      isEnabled: true, isPaused: true, hasWaf: true,
      consecutiveFailures: true,
      lastWatermarkUrl: true, lastCrawlAt: true, nextCrawlAt: true,
      streamState: true, baseBudget: true,
    },
  });

  if (!site) {
    console.error(`Site not found: ${domain}`);
    return null;
  }

  var report = {
    domain: site.domain,
    name: site.name,
    adapter: site.adapterType,
    siteType: site.siteType,
    enabled: site.isEnabled,
    paused: site.isPaused,
    hasWaf: site.hasWaf,
    consecutiveFailures: site.consecutiveFailures,
    probes: {},
    allIssues: [],
    summary: { PASS: 0, WARN: 0, FAIL: 0, SKIP: 0 },
  };

  // ── Category A: DB State ──
  if (!options.json) {
    console.log(`\n${C.bold}${C.cyan}═══ CATEGORY A: DB STATE ═══${C.reset}`);
  }

  var probes = [
    { name: 'A1', fn: function() { return probeA1_StreamState(site); } },
    { name: 'A2', fn: function() { return probeA2_CrawlEvents(site); } },
    { name: 'A3', fn: function() { return probeA3_ProductIndex(site); } },
    { name: 'A4', fn: function() { return probeA4_Watermark(site); } },
  ];

  if (!options.dbOnly) {
    probes.push(
      { name: 'B1', fn: function() { return probeB1_PlatformDetect(site); } },
      { name: 'B4', fn: function() { return probeB4_Pagination(site); } },
      { name: 'C1', fn: function() { return probeC1_MultiKeywordSearch(site); } },
      { name: 'C2', fn: function() { return probeC2_ProductSpotCheck(site); } }
    );
  }

  for (var probe of probes) {
    var result = await probe.fn();
    report.probes[result.probe] = result;
    report.summary[result.verdict] = (report.summary[result.verdict] || 0) + 1;
    report.allIssues.push(...result.issues);

    if (!options.json) {
      var verdictColor = result.verdict === 'PASS' ? C.green : result.verdict === 'FAIL' ? C.red : result.verdict === 'WARN' ? C.yellow : C.dim;
      console.log(`\n${C.bold}[${probe.name}] ${result.probe} — ${verdictColor}${result.verdict}${C.reset}`);
      result.details.forEach(function(d) { console.log('  ' + d); });
    }
  }

  // ── Summary ──
  if (!options.json) {
    console.log(`\n${C.bold}${C.magenta}═══ SUMMARY: ${site.domain} ═══${C.reset}`);
    console.log(`  PASS: ${report.summary.PASS} | WARN: ${report.summary.WARN} | FAIL: ${report.summary.FAIL} | SKIP: ${report.summary.SKIP || 0}`);
    console.log(`  Total issues: ${report.allIssues.length}`);
    var high = report.allIssues.filter(function(i) { return i.severity === 'high'; });
    var medium = report.allIssues.filter(function(i) { return i.severity === 'medium'; });
    var low = report.allIssues.filter(function(i) { return i.severity === 'low'; });
    if (high.length) console.log(`  ${C.red}HIGH: ${high.length}${C.reset} — ${high.map(function(i) { return i.code; }).join(', ')}`);
    if (medium.length) console.log(`  ${C.yellow}MEDIUM: ${medium.length}${C.reset} — ${medium.map(function(i) { return i.code; }).join(', ')}`);
    if (low.length) console.log(`  ${C.dim}LOW: ${low.length}${C.reset}`);
  }

  return report;
}

async function main() {
  var args = process.argv.slice(2);
  var domain = args.find(function(a) { return !a.startsWith('--'); });
  var jsonOutput = args.includes('--json');
  var dbOnly = args.includes('--db-only');

  if (!domain) {
    console.error('Usage: node scripts/investigate-site.js <domain> [--json] [--db-only]');
    process.exit(1);
  }

  if (!jsonOutput) {
    console.log(`${C.bold}${C.white}╔═══════════════════════════════════════════════════════════╗${C.reset}`);
    console.log(`${C.bold}${C.white}║  SITE INVESTIGATION: ${domain.padEnd(37)}║${C.reset}`);
    console.log(`${C.bold}${C.white}╚═══════════════════════════════════════════════════════════╝${C.reset}`);
  }

  var report = await investigateSite(domain, { json: jsonOutput, dbOnly: dbOnly });

  if (jsonOutput && report) {
    console.log(JSON.stringify(report, null, 2));
  }

  await prisma.$disconnect();
}

main().catch(function(err) { console.error(err); process.exit(1); });
