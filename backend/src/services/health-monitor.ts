/**
 * Health Monitor — daily connectivity + light scrape test for all monitored sites.
 *
 * For each enabled MonitoredSite:
 *   1. Fetch the homepage (connectivity test, measures response time)
 *   2. Verify the page contains expected structure (scrape test)
 *   3. Record results in SiteHealthCheck table
 *   4. Alert admin if a site is unreachable or structure changed
 */

import { prisma } from '../lib/prisma';
import { fetchPage, randomDelay } from './scraper/http-client';
import { detectSiteType } from './scraper/utils/html';
import * as cheerio from 'cheerio';

interface HealthCheckResult {
  siteId: string;
  domain: string;
  isReachable: boolean;
  canScrape: boolean;
  responseTimeMs: number | null;
  errorMessage: string | null;
}

/**
 * Run health check for a single site.
 */
async function checkSite(site: {
  id: string;
  domain: string;
  url: string;
  siteType: string;
}): Promise<HealthCheckResult> {
  const start = Date.now();

  try {
    const html = await fetchPage(site.url);
    const responseTimeMs = Date.now() - start;

    if (!html || html.length < 100) {
      return {
        siteId: site.id,
        domain: site.domain,
        isReachable: true,
        canScrape: false,
        responseTimeMs,
        errorMessage: 'Page returned empty or very short content',
      };
    }

    // Light scrape test: verify the page has expected structure
    const $ = cheerio.load(html);
    const detectedType = detectSiteType(site.url, $);

    // Check for basic page structure
    const hasLinks = $('a[href]').length > 5;
    const hasContent = $('body').text().trim().length > 200;
    const hasNav = $('nav, header, [class*="menu"], [class*="nav"]').length > 0;

    // Check for expected content markers based on site type
    let canScrape = hasLinks && hasContent;
    let errorMessage: string | null = null;

    if (site.siteType === 'retailer') {
      const hasProducts = $(
        '[data-product-id], [class*="product"], [class*="item-card"], [class*="collection"]'
      ).length > 0 || html.includes('Shopify') || html.includes('WooCommerce');
      if (!hasProducts && !hasNav) {
        canScrape = false;
        errorMessage = 'No product elements or navigation found — site structure may have changed';
      }
    } else if (site.siteType === 'forum') {
      const hasForum = $(
        '[data-xf-init], [class*="threadbit"], [class*="structItem"], [class*="phpbb"]'
      ).length > 0 || html.includes('XenForo') || html.includes('vBulletin');
      if (!hasForum) {
        // Forum might just need auth
        const hasLoginForm = $('input[type="password"]').length > 0;
        if (hasLoginForm) {
          canScrape = true; // login page is expected
        } else {
          canScrape = false;
          errorMessage = 'No forum structure detected';
        }
      }
    } else if (site.siteType === 'auction') {
      const hasAuction = $(
        '[class*="lot"], [class*="auction"], [class*="catalog"], [class*="bid"]'
      ).length > 0;
      if (!hasAuction && hasNav) {
        // Auction sites often show category pages, not lots
        canScrape = true;
      }
    }

    // Check for common error pages
    const bodyText = $('body').text().toLowerCase();
    if (
      bodyText.includes('access denied') ||
      bodyText.includes('403 forbidden') ||
      bodyText.includes('site under maintenance') ||
      bodyText.includes('coming soon')
    ) {
      canScrape = false;
      errorMessage = 'Site returned access denied or maintenance page';
    }

    return {
      siteId: site.id,
      domain: site.domain,
      isReachable: true,
      canScrape,
      responseTimeMs,
      errorMessage,
    };
  } catch (err) {
    const responseTimeMs = Date.now() - start;
    return {
      siteId: site.id,
      domain: site.domain,
      isReachable: false,
      canScrape: false,
      responseTimeMs: responseTimeMs > 0 ? responseTimeMs : null,
      errorMessage: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

/**
 * Run health checks for all enabled monitored sites.
 * Returns summary stats.
 */
export async function runHealthChecks(): Promise<{
  total: number;
  reachable: number;
  canScrape: number;
  failed: HealthCheckResult[];
}> {
  const sites = await prisma.monitoredSite.findMany({
    where: { isEnabled: true },
    select: { id: true, domain: true, url: true, siteType: true },
  });

  console.log(`[HealthMonitor] Starting health checks for ${sites.length} sites...`);

  const results: HealthCheckResult[] = [];
  const BATCH_SIZE = 5;

  // Process in batches to avoid overwhelming the network
  for (let i = 0; i < sites.length; i += BATCH_SIZE) {
    const batch = sites.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (site) => {
        await randomDelay(200, 600); // stagger within batch
        return checkSite(site);
      })
    );
    results.push(...batchResults);

    const done = Math.min(i + BATCH_SIZE, sites.length);
    console.log(`[HealthMonitor] Progress: ${done}/${sites.length}`);

    // Brief pause between batches
    if (i + BATCH_SIZE < sites.length) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // Persist results
  for (const result of results) {
    await prisma.siteHealthCheck.create({
      data: {
        siteId: result.siteId,
        isReachable: result.isReachable,
        canScrape: result.canScrape,
        responseTimeMs: result.responseTimeMs,
        errorMessage: result.errorMessage,
      },
    });
  }

  const reachable = results.filter((r) => r.isReachable).length;
  const canScrape = results.filter((r) => r.canScrape).length;
  const failed = results.filter((r) => !r.isReachable || !r.canScrape);

  console.log(`[HealthMonitor] Complete: ${reachable}/${results.length} reachable, ${canScrape}/${results.length} scrapable, ${failed.length} failed`);

  // Log failures
  for (const f of failed) {
    console.log(`[HealthMonitor] FAIL: ${f.domain} — reachable=${f.isReachable}, canScrape=${f.canScrape}, error=${f.errorMessage}`);
  }

  return { total: results.length, reachable, canScrape, failed };
}

/**
 * Get the latest health status for all sites (for admin dashboard).
 */
export async function getHealthSummary(): Promise<{
  sites: Array<{
    id: string;
    domain: string;
    name: string;
    siteType: string;
    isEnabled: boolean;
    lastCheck: {
      isReachable: boolean;
      canScrape: boolean;
      responseTimeMs: number | null;
      errorMessage: string | null;
      checkedAt: Date;
    } | null;
  }>;
}> {
  const sites = await prisma.monitoredSite.findMany({
    include: {
      healthChecks: {
        orderBy: { checkedAt: 'desc' },
        take: 1,
      },
    },
    orderBy: { domain: 'asc' },
  });

  return {
    sites: sites.map((site) => ({
      id: site.id,
      domain: site.domain,
      name: site.name,
      siteType: site.siteType,
      isEnabled: site.isEnabled,
      lastCheck: site.healthChecks[0]
        ? {
            isReachable: site.healthChecks[0].isReachable,
            canScrape: site.healthChecks[0].canScrape,
            responseTimeMs: site.healthChecks[0].responseTimeMs,
            errorMessage: site.healthChecks[0].errorMessage,
            checkedAt: site.healthChecks[0].checkedAt,
          }
        : null,
    })),
  };
}

/**
 * Clean up old health check records (keep last 30 days).
 */
export async function pruneOldHealthChecks(): Promise<number> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const result = await prisma.siteHealthCheck.deleteMany({
    where: { checkedAt: { lt: cutoff } },
  });
  return result.count;
}
