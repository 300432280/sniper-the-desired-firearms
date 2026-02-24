import { Worker, Job } from 'bullmq';
import { redisConnection } from './queue';
import { scrapeWithAdapter, type ScrapeResult } from './scraper/index';
import { sendAlertEmail } from './email';
import { sendAlertSms } from './sms';
import { pushEvent } from './debugLog';
import { prisma } from '../lib/prisma';
import { config } from '../config';
import { runHealthChecks, pruneOldHealthChecks } from './health-monitor';
import { schedulerTick, onCrawlComplete, initializeCrawlSchedule, pruneCrawlEvents } from './crawl-scheduler';
import { sendDailyDigests } from './daily-digest';

interface CrawlSiteJobData {
  siteId: string;
  domain: string;
  url: string;
  difficultyScore: number;
}

// ─── Crawl-Site Job Processor (Unified Scheduler) ────────────────────────────

/**
 * Process a scheduled crawl for a single site.
 * Finds all active searches targeting this site and runs the scraper once,
 * then distributes results to all matching searches.
 */
async function processCrawlSite(job: Job<CrawlSiteJobData>): Promise<void> {
  const { siteId, domain, url, difficultyScore } = job.data;
  const startTime = Date.now();

  console.log(`[CrawlWorker] Crawling ${domain} (difficulty: ${difficultyScore})`);
  pushEvent({ type: 'scrape_start', websiteUrl: url, message: `Scheduled crawl: ${domain}` });

  // Find all active searches targeting this site
  const searches = await prisma.search.findMany({
    where: {
      websiteUrl: { contains: domain },
      isActive: true,
    },
    include: { user: true },
  });

  if (searches.length === 0) {
    console.log(`[CrawlWorker] No active searches for ${domain}, skipping`);
    await onCrawlComplete({ siteId, status: 'success', matchesFound: 0 });
    return;
  }

  // Get unique keywords to search for
  const keywords = [...new Set(searches.map(s => s.keyword))];

  let totalMatches = 0;
  let lastResult: ScrapeResult | null = null;

  try {
    // Scrape for each unique keyword
    for (const keyword of keywords) {
      const result = await scrapeWithAdapter(url, keyword, {
        fast: true,
        difficultyRating: difficultyScore,
      });
      lastResult = result;
      totalMatches += result.matches.length;

      // Distribute results to all searches with this keyword on this site
      const matchingSearches = searches.filter(s => s.keyword === keyword);
      for (const search of matchingSearches) {
        await distributeMatchesToSearch(search, result);
      }
    }

    // Record successful crawl
    await onCrawlComplete({
      siteId,
      status: 'success',
      responseTimeMs: lastResult?.fetchMeta?.responseTimeMs ?? (Date.now() - startTime),
      statusCode: lastResult?.fetchMeta?.statusCode,
      matchesFound: totalMatches,
      signals: lastResult?.fetchMeta?.signals,
      headers: lastResult?.fetchMeta?.headers,
    });

    pushEvent({
      type: 'scrape_done',
      websiteUrl: url,
      message: `Crawl complete: ${domain} — ${totalMatches} matches across ${keywords.length} keyword(s)`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[CrawlWorker] Crawl failed for ${domain}: ${msg}`);

    const status = msg.includes('timeout') ? 'timeout'
      : msg.includes('429') ? 'blocked'
      : msg.includes('captcha') ? 'captcha'
      : 'fail';

    await onCrawlComplete({
      siteId,
      status,
      responseTimeMs: Date.now() - startTime,
      matchesFound: 0,
      errorMessage: msg,
      signals: lastResult?.fetchMeta?.signals,
      headers: lastResult?.fetchMeta?.headers,
    });

    pushEvent({ type: 'scrape_fail', websiteUrl: url, message: `Crawl failed: ${domain} — ${msg}` });
  }
}

/**
 * Distribute scrape results to a specific search — delta detect, persist, notify.
 */
async function distributeMatchesToSearch(
  search: { id: string; keyword: string; websiteUrl: string; user: any; notificationType: string; notifyEmail: string | null },
  result: ScrapeResult
): Promise<void> {
  const searchId = search.id;

  // Update lastChecked
  await prisma.search.update({
    where: { id: searchId },
    data: { lastChecked: result.scrapedAt },
  });

  // Delta detection
  const existingMatches = await prisma.match.findMany({
    where: { searchId },
    select: { url: true },
  });
  const existingUrls = new Set(existingMatches.map(m => m.url));

  const newMatches = result.matches.filter(m => !existingUrls.has(m.url));
  const updatedMatches = result.matches.filter(m => existingUrls.has(m.url));

  // Update existing
  for (const m of updatedMatches) {
    await prisma.match.updateMany({
      where: { searchId, url: m.url },
      data: {
        title: m.title,
        price: m.price ?? null,
        hash: result.contentHash,
        thumbnail: m.thumbnail ?? undefined,
        seller: m.seller ?? undefined,
      },
    });
  }

  // Insert new
  if (newMatches.length > 0) {
    await prisma.match.createMany({
      data: newMatches.map(m => ({
        searchId,
        title: m.title,
        price: m.price ?? null,
        url: m.url,
        hash: result.contentHash,
        thumbnail: m.thumbnail ?? null,
        postDate: m.postDate ? new Date(m.postDate) : null,
        seller: m.seller ?? null,
      })),
      skipDuplicates: true,
    });

    // Update hash
    await prisma.search.update({
      where: { id: searchId },
      data: { lastMatchHash: result.contentHash },
    });

    // Tier-aware notifications: PRO gets instant, FREE gets daily digest
    if (newMatches.length > 0 && search.user && search.user.tier === 'PRO') {
      const recipientEmail = search.user.email ?? search.notifyEmail;
      if (recipientEmail && (search.notificationType === 'EMAIL' || search.notificationType === 'BOTH')) {
        const insertedMatches = await prisma.match.findMany({
          where: { searchId, url: { in: newMatches.map(m => m.url) } },
          select: { id: true },
        });

        const notification = await prisma.notification.create({
          data: { searchId, type: 'EMAIL', status: 'pending' },
        });
        if (insertedMatches.length > 0) {
          await prisma.notificationMatch.createMany({
            data: insertedMatches.map(m => ({ notificationId: notification.id, matchId: m.id })),
          });
        }

        try {
          await sendAlertEmail({
            to: recipientEmail,
            keyword: search.keyword,
            matches: newMatches,
            notificationId: notification.id,
            backendUrl: config.backendUrl,
          });
          await prisma.notification.update({ where: { id: notification.id }, data: { status: 'sent' } });
        } catch {
          await prisma.notification.update({ where: { id: notification.id }, data: { status: 'failed' } });
        }
      }
    }
  }
}

// ─── Worker Startup ──────────────────────────────────────────────────────────

export function startWorker(): Worker<CrawlSiteJobData> {
  const worker = new Worker<CrawlSiteJobData>('scrape', async (job) => {
    // All crawl jobs go through the unified per-site processor
    await processCrawlSite(job);
  }, {
    connection: redisConnection,
    concurrency: 20,
  });

  worker.on('completed', (job) => {
    console.log(`[Worker] Job ${job.id} completed`);
    pushEvent({ type: 'job_completed', message: `Job ${job.id} completed` });
  });

  worker.on('failed', (job, err) => {
    console.error(`[Worker] Job ${job?.id} failed: ${err.message}`);
    pushEvent({ type: 'job_failed', message: `Job ${job?.id} failed: ${err.message}` });
  });

  worker.on('error', (err) => {
    console.error(`[Worker] Worker error: ${err.message}`);
  });

  console.log('[Worker] BullMQ worker started');
  return worker;
}

// ─── Scheduler Worker ────────────────────────────────────────────────────────

export function startSchedulerWorker(): Worker {
  const worker = new Worker('scheduler', async (_job: Job) => {
    await schedulerTick();
  }, {
    connection: redisConnection,
    concurrency: 1,
  });

  worker.on('error', (err) => {
    console.error(`[SchedulerWorker] Error: ${err.message}`);
  });

  // Initialize crawl schedule for sites that don't have one yet
  initializeCrawlSchedule().catch(err => {
    console.error(`[SchedulerWorker] Failed to initialize schedule: ${err.message}`);
  });

  console.log('[SchedulerWorker] Crawl scheduler worker started');
  return worker;
}

// ─── Health Check Worker ──────────────────────────────────────────────────────

export function startHealthWorker(): Worker {
  const worker = new Worker('health', async (_job: Job) => {
    console.log(`[HealthWorker] Running daily health checks...`);
    pushEvent({ type: 'info', message: 'Daily health check started' });

    const result = await runHealthChecks();

    // Prune old records while we're at it
    const pruned = await pruneOldHealthChecks();
    if (pruned > 0) {
      console.log(`[HealthWorker] Pruned ${pruned} old health check records`);
    }

    // Prune old crawl events too
    const prunedCrawls = await pruneCrawlEvents();
    if (prunedCrawls > 0) {
      console.log(`[HealthWorker] Pruned ${prunedCrawls} old crawl events`);
    }

    // Send daily digest emails to FREE-tier users
    try {
      const digestResult = await sendDailyDigests();
      console.log(`[HealthWorker] Daily digest: ${digestResult.sent} sent, ${digestResult.skipped} skipped`);
    } catch (err) {
      console.error(`[HealthWorker] Daily digest failed:`, err instanceof Error ? err.message : err);
    }

    pushEvent({
      type: 'info',
      message: `Health check complete: ${result.reachable}/${result.total} reachable, ${result.canScrape}/${result.total} scrapable, ${result.failed.length} failed`,
    });
  }, {
    connection: redisConnection,
    concurrency: 1,
  });

  worker.on('completed', (job) => {
    console.log(`[HealthWorker] Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[HealthWorker] Job ${job?.id} failed: ${err.message}`);
    pushEvent({ type: 'job_failed', message: `Health check failed: ${err.message}` });
  });

  worker.on('error', (err) => {
    console.error(`[HealthWorker] Worker error: ${err.message}`);
  });

  console.log('[HealthWorker] Health check worker started');
  return worker;
}
