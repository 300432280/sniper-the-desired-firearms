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
import { crawlWatermark } from './watermark-crawler';
import { crawlCatalogTier, parseTierState, startTierCycle, updateTierProgress, type TierState } from './catalog-crawler';
import { expireFreeAlerts } from './free-tier';
import { allocateCatalogTokens } from './token-budget';
import { resolveTuning } from './crawl-tuning';

interface CrawlSiteJobData {
  siteId: string;
  domain: string;
  url: string;
}

interface WatermarkJobData {
  siteId: string;
  domain: string;
  url: string;
  baseBudget: number;
  capacity: number;
  lastWatermarkUrl: string | null;
  hasWaf?: boolean;
}

interface CatalogJobData {
  siteId: string;
  domain: string;
  url: string;
  baseBudget: number;
  capacity: number;
  tierState: string;
  activeTiers: { tier2: boolean; tier3: boolean; tier4: boolean };
  hasWaf?: boolean;
  crawlTuning?: unknown;
}

// ─── Crawl-Site Job Processor (Unified Scheduler) ────────────────────────────

/**
 * Process a scheduled crawl for a single site.
 * Finds all active searches targeting this site and runs the scraper once,
 * then distributes results to all matching searches.
 */
async function processCrawlSite(job: Job<CrawlSiteJobData>): Promise<void> {
  const { siteId, domain, url } = job.data;
  const startTime = Date.now();

  console.log(`[CrawlWorker] Crawling ${domain}`);
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
    const allScrapedProducts = new Map<string, { title: string; url: string; price?: number; thumbnail?: string; inStock?: boolean }>();

    for (const keyword of keywords) {
      const result = await scrapeWithAdapter(url, keyword, {
        fast: true,
        difficultyRating: 0,
      });
      lastResult = result;
      totalMatches += result.matches.length;

      // Collect all products for ProductIndex (deduped by URL)
      for (const m of result.matches) {
        if (!allScrapedProducts.has(m.url)) {
          allScrapedProducts.set(m.url, { title: m.title, url: m.url, price: m.price, thumbnail: m.thumbnail, inStock: m.inStock });
        }
      }

      // Distribute results to all searches with this keyword on this site
      const matchingSearches = searches.filter(s => s.keyword === keyword);
      for (const search of matchingSearches) {
        await distributeMatchesToSearch(search, result);
      }
    }

    // Save scraped products to ProductIndex (so keyword search also populates the index)
    if (allScrapedProducts.size > 0) {
      let indexed = 0;
      for (const product of allScrapedProducts.values()) {
        try {
          const stockVal = product.inStock === false ? 'out_of_stock' : product.inStock ? 'in_stock' : null;
          const hasRealStock = !!stockVal;
          const update: Record<string, any> = {
            title: product.title,
            lastSeenAt: new Date(),
            isActive: true,
          };
          if (hasRealStock) update.stockStatus = stockVal;
          if (product.price != null) update.price = product.price;
          if (product.thumbnail) update.thumbnail = product.thumbnail;

          await prisma.productIndex.upsert({
            where: { siteId_url: { siteId, url: product.url } },
            update,
            create: {
              siteId,
              url: product.url,
              title: product.title,
              price: product.price ?? null,
              stockStatus: stockVal,
              thumbnail: product.thumbnail ?? null,
            },
          });
          indexed++;
        } catch (err) {
          if (!(err instanceof Error && err.message.includes('Unique constraint'))) {
            console.error(`[CrawlWorker] Failed to index product ${product.url}:`, err);
          }
        }
      }
      if (indexed > 0) {
        console.log(`[CrawlWorker] Indexed ${indexed} products to ProductIndex for ${domain}`);
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
      usedPlaywright: lastResult?.usedPlaywright,
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

// ─── Watermark Crawl Job Processor (Tier 1 — New Items) ─────────────────────

async function processWatermarkCrawl(job: Job<WatermarkJobData>): Promise<void> {
  const { siteId, domain, url, baseBudget, capacity, lastWatermarkUrl, hasWaf } = job.data;

  console.log(`[WatermarkWorker] Tier 1 watermark crawl: ${domain}`);
  pushEvent({ type: 'scrape_start', websiteUrl: url, message: `Watermark crawl: ${domain}` });

  const result = await crawlWatermark({ siteId, url, domain, baseBudget, capacity, lastWatermarkUrl, hasWaf });

  // Record crawl event and update watermark
  await onCrawlComplete({
    siteId,
    status: result.status,
    responseTimeMs: result.responseTimeMs,
    statusCode: result.statusCode,
    matchesFound: result.productsFound,
    errorMessage: result.errorMessage,
    signals: result.signals,
    headers: result.headers,
    newWatermarkUrl: result.newWatermarkUrl,
  });

  pushEvent({
    type: result.status === 'success' ? 'scrape_done' : 'scrape_fail',
    websiteUrl: url,
    message: `Watermark crawl ${result.status}: ${domain} — ${result.productsFound} products, ${result.pagesScanned} pages, ${result.tokensUsed} tokens`,
  });
}

// ─── Catalog Crawl Job Processor (Tiers 2-4 — Full Catalog Refresh) ─────────

async function processCatalogCrawl(job: Job<CatalogJobData>): Promise<void> {
  const { siteId, domain, url, baseBudget, capacity, activeTiers } = job.data;
  const tierState = parseTierState(job.data.tierState);
  const tuning = resolveTuning(job.data.crawlTuning);

  console.log(`[CatalogWorker] Catalog crawl: ${domain} (tiers: ${Object.entries(activeTiers).filter(([, v]) => v).map(([k]) => k).join(',')})`);

  // Allocate tokens across active tiers using per-site tuning
  const allocation = allocateCatalogTokens(siteId, baseBudget, capacity, activeTiers, tuning);

  const updatedState: TierState = { ...tierState };

  for (const tier of [2, 3, 4] as const) {
    const tierKey = `tier${tier}` as keyof typeof activeTiers;
    if (!activeTiers[tierKey] || allocation[tierKey] <= 0) continue;

    // Start new cycle if idle or cooldown expired
    let cycleState = updatedState[tierKey];
    if (cycleState.status === 'idle' || cycleState.status === 'cooldown') {
      cycleState = startTierCycle(tier);
      updatedState[tierKey] = cycleState;
    }

    const result = await crawlCatalogTier({
      siteId,
      url,
      domain,
      tier,
      tierState: cycleState,
      tokensAllocated: allocation[tierKey],
      baseBudget,
      capacity,
      hasWaf: job.data.hasWaf,
    });

    // Pass per-site cooldown override for this tier
    const cooldownMap = { tier2: tuning.t2CooldownHrs, tier3: tuning.t3CooldownHrs, tier4: tuning.t4CooldownHrs };
    updatedState[tierKey] = updateTierProgress(cycleState, result.pagesScanned, result.cycleComplete, tier, cooldownMap[tierKey]);

    console.log(`[CatalogWorker] Tier ${tier} ${result.status}: ${result.productsFound} products, ${result.pagesScanned} pages, ${result.tokensUsed} tokens${result.cycleComplete ? ' (cycle complete)' : ''}`);
  }

  // Persist updated tier state
  await prisma.monitoredSite.update({
    where: { id: siteId },
    data: { tierState: updatedState as any },
  });

  pushEvent({ type: 'info', message: `Catalog crawl complete: ${domain}` });
}

// ─── Worker Startup ──────────────────────────────────────────────────────────

export function startWorker(): Worker {
  const worker = new Worker('scrape', async (job) => {
    if (job.name === 'crawl-site') {
      await processCrawlSite(job as Job<CrawlSiteJobData>);
    } else if (job.name === 'crawl-watermark') {
      await processWatermarkCrawl(job as Job<WatermarkJobData>);
    } else if (job.name === 'crawl-catalog') {
      await processCatalogCrawl(job as Job<CatalogJobData>);
    } else {
      console.log(`[Worker] Skipping legacy job ${job.name} (${job.id})`);
    }
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

    // Daily digest moved to its own cron (11 PM UTC / 6 PM EST) — see startDigestWorker()

    // Expire FREE user alerts past 14-day window
    const expiredAlerts = await expireFreeAlerts();
    if (expiredAlerts.expired > 0) {
      console.log(`[HealthWorker] Expired ${expiredAlerts.expired} FREE user alerts`);
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

// ─── Digest Worker ───────────────────────────────────────────────────────────

export function startDigestWorker(): Worker {
  const worker = new Worker('digest', async (_job: Job) => {
    console.log(`[DigestWorker] Sending daily digests (6 PM EST)...`);
    pushEvent({ type: 'info', message: 'Daily digest started' });

    try {
      const result = await sendDailyDigests();
      console.log(`[DigestWorker] Daily digest: ${result.sent} sent, ${result.skipped} skipped`);
      pushEvent({ type: 'info', message: `Daily digest complete: ${result.sent} sent, ${result.skipped} skipped` });
    } catch (err) {
      console.error(`[DigestWorker] Daily digest failed:`, err instanceof Error ? err.message : err);
    }
  }, {
    connection: redisConnection,
    concurrency: 1,
  });

  worker.on('error', (err) => {
    console.error(`[DigestWorker] Worker error: ${err.message}`);
  });

  console.log('[DigestWorker] Digest worker started');
  return worker;
}
