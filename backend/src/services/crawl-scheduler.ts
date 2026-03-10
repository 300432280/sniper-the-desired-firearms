/**
 * Unified Crawl Scheduler — one crawl schedule per site, shared by all users.
 *
 * A BullMQ cron job ticks every 2 minutes and checks which sites are due.
 * No user action ever triggers a crawl directly. The priority engine determines
 * each site's interval based on demand, difficulty, traffic class, and health.
 *
 * v2: Integrates token budget, cold start, and tier-based catalog crawling.
 *
 * Safety ceilings (hard limits, no override):
 * - MAX_CRAWLS_PER_SITE_PER_HOUR = 4
 * - MAX_CONCURRENT_CRAWLS = 10
 * - MAX_GLOBAL_CRAWLS_PER_HOUR = 200
 * - CRAWL_LOCK_TIMEOUT_MS = 5 minutes (auto-expire)
 */

import { prisma } from '../lib/prisma';
import { scrapeQueue } from './queue';
import { recalculateSitePriority } from './priority-engine';
import { pushEvent } from './debugLog';
import { getColdStartStatus } from './cold-start';
import { getBudget } from './token-budget';
import { parseTierState, getActiveTiers } from './catalog-crawler';
import { detectStreams, initStreamState, parseStreamState } from './stream-detector';

// ── Safety Ceilings ──────────────────────────────────────────────────────────

const MAX_CRAWLS_PER_SITE_PER_HOUR = 4;
const MAX_CONCURRENT_CRAWLS = 10;
const MAX_GLOBAL_CRAWLS_PER_HOUR = 200;
const CRAWL_LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Track recent crawl counts in memory (reset periodically)
const siteCrawlCounts = new Map<string, { count: number; windowStart: number }>();
let globalCrawlCount = { count: 0, windowStart: Date.now() };

function getSiteCrawlCount(siteId: string): number {
  const entry = siteCrawlCounts.get(siteId);
  if (!entry || Date.now() - entry.windowStart > 60 * 60 * 1000) {
    return 0; // Window expired
  }
  return entry.count;
}

function incrementSiteCrawlCount(siteId: string): void {
  const now = Date.now();
  const entry = siteCrawlCounts.get(siteId);
  if (!entry || now - entry.windowStart > 60 * 60 * 1000) {
    siteCrawlCounts.set(siteId, { count: 1, windowStart: now });
  } else {
    entry.count++;
  }
}

function getGlobalCrawlCount(): number {
  if (Date.now() - globalCrawlCount.windowStart > 60 * 60 * 1000) {
    globalCrawlCount = { count: 0, windowStart: Date.now() };
  }
  return globalCrawlCount.count;
}

function incrementGlobalCrawlCount(): void {
  if (Date.now() - globalCrawlCount.windowStart > 60 * 60 * 1000) {
    globalCrawlCount = { count: 1, windowStart: Date.now() };
  } else {
    globalCrawlCount.count++;
  }
}

// ── Scheduler Tick ───────────────────────────────────────────────────────────

/**
 * Main scheduler tick — runs every 2 minutes.
 * 1. Clean up expired crawl locks
 * 2. Find sites that are due for a crawl
 * 3. Enforce safety ceilings + cold start + token budgets
 * 4. Queue crawl jobs: legacy keyword crawl + new catalog/watermark crawls
 */
export async function schedulerTick(): Promise<void> {
  const now = new Date();

  // 1. Clean up expired locks (crashed workers, stuck jobs)
  const expiredLocks = await prisma.monitoredSite.findMany({
    where: {
      crawlLock: { not: null },
      crawlLockExpiresAt: { lt: now },
    },
    select: { id: true, domain: true },
  });

  if (expiredLocks.length > 0) {
    for (const site of expiredLocks) {
      await prisma.monitoredSite.update({
        where: { id: site.id },
        data: { crawlLock: null, crawlLockExpiresAt: null },
      });
      console.log(`[Scheduler] Released expired lock for ${site.domain}`);
    }
  }

  // 2. Find sites due for crawling (Tier 1 — new items)
  const dueSites = await prisma.monitoredSite.findMany({
    where: {
      isEnabled: true,
      isPaused: false,
      crawlLock: null, // Not currently being crawled
      OR: [
        { nextCrawlAt: { lte: now } },
        { nextCrawlAt: null }, // Never scheduled — needs initial crawl
      ],
    },
    orderBy: { nextCrawlAt: 'asc' }, // Most overdue first
  });

  if (dueSites.length === 0) return;

  // 3. Count currently locked (in-progress) crawls
  const activeLocks = await prisma.monitoredSite.count({
    where: { crawlLock: { not: null } },
  });

  const availableSlots = MAX_CONCURRENT_CRAWLS - activeLocks;
  if (availableSlots <= 0) {
    console.log(`[Scheduler] All ${MAX_CONCURRENT_CRAWLS} crawl slots occupied, skipping tick`);
    return;
  }

  // 4. Check global hourly budget
  if (getGlobalCrawlCount() >= MAX_GLOBAL_CRAWLS_PER_HOUR) {
    console.log(`[Scheduler] Global hourly budget (${MAX_GLOBAL_CRAWLS_PER_HOUR}) exhausted`);
    return;
  }

  // 5. Queue crawls for eligible sites
  let queued = 0;
  for (const site of dueSites) {
    if (queued >= availableSlots) break;
    if (getGlobalCrawlCount() >= MAX_GLOBAL_CRAWLS_PER_HOUR) break;

    // Per-site hourly ceiling
    if (getSiteCrawlCount(site.id) >= MAX_CRAWLS_PER_SITE_PER_HOUR) {
      console.log(`[Scheduler] ${site.domain} hit per-site hourly ceiling (${MAX_CRAWLS_PER_SITE_PER_HOUR}), skipping`);
      continue;
    }

    // Determine cold start phase for budget cap
    const coldStart = getColdStartStatus(site.addedAt, site.baseBudget, site.coldStartOverride);

    // Initialize token budget for this site (respecting cold start cap)
    const effectiveBudgetCap = Math.min(site.baseBudget, coldStart.budgetCap);
    getBudget(site.id, effectiveBudgetCap, site.capacity);

    // Acquire lock
    const lockExpiry = new Date(Date.now() + CRAWL_LOCK_TIMEOUT_MS);
    const jobId = `crawl:${site.id}:${Date.now()}`;

    await prisma.monitoredSite.update({
      where: { id: site.id },
      data: { crawlLock: jobId, crawlLockExpiresAt: lockExpiry },
    });

    // Queue legacy keyword crawl (runs alongside new system during transition)
    await scrapeQueue.add('crawl-site', {
      siteId: site.id,
      domain: site.domain,
      url: site.url,
    }, {
      jobId,
      attempts: 1,
      removeOnComplete: 50,
      removeOnFail: 100,
    });

    // Queue Tier 1 watermark crawl (new catalog system)
    await scrapeQueue.add('crawl-watermark', {
      siteId: site.id,
      domain: site.domain,
      url: site.url,
      baseBudget: effectiveBudgetCap,
      capacity: site.capacity,
      lastWatermarkUrl: site.lastWatermarkUrl,
      hasWaf: site.hasWaf,
    }, {
      jobId: `watermark:${site.id}:${Date.now()}`,
      attempts: 1,
      removeOnComplete: 50,
      removeOnFail: 100,
    });

    // Queue catalog tier crawls (Tiers 2-4) if cold start allows
    if (coldStart.catalogAllowed) {
      const tierState = parseTierState(site.tierState);
      const activeTiers = getActiveTiers(tierState);

      // Detect streams if not yet initialized (Phase 2)
      let streamState = parseStreamState(site.streamState);
      if (!streamState) {
        try {
          const streams = await detectStreams(site.url);
          if (streams.length > 0) {
            streamState = initStreamState(streams);
            await prisma.monitoredSite.update({
              where: { id: site.id },
              data: { streamState: streamState as any },
            });
            console.log(`[Scheduler] Detected ${streams.length} stream(s) for ${site.domain}: ${streams.map(s => s.id).join(', ')}`);
          }
        } catch (err) {
          console.error(`[Scheduler] Stream detection failed for ${site.domain}:`, err instanceof Error ? err.message : err);
          // Continue with legacy path
        }
      }

      if (activeTiers.tier2 || activeTiers.tier3 || activeTiers.tier4) {
        await scrapeQueue.add('crawl-catalog', {
          siteId: site.id,
          domain: site.domain,
          url: site.url,
          baseBudget: effectiveBudgetCap,
          capacity: site.capacity,
          tierState: JSON.stringify(tierState),
          activeTiers,
          hasWaf: site.hasWaf,
          crawlTuning: site.crawlTuning,
          streamState: streamState ?? undefined,
        }, {
          jobId: `catalog:${site.id}:${Date.now()}`,
          attempts: 1,
          removeOnComplete: 50,
          removeOnFail: 100,
        });
      }
    }

    incrementSiteCrawlCount(site.id);
    incrementGlobalCrawlCount();
    queued++;
  }

  if (queued > 0) {
    console.log(`[Scheduler] Queued ${queued} crawl(s) (${dueSites.length} due, ${availableSlots} slots available)`);
    pushEvent({
      type: 'info',
      message: `Scheduler: queued ${queued} crawl(s) of ${dueSites.length} due sites`,
    });
  }
}

// ── Post-Crawl Updates ───────────────────────────────────────────────────────

/**
 * Called after a crawl completes (success or failure).
 * Records CrawlEvent, updates site metrics, recalculates priority, releases lock.
 */
export async function onCrawlComplete(params: {
  siteId: string;
  status: 'success' | 'fail' | 'timeout' | 'blocked' | 'captcha';
  responseTimeMs?: number;
  statusCode?: number;
  matchesFound: number;
  errorMessage?: string;
  signals?: { hasWaf: boolean; hasRateLimit: boolean; hasCaptcha: boolean };
  headers?: Record<string, any>;
  usedPlaywright?: boolean;
  /** Updated watermark URL from Tier 1 crawl */
  newWatermarkUrl?: string | null;
  /** Updated tier state from catalog crawl */
  newTierState?: string;
}): Promise<void> {
  const { siteId, status, responseTimeMs, statusCode, matchesFound, errorMessage, signals } = params;

  if (!siteId) {
    console.error('[CrawlScheduler] onCrawlComplete called with missing siteId, skipping');
    return;
  }

  // 1. Record CrawlEvent
  await prisma.crawlEvent.create({
    data: {
      siteId,
      status,
      responseTimeMs,
      statusCode,
      matchesFound,
      errorMessage: errorMessage?.slice(0, 500),
    },
  });

  // 2. Update site metrics
  const site = await prisma.monitoredSite.findUnique({ where: { id: siteId } });
  if (!site) return;

  const updateData: Record<string, any> = {
    lastCrawlAt: new Date(),
    crawlLock: null,
    crawlLockExpiresAt: null,
  };

  if (status === 'success') {
    updateData.consecutiveFailures = 0;
  } else {
    updateData.consecutiveFailures = site.consecutiveFailures + 1;
  }

  // Update watermark if provided
  if (params.newWatermarkUrl !== undefined) {
    updateData.lastWatermarkUrl = params.newWatermarkUrl;
  }

  // Update tier state if provided
  if (params.newTierState) {
    updateData.tierState = JSON.parse(params.newTierState);
  }

  // Update difficulty signals if we have them
  if (signals) {
    if (signals.hasWaf && !site.hasWaf) updateData.hasWaf = true;
    if (signals.hasRateLimit && !site.hasRateLimit) updateData.hasRateLimit = true;
    if (signals.hasCaptcha && !site.hasCaptcha) updateData.hasCaptcha = true;
  }

  // Update average response time (rolling average over last value)
  if (responseTimeMs) {
    updateData.avgResponseTimeMs = site.avgResponseTimeMs
      ? Math.round((site.avgResponseTimeMs * 0.7) + (responseTimeMs * 0.3))
      : responseTimeMs;
  }

  await prisma.monitoredSite.update({ where: { id: siteId }, data: updateData });

  // 5. Recalculate pressure, capacity, interval, and nextCrawlAt
  await recalculateSitePriority(siteId);

  // 6. Apply backoff rules for failures
  if (status !== 'success') {
    await applyBackoff(siteId, status, updateData.consecutiveFailures ?? site.consecutiveFailures + 1);
  }
}

// ── Backoff Rules ────────────────────────────────────────────────────────────

async function applyBackoff(siteId: string, status: string, failures: number): Promise<void> {
  let minIntervalMin: number;

  if (status === 'blocked' || status === 'captcha') {
    minIntervalMin = 120; // 2 hours minimum for blocks
  } else if (failures >= 10) {
    await prisma.monitoredSite.update({
      where: { id: siteId },
      data: { isEnabled: false },
    });
    console.log(`[Scheduler] Site ${siteId} disabled after ${failures} consecutive failures`);
    pushEvent({ type: 'info', message: `Site disabled after ${failures} failures — requires manual re-enable` });
    return;
  } else if (failures >= 5) {
    minIntervalMin = 360; // 6 hours
    console.log(`[Scheduler] Site ${siteId}: ${failures} failures, backing off to 6 hours`);
  } else if (failures >= 3) {
    minIntervalMin = 60; // 1 hour circuit breaker
    console.log(`[Scheduler] Site ${siteId}: ${failures} failures, circuit breaker — 1 hour pause`);
  } else {
    minIntervalMin = 30; // At least 30 min after any failure
  }

  const minNext = new Date(Date.now() + minIntervalMin * 60 * 1000);
  const site = await prisma.monitoredSite.findUnique({
    where: { id: siteId },
    select: { nextCrawlAt: true },
  });

  if (!site?.nextCrawlAt || site.nextCrawlAt < minNext) {
    await prisma.monitoredSite.update({
      where: { id: siteId },
      data: { nextCrawlAt: minNext },
    });
  }
}

// ── Initial Setup ────────────────────────────────────────────────────────────

/**
 * Initialize all sites with staggered nextCrawlAt values.
 */
export async function initializeCrawlSchedule(): Promise<void> {
  const sites = await prisma.monitoredSite.findMany({
    where: { isEnabled: true, nextCrawlAt: null },
    orderBy: { domain: 'asc' },
  });

  if (sites.length === 0) return;

  console.log(`[Scheduler] Initializing crawl schedule for ${sites.length} sites`);

  const staggerIntervalMs = 2 * 60 * 1000;
  const now = Date.now();

  for (let i = 0; i < sites.length; i++) {
    const staggeredStart = new Date(now + (i * staggerIntervalMs));
    await prisma.monitoredSite.update({
      where: { id: sites[i].id },
      data: {
        nextCrawlAt: staggeredStart,
        crawlIntervalMin: 120,
      },
    });
  }

  console.log(`[Scheduler] Staggered ${sites.length} sites over ${Math.round(sites.length * 2)} minutes`);
}

// ── Crawl Event Cleanup ──────────────────────────────────────────────────────

export async function pruneCrawlEvents(): Promise<number> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const result = await prisma.crawlEvent.deleteMany({
    where: { crawledAt: { lt: cutoff } },
  });
  return result.count;
}
