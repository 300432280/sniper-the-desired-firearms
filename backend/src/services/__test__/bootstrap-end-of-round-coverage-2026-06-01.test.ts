import { describe, it, expect } from 'vitest';
import type { SiteStreamState, StreamTierState } from '../scraper/types';

/**
 * Unit test for the end-of-round site-level coverage gate in worker.ts
 * processStreamCatalogCrawl (2026-06-01, re-walk fix Part E 2026-06-02).
 *
 * The production gate is inline in a non-exported async function with prisma /
 * network deps (verifyBootstrapCoverage), so — as with the sibling
 * bootstrap-streams-pending test — we replicate the PURE decision logic here and
 * assert the contract the gate relies on:
 *
 *   1. The gate only acts when a FULL round just completed (no stream pending).
 *   2. The pass counter is SITE-level (on streams[0]:4), not per-stream.
 *   3. Part E: on a sub-95% round, re-open ONLY streams that were token-truncated
 *      mid-walk (truncated===true). Naturally-completed streams (truncated===false)
 *      are LEFT complete — re-walking them from page 1 re-indexes saved products and
 *      burns the per-site budget for zero gain (the bug this fix removes).
 *   4. Part E: if NO stream is truncated yet coverage <95% → STRUCTURAL gap; set
 *      coverageWarning IMMEDIATELY (no wasted retry rounds), even with passes left.
 *   5. Bounded at 3 retry rounds; after that, coverageWarning and STOP (no infinite
 *      loop). Monotonic: each new round re-opens only truncated streams that advance.
 */

const COVERAGE_THRESHOLD = 0.95;

interface GateResult {
  startNewRound: boolean;
  coverageWarning: boolean;
  newSitePassCount: number;
  clearedCompletions: number; // how many streams had lastCycleCompletedAt cleared
}

/** Pure model of the gate body (assumes cycleComplete && !streamsPending). */
function endOfRoundGate(state: SiteStreamState, coverageRatio: number | null): GateResult {
  const firstKey = `${state.streams[0].id}:4`;
  const siteTier = state.tiers[firstKey];
  const sitePassCount = siteTier?.bootstrapPassCount ?? 0;

  if (coverageRatio !== null && coverageRatio < COVERAGE_THRESHOLD) {
    const truncatedStreamIds = state.streams
      .filter(s => (state.tiers[`${s.id}:4`] as any)?.truncated === true)
      .map(s => s.id);

    if (sitePassCount < 3 && siteTier && truncatedStreamIds.length > 0) {
      siteTier.bootstrapPassCount = sitePassCount + 1;
      let cleared = 0;
      for (const id of truncatedStreamIds) {
        const t = state.tiers[`${id}:4`];
        if (t && t.lastCycleCompletedAt) { t.lastCycleCompletedAt = undefined; cleared++; }
      }
      return { startNewRound: true, coverageWarning: false, newSitePassCount: sitePassCount + 1, clearedCompletions: cleared };
    }
    // Out of rounds OR no truncated stream (structural gap) → warn and stop.
    if (siteTier) siteTier.coverageWarning = true;
    return { startNewRound: false, coverageWarning: true, newSitePassCount: sitePassCount, clearedCompletions: 0 };
  }
  return { startNewRound: false, coverageWarning: false, newSitePassCount: sitePassCount, clearedCompletions: 0 };
}

/**
 * @param truncatedIds streams that ended this round still budget-truncated (truncated=true).
 *   By default every stream reached natural end (truncated=false) — the real end-of-round
 *   state in the current round model.
 */
function mkRoundCompleteState(ids: string[], sitePassCount = 0, truncatedIds: string[] = []): SiteStreamState {
  const tiers: Record<string, StreamTierState> = {};
  ids.forEach((id, i) => {
    tiers[`${id}:4`] = {
      streamId: id, tier: 4, currentPage: 1, pageRangeStart: 1, status: 'idle',
      lastCycleCompletedAt: '2026-06-01T00:00:00.000Z',
      ...(truncatedIds.includes(id) ? { truncated: true } as any : { truncated: false } as any),
      ...(i === 0 ? { bootstrapPassCount: sitePassCount } : {}),
    };
  });
  return { streams: ids.map(id => ({ id } as any)), tiers } as SiteStreamState;
}

describe('bootstrap end-of-round coverage gate', () => {
  it('coverage OK (>=95%) → no new round, no warning, completions kept', () => {
    const state = mkRoundCompleteState(['A', 'B', 'C']);
    const r = endOfRoundGate(state, 0.97);
    expect(r.startNewRound).toBe(false);
    expect(r.coverageWarning).toBe(false);
    // All streams still complete → maintain-readiness will pass.
    expect(state.streams.every(s => !!state.tiers[`${s.id}:4`].lastCycleCompletedAt)).toBe(true);
  });

  it('Part E STRUCTURAL gap: sub-95%, passes left, NO truncated stream → warn IMMEDIATELY, no re-walk', () => {
    const state = mkRoundCompleteState(['A', 'B', 'C'], 0); // all truncated=false
    const r = endOfRoundGate(state, 0.15);
    expect(r.startNewRound).toBe(false);          // do NOT start a fresh full-round re-walk
    expect(r.coverageWarning).toBe(true);         // mark complete-with-warning immediately
    expect(r.clearedCompletions).toBe(0);         // NO completions cleared → no re-walk
    // All streams stay complete → site is readiness-eligible at its reachable max.
    expect(state.streams.every(s => !!state.tiers[`${s.id}:4`].lastCycleCompletedAt)).toBe(true);
  });

  it('Part E re-open: sub-95% with a truncated stream → re-open ONLY that stream, keep the rest complete', () => {
    const state = mkRoundCompleteState(['A', 'B', 'C'], 0, ['B']); // B was truncated
    const r = endOfRoundGate(state, 0.50);
    expect(r.startNewRound).toBe(true);
    expect(r.newSitePassCount).toBe(1);
    expect(r.clearedCompletions).toBe(1);                                   // only B re-opened
    expect(state.tiers['B:4'].lastCycleCompletedAt).toBeUndefined();        // B pending again
    expect(state.tiers['A:4'].lastCycleCompletedAt).toBeDefined();          // A NOT re-walked
    expect(state.tiers['C:4'].lastCycleCompletedAt).toBeDefined();          // C NOT re-walked
  });

  it('pass counter is SITE-level (on streams[0]), independent of small-stream finishing first', () => {
    const state = mkRoundCompleteState(['A', 'B', 'C'], 2, ['A']); // A truncated, passes left
    const r = endOfRoundGate(state, 0.50);
    // sitePassCount was 2 (<3) → one more round allowed, becomes 3.
    expect(r.startNewRound).toBe(true);
    expect(state.tiers['A:4'].bootstrapPassCount).toBe(3);
    // B/C never carry the counter.
    expect(state.tiers['B:4'].bootstrapPassCount).toBeUndefined();
  });

  it('BOUND: after 3 retry rounds still sub-95% (even with a truncated stream) → coverageWarning, STOP', () => {
    const state = mkRoundCompleteState(['A', 'B', 'C'], 3, ['B']);
    const r = endOfRoundGate(state, 0.40);
    expect(r.startNewRound).toBe(false);
    expect(r.coverageWarning).toBe(true);
    expect(state.tiers['A:4'].coverageWarning).toBe(true);
    // Completions are NOT cleared → all streams stay complete → bootstrap done.
    expect(state.streams.every(s => !!state.tiers[`${s.id}:4`].lastCycleCompletedAt)).toBe(true);
  });

  it('unmeasurable coverage (ratio null) → no new round, no warning (treated as pass)', () => {
    const state = mkRoundCompleteState(['A', 'B']);
    const r = endOfRoundGate(state, null);
    expect(r.startNewRound).toBe(false);
    expect(r.coverageWarning).toBe(false);
  });
});
