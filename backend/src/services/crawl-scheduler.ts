/**
 * Unified Crawl Scheduler — one crawl schedule per site, shared by all users.
 *
 * A BullMQ cron job ticks every 2 minutes and checks which sites are due.
 * No user action ever triggers a crawl directly. The priority engine determines
 * each site's interval based on demand, difficulty, traffic class, and health.
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
 * 3. Enforce safety ceilings
 * 4. Queue crawl jobs for eligible sites
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

  // 2. Find sites due for crawling
  const dueSites = await prisma.monitoredSite.findMany({
    where: {
      isEnabled: true,
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

    // Acquire lock
    const lockExpiry = new Date(Date.now() + CRAWL_LOCK_TIMEOUT_MS);
    const jobId = `crawl:${site.id}:${Date.now()}`;

    await prisma.monitoredSite.update({
      where: { id: site.id },
      data: { crawlLock: jobId, crawlLockExpiresAt: lockExpiry },
    });

    // Queue the crawl job
    await scrapeQueue.add('crawl-site', {
      siteId: site.id,
      domain: site.domain,
      url: site.url,
      difficultyScore: site.difficultyScore,
    }, {
      jobId,
      attempts: 1, // No auto-retry — scheduler handles backoff
      removeOnComplete: 50,
      removeOnFail: 100,
    });

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
}): Promise<void> {
  const { siteId, status, responseTimeMs, statusCode, matchesFound, errorMessage, signals } = params;

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

  // Update difficulty signals if we have them
  if (signals) {
    if (signals.hasWaf && !site.hasWaf) updateData.hasWaf = true;
    if (signals.hasRateLimit && !site.hasRateLimit) updateData.hasRateLimit = true;
    if (signals.hasCaptcha && !site.hasCaptcha) updateData.hasCaptcha = true;
  }

  // Update average response time (rolling average over last value)
  if (responseTimeMs) {
    updateData.avgResponseTimeMs = site.avgResponseTimeMs
      ? Math.round((site.avgResponseTimeMs * 0.7) + (responseTimeMs * 0.3)) // Weighted moving average
      : responseTimeMs;
  }

  // 3. Update traffic class dynamically (piggyback on crawl data)
  if (!site.overrideTrafficClass && params.headers) {
    const { classifyTraffic, detectInfraSignals, computeErrorRate } = await import('./traffic-classifier');

    const infraSignals = detectInfraSignals(params.headers);

    // Get recent crawl statuses for error rate
    const recentCrawls = await prisma.crawlEvent.findMany({
      where: { siteId },
      orderBy: { crawledAt: 'desc' },
      take: 10,
      select: { status: true },
    });
    const errorRate = computeErrorRate(recentCrawls.map(c => c.status));

    const newTrafficClass = classifyTraffic({
      avgResponseTimeMs: updateData.avgResponseTimeMs ?? site.avgResponseTimeMs,
      recentErrorRate: errorRate,
      hasCdn: infraSignals.hasCdn,
      hasWaf: infraSignals.hasWaf || site.hasWaf,
      requiresSucuri: site.requiresSucuri,
      serverType: infraSignals.serverType,
      consecutiveFailures: updateData.consecutiveFailures ?? site.consecutiveFailures,
    });

    updateData.trafficClass = newTrafficClass;
  }

  // 4. Compute difficulty score
  if (!site.overrideDifficulty) {
    const { computeDifficulty } = await import('./priority-engine');
    updateData.difficultyScore = computeDifficulty(
      { ...site, ...updateData },
      updateData.avgResponseTimeMs ?? site.avgResponseTimeMs
    );
  }

  await prisma.monitoredSite.update({ where: { id: siteId }, data: updateData });

  // 5. Recalculate priority and set nextCrawlAt
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
    // Disable site after 10 consecutive failures
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

  // Ensure nextCrawlAt is at least minIntervalMin from now
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
 * Called once during first setup or migration.
 */
export async function initializeCrawlSchedule(): Promise<void> {
  const sites = await prisma.monitoredSite.findMany({
    where: { isEnabled: true, nextCrawlAt: null },
    orderBy: { domain: 'asc' },
  });

  if (sites.length === 0) return;

  console.log(`[Scheduler] Initializing crawl schedule for ${sites.length} sites`);

  // Stagger crawls evenly across the first interval window
  const staggerIntervalMs = 2 * 60 * 1000; // 2 minutes between each site's first crawl
  const now = Date.now();

  for (let i = 0; i < sites.length; i++) {
    const staggeredStart = new Date(now + (i * staggerIntervalMs));
    await prisma.monitoredSite.update({
      where: { id: sites[i].id },
      data: {
        nextCrawlAt: staggeredStart,
        crawlIntervalMin: 120, // Default 2 hours until priority engine takes over
      },
    });
  }

  console.log(`[Scheduler] Staggered ${sites.length} sites over ${Math.round(sites.length * 2)} minutes`);
}

// ── Crawl Event Cleanup ──────────────────────────────────────────────────────

/**
 * Prune old CrawlEvents to prevent unbounded growth.
 * Keeps last 30 days of events.
 */
export async function pruneCrawlEvents(): Promise<number> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const result = await prisma.crawlEvent.deleteMany({
    where: { crawledAt: { lt: cutoff } },
  });
  return result.count;
}
