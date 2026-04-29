// backend/scripts/probe/room5-bootstrap/index.ts
// Room 5 composer: strategy dispatch → index products → return BootstrapState.
// First room that writes to the DB. Mirrors room4-navigation/index.ts style.

import { prisma } from '../../../src/lib/prisma';
import { strategyDispatch } from './strategy-dispatch';
import { indexProducts } from './index-products';
import type { NavigationState, BootstrapState, RoomFailure } from '../shared/types';

export async function runRoom5(state: NavigationState): Promise<BootstrapState | RoomFailure> {
  const startMs = Date.now();
  process.stderr.write(`\n[Room 5] Bootstrap for ${state.canonicalOrigin}\n`);

  // Step 1: Extract domain from canonicalOrigin
  const parsedUrl = new URL(state.canonicalOrigin);
  const domain = parsedUrl.hostname.replace(/^www\./, '');

  // Step 2: Upsert MonitoredSite row (gives us siteId)
  const siteTypeMap: Record<string, string> = {
    'drupal-commerce': 'classified',
    'classifieds-drupal': 'classified',
    'forum-xenforo': 'forum',
    'forum-vbulletin': 'forum',
  };
  const siteType = siteTypeMap[state.platform] ?? 'retailer';

  const dispatch = strategyDispatch(state);
  process.stderr.write(`  [Room 5] strategy=${dispatch.strategy}, adapter=${dispatch.adapterEntry}, reason=${dispatch.reason.slice(0, 100)}\n`);

  const site = await prisma.monitoredSite.upsert({
    where: { domain },
    create: {
      domain,
      name: domain,
      url: state.canonicalOrigin,
      siteType,
      siteCategory: siteType,
      adapterType: dispatch.adapterEntry,
      isEnabled: false,
      hasWaf: state.hasWaf,
      requiresSucuri: state.wafType === 'sucuri',
      bootstrapStartedAt: new Date(),
      crawlPhase: 'bootstrap',
      siteProfile: {
        platform: state.platform,
        catalogUrls: state.catalogUrls,
        sortParam: state.sortParam,
        paginationPattern: state.paginationPattern,
        watermarkMethod: state.watermarkMethod,
        wafType: state.wafType,
        needsPlaywright: state.needsPlaywright,
        userAgentOverride: state.userAgentOverride,
        globalProductCount: state.globalProductCount,
      },
    },
    update: {
      url: state.canonicalOrigin,
      adapterType: dispatch.adapterEntry,
      hasWaf: state.hasWaf,
      requiresSucuri: state.wafType === 'sucuri',
      bootstrapStartedAt: new Date(),
      crawlPhase: 'bootstrap',
      siteProfile: {
        platform: state.platform,
        catalogUrls: state.catalogUrls,
        sortParam: state.sortParam,
        paginationPattern: state.paginationPattern,
        watermarkMethod: state.watermarkMethod,
        wafType: state.wafType,
        needsPlaywright: state.needsPlaywright,
        userAgentOverride: state.userAgentOverride,
        globalProductCount: state.globalProductCount,
      },
    },
  });

  process.stderr.write(`  [Room 5] MonitoredSite ${site.id} (${site.domain}) — ${site.createdAt.toISOString() === site.updatedAt.toISOString() ? 'created' : 'updated'}\n`);

  // Step 3: Run indexProducts
  const result = await indexProducts(state, site.id, dispatch.strategy, dispatch.adapterEntry);

  // If indexProducts returned a failure, propagate it
  if ('roomFailed' in result) return result;

  // Step 4: Assemble BootstrapState
  const bootstrapState: BootstrapState = {
    ...state,
    productsIndexed: result.productsIndexed,
    indexingStrategyUsed: dispatch.strategy,
    detailEnrichmentStats: result.detailEnrichmentStats,
    newestProduct: result.newestProduct,
    finalDriftPct: result.finalDriftPct,
    durationMs: Date.now() - startMs,
    dbWrites: {
      ...result.dbWrites,
      monitoredSiteCreated: site.createdAt.toISOString() === site.updatedAt.toISOString(),
    },
  };

  process.stderr.write(`  [Room 5] DONE in ${bootstrapState.durationMs}ms — ${result.productsIndexed} products, drift=${result.finalDriftPct.toFixed(1)}%, enabled=${result.dbWrites.isEnabledSet}\n`);
  return bootstrapState;
}
