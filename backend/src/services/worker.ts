import { Worker, Job } from 'bullmq';
import { redisConnection, cancelSearch } from './queue';
import { scrapeWithAdapter, type ScrapeResult } from './scraper/index';
import { sendAlertEmail } from './email';
import { sendAlertSms } from './sms';
import { loginToSite, validateSession } from './auth-manager';
import { decryptPassword } from '../lib/crypto';
import { pushEvent } from './debugLog';
import { prisma } from '../lib/prisma';
import { config } from '../config';
import { runHealthChecks, pruneOldHealthChecks } from './health-monitor';

interface ScrapeJobData {
  searchId: string;
}

async function processJob(job: Job<ScrapeJobData>): Promise<void> {
  const { searchId } = job.data;

  // 1. Fetch the search record (with optional credential)
  const search = await prisma.search.findUnique({
    where: { id: searchId },
    include: { user: true, credential: true },
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
    pushEvent({ type: 'info', searchId, keyword: search.keyword, websiteUrl: search.websiteUrl, message: 'Search expired — deactivated' });
    await prisma.search.update({ where: { id: searchId }, data: { isActive: false } });
    await cancelSearch(searchId);
    return;
  }

  // 3. Resolve credentials if linked
  let cookies: string | undefined;
  if (search.credential) {
    const cred = search.credential;
    // Try cached session cookies first
    if (cred.sessionCookies) {
      const valid = await validateSession(cred.domain, cred.sessionCookies);
      if (valid) {
        cookies = cred.sessionCookies;
        console.log(`[Worker] Reusing cached session for ${cred.domain}`);
      }
    }
    // Login if no valid cached cookies
    if (!cookies) {
      try {
        const password = decryptPassword(cred.encryptedPassword);
        cookies = await loginToSite(cred.domain, cred.username, password);
        // Cache the session cookies
        await prisma.siteCredential.update({
          where: { id: cred.id },
          data: { sessionCookies: cookies, lastLogin: new Date() },
        });
        console.log(`[Worker] Logged in to ${cred.domain} for search ${searchId}`);
        pushEvent({ type: 'info', searchId, keyword: search.keyword, websiteUrl: search.websiteUrl, message: `Logged in to ${cred.domain}` });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown';
        console.error(`[Worker] Login failed for ${cred.domain}: ${msg}`);
        pushEvent({ type: 'info', searchId, keyword: search.keyword, websiteUrl: search.websiteUrl, message: `Login failed for ${cred.domain}: ${msg}` });
        // Continue without auth — may get partial results or login page
      }
    }
  }

  // 4. Scrape
  console.log(`[Worker] Scraping "${search.keyword}" at ${search.websiteUrl}`);
  pushEvent({ type: 'scrape_start', searchId, keyword: search.keyword, websiteUrl: search.websiteUrl, message: `Scraping "${search.keyword}"` });

  let result: ScrapeResult;
  try {
    result = await scrapeWithAdapter(search.websiteUrl, search.keyword, {
      inStockOnly: search.inStockOnly,
      maxPrice: search.maxPrice ?? undefined,
      cookies,
      fast: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[Worker] Scrape failed for search ${searchId}: ${msg}`);
    pushEvent({ type: 'scrape_fail', searchId, keyword: search.keyword, websiteUrl: search.websiteUrl, message: `Scrape failed: ${msg}` });
    throw err; // Let BullMQ retry with exponential backoff
  }

  pushEvent({ type: 'scrape_done', searchId, keyword: search.keyword, websiteUrl: search.websiteUrl, message: `Scrape done — ${result.matches.length} raw match(es), hash: ${result.contentHash.slice(0, 8)}` });

  // 4. Update lastChecked regardless of match result
  await prisma.search.update({
    where: { id: searchId },
    data: { lastChecked: result.scrapedAt },
  });

  // 5. Delta detection — compare scraped URLs against existing matches in DB
  const existingMatches = await prisma.match.findMany({
    where: { searchId },
    select: { url: true },
  });
  const existingUrls = new Set(existingMatches.map((m) => m.url));

  const newMatches = result.matches.filter((m) => !existingUrls.has(m.url));
  const updatedMatches = result.matches.filter((m) => existingUrls.has(m.url));

  // Update existing matches (title/price/thumbnail may have changed)
  for (const m of updatedMatches) {
    await prisma.match.updateMany({
      where: { searchId, url: m.url },
      data: {
        title: m.title,
        price: m.price ?? null,
        hash: result.contentHash,
        thumbnail: m.thumbnail ?? undefined,
        seller: m.seller ?? undefined,
      },
    });
  }

  // Insert genuinely new matches
  if (newMatches.length > 0) {
    await prisma.match.createMany({
      data: newMatches.map((m) => ({
        searchId,
        title: m.title,
        price: m.price ?? null,
        url: m.url,
        hash: result.contentHash,
        thumbnail: m.thumbnail ?? null,
        postDate: m.postDate ? new Date(m.postDate) : null,
        seller: m.seller ?? null,
      })),
      skipDuplicates: true,
    });
  }

  // Update content hash
  await prisma.search.update({
    where: { id: searchId },
    data: { lastMatchHash: result.contentHash },
  });

  // 6. Only notify if there are genuinely NEW matches
  if (newMatches.length === 0) {
    console.log(`[Worker] No new matches for search ${searchId} (${updatedMatches.length} existing updated)`);
    pushEvent({ type: 'info', searchId, keyword: search.keyword, websiteUrl: search.websiteUrl, message: `No new items (${updatedMatches.length} existing updated)` });
    return;
  }

  console.log(`[Worker] ${newMatches.length} genuinely new match(es) for search ${searchId}`);
  pushEvent({
    type: 'matches_found',
    searchId,
    keyword: search.keyword,
    websiteUrl: search.websiteUrl,
    message: `${newMatches.length} new match(es) (${updatedMatches.length} existing updated)`,
    data: newMatches.map((m) => ({ title: m.title, price: m.price, url: m.url })),
  });

  // 7. Determine notification recipients
  const recipientEmail = search.user?.email ?? search.notifyEmail;
  const recipientPhone = search.user?.phone;

  const notifyByEmail =
    (search.notificationType === 'EMAIL' || search.notificationType === 'BOTH') &&
    !!recipientEmail;
  const notifyBySms =
    (search.notificationType === 'SMS' || search.notificationType === 'BOTH') &&
    !!recipientPhone;

  // Fetch the inserted match IDs for linking to notifications
  const insertedMatches = await prisma.match.findMany({
    where: { searchId, url: { in: newMatches.map((m) => m.url) } },
    select: { id: true },
  });

  // Helper: create notification, link matches, return notification ID
  async function createNotification(type: 'EMAIL' | 'SMS', status: string) {
    const notification = await prisma.notification.create({
      data: { searchId, type, status },
    });
    if (insertedMatches.length > 0) {
      await prisma.notificationMatch.createMany({
        data: insertedMatches.map((m) => ({
          notificationId: notification.id,
          matchId: m.id,
        })),
      });
    }
    return notification;
  }

  // 8. Send email notification
  if (notifyByEmail && recipientEmail) {
    const notification = await createNotification('EMAIL', 'pending');
    try {
      await sendAlertEmail({
        to: recipientEmail,
        keyword: search.keyword,
        matches: newMatches,
        notificationId: notification.id,
        backendUrl: config.backendUrl,
      });
      await prisma.notification.update({ where: { id: notification.id }, data: { status: 'sent' } });
      console.log(`[Worker] Email sent to ${recipientEmail} for search ${searchId}`);
      pushEvent({ type: 'email_sent', searchId, keyword: search.keyword, websiteUrl: search.websiteUrl, message: `Email sent to ${recipientEmail}`, data: { notificationId: notification.id } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown';
      console.error(`[Worker] Email failed for search ${searchId}: ${msg}`);
      await prisma.notification.update({ where: { id: notification.id }, data: { status: 'failed' } });
      pushEvent({ type: 'email_failed', searchId, keyword: search.keyword, websiteUrl: search.websiteUrl, message: `Email to ${recipientEmail} failed: ${msg}`, data: { notificationId: notification.id } });
    }
  }

  // 9. Send SMS notification (Pro feature)
  if (notifyBySms && recipientPhone) {
    const notification = await createNotification('SMS', 'pending');
    try {
      await sendAlertSms(
        recipientPhone,
        search.keyword,
        newMatches.length,
        notification.id,
        config.backendUrl
      );
      await prisma.notification.update({ where: { id: notification.id }, data: { status: 'sent' } });
      console.log(`[Worker] SMS sent to ${recipientPhone} for search ${searchId}`);
      pushEvent({ type: 'sms_sent', searchId, keyword: search.keyword, websiteUrl: search.websiteUrl, message: `SMS sent to ${recipientPhone}`, data: { notificationId: notification.id } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown';
      console.error(`[Worker] SMS failed for search ${searchId}: ${msg}`);
      await prisma.notification.update({ where: { id: notification.id }, data: { status: 'failed' } });
      pushEvent({ type: 'sms_failed', searchId, keyword: search.keyword, websiteUrl: search.websiteUrl, message: `SMS to ${recipientPhone} failed: ${msg}`, data: { notificationId: notification.id } });
    }
  }
}

export function startWorker(): Worker<ScrapeJobData> {
  const worker = new Worker<ScrapeJobData>('scrape', processJob, {
    connection: redisConnection,
    concurrency: 20,
  });

  worker.on('completed', (job) => {
    console.log(`[Worker] Job ${job.id} completed`);
    pushEvent({ type: 'job_completed', message: `Job ${job.id} completed` });
  });

  worker.on('failed', (job, err) => {
    console.error(`[Worker] Job ${job?.id} failed: ${err.message}`);
    pushEvent({ type: 'job_failed', message: `Job ${job?.id} failed: ${err.message}` });
  });

  worker.on('error', (err) => {
    console.error(`[Worker] Worker error: ${err.message}`);
  });

  console.log('[Worker] BullMQ worker started');
  return worker;
}

// ─── Health Check Worker ──────────────────────────────────────────────────────

export function startHealthWorker(): Worker {
  const worker = new Worker('health', async (_job: Job) => {
    console.log(`[HealthWorker] Running daily health checks...`);
    pushEvent({ type: 'info', message: 'Daily health check started' });

    const result = await runHealthChecks();

    // Prune old records while we're at it
    const pruned = await pruneOldHealthChecks();
    if (pruned > 0) {
      console.log(`[HealthWorker] Pruned ${pruned} old health check records`);
    }

    pushEvent({
      type: 'info',
      message: `Health check complete: ${result.reachable}/${result.total} reachable, ${result.canScrape}/${result.total} scrapable, ${result.failed.length} failed`,
    });
  }, {
    connection: redisConnection,
    concurrency: 1,
  });

  worker.on('completed', (job) => {
    console.log(`[HealthWorker] Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[HealthWorker] Job ${job?.id} failed: ${err.message}`);
    pushEvent({ type: 'job_failed', message: `Health check failed: ${err.message}` });
  });

  worker.on('error', (err) => {
    console.error(`[HealthWorker] Worker error: ${err.message}`);
  });

  console.log('[HealthWorker] Health check worker started');
  return worker;
}
