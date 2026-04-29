/**
 * @deprecated 2026-04-27 — Generic discovery superseded by AI-driven per-site audit.
 * See `_DEPRECATED.md` in this folder and `docs/superpowers/plans/2026-04-27-pivot-to-ai-audit.md`.
 * Do not import from this file in new code.
 */
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

  // Step 2: Ensure MonitoredSite row exists (Fix #12 — explicit findUnique + create/update)
  const siteTypeMap: Record<string, string> = {
    'drupal-commerce': 'classified',
    'classifieds-drupal': 'classified',
    'forum-xenforo': 'forum',
    'forum-vbulletin': 'forum',
  };
  const siteType = siteTypeMap[state.platform] ?? 'retailer';

  const dispatch = strategyDispatch(state);
  process.stderr.write(`  [Room 5] strategy=${dispatch.strategy}, adapter=${dispatch.adapterEntry}, reason=${dispatch.reason.slice(0, 100)}\n`);

  const newProfileFields = {
    platform: state.platform,
    catalogUrls: state.catalogUrls,
    sortParam: state.sortParam,
    paginationPattern: state.paginationPattern,
    watermarkMethod: state.watermarkMethod,
    wafType: state.wafType,
    needsPlaywright: state.needsPlaywright,
    userAgentOverride: state.userAgentOverride,
    globalProductCount: state.globalProductCount,
  };

  // Fix #12: explicit findUnique → create OR update (no upsert race, reliable creation detection)
  // Fix #8: do NOT set isEnabled=false in update path — avoids flickering live sites offline
  const existing = await prisma.monitoredSite.findUnique({ where: { domain } });
  let site: typeof existing & {};
  let monitoredSiteCreated: boolean;

  if (!existing) {
    monitoredSiteCreated = true;
    site = await prisma.monitoredSite.create({
      data: {
        domain,
        name: domain,
        url: state.canonicalOrigin,
        siteType,
        siteCategory: siteType,
        adapterType: dispatch.adapterEntry,
        isEnabled: false, // OK on first create
        hasWaf: state.hasWaf,
        requiresSucuri: state.wafType === 'sucuri',
        bootstrapStartedAt: new Date(),
        crawlPhase: 'bootstrap',
        siteProfile: newProfileFields,
      },
    });
  } else {
    monitoredSiteCreated = false;
    // Fix #7: merge siteProfile instead of overwrite
    const existingProfile = (existing.siteProfile as Record<string, any>) ?? {};
    site = await prisma.monitoredSite.update({
      where: { domain },
      data: {
        url: state.canonicalOrigin,
        adapterType: dispatch.adapterEntry,
        // DO NOT touch isEnabled here (Fix #8) — leave it as-is for re-bootstrap
        hasWaf: state.hasWaf,
        requiresSucuri: state.wafType === 'sucuri',
        bootstrapStartedAt: new Date(),
        crawlPhase: 'bootstrap',
        siteProfile: { ...existingProfile, ...newProfileFields },
      },
    });
  }

  process.stderr.write(`  [Room 5] MonitoredSite ${site.id} (${site.domain}) — ${monitoredSiteCreated ? 'created' : 'updated'}\n`);

  // Step 3: Run indexProducts (pass monitoredSiteCreated for accurate dbWrites reporting)
  const result = await indexProducts(state, site.id, dispatch.strategy, dispatch.adapterEntry, monitoredSiteCreated);

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
    dbWrites: result.dbWrites,
  };

  process.stderr.write(`  [Room 5] DONE in ${bootstrapState.durationMs}ms — ${result.productsIndexed} products, drift=${result.finalDriftPct.toFixed(1)}% (band=${result.driftBand}), enabled=${result.dbWrites.isEnabledSet}\n`);
  return bootstrapState;
}
