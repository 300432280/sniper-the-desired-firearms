/**
 * Fix stuck tiers and stale products for the 7 target sites.
 *
 * 1. Reset all in_progress tiers that are stuck >15min to idle
 * 2. Reset expired cooldowns to idle
 * 3. Deactivate products not seen in >14 days
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const DOMAINS = [
  'aagcanada.ca',
  'alflahertys.com',
  'alsimmonsgunshop.com',
  'budgetshootersupply.ca',
  'bullseyenorth.com',
  'canadafirstammo.ca',
  'gunpost.ca',
];

async function main() {
  const now = Date.now();
  const d14 = new Date(now - 14 * 24 * 3600000);

  for (const domain of DOMAINS) {
    const site = await p.monitoredSite.findUnique({
      where: { domain },
      select: { id: true, domain: true, streamState: true },
    });
    if (!site) { console.log(`[SKIP] ${domain} not found`); continue; }

    const ss = site.streamState;
    let changed = false;
    let stuckFixed = 0;
    let cooldownFixed = 0;

    if (ss && ss.tiers) {
      for (const [key, ts] of Object.entries(ss.tiers)) {
        // Fix stuck in_progress
        if (ts.status === 'in_progress' && ts.cycleStartedAt) {
          const stuckMs = now - new Date(ts.cycleStartedAt).getTime();
          if (stuckMs > 15 * 60 * 1000) {
            ts.status = 'idle';
            ts.currentPage = ts.pageRangeStart || 1;
            ts.currentPageUrl = undefined;
            ts.cycleStartedAt = undefined;
            changed = true;
            stuckFixed++;
          }
        }
        // Fix expired cooldowns
        if (ts.status === 'cooldown' && ts.cooldownEndsAt) {
          if (new Date(ts.cooldownEndsAt).getTime() < now) {
            ts.status = 'idle';
            ts.cooldownEndsAt = undefined;
            changed = true;
            cooldownFixed++;
          }
        }
      }
    }

    if (changed) {
      await p.monitoredSite.update({
        where: { id: site.id },
        data: { streamState: ss },
      });
      console.log(`[FIX] ${domain}: reset ${stuckFixed} stuck tiers, ${cooldownFixed} expired cooldowns`);
    } else {
      console.log(`[OK]  ${domain}: no stuck/expired tiers`);
    }

    // NOTE: Do NOT deactivate products based on lastSeenAt alone.
    // The crawler may not have visited those pages yet.
    // A product is only "removed" if the crawler visited its page AND it wasn't there.
  }

  await p.$disconnect();
  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
