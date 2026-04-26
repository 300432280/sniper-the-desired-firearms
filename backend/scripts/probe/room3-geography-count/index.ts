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
  // NOTE: spec §4.3 says drift > 5% is hard fail. That gate assumes the walk
  // can actually paginate every catalogUrl, which requires Room 4's
  // paginationPattern detection (Phase 5 Task 5.1). Until Room 4 lands,
  // walk-verify uses generic ?page=N which only catches platforms that honor
  // it (Shopify, Ecwid, default WC); /page/N/ (Celerant, custom WC) and
  // pageN.html (LightSpeed eCom) silently return page-1 forever. High drift
  // on those platforms is EXPECTED at this phase. Per spec §4.3 "Relationship
  // between Room 3 count and Room 5 indexed count": Room 5 (which uses the
  // discovered paginationPattern) becomes the authoritative drift gate. The
  // driftPct is still emitted in the state so Room 5 / the report layer / a
  // future hard-fail-restore can compute thresholds from it. AGGREGATE 0
  // products (line 17 above) remains a hard fail — that's a catastrophic
  // catalogUrl-discovery failure, not a pagination unknown.
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
