import { Router, Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { requireAuth, optionalAuth } from '../middleware/auth';
import { scheduleSearch, cancelSearch } from '../services/queue';
import { scrapeWithAdapter } from '../services/scraper/index';
import { sendAlertEmail } from '../services/email';
import { sendAlertSms } from '../services/sms';
import { encryptPassword, decryptPassword } from '../lib/crypto';
import { loginToSite } from '../services/auth-manager';
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

      // Inline scrape for immediate results
      pushEvent({ type: 'search_created', searchId: search.id, keyword, websiteUrl, message: `Guest alert created` });
      pushEvent({ type: 'scrape_start', searchId: search.id, keyword, websiteUrl, message: `Inline scrape starting` });
      let initialMatches: any[] = [];
      try {
        const result = await scrapeWithAdapter(websiteUrl, keyword, { fast: true });
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
              thumbnail: m.thumbnail ?? null,
              postDate: m.postDate ? new Date(m.postDate) : null,
              seller: m.seller ?? null,
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

  const { websiteUrls, keyword, credentialId, searchAll, ...settings } = parse.data;
  const searches: any[] = [];
  const allMatches: any[] = [];
  let loginRequired = false;

  // Resolve the list of URLs to scrape
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

  // Verify credential belongs to user if provided, and resolve cookies
  let cookies: string | undefined;
  if (credentialId) {
    const cred = await prisma.siteCredential.findFirst({
      where: { id: credentialId, userId: req.user.userId },
    });
    if (!cred) return res.status(400).json({ error: 'Invalid credential' });

    // Try cached session cookies first, then login fresh
    if (cred.sessionCookies) {
      cookies = cred.sessionCookies;
    }
    if (!cookies) {
      try {
        const password = decryptPassword(cred.encryptedPassword);
        cookies = await loginToSite(cred.domain, cred.username, password);
        // Cache the session cookies
        await prisma.siteCredential.update({
          where: { id: cred.id },
          data: { sessionCookies: cookies, lastLogin: new Date() },
        });
      } catch (err) {
        console.error(`[Route] Login failed for ${cred.domain}:`, err);
      }
    }
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

    pushEvent({ type: 'search_created', searchId: search.id, keyword, websiteUrl, message: searchAll ? `Search-All alert created` : `Auth alert created` });

    // For searchAll, skip inline scrape — let the worker handle it async
    if (searchAll) {
      await scheduleSearch(search.id, settings.checkInterval);
      searches.push(search);
      continue;
    }

    pushEvent({ type: 'scrape_start', searchId: search.id, keyword, websiteUrl, message: `Inline scrape starting` });

    // Inline scrape for immediate results
    try {
      const result = await scrapeWithAdapter(websiteUrl, keyword, {
        inStockOnly: search.inStockOnly,
        maxPrice: search.maxPrice ?? undefined,
        cookies,
        fast: true,
      });
      if (result.loginRequired) loginRequired = true;
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
            thumbnail: m.thumbnail ?? null,
            postDate: m.postDate ? new Date(m.postDate) : null,
            seller: m.seller ?? null,
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

  return res.status(201).json({
    searches,
    matches: allMatches,
    loginRequired,
    searchAllGroupId: searchAllGroupId || undefined,
    siteCount: searchAll ? urlsToScrape.length : undefined,
  });
});

// GET /api/searches/group/:groupId — aggregated results for a "Search All" group
router.get('/group/:groupId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { groupId } = req.params;

    const searches = await prisma.search.findMany({
      where: {
        searchAllGroupId: groupId,
        userId: req.user!.userId,
      },
      include: {
        matches: {
          orderBy: { foundAt: 'desc' },
          take: 20,
        },
        _count: { select: { matches: true } },
      },
      orderBy: { websiteUrl: 'asc' },
    });

    if (searches.length === 0) {
      return res.status(404).json({ error: 'Search group not found' });
    }

    // Aggregate all matches across the group, sorted by date
    const allMatches = searches
      .flatMap((s) =>
        s.matches.map((m) => ({
          ...m,
          websiteUrl: s.websiteUrl,
        }))
      )
      .sort((a, b) => b.foundAt.getTime() - a.foundAt.getTime());

    const totalMatches = searches.reduce((sum, s) => sum + s._count.matches, 0);
    const sitesWithMatches = searches.filter((s) => s._count.matches > 0).length;

    return res.json({
      groupId,
      keyword: searches[0].keyword,
      siteCount: searches.length,
      sitesWithMatches,
      totalMatches,
      matches: allMatches.slice(0, 100), // Cap at 100 for performance
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
      select: { id: true, checkInterval: true },
    });

    for (const s of searches) {
      if (newState) {
        await scheduleSearch(s.id, s.checkInterval);
      } else {
        await cancelSearch(s.id);
      }
    }

    return res.json({ isActive: newState, count: searches.length });
  } catch (err) {
    console.error('[Route] Failed to toggle search group:', err);
    return res.status(500).json({ error: 'Failed to toggle group' });
  }
});

// POST /api/searches/group/:groupId/scan — parallel batch scan all sites in group
router.post('/group/:groupId/scan', requireAuth, async (req: Request, res: Response) => {
  try {
    const { groupId } = req.params;
    const searches = await prisma.search.findMany({
      where: { searchAllGroupId: groupId, userId: req.user!.userId },
      select: { id: true, keyword: true, websiteUrl: true, inStockOnly: true, maxPrice: true },
    });
    if (searches.length === 0) return res.status(404).json({ error: 'Group not found' });

    // Filter out searches whose sites have been disabled
    const enabledSites = await prisma.monitoredSite.findMany({
      where: { isEnabled: true },
      select: { url: true },
    });
    const enabledUrls = new Set(enabledSites.map((s) => s.url));
    const activeSearches = searches.filter((s) => enabledUrls.has(s.websiteUrl));

    const keyword = activeSearches[0]?.keyword || searches[0].keyword;
    pushEvent({ type: 'info', message: `Group scan started: ${activeSearches.length} active sites (${searches.length - activeSearches.length} disabled) for "${keyword}"` });

    // Scrape all sites in parallel (single batch — all concurrent with per-site timeout)
    const SITE_TIMEOUT = 30000; // 30s per site
    const allResults: Array<{ searchId: string; websiteUrl: string; matches: any[]; error?: string }> = [];

    for (let i = 0; i < activeSearches.length; i += activeSearches.length) {
      const batch = activeSearches.slice(i, i + activeSearches.length);
      const results = await Promise.allSettled(
        batch.map(async (s) => {
          // Per-site timeout to prevent one slow site from blocking
          const result = await Promise.race([
            scrapeWithAdapter(s.websiteUrl, s.keyword, {
              inStockOnly: s.inStockOnly,
              maxPrice: s.maxPrice ?? undefined,
              fast: true,
            }),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timeout scraping ${s.websiteUrl}`)), SITE_TIMEOUT)),
          ]);

          // Delta detect + persist
          const existing = await prisma.match.findMany({
            where: { searchId: s.id },
            select: { url: true },
          });
          const existingUrls = new Set(existing.map((m) => m.url));
          const newMatches = result.matches.filter((m) => !existingUrls.has(m.url));
          const updatedMatches = result.matches.filter((m) => existingUrls.has(m.url));

          for (const m of updatedMatches) {
            await prisma.match.updateMany({
              where: { searchId: s.id, url: m.url },
              data: { title: m.title, price: m.price ?? null, hash: result.contentHash, thumbnail: m.thumbnail ?? undefined, seller: m.seller ?? undefined },
            });
          }

          if (newMatches.length > 0) {
            await prisma.match.createMany({
              data: newMatches.map((m) => ({
                searchId: s.id, title: m.title, price: m.price ?? null, url: m.url,
                hash: result.contentHash, thumbnail: m.thumbnail ?? null,
                postDate: m.postDate ? new Date(m.postDate) : null, seller: m.seller ?? null,
              })),
              skipDuplicates: true,
            });
          }

          await prisma.search.update({
            where: { id: s.id },
            data: { lastChecked: result.scrapedAt, lastMatchHash: result.contentHash },
          });

          const domain = new URL(s.websiteUrl).hostname.replace('www.', '');
          pushEvent({ type: 'scrape_done', message: `${domain}: ${result.matches.length} matches` });
          return { searchId: s.id, websiteUrl: s.websiteUrl, matches: result.matches };
        })
      );

      for (const [idx, r] of results.entries()) {
        if (r.status === 'fulfilled') {
          allResults.push(r.value);
        } else {
          allResults.push({
            searchId: batch[idx].id,
            websiteUrl: batch[idx].websiteUrl,
            matches: [],
            error: r.reason?.message || 'Unknown error',
          });
        }
      }
    }

    const totalMatches = allResults.reduce((sum, r) => sum + r.matches.length, 0);
    const successCount = allResults.filter((r) => !r.error).length;
    const failCount = allResults.filter((r) => r.error).length;

    pushEvent({ type: 'info', message: `Group scan done: ${successCount} ok, ${failCount} failed, ${totalMatches} total matches` });

    // Return aggregated fresh matches
    const flatMatches = allResults.flatMap((r) =>
      r.matches.map((m) => ({ ...m, websiteUrl: r.websiteUrl }))
    );

    return res.json({
      scannedSites: activeSearches.length,
      successCount,
      failCount,
      totalMatches,
      matches: flatMatches.slice(0, 200),
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

    if (updated.isActive) {
      await scheduleSearch(search.id, search.checkInterval);
    } else {
      await cancelSearch(search.id);
    }

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

    const matches = await prisma.match.findMany({
      where: { searchId: search.id },
      orderBy: { foundAt: 'desc' },
      take: 50,
    });

    return res.json({ matches });
  } catch (err) {
    console.error('[Route] Failed to load matches:', err);
    return res.status(500).json({ error: 'Failed to load match history' });
  }
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
    const result = await scrapeWithAdapter(search.websiteUrl, search.keyword, {
      inStockOnly: search.inStockOnly,
      maxPrice: search.maxPrice ?? undefined,
      fast: true,
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

    // Update existing matches (title/price/thumbnail may have changed)
    for (const m of updatedMatches) {
      await prisma.match.updateMany({
        where: { searchId: search.id, url: m.url },
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
          searchId: search.id,
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
    console.error(`[Route] Scan error for ${search.websiteUrl}:`, err instanceof Error ? err.message : err);
    pushEvent({ type: 'scrape_fail', searchId: search.id, keyword: search.keyword, websiteUrl: search.websiteUrl, message: `Manual scan failed: ${err instanceof Error ? err.message : 'Unknown'}` });
    return res.status(502).json({ error: 'Scrape failed — the website may be unreachable', matches: [] });
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
          take: 10,
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
