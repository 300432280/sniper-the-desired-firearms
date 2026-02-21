import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config';

export const redisConnection = new IORedis(config.redisUrl, {
  maxRetriesPerRequest: null, // Required by BullMQ
  enableReadyCheck: false,
  lazyConnect: true,
});

redisConnection.on('error', (err) => {
  console.error('[Redis] Connection error:', err.message);
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

// ─── Health Check Queue ───────────────────────────────────────────────────────

export const healthQueue = new Queue('health', {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: 10,
    removeOnFail: 20,
    attempts: 1,
  },
});

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
