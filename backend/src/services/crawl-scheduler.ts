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

import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { scrapeQueue } from './queue';
import { recalculateSitePriority } from './priority-engine';
import { pushEvent } from './debugLog';
import { getColdStartStatus } from './cold-start';
import { getBudget } from './token-budget';
import { parseTierState, getActiveTiers } from './catalog-crawler';
import { detectStreams, initStreamState, parseStreamState, probeStreamTotalPages } from './stream-detector';
import { resolveTuning } from './crawl-tuning';

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
  try {
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

  // 2b. Recover stale/expired stream tiers for ALL enabled sites
  // This runs regardless of whether sites are "due" — stuck tiers can prevent
  // sites from becoming due in the first place, creating a deadlock.
  const STALE_PROGRESS_MS = 15 * 60 * 1000;
  const allEnabledSites = dueSites.length > 0 ? dueSites : await prisma.monitoredSite.findMany({
    where: { isEnabled: true, isPaused: false, NOT: { streamState: { equals: Prisma.DbNull } } },
    select: { id: true, domain: true, streamState: true },
  });
  for (const site of allEnabledSites) {
    const ss = parseStreamState(site.streamState);
    if (!ss) continue;
    let needsPersist = false;
    for (const [, ts] of Object.entries(ss.tiers)) {
      if (ts.status === 'in_progress' && ts.cycleStartedAt) {
        const age = now.getTime() - new Date(ts.cycleStartedAt).getTime();
        if (age > STALE_PROGRESS_MS) {
          ts.status = 'idle';
          ts.currentPage = ts.pageRangeStart || 1;
          ts.currentPageUrl = undefined;
          ts.cycleStartedAt = undefined;
          needsPersist = true;
        }
      }
      if (ts.status === 'cooldown' && ts.cooldownEndsAt && new Date(ts.cooldownEndsAt) <= now) {
        ts.status = 'idle';
        ts.cooldownEndsAt = undefined;
        needsPersist = true;
      }
    }
    if (needsPersist) {
      await prisma.monitoredSite.update({
        where: { id: site.id },
        data: { streamState: ss as any },
      });
      console.log(`[Scheduler] ${site.domain}: recovered stale/expired stream tiers`);
    }
  }

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

    // Queue Tier 1 watermark crawl
    const tuning = resolveTuning(site.crawlTuning);
    const tuningObj = (site.crawlTuning && typeof site.crawlTuning === 'object') ? site.crawlTuning as Record<string, any> : {};
    await scrapeQueue.add('crawl-watermark', {
      siteId: site.id,
      domain: site.domain,
      url: site.url,
      baseBudget: effectiveBudgetCap,
      capacity: site.capacity,
      lastWatermarkUrl: site.lastWatermarkUrl,
      lastWatermarkDate: tuningObj.lastWatermarkDate || null,
      crawlTuning: site.crawlTuning,
      hasWaf: site.hasWaf,
    }, {
      jobId: `watermark:${site.id}:${Date.now()}`,
      attempts: 1,
      removeOnComplete: 50,
      removeOnFail: 100,
    });

    // Queue T2-T4 work based on crawl phase
    if (coldStart.catalogAllowed) {
      if ((site as any).crawlPhase === 'maintain') {
        // ── MAINTAIN PHASE: verify products from DB ──
        console.log(`[Scheduler] ${site.domain}: maintain phase, queuing verification`);
        await queueMaintainVerification(site, effectiveBudgetCap, tuning);
      } else {
        // ── BOOTSTRAP PHASE: crawl listing pages (current approach) ──
        const tierState = parseTierState(site.tierState);
        const activeTiers = getActiveTiers(tierState);

        // Detect streams if not yet initialized
        let streamState = parseStreamState(site.streamState);
        if (!streamState) {
          try {
            const streams = await detectStreams(site.url, { hasWaf: site.hasWaf });
            if (streams.length > 0) {
              await probeStreamTotalPages(streams, site.url, { hasWaf: site.hasWaf });
              streamState = initStreamState(streams);
              const pagesInfo = streams.filter(s => s.totalPages).map(s => `${s.id}:${s.totalPages}p`).join(', ');
              await prisma.monitoredSite.update({
                where: { id: site.id },
                data: { streamState: streamState as any },
              });
              console.log(`[Scheduler] Detected ${streams.length} stream(s) for ${site.domain}: ${streams.map(s => s.id).join(', ')}${pagesInfo ? ` (pages: ${pagesInfo})` : ''}`);
            }
          } catch (err) {
            console.error(`[Scheduler] Stream detection failed for ${site.domain}:`, err instanceof Error ? err.message : err);
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

        // Check if bootstrap is complete → transition to maintain
        await checkBootstrapComplete(site);
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
  } catch (err) {
    console.error('[Scheduler] schedulerTick failed:', err instanceof Error ? err.message : err);
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
  /** Updated watermark date (modified/bumped date of newest listing) */
  newWatermarkDate?: string;
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

  // Store watermark date in crawlTuning JSON (avoids schema change)
  if (params.newWatermarkDate) {
    const currentTuning = (site.crawlTuning && typeof site.crawlTuning === 'object') ? site.crawlTuning as Record<string, any> : {};
    updateData.crawlTuning = { ...currentTuning, lastWatermarkDate: params.newWatermarkDate };
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

// ── Maintain Phase: DB-Based Verification ────────────────────────────────────

/**
 * Queue verification jobs for maintain-phase sites.
 * Queries products from DB sorted by lastSeenAt ASC within each tier's date window.
 * T1 gets priority on budget, T2-T4 share ALL remaining tokens.
 */
async function queueMaintainVerification(
  site: any,
  effectiveBudgetCap: number,
  tuning: ReturnType<typeof resolveTuning>,
): Promise<void> {
  const now = new Date();
  const { allocateMaintainTokens } = await import('./token-budget');
  const allocation = allocateMaintainTokens(site.id, effectiveBudgetCap, site.capacity, tuning);

  const tiers = [
    { tier: 2 as const, minDays: tuning.maintainT2MinDays, maxDays: tuning.maintainT2MaxDays, tokens: allocation.tier2 },
    { tier: 3 as const, minDays: tuning.maintainT3MinDays, maxDays: tuning.maintainT3MaxDays, tokens: allocation.tier3 },
    { tier: 4 as const, minDays: tuning.maintainT4MinDays, maxDays: tuning.maintainT4MaxDays ?? 365, tokens: allocation.tier4 },
  ];

  for (const t of tiers) {
    if (t.tokens <= 0) continue;

    const minDate = new Date(now.getTime() - t.maxDays * 86400000);
    const maxDate = new Date(now.getTime() - t.minDays * 86400000);

    // Use staleVerifiedAt (last detail-page check) not lastSeenAt (last listing-page crawl).
    // Products with null staleVerifiedAt have NEVER been verified — T4 picks them up.
    const products = await prisma.productIndex.findMany({
      where: {
        siteId: site.id,
        isActive: true,
        OR: [
          // Products verified within the tier's date window
          { staleVerifiedAt: { gte: minDate, lte: maxDate } },
          // Products NEVER verified — T4 (21+ days) picks up all unverified products
          ...(t.tier === 4 ? [{ staleVerifiedAt: null }] : []),
        ],
      },
      orderBy: { staleVerifiedAt: 'asc' },
      take: t.tokens,
      select: { id: true },
    });

    if (products.length > 0) {
      await scrapeQueue.add('crawl-verify', {
        siteId: site.id,
        domain: site.domain,
        tier: t.tier,
        productIds: products.map(p => p.id),
        hasWaf: site.hasWaf,
      }, {
        jobId: `verify-${site.id}-t${t.tier}-${Date.now()}`,
        attempts: 1,
        removeOnComplete: 50,
        removeOnFail: 100,
      });
    }
  }
}

/**
 * Check if a site's bootstrap is complete.
 * All streams must have completed at least one cycle across all tiers.
 * Also compares DB count vs live count — if significantly lower, don't transition.
 */
async function checkBootstrapComplete(site: any): Promise<void> {
  if ((site as any).crawlPhase !== 'bootstrap') return;

  const streamState = parseStreamState(site.streamState);
  if (!streamState) return;

  // All tiers on all streams must have completed at least one cycle
  for (const stream of streamState.streams) {
    for (const tier of [2, 3, 4]) {
      const key = `${stream.id}:${tier}`;
      const ts = streamState.tiers[key];
      if (!ts?.lastCycleCompletedAt) return; // Not complete yet
    }
  }

  // All tiers completed — transition to maintain phase
  await prisma.monitoredSite.update({
    where: { id: site.id },
    data: {
      crawlPhase: 'maintain',
      bootstrapCompletedAt: new Date(),
      // Clear streamState — not needed in maintain phase
      // (but keep it in DB for reference, just don't use it)
    },
  });

  console.log(`[Scheduler] ${site.domain}: bootstrap complete → maintain phase`);
}

// ── Crawl Event Cleanup ──────────────────────────────────────────────────────

export async function pruneCrawlEvents(): Promise<number> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const result = await prisma.crawlEvent.deleteMany({
    where: { crawledAt: { lt: cutoff } },
  });
  return result.count;
}
