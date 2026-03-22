import { Worker, Job } from 'bullmq';
import { redisConnection } from './queue';
import { pushEvent } from './debugLog';
import { prisma } from '../lib/prisma';
import { runHealthChecks, pruneOldHealthChecks } from './health-monitor';
import { schedulerTick, onCrawlComplete, initializeCrawlSchedule, pruneCrawlEvents } from './crawl-scheduler';
import { sendDailyDigests } from './daily-digest';
import { crawlWatermark } from './watermark-crawler';
import { crawlCatalogTier, parseTierState, startTierCycle, updateTierProgress, type TierState, crawlStreamTier, isStreamTierActive, startStreamTierCycle, completeStreamTierCycle } from './catalog-crawler';
import { expireFreeAlerts } from './free-tier';
import { allocateCatalogTokens } from './token-budget';
import { resolveTuning } from './crawl-tuning';
import { parseStreamState, updateStreamPageRanges } from './stream-detector';
import { pickStream } from './stream-priority';
import { firearmsPriority } from './stream-priority-firearms';
import type { SiteStreamState } from './scraper/types';

interface WatermarkJobData {
  siteId: string;
  domain: string;
  url: string;
  baseBudget: number;
  capacity: number;
  lastWatermarkUrl: string | null;
  lastWatermarkDate?: string | null;
  crawlTuning?: unknown;
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
  streamState?: unknown;
}

// ─── Watermark Crawl Job Processor (Tier 1 — New Items) ─────────────────────

async function processWatermarkCrawl(job: Job<WatermarkJobData>): Promise<void> {
  const { siteId, domain, url, baseBudget, capacity, lastWatermarkUrl, lastWatermarkDate, crawlTuning, hasWaf } = job.data;
  const tuning = resolveTuning(crawlTuning);

  console.log(`[WatermarkWorker] Tier 1 watermark crawl: ${domain}`);
  pushEvent({ type: 'scrape_start', websiteUrl: url, message: `Watermark crawl: ${domain}` });

  const result = await crawlWatermark({ siteId, url, domain, baseBudget, capacity, lastWatermarkUrl, lastWatermarkDate, hasWaf, wmKnownThreshold: tuning.wmKnownThreshold, wmOldDateThreshold: tuning.wmOldDateThreshold });

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
    newWatermarkDate: result.newWatermarkDate,
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
  const tuning = resolveTuning(job.data.crawlTuning);

  // Try stream-based crawling first (Phase 2)
  const streamState = parseStreamState(job.data.streamState);
  if (streamState && streamState.streams.length > 0) {
    await processStreamCatalogCrawl(job.data, streamState, tuning, activeTiers);
    return;
  }

  // Legacy path: per-tier crawling (sites without streamState)
  const tierState = parseTierState(job.data.tierState);

  console.log(`[CatalogWorker] Legacy catalog crawl: ${domain} (tiers: ${Object.entries(activeTiers).filter(([, v]) => v).map(([k]) => k).join(',')})`);

  const allocation = allocateCatalogTokens(siteId, baseBudget, capacity, activeTiers, tuning);
  const updatedState: TierState = { ...tierState };

  for (const tier of [2, 3, 4] as const) {
    const tierKey = `tier${tier}` as keyof typeof activeTiers;
    if (!activeTiers[tierKey] || allocation[tierKey] <= 0) continue;

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

    const cooldownMap = { tier2: tuning.t2CooldownHrs, tier3: tuning.t3CooldownHrs, tier4: tuning.t4CooldownHrs };
    updatedState[tierKey] = updateTierProgress(cycleState, result.pagesScanned, result.cycleComplete, tier, cooldownMap[tierKey]);

    console.log(`[CatalogWorker] Tier ${tier} ${result.status}: ${result.productsFound} products, ${result.pagesScanned} pages, ${result.tokensUsed} tokens${result.cycleComplete ? ' (cycle complete)' : ''}`);
  }

  await prisma.monitoredSite.update({
    where: { id: siteId },
    data: { tierState: updatedState as any },
  });

  pushEvent({ type: 'info', message: `Catalog crawl complete: ${domain}` });
}

/**
 * Stream-based catalog crawl (Phase 2).
 * Each tier picks ONE stream (highest priority) and concentrates all tokens on it.
 */
async function processStreamCatalogCrawl(
  data: CatalogJobData,
  streamState: SiteStreamState,
  tuning: ReturnType<typeof resolveTuning>,
  activeTiers: { tier2: boolean; tier3: boolean; tier4: boolean },
): Promise<void> {
  const { siteId, domain, url, baseBudget, capacity } = data;
  const now = new Date();
  const cooldownMap = { 2: tuning.t2CooldownHrs, 3: tuning.t3CooldownHrs, 4: tuning.t4CooldownHrs } as const;

  // Auto-reset stale in_progress tiers (stuck from stalled jobs / worker restarts)
  const STALE_PROGRESS_MS = 15 * 60 * 1000; // 15 minutes
  let resetCount = 0;
  for (const [, ts] of Object.entries(streamState.tiers)) {
    if (ts.status === 'in_progress' && ts.cycleStartedAt) {
      const age = now.getTime() - new Date(ts.cycleStartedAt).getTime();
      if (age > STALE_PROGRESS_MS) {
        ts.status = 'idle';
        ts.currentPage = ts.pageRangeStart || 1;
        ts.currentPageUrl = undefined;
        ts.cycleStartedAt = undefined;
        resetCount++;
      }
    }
  }
  if (resetCount > 0) {
    console.log(`[CatalogWorker] ${domain}: auto-reset ${resetCount} stale in_progress tier(s)`);
  }

  console.log(`[CatalogWorker] Stream catalog crawl: ${domain} (${streamState.streams.length} streams, tiers: ${Object.entries(activeTiers).filter(([, v]) => v).map(([k]) => k).join(',')})`);

  const allocation = allocateCatalogTokens(siteId, baseBudget, capacity, activeTiers, tuning);

  for (const tier of [2, 3, 4] as const) {
    const tierKey = `tier${tier}` as keyof typeof activeTiers;
    if (!activeTiers[tierKey] || allocation[tierKey] <= 0) continue;

    // Find eligible streams for this tier (not in cooldown)
    const eligibleStreams = streamState.streams.map(stream => {
      const key = `${stream.id}:${tier}`;
      const ts = streamState.tiers[key];
      if (!ts) return null;
      if (!isStreamTierActive(ts, now)) return null;
      return { ...stream, lastRefreshedAt: ts.lastRefreshedAt };
    }).filter((s): s is NonNullable<typeof s> => s !== null);

    if (eligibleStreams.length === 0) continue;

    // Pick highest-priority stream (firearms plugin for this project)
    const chosen = pickStream(eligibleStreams, firearmsPriority);
    if (!chosen) continue;

    const stateKey = `${chosen.id}:${tier}`;
    let tierState = streamState.tiers[stateKey];
    if (!tierState) continue;

    // Apply page ranges from stored totalPages if not yet set (HTML streams only — API uses date ranges)
    if (chosen.type === 'html' && chosen.totalPages && chosen.totalPages > 1 && !tierState.pageRangeEnd) {
      updateStreamPageRanges(streamState, chosen.id, chosen.totalPages);
      tierState = streamState.tiers[stateKey]; // re-read after range update
      if (!tierState) continue;
    }

    // Start new cycle if needed
    if (tierState.status === 'idle' || tierState.status === 'cooldown') {
      tierState = startStreamTierCycle(chosen, tier, tierState);
      streamState.tiers[stateKey] = tierState;
    }

    const result = await crawlStreamTier({
      siteId,
      url,
      domain,
      stream: chosen,
      tier,
      tierState,
      tokensAllocated: allocation[tierKey],
      hasWaf: data.hasWaf,
    });

    // Update page ranges if we discovered total pages (HTML streams only)
    if (result.totalPagesDiscovered && chosen.type === 'html') {
      updateStreamPageRanges(streamState, chosen.id, result.totalPagesDiscovered);
    }

    // Complete or update progress
    if (result.cycleComplete) {
      streamState.tiers[stateKey] = completeStreamTierCycle(tierState, cooldownMap[tier]);
    }
    // tierState was mutated in-place by crawlStreamTier for resume position

    console.log(`[CatalogWorker] Stream "${chosen.id}" T${tier} ${result.status}: ${result.productsFound} products, ${result.pagesScanned} pages, ${result.tokensUsed} tokens${result.cycleComplete ? ' (cycle complete)' : ''}`);
  }

  // Persist updated stream state
  await prisma.monitoredSite.update({
    where: { id: siteId },
    data: { streamState: streamState as any },
  });

  pushEvent({ type: 'info', message: `Stream catalog crawl complete: ${domain}` });
}

// ─── Worker Startup ──────────────────────────────────────────────────────────

export function startWorker(): Worker {
  const worker = new Worker('scrape', async (job) => {
    if (job.name === 'crawl-watermark') {
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
