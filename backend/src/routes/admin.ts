import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth';
import { getEvents, subscribe } from '../services/debugLog';
import { runHealthChecks, getHealthSummary, pruneOldHealthChecks } from '../services/health-monitor';
import { prisma } from '../lib/prisma';
import { invalidateAdapterCache } from '../services/scraper/adapter-registry';

const router = Router();

// All admin routes require admin auth
router.use(requireAdmin);

// ─── Debug Log ────────────────────────────────────────────────────────────────

// GET /api/admin/debug-log/history — returns all buffered events as JSON
router.get('/debug-log/history', (_req: Request, res: Response) => {
  return res.json({ events: getEvents() });
});

// GET /api/admin/debug-log — SSE stream of live events
router.get('/debug-log', (req: Request, res: Response) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable nginx buffering
  });

  // Send initial keepalive
  res.write(':ok\n\n');

  const unsubscribe = subscribe((event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  // Send keepalive every 30s to prevent timeout
  const keepalive = setInterval(() => {
    res.write(':keepalive\n\n');
  }, 30000);

  req.on('close', () => {
    unsubscribe();
    clearInterval(keepalive);
  });
});

// ─── Health Monitoring ────────────────────────────────────────────────────────

// GET /api/admin/health — latest health summary for all sites
router.get('/health', async (_req: Request, res: Response) => {
  try {
    const summary = await getHealthSummary();
    return res.json(summary);
  } catch (err) {
    console.error('[Admin] Health summary error:', err);
    return res.status(500).json({ error: 'Failed to fetch health summary' });
  }
});

// POST /api/admin/health/run — trigger a full health check
router.post('/health/run', async (_req: Request, res: Response) => {
  try {
    const result = await runHealthChecks();
    return res.json(result);
  } catch (err) {
    console.error('[Admin] Health check run error:', err);
    return res.status(500).json({ error: 'Health check failed' });
  }
});

// POST /api/admin/health/prune — clean up old health check records
router.post('/health/prune', async (_req: Request, res: Response) => {
  try {
    const deleted = await pruneOldHealthChecks();
    return res.json({ deleted });
  } catch (err) {
    console.error('[Admin] Health prune error:', err);
    return res.status(500).json({ error: 'Prune failed' });
  }
});

// ─── Monitored Sites CRUD ─────────────────────────────────────────────────────

// GET /api/admin/sites — list all monitored sites with latest health status
router.get('/sites', async (_req: Request, res: Response) => {
  try {
    const sites = await prisma.monitoredSite.findMany({
      include: {
        healthChecks: {
          orderBy: { checkedAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { domain: 'asc' },
    });
    return res.json({ sites });
  } catch (err) {
    console.error('[Admin] List sites error:', err);
    return res.status(500).json({ error: 'Failed to list sites' });
  }
});

// POST /api/admin/sites — add a new monitored site
router.post('/sites', async (req: Request, res: Response) => {
  try {
    const { domain, name, url, siteType, adapterType, requiresSucuri, requiresAuth, searchUrlPattern, notes } = req.body;

    if (!domain || !name || !url) {
      return res.status(400).json({ error: 'domain, name, and url are required' });
    }

    const site = await prisma.monitoredSite.create({
      data: {
        domain,
        name,
        url,
        siteType: siteType || 'retailer',
        adapterType: adapterType || 'generic',
        requiresSucuri: requiresSucuri || false,
        requiresAuth: requiresAuth || false,
        searchUrlPattern: searchUrlPattern || null,
        notes: notes || null,
      },
    });

    invalidateAdapterCache();
    return res.status(201).json({ site });
  } catch (err: any) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'Site with this domain already exists' });
    }
    console.error('[Admin] Create site error:', err);
    return res.status(500).json({ error: 'Failed to create site' });
  }
});

// PATCH /api/admin/sites/:id — update a monitored site
router.patch('/sites/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, url, siteType, adapterType, isEnabled, requiresSucuri, requiresAuth, searchUrlPattern, notes } = req.body;

    const site = await prisma.monitoredSite.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(url !== undefined && { url }),
        ...(siteType !== undefined && { siteType }),
        ...(adapterType !== undefined && { adapterType }),
        ...(isEnabled !== undefined && { isEnabled }),
        ...(requiresSucuri !== undefined && { requiresSucuri }),
        ...(requiresAuth !== undefined && { requiresAuth }),
        ...(searchUrlPattern !== undefined && { searchUrlPattern }),
        ...(notes !== undefined && { notes }),
      },
    });

    invalidateAdapterCache();
    return res.json({ site });
  } catch (err: any) {
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'Site not found' });
    }
    console.error('[Admin] Update site error:', err);
    return res.status(500).json({ error: 'Failed to update site' });
  }
});

// DELETE /api/admin/sites/:id — remove a monitored site
router.delete('/sites/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Delete health checks first (cascade)
    await prisma.siteHealthCheck.deleteMany({ where: { siteId: id } });
    await prisma.monitoredSite.delete({ where: { id } });

    invalidateAdapterCache();
    return res.json({ success: true });
  } catch (err: any) {
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'Site not found' });
    }
    console.error('[Admin] Delete site error:', err);
    return res.status(500).json({ error: 'Failed to delete site' });
  }
});

// POST /api/admin/sites/:id/test — test scrape a single site
router.post('/sites/:id/test', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { keyword } = req.body;

    const site = await prisma.monitoredSite.findUnique({ where: { id } });
    if (!site) return res.status(404).json({ error: 'Site not found' });

    const testKeyword = keyword || 'rifle';

    // Use the adapter-based scraper
    const { scrapeWithAdapter } = await import('../services/scraper/index');
    const result = await scrapeWithAdapter(site.url, testKeyword, { fast: true });

    return res.json({
      site: { id: site.id, domain: site.domain, name: site.name },
      keyword: testKeyword,
      adapterUsed: result.adapterUsed,
      matchCount: result.matches.length,
      matches: result.matches.slice(0, 10), // Return first 10 for preview
      loginRequired: result.loginRequired,
      errors: result.errors,
    });
  } catch (err) {
    console.error('[Admin] Test scrape error:', err);
    return res.status(500).json({ error: 'Test scrape failed' });
  }
});

export default router;
