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
      orderBy: { createdAt: 'desc' },
    });

    // LIVE per-search match count (Match table is retired). The frontend reads
    // s._count.matches (dashboard/page.tsx, AlertCard, CompactAlertCard,
    // AlertDetailPanel), so keep that exact shape but source the count from the
    // live query. This is N live queries per load — acceptable at current scale;
    // optimize later if alert counts grow large.
    const withCounts = await Promise.all(
      searches.map(async (s) => {
        let matchCount = 0;
        try {
          const searchDomain = new URL(s.websiteUrl).hostname.replace(/^www\./, '');
          const candidateSites = await prisma.monitoredSite.findMany({
            where: { OR: [{ domain: searchDomain }, { domain: `www.${searchDomain}` }] },
            select: { id: true, domain: true },
          });
          const site = candidateSites.find(cs => cs.domain.replace(/^www\./, '') === searchDomain);
          if (site) {
            matchCount = (await searchProductIndex(s.keyword, [site.id], {
              inStockOnly: s.inStockOnly,
              maxPrice: s.maxPrice ?? undefined,
            })).length;
          }
        } catch {
          matchCount = 0;
        }
        return { ...s, _count: { matches: matchCount } };
      }),
    );

    return res.json({ searches: withCounts });
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
          // Baseline the dispatch cursor at creation so the first dispatch only
          // matches products that change AFTER the alert was saved.
          alertCursor: new Date(),
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
        // Baseline the dispatch cursor at creation (see guest path above).
        alertCursor: new Date(),
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
      orderBy: { websiteUrl: 'asc' },
    });

    if (searches.length === 0) {
      return res.status(404).json({ error: 'Search group not found' });
    }

    // Run the LIVE query for each member search (each member = one site row).
    const perSearch = await Promise.all(
      searches.map(async (s) => {
        let searchDomain: string;
        try {
          searchDomain = new URL(s.websiteUrl).hostname.replace(/^www\./, '');
        } catch {
          searchDomain = s.websiteUrl;
        }
        const site = await prisma.monitoredSite.findFirst({
          where: { domain: { contains: searchDomain } },
          select: { id: true },
        });
        const results = site
          ? await searchProductIndex(s.keyword, [site.id], {
              inStockOnly: s.inStockOnly,
              maxPrice: s.maxPrice ?? undefined,
            })
          : [];
        return { search: s, results };
      }),
    );

    const totalMatches = perSearch.reduce((sum, ps) => sum + ps.results.length, 0);
    const sitesWithMatches = perSearch.filter((ps) => ps.results.length > 0).length;

    // Union the per-search results, annotating each with its site URL.
    const unioned = perSearch.flatMap((ps) =>
      ps.results.map((p) => ({
        title: p.title,
        price: p.price,
        regularPrice: p.regularPrice,
        url: p.url,
        thumbnail: p.thumbnail,
        stockStatus: p.stockStatus,
        category: p.category,
        websiteUrl: ps.search.websiteUrl,
      })),
    );
    const annotatedMatches = unioned.slice(skip, skip + limit);

    return res.json({
      groupId,
      keyword: searches[0].keyword,
      siteCount: searches.length,
      sitesWithMatches,
      totalMatches,
      matches: annotatedMatches,
      page,
      totalPages: Math.ceil(totalMatches / limit),
      searches: perSearch.map((ps) => ({
        id: ps.search.id,
        websiteUrl: ps.search.websiteUrl,
        matchCount: ps.results.length,
        lastChecked: ps.search.lastChecked,
        isActive: ps.search.isActive,
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
      select: { id: true, keyword: true, websiteUrl: true, lastChecked: true, isActive: true, inStockOnly: true, maxPrice: true },
    });
    if (searches.length === 0) return res.status(404).json({ error: 'Group not found' });

    // Live query per member search (each member = one site row); no Match I/O.
    const perSearch = await Promise.all(
      searches.map(async (search) => {
        let searchDomain: string;
        try {
          searchDomain = new URL(search.websiteUrl).hostname.replace(/^www\./, '');
        } catch {
          return { search, results: [] as Awaited<ReturnType<typeof searchProductIndex>> };
        }
        const site = await prisma.monitoredSite.findFirst({
          where: { domain: { contains: searchDomain } },
          select: { id: true },
        });
        const results = site
          ? await searchProductIndex(search.keyword, [site.id], {
              inStockOnly: search.inStockOnly,
              maxPrice: search.maxPrice ?? undefined,
            })
          : [];
        return { search, results };
      }),
    );

    // Union the per-search results, annotating each with its site URL.
    const unioned = perSearch.flatMap((ps) =>
      ps.results.map((p) => ({
        title: p.title,
        price: p.price,
        regularPrice: p.regularPrice,
        url: p.url,
        thumbnail: p.thumbnail,
        seller: null,
        postDate: null,
        foundAt: null,
        websiteUrl: ps.search.websiteUrl,
        isNew: false, // "new since last viewed" badge is retired in the new model
        category: p.category,
        stockStatus: p.stockStatus,
      })),
    );

    const totalMatches = unioned.length;
    const annotatedMatches = unioned.slice(skip, skip + limit);
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

// GET /api/searches/live — ephemeral ad-hoc keyword search (writes NOTHING).
// MUST be registered before GET /:id so Express doesn't match "live" as an :id.
router.get('/live', optionalAuth, async (req: Request, res: Response) => {
  const handler = async () => {
    const keyword = typeof req.query.keyword === 'string' ? req.query.keyword.trim() : '';
    if (!keyword) {
      return res.status(400).json({ error: 'keyword is required' });
    }

    const searchAll = req.query.searchAll === 'true' || req.query.searchAll === '1';
    const websiteUrl = typeof req.query.websiteUrl === 'string' ? req.query.websiteUrl.trim() : '';

    try {
      // Resolve which sites to search:
      //   searchAll       → undefined (all sites)
      //   websiteUrl given → [siteId] resolved by domain (empty results if no match)
      //   neither          → undefined (all sites)
      let siteIds: string[] | undefined;
      if (searchAll) {
        siteIds = undefined;
      } else if (websiteUrl) {
        let searchDomain: string;
        try {
          searchDomain = new URL(websiteUrl).hostname.replace(/^www\./, '');
        } catch {
          searchDomain = websiteUrl;
        }
        const site = await prisma.monitoredSite.findFirst({
          where: { domain: { contains: searchDomain } },
          select: { id: true },
        });
        if (!site) {
          return res.json({ results: [], total: 0 });
        }
        siteIds = [site.id];
      } else {
        siteIds = undefined;
      }

      // Return the FULL keyword-matched set in one shot. Filtering (stock/ammo/
      // price), sorting, and pagination are applied CLIENT-SIDE so they cost zero
      // server round-trips — the expensive keyword match (full ILIKE scan over
      // ~200k rows) runs ONCE per keyword, not once per filter toggle.
      const results = await searchProductIndex(keyword, siteIds, {});

      return res.json({ results, total: results.length });
    } catch (err) {
      console.error('[Route] Live search failed:', err instanceof Error ? err.message : err);
      return res.status(500).json({ error: 'Live search failed' });
    }
  };

  // Guests get the extra rate limiter (mirror POST /); authed users go straight through.
  if (!req.user) {
    return guestSearchLimiter(req, res, handler);
  }
  return handler();
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

// GET /api/searches/matches/:searchId — per-search results sourced LIVE from
// ProductIndex (no longer reads the Match table).
router.get('/matches/:searchId', requireAuth, async (req: Request, res: Response) => {
  try {
    const search = await prisma.search.findFirst({
      where: { id: req.params.searchId, userId: req.user!.userId },
    });
    if (!search) return res.status(404).json({ error: 'Search not found' });

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 50));
    // In-stock filter: honour the query param OR the search's own setting.
    const inStockOnly = req.query.inStockOnly === 'true' || search.inStockOnly;

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

    const allResults = site
      ? await searchProductIndex(search.keyword, [site.id], {
          inStockOnly,
          maxPrice: search.maxPrice ?? undefined,
        })
      : [];

    const total = allResults.length;
    const skip = (page - 1) * limit;
    const matches = allResults.slice(skip, skip + limit).map(p => ({
      title: p.title,
      price: p.price,
      regularPrice: p.regularPrice,
      url: p.url,
      thumbnail: p.thumbnail,
      stockStatus: p.stockStatus,
      category: p.category,
    }));

    return res.json({ matches, total, page, totalPages: Math.ceil(total / limit) });
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

    // Live query against ProductIndex (zero HTTP, no Match I/O).
    const allResults = site
      ? await searchProductIndex(search.keyword, [site.id], {
          inStockOnly: search.inStockOnly,
          maxPrice: search.maxPrice ?? undefined,
        })
      : [];

    const totalDbMatches = allResults.length;
    const annotatedMatches = allResults.slice(skip, skip + limit).map((p) => ({
      title: p.title,
      price: p.price,
      regularPrice: p.regularPrice,
      url: p.url,
      thumbnail: p.thumbnail,
      seller: null,
      postDate: null,
      isNew: false, // "new since last viewed" badge is retired in the new model
      stockStatus: p.stockStatus,
      category: p.category,
    }));

    return res.json({
      matches: annotatedMatches,
      scrapedAt: new Date().toISOString(),
      newCount: 0,
      totalDbMatches,
      page,
      totalPages: Math.ceil(totalDbMatches / limit),
      notificationId: null,
    });
  } catch (err) {
    console.error(`[ScanNow] Failed for ${search.websiteUrl}:`, err instanceof Error ? err.message : err);
    // No `matches: []` — a 500 must be distinguishable from a successful empty result.
    return res.status(500).json({ error: 'Failed to scan' });
  }
});

// GET /api/searches/:id — single search with recent matches (sourced LIVE
// from ProductIndex, no longer from the Match table).
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const search = await prisma.search.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
    });
    if (!search) return res.status(404).json({ error: 'Search not found' });

    // Resolve the MonitoredSite and run the live query (cap at 50 recent rows).
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
    const allResults = site
      ? await searchProductIndex(search.keyword, [site.id], {
          inStockOnly: search.inStockOnly,
          maxPrice: search.maxPrice ?? undefined,
        })
      : [];
    const matches = allResults.slice(0, 50).map(p => ({
      title: p.title,
      price: p.price,
      regularPrice: p.regularPrice,
      url: p.url,
      thumbnail: p.thumbnail,
      stockStatus: p.stockStatus,
      category: p.category,
    }));

    return res.json({ search: { ...search, matches, _count: { matches: allResults.length } } });
  } catch (err) {
    console.error('[Route] Failed to load search:', err);
    return res.status(500).json({ error: 'Failed to load alert details' });
  }
});

export default router;
