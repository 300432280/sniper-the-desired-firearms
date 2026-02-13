import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, optionalAuth } from '../middleware/auth';
import { scheduleSearch, cancelSearch } from '../services/queue';
import { scrapeForKeyword } from '../services/scraper';
import { sendAlertEmail } from '../services/email';
import { sendAlertSms } from '../services/sms';
import { guestSearchLimiter } from '../middleware/rateLimit';
import { pushEvent } from '../services/debugLog';
import { config } from '../config';

const router = Router();

// 0 = 10-second test mode (admin only), 5/30/60 = minutes
const CHECK_INTERVALS = [0, 5, 30, 60] as const;
type CheckInterval = (typeof CHECK_INTERVALS)[number];

function normalizeUrl(raw: string): string {
  const url = raw.trim();
  if (!url) return url;
  if (/^https?:\/\//i.test(url)) return url;
  // Use http:// for localhost (no SSL), https:// for everything else
  if (/^localhost(:\d+)?/i.test(url) || /^127\.0\.0\.1/i.test(url)) return `http://${url}`;
  return `https://${url}`;
}

const urlField = z.string().transform(normalizeUrl).pipe(
  z.string().url('Invalid URL — enter a domain like gunpost.ca or a full URL')
);

const guestSearchSchema = z.object({
  keyword: z.string().min(2, 'Keyword must be at least 2 characters').max(100),
  websiteUrl: urlField,
  notifyEmail: z.string().email('Invalid notification email'),
});

// Accept either an array of URLs or a single string, and auto-split comma-separated values
const websiteUrlsField = z
  .union([z.array(z.string()), z.string()])
  .transform((val) => {
    const raw = Array.isArray(val) ? val : [val];
    // Split any comma/newline-separated entries into individual URLs
    return raw.flatMap((u) => u.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean));
  })
  .pipe(z.array(urlField).min(1, 'At least one URL is required').max(10, 'Maximum 10 URLs'));

const authSearchSchema = z.object({
  keyword: z.string().min(2).max(100),
  websiteUrls: websiteUrlsField,
  checkInterval: z
    .number()
    .refine((v): v is CheckInterval => CHECK_INTERVALS.includes(v as CheckInterval), {
      message: 'Check interval must be 0 (test), 5, 30, or 60 minutes',
    })
    .default(30),
  notificationType: z.enum(['EMAIL', 'SMS', 'BOTH']).default('EMAIL'),
  inStockOnly: z.boolean().default(false),
  maxPrice: z.number().positive().optional(),
});

// GET /api/searches
router.get('/', requireAuth, async (req: Request, res: Response) => {
  const searches = await prisma.search.findMany({
    where: { userId: req.user!.userId },
    include: {
      _count: { select: { matches: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  return res.json({ searches });
});

// POST /api/searches
router.post('/', optionalAuth, async (req: Request, res: Response) => {
  if (!req.user) {
    // Guest flow — apply extra rate limiting
    return guestSearchLimiter(req, res, async () => {
      const parse = guestSearchSchema.safeParse(req.body);
      if (!parse.success) {
        return res.status(400).json({ error: parse.error.flatten().fieldErrors });
      }
      const { keyword, websiteUrl, notifyEmail } = parse.data;
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

      const search = await prisma.search.create({
        data: {
          keyword,
          websiteUrl,
          notifyEmail,
          checkInterval: 30,
          notificationType: 'EMAIL',
          expiresAt,
        },
      });

      // Inline scrape for immediate results
      pushEvent({ type: 'search_created', searchId: search.id, keyword, websiteUrl, message: `Guest alert created` });
      pushEvent({ type: 'scrape_start', searchId: search.id, keyword, websiteUrl, message: `Inline scrape starting` });
      let initialMatches: any[] = [];
      try {
        const result = await scrapeForKeyword(websiteUrl, keyword);
        pushEvent({ type: 'scrape_done', searchId: search.id, keyword, websiteUrl, message: `Inline scrape done — ${result.matches.length} match(es)` });
        await prisma.search.update({
          where: { id: search.id },
          data: { lastChecked: result.scrapedAt, lastMatchHash: result.contentHash },
        });
        if (result.matches.length > 0) {
          pushEvent({ type: 'matches_found', searchId: search.id, keyword, websiteUrl, message: `${result.matches.length} match(es) saved`, data: result.matches.map((m) => ({ title: m.title, price: m.price, url: m.url })) });
          await prisma.match.createMany({
            data: result.matches.map((m) => ({
              searchId: search.id,
              title: m.title,
              price: m.price ?? null,
              url: m.url,
              hash: result.contentHash,
            })),
            skipDuplicates: true,
          });
          initialMatches = await prisma.match.findMany({
            where: { searchId: search.id },
            orderBy: { foundAt: 'desc' },
          });
        }
      } catch (err) {
        console.error(`[Route] Inline scrape failed for search ${search.id}:`, err);
        pushEvent({ type: 'scrape_fail', searchId: search.id, keyword, websiteUrl, message: `Inline scrape failed: ${err instanceof Error ? err.message : 'Unknown'}` });
      }

      await scheduleSearch(search.id, 30);
      return res.status(201).json({ search, matches: initialMatches });
    });
  }

  // Authenticated flow
  const parse = authSearchSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: parse.error.flatten().fieldErrors });
  }

  const { websiteUrls, keyword, ...settings } = parse.data;
  const searches: any[] = [];
  const allMatches: any[] = [];

  for (const websiteUrl of websiteUrls) {
    const search = await prisma.search.create({
      data: {
        keyword,
        websiteUrl,
        ...settings,
        userId: req.user.userId,
      },
    });

    pushEvent({ type: 'search_created', searchId: search.id, keyword, websiteUrl, message: `Auth alert created` });
    pushEvent({ type: 'scrape_start', searchId: search.id, keyword, websiteUrl, message: `Inline scrape starting` });

    // Inline scrape for immediate results
    try {
      const result = await scrapeForKeyword(websiteUrl, keyword, {
        inStockOnly: search.inStockOnly,
        maxPrice: search.maxPrice ?? undefined,
      });
      pushEvent({ type: 'scrape_done', searchId: search.id, keyword, websiteUrl, message: `Inline scrape done — ${result.matches.length} match(es)` });
      await prisma.search.update({
        where: { id: search.id },
        data: { lastChecked: result.scrapedAt, lastMatchHash: result.contentHash },
      });
      if (result.matches.length > 0) {
        pushEvent({ type: 'matches_found', searchId: search.id, keyword, websiteUrl, message: `${result.matches.length} match(es) saved`, data: result.matches.map((m) => ({ title: m.title, price: m.price, url: m.url })) });
        await prisma.match.createMany({
          data: result.matches.map((m) => ({
            searchId: search.id,
            title: m.title,
            price: m.price ?? null,
            url: m.url,
            hash: result.contentHash,
          })),
          skipDuplicates: true,
        });
        const saved = await prisma.match.findMany({
          where: { searchId: search.id },
          orderBy: { foundAt: 'desc' },
        });
        allMatches.push(...saved);
      }
    } catch (err) {
      console.error(`[Route] Inline scrape failed for ${websiteUrl}:`, err);
      pushEvent({ type: 'scrape_fail', searchId: search.id, keyword, websiteUrl, message: `Inline scrape failed: ${err instanceof Error ? err.message : 'Unknown'}` });
    }

    await scheduleSearch(search.id, search.checkInterval);
    searches.push(search);
  }

  return res.status(201).json({ searches, matches: allMatches });
});

// DELETE /api/searches/:id
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  const search = await prisma.search.findFirst({
    where: { id: req.params.id, userId: req.user!.userId },
  });
  if (!search) return res.status(404).json({ error: 'Search not found' });

  await cancelSearch(search.id);
  await prisma.search.delete({ where: { id: search.id } });
  return res.json({ message: 'Search deleted' });
});

// PATCH /api/searches/:id/toggle
router.patch('/:id/toggle', requireAuth, async (req: Request, res: Response) => {
  const search = await prisma.search.findFirst({
    where: { id: req.params.id, userId: req.user!.userId },
  });
  if (!search) return res.status(404).json({ error: 'Search not found' });

  const updated = await prisma.search.update({
    where: { id: search.id },
    data: { isActive: !search.isActive },
  });

  if (updated.isActive) {
    await scheduleSearch(search.id, search.checkInterval);
  } else {
    await cancelSearch(search.id);
  }

  return res.json({ search: updated });
});

// GET /api/searches/matches/:searchId
router.get('/matches/:searchId', requireAuth, async (req: Request, res: Response) => {
  const search = await prisma.search.findFirst({
    where: { id: req.params.searchId, userId: req.user!.userId },
  });
  if (!search) return res.status(404).json({ error: 'Search not found' });

  const matches = await prisma.match.findMany({
    where: { searchId: search.id },
    orderBy: { foundAt: 'desc' },
    take: 50,
  });

  return res.json({ matches });
});

// POST /api/searches/:id/scan — re-scrape, persist new matches, trigger notifications
router.post('/:id/scan', requireAuth, async (req: Request, res: Response) => {
  const search = await prisma.search.findFirst({
    where: { id: req.params.id, userId: req.user!.userId },
    include: { user: true },
  });
  if (!search) return res.status(404).json({ error: 'Search not found' });

  pushEvent({ type: 'scrape_start', searchId: search.id, keyword: search.keyword, websiteUrl: search.websiteUrl, message: `Manual scan triggered` });

  try {
    const result = await scrapeForKeyword(search.websiteUrl, search.keyword, {
      inStockOnly: search.inStockOnly,
      maxPrice: search.maxPrice ?? undefined,
    });
    pushEvent({ type: 'scrape_done', searchId: search.id, keyword: search.keyword, websiteUrl: search.websiteUrl, message: `Manual scan done — ${result.matches.length} match(es)` });

    // Delta detection — compare scraped URLs against existing DB matches
    const existingMatches = await prisma.match.findMany({
      where: { searchId: search.id },
      select: { url: true },
    });
    const existingUrls = new Set(existingMatches.map((m) => m.url));
    const newMatches = result.matches.filter((m) => !existingUrls.has(m.url));
    const updatedMatches = result.matches.filter((m) => existingUrls.has(m.url));

    // Update existing matches (title/price may have changed)
    for (const m of updatedMatches) {
      await prisma.match.updateMany({
        where: { searchId: search.id, url: m.url },
        data: { title: m.title, price: m.price ?? null, hash: result.contentHash },
      });
    }

    // Insert genuinely new matches
    if (newMatches.length > 0) {
      await prisma.match.createMany({
        data: newMatches.map((m) => ({
          searchId: search.id,
          title: m.title,
          price: m.price ?? null,
          url: m.url,
          hash: result.contentHash,
        })),
        skipDuplicates: true,
      });
      pushEvent({
        type: 'matches_found', searchId: search.id, keyword: search.keyword, websiteUrl: search.websiteUrl,
        message: `${newMatches.length} new match(es) from manual scan`,
        data: newMatches.map((m) => ({ title: m.title, price: m.price, url: m.url })),
      });
    }

    // Update search timestamps
    await prisma.search.update({
      where: { id: search.id },
      data: { lastChecked: result.scrapedAt, lastMatchHash: result.contentHash },
    });

    // Send notifications for new matches
    let notificationId: string | null = null;
    if (newMatches.length > 0) {
      const recipientEmail = search.user?.email ?? search.notifyEmail;
      const recipientPhone = search.user?.phone;
      const notifyByEmail = (search.notificationType === 'EMAIL' || search.notificationType === 'BOTH') && !!recipientEmail;
      const notifyBySms = (search.notificationType === 'SMS' || search.notificationType === 'BOTH') && !!recipientPhone;

      // Fetch the inserted match IDs for linking to notifications
      const insertedMatches = await prisma.match.findMany({
        where: { searchId: search.id, url: { in: newMatches.map((m) => m.url) } },
        select: { id: true },
      });

      if (notifyByEmail && recipientEmail) {
        const notification = await prisma.notification.create({
          data: { searchId: search.id, type: 'EMAIL', status: 'pending' },
        });
        if (insertedMatches.length > 0) {
          await prisma.notificationMatch.createMany({
            data: insertedMatches.map((m) => ({ notificationId: notification.id, matchId: m.id })),
          });
        }
        notificationId = notification.id;
        try {
          await sendAlertEmail({ to: recipientEmail, keyword: search.keyword, matches: newMatches, notificationId: notification.id, backendUrl: config.backendUrl });
          await prisma.notification.update({ where: { id: notification.id }, data: { status: 'sent' } });
          pushEvent({ type: 'email_sent', searchId: search.id, keyword: search.keyword, websiteUrl: search.websiteUrl, message: `Email sent to ${recipientEmail}` });
        } catch (err) {
          console.error(`[Route] Scan email failed:`, err);
          await prisma.notification.update({ where: { id: notification.id }, data: { status: 'failed' } });
        }
      }

      if (notifyBySms && recipientPhone) {
        const notification = await prisma.notification.create({
          data: { searchId: search.id, type: 'SMS', status: 'pending' },
        });
        if (insertedMatches.length > 0) {
          await prisma.notificationMatch.createMany({
            data: insertedMatches.map((m) => ({ notificationId: notification.id, matchId: m.id })),
          });
        }
        if (!notificationId) notificationId = notification.id;
        try {
          await sendAlertSms(recipientPhone, search.keyword, newMatches.length, notification.id, config.backendUrl);
          await prisma.notification.update({ where: { id: notification.id }, data: { status: 'sent' } });
          pushEvent({ type: 'sms_sent', searchId: search.id, keyword: search.keyword, websiteUrl: search.websiteUrl, message: `SMS sent to ${recipientPhone}` });
        } catch (err) {
          console.error(`[Route] Scan SMS failed:`, err);
          await prisma.notification.update({ where: { id: notification.id }, data: { status: 'failed' } });
        }
      }
    }

    // Annotate results with isNew flag
    const annotatedMatches = result.matches.map((m) => ({
      ...m,
      isNew: !existingUrls.has(m.url),
    }));

    // Get updated match count
    const totalDbMatches = await prisma.match.count({ where: { searchId: search.id } });

    return res.json({
      matches: annotatedMatches,
      scrapedAt: result.scrapedAt,
      newCount: newMatches.length,
      totalDbMatches,
      notificationId,
    });
  } catch (err) {
    pushEvent({ type: 'scrape_fail', searchId: search.id, keyword: search.keyword, websiteUrl: search.websiteUrl, message: `Manual scan failed: ${err instanceof Error ? err.message : 'Unknown'}` });
    return res.status(502).json({ error: 'Scrape failed — the website may be unreachable', matches: [] });
  }
});

// GET /api/searches/:id — single search with recent matches
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  const search = await prisma.search.findFirst({
    where: { id: req.params.id, userId: req.user!.userId },
    include: {
      matches: {
        orderBy: { foundAt: 'desc' },
        take: 10,
      },
      _count: { select: { matches: true } },
    },
  });
  if (!search) return res.status(404).json({ error: 'Search not found' });
  return res.json({ search });
});

export default router;
