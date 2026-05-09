/**
 * @deprecated 2026-04-27 — Generic discovery superseded by AI-driven per-site audit.
 * See `_DEPRECATED.md` in this folder and `docs/superpowers/plans/2026-04-27-pivot-to-ai-audit.md`.
 * Do not import from this file in new code.
 */
// backend/scripts/probe/navigation/index.ts
// Navigation stage composer: sort + watermark method → NavigationState.
// Pagination detection has moved to the Geography & Count stage — state.paginationPattern already populated.
// Per spec §4.4: never hard-fail on pagination (single-page catalogs are valid).

import { detectSort } from './sort-detect';
import { selectWatermarkMethod } from './watermark-method';
import type { GeographyCountState, NavigationState, StageFailure } from '../shared/types';

export async function runNavigation(prev: GeographyCountState): Promise<NavigationState | StageFailure> {
  process.stderr.write(`\n[Navigation] detection for ${prev.canonicalOrigin}\n`);

  // Pagination already detected in the Geography & Count stage — read from state
  process.stderr.write(`  [Navigation] pagination (from Geography&Count): type=${prev.paginationPattern.type}, perPage=${prev.paginationPattern.perPage}\n`);

  // Step 1: sort
  const sort = await detectSort(prev);
  process.stderr.write(`  [Navigation] sort: param=${sort.sortParam ?? 'null'}\n`);

  // Step 2: watermark method
  const watermark = await selectWatermarkMethod(prev, sort);
  process.stderr.write(`  [Navigation] watermark: method=${watermark.method}, reason=${watermark.reason.slice(0, 120)}\n`);

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
