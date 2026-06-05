import { describe, it, expect } from 'vitest';
import { hasPendingStreams } from '../stream-detector';
import type { SiteStreamState } from '../scraper/types';

/**
 * Tests for the EXPORTED `hasPendingStreams` helper (2026-06-02). This is now the
 * single source of truth shared by:
 *   - crawl-scheduler.ts bootstrap dispatch gate (replaces the stale legacy
 *     `getActiveTiers(tierState)` gate that could block dispatch while streams pend), and
 *   - worker.ts processStreamCatalogCrawl self-queue chain (`streamsPending`).
 * The predicate: ANY stream whose T4 tier lacks `lastCycleCompletedAt` (or has no T4
 * entry) means there is pending bootstrap work → dispatch / keep draining.
 */
function mkState(
  streamIds: string[],
  completed: Record<string, boolean>,
): SiteStreamState {
  const tiers: SiteStreamState['tiers'] = {};
  for (const id of streamIds) {
    if (completed[id] !== undefined) {
      tiers[`${id}:4`] = {
        streamId: id,
        tier: 4,
        currentPage: 1,
        pageRangeStart: 1,
        status: 'idle',
        ...(completed[id] ? { lastCycleCompletedAt: '2026-06-02T00:00:00.000Z' } : {}),
      };
    }
  }
  return { streams: streamIds.map(id => ({ id } as any)), tiers } as SiteStreamState;
}

describe('hasPendingStreams (exported)', () => {
  it('null state → false (scheduler falls back to legacy gate)', () => {
    expect(hasPendingStreams(null)).toBe(false);
  });

  it('empty streams array → false', () => {
    expect(hasPendingStreams({ streams: [], tiers: {} } as SiteStreamState)).toBe(false);
  });

  it('fresh multi-stream site, no tier state → true (dispatch)', () => {
    expect(hasPendingStreams(mkState(['A', 'B'], {}))).toBe(true);
  });

  it('one stream complete, others never dispatched → true (dispatch)', () => {
    expect(hasPendingStreams(mkState(['A', 'B', 'C'], { A: true }))).toBe(true);
  });

  it('one stream dispatched but not completed → true (dispatch)', () => {
    expect(hasPendingStreams(mkState(['A', 'B'], { A: true, B: false }))).toBe(true);
  });

  it('every T4 stream completed this round → false (round done, do not re-dispatch)', () => {
    expect(hasPendingStreams(mkState(['A', 'B', 'C'], { A: true, B: true, C: true }))).toBe(false);
  });

  it('single-stream site just completed → false (no re-dispatch / no loop)', () => {
    expect(hasPendingStreams(mkState(['A'], { A: true }))).toBe(false);
  });

  it('end-of-round gate re-opened a truncated stream (cleared lastCycleCompletedAt) → true', () => {
    // Worker's sub-95% coverage path sets lastCycleCompletedAt=undefined on truncated
    // streams; the scheduler must then re-dispatch the site to resume them.
    const state = mkState(['A', 'B'], { A: true, B: true });
    delete (state.tiers['B:4'] as any).lastCycleCompletedAt;
    expect(hasPendingStreams(state)).toBe(true);
  });
});
