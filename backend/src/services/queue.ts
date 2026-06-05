import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config';
import { decideStaleJobAction } from './queue-stale-job';

export const redisConnection = new IORedis(config.redisUrl, {
  maxRetriesPerRequest: null, // Required by BullMQ
  enableReadyCheck: true,
  lazyConnect: false,
  retryStrategy: (times: number) => {
    const delay = Math.min(times * 500, 30000); // 500ms, 1s, 1.5s, ... max 30s
    console.log(`[Redis] Reconnecting in ${delay}ms (attempt ${times})`);
    return delay;
  },
  reconnectOnError: (err: Error) => {
    const targetErrors = ['READONLY', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNREFUSED'];
    return targetErrors.some(e => err.message.includes(e));
  },
});

redisConnection.on('error', (err) => {
  console.error('[Redis] Connection error:', err.message);
});
redisConnection.on('close', () => {
  console.warn('[Redis] Connection closed');
});
redisConnection.on('reconnecting', (ms: number) => {
  console.log(`[Redis] Reconnecting in ${ms}ms`);
});
redisConnection.on('ready', () => {
  console.log('[Redis] Connection ready');
});

export const scrapeQueue = new Queue('scrape', {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 200,
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
  },
});

/**
 * Remove a pre-existing scrape job by jobId IF AND ONLY IF it is in a TERMINAL
 * state (failed / completed / unknown). Singleton-jobId enqueues (catalog-<id>,
 * watermark-<id>, verify-<id>-t<n>) use `removeOnComplete: true` + `removeOnFail: 100`.
 * A FAILED job (attempts:1, no retry) keeps its hash in Redis under the same jobId,
 * and BullMQ's `add()` silently de-dupes against it — so every subsequent enqueue is
 * a no-op and the site stalls permanently (Mistake-34 class: re-enqueue path exists
 * but is silently swallowed). Calling this before `add()` clears the dead hash.
 *
 * Removes failed / completed / unknown jobs and orphaned ACTIVE jobs whose lock
 * has EXPIRED (worker died on SIGKILL without releasing it — see decideStaleJobAction).
 * SKIPS a fresh active job (a live worker genuinely owns it — removing would yank a
 * running crawl). An expired-lock active job may be re-grabbed by a live worker the
 * instant we try to remove it; job.remove() then throws ("locked"), which we treat as
 * a benign skip. Any OTHER error (Redis down, unexpected BullMQ failure) is rethrown —
 * swallowing it would hide a real failure as if a worker held the lock.
 */
export async function removeStaleJob(jobId: string): Promise<'removed' | 'skipped' | 'not-found'> {
  const job = await scrapeQueue.getJob(jobId);
  if (!job) return 'not-found';

  const state = await job.getState();
  const action = decideStaleJobAction(state, job.processedOn);

  if (action === 'skip') {
    console.warn(`[Queue] removeStaleJob: ${jobId} is active with a fresh lock — not removing; if its worker died, the reaper recovers it within ~5min`);
    return 'skipped';
  }

  try {
    await job.remove();
    if (action === 'remove-active') {
      console.log(`[Queue] removeStaleJob: removed orphaned active job ${jobId} (lock expired)`);
    }
    return 'removed';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/lock|could not (be )?remove/i.test(msg)) throw err;
    console.warn(`[Queue] removeStaleJob: ${jobId} could not be removed (state=${state}, action=${action}, likely re-locked by a live worker): ${msg}`);
    return 'skipped';
  }
}

/**
 * @deprecated Legacy per-search scheduling. The unified crawl scheduler now handles
 * all site-level crawling via MonitoredSite.nextCrawlAt. This function remains only
 * for cleanup of old per-search BullMQ jobs during the migration period.
 */
export async function scheduleSearch(
  searchId: string,
  intervalMinutes: number
): Promise<void> {
  try {
    const jobId = `search:${searchId}`;

    // Remove existing repeating job before creating new one (handles interval changes)
    try {
      await scrapeQueue.removeRepeatableByKey(jobId);
    } catch {
      // Ignore if key doesn't exist
    }

    // 0 = 10-second test mode (admin only), otherwise convert minutes to ms
    const everyMs = intervalMinutes === 0 ? 10_000 : intervalMinutes * 60 * 1000;

    await scrapeQueue.add(
      'scrape-search',
      { searchId },
      {
        jobId,
        repeat: {
          every: everyMs,
          immediately: true, // Run immediately on creation, then on interval
        },
      }
    );
  } catch (err) {
    console.error(`[Queue] Failed to schedule search ${searchId}:`, err instanceof Error ? err.message : err);
    // Don't throw — allow the app to continue without background jobs
  }
}

export async function cancelSearch(searchId: string): Promise<void> {
  try {
    const jobId = `search:${searchId}`;
    await scrapeQueue.removeRepeatableByKey(jobId);
  } catch {
    // Ignore — Redis may be unavailable
  }
}

/**
 * Remove legacy per-search repeatable jobs from the scrape queue.
 * These are leftover from the old per-search scheduling system.
 * Call once at startup.
 */
export async function cleanupLegacyJobs(): Promise<void> {
  try {
    const repeatableJobs = await scrapeQueue.getRepeatableJobs();
    let removed = 0;
    for (const job of repeatableJobs) {
      // Legacy jobs have IDs like "search:<cuid>"
      if (job.id?.startsWith('search:') || job.name === 'scrape-search') {
        await scrapeQueue.removeRepeatableByKey(job.key);
        removed++;
      }
    }
    if (removed > 0) {
      console.log(`[Queue] Cleaned up ${removed} legacy repeatable job(s)`);
    }
  } catch (err) {
    console.error('[Queue] Failed to cleanup legacy jobs:', err instanceof Error ? err.message : err);
  }
}

// ─── Crawl Scheduler Queue ────────────────────────────────────────────────────

export const schedulerQueue = new Queue('scheduler', {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: 10,
    removeOnFail: 20,
    attempts: 1,
  },
});

/**
 * Start the unified crawl scheduler (ticks every 2 minutes).
 * Call once at startup.
 */
export async function startCrawlScheduler(): Promise<void> {
  try {
    const jobId = 'scheduler-tick';

    // Remove existing repeatable job before re-creating
    try {
      const repeatableJobs = await schedulerQueue.getRepeatableJobs();
      for (const job of repeatableJobs) {
        if (job.id === jobId) {
          await schedulerQueue.removeRepeatableByKey(job.key);
        }
      }
    } catch {
      // Ignore
    }

    await schedulerQueue.add(
      'scheduler-tick',
      {},
      {
        jobId,
        repeat: {
          every: 2 * 60 * 1000, // Every 2 minutes
        },
      }
    );

    console.log('[Queue] Crawl scheduler started (ticking every 2 minutes)');
  } catch (err) {
    console.error('[Queue] Failed to start crawl scheduler:', err instanceof Error ? err.message : err);
  }
}

// ─── Health Check Queue ───────────────────────────────────────────────────────

export const healthQueue = new Queue('health', {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: 10,
    removeOnFail: 20,
    attempts: 1,
  },
});

// ─── Daily Digest Queue ───────────────────────────────────────────────────────

export const digestQueue = new Queue('digest', {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: 10,
    removeOnFail: 20,
    attempts: 1,
  },
});

/**
 * Schedule daily digest cron job (runs at 11:00 PM UTC = 6:00 PM EST).
 * Call once at startup.
 */
export async function scheduleDailyDigest(): Promise<void> {
  try {
    const jobId = 'daily-digest';

    // Remove existing repeatable job before re-creating
    try {
      const repeatableJobs = await digestQueue.getRepeatableJobs();
      for (const job of repeatableJobs) {
        if (job.id === jobId) {
          await digestQueue.removeRepeatableByKey(job.key);
        }
      }
    } catch {
      // Ignore if doesn't exist
    }

    await digestQueue.add(
      'send-daily-digests',
      {},
      {
        jobId,
        repeat: {
          pattern: '0 23 * * *', // Daily at 11:00 PM UTC (6:00 PM EST)
        },
      }
    );

    console.log('[Queue] Daily digest scheduled at 11:00 PM UTC (6:00 PM EST)');
  } catch (err) {
    console.error('[Queue] Failed to schedule daily digest:', err instanceof Error ? err.message : err);
  }
}

// ─── Alert Dispatch Queue ─────────────────────────────────────────────────────

export const alertDispatchQueue = new Queue('alert-dispatch', {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: 10,
    removeOnFail: 20,
    attempts: 1,
  },
});

/**
 * Schedule the cursor-based alert dispatcher (runs every 5 minutes).
 * Call once at startup.
 */
export async function scheduleAlertDispatch(): Promise<void> {
  try {
    const jobId = 'alert-dispatch';

    // Remove existing repeatable job before re-creating
    try {
      const repeatableJobs = await alertDispatchQueue.getRepeatableJobs();
      for (const job of repeatableJobs) {
        if (job.id === jobId) {
          await alertDispatchQueue.removeRepeatableByKey(job.key);
        }
      }
    } catch {
      // Ignore if doesn't exist
    }

    await alertDispatchQueue.add(
      'dispatch-alerts',
      {},
      {
        jobId,
        repeat: {
          every: 5 * 60 * 1000, // Every 5 minutes
        },
      }
    );

    console.log('[Queue] Alert dispatch scheduled every 5 minutes');
  } catch (err) {
    console.error('[Queue] Failed to schedule alert dispatch:', err instanceof Error ? err.message : err);
  }
}

/**
 * Schedule daily health check cron job (runs at 6:00 AM UTC).
 * Call once at startup.
 */
export async function scheduleHealthChecks(): Promise<void> {
  try {
    const jobId = 'daily-health-check';

    // Remove existing repeatable job before re-creating
    try {
      const repeatableJobs = await healthQueue.getRepeatableJobs();
      for (const job of repeatableJobs) {
        if (job.id === jobId) {
          await healthQueue.removeRepeatableByKey(job.key);
        }
      }
    } catch {
      // Ignore if doesn't exist
    }

    await healthQueue.add(
      'run-health-checks',
      {},
      {
        jobId,
        repeat: {
          pattern: '0 6 * * *', // Daily at 6:00 AM UTC
        },
      }
    );

    console.log('[Queue] Daily health check scheduled at 6:00 AM UTC');
  } catch (err) {
    console.error('[Queue] Failed to schedule health checks:', err instanceof Error ? err.message : err);
  }
}

// ─── Stale Product Check Queue ────────────────────────────────────────────────

export const staleCheckQueue = new Queue('stale-check', {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: 20,
    removeOnFail: 20,
    attempts: 1,
  },
});

/**
 * Schedule daily stale product check (runs at 4:00 AM UTC = 11:00 PM EST).
 * Checks all enabled sites for products that disappeared from listing pages
 * (sold, deleted, expired). Uses cross-tier cycle completion to avoid false positives.
 */
export async function scheduleDailyStaleCheck(): Promise<void> {
  try {
    const jobId = 'daily-stale-check';

    try {
      const repeatableJobs = await staleCheckQueue.getRepeatableJobs();
      for (const job of repeatableJobs) {
        if (job.id === jobId) {
          await staleCheckQueue.removeRepeatableByKey(job.key);
        }
      }
    } catch {
      // Ignore if doesn't exist
    }

    await staleCheckQueue.add(
      'check-stale-products',
      {},
      {
        jobId,
        repeat: {
          pattern: '0 4 * * *', // Daily at 4:00 AM UTC (11:00 PM EST)
        },
      }
    );

    console.log('[Queue] Daily stale check scheduled at 4:00 AM UTC (11:00 PM EST)');
  } catch (err) {
    console.error('[Queue] Failed to schedule stale check:', err instanceof Error ? err.message : err);
  }
}
