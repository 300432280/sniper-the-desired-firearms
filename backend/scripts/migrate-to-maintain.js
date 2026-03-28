/**
 * Migration script: Transition eligible sites from bootstrap to maintain phase.
 * A site is eligible if all streams × all tiers have completed at least one cycle.
 *
 * Usage: node scripts/migrate-to-maintain.js [--dry-run]
 */
require('dotenv').config();
var { PrismaClient } = require('@prisma/client');
var p = new PrismaClient();

async function main() {
  var dryRun = process.argv.includes('--dry-run');
  if (dryRun) console.log('DRY RUN — no changes will be made\n');

  var sites = await p.monitoredSite.findMany({
    where: { isEnabled: true, crawlPhase: 'bootstrap' },
    select: { id: true, domain: true, streamState: true },
  });

  console.log('Checking ' + sites.length + ' bootstrap sites...\n');

  var transitioned = 0;
  var notReady = 0;

  for (var site of sites) {
    var ss = site.streamState;
    if (!ss || !ss.streams || !ss.tiers) {
      console.log(site.domain.padEnd(40) + ' NO STREAMS — skip');
      notReady++;
      continue;
    }

    var allComplete = true;
    var missing = [];
    for (var stream of ss.streams) {
      for (var tier of [2, 3, 4]) {
        var key = stream.id + ':' + tier;
        var ts = ss.tiers[key];
        if (!ts || !ts.lastCycleCompletedAt) {
          allComplete = false;
          missing.push(key);
        }
      }
    }

    if (allComplete) {
      var productCount = await p.productIndex.count({ where: { siteId: site.id, isActive: true } });
      console.log(site.domain.padEnd(40) + ' READY — ' + productCount + ' products');

      if (!dryRun) {
        await p.monitoredSite.update({
          where: { id: site.id },
          data: {
            crawlPhase: 'maintain',
            bootstrapCompletedAt: new Date(),
          },
        });
        console.log('  → Transitioned to MAINTAIN phase');
      }
      transitioned++;
    } else {
      console.log(site.domain.padEnd(40) + ' NOT READY — missing: ' + missing.slice(0, 3).join(', ') + (missing.length > 3 ? ' +' + (missing.length - 3) + ' more' : ''));
      notReady++;
    }
  }

  console.log('\n=== Summary ===');
  console.log('Transitioned: ' + transitioned);
  console.log('Not ready: ' + notReady);

  await p['$disconnect']();
}
main().catch(function(e) { console.error(e); process.exit(1); });
