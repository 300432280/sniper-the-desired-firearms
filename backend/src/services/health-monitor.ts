/**
 * Health Monitor — daily connectivity + siteProfile verification for all monitored sites.
 *
 * Two complementary daily checks (both run in the HealthWorker cron):
 *
 * 1. runHealthChecks() — connectivity + light scrape test
 *    - Fetch homepage, verify page structure, record SiteHealthCheck
 *
 * 2. verifyAllSiteProfiles() — siteProfile watchdog
 *    - Verify catalogUrls, pagination, sort, count, WAF against live site
 *    - Record SiteHealthCheck, detect 3-consecutive-fail drift
 *    - Read-only on MonitoredSite; only writes to SiteHealthCheck
 */

import { prisma } from '../lib/prisma';
import { randomDelay } from './scraper/http-client';
import { detectSiteType } from './scraper/utils/html';
import * as cheerio from 'cheerio';

// WAF-aware fetch primitive (cached-cookies → Playwright for hasWaf sites,
// axios otherwise) — the SAME path the crawler/verifier use. Plain
// http-client.fetchPage does NOT route WAF sites through Playwright, which
// caused WAF-protected maintain sites (leverarms, precisionoptics,
// triggersandbows, westernmetal) to be marked unreachable here even though
// production crawls reach them fine. Dynamic require mirrors the existing
// verifyAllSiteProfiles() pattern (scripts/ lives outside src/ rootDir).
type WafAwareFetch = (
  url: string,
  opts: { timeoutMs?: number; hasWaf?: boolean; wafType?: string | null },
) => Promise<{ status: number; body: string }>;
function getWafAwareFetch(): WafAwareFetch {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../../scripts/probe/shared/fetch').fetchUrl as WafAwareFetch;
}

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
  hasWaf?: boolean;
  wafType?: string | null;
}): Promise<HealthCheckResult> {
  const start = Date.now();

  try {
    // Use the WAF-aware fetch so WAF sites get the cached-cookies → Playwright
    // path the crawler uses, instead of a plain HTTP GET the WAF blocks.
    const fetchUrl = getWafAwareFetch();
    const fetched = await fetchUrl(site.url, {
      timeoutMs: 30000,
      hasWaf: site.hasWaf,
      wafType: site.wafType ?? null,
    });
    const responseTimeMs = Date.now() - start;

    // A WAF/error status with no usable body means the probe was blocked.
    if (fetched.status >= 400) {
      return {
        siteId: site.id,
        domain: site.domain,
        isReachable: fetched.status >= 500 ? false : true,
        canScrape: false,
        responseTimeMs,
        errorMessage: `HTTP ${fetched.status}`,
      };
    }

    const html = fetched.body;

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
    select: { id: true, domain: true, url: true, siteType: true, hasWaf: true, siteProfile: true },
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
        const wafType = (site.siteProfile as { wafType?: string | null } | null)?.wafType ?? null;
        return checkSite({ ...site, wafType });
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
        checkType: 'connectivity',
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

// ─── Site Profile Watchdog ──────────────────────────────────────────────────

// Types mirrored from scripts/verify-site-profile.ts to avoid rootDir import issues
type Verdict = 'PASS' | 'WARN' | 'FAIL';

interface ParameterCheck {
  name: string;
  verdict: Verdict;
  expected: unknown;
  actual: unknown;
  evidence: Record<string, unknown>;
  reason?: string;
}

interface VerificationResult {
  siteId: string;
  domain: string;
  timestamp: string;
  durationMs: number;
  overallVerdict: Verdict;
  checks: ParameterCheck[];
  rawSiteProfile: unknown;
}

export interface WatchdogResult {
  siteId: string;
  domain: string;
  verification: VerificationResult;
  consecutiveFailCount: number;
  shouldAlert: boolean;
}

/**
 * Watchdog: verify all enabled site profiles against live sites.
 *
 * For each enabled site with a siteProfile:
 *   1. Run verifySiteProfile() to test catalogUrls, pagination, sort, count, WAF
 *   2. Persist result as a SiteHealthCheck row
 *   3. Check last 3 SiteHealthCheck rows for consecutive failures
 *   4. If 3+ consecutive failures: surface alert via DismissedIssue mechanism
 *
 * This is READ-ONLY on MonitoredSite — only writes to SiteHealthCheck.
 * Sequential with 2s anti-ban delay between sites.
 */
export async function verifyAllSiteProfiles(): Promise<WatchdogResult[]> {
  // Dynamic require to avoid rootDir issues (scripts/ is outside src/)
  const { verifySiteProfile } = require('../../scripts/verify-site-profile') as {
    verifySiteProfile: (site: { id: string; domain: string; url: string; siteProfile: unknown; hasWaf?: boolean }) => Promise<VerificationResult>;
  };

  const sites = await prisma.monitoredSite.findMany({
    where: { isEnabled: true },
    select: { id: true, domain: true, url: true, siteProfile: true, hasWaf: true },
  });

  console.log(`[Watchdog] Starting siteProfile verification for ${sites.length} enabled sites...`);

  const results: WatchdogResult[] = [];

  for (const site of sites) {
    if (!site.siteProfile) continue; // sites without profile: skip (handled by onboarding flow)

    let verification: VerificationResult;
    try {
      verification = await verifySiteProfile({
        id: site.id,
        domain: site.domain,
        url: site.url,
        siteProfile: site.siteProfile,
        hasWaf: site.hasWaf,
      });
    } catch (err) {
      // Hard error — record as failure
      verification = {
        siteId: site.id,
        domain: site.domain,
        timestamp: new Date().toISOString(),
        durationMs: 0,
        overallVerdict: 'FAIL',
        checks: [],
        rawSiteProfile: site.siteProfile,
      };
      console.error(`[Watchdog] Error verifying ${site.domain}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Persist to SiteHealthCheck
    await prisma.siteHealthCheck.create({
      data: {
        siteId: site.id,
        checkType: 'watchdog',
        // 2026-06-08 mapping fix: stop the watchdog crying wolf on healthy sites.
        // isReachable = did the verifier actually reach the site (produced any checks). A data-drift
        // FAIL (e.g. expectedProductCount probe mismatch) must NOT mark a site that crawls fine "unreachable";
        // only a hard error (catch -> checks=[]) is truly unreachable.
        // canScrape = PASS or WARN. WARN (honored-default sort, sub-category tile pages, non-URL API sort
        // descriptors) is a HEALTHY state, not a scrape failure; only a real FAIL flips canScrape, so benign
        // WARNs no longer trip siteprofile_drift_3strikes (which keys on canScrape).
        isReachable: verification.checks.length > 0,
        canScrape: verification.overallVerdict !== 'FAIL',
        responseTimeMs: verification.durationMs,
        errorMessage: verification.overallVerdict === 'PASS'
          ? null
          : JSON.stringify(verification.checks.filter(c => c.verdict !== 'PASS').map(c => ({ name: c.name, verdict: c.verdict, reason: c.reason }))),
      },
    });

    // Count consecutive failures from the last 3 watchdog checks (ignoring connectivity rows)
    const recent = await prisma.siteHealthCheck.findMany({
      where: { siteId: site.id, checkType: 'watchdog' },
      orderBy: { checkedAt: 'desc' },
      take: 3,
    });
    const firstPassIdx = recent.findIndex(r => r.canScrape);
    const consecutiveFailCount = firstPassIdx === -1
      ? recent.length
      : firstPassIdx;

    const shouldAlert = consecutiveFailCount >= 3;

    if (shouldAlert) {
      // Alert logged here; surfaces in admin UI via /api/admin/site-issues
      // endpoint which detects siteprofile_drift_3strikes from SiteHealthCheck data.
      // DismissedIssue table handles user dismissals with conditionSnapshot re-surface.
      console.warn(`[Watchdog] ALERT: ${site.domain} — 3 consecutive siteProfile verification failures. Suggest: re-run /pre-bootstrap on ${site.domain} (or load skill via Skill tool: pre-bootstrap)`);
    }

    const icon = verification.overallVerdict === 'PASS' ? 'PASS' : verification.overallVerdict === 'WARN' ? 'WARN' : 'FAIL';
    console.log(`[Watchdog] ${icon}: ${site.domain} (${verification.durationMs}ms, consecutive fails: ${consecutiveFailCount})`);

    results.push({ siteId: site.id, domain: site.domain, verification, consecutiveFailCount, shouldAlert });

    // Anti-ban delay between sites
    await new Promise(r => setTimeout(r, 2000));
  }

  const alertCount = results.filter(r => r.shouldAlert).length;
  console.log(`[Watchdog] Complete: ${results.length} sites verified, ${alertCount} alerts triggered`);

  return results;
}
