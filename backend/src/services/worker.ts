import { Worker, Job } from 'bullmq';
import { redisConnection, cancelSearch } from './queue';
import { scrapeForKeyword } from './scraper';
import { sendAlertEmail } from './email';
import { sendAlertSms } from './sms';
import { prisma } from '../lib/prisma';
import { config } from '../config';

interface ScrapeJobData {
  searchId: string;
}

async function processJob(job: Job<ScrapeJobData>): Promise<void> {
  const { searchId } = job.data;

  // 1. Fetch the search record
  const search = await prisma.search.findUnique({
    where: { id: searchId },
    include: { user: true },
  });

  if (!search) {
    console.log(`[Worker] Search ${searchId} not found — removing job`);
    await cancelSearch(searchId);
    return;
  }

  if (!search.isActive) {
    console.log(`[Worker] Search ${searchId} is paused — skipping`);
    return;
  }

  // 2. Check expiry (guest searches expire after 24h)
  if (search.expiresAt && search.expiresAt < new Date()) {
    console.log(`[Worker] Search ${searchId} expired — deactivating`);
    await prisma.search.update({ where: { id: searchId }, data: { isActive: false } });
    await cancelSearch(searchId);
    return;
  }

  // 3. Scrape
  console.log(`[Worker] Scraping "${search.keyword}" at ${search.websiteUrl}`);

  let result;
  try {
    result = await scrapeForKeyword(search.websiteUrl, search.keyword, {
      inStockOnly: search.inStockOnly,
      maxPrice: search.maxPrice ?? undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[Worker] Scrape failed for search ${searchId}: ${msg}`);
    throw err; // Let BullMQ retry with exponential backoff
  }

  // 4. Update lastChecked regardless of match result
  await prisma.search.update({
    where: { id: searchId },
    data: { lastChecked: result.scrapedAt },
  });

  // 5. Deduplicate — only proceed if content hash has changed
  if (result.contentHash === search.lastMatchHash) {
    console.log(`[Worker] No new content for search ${searchId}`);
    return;
  }

  // Update hash even if no matches (page may have changed, no matches found)
  await prisma.search.update({
    where: { id: searchId },
    data: { lastMatchHash: result.contentHash },
  });

  if (result.matches.length === 0) {
    console.log(`[Worker] Page changed but no keyword matches for search ${searchId}`);
    return;
  }

  console.log(`[Worker] ${result.matches.length} new match(es) for search ${searchId}`);

  // 6. Save matches to DB
  await prisma.match.createMany({
    data: result.matches.map((m) => ({
      searchId,
      title: m.title,
      price: m.price ?? null,
      url: m.url,
      hash: result.contentHash,
    })),
    skipDuplicates: true,
  });

  // 7. Determine notification recipients
  const recipientEmail = search.user?.email ?? search.notifyEmail;
  const recipientPhone = search.user?.phone;
  const dashboardUrl = `${config.frontendUrl}/dashboard`;

  const notifyByEmail =
    (search.notificationType === 'EMAIL' || search.notificationType === 'BOTH') &&
    !!recipientEmail;
  const notifyBySms =
    (search.notificationType === 'SMS' || search.notificationType === 'BOTH') &&
    !!recipientPhone;

  // 8. Send email notification
  if (notifyByEmail && recipientEmail) {
    try {
      await sendAlertEmail({
        to: recipientEmail,
        keyword: search.keyword,
        matches: result.matches,
        dashboardUrl,
      });
      await prisma.notification.create({
        data: { searchId, type: 'EMAIL', status: 'sent' },
      });
      console.log(`[Worker] Email sent to ${recipientEmail} for search ${searchId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown';
      console.error(`[Worker] Email failed for search ${searchId}: ${msg}`);
      await prisma.notification.create({
        data: { searchId, type: 'EMAIL', status: 'failed' },
      });
    }
  }

  // 9. Send SMS notification (Pro feature)
  if (notifyBySms && recipientPhone) {
    try {
      await sendAlertSms(
        recipientPhone,
        search.keyword,
        result.matches.length,
        result.matches[0].url
      );
      await prisma.notification.create({
        data: { searchId, type: 'SMS', status: 'sent' },
      });
      console.log(`[Worker] SMS sent to ${recipientPhone} for search ${searchId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown';
      console.error(`[Worker] SMS failed for search ${searchId}: ${msg}`);
      await prisma.notification.create({
        data: { searchId, type: 'SMS', status: 'failed' },
      });
    }
  }
}

export function startWorker(): Worker<ScrapeJobData> {
  const worker = new Worker<ScrapeJobData>('scrape', processJob, {
    connection: redisConnection,
    concurrency: 3,
  });

  worker.on('completed', (job) => {
    console.log(`[Worker] Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[Worker] Job ${job?.id} failed: ${err.message}`);
  });

  worker.on('error', (err) => {
    console.error(`[Worker] Worker error: ${err.message}`);
  });

  console.log('[Worker] BullMQ worker started');
  return worker;
}
