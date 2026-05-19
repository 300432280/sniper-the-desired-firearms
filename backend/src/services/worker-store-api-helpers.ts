// backend/src/services/worker-store-api-helpers.ts
//
// Pure helpers extracted from worker.ts:tryStoreApiVerify().
// Kept here so unit tests don't have to load the full worker (which pulls
// BullMQ / Prisma / axios / dynamic imports at module-init time).

interface ChunkProduct {
  id: string;
  sourceId: string | null;
}

/**
 * Partition a chunk of products into:
 *   - matched:   products whose sourceId is present in `apiMap` (the Store API
 *                response actually returned them, so we can update from API data).
 *   - unmatched: products NOT returned by the API (missing sourceId, dropped by
 *                pagination, OOS-visibility-filtered, etc.). These MUST fall
 *                through to Playwright detail-page verification — they cannot
 *                be safely marked as handled by the Store API path.
 *
 * This split is the load-bearing fix for the "silent loss-of-signal under
 * store-api" bug: previously every product was pushed to `handledProductIds`
 * unconditionally, causing the caller's `handled === products.length` early
 * return to fire and skip Playwright fallback. The result was that OOS
 * transitions were never recorded — restock detection silently broke.
 */
export function splitChunkByApiMatch<T extends ChunkProduct>(
  chunk: T[],
  apiMap: Map<string, any>,
): { matched: T[]; unmatched: T[] } {
  const matched: T[] = [];
  const unmatched: T[] = [];
  for (const product of chunk) {
    if (product.sourceId != null && apiMap.has(product.sourceId)) {
      matched.push(product);
    } else {
      unmatched.push(product);
    }
  }
  return { matched, unmatched };
}
