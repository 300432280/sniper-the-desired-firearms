// backend/src/services/__test__/queue-stale-job.test.ts
//
// FIX 1b — removeStaleJob lock-expiry decision. An orphaned `active` job (worker
// died on SIGKILL without releasing the lock) must be removable once its lock
// has expired, but a FRESH active job (a live worker genuinely running it) must
// NEVER be removed. Other states (waiting/delayed/failed/completed/unknown) are
// always safe to remove.
import { describe, it, expect } from 'vitest';
import { decideStaleJobAction, LOCK_DURATION_MS } from '../queue-stale-job';

const NOW = 1_000_000_000_000;

describe('decideStaleJobAction (FIX 1b)', () => {
  it('skips a FRESH active job (live worker holds the lock)', () => {
    const processedOn = NOW - 1000; // 1s ago, well within lock duration
    expect(decideStaleJobAction('active', processedOn, NOW)).toBe('skip');
  });

  it('skips an active job exactly at the lock boundary (age == LOCK_DURATION_MS)', () => {
    const processedOn = NOW - LOCK_DURATION_MS; // age == lock duration → still fresh
    expect(decideStaleJobAction('active', processedOn, NOW)).toBe('skip');
  });

  it('removes an active job whose lock has EXPIRED (orphan from a dead worker)', () => {
    const processedOn = NOW - (LOCK_DURATION_MS + 1); // 1ms past expiry
    expect(decideStaleJobAction('active', processedOn, NOW)).toBe('remove-active');
  });

  it('removes an active job with no processedOn (treated as infinitely old)', () => {
    expect(decideStaleJobAction('active', null, NOW)).toBe('remove-active');
    expect(decideStaleJobAction('active', undefined, NOW)).toBe('remove-active');
  });

  it('removes waiting / delayed jobs (not running)', () => {
    expect(decideStaleJobAction('waiting', null, NOW)).toBe('remove');
    expect(decideStaleJobAction('delayed', null, NOW)).toBe('remove');
  });

  it('removes failed / completed / unknown jobs', () => {
    expect(decideStaleJobAction('failed', null, NOW)).toBe('remove');
    expect(decideStaleJobAction('completed', NOW, NOW)).toBe('remove');
    expect(decideStaleJobAction('unknown', null, NOW)).toBe('remove');
  });
});
