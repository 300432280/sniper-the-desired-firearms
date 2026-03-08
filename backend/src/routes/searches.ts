import { Router, Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { requireAuth, optionalAuth } from '../middleware/auth';
import { cancelSearch } from '../services/queue';
import { encryptPassword } from '../lib/crypto';
import { guestSearchLimiter } from '../middleware/rateLimit';
import { pushEvent } from '../services/debugLog';
import { searchProductIndex } from '../services/keyword-matcher';
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
  websiteUrls: websiteUrlsField.optional(),
  checkInterval: z
    .number()
    .refine((v): v is CheckInterval => CHECK_INTERVALS.includes(v as CheckInterval), {
      message: 'Check interval must be 0 (test), 5, 30, or 60 minutes',
    })
    .default(30),
  notificationType: z.enum(['EMAIL', 'SMS', 'BOTH']).default('EMAIL'),
  inStockOnly: z.boolean().default(false),
  maxPrice: z.number().positive().optional(),
  credentialId: z.string().optional(),
  searchAll: z.boolean().optional(),
}).refine(
  (data) => data.searchAll || (data.websiteUrls && data.websiteUrls.length > 0),
  { message: 'Either websiteUrls or searchAll: true is required', path: ['websiteUrls'] }
);

// ── Credential schemas ─────────────────────────────────────────────────────────

const credentialSchema = z.object({
  domain: z.string().min(3).max(100),
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(200),
});

// GET /api/searches
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const searches = await prisma.search.findMany({
      where: { userId: req.user!.userId },
      include: {
        _count: { select: { matches: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ searches });
  } catch (err) {
    console.error('[Route] Failed to list searches:', err);
    return res.status(500).json({ error: 'Failed to load alerts' });
  }
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

      // No inline scrape — the unified crawl scheduler will pick this up
      pushEvent({ type: 'search_created', searchId: search.id, keyword, websiteUrl, message: `Guest alert created — awaiting next scheduled crawl` });

      return res.status(201).json({ search, matches: [] });
    });
  }

  // Authenticated flow
  const parse = authSearchSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: parse.error.flatten().fieldErrors });
  }

  const { websiteUrls, keyword, credentialId, searchAll, ...settings } = parse.data;
  const isAdmin = config.adminEmails.includes(req.user.email);
  const userTier = isAdmin ? 'PRO' : (req.user.tier || 'FREE');

  // FREE tier restrictions
  if (userTier === 'FREE') {
    // Force daily interval and EMAIL-only notifications
    settings.checkInterval = 60 as CheckInterval; // Slowest allowed interval
    settings.notificationType = 'EMAIL';

    // Cap at 3 active alerts
    const activeCount = await prisma.search.count({
      where: { userId: req.user.userId, isActive: true },
    });
    if (activeCount >= 3) {
      return res.status(403).json({
        error: 'Free accounts are limited to 3 active alerts. Upgrade to Pro for unlimited alerts.',
        tier: 'FREE',
        limit: 3,
      });
    }
  }
  const searches: any[] = [];

  // Resolve the list of URLs to create alerts for
  let urlsToScrape: string[];
  let searchAllGroupId: string | undefined;

  if (searchAll) {
    // Search All Sites — fetch all enabled MonitoredSites
    const sites = await prisma.monitoredSite.findMany({
      where: { isEnabled: true },
      select: { url: true },
      orderBy: { domain: 'asc' },
    });
    urlsToScrape = sites.map((s) => s.url);
    searchAllGroupId = crypto.randomUUID();

    if (urlsToScrape.length === 0) {
      return res.status(400).json({ error: 'No monitored sites available' });
    }
  } else {
    urlsToScrape = websiteUrls!;
  }

  // Verify credential belongs to user if provided
  if (credentialId) {
    const cred = await prisma.siteCredential.findFirst({
      where: { id: credentialId, userId: req.user.userId },
    });
    if (!cred) return res.status(400).json({ error: 'Invalid credential' });
  }

  for (const websiteUrl of urlsToScrape) {
    const search = await prisma.search.create({
      data: {
        keyword,
        websiteUrl,
        ...settings,
        userId: req.user.userId,
        credentialId: credentialId || undefined,
        searchAllGroupId: searchAllGroupId || undefined,
      },
    });

    pushEvent({ type: 'search_created', searchId: search.id, keyword, websiteUrl, message: searchAll ? `Search-All alert created` : `Auth alert created — awaiting next scheduled crawl` });
    searches.push(search);
  }

  return res.status(201).json({
    searches,
    matches: [],
    searchAllGroupId: searchAllGroupId || undefined,
    siteCount: searchAll ? urlsToScrape.length : undefined,
  });
});

// GET /api/searches/group/:groupId — aggregated results for a "Search All" group
router.get('/group/:groupId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { groupId } = req.params;

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 50));
    const skip = (page - 1) * limit;

    const searches = await prisma.search.findMany({
      where: {
        searchAllGroupId: groupId,
        userId: req.user!.userId,
      },
      include: {
        _count: { select: { matches: true } },
      },
      orderBy: { websiteUrl: 'asc' },
    });

    if (searches.length === 0) {
      return res.status(404).json({ error: 'Search group not found' });
    }

    const searchIds = searches.map((s) => s.id);
    const totalMatches = searches.reduce((sum, s) => sum + s._count.matches, 0);
    const sitesWithMatches = searches.filter((s) => s._count.matches > 0).length;

    // Paginated matches across all searches in the group
    const matches = await prisma.match.findMany({
      where: { searchId: { in: searchIds } },
      orderBy: { foundAt: 'desc' },
      skip,
      take: limit,
      include: { search: { select: { websiteUrl: true } } },
    });

    const annotatedMatches = matches.map((m) => ({
      ...m,
      websiteUrl: m.search.websiteUrl,
      search: undefined,
    }));

    return res.json({
      groupId,
      keyword: searches[0].keyword,
      siteCount: searches.length,
      sitesWithMatches,
      totalMatches,
      matches: annotatedMatches,
      page,
      totalPages: Math.ceil(totalMatches / limit),
      searches: searches.map((s) => ({
        id: s.id,
        websiteUrl: s.websiteUrl,
        matchCount: s._count.matches,
        lastChecked: s.lastChecked,
        isActive: s.isActive,
      })),
    });
  } catch (err) {
    console.error('[Route] Failed to load search group:', err);
    return res.status(500).json({ error: 'Failed to load search group' });
  }
});

// ── Group operations (Search All) ─────────────────────────────────────────────

// DELETE /api/searches/group/:groupId — delete all searches in a group
router.delete('/group/:groupId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { groupId } = req.params;
    const searches = await prisma.search.findMany({
      where: { searchAllGroupId: groupId, userId: req.user!.userId },
      select: { id: true },
    });
    if (searches.length === 0) return res.status(404).json({ error: 'Group not found' });

    for (const s of searches) {
      await cancelSearch(s.id);
    }
    await prisma.search.deleteMany({
      where: { searchAllGroupId: groupId, userId: req.user!.userId },
    });
    return res.json({ message: `Deleted ${searches.length} searches` });
  } catch (err) {
    console.error('[Route] Failed to delete search group:', err);
    return res.status(500).json({ error: 'Failed to delete group' });
  }
});

// PATCH /api/searches/group/:groupId/toggle — toggle all searches in a group
router.patch('/group/:groupId/toggle', requireAuth, async (req: Request, res: Response) => {
  try {
    const { groupId } = req.params;
    const first = await prisma.search.findFirst({
      where: { searchAllGroupId: groupId, userId: req.user!.userId },
    });
    if (!first) return res.status(404).json({ error: 'Group not found' });

    const newState = !first.isActive;
    await prisma.search.updateMany({
      where: { searchAllGroupId: groupId, userId: req.user!.userId },
      data: { isActive: newState },
    });

    const searches = await prisma.search.findMany({
      where: { searchAllGroupId: groupId, userId: req.user!.userId },
      select: { id: true },
    });

    // Cancel any legacy per-search BullMQ jobs
    for (const s of searches) {
      await cancelSearch(s.id);
    }

    return res.json({ isActive: newState, count: searches.length });
  } catch (err) {
    console.error('[Route] Failed to toggle search group:', err);
    return res.status(500).json({ error: 'Failed to toggle group' });
  }
});

// POST /api/searches/group/:groupId/scan — read cached matches, trigger crawls for empty sites
router.post('/group/:groupId/scan', requireAuth, async (req: Request, res: Response) => {
  try {
    const { groupId } = req.params;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 50));
    const skip = (page - 1) * limit;

    const searches = await prisma.search.findMany({
      where: { searchAllGroupId: groupId, userId: req.user!.userId },
      select: { id: true, keyword: true, websiteUrl: true, lastChecked: true, isActive: true },
    });
    if (searches.length === 0) return res.status(404).json({ error: 'Group not found' });

    const searchIds = searches.map((s) => s.id);

    const [matches, totalMatches] = await Promise.all([
      prisma.match.findMany({
        where: { searchId: { in: searchIds } },
        orderBy: { foundAt: 'desc' },
        skip,
        take: limit,
        include: { search: { select: { websiteUrl: true, lastChecked: true } } },
      }),
      prisma.match.count({ where: { searchId: { in: searchIds } } }),
    ]);

    // Pure DB read — no crawl triggering from user endpoints.
    // The crawl scheduler handles all crawl timing independently.

    // Enrich with ProductIndex thumbnails for matches that lack them
    const matchUrlsNoThumb = matches.filter(m => !m.thumbnail).map(m => m.url);
    const piThumbnails = matchUrlsNoThumb.length > 0
      ? await prisma.productIndex.findMany({
          where: { url: { in: matchUrlsNoThumb }, thumbnail: { not: null } },
          select: { url: true, thumbnail: true },
        })
      : [];
    const groupThumbnailMap = new Map(piThumbnails.map(p => [p.url, p.thumbnail]));

    const annotatedMatches = matches.map((m) => ({
      title: m.title,
      price: m.price,
      url: m.url,
      thumbnail: m.thumbnail || groupThumbnailMap.get(m.url) || null,
      seller: m.seller,
      postDate: m.postDate,
      foundAt: m.foundAt,
      websiteUrl: m.search.websiteUrl,
      isNew: m.search.lastChecked ? m.foundAt > m.search.lastChecked : true,
    }));

    // Update lastChecked for all searches in group
    await prisma.search.updateMany({
      where: { id: { in: searchIds } },
      data: { lastChecked: new Date() },
    });

    const successCount = searches.length;

    return res.json({
      scannedSites: searches.length,
      successCount,
      totalMatches,
      matches: annotatedMatches,
      page,
      totalPages: Math.ceil(totalMatches / limit),
    });
  } catch (err) {
    console.error('[Route] Group scan failed:', err);
    return res.status(500).json({ error: 'Group scan failed' });
  }
});

// ── Credential endpoints (must come before /:id routes) ──────────────────────

// GET /api/searches/credentials — list user's stored credentials
router.get('/credentials', requireAuth, async (req: Request, res: Response) => {
  try {
    const credentials = await prisma.siteCredential.findMany({
      where: { userId: req.user!.userId },
      select: {
        id: true,
        domain: true,
        username: true,
        lastLogin: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ credentials });
  } catch (err) {
    console.error('[Route] Failed to list credentials:', err);
    return res.status(500).json({ error: 'Failed to load credentials' });
  }
});

// POST /api/searches/credentials — store a site credential
router.post('/credentials', requireAuth, async (req: Request, res: Response) => {
  try {
    const parse = credentialSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: parse.error.flatten().fieldErrors });
    }

    const { domain, username, password } = parse.data;
    const normalizedDomain = domain.replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/.*$/, '').toLowerCase();

    const encryptedPassword = encryptPassword(password);

    const credential = await prisma.siteCredential.upsert({
      where: {
        userId_domain: {
          userId: req.user!.userId,
          domain: normalizedDomain,
        },
      },
      update: {
        username,
        encryptedPassword,
        sessionCookies: null,
      },
      create: {
        userId: req.user!.userId,
        domain: normalizedDomain,
        username,
        encryptedPassword,
      },
    });

    return res.status(201).json({
      credential: {
        id: credential.id,
        domain: credential.domain,
        username: credential.username,
        lastLogin: credential.lastLogin,
      },
    });
  } catch (err) {
    console.error('[Route] Failed to save credential:', err);
    return res.status(500).json({ error: 'Failed to save credential' });
  }
});

// DELETE /api/searches/credentials/:id — remove a credential
router.delete('/credentials/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const credential = await prisma.siteCredential.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
    });
    if (!credential) return res.status(404).json({ error: 'Credential not found' });

    await prisma.siteCredential.delete({ where: { id: credential.id } });
    return res.json({ message: 'Credential deleted' });
  } catch (err) {
    console.error('[Route] Failed to delete credential:', err);
    return res.status(500).json({ error: 'Failed to delete credential' });
  }
});

// DELETE /api/searches/:id
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const search = await prisma.search.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
    });
    if (!search) return res.status(404).json({ error: 'Search not found' });

    await cancelSearch(search.id);
    await prisma.search.delete({ where: { id: search.id } });
    return res.json({ message: 'Search deleted' });
  } catch (err) {
    console.error('[Route] Failed to delete search:', err);
    return res.status(500).json({ error: 'Failed to delete alert' });
  }
});

// PATCH /api/searches/:id/toggle
router.patch('/:id/toggle', requireAuth, async (req: Request, res: Response) => {
  try {
    const search = await prisma.search.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
    });
    if (!search) return res.status(404).json({ error: 'Search not found' });

    const updated = await prisma.search.update({
      where: { id: search.id },
      data: { isActive: !search.isActive },
    });

    // Cancel any legacy per-search BullMQ job
    await cancelSearch(search.id);

    return res.json({ search: updated });
  } catch (err) {
    console.error('[Route] Failed to toggle search:', err);
    return res.status(500).json({ error: 'Failed to toggle alert' });
  }
});

// GET /api/searches/matches/:searchId
router.get('/matches/:searchId', requireAuth, async (req: Request, res: Response) => {
  try {
    const search = await prisma.search.findFirst({
      where: { id: req.params.searchId, userId: req.user!.userId },
    });
    if (!search) return res.status(404).json({ error: 'Search not found' });

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 50));
    const skip = (page - 1) * limit;

    const [matches, total] = await Promise.all([
      prisma.match.findMany({
        where: { searchId: search.id },
        orderBy: { foundAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.match.count({ where: { searchId: search.id } }),
    ]);

    // Enrich matches with stockStatus from ProductIndex
    const matchUrls = matches.map(m => m.url);
    const products = matchUrls.length > 0
      ? await prisma.productIndex.findMany({
          where: { url: { in: matchUrls } },
          select: { url: true, stockStatus: true },
        })
      : [];
    const stockMap = new Map(products.map(p => [p.url, p.stockStatus]));
    const enrichedMatches = matches.map(m => ({
      ...m,
      stockStatus: stockMap.get(m.url) || null,
    }));

    return res.json({ matches: enrichedMatches, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('[Route] Failed to load matches:', err);
    return res.status(500).json({ error: 'Failed to load match history' });
  }
});

// POST /api/searches/:id/scan — query ProductIndex for keyword matches (zero HTTP)
router.post('/:id/scan', requireAuth, async (req: Request, res: Response) => {
  const search = await prisma.search.findFirst({
    where: { id: req.params.id, userId: req.user!.userId },
  });
  if (!search) return res.status(404).json({ error: 'Search not found' });

  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 50));
  const skip = (page - 1) * limit;

  try {
    // Resolve the MonitoredSite for this search's URL
    let searchDomain: string;
    try {
      searchDomain = new URL(search.websiteUrl).hostname.replace(/^www\./, '');
    } catch {
      searchDomain = search.websiteUrl;
    }

    const site = await prisma.monitoredSite.findFirst({
      where: { domain: { contains: searchDomain } },
      select: { id: true },
    });

    // Query ProductIndex for keyword matches (zero HTTP, instant SQL)
    // Respect search.inStockOnly — if user didn't ask for in-stock only, show everything
    const indexMatches = site
      ? await searchProductIndex(search.keyword, [site.id], { inStockOnly: search.inStockOnly })
      : [];
    const indexUrls = new Set(indexMatches.map(p => p.url));
    // Build URL → stockStatus/thumbnail lookups for response annotation
    const stockStatusMap = new Map(indexMatches.map(p => [p.url, p.stockStatus]));
    const thumbnailMap = new Map(indexMatches.filter(p => p.thumbnail).map(p => [p.url, p.thumbnail]));

    // Sync Match table with ProductIndex
    if (indexUrls.size > 0) {
      const existingUrls = new Set(
        (await prisma.match.findMany({
          where: { searchId: search.id },
          select: { url: true },
        })).map(m => m.url),
      );

      // Insert new products not yet in Match table
      const newProducts = indexMatches.filter(p => !existingUrls.has(p.url));
      if (newProducts.length > 0) {
        await prisma.match.createMany({
          data: newProducts.map(p => ({
            searchId: search.id,
            title: p.title,
            price: p.price,
            url: p.url,
            hash: `pi:scan`,
            thumbnail: p.thumbnail,
          })),
          skipDuplicates: true,
        });
      }

      // Backfill thumbnails: update existing matches that have null thumbnail
      // but ProductIndex now has one (e.g. catalog crawl discovered the image)
      const thumbUpdates = indexMatches.filter(p => p.thumbnail && existingUrls.has(p.url));
      for (const p of thumbUpdates) {
        await prisma.match.updateMany({
          where: { searchId: search.id, url: p.url, thumbnail: null },
          data: { thumbnail: p.thumbnail },
        });
      }

      // Remove Match records for products no longer in ProductIndex at all
      const staleUrls = [...existingUrls].filter(u => !indexUrls.has(u));
      if (staleUrls.length > 0) {
        await prisma.match.deleteMany({
          where: { searchId: search.id, url: { in: staleUrls } },
        });
      }

      console.log(`[ScanNow] ${searchDomain} "${search.keyword}" — ${indexUrls.size} matches, +${newProducts.length} new, -${staleUrls.length} removed`);
    }

    // Read back synced matches (paginated)
    const [matches, totalDbMatches] = await Promise.all([
      prisma.match.findMany({
        where: { searchId: search.id },
        orderBy: { foundAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.match.count({ where: { searchId: search.id } }),
    ]);

    const lastViewed = search.lastChecked;
    const annotatedMatches = matches.map((m) => ({
      title: m.title,
      price: m.price,
      url: m.url,
      thumbnail: m.thumbnail || thumbnailMap.get(m.url) || null,
      seller: m.seller,
      postDate: m.postDate,
      isNew: lastViewed ? m.foundAt > lastViewed : true,
      stockStatus: stockStatusMap.get(m.url) || null,
    }));

    const newCount = annotatedMatches.filter((m) => m.isNew).length;

    // Update lastChecked to track "last viewed"
    await prisma.search.update({
      where: { id: search.id },
      data: { lastChecked: new Date() },
    });

    return res.json({
      matches: annotatedMatches,
      scrapedAt: new Date().toISOString(),
      newCount,
      totalDbMatches,
      page,
      totalPages: Math.ceil(totalDbMatches / limit),
      notificationId: null,
    });
  } catch (err) {
    console.error(`[ScanNow] Failed for ${search.websiteUrl}:`, err instanceof Error ? err.message : err);
    return res.status(500).json({ error: 'Failed to scan', matches: [] });
  }
});

// GET /api/searches/:id — single search with recent matches
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const search = await prisma.search.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
      include: {
        matches: {
          orderBy: { foundAt: 'desc' },
          take: 50,
        },
        _count: { select: { matches: true } },
      },
    });
    if (!search) return res.status(404).json({ error: 'Search not found' });
    return res.json({ search });
  } catch (err) {
    console.error('[Route] Failed to load search:', err);
    return res.status(500).json({ error: 'Failed to load alert details' });
  }
});

export default router;
