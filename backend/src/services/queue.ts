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
  const jobId = `search:${searchId}`;

  // Remove existing repeating job before creating new one (handles interval changes)
  try {
    await scrapeQueue.removeRepeatableByKey(jobId);
  } catch {
    // Ignore if key doesn't exist
  }

  await scrapeQueue.add(
    'scrape-search',
    { searchId },
    {
      jobId,
      repeat: {
        every: intervalMinutes * 60 * 1000,
        immediately: true, // Run immediately on creation, then on interval
      },
    }
  );
}

export async function cancelSearch(searchId: string): Promise<void> {
  const jobId = `search:${searchId}`;
  try {
    await scrapeQueue.removeRepeatableByKey(jobId);
  } catch {
    // Ignore if key doesn't exist
  }
}
