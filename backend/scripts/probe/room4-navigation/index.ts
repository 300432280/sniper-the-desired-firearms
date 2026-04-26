// backend/scripts/probe/room4-navigation/index.ts
// Room 4 composer: pagination + sort + watermark method → NavigationState.
// Per spec §4.4: never hard-fail on pagination (single-page catalogs are valid).

import { detectPagination } from './pagination-detect';
import { detectSort } from './sort-detect';
import { selectWatermarkMethod } from './watermark-method';
import type { GeographyCountState, NavigationState, RoomFailure } from '../shared/types';

export async function runRoom4(prev: GeographyCountState): Promise<NavigationState | RoomFailure> {
  process.stderr.write(`\n[Room 4] Navigation detection for ${prev.canonicalOrigin}\n`);

  // Step 1: pagination
  const pag = await detectPagination(prev);
  process.stderr.write(`  [Room 4] pagination: type=${pag.pattern.type}, perPage=${pag.pattern.perPage}, testA=${pag.evidence.testA_page1_vs_page2.passed}\n`);

  // Step 2: sort
  const sort = await detectSort(prev);
  process.stderr.write(`  [Room 4] sort: param=${sort.sortParam ?? 'null'}\n`);

  // Step 3: watermark method
  const watermark = await selectWatermarkMethod(prev, sort);
  process.stderr.write(`  [Room 4] watermark: method=${watermark.method}, reason=${watermark.reason.slice(0, 120)}\n`);

  // Step 4: assemble NavigationState (per spec §4.4 type)
  return {
    ...prev,
    paginationPattern: pag.pattern,
    paginationEvidence: pag.evidence,
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
