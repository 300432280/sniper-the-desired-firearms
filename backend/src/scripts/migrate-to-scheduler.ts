/**
 * One-time migration: cancel all legacy per-search BullMQ repeating jobs.
 *
 * The unified crawl scheduler now handles all site-level crawling.
 * This script removes the old per-search repeating jobs that were created
 * by `scheduleSearch()` before the migration to the centralized system.
 *
 * Also ensures all enabled MonitoredSites have a `nextCrawlAt` set
 * (staggered across 2-minute intervals).
 *
 * Run: npx tsx src/scripts/migrate-to-scheduler.ts
 */

import { scrapeQueue, redisConnection } from '../services/queue';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function migrate(): Promise<void> {
  console.log('[Migration] Starting migration from per-search to unified scheduler...\n');

  // 1. Cancel all legacy per-search repeating jobs
  const repeatableJobs = await scrapeQueue.getRepeatableJobs();
  let removed = 0;

  for (const job of repeatableJobs) {
    // Legacy per-search jobs have id like "search:<searchId>"
    if (job.id?.startsWith('search:')) {
      await scrapeQueue.removeRepeatableByKey(job.key);
      removed++;
      console.log(`  Removed legacy job: ${job.id}`);
    }
  }

  console.log(`\n[Migration] Removed ${removed} legacy per-search repeating job(s)`);

  // 2. Ensure all enabled MonitoredSites have nextCrawlAt set (staggered)
  const sites = await prisma.monitoredSite.findMany({
    where: { isEnabled: true, nextCrawlAt: null },
    orderBy: { domain: 'asc' },
  });

  if (sites.length > 0) {
    const staggerMs = 2 * 60 * 1000; // 2 minutes apart
    const now = Date.now();

    for (let i = 0; i < sites.length; i++) {
      const nextCrawlAt = new Date(now + i * staggerMs);
      await prisma.monitoredSite.update({
        where: { id: sites[i].id },
        data: {
          nextCrawlAt,
          crawlIntervalMin: 120, // Default 2hr until priority engine takes over
        },
      });
      console.log(`  Scheduled ${sites[i].domain} → ${nextCrawlAt.toISOString()}`);
    }

    console.log(`\n[Migration] Staggered ${sites.length} site(s) across ${Math.round(sites.length * 2)} minutes`);
  } else {
    console.log('\n[Migration] All enabled sites already have nextCrawlAt set');
  }

  // 3. Summary
  const totalSites = await prisma.monitoredSite.count({ where: { isEnabled: true } });
  const totalSearches = await prisma.search.count({ where: { isActive: true } });
  console.log(`\n[Migration] Done. ${totalSites} enabled sites serving ${totalSearches} active searches.`);

  await prisma.$disconnect();
  await redisConnection.quit();
}

migrate().catch((err) => {
  console.error('[Migration] Failed:', err);
  process.exit(1);
});
