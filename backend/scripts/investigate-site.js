/**
 * Site Investigation Script — Deep Behavioral Analysis
 *
 * 14 probes across 3 categories:
 *   Category A (DB State):  A1-StreamState, A2-CrawlEvents, A3-ProductIndex, A4-Watermark, A5-SourceIdCoverage
 *   Category B (Live):      B1-PlatformDetect, B2-WAFDetect, B3-SelectorValidation, B4-Pagination
 *   Category C (Simulate):  C1-MultiKeywordSearch, C2-ProductSpotCheck, C3-WatermarkSim, C4-DuplicateDetection
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
  // Short / basic
  { keyword: 'SKS', type: 'short' },
  { keyword: '9mm', type: 'caliber-short' },
  { keyword: '.308', type: 'caliber-dot' },
  { keyword: '.22 LR', type: 'caliber-space' },
  { keyword: '7.62x39', type: 'caliber-x' },
  // Brand + model
  { keyword: 'Ruger 10/22', type: 'brand-model-slash' },
  { keyword: 'AR-15', type: 'brand-hyphen' },
  { keyword: 'tikka t3x', type: 'brand-model-lower' },
  { keyword: 'GSG-16', type: 'model-hyphen-number' },
  // Category / type
  { keyword: 'magazine', type: 'ambiguous' },
  { keyword: 'shotgun', type: 'category' },
  { keyword: 'surplus', type: 'condition' },
  { keyword: 'scope', type: 'accessory' },
  { keyword: 'Federal', type: 'ammo-brand' },
  { keyword: 'FMJ', type: 'ammo-type' },
  { keyword: 'primer', type: 'reloading' },
  { keyword: 'holster', type: 'accessory-2' },
  { keyword: 'Glock 19', type: 'handgun' },
  { keyword: '12 gauge', type: 'gauge' },
  { keyword: 'used rifle', type: 'condition-category' },
  // Long / complex
  { keyword: 'Savage 110 Ultralite .308', type: 'brand-model-caliber' },
  { keyword: 'Winchester SXP 12ga pump', type: 'brand-model-gauge-type' },
  { keyword: 'Vortex Crossfire II 4-12x44', type: 'optics-magnification' },
  { keyword: 'CCI Blazer 9mm 115gr FMJ', type: 'full-ammo-spec' },
  { keyword: 'Remington 870 Express 12 gauge pump shotgun', type: 'long-descriptive' },
  { keyword: 'norinco type 97', type: 'foreign-brand' },
  { keyword: 'stripped lower receiver', type: 'parts-description' },
  { keyword: '10 round magazine .223', type: 'capacity-type-caliber' },
  { keyword: '$500 rifle', type: 'price-in-keyword' },
  { keyword: 'mauser 270 win bolt action', type: 'multi-attribute' },
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

// ── Probe A5: sourceId Coverage ──────────────────────────────────────────
async function probeA5_SourceIdCoverage(site) {
  var results = [];
  var issues = [];

  var total = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true } });
  var withSourceId = await prisma.productIndex.count({ where: { siteId: site.id, isActive: true, sourceId: { not: null } } });
  var withoutSourceId = total - withSourceId;
  var coverage = total === 0 ? 0 : Math.round(withSourceId / total * 100);

  // Determine if adapter type should have sourceId
  var sourceIdAdapters = ['shopify', 'woocommerce', 'classifieds-gunpost', 'auction-icollector', 'auction-hibid', 'forum-xenforo'];
  var shouldHaveSourceId = sourceIdAdapters.includes(site.adapterType);
  var isGenericRetail = site.adapterType === 'generic-retail';

  results.push(info(`sourceId coverage: ${withSourceId}/${total} active products (${coverage}%)`));

  if (total === 0) {
    return { probe: 'A5-sourceid-coverage', verdict: 'SKIP', issues, details: [info('No active products to check')] };
  }

  if (shouldHaveSourceId) {
    if (coverage < 50) {
      issues.push(makeIssue('LOW_SOURCEID_COVERAGE',
        `Only ${coverage}% of active products have sourceId — ${site.adapterType} adapter should populate sourceId`,
        { coverage, withSourceId, total, adapterType: site.adapterType },
        'high', false, 'Check adapter scraping logic for sourceId extraction'));
      results.push(fail(`${coverage}% sourceId coverage — ${site.adapterType} should have near 100%`));
    } else if (coverage < 90) {
      issues.push(makeIssue('PARTIAL_SOURCEID_COVERAGE',
        `${coverage}% sourceId coverage — ${site.adapterType} adapter should be higher`,
        { coverage, withSourceId, total, adapterType: site.adapterType },
        'medium'));
      results.push(warn(`${coverage}% sourceId coverage — expected >90% for ${site.adapterType}`));
    } else {
      results.push(pass(`${coverage}% sourceId coverage (${site.adapterType} adapter)`));
    }
  } else if (isGenericRetail) {
    // generic-retail may or may not have sourceId (BigCommerce has data-product-id, others may not)
    if (coverage > 0) {
      results.push(pass(`${coverage}% sourceId coverage (generic-retail — some sources support it)`));
    } else {
      results.push(info('No sourceId coverage (generic-retail — may not support it)'));
    }
  } else {
    // generic adapter — no sourceId expected
    if (coverage > 0) {
      results.push(info(`${coverage}% sourceId coverage (unexpected for ${site.adapterType} — bonus)`));
    } else {
      results.push(pass(`No sourceId expected for ${site.adapterType} adapter`));
    }
  }

  var hasFail = issues.some(function(i) { return i.severity === 'high'; });
  var hasWarn = issues.some(function(i) { return i.severity === 'medium'; });
  return { probe: 'A5-sourceid-coverage', verdict: hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS', issues, details: results };
}

// ── Probe C4: Duplicate Detection ────────────────────────────────────────
async function probeC4_DuplicateDetection(site) {
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
    results.push(pass('No duplicate sourceIds found among active products'));
    return { probe: 'C4-duplicate-detection', verdict: 'PASS', issues, details: results };
  }

  var totalDupes = dupes.reduce(function(sum, d) { return sum + Number(d.cnt); }, 0);
  results.push(fail(`${dupes.length} sourceId(s) with duplicate active products (${totalDupes} total rows)`));

  for (var i = 0; i < Math.min(dupes.length, 5); i++) {
    results.push(info(`  sourceId="${dupes[i].sourceId}" → ${dupes[i].cnt} active products`));
  }
  if (dupes.length > 5) {
    results.push(info(`  ...and ${dupes.length - 5} more`));
  }

  issues.push(makeIssue('DUPLICATE_SOURCEIDS',
    `${dupes.length} sourceIds have multiple active products — dedup may not be working`,
    { duplicateCount: dupes.length, totalExtraRows: totalDupes, top5: dupes.slice(0, 5) },
    'high', true, 'Run dedup to merge products with same sourceId on same site'));

  return { probe: 'C4-duplicate-detection', verdict: 'FAIL', issues, details: results };
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

// ── Probe C3: Data Accuracy — title, price, thumbnail, sourceId, URL, Match↔PI consistency ────
async function probeC3_DataAccuracy(site, opts) {
  var dbOnly = opts && opts.dbOnly;
  var results = [];
  var issues = [];

  // Determine site classification for context-sensitive checks
  var siteRecord = await prisma.monitoredSite.findUnique({
    where: { id: site.id },
    select: { siteCategory: true, adapterType: true },
  });
  var siteCategory = siteRecord ? siteRecord.siteCategory : 'retailer';
  var adapterType = siteRecord ? siteRecord.adapterType : 'generic';
  var isClassified = siteCategory === 'classified' || siteCategory === 'forum' || siteCategory === 'auction';

  // Adapters known to produce sourceId (Shopify, WooCommerce, Gunpost, etc.)
  var sourceIdAdapters = ['shopify', 'woocommerce', 'woo-api', 'gunpost', 'classifieds-gunpost', 'auction-icollector', 'auction-hibid', 'forum-xenforo'];
  var expectsSourceId = sourceIdAdapters.indexOf(adapterType) !== -1;

  // Get 200 random active products (no price filter — we want to catch missing prices too)
  var products = await prisma.productIndex.findMany({
    where: { siteId: site.id, isActive: true },
    select: { id: true, url: true, title: true, price: true, thumbnail: true, sourceId: true, stockStatus: true },
    take: 200,
  });

  if (products.length < 3) {
    results.push(info('Not enough active products to spot-check data accuracy'));
    return { probe: 'C3-data-accuracy', verdict: 'SKIP', issues, details: results };
  }

  var shuffled = products.sort(function() { return 0.5 - Math.random(); });
  var sample = shuffled.slice(0, 15);

  var titleMismatches = 0;
  var priceMismatches = 0;
  var checked = 0;

  // Counters for new checks
  var thumbMissing = 0;
  var thumbBroken = 0;
  var priceMissing = 0;
  var sourceIdMissing = 0;
  var urlDead = 0;
  var titleEmpty = 0;
  var matchStale = 0;

  for (var product of sample) {
    var productLabel = '"' + (product.title || '(no title)').substring(0, 45) + '"';

    // ── Title check: not empty and not a URL ──
    var titleIsEmpty = !product.title || product.title.trim() === '';
    var titleIsUrl = product.title && /^https?:\/\//i.test(product.title.trim());
    if (titleIsEmpty || titleIsUrl) {
      titleEmpty++;
      var titleReason = titleIsUrl ? 'Title is a URL: ' + product.title.substring(0, 60) : 'Product has empty title';
      issues.push(makeIssue('TITLE_EMPTY', titleReason, { id: product.id, url: product.url, title: product.title }, 'high'));
      results.push(fail('TITLE_EMPTY: ' + (titleIsUrl ? product.title.substring(0, 60) : product.url.substring(0, 60))));
    }

    // ── Price check: not null for retailer sites ──
    if (product.price == null && !isClassified) {
      priceMissing++;
      issues.push(makeIssue('PRICE_MISSING',
        'Retailer product has no price: ' + productLabel,
        { id: product.id, url: product.url },
        'high'));
      results.push(fail('PRICE_MISSING: ' + productLabel));
    }

    // ── Thumbnail: not null ──
    if (!product.thumbnail) {
      thumbMissing++;
      issues.push(makeIssue('THUMBNAIL_MISSING',
        'Product has no thumbnail: ' + productLabel,
        { id: product.id, url: product.url },
        'medium'));
      results.push(warn('THUMBNAIL_MISSING: ' + productLabel));
    } else if (!dbOnly) {
      // ── Thumbnail: resolves with image content-type (HTTP check) ──
      await delay(500);
      var thumbOk = await safeHeadImage(product.thumbnail);
      if (!thumbOk.ok) {
        thumbBroken++;
        issues.push(makeIssue('THUMBNAIL_BROKEN',
          'Thumbnail URL non-200 or non-image: ' + productLabel + ' (' + thumbOk.reason + ')',
          { id: product.id, thumbnail: product.thumbnail, reason: thumbOk.reason },
          'medium'));
        results.push(warn('THUMBNAIL_BROKEN: ' + productLabel + ' — ' + thumbOk.reason));
      }
    }

    // ── SourceId: not null for adapters that should produce it ──
    if (expectsSourceId && !product.sourceId) {
      sourceIdMissing++;
      issues.push(makeIssue('SOURCEID_MISSING',
        'Product on ' + adapterType + ' adapter has no sourceId: ' + productLabel,
        { id: product.id, url: product.url, adapter: adapterType },
        'medium'));
      // Only log first few to avoid spam
      if (sourceIdMissing <= 3) results.push(info('SOURCEID_MISSING: ' + productLabel));
    }

    // ── URL resolves (not 404) — only flag confirmed 404s, not other errors ──
    var urlCheck = { ok: true }; // default for db-only mode
    if (!dbOnly) {
      await delay(500);
      urlCheck = await safeHeadUrl(product.url);
      if (!urlCheck.ok && urlCheck.reason === 'HTTP 404') {
        urlDead++;
        issues.push(makeIssue('URL_DEAD',
          'Product URL returns 404: ' + productLabel,
          { id: product.id, url: product.url, reason: urlCheck.reason },
          'high'));
        results.push(fail('URL_DEAD: ' + productLabel + ' — ' + urlCheck.reason));
      }
    }

    // ── Match↔ProductIndex consistency: if Matches reference this product, verify data matches ──
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
        issues.push(makeIssue('MATCH_STALE',
          'Match ' + m.id.substring(0, 8) + ' differs from PI on: ' + staleFields.join(', ') +
          (staleFields.indexOf('title') !== -1 ? ' (Match="' + m.title.substring(0, 30) + '" vs PI="' + product.title.substring(0, 30) + '")' : '') +
          (staleFields.indexOf('price') !== -1 ? ' (Match=$' + m.price + ' vs PI=$' + product.price + ')' : ''),
          { matchId: m.id, productId: product.id, staleFields: staleFields },
          'high'));
        if (matchStale <= 3) results.push(fail('MATCH_STALE: Match→PI mismatch on ' + staleFields.join(', ') + ' for ' + productLabel));
      }
    }

    // ── Live page comparison (original C3 logic): fetch page, compare title & price ──
    if (!dbOnly && urlCheck.ok) {
      await delay(500);
      var resp = await safeFetch(product.url, 10000);

      if (resp.status === 200 && resp.data.length >= 500) {
        checked++;
        var html = resp.data;

        // Title check vs live h1
        var pageTitleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
        var pageTitle = pageTitleMatch ? pageTitleMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : null;

        if (pageTitle) {
          var dbNorm = product.title.replace(/\s+/g, ' ').trim().toLowerCase();
          var pageNorm = pageTitle.toLowerCase();
          var titleMatchOk = dbNorm === pageNorm || pageNorm.startsWith(dbNorm) || dbNorm.startsWith(pageNorm);

          if (!titleMatchOk) {
            titleMismatches++;
            issues.push(makeIssue('TITLE_MISMATCH',
              'DB: "' + product.title.substring(0, 60) + '" vs Page: "' + pageTitle.substring(0, 60) + '"',
              { dbTitle: product.title, pageTitle: pageTitle, url: product.url },
              'medium'));
            results.push(warn('Title mismatch: DB="' + product.title.substring(0, 45) + '" vs Page="' + pageTitle.substring(0, 45) + '"'));
          }
        }

        // Price check vs live page
        if (product.price) {
          var priceStr = product.price.toFixed(2);
          var priceInt = Math.round(product.price).toString();
          var priceOnPage = html.includes(priceStr) || html.includes(priceInt + '.') || html.includes('$' + priceStr) || html.includes('$' + priceInt);

          if (!priceOnPage) {
            priceMismatches++;
            var priceMatches = html.match(/\$[\d,]+\.\d{2}/g) || [];
            var uniquePrices = Array.from(new Set(priceMatches)).slice(0, 5);
            issues.push(makeIssue('PRICE_MISMATCH',
              'DB price $' + priceStr + ' not found on page. Page prices: ' + (uniquePrices.join(', ') || 'none found'),
              { dbPrice: product.price, pagePrices: uniquePrices, url: product.url },
              'high'));
            results.push(fail('Price mismatch: DB=$' + priceStr + ' not on page. Found: ' + (uniquePrices.join(', ') || 'none') + ' — ' + product.url.substring(0, 60)));
          }
        }
      }
    }
  }

  // ── Summary ──
  results.push(info('Checked ' + sample.length + ' products (' + checked + ' live-compared): ' +
    titleMismatches + ' title mismatches, ' + priceMismatches + ' price mismatches'));
  results.push(info('Completeness: ' + thumbMissing + ' thumb_missing, ' + thumbBroken + ' thumb_broken, ' +
    priceMissing + ' price_missing, ' + sourceIdMissing + ' sourceId_missing, ' +
    urlDead + ' url_dead, ' + titleEmpty + ' title_empty, ' + matchStale + ' match_stale'));

  if (titleMismatches === 0 && priceMismatches === 0 && thumbMissing === 0 && thumbBroken === 0 &&
      priceMissing === 0 && urlDead === 0 && titleEmpty === 0 && matchStale === 0 && sourceIdMissing === 0) {
    results.push(pass('All sampled products pass completeness and accuracy checks'));
  }

  // ── SYSTEMATIC detection: 3+ of same issue type = adapter-level bug ──
  var systematicChecks = [
    { count: priceMismatches, code: 'SYSTEMATIC_PRICE_ERRORS', label: 'wrong prices — adapter price extraction may be broken', field: 'priceMismatches' },
    { count: titleMismatches, code: 'SYSTEMATIC_TITLE_ERRORS', label: 'wrong titles — adapter title extraction may be broken', field: 'titleMismatches' },
    { count: thumbMissing, code: 'SYSTEMATIC_THUMBNAIL_MISSING', label: 'missing thumbnails — adapter thumbnail extraction may be broken', field: 'thumbMissing' },
    { count: thumbBroken, code: 'SYSTEMATIC_THUMBNAIL_BROKEN', label: 'broken thumbnail URLs — image hosting or extraction issue', field: 'thumbBroken' },
    { count: priceMissing, code: 'SYSTEMATIC_PRICE_MISSING', label: 'missing prices — adapter not extracting prices', field: 'priceMissing' },
    { count: sourceIdMissing, code: 'SYSTEMATIC_SOURCEID_MISSING', label: 'missing sourceIds — adapter not extracting sourceId', field: 'sourceIdMissing' },
    { count: urlDead, code: 'SYSTEMATIC_URL_DEAD', label: 'dead URLs (404) — stale products not being deactivated', field: 'urlDead' },
    { count: titleEmpty, code: 'SYSTEMATIC_TITLE_EMPTY', label: 'empty/URL titles — adapter title extraction broken', field: 'titleEmpty' },
    { count: matchStale, code: 'SYSTEMATIC_MATCH_STALE', label: 'stale Match records — enrichment not propagating updates', field: 'matchStale' },
  ];
  for (var sc of systematicChecks) {
    if (sc.count >= 3) {
      var evidence = {};
      evidence[sc.field] = sc.count;
      evidence.sampleSize = sample.length;
      issues.push(makeIssue(sc.code,
        sc.count + '/' + sample.length + ' products have ' + sc.label,
        evidence,
        'high'));
      results.push(fail('SYSTEMATIC: ' + sc.count + '/' + sample.length + ' ' + sc.label));
    }
  }

  var hasFail = issues.some(function(i) { return i.severity === 'high'; });
  var hasWarn = issues.some(function(i) { return i.severity === 'medium'; });
  return { probe: 'C3-data-accuracy', verdict: hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS', issues: issues, details: results };
}

// ── C3 Helpers: HTTP HEAD checks ──────────────────────────────────────────
async function safeHeadImage(url) {
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

async function safeHeadUrl(url) {
  if (!url) return { ok: false, reason: 'null' };
  try {
    var resp = await axios.head(url, {
      headers: { 'User-Agent': UA },
      timeout: 10000,
      maxRedirects: 5,
      validateStatus: function() { return true; },
    });
    if (resp.status >= 200 && resp.status < 400) return { ok: true, status: resp.status };
    if (resp.status === 403) return { ok: true, status: resp.status }; // WAF
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
    if (resp.status === 404) return { ok: false, reason: 'HTTP 404' };
    return { ok: false, reason: 'HTTP ' + resp.status };
  } catch (err) {
    return { ok: false, reason: err.message.substring(0, 80) };
  }
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
    { name: 'A5', fn: function() { return probeA5_SourceIdCoverage(site); } },
    { name: 'C4', fn: function() { return probeC4_DuplicateDetection(site); } },
    { name: 'C3', fn: function() { return probeC3_DataAccuracy(site, { dbOnly: options.dbOnly }); } },
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
