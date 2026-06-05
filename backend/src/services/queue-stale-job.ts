// backend/src/services/queue-stale-job.ts
//
// Pure decision logic for removeStaleJob (FIX 1b). Extracted so it can be
// unit-tested without opening a real Redis/BullMQ connection (importing
// queue.ts connects to Redis at module load). queue.ts wraps this with the
// actual job.remove() side effect.

/** BullMQ lock duration for the crawl worker (worker.ts lockDuration: 300000). */
export const LOCK_DURATION_MS = 300_000;

export type StaleJobAction =
  | 'remove'        // safe to remove now
  | 'remove-active' // active but lock expired (orphan) — try remove, tolerate re-lock
  | 'skip';         // a live worker genuinely owns it — never remove

/**
 * Decide what to do with a job given its BullMQ state and timing.
 *
 *  - active + lock FRESH (age <= LOCK_DURATION_MS) → skip (live crawl)
 *  - active + lock EXPIRED                         → remove-active (dead worker orphan)
 *  - waiting / delayed                            → remove (not running)
 *  - failed / completed / anything else           → remove
 */
export function decideStaleJobAction(
  state: string,
  processedOn: number | null | undefined,
  now: number = Date.now(),
): StaleJobAction {
  if (state === 'active') {
    const age = processedOn != null ? now - processedOn : Infinity;
    // NEVER remove a fresh active job — that would kill a live crawl.
    return age > LOCK_DURATION_MS ? 'remove-active' : 'skip';
  }
  // waiting, delayed, failed, completed, unknown → safe to remove.
  return 'remove';
}
