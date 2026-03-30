import { Worker, Job } from 'bullmq';
import { redisConnection } from './queue';
import { pushEvent } from './debugLog';
import { prisma } from '../lib/prisma';
import { runHealthChecks, pruneOldHealthChecks } from './health-monitor';
import { schedulerTick, onCrawlComplete, initializeCrawlSchedule, pruneCrawlEvents } from './crawl-scheduler';
import { sendDailyDigests } from './daily-digest';
import { crawlWatermark } from './watermark-crawler';
import { crawlCatalogTier, parseTierState, getActiveTiers, startTierCycle, updateTierProgress, type TierState, crawlStreamTier, isStreamTierActive, startStreamTierCycle, completeStreamTierCycle } from './catalog-crawler';
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

  try {
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

      // No cooldowns — T2-T4 run continuously, limited only by budget
      updatedState[tierKey] = updateTierProgress(cycleState, result.pagesScanned, result.cycleComplete, tier, 0);

      console.log(`[CatalogWorker] Tier ${tier} ${result.status}: ${result.productsFound} products, ${result.pagesScanned} pages, ${result.tokensUsed} tokens${result.cycleComplete ? ' (cycle complete)' : ''}`);
    }

    await prisma.monitoredSite.update({
      where: { id: siteId },
      data: { tierState: updatedState as any },
    });

    pushEvent({ type: 'info', message: `Catalog crawl complete: ${domain}` });
  } catch (err) {
    console.error(`[CatalogWorker] Fatal error for ${domain}:`, err);
    pushEvent({ type: 'scrape_fail', websiteUrl: url, message: `Catalog crawl error: ${domain} — ${(err as Error).message}` });
  } finally {
    // Always release crawl lock so site isn't stuck for 5 minutes
    await prisma.monitoredSite.update({
      where: { id: siteId },
      data: { crawlLock: null },
    }).catch(e => console.error(`[CatalogWorker] Failed to release lock for ${domain}:`, e));
  }
}

/**
 * Stream-based catalog crawl.
 *
 * BOOTSTRAP MODE: All catalog tokens go to a single continuous paginated crawl.
 * No date filters, no tier partitioning. Just page 1 → 2 → ... → N as fast as possible.
 * Uses T4's tier state to track currentPage (T2/T3 are unused in bootstrap).
 *
 * MAINTAIN MODE is handled by processVerifyCrawl (separate job type).
 */
async function processStreamCatalogCrawl(
  data: CatalogJobData,
  streamState: SiteStreamState,
  tuning: ReturnType<typeof resolveTuning>,
  activeTiers: { tier2: boolean; tier3: boolean; tier4: boolean },
): Promise<void> {
  const { siteId, domain, url, baseBudget, capacity } = data;
  const now = new Date();
  const cooldownMap = { 2: 0, 3: 0, 4: 0 } as const;

  // ── BOOTSTRAP: single continuous crawl using ALL catalog tokens ──
  // No date filters, no tier splitting. One stream, one pagination cursor.
  // Track progress in T4's tier state (T2/T3 mirror T4 for compatibility).
  const stream = streamState.streams[0];
  if (!stream) return;

  const stateKey = `${stream.id}:4`; // Use T4 as the bootstrap cursor
  let tierState = streamState.tiers[stateKey];
  if (!tierState) {
    // Initialize if missing
    tierState = {
      streamId: stream.id, tier: 4, status: 'idle',
      currentPage: 1, pageRangeStart: 1,
    } as any;
    streamState.tiers[stateKey] = tierState;
  }

  // Get ALL remaining catalog tokens (not split by tier)
  const { getCatalogRemaining } = await import('./token-budget');
  const totalCatalogTokens = getCatalogRemaining(siteId, baseBudget, capacity);
  if (totalCatalogTokens <= 0) return;

  // Start cycle if idle
  if (tierState.status === 'idle' || tierState.status === 'cooldown') {
    tierState.status = 'in_progress';
    tierState.cycleStartedAt = now.toISOString();
    // DON'T reset currentPage — resume from where we left off
    // Clear date ranges — bootstrap crawls ALL products, no date filter
    tierState.dateRangeStart = undefined;
    tierState.dateRangeEnd = undefined;
  }

  console.log(`[CatalogWorker] Bootstrap crawl: ${domain} — page ${tierState.currentPage}, ${totalCatalogTokens} tokens`);

  // Read perPage from site profile (WAF sites need smaller pages for Store API enrichment)
  const { _getSiteCacheEntry } = await import('./scraper/adapter-registry');
  const profileEntry = _getSiteCacheEntry(domain.replace(/^www\./, ''));
  const profilePerPage = profileEntry?.siteProfile?.perPage;

  // Crawl using the adapter, NO date filters
  const result = await crawlStreamTier({
    siteId, url, domain, stream,
    tier: 4,
    tierState,
    tokensAllocated: totalCatalogTokens,
    hasWaf: data.hasWaf,
    perPage: profilePerPage,
  });

  // Update totalPages if discovered
  if (result.totalPagesDiscovered) {
    stream.totalPages = result.totalPagesDiscovered;
  }

  if (result.cycleComplete) {
    // Truly reached the end — reset to page 1 for next full pass
    tierState.status = 'idle';
    tierState.currentPage = 1;
    tierState.lastRefreshedAt = now.toISOString();
    tierState.lastCycleStartedAt = tierState.cycleStartedAt;
    tierState.lastCycleCompletedAt = now.toISOString();
    tierState.cycleStartedAt = undefined;
    // Also mark T2/T3 as complete (for bootstrap completion check)
    for (const t of [2, 3] as const) {
      const k = `${stream.id}:${t}`;
      if (streamState.tiers[k]) {
        streamState.tiers[k].lastCycleCompletedAt = now.toISOString();
        streamState.tiers[k].status = 'idle';
      }
    }
    console.log(`[CatalogWorker] Bootstrap complete for ${domain}: ${result.productsFound} products on final pass`);
  }
  // If not complete, currentPage was updated in-place by crawlStreamTier

  // Persist
  await prisma.monitoredSite.update({
    where: { id: siteId },
    data: { streamState: streamState as any },
  });

  pushEvent({ type: 'info', message: `Bootstrap crawl: ${domain} page ${tierState.currentPage}` });

  // Self-queue next batch
  try {
    const remaining = getCatalogRemaining(siteId, baseBudget, capacity);
    if (remaining > 0 && !result.cycleComplete) {
      const { scrapeQueue: sq } = await import('./queue');
      const site = await prisma.monitoredSite.findUnique({
        where: { id: siteId },
        select: { streamState: true, crawlTuning: true, crawlPhase: true },
      });
      if (site && (site as any).crawlPhase === 'bootstrap') {
        await sq.add('crawl-catalog', {
          siteId, domain, url: data.url,
          baseBudget: data.baseBudget, capacity: data.capacity,
          tierState: data.tierState, activeTiers: data.activeTiers,
          hasWaf: data.hasWaf, crawlTuning: site.crawlTuning,
          streamState: parseStreamState(site.streamState) ?? undefined,
        }, {
          jobId: `catalog-${siteId}-${Date.now()}`,
          attempts: 1, removeOnComplete: 50, removeOnFail: 100,
        });
      }
    }
  } catch (err) {
    console.error(`[CatalogWorker] Bootstrap self-queue failed for ${domain}:`, err instanceof Error ? err.message : err);
  }

  return;
}

// ── OLD TIER-SPLIT CODE (preserved as _legacyStreamCatalogCrawl for potential reuse) ──
async function _legacyStreamCatalogCrawl(
  data: CatalogJobData,
  streamState: SiteStreamState,
  tuning: ReturnType<typeof resolveTuning>,
  activeTiers: { tier2: boolean; tier3: boolean; tier4: boolean },
): Promise<void> {
  const { siteId, domain, url, baseBudget, capacity } = data;
  const now = new Date();
  const cooldownMap = { 2: 0, 3: 0, 4: 0 } as const;
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
    } else if (result.status === 'fail') {
      // API error (expired cookies, network timeout, etc.) — reset to idle with a short
      // cooldown so we don't hammer the site. Keep currentPage so we resume from where
      // we stopped instead of restarting from page 1.
      const retryCooldown = new Date(Date.now() + 30 * 60 * 1000); // 30 min backoff
      tierState.status = 'cooldown';
      tierState.cooldownEndsAt = retryCooldown.toISOString();
      tierState.cycleStartedAt = undefined;
      streamState.tiers[stateKey] = tierState;
      console.log(`[CatalogWorker] Stream "${chosen.id}" T${tier}: failed, backing off 30min (resume at page ${tierState.currentPage})`);
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

  // Self-queue: immediately queue next catalog job if budget remains (bootstrap continuous crawl)
  try {
    const { getCatalogRemaining } = await import('./token-budget');
    const remaining = getCatalogRemaining(siteId, data.baseBudget, data.capacity);
    if (remaining > 0) {
      const site = await prisma.monitoredSite.findUnique({
        where: { id: siteId },
        select: { tierState: true, streamState: true, crawlTuning: true, hasWaf: true, crawlPhase: true },
      });
      if (site && (site as any).crawlPhase === 'bootstrap') {
        const freshStreamState = parseStreamState(site.streamState);
        const freshTierState = parseTierState(site.tierState);
        const freshActiveTiers = getActiveTiers(freshTierState);
        if (freshActiveTiers.tier2 || freshActiveTiers.tier3 || freshActiveTiers.tier4) {
          const { scrapeQueue: sq } = await import('./queue');
          await sq.add('crawl-catalog', {
            siteId, domain, url: data.url,
            baseBudget: data.baseBudget, capacity: data.capacity,
            tierState: JSON.stringify(freshTierState),
            activeTiers: freshActiveTiers,
            hasWaf: data.hasWaf,
            crawlTuning: site.crawlTuning,
            streamState: freshStreamState ?? undefined,
          }, {
            jobId: `catalog-${siteId}-${Date.now()}`,
            attempts: 1, removeOnComplete: 50, removeOnFail: 100,
          });
        }
      }
    }
  } catch (err) {
    // Self-queue failure is non-fatal — scheduler tick will pick it up
    console.error(`[CatalogWorker] Self-queue failed for ${domain}:`, err instanceof Error ? err.message : err);
  }
}

// ─── Maintain Phase: Product Verification Job ────────────────────────────────

interface VerifyJobData {
  siteId: string;
  domain: string;
  tier: 2 | 3 | 4;
  productIds: string[];
  hasWaf?: boolean;
}

async function processVerifyCrawl(job: Job<VerifyJobData>): Promise<void> {
  const { siteId, domain, tier, productIds, hasWaf } = job.data;
  const { verifyProduct } = await import('./product-verifier');
  const { randomDelay } = await import('./scraper/http-client');

  console.log(`[VerifyWorker] T${tier} verifying ${productIds.length} products for ${domain}`);

  const products = await prisma.productIndex.findMany({
    where: { id: { in: productIds } },
  });

  let verified = 0, updated = 0, sold = 0, deleted = 0, errors = 0;

  for (const product of products) {
    try {
      const result = await verifyProduct({ url: product.url, domain, hasWaf });
      const now = new Date();

      if (result.status === 'deleted') {
        // Preserve all last known data — just mark inactive
        await prisma.productIndex.update({
          where: { id: product.id },
          data: {
            isActive: false,
            staleSince: product.staleSince ?? now,
            staleVerifiedAt: now,
            verifyErrors: 0,
          },
        });
        deleted++;
      } else if (result.status === 'sold') {
        await prisma.productIndex.update({
          where: { id: product.id },
          data: {
            stockStatus: 'out_of_stock',
            staleSince: product.staleSince ?? now,
            staleVerifiedAt: now,
            lastSeenAt: now, // Page exists, just sold
            verifyErrors: 0,
          },
        });
        sold++;
      } else if (result.status === 'wanted') {
        await prisma.productIndex.update({
          where: { id: product.id },
          data: {
            category: 'wanted',
            lastSeenAt: now,
            staleVerifiedAt: now,
            verifyErrors: 0,
          },
        });
        updated++;
      } else if (result.status === 'alive') {
        const update: Record<string, any> = {
          lastSeenAt: now,
          staleSince: null,
          staleVerifiedAt: now,
          verifyErrors: 0,
          isActive: true,
        };
        if (result.title) update.title = result.title;
        if (result.price != null) update.price = result.price;
        if (result.regularPrice != null) update.regularPrice = result.regularPrice;
        if (result.stockStatus) update.stockStatus = result.stockStatus;
        if (result.thumbnail) update.thumbnail = result.thumbnail;

        await prisma.productIndex.update({
          where: { id: product.id },
          data: update,
        });
        updated++;
      } else {
        // status === 'error' — increment error counter
        const newErrors = (product.verifyErrors || 0) + 1;
        const tuning = resolveTuning(null);
        if (newErrors >= tuning.maxVerifyErrors) {
          // Too many consecutive errors — mark as deleted (garbage collection)
          await prisma.productIndex.update({
            where: { id: product.id },
            data: {
              isActive: false,
              staleSince: product.staleSince ?? now,
              staleVerifiedAt: now,
              verifyErrors: newErrors,
            },
          });
          deleted++;
          console.log(`[VerifyWorker] ${domain}: ${product.title.substring(0, 40)} — ${newErrors} consecutive errors, marking deleted`);
        } else {
          await prisma.productIndex.update({
            where: { id: product.id },
            data: { verifyErrors: newErrors, staleVerifiedAt: now },
          });
          errors++;
        }
      }

      verified++;
      await randomDelay(300, 800);
    } catch (err) {
      console.error(`[VerifyWorker] ${domain}: error verifying ${product.url}:`, err instanceof Error ? err.message : err);
      errors++;
    }
  }

  console.log(
    `[VerifyWorker] ${domain} T${tier}: verified=${verified} updated=${updated} sold=${sold} deleted=${deleted} errors=${errors}`
  );

  // Self-queue: immediately check for more work instead of waiting for scheduler tick
  await selfQueueNextBatch(siteId, domain, tier, hasWaf);
}

// Track when each tier completed its cycle (no more products to verify).
// Key: "siteId:tier" → cooldown end time. Scheduler tick also checks this.
const maintainCooldowns = new Map<string, number>();

/** Check if a maintain tier is in cooldown */
export function isMaintainTierInCooldown(siteId: string, tier: 2 | 3 | 4): boolean {
  const key = `${siteId}:${tier}`;
  const cooldownEnd = maintainCooldowns.get(key);
  if (!cooldownEnd) return false;
  if (Date.now() >= cooldownEnd) {
    maintainCooldowns.delete(key);
    return false;
  }
  return true;
}

/**
 * After finishing a verify batch, immediately queue the next batch if budget allows.
 * This eliminates the 2-minute scheduler tick delay between batches.
 * When a tier has 0 remaining products, it enters cooldown (T2=3h, T3=5h, T4=9h).
 * If a tier's cycle was not complete before cooldown ends, it continues where it left off.
 */
async function selfQueueNextBatch(
  siteId: string,
  domain: string,
  tier: 2 | 3 | 4,
  hasWaf?: boolean,
): Promise<void> {
  try {
    // Check cooldown first — don't query DB if tier is cooling down
    if (isMaintainTierInCooldown(siteId, tier)) return;

    const site = await prisma.monitoredSite.findUnique({
      where: { id: siteId },
      select: { baseBudget: true, capacity: true, crawlTuning: true, crawlPhase: true, hasWaf: true },
    });
    if (!site || (site as any).crawlPhase !== 'maintain') return;

    const { allocateMaintainTokens } = await import('./token-budget');
    const tuning = resolveTuning(site.crawlTuning);
    const allocation = allocateMaintainTokens(siteId, site.baseBudget, site.capacity, tuning);

    const tierTokens = tier === 2 ? allocation.tier2 : tier === 3 ? allocation.tier3 : allocation.tier4;
    if (tierTokens <= 0) return; // No budget left

    const tierConfig = {
      2: { minDays: tuning.maintainT2MinDays, maxDays: tuning.maintainT2MaxDays },
      3: { minDays: tuning.maintainT3MinDays, maxDays: tuning.maintainT3MaxDays },
      4: { minDays: tuning.maintainT4MinDays, maxDays: tuning.maintainT4MaxDays ?? 365 },
    }[tier];

    const now = new Date();
    const minDate = new Date(now.getTime() - tierConfig.maxDays * 86400000);
    const maxDate = new Date(now.getTime() - tierConfig.minDays * 86400000);

    const products = await prisma.productIndex.findMany({
      where: {
        siteId,
        isActive: true,
        OR: [
          { staleVerifiedAt: { gte: minDate, lte: maxDate } },
          ...(tier === 4 ? [{ staleVerifiedAt: null }] : []),
        ],
      },
      orderBy: { staleVerifiedAt: 'asc' },
      take: tierTokens,
      select: { id: true },
    });

    if (products.length === 0) {
      // Tier completed its cycle — enter cooldown
      const cooldownHrs = { 2: tuning.maintainT2CooldownHrs, 3: tuning.maintainT3CooldownHrs, 4: tuning.maintainT4CooldownHrs }[tier];
      const cooldownEnd = Date.now() + cooldownHrs * 3600000;
      maintainCooldowns.set(`${siteId}:${tier}`, cooldownEnd);
      console.log(`[VerifyWorker] ${domain} T${tier}: cycle complete, cooldown ${cooldownHrs}h`);
      return;
    }

    const { scrapeQueue } = await import('./queue');
    await scrapeQueue.add('crawl-verify', {
      siteId,
      domain,
      tier,
      productIds: products.map(p => p.id),
      hasWaf: hasWaf ?? site.hasWaf,
    }, {
      jobId: `verify-${siteId}-t${tier}-${Date.now()}`,
      attempts: 1,
      removeOnComplete: 50,
      removeOnFail: 100,
    });
  } catch (err) {
    // Self-queue failure is non-fatal — scheduler tick will pick it up
    console.error(`[VerifyWorker] Self-queue failed for ${domain} T${tier}:`, err instanceof Error ? err.message : err);
  }
}

// ─── Worker Startup ──────────────────────────────────────────────────────────

export function startWorker(): Worker {
  const worker = new Worker('scrape', async (job) => {
    if (job.name === 'crawl-watermark') {
      await processWatermarkCrawl(job as Job<WatermarkJobData>);
    } else if (job.name === 'crawl-catalog') {
      await processCatalogCrawl(job as Job<CatalogJobData>);
    } else if (job.name === 'crawl-verify') {
      await processVerifyCrawl(job as Job<VerifyJobData>);
    } else {
      console.log(`[Worker] Skipping legacy job ${job.name} (${job.id})`);
    }
  }, {
    connection: redisConnection,
    concurrency: 20,
    lockDuration: 300000,     // 5 minutes — crawl jobs can run 30-120s+
    lockRenewTime: 150000,    // Renew lock every 2.5 minutes
    stalledInterval: 300000,  // Check for stalled jobs every 5 minutes
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

// ─── Stale Product Check Worker (Daily — sold/deleted detection) ─────────────

export function startStaleCheckWorker(): Worker {
  const worker = new Worker('stale-check', async () => {
    console.log('[StaleWorker] Running daily stale product check...');

    const sites = await prisma.monitoredSite.findMany({
      where: { isEnabled: true, isPaused: false },
      select: { id: true, domain: true, streamState: true },
    });

    const { checkStaleProducts } = await import('./stale-detector');
    const { parseStreamState } = await import('./stream-detector');

    let totalSold = 0;
    let totalInactive = 0;
    let totalFP = 0;

    for (const site of sites) {
      const ss = parseStreamState(site.streamState);
      if (!ss || ss.streams.length === 0) continue;

      try {
        const result = await checkStaleProducts(site.id, ss.streams[0].id, ss);
        totalSold += result.markedSold;
        totalInactive += result.markedInactive;
        totalFP += result.falsePositives;

        if (result.candidatesFound > 0) {
          console.log(
            `[StaleWorker] ${site.domain}: ${result.candidatesFound} candidates, ` +
            `${result.markedSold} sold, ${result.markedInactive} inactive, ` +
            `${result.falsePositives} false positives`
          );
        }
      } catch (err) {
        console.error(`[StaleWorker] ${site.domain}: error —`, err instanceof Error ? err.message : err);
      }
    }

    console.log(`[StaleWorker] Daily stale check complete: ${totalSold} sold, ${totalInactive} deactivated, ${totalFP} false positives across ${sites.length} sites`);

    // ── Auto-adjust budgets based on catalog size ──
    // <100: 20/hr, 100-500: 40, 500-2000: 60, 2000-5000: 90, 5000-10000: 120, 10000+: 180
    const allSites = await prisma.monitoredSite.findMany({
      where: { isEnabled: true, isPaused: false },
      select: { id: true, domain: true, baseBudget: true },
    });
    // Single query instead of N+1 count queries
    const counts = await prisma.productIndex.groupBy({
      by: ['siteId'],
      where: { isActive: true },
      _count: true,
    });
    const countMap = new Map(counts.map(c => [c.siteId, c._count]));

    let budgetChanges = 0;
    for (const site of allSites) {
      const count = countMap.get(site.id) || 0;
      const target = count < 100 ? 20 : count < 500 ? 40 : count < 2000 ? 60 : count < 5000 ? 90 : count < 10000 ? 120 : 180;
      if (site.baseBudget !== target) {
        await prisma.monitoredSite.update({ where: { id: site.id }, data: { baseBudget: target } });
        console.log(`[StaleWorker] Budget adjusted: ${site.domain} ${site.baseBudget} → ${target} (${count} products)`);
        budgetChanges++;
      }
    }
    if (budgetChanges > 0) {
      console.log(`[StaleWorker] Adjusted ${budgetChanges} site budget(s)`);
    }
  }, {
    connection: redisConnection,
    concurrency: 1,
  });

  worker.on('error', (err) => {
    console.error(`[StaleWorker] Worker error: ${err.message}`);
  });

  console.log('[StaleWorker] Stale check worker started');
  return worker;
}
