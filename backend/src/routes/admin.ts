import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth';
import { getEvents, subscribe } from '../services/debugLog';
import { runHealthChecks, getHealthSummary, pruneOldHealthChecks } from '../services/health-monitor';
import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import { invalidateAdapterCache } from '../services/scraper/adapter-registry';
import { computeCrawlPriority } from '../services/priority-engine';
import { resolveTuning, TUNING_DEFAULTS } from '../services/crawl-tuning';

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
    const { name, url, siteType, adapterType, isEnabled, isPaused, requiresSucuri, requiresAuth, searchUrlPattern, notes } = req.body;

    const site = await prisma.monitoredSite.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(url !== undefined && { url }),
        ...(siteType !== undefined && { siteType }),
        ...(adapterType !== undefined && { adapterType }),
        ...(isEnabled !== undefined && { isEnabled }),
        ...(isPaused !== undefined && { isPaused }),
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

// PATCH /api/admin/sites/batch — batch update isEnabled or isPaused for multiple sites
router.patch('/sites/batch', async (req: Request, res: Response) => {
  try {
    const { siteIds, isEnabled, isPaused } = req.body;
    if (!Array.isArray(siteIds) || siteIds.length === 0) {
      return res.status(400).json({ error: 'siteIds (array) is required' });
    }
    if (typeof isEnabled !== 'boolean' && typeof isPaused !== 'boolean') {
      return res.status(400).json({ error: 'isEnabled (boolean) or isPaused (boolean) is required' });
    }
    const data: Record<string, boolean> = {};
    if (typeof isEnabled === 'boolean') data.isEnabled = isEnabled;
    if (typeof isPaused === 'boolean') data.isPaused = isPaused;
    await prisma.monitoredSite.updateMany({
      where: { id: { in: siteIds } },
      data,
    });
    return res.json({ updated: siteIds.length, ...data });
  } catch (err) {
    console.error('[Admin] Batch update error:', err);
    return res.status(500).json({ error: 'Failed to batch update sites' });
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

// ─── Site Dashboard (Crawl Engine) ──────────────────────────────────────────

// GET /api/admin/sites/dashboard — all sites with crawl metrics and computed priority
router.get('/sites/dashboard', async (_req: Request, res: Response) => {
  try {
    const sites = await prisma.monitoredSite.findMany({
      include: {
        crawlEvents: {
          orderBy: { crawledAt: 'desc' },
          take: 5,
          select: {
            status: true,
            responseTimeMs: true,
            statusCode: true,
            matchesFound: true,
            crawledAt: true,
          },
        },
        _count: {
          select: { crawlEvents: true, products: true },
        },
      },
      orderBy: { domain: 'asc' },
    });

    // Count active searches per site
    const searchCounts = await prisma.search.groupBy({
      by: ['websiteUrl'],
      where: { isActive: true },
      _count: { id: true },
    });
    const searchCountMap = new Map(searchCounts.map(s => [s.websiteUrl, s._count.id]));

    const dashboard = sites.map(site => {
      const lastCrawl = site.crawlEvents[0] ?? null;
      const activeSearches = searchCountMap.get(site.url) ?? 0;

      // Compute v2 interval and budget dynamically using per-site tuning
      const tuning = resolveTuning(site.crawlTuning);
      const siteCategory = (site.siteCategory || 'retailer') as 'forum' | 'classified' | 'retailer' | 'auction';
      const priority = computeCrawlPriority({
        siteCategory,
        capacity: site.capacity ?? 1,
        baseBudget: tuning.baseBudget,
        tier1IntervalMin: tuning.tier1IntervalMin,
      });

      return {
        id: site.id,
        domain: site.domain,
        name: site.name,
        url: site.url,
        isEnabled: site.isEnabled,
        isPaused: site.isPaused,
        adapterType: site.adapterType,
        siteType: site.siteType,
        siteCategory: site.siteCategory,

        // v2 pressure/capacity model
        pressure: site.pressure,
        capacity: site.capacity,
        baseBudget: site.baseBudget,
        effectiveBudget: priority.effectiveBudget,
        minGapSeconds: priority.minGapSeconds,
        v2IntervalMin: priority.intervalMinutes,

        // Crawl metrics
        crawlIntervalMin: site.crawlIntervalMin,
        nextCrawlAt: site.nextCrawlAt,
        lastCrawlAt: site.lastCrawlAt,
        crawlLock: site.crawlLock,
        consecutiveFailures: site.consecutiveFailures,
        avgResponseTimeMs: site.avgResponseTimeMs,

        // v2 catalog fields
        lastWatermarkUrl: site.lastWatermarkUrl,
        tierState: site.tierState,
        streamState: site.streamState,
        addedAt: site.addedAt,
        coldStartOverride: site.coldStartOverride,
        productCount: site._count.products,

        // Difficulty signals
        hasWaf: site.hasWaf,
        hasRateLimit: site.hasRateLimit,
        hasCaptcha: site.hasCaptcha,
        requiresSucuri: site.requiresSucuri,

        // Per-site crawl tuning
        crawlTuning: site.crawlTuning,

        // Computed
        activeSearches,
        totalCrawlEvents: site._count.crawlEvents,
        lastCrawl,
        recentCrawls: site.crawlEvents,
      };
    });

    return res.json({ sites: dashboard });
  } catch (err) {
    console.error('[Admin] Site dashboard error:', err);
    return res.status(500).json({ error: 'Failed to load site dashboard' });
  }
});

// GET /api/admin/site-issues — actionable alerts for sites with problems
router.get('/site-issues', async (req: Request, res: Response) => {
  try {
    const showDismissed = req.query.showDismissed === 'true';

    const sites = await prisma.monitoredSite.findMany({
      where: { isEnabled: true, isPaused: false },
      select: {
        id: true,
        domain: true,
        url: true,
        adapterType: true,
        siteType: true,
        consecutiveFailures: true,
        hasWaf: true,
        hasCaptcha: true,
        hasRateLimit: true,
        requiresAuth: true,
        lastCrawlAt: true,
        avgResponseTimeMs: true,
        notes: true,
        _count: { select: { products: true } },
        crawlEvents: {
          orderBy: { crawledAt: 'desc' },
          take: 5,
          select: { status: true, errorMessage: true, crawledAt: true },
        },
      },
      orderBy: { domain: 'asc' },
    });

    // Load dismissed issues
    const dismissed = await prisma.dismissedIssue.findMany();
    const dismissedMap = new Map(dismissed.map(d => [`${d.siteId}:${d.issueType}`, d]));

    // Count active searches per site for "no_active_searches" detection
    const searchCounts = await prisma.search.groupBy({
      by: ['websiteUrl'],
      where: { isActive: true },
      _count: true,
    });
    const searchCountMap = new Map<string, number>();
    for (const sc of searchCounts) {
      try {
        const hostname = new URL(sc.websiteUrl).hostname.replace(/^www\./, '');
        searchCountMap.set(hostname, (searchCountMap.get(hostname) || 0) + sc._count);
      } catch {}
    }

    interface SiteIssue {
      id: string;
      domain: string;
      severity: 'critical' | 'warning' | 'info';
      issueType: string;
      issue: string;
      detail: string;
      suggestion: string;
      issueKey: string;
      isDismissed: boolean;
    }

    const issues: SiteIssue[] = [];

    function addIssue(
      siteId: string, domain: string, severity: 'critical' | 'warning' | 'info',
      issueType: string, issue: string, detail: string, suggestion: string,
      conditionSnapshot?: string,
    ) {
      const issueKey = `${siteId}:${issueType}`;
      const dismissal = dismissedMap.get(issueKey);
      let isDismissed = false;

      if (dismissal) {
        // Check staleness: if condition worsened significantly, void the dismissal
        if (conditionSnapshot && dismissal.conditionSnapshot &&
            conditionSnapshot !== dismissal.conditionSnapshot) {
          isDismissed = false; // Condition changed — re-surface
        } else {
          isDismissed = true;
        }
      }

      if (!isDismissed || showDismissed) {
        issues.push({ id: siteId, domain, severity, issueType, issue, detail, suggestion, issueKey, isDismissed });
      }
    }

    for (const site of sites) {
      const activeSearches = searchCountMap.get(site.domain) || 0;

      // Critical: 5+ consecutive failures
      if (site.consecutiveFailures >= 5) {
        addIssue(site.id, site.domain, 'critical', 'consecutive_failures',
          'Repeated crawl failures', `${site.consecutiveFailures} consecutive failures`,
          'Check if site is down or blocking. Consider pausing until resolved.',
          `failures:${site.consecutiveFailures}`);
      } else if (site.consecutiveFailures >= 3) {
        addIssue(site.id, site.domain, 'warning', 'multiple_failures',
          'Multiple crawl failures', `${site.consecutiveFailures} consecutive failures`,
          'Monitor closely. Circuit breaker may activate at 5 failures.',
          `failures:${site.consecutiveFailures}`);
      }

      // Warning: WAF/CAPTCHA detected
      if (site.hasWaf || site.hasCaptcha) {
        const blockers = [site.hasWaf && 'WAF', site.hasCaptcha && 'CAPTCHA'].filter(Boolean).join(', ');
        addIssue(site.id, site.domain, 'warning', 'waf_blocked',
          'Security block detected', `Detected: ${blockers}`,
          'Site uses Playwright bypass. Check if products are being indexed.');
      }

      // Warning: 0 products indexed despite being crawled
      if (site._count.products === 0 && site.lastCrawlAt) {
        const daysSinceCrawl = (Date.now() - site.lastCrawlAt.getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceCrawl < 7) {
          // Distinguish between adapter mismatch and general failure
          if (site.consecutiveFailures === 0) {
            addIssue(site.id, site.domain, 'warning', 'adapter_mismatch',
              'Adapter finds no products', 'Site reachable but 0 products extracted',
              'HTML selectors may be outdated. Check adapter compatibility.');
          } else {
            addIssue(site.id, site.domain, 'warning', 'no_products',
              'No products indexed', 'Crawled recently but 0 products in catalog',
              'API or HTML extraction may be failing. Check adapter compatibility.');
          }
        }
      }

      // Info: auth required
      if (site.requiresAuth) {
        addIssue(site.id, site.domain, 'info', 'auth_required',
          'Auth required', 'Site requires login credentials',
          'Configure SiteCredential or pause until auth is implemented.');
      }

      // Warning: SPA/headless site (limited scraping)
      if (site.notes && /\b(SPA|Headless|Wix|FastSimon)\b/i.test(site.notes)) {
        addIssue(site.id, site.domain, 'warning', 'spa_limited',
          'JS-heavy / SPA site', `${site.notes?.slice(0, 80)}`,
          'Client-side rendering limits scraping. Playwright may only partially work.');
      }

      // Info: very slow response time
      if (site.avgResponseTimeMs && site.avgResponseTimeMs > 15000) {
        addIssue(site.id, site.domain, 'info', 'slow_response',
          'Slow response time', `Average ${Math.round(site.avgResponseTimeMs / 1000)}s response time`,
          'High latency increases pressure and reduces capacity.');
      }

      // Warning: all recent crawls failed (but consecutive counter not yet 3)
      if (site.crawlEvents.length >= 3 && site.crawlEvents.every(e => e.status !== 'success')) {
        const lastError = site.crawlEvents[0]?.errorMessage || 'Unknown error';
        if (site.consecutiveFailures < 3) {
          addIssue(site.id, site.domain, 'warning', 'all_recent_failed',
            'All recent crawls failed', `Last error: ${lastError.slice(0, 100)}`,
            'Review crawl logs for this site.');
        }
      }

      // Info: no active searches targeting this site
      if (activeSearches === 0) {
        addIssue(site.id, site.domain, 'info', 'no_active_searches',
          'No active searches', 'No user alerts target this site',
          'Only watermark/catalog crawls run. Keyword search is skipped.');
      }

      // Info: never crawled
      if (!site.lastCrawlAt) {
        addIssue(site.id, site.domain, 'info', 'never_crawled',
          'Never crawled', 'Site has never been crawled',
          'May be newly added. Will be picked up on next scheduler tick.');
      }
    }

    // Sort: critical first, then warning, then info
    const severityOrder = { critical: 0, warning: 1, info: 2 };
    issues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    const activeIssues = issues.filter(i => !i.isDismissed);
    const dismissedIssues = issues.filter(i => i.isDismissed);

    return res.json({
      totalIssues: activeIssues.length,
      totalDismissed: dismissedIssues.length,
      critical: activeIssues.filter(i => i.severity === 'critical').length,
      warning: activeIssues.filter(i => i.severity === 'warning').length,
      info: activeIssues.filter(i => i.severity === 'info').length,
      issues,
    });
  } catch (err) {
    console.error('[Admin] Site issues error:', err);
    return res.status(500).json({ error: 'Failed to compute site issues' });
  }
});

// POST /api/admin/site-issues/dismiss — dismiss an issue
router.post('/site-issues/dismiss', async (req: Request, res: Response) => {
  try {
    const { siteId, issueType, conditionSnapshot } = req.body;
    if (!siteId || !issueType) {
      return res.status(400).json({ error: 'siteId and issueType are required' });
    }
    await prisma.dismissedIssue.upsert({
      where: { siteId_issueType: { siteId, issueType } },
      update: { dismissedAt: new Date(), conditionSnapshot: conditionSnapshot ?? null },
      create: { siteId, issueType, conditionSnapshot: conditionSnapshot ?? null },
    });
    return res.json({ success: true });
  } catch (err) {
    console.error('[Admin] Dismiss issue error:', err);
    return res.status(500).json({ error: 'Failed to dismiss issue' });
  }
});

// DELETE /api/admin/site-issues/dismiss — restore a dismissed issue
router.delete('/site-issues/dismiss', async (req: Request, res: Response) => {
  try {
    const { siteId, issueType } = req.body;
    if (!siteId || !issueType) {
      return res.status(400).json({ error: 'siteId and issueType are required' });
    }
    await prisma.dismissedIssue.deleteMany({
      where: { siteId, issueType },
    });
    return res.json({ success: true });
  } catch (err) {
    console.error('[Admin] Restore issue error:', err);
    return res.status(500).json({ error: 'Failed to restore issue' });
  }
});

// POST /api/admin/sites/:id/set-waf — quick toggle WAF flag
router.post('/sites/:id/set-waf', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { hasWaf } = req.body;
    if (typeof hasWaf !== 'boolean') {
      return res.status(400).json({ error: 'hasWaf must be a boolean' });
    }
    await prisma.monitoredSite.update({
      where: { id },
      data: { hasWaf },
    });
    return res.json({ success: true });
  } catch (err) {
    console.error('[Admin] Set WAF error:', err);
    return res.status(500).json({ error: 'Failed to update WAF flag' });
  }
});

// PATCH /api/admin/sites/:id/tuning — update per-site crawl tuning overrides
router.patch('/sites/:id/tuning', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    if (!updates || typeof updates !== 'object') {
      return res.status(400).json({ error: 'Request body must be a JSON object with tuning fields' });
    }

    // Merge with existing tuning (partial updates)
    const existing = await prisma.monitoredSite.findUnique({ where: { id }, select: { crawlTuning: true } });
    if (!existing) return res.status(404).json({ error: 'Site not found' });

    const merged = { ...(existing.crawlTuning as Record<string, unknown> ?? {}), ...updates };

    // Sync baseBudget column if included (backward compat)
    const data: Record<string, unknown> = { crawlTuning: merged };
    if (updates.baseBudget != null) {
      data.baseBudget = updates.baseBudget;
    }

    await prisma.monitoredSite.update({ where: { id }, data });

    // Recalculate priority with new tuning
    const { recalculateSitePriority } = await import('../services/priority-engine');
    await recalculateSitePriority(id);

    const updated = await prisma.monitoredSite.findUnique({ where: { id }, select: { crawlTuning: true, baseBudget: true, crawlIntervalMin: true, pressure: true, capacity: true } });
    return res.json({ success: true, ...updated });
  } catch (err: any) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Site not found' });
    console.error('[Admin] Tuning update error:', err);
    return res.status(500).json({ error: 'Failed to update tuning' });
  }
});

// DELETE /api/admin/sites/:id/tuning — reset all tuning to defaults
router.delete('/sites/:id/tuning', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    await prisma.monitoredSite.update({
      where: { id },
      data: { crawlTuning: Prisma.JsonNull, baseBudget: TUNING_DEFAULTS.baseBudget },
    });

    // Recalculate priority with defaults
    const { recalculateSitePriority } = await import('../services/priority-engine');
    await recalculateSitePriority(id);

    const updated = await prisma.monitoredSite.findUnique({ where: { id }, select: { crawlTuning: true, baseBudget: true, crawlIntervalMin: true, pressure: true, capacity: true } });
    return res.json({ success: true, ...updated });
  } catch (err: any) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Site not found' });
    console.error('[Admin] Tuning reset error:', err);
    return res.status(500).json({ error: 'Failed to reset tuning' });
  }
});

// GET /api/admin/tuning/defaults — return global default values for frontend display
router.get('/tuning/defaults', (_req: Request, res: Response) => {
  return res.json(TUNING_DEFAULTS);
});

// POST /api/admin/crawl-now — force immediate crawl of all enabled sites
router.post('/crawl-now', async (_req: Request, res: Response) => {
  try {
    // Set all enabled sites' nextCrawlAt to now so the scheduler picks them up immediately
    const result = await prisma.monitoredSite.updateMany({
      where: { isEnabled: true, crawlLock: null },
      data: { nextCrawlAt: new Date() },
    });

    // Trigger a scheduler tick immediately instead of waiting up to 2 minutes
    const { schedulerTick } = await import('../services/crawl-scheduler');
    await schedulerTick();

    return res.json({
      message: `Triggered crawl for ${result.count} sites`,
      sitesQueued: result.count,
    });
  } catch (err) {
    console.error('[Admin] Force crawl error:', err);
    return res.status(500).json({ error: 'Failed to trigger crawl' });
  }
});

export default router;
