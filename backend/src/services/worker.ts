import { Worker, Job } from 'bullmq';
import { redisConnection } from './queue';
import { pushEvent } from './debugLog';
import { prisma } from '../lib/prisma';
import { runHealthChecks, pruneOldHealthChecks } from './health-monitor';
import { schedulerTick, onCrawlComplete, initializeCrawlSchedule, pruneCrawlEvents } from './crawl-scheduler';
import { sendDailyDigests } from './daily-digest';
import { crawlWatermark } from './watermark-crawler';
import { crawlCatalogTier, parseTierState, startTierCycle, updateTierProgress, type TierState, crawlStreamTier } from './catalog-crawler';
import { expireFreeAlerts } from './free-tier';
import { allocateCatalogTokens } from './token-budget';
import { resolveTuning } from './crawl-tuning';
import { parseStreamState } from './stream-detector';
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
  crawlIntervalMin?: number;
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
    pagesScanned: result.pagesScanned,
    tokensUsed: result.tokensUsed,
    tier: 1,
    jobType: 'crawl-watermark',
    errorMessage: result.errorMessage,
    signals: result.signals,
    headers: result.headers,
    newWatermarkUrl: result.newWatermarkUrl,
    newWatermarkDate: result.newWatermarkDate,
  });

  // Mark T1 run as completed — releases proportional token share to verify tiers
  const { completeTier1Run } = await import('./token-budget');
  completeTier1Run(siteId);

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

    const allocation = allocateCatalogTokens(siteId, baseBudget, capacity, activeTiers, tuning, job.data.crawlIntervalMin || 20);
    const updatedState: TierState = { ...tierState };
    let totalProductsFound = 0;
    let totalPagesScanned = 0;
    let legacyError: string | undefined;

    for (const tier of [2, 3, 4] as const) {
      const tierKey = `tier${tier}` as keyof typeof activeTiers;
      if (!activeTiers[tierKey] || allocation[tierKey] <= 0) continue;

      let cycleState = updatedState[tierKey];
      if (cycleState.status === 'idle' || cycleState.status === 'cooldown') {
        const prevEmptyApiCycles = cycleState.consecutiveEmptyApiCycles;
        cycleState = startTierCycle(tier);
        if (prevEmptyApiCycles) cycleState.consecutiveEmptyApiCycles = prevEmptyApiCycles;
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

      totalProductsFound += result.productsFound;
      totalPagesScanned += result.pagesScanned;
      if (result.status === 'fail' && result.errorMessage) legacyError = result.errorMessage;

      console.log(`[CatalogWorker] Tier ${tier} ${result.status}: ${result.productsFound} products, ${result.pagesScanned} pages, ${result.tokensUsed} tokens${result.cycleComplete ? ' (cycle complete)' : ''}`);
    }

    await prisma.monitoredSite.update({
      where: { id: siteId },
      data: { tierState: updatedState as any },
    });

    // Record CrawlEvent and update site metrics
    await onCrawlComplete({
      siteId,
      status: legacyError ? 'fail' : 'success',
      matchesFound: totalProductsFound,
      pagesScanned: totalPagesScanned,
      jobType: 'crawl-catalog',
      errorMessage: legacyError,
    });

    pushEvent({ type: 'info', message: `Catalog crawl complete: ${domain} — ${totalProductsFound} products, ${totalPagesScanned} pages` });
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
  const profilePaginationPattern = profileEntry?.siteProfile?.paginationPattern;

  // Crawl using the adapter, NO date filters
  const result = await crawlStreamTier({
    siteId, url, domain, stream,
    tier: 4,
    tierState,
    tokensAllocated: totalCatalogTokens,
    hasWaf: data.hasWaf,
    perPage: profilePerPage,
    paginationPattern: profilePaginationPattern,
  });

  // Update totalPages if discovered
  if (result.totalPagesDiscovered) {
    stream.totalPages = result.totalPagesDiscovered;
  }

  let shouldSelfQueue = false;

  if (result.cycleComplete) {
    // ── Coverage verification gate ──
    // Before marking bootstrap complete, verify we captured enough products.
    const siteProfile = profileEntry?.siteProfile ?? null;
    const productCountMethod = siteProfile?.productCountMethod ?? null;
    const expectedProductCount = siteProfile?.expectedProductCount ?? null;

    const passCount = tierState.bootstrapPassCount ?? 0;
    let markComplete = true;

    if (productCountMethod !== null || expectedProductCount !== null) {
      const { verifyBootstrapCoverage, COVERAGE_THRESHOLD } = await import('./product-count-probe');
      const coverage = await verifyBootstrapCoverage(siteId, data.url, productCountMethod, expectedProductCount, { hasWaf: data.hasWaf });

      // Store expectedProductCount for future checks
      if (coverage.expectedCount !== null && !siteProfile?.expectedProductCount) {
        try {
          const updatedProfile = { ...(siteProfile ?? {}), expectedProductCount: coverage.expectedCount };
          await prisma.monitoredSite.update({ where: { id: siteId }, data: { siteProfile: updatedProfile } });
        } catch { /* non-fatal */ }
      }

      if (coverage.ratio !== null && coverage.ratio < COVERAGE_THRESHOLD) {
        if (passCount < 3) {
          markComplete = false;
          tierState.bootstrapPassCount = passCount + 1;
          tierState.currentPage = 1;
          tierState.currentPageUrl = undefined;
          tierState.status = 'idle';
          // Signal self-queue to continue crawling despite cycleComplete
          shouldSelfQueue = true;
          console.log(`[CatalogWorker] ${domain}: coverage ${(coverage.ratio * 100).toFixed(1)}% < 95% (${coverage.dbCount}/${coverage.expectedCount}), retrying pass ${passCount + 1}/3`);
        } else {
          markComplete = true;
          tierState.coverageWarning = true;
          console.warn(`[CatalogWorker] ${domain}: COVERAGE WARNING — ${(coverage.ratio * 100).toFixed(1)}% after ${passCount + 1} passes (${coverage.dbCount}/${coverage.expectedCount}). Marking complete anyway.`);
        }
      } else {
        console.log(`[CatalogWorker] ${domain}: coverage OK — ${coverage.dbCount}/${coverage.expectedCount ?? '?'} (${coverage.ratio !== null ? (coverage.ratio * 100).toFixed(1) + '%' : 'unmeasurable'})`);
      }
    }

    if (markComplete) {
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
  }
  // If not complete, currentPage was updated in-place by crawlStreamTier

  // Persist
  await prisma.monitoredSite.update({
    where: { id: siteId },
    data: { streamState: streamState as any },
  });

  // Record CrawlEvent and update site metrics
  await onCrawlComplete({
    siteId,
    status: result.status === 'success' || result.status === 'partial' ? 'success' : 'fail',
    matchesFound: result.productsFound,
    pagesScanned: result.pagesScanned,
    tokensUsed: result.tokensUsed,
    tier: 4,
    jobType: 'crawl-catalog',
    errorMessage: result.errorMessage,
  });

  pushEvent({ type: 'info', message: `Bootstrap crawl: ${domain} page ${tierState.currentPage}, ${result.productsFound} products, ${result.pagesScanned} pages, ${result.tokensUsed} tokens` });

  // Self-queue next batch
  try {
    const remaining = getCatalogRemaining(siteId, baseBudget, capacity);
    if (remaining > 0 && (!result.cycleComplete || shouldSelfQueue)) {
      const { scrapeQueue: sq } = await import('./queue');
      const site = await prisma.monitoredSite.findUnique({
        where: { id: siteId },
        select: { streamState: true, crawlTuning: true, crawlPhase: true },
      });
      if (site && site.crawlPhase === 'bootstrap') {
        await sq.add('crawl-catalog', {
          siteId, domain, url: data.url,
          baseBudget: data.baseBudget, capacity: data.capacity,
          tierState: data.tierState, activeTiers: data.activeTiers,
          hasWaf: data.hasWaf, crawlTuning: site.crawlTuning,
          streamState: parseStreamState(site.streamState) ?? undefined,
        }, {
          jobId: `catalog-${siteId}-${Date.now()}`,
          priority: 10, // Lower priority than maintain-phase verify/watermark jobs
          attempts: 1, removeOnComplete: 50, removeOnFail: 100,
        });
      }
    }
  } catch (err) {
    console.error(`[CatalogWorker] Bootstrap self-queue failed for ${domain}:`, err instanceof Error ? err.message : err);
  }

  return;
}

// ─── Maintain Phase: Product Verification Job ────────────────────────────────

interface VerifyJobData {
  siteId: string;
  domain: string;
  tier: 2 | 3 | 4;
  productIds: string[];
  hasWaf?: boolean;
}

interface WooVerifyResult {
  verified: number;
  updated: number;
  deleted: number;
  errors: number;
  handled: number;
  handledProductIds: string[];
}

/**
 * WooCommerce Store API fast-path for product verification.
 * Batches products by sourceId and verifies via the public Store API instead of
 * launching Playwright per-product. Returns null if the site is not WooCommerce
 * or none of the products have sourceIds.
 */
async function tryStoreApiVerify(
  products: Array<{ id: string; sourceId: string | null; url: string; staleSince: Date | null; verifyErrors: number; title: string }>,
  domain: string,
  siteId: string,
  hasWaf?: boolean,
): Promise<WooVerifyResult | null> {
  const { _getSiteCacheEntry } = await import('./scraper/adapter-registry');
  const siteInfo = _getSiteCacheEntry(domain);
  if (!siteInfo) return null;

  const profile = siteInfo.siteProfile;

  // Read verify method from site profile — NOT from adapter type
  // Profile should have: crawlers.maintain.verifyMethod = "store-api"
  //                  and: crawlers.maintain.verifyEndpoint = "/wp-json/wc/store/v1/products"
  const maintainConfig = profile?.crawlers?.maintain;
  if (!maintainConfig || maintainConfig.verifyMethod !== 'store-api') return null;

  const verifyEndpoint = maintainConfig.verifyEndpoint;
  if (!verifyEndpoint) return null;

  // Filter products with sourceIds (Store API queries by product ID)
  const withSourceId = products.filter(p => p.sourceId != null);
  if (withSourceId.length === 0) return null;

  const axios = (await import('axios')).default;
  const { ensureCookies, reportFailure } = await import('./scraper/waf-cookie-manager');
  const { PLAYWRIGHT_UA } = await import('./scraper/playwright-fetcher');

  // Derive origin from first product URL
  const origin = new URL(products[0].url).origin;

  let verified = 0, updated = 0, deleted = 0, errors = 0;
  const handledProductIds: string[] = [];

  // Batch sourceIds into chunks — read from profile
  const CHUNK_SIZE = profile?.storeApiChunkSize ?? profile?.enrichmentChunkSize ?? 10;
  const chunks: typeof withSourceId[] = [];
  for (let i = 0; i < withSourceId.length; i += CHUNK_SIZE) {
    chunks.push(withSourceId.slice(i, i + CHUNK_SIZE));
  }

  // Get WAF cookies if needed
  let cookies: string | undefined;
  let userAgent = PLAYWRIGHT_UA;
  if (hasWaf) {
    try {
      const creds = await ensureCookies(domain, origin);
      cookies = creds.cookies;
      userAgent = creds.userAgent;
    } catch (err) {
      console.warn(`[VerifyWorker] ${domain}: WAF cookie solve failed, falling back to Playwright`, err instanceof Error ? err.message : err);
      return null; // Fall back to Playwright
    }
  }

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const ids = chunk.map(p => p.sourceId).join(',');
    const apiUrl = `${origin}${verifyEndpoint}`;

    let response: any;

    // Fetch with 403 retry logic
    const maxRetries = profile?.maxApiRetries ?? 2;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const headers: Record<string, string> = { 'User-Agent': userAgent };
        if (cookies) headers['Cookie'] = cookies;

        const apiTimeout = profile?.apiTimeout ?? profile?.timeout ?? 15000;
        response = await axios.get(apiUrl, {
          params: { include: ids, per_page: CHUNK_SIZE },
          headers,
          timeout: apiTimeout,
          validateStatus: () => true,
        });

        if (response.status === 403 && hasWaf && attempt === 0) {
          // WAF cookies expired — refresh and retry
          console.log(`[VerifyWorker] ${domain}: Store API 403, refreshing WAF cookies...`);
          await reportFailure(domain);
          try {
            const creds = await ensureCookies(domain, origin);
            cookies = creds.cookies;
            userAgent = creds.userAgent;
            continue; // Retry this chunk
          } catch {
            console.warn(`[VerifyWorker] ${domain}: WAF cookie refresh failed, falling back to Playwright for remaining`);
            return {
              verified, updated, deleted, errors,
              handled: handledProductIds.length,
              handledProductIds,
            };
          }
        }

        break; // Success or non-403 error
      } catch (err) {
        console.error(`[VerifyWorker] ${domain}: Store API request failed:`, err instanceof Error ? err.message : err);
        // Network error — fall back to Playwright for remaining
        return {
          verified, updated, deleted, errors,
          handled: handledProductIds.length,
          handledProductIds,
        };
      }
    }

    if (!response || response.status !== 200) {
      console.warn(`[VerifyWorker] ${domain}: Store API returned ${response?.status}, falling back to Playwright for remaining`);
      return {
        verified, updated, deleted, errors,
        handled: handledProductIds.length,
        handledProductIds,
      };
    }

    // Build lookup map from API response: sourceId -> API product
    const apiProducts: any[] = response.data;
    const apiMap = new Map<string, any>();
    for (const ap of apiProducts) {
      apiMap.set(String(ap.id), ap);
    }

    // Process each product in this chunk — collect updates, then batch via $transaction
    const now = new Date();
    const batchOps: ReturnType<typeof prisma.productIndex.update>[] = [];

    for (const product of chunk) {
      const apiProduct = apiMap.get(product.sourceId!);

      if (apiProduct) {
        // Found in Store API — extract data and update
        const price = apiProduct.prices?.price ? Number(apiProduct.prices.price) / 100 : null;
        const regularPrice = apiProduct.prices?.regular_price ? Number(apiProduct.prices.regular_price) / 100 : null;
        const stockStatus = apiProduct.is_in_stock ? 'in_stock' : 'out_of_stock';
        const thumbnail = apiProduct.images?.[0]?.src || null;

        const updateData: Record<string, any> = {
          lastSeenAt: now,
          staleSince: null,
          staleVerifiedAt: now,
          verifyErrors: 0,
          isActive: true,
          stockStatus,
        };
        if (price != null) updateData.price = price;
        if (regularPrice != null) updateData.regularPrice = regularPrice;
        if (thumbnail) updateData.thumbnail = thumbnail;

        batchOps.push(prisma.productIndex.update({
          where: { id: product.id },
          data: updateData,
        }));
        updated++;
      } else {
        // Not found in Store API — may be deleted, but the API has per_page
        // Store API "not found" does NOT mean product is deleted.
        // The API has pagination limits, caching, and visibility filters
        // that can cause real products to be missing from responses.
        // Do NOT increment verifyErrors or deactivate — just skip.
        // The Playwright detail-page path is the only reliable way to
        // confirm a product is truly deleted (HTTP 404 on the actual URL).
        // Leave this product for the next verify cycle or Playwright fallback.
      }

      verified++;
      handledProductIds.push(product.id);
    }

    // Execute all updates for this chunk in a single transaction
    if (batchOps.length > 0) {
      await prisma.$transaction(batchOps);
    }

    // Delay between chunks for WAF sites
    if (hasWaf && ci < chunks.length - 1) {
      await new Promise(r => setTimeout(r, 800));
    }
  }

  // Also mark products without sourceIds as handled if ALL were handled via API
  // (they weren't — they need Playwright fallback)
  return {
    verified,
    updated,
    deleted,
    errors,
    handled: handledProductIds.length,
    handledProductIds,
  };
}

/**
 * Shared Playwright per-product verification loop.
 * Used by both WooCommerce fallback and standard Playwright paths.
 */
async function verifyProductsViaPlaywright(
  products: Array<{ id: string; url: string; title: string; staleSince: Date | null; verifyErrors: number | null; [key: string]: any }>,
  domain: string,
  siteId: string,
  tier: number,
  hasWaf: boolean | undefined,
  deps: {
    verifyProduct: (params: { url: string; domain: string; hasWaf?: boolean }) => Promise<any>;
    randomDelay: (min: number, max: number) => Promise<void>;
    consumeToken: (siteId: string, tier: 1 | 2 | 3 | 4) => void;
  },
): Promise<{ alive: number; sold: number; deleted: number; wanted: number; errors: number }> {
  let alive = 0, sold = 0, deleted = 0, wanted = 0, errors = 0;

  for (const product of products) {
    try {
      deps.consumeToken(siteId, tier as 1 | 2 | 3 | 4);
      const result = await deps.verifyProduct({ url: product.url, domain, hasWaf });
      const now = new Date();

      if (result.status === 'deleted') {
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
            lastSeenAt: now,
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
        wanted++;
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
        alive++;
      } else {
        const newErrors = (product.verifyErrors || 0) + 1;
        const tuning = resolveTuning(null);
        if (newErrors >= tuning.maxVerifyErrors) {
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

      await deps.randomDelay(300, 800);
    } catch (err) {
      console.error(`[VerifyWorker] ${domain}: error verifying ${product.url}:`, err instanceof Error ? err.message : err);
      errors++;
    }
  }

  return { alive, sold, deleted, wanted, errors };
}

async function processVerifyCrawl(job: Job<VerifyJobData>): Promise<void> {
  const { siteId, domain, tier, productIds, hasWaf } = job.data;
  const { verifyProduct } = await import('./product-verifier');
  const { randomDelay } = await import('./scraper/http-client');
  const { consumeToken } = await import('./token-budget');

  console.log(`[VerifyWorker] T${tier} verifying ${productIds.length} products for ${domain}`);

  const products = await prisma.productIndex.findMany({
    where: { id: { in: productIds } },
  });

  let verified = 0, updated = 0, sold = 0, deleted = 0, errors = 0;

  // ─── WooCommerce Store API Fast-Path ───────────────────────────────────────
  // If the site profile specifies store-api verify method, use batch API verification
  // instead of launching Playwright per-product.
  const storeApiFastPath = await tryStoreApiVerify(products, domain, siteId, hasWaf);
  if (storeApiFastPath) {
    verified = storeApiFastPath.verified;
    updated = storeApiFastPath.updated;
    deleted = storeApiFastPath.deleted;
    errors = storeApiFastPath.errors;

    // If fast-path handled everything, record event and self-queue
    if (storeApiFastPath.handled === products.length) {
      console.log(
        `[VerifyWorker] ${domain} T${tier} (WooAPI): verified=${verified} updated=${updated} deleted=${deleted} errors=${errors}`
      );
      await onCrawlComplete({
        siteId,
        status: errors === products.length ? 'fail' : 'success',
        matchesFound: verified,
        pagesScanned: products.length,
        tokensUsed: products.length,
        tier,
        jobType: 'crawl-verify',
        errorMessage: errors > 0 ? `${errors} verification errors` : undefined,
      });
      await selfQueueNextBatch(siteId, domain, tier, hasWaf);
      return;
    }

    // Partial fast-path: some products lacked sourceIds or API failed.
    // Fall through to Playwright for remaining products.
    const handledIds = new Set(storeApiFastPath.handledProductIds);
    const remaining = products.filter(p => !handledIds.has(p.id));
    if (remaining.length === 0) {
      console.log(
        `[VerifyWorker] ${domain} T${tier} (WooAPI): verified=${verified} updated=${updated} deleted=${deleted} errors=${errors}`
      );
      await onCrawlComplete({
        siteId,
        status: errors === products.length ? 'fail' : 'success',
        matchesFound: verified,
        pagesScanned: products.length,
        tokensUsed: products.length,
        tier,
        jobType: 'crawl-verify',
        errorMessage: errors > 0 ? `${errors} verification errors` : undefined,
      });
      await selfQueueNextBatch(siteId, domain, tier, hasWaf);
      return;
    }

    // Continue with Playwright for remaining products
    console.log(`[VerifyWorker] ${domain} T${tier}: WooAPI handled ${storeApiFastPath.handled}, falling back to Playwright for ${remaining.length}`);
    const pwResult = await verifyProductsViaPlaywright(remaining, domain, siteId, tier, hasWaf, { verifyProduct, randomDelay, consumeToken });
    deleted += pwResult.deleted;
    sold += pwResult.sold;
    updated += pwResult.alive + pwResult.wanted;
    errors += pwResult.errors;
    verified += pwResult.alive + pwResult.sold + pwResult.deleted + pwResult.wanted;
  } else {
    // ─── Verify method must be declared in site profile ──────────────────────────
    const { _getSiteCacheEntry: getEntry } = await import('./scraper/adapter-registry');
    const entry = getEntry(domain.replace(/^www\./, ''));
    const verifyMethod = entry?.siteProfile?.crawlers?.maintain?.verifyMethod;
    if (!verifyMethod) {
      console.error(`[VerifyWorker] ${domain}: MISSING verifyMethod in site profile (crawlers.maintain.verifyMethod). Skipping verification.`);
      return;
    }
    // verifyMethod === 'detail-page' — visit each product URL via Playwright
    const pwResult = await verifyProductsViaPlaywright(products, domain, siteId, tier, hasWaf, { verifyProduct, randomDelay, consumeToken });
    deleted += pwResult.deleted;
    sold += pwResult.sold;
    updated += pwResult.alive + pwResult.wanted;
    errors += pwResult.errors;
    verified += pwResult.alive + pwResult.sold + pwResult.deleted + pwResult.wanted;
  }

  console.log(
    `[VerifyWorker] ${domain} T${tier}: verified=${verified} updated=${updated} sold=${sold} deleted=${deleted} errors=${errors}`
  );

  // Record CrawlEvent and update site metrics
  await onCrawlComplete({
    siteId,
    status: errors === products.length ? 'fail' : 'success',
    matchesFound: verified,
    pagesScanned: products.length,
    tokensUsed: products.length,
    tier,
    jobType: 'crawl-verify',
    errorMessage: errors > 0 ? `${errors} verification errors` : undefined,
  });

  // Self-queue: immediately check for more work instead of waiting for scheduler tick
  await selfQueueNextBatch(siteId, domain, tier, hasWaf);
}

// Cooldown tracking extracted to maintain-cooldown.ts (shared with scheduler)
import { isMaintainTierInCooldown, setMaintainTierCooldown } from './maintain-cooldown';

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
      select: { baseBudget: true, capacity: true, crawlTuning: true, crawlPhase: true, hasWaf: true, crawlIntervalMin: true },
    });
    if (!site || site.crawlPhase !== 'maintain') return;

    const { allocateMaintainTokens } = await import('./token-budget');
    const tuning = resolveTuning(site.crawlTuning);
    const allocation = allocateMaintainTokens(siteId, site.baseBudget, site.capacity, tuning, site.crawlIntervalMin || 20);

    const tierTokens = tier === 2 ? allocation.tier2 : tier === 3 ? allocation.tier3 : allocation.tier4;
    if (tierTokens <= 0) return; // No budget left

    // Partition by product age (firstSeenAt), not last verification date.
    // Matches queueMaintainVerification logic in crawl-scheduler.ts.
    const tierConfig = {
      2: { minDays: tuning.maintainT2MinDays, maxDays: tuning.maintainT2MaxDays },
      3: { minDays: tuning.maintainT3MinDays, maxDays: tuning.maintainT3MaxDays },
      4: { minDays: tuning.maintainT4MinDays, maxDays: tuning.maintainT4MaxDays ?? 365 },
    }[tier];

    const now = new Date();
    const ageMaxDate = new Date(now.getTime() - tierConfig.minDays * 86400000);
    const ageMinDate = new Date(now.getTime() - tierConfig.maxDays * 86400000);

    // Only select products that NEED verification in this cycle:
    // - Never verified (staleVerifiedAt is null), OR
    // - Verified before the current cycle (older than the tier's cooldown period)
    // This ensures each product is verified once per cycle, then the tier enters cooldown.
    const cooldownHrs = { 2: tuning.maintainT2CooldownHrs, 3: tuning.maintainT3CooldownHrs, 4: tuning.maintainT4CooldownHrs }[tier]!;
    const cycleThreshold = new Date(now.getTime() - cooldownHrs * 3600000);

    const products = await prisma.productIndex.findMany({
      where: {
        siteId,
        isActive: true,
        firstSeenAt: { gte: ageMinDate, lte: ageMaxDate },
        // Only products not yet verified in this cycle
        OR: [
          { staleVerifiedAt: null },
          { staleVerifiedAt: { lt: cycleThreshold } },
        ],
      },
      orderBy: { staleVerifiedAt: 'asc' },
      take: tierTokens,
      select: { id: true },
    });

    if (products.length === 0) {
      // Tier completed its cycle — all products verified recently. Enter cooldown.
      setMaintainTierCooldown(siteId, tier, cooldownHrs);
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
      priority: 3, // Below T1 watermarks, above bootstrap catalog
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
      select: { id: true, domain: true, streamState: true, crawlPhase: true },
    });

    const { checkStaleProducts } = await import('./stale-detector');

    let totalSold = 0;
    let totalInactive = 0;
    let totalFP = 0;

    for (const site of sites) {
      const ss = parseStreamState(site.streamState);
      if (!ss || ss.streams.length === 0) continue;

      try {
        const result = await checkStaleProducts(site.id, ss.streams[0].id, ss, site.crawlPhase);
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
