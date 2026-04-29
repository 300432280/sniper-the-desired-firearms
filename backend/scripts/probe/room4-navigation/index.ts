/**
 * @deprecated 2026-04-27 — Generic discovery superseded by AI-driven per-site audit.
 * See `_DEPRECATED.md` in this folder and `docs/superpowers/plans/2026-04-27-pivot-to-ai-audit.md`.
 * Do not import from this file in new code.
 */
// backend/scripts/probe/room4-navigation/index.ts
// Room 4 composer: sort + watermark method → NavigationState.
// Pagination detection has moved to Room 3 — state.paginationPattern already populated.
// Per spec §4.4: never hard-fail on pagination (single-page catalogs are valid).

import { detectSort } from './sort-detect';
import { selectWatermarkMethod } from './watermark-method';
import type { GeographyCountState, NavigationState, RoomFailure } from '../shared/types';

export async function runRoom4(prev: GeographyCountState): Promise<NavigationState | RoomFailure> {
  process.stderr.write(`\n[Room 4] Navigation detection for ${prev.canonicalOrigin}\n`);

  // Pagination already detected in Room 3 — read from state
  process.stderr.write(`  [Room 4] pagination (from Room 3): type=${prev.paginationPattern.type}, perPage=${prev.paginationPattern.perPage}\n`);

  // Step 1: sort
  const sort = await detectSort(prev);
  process.stderr.write(`  [Room 4] sort: param=${sort.sortParam ?? 'null'}\n`);

  // Step 2: watermark method
  const watermark = await selectWatermarkMethod(prev, sort);
  process.stderr.write(`  [Room 4] watermark: method=${watermark.method}, reason=${watermark.reason.slice(0, 120)}\n`);

  // Step 3: assemble NavigationState
  return {
    ...prev,
    sortParam: sort.sortParam,
    sortEvidence: {
      ...sort.evidence,
      dateVerification: watermark.dateVerification,
    },
    watermarkMethod: watermark.method,
    watermarkMethodSelection: {
      reason: watermark.reason,
      dateSourceForMethodA: watermark.dateSourceForMethodA,
      urlSortVerifiedForMethodB: watermark.urlSortVerifiedForMethodB,
      fallbackToMethodCReason: watermark.fallbackToMethodCReason,
    },
  };
}
