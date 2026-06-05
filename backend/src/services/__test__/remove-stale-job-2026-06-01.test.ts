// backend/src/services/__test__/remove-stale-job-2026-06-01.test.ts
//
// Integration test for the queue.ts removeStaleJob() WRAPPER (the pure decision
// logic is tested separately in queue-stale-job.test.ts). Singleton-jobId
// enqueues (catalog-<id>, watermark-<id>, verify-<id>-t<n>) use
// removeOnComplete:true + removeOnFail:100. A FAILED job keeps its hash in Redis
// under the same jobId, so BullMQ's add() silently de-dupes and the site stalls
// forever. removeStaleJob() clears it.
//
// Updated 2026-06-01 (FIX 1b): removeStaleJob now ALSO removes an orphaned ACTIVE
// job whose lock has EXPIRED (worker died on SIGKILL), but NEVER a fresh active
// job (live worker owns it). It returns a status ('removed' | 'skipped' |
// 'not-found') and RETHROWS unexpected (non-lock) errors instead of swallowing
// them — a swallowed Redis failure would hide a real fault as if a worker held
// the lock.
//
// queue.ts builds a real IORedis connection + BullMQ Queues at import time, so
// we mock both ioredis and bullmq to keep this test hermetic.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LOCK_DURATION_MS } from '../queue-stale-job';

// vi.hoisted so the fn exists when the hoisted vi.mock factory below runs.
const { getJob } = vi.hoisted(() => ({ getJob: vi.fn() }));

vi.mock('ioredis', () => {
  class FakeRedis {
    on() { return this; }
  }
  return { default: FakeRedis };
});

vi.mock('bullmq', () => {
  class FakeQueue {
    getJob = getJob;
    add = vi.fn();
    on() { return this; }
  }
  return { Queue: FakeQueue };
});

// Import AFTER mocks are registered.
import { removeStaleJob } from '../queue';

function fakeJob(state: string, opts: { processedOn?: number | null; removeError?: Error } = {}) {
  return {
    processedOn: opts.processedOn ?? null,
    getState: vi.fn().mockResolvedValue(state),
    remove: opts.removeError
      ? vi.fn().mockRejectedValue(opts.removeError)
      : vi.fn().mockResolvedValue(undefined),
  };
}

describe('removeStaleJob', () => {
  beforeEach(() => {
    getJob.mockReset();
  });

  it.each(['failed', 'completed', 'unknown', 'waiting', 'delayed'])(
    'removes a non-running job in state "%s" and returns "removed"',
    async (state) => {
      const job = fakeJob(state);
      getJob.mockResolvedValue(job);
      await expect(removeStaleJob('catalog-x')).resolves.toBe('removed');
      expect(job.remove).toHaveBeenCalledTimes(1);
    }
  );

  it('SKIPS a fresh active job (live worker holds the lock) and does NOT remove it', async () => {
    const job = fakeJob('active', { processedOn: Date.now() - 1000 }); // 1s ago = fresh
    getJob.mockResolvedValue(job);
    await expect(removeStaleJob('catalog-x')).resolves.toBe('skipped');
    expect(job.remove).not.toHaveBeenCalled();
  });

  it('REMOVES an orphaned active job whose lock has expired', async () => {
    const job = fakeJob('active', { processedOn: Date.now() - (LOCK_DURATION_MS + 60_000) });
    getJob.mockResolvedValue(job);
    await expect(removeStaleJob('catalog-x')).resolves.toBe('removed');
    expect(job.remove).toHaveBeenCalledTimes(1);
  });

  it('returns "not-found" when no job exists', async () => {
    getJob.mockResolvedValue(undefined);
    await expect(removeStaleJob('catalog-missing')).resolves.toBe('not-found');
  });

  it('treats a re-lock throw on an expired active job as a benign skip', async () => {
    const job = fakeJob('active', {
      processedOn: Date.now() - (LOCK_DURATION_MS + 60_000),
      removeError: new Error('Job catalog-x could not be removed because it is locked by another worker'),
    });
    getJob.mockResolvedValue(job);
    await expect(removeStaleJob('catalog-x')).resolves.toBe('skipped');
    expect(job.remove).toHaveBeenCalledTimes(1);
  });

  it('RETHROWS an unexpected (non-lock) error from getJob — must not be silently swallowed', async () => {
    getJob.mockRejectedValue(new Error('redis down'));
    await expect(removeStaleJob('catalog-x')).rejects.toThrow('redis down');
  });

  it('RETHROWS an unexpected (non-lock) error from remove() — must not be silently swallowed', async () => {
    const job = fakeJob('failed', { removeError: new Error('redis blip on remove') });
    getJob.mockResolvedValue(job);
    await expect(removeStaleJob('catalog-x')).rejects.toThrow('redis blip on remove');
    expect(job.remove).toHaveBeenCalledTimes(1);
  });
});
