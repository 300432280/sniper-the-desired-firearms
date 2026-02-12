import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, optionalAuth } from '../middleware/auth';
import { scheduleSearch, cancelSearch } from '../services/queue';
import { guestSearchLimiter } from '../middleware/rateLimit';

const router = Router();

const CHECK_INTERVALS = [5, 30, 60] as const;
type CheckInterval = (typeof CHECK_INTERVALS)[number];

const guestSearchSchema = z.object({
  keyword: z.string().min(2, 'Keyword must be at least 2 characters').max(100),
  websiteUrl: z.string().url('Invalid URL — must start with http:// or https://'),
  notifyEmail: z.string().email('Invalid notification email'),
});

const authSearchSchema = z.object({
  keyword: z.string().min(2).max(100),
  websiteUrl: z.string().url(),
  checkInterval: z
    .number()
    .refine((v): v is CheckInterval => CHECK_INTERVALS.includes(v as CheckInterval), {
      message: 'Check interval must be 5, 30, or 60 minutes',
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

      await scheduleSearch(search.id, 30);
      return res.status(201).json({ search });
    });
  }

  // Authenticated flow
  const parse = authSearchSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: parse.error.flatten().fieldErrors });
  }

  const search = await prisma.search.create({
    data: {
      ...parse.data,
      userId: req.user.userId,
    },
  });

  await scheduleSearch(search.id, search.checkInterval);
  return res.status(201).json({ search });
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
