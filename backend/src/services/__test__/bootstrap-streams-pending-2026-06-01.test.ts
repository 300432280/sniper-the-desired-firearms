import { describe, it, expect } from 'vitest';
import type { SiteStreamState } from '../scraper/types';

/**
 * Unit test for the multi-stream bootstrap self-queue predicate added to
 * worker.ts processStreamCatalogCrawl (2026-06-01).
 *
 * The production predicate is a 4-line inline expression inside a non-exported
 * async function that depends on prisma/queue/token-budget. Extracting the whole
 * function for testing would be a large, non-surgical refactor. The predicate
 * itself is pure (a function of streamState only), so we assert its exact logic
 * here. This is the contract the self-queue condition relies on:
 *   if (remaining > 0 && (!result.cycleComplete || shouldSelfQueue || streamsPending))
 */
function streamsPending(streamState: SiteStreamState): boolean {
  return streamState.streams.some(s => {
    const t = streamState.tiers[`${s.id}:4`];
    return !t || !t.lastCycleCompletedAt;
  });
}

/**
 * Models the full self-queue decision from worker.ts (assumes remaining > 0):
 *   shouldContinue || coverageRetry || (streamsPending && madeProgress)
 * where shouldContinue = !cycleComplete && madeProgress.
 * Both the keep-paginating arm AND the next-stream arm are gated on madeProgress,
 * so a 0-page job (broken/empty stream) never self-queues.
 */
function shouldSelfQueue(opts: {
  state: SiteStreamState;
  cycleComplete: boolean;
  coverageRetry: boolean; // worker.ts `shouldSelfQueue` flag (coverage-retry branch)
  pagesScanned: number;
}): boolean {
  const madeProgress = opts.pagesScanned > 0;
  const shouldContinue = !opts.cycleComplete && madeProgress;
  return (
    shouldContinue ||
    opts.coverageRetry ||
    (streamsPending(opts.state) && madeProgress)
  );
}

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
        ...(completed[id] ? { lastCycleCompletedAt: '2026-06-01T00:00:00.000Z' } : {}),
      };
    }
  }
  return {
    streams: streamIds.map(id => ({ id } as any)),
    tiers,
  } as SiteStreamState;
}

describe('bootstrap streamsPending predicate', () => {
  it('FORWARD PROGRESS: stream A complete but B,C idle (never dispatched) → pending=true', () => {
    // A finished its sweep; B and C have no tier state yet.
    const state = mkState(['A', 'B', 'C'], { A: true });
    expect(streamsPending(state)).toBe(true);
  });

  it('FORWARD PROGRESS: A complete, B dispatched-but-not-completed → pending=true', () => {
    const state = mkState(['A', 'B', 'C'], { A: true, B: false });
    expect(streamsPending(state)).toBe(true);
  });

  it('TERMINATION: every stream T4 has lastCycleCompletedAt → pending=false', () => {
    const state = mkState(['A', 'B', 'C'], { A: true, B: true, C: true });
    expect(streamsPending(state)).toBe(false);
  });

  it('single-stream site that just completed → pending=false (no infinite loop)', () => {
    const state = mkState(['A'], { A: true });
    expect(streamsPending(state)).toBe(false);
  });

  it('fresh multi-stream site, no tier state at all → pending=true', () => {
    const state = mkState(['A', 'B'], {});
    expect(streamsPending(state)).toBe(true);
  });
});

describe('bootstrap self-queue decision (madeProgress gate)', () => {
  it('healthy stream completes WITH pages → streamsPending self-queues to next stream', () => {
    // A done, B,C pending; A completed this cycle scanning pages.
    const state = mkState(['A', 'B', 'C'], { A: true });
    expect(
      shouldSelfQueue({ state, cycleComplete: true, coverageRetry: false, pagesScanned: 12 }),
    ).toBe(true);
  });

  it('healthy stream MID-crawl: pages scanned, not done → shouldContinue self-queues + advances cursor', () => {
    const state = mkState(['A', 'B', 'C'], { A: true });
    expect(
      shouldSelfQueue({ state, cycleComplete: false, coverageRetry: false, pagesScanned: 7 }),
    ).toBe(true);
  });

  it('TERMINATION: BROKEN stream scans 0 pages, never completes → NO self-queue (runaway closed)', () => {
    // C broken: cycleComplete=false, 0 pages, streamsPending=true (C never completed).
    // Both arms are now gated on madeProgress, so the chain STOPS immediately and falls
    // back to the bounded scheduler tick. (Round-1 incorrectly expected true here.)
    const state = mkState(['A', 'B', 'C'], { A: true, B: true });
    expect(streamsPending(state)).toBe(true); // C still pending
    expect(
      shouldSelfQueue({ state, cycleComplete: false, coverageRetry: false, pagesScanned: 0 }),
    ).toBe(false);
  });

  it('stream fetched 1 page, 0 products, then broke → madeProgress=true → re-queues (cursor moved forward, not infinite)', () => {
    const state = mkState(['A', 'B', 'C'], { A: true });
    expect(
      shouldSelfQueue({ state, cycleComplete: false, coverageRetry: false, pagesScanned: 1 }),
    ).toBe(true);
  });

  it('TERMINATION: picker rotates to a completed stream → cycleComplete + 0 pages → STOP', () => {
    // After C (broken) advances its lastDispatchedAt, the picker rotates to an
    // already-completed stream which returns cycleComplete=true, 0 pages. C still has
    // no lastCycleCompletedAt so streamsPending=true, but madeProgress=false gates it.
    const state = mkState(['A', 'B', 'C'], { A: true, B: true /* C never completes */ });
    expect(streamsPending(state)).toBe(true); // C still pending
    expect(
      shouldSelfQueue({ state, cycleComplete: true, coverageRetry: false, pagesScanned: 0 }),
    ).toBe(false); // but no self-queue → falls back to scheduler tick
  });

  it('coverage-retry branch self-queues regardless of progress', () => {
    const state = mkState(['A'], { A: true });
    expect(
      shouldSelfQueue({ state, cycleComplete: true, coverageRetry: true, pagesScanned: 0 }),
    ).toBe(true);
  });

  it('all streams complete WITH progress → no self-queue (clean termination)', () => {
    const state = mkState(['A', 'B', 'C'], { A: true, B: true, C: true });
    expect(
      shouldSelfQueue({ state, cycleComplete: true, coverageRetry: false, pagesScanned: 20 }),
    ).toBe(false);
  });
});
