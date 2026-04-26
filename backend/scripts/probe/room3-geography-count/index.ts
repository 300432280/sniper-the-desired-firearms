// backend/scripts/probe/room3-geography-count/index.ts
import { discoverCatalogUrls } from './catalog-urls';
import { getGlobalCount } from './global-count';
import { walkAndDedupe } from './walk-verify';
import type { AccessIdentityState, GeographyCountState, RoomFailure } from '../shared/types';

export async function runRoom3(prev: AccessIdentityState): Promise<GeographyCountState | RoomFailure> {
  // Step 1: catalogUrls
  const cu = await discoverCatalogUrls(prev);
  if (cu.catalogUrls.length === 0) {
    return fail('no catalogUrls discovered', { source: cu.source });
  }
  // Step 2: global count (independent)
  const gc = await getGlobalCount(prev);
  // Step 3: walk
  const walk = await walkAndDedupe(prev, cu.catalogUrls);
  if (walk.uniqueProductUrls.size === 0) {
    return fail('walk returned 0 products from all catalogUrls', { walkCounts: walk.walkCounts });
  }
  // Step 4: reconcile
  const walkedCount = walk.uniqueProductUrls.size;
  const globalCount = gc?.count ?? walkedCount;
  const method = gc?.method ?? 'catalog-walk-only';
  const driftPct = gc ? Math.abs(globalCount - walkedCount) / globalCount * 100 : 0;
  if (driftPct > 5) {
    return fail(`drift ${driftPct.toFixed(1)}% > 5%`, { globalCount, walkedCount, method, walkCounts: walk.walkCounts });
  }
  // Pass / soft-warn
  return {
    ...prev,
    catalogUrls: cu.catalogUrls,
    catalogUrlSource: cu.source,
    catalogUrlWalkCounts: walk.walkCounts,
    walkedUniqueCount: walkedCount,
    globalProductCount: globalCount,
    globalProductCountMethod: method,
    globalProductCountEvidence: gc?.evidence ?? {},
    driftPct,
    coverageStrategy: gc && /api|wp-rest|store-api|shopify|ecwid|klevu/.test(method) ? 'api-walk'
                    : (gc ? 'hybrid' : 'html-walk'),
  };

  function fail(reason: string, evidence: Record<string, unknown>): RoomFailure {
    return { roomFailed: true, roomNumber: 3, reason, evidence, timestamp: new Date().toISOString() };
  }
}
