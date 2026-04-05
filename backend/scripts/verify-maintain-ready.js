/**
 * Verify if a site is ready to transition from bootstrap to maintain phase.
 * Checks: DB count vs live, T1 watermark working, all products indexed.
 *
 * Usage: node scripts/verify-maintain-ready.js <domain> [--transition]
 */
require('dotenv').config();
require('ts-node').register({ transpileOnly: true, project: require('path').join(__dirname, '..', 'tsconfig.json') });
var { PrismaClient } = require('@prisma/client');
var axios = require('axios');
var p = new PrismaClient();

async function main() {
  var domain = process.argv[2];
  var doTransition = process.argv.includes('--transition');
  if (!domain) { console.log('Usage: node verify-maintain-ready.js <domain> [--transition]'); process.exit(1); }

  var site = await p.monitoredSite.findUnique({ where: { domain: domain } });
  if (!site) { console.log('Site not found:', domain); process.exit(1); }

  console.log('=== Verify Maintain Ready: ' + domain + ' ===');
  console.log('Adapter:', site.adapterType, '| Budget:', site.baseBudget, '| Phase:', site.crawlPhase);

  var checks = { dbCount: false, liveCount: null, coverage: false, watermark: false, tiers: false };
  var pass = true;

  // 1. DB product count
  var dbActive = await p.productIndex.count({ where: { siteId: site.id, isActive: true } });
  var dbTotal = await p.productIndex.count({ where: { siteId: site.id } });
  console.log('\n[1] DB: ' + dbActive + ' active / ' + dbTotal + ' total');

  // 2. Live product count (profile-driven — no hardcoded platform checks)
  var liveCount = null;
  var profile = site.siteProfile || {};
  try {
    if (profile.productCountMethod) {
      var { probeExpectedProductCount } = require('../dist/services/product-count-probe');
      liveCount = await probeExpectedProductCount(site.url, profile.productCountMethod, { hasWaf: site.hasWaf });
    }
  } catch (e) {
    // Probe failed — try stored expectedProductCount
    if (profile.expectedProductCount) liveCount = profile.expectedProductCount;
  }

  if (liveCount !== null) {
    var ratio = typeof liveCount === 'number' ? Math.round(dbActive / liveCount * 100) : '?';
    console.log('[2] Live: ~' + liveCount + ' | Coverage: ' + ratio + '%');
    if (typeof liveCount === 'number' && dbActive >= liveCount * 0.95) {
      checks.coverage = true;
      console.log('    PASS — DB has >= 95% of live products');
    } else {
      pass = false;
      console.log('    FAIL — DB coverage too low');
    }
  } else {
    console.log('[2] Live count: unavailable (will check via stream completion)');
  }

  // 3. Watermark check
  console.log('\n[3] Watermark: ' + (site.lastWatermarkUrl ? site.lastWatermarkUrl.substring(0, 60) : 'NONE'));
  var wmAge = site.lastWatermarkUrl ? 'set' : 'missing';
  // Check if T1 found any products recently
  var recentEvents = await p.crawlEvent.findMany({
    where: { siteId: site.id }, orderBy: { crawledAt: 'desc' }, take: 20, select: { matchesFound: true }
  });
  var t1Finds = recentEvents.filter(function(e) { return e.matchesFound > 0; }).length;
  console.log('    T1 finds: ' + t1Finds + '/20 recent crawls found products');
  if (site.lastWatermarkUrl) {
    checks.watermark = true;
    console.log('    PASS — watermark set');
  } else {
    pass = false;
    console.log('    FAIL — no watermark');
  }

  // 4. Stream/tier completion
  var ss = site.streamState;
  if (ss && ss.streams && ss.tiers) {
    var allComplete = true;
    var tierStatus = [];
    if (site.crawlPhase === 'bootstrap') {
      // Bootstrap: only check T4 on the first stream
      var firstStream = ss.streams[0];
      if (firstStream) {
        var key = firstStream.id + ':4';
        var ts = ss.tiers[key];
        var completed = ts && ts.lastCycleCompletedAt;
        tierStatus.push(key + '=' + (completed ? 'done' : 'pending'));
        if (!completed) allComplete = false;
      }
    } else {
      // Maintain: check all tiers on all streams
      for (var stream of ss.streams) {
        for (var tier of [2, 3, 4]) {
          var key = stream.id + ':' + tier;
          var ts = ss.tiers[key];
          var completed = ts && ts.lastCycleCompletedAt;
          tierStatus.push(key + '=' + (completed ? 'done' : 'pending'));
          if (!completed) allComplete = false;
        }
      }
    }
    console.log('\n[4] Tiers: ' + (allComplete ? 'ALL COMPLETE' : 'NOT COMPLETE'));
    tierStatus.forEach(function(s) { console.log('    ' + s); });
    checks.tiers = allComplete;
    if (!allComplete) pass = false;
  } else {
    console.log('\n[4] No stream state — bootstrap not started?');
    pass = false;
  }

  // 5. Data quality quick check
  var noPrice = await p.productIndex.count({ where: { siteId: site.id, isActive: true, price: null } });
  var noThumb = await p.productIndex.count({ where: { siteId: site.id, isActive: true, thumbnail: null } });
  var noStock = await p.productIndex.count({ where: { siteId: site.id, isActive: true, stockStatus: null } });
  var inStock = await p.productIndex.count({ where: { siteId: site.id, isActive: true, stockStatus: 'in_stock' } });
  var pricePct = dbActive > 0 ? Math.round((dbActive - noPrice) / dbActive * 100) : 0;
  var thumbPct = dbActive > 0 ? Math.round((dbActive - noThumb) / dbActive * 100) : 0;
  var stockPct = dbActive > 0 ? Math.round((dbActive - noStock) / dbActive * 100) : 0;
  console.log('\n[5] Quality: price=' + pricePct + '% stock=' + stockPct + '% thumb=' + thumbPct + '%');
  console.log('    In stock: ' + inStock + ' | No price: ' + noPrice + ' | No stock: ' + noStock);

  // Price and stock must be >= 60% for bootstrap to be considered complete
  // (some OOS products genuinely have no price — 60% is the minimum acceptable)
  if (pricePct < 95) {
    console.log('    FAIL — price coverage ' + pricePct + '% < 95% minimum');
    pass = false;
  } else {
    console.log('    PASS — price coverage ' + pricePct + '%');
  }
  if (stockPct < 95) {
    console.log('    FAIL — stock coverage ' + stockPct + '% < 95% minimum');
    pass = false;
  } else {
    console.log('    PASS — stock coverage ' + stockPct + '%');
  }

  // Verdict
  console.log('\n=== VERDICT: ' + (pass ? 'READY' : 'NOT READY') + ' ===');
  if (pass && doTransition) {
    await p.monitoredSite.update({
      where: { id: site.id },
      data: { crawlPhase: 'maintain', bootstrapCompletedAt: new Date() },
    });
    console.log('Transitioned to MAINTAIN phase!');
  } else if (pass && !doTransition) {
    console.log('Run with --transition to transition this site');
  }

  await p['$disconnect']();
}
main().catch(function(e) { console.error(e); process.exit(1); });
