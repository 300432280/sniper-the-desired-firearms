import { prisma } from '../lib/prisma';

// ── Types ────────────────────────────────────────────────────────────────────

export interface CrawlPriority {
  intervalMinutes: number;
  delayBetweenRequestsMs: [number, number]; // [min, max] for random jitter
  maxPagesPerCrawl: number;
  preferApiOnly: boolean; // Difficult sites: skip HTML, API only
}

interface SiteMetrics {
  difficultyScore: number;
  trafficClass: string;
  consecutiveFailures: number;
  hasWaf: boolean;
  hasRateLimit: boolean;
  hasCaptcha: boolean;
  requiresAuth: boolean;
  requiresSucuri: boolean;
  overrideInterval: number | null;
  overrideDifficulty: number | null;
  overrideTrafficClass: string | null;
}

// ── Constants ────────────────────────────────────────────────────────────────

const BASE_INTERVAL_MIN = 120; // 2 hours default

// Traffic class hard floors — no site in this class crawls faster than this
const TRAFFIC_FLOORS: Record<string, number> = {
  tiny: 720,   // 12 hours minimum
  small: 240,  // 4 hours minimum
  medium: 60,  // 1 hour minimum
  large: 30,   // 30 minutes minimum
};

// Seasonal peak date ranges (month-day pairs, inclusive)
const SEASONAL_PEAKS = [
  { startMonth: 11, startDay: 15, endMonth: 12, endDay: 5 },  // Black Friday / Cyber Monday
  { startMonth: 12, endMonth: 12, startDay: 26, endDay: 28 }, // Boxing Day
];

// Peak hours in UTC (17-22 UTC = noon-5pm EST, when Canadian shoppers most active)
const PEAK_HOURS_UTC = [17, 18, 19, 20, 21, 22];

// ── Difficulty Scoring ───────────────────────────────────────────────────────

/**
 * Compute difficulty score (0-100) from measurable signals + crawl outcomes.
 * Higher = harder to scrape safely.
 *
 * @param recentCrawlStats - Optional stats from the last N crawl events:
 *   - zeroMatchStreak: consecutive "success" crawls with 0 matches found
 *   - usedPlaywright: whether the current crawl fell back to Playwright
 */
export function computeDifficulty(
  site: SiteMetrics,
  avgResponseTimeMs?: number | null,
  recentCrawlStats?: { zeroMatchStreak: number; usedPlaywright?: boolean },
): number {
  if (site.overrideDifficulty != null) return site.overrideDifficulty;

  let score = 0;

  // ── Detection-based signals ────────────────────────────────────────────
  if (site.requiresSucuri || site.hasWaf) score += 15;
  if (site.hasRateLimit) score += 20;
  if (site.hasCaptcha) score += 25;
  if (site.requiresAuth) score += 5;

  if (avgResponseTimeMs) {
    if (avgResponseTimeMs > 8000) score += 15;
    else if (avgResponseTimeMs > 5000) score += 10;
    else if (avgResponseTimeMs > 3000) score += 5;
  }

  if (site.consecutiveFailures >= 5) score += 20;
  else if (site.consecutiveFailures >= 3) score += 10;

  // ── Outcome-based signals ──────────────────────────────────────────────

  // Zero-match streak: site returns HTTP 200 but yields no products.
  // Strong indicator of stealth WAF blocks, wrong adapter, or broken extraction.
  // Escalates: 3+ crawls with 0 matches = +10, 5+ = +20, 8+ = +35
  if (recentCrawlStats) {
    const streak = recentCrawlStats.zeroMatchStreak;
    if (streak >= 8) score += 35;
    else if (streak >= 5) score += 20;
    else if (streak >= 3) score += 10;

    // Playwright fallback: site requires a headless browser (JS-rendered/SPA)
    if (recentCrawlStats.usedPlaywright) score += 10;
  }

  return Math.min(score, 100);
}

// ── Crawl Priority Computation ───────────────────────────────────────────────

/**
 * Compute the optimal crawl interval and behavior for a site.
 * Takes all factors into account: difficulty, traffic, failures, time, demand.
 */
export function computeCrawlPriority(params: {
  site: SiteMetrics;
  activeSearchCount: number;
  recentMatchYield: number; // avg matches per crawl over last 10 crawls
  hourUtc?: number;
}): CrawlPriority {
  const { site, activeSearchCount, recentMatchYield } = params;
  const hourUtc = params.hourUtc ?? new Date().getUTCHours();

  // Admin override takes absolute priority
  if (site.overrideInterval != null) {
    const difficulty = site.overrideDifficulty ?? site.difficultyScore;
    return {
      intervalMinutes: site.overrideInterval,
      ...getDifficultyBehavior(difficulty),
    };
  }

  const difficulty = site.overrideDifficulty ?? site.difficultyScore;
  const trafficClass = site.overrideTrafficClass ?? site.trafficClass;

  // ── Multipliers ──

  // Difficulty: 0→1x, 50→2x, 100→3x
  const difficultyMult = 1.0 + difficulty / 50;

  // Traffic class multiplier
  const trafficMult: Record<string, number> = { tiny: 4.0, small: 2.5, medium: 1.5, large: 1.0 };
  const tMult = trafficMult[trafficClass] ?? 1.5;

  // Consecutive failure backoff: exponential, capped at 8x
  const failureMult = Math.min(Math.pow(1.5, site.consecutiveFailures), 8.0);

  // WAF / rate limit / CAPTCHA multipliers
  const wafMult = site.hasWaf ? 1.3 : 1.0;
  const rateLimitMult = site.hasRateLimit ? 2.0 : 1.0;
  const captchaMult = site.hasCaptcha ? 3.0 : 1.0;

  // Peak hours: slower during site peak traffic
  const peakMult = PEAK_HOURS_UTC.includes(hourUtc) ? 1.3 : 1.0;

  // Seasonal events: slower during high-traffic retail periods
  const seasonMult = isSeasonalPeak() ? 1.5 : 1.0;

  // Demand bonus: more active searches = slightly faster (amortized value)
  const demandBonus = activeSearchCount > 5 ? 0.8 : activeSearchCount > 2 ? 0.9 : 1.0;

  // Yield bonus: high-yield sites get crawled slightly faster
  const yieldBonus = recentMatchYield > 5 ? 0.85 : 1.0;

  // ── Compute interval ──

  let interval = BASE_INTERVAL_MIN
    * difficultyMult
    * tMult
    * failureMult
    * wafMult
    * rateLimitMult
    * captchaMult
    * peakMult
    * seasonMult
    * demandBonus
    * yieldBonus;

  // Clamp to absolute bounds: 30 min floor, 24 hr ceiling
  interval = Math.max(30, Math.min(1440, Math.round(interval)));

  // Apply traffic class hard floor
  const trafficFloor = TRAFFIC_FLOORS[trafficClass] ?? 60;
  interval = Math.max(interval, trafficFloor);

  return {
    intervalMinutes: interval,
    ...getDifficultyBehavior(difficulty),
  };
}

// ── Difficulty-Based Behavior ────────────────────────────────────────────────

function getDifficultyBehavior(difficulty: number): Omit<CrawlPriority, 'intervalMinutes'> {
  if (difficulty > 60) {
    return {
      delayBetweenRequestsMs: [2500, 4000],
      maxPagesPerCrawl: 1,
      preferApiOnly: true,
    };
  }
  if (difficulty > 30) {
    return {
      delayBetweenRequestsMs: [1500, 3000],
      maxPagesPerCrawl: 2,
      preferApiOnly: false,
    };
  }
  return {
    delayBetweenRequestsMs: [1000, 2000],
    maxPagesPerCrawl: 3,
    preferApiOnly: false,
  };
}

// ── Seasonal Peak Detection ──────────────────────────────────────────────────

function isSeasonalPeak(): boolean {
  const now = new Date();
  const month = now.getMonth() + 1; // 1-indexed
  const day = now.getDate();

  for (const peak of SEASONAL_PEAKS) {
    if (month >= peak.startMonth && month <= peak.endMonth) {
      if (month === peak.startMonth && day < peak.startDay) continue;
      if (month === peak.endMonth && day > peak.endDay) continue;
      return true;
    }
  }
  return false;
}

// ── Site Priority Recalculation ──────────────────────────────────────────────

/**
 * Recalculate priority for a single site and update its crawlIntervalMin + nextCrawlAt.
 * Called after each crawl completes.
 */
export async function recalculateSitePriority(siteId: string): Promise<void> {
  const site = await prisma.monitoredSite.findUnique({ where: { id: siteId } });
  if (!site || !site.isEnabled) return;

  // Count active searches targeting this site
  const activeSearchCount = await prisma.search.count({
    where: { websiteUrl: { contains: site.domain }, isActive: true },
  });

  // Compute recent match yield (avg matches over last 10 crawls)
  const recentCrawls = await prisma.crawlEvent.findMany({
    where: { siteId, status: 'success' },
    orderBy: { crawledAt: 'desc' },
    take: 10,
    select: { matchesFound: true },
  });
  const recentMatchYield = recentCrawls.length > 0
    ? recentCrawls.reduce((sum, c) => sum + c.matchesFound, 0) / recentCrawls.length
    : 0;

  const priority = computeCrawlPriority({
    site: {
      difficultyScore: site.difficultyScore,
      trafficClass: site.trafficClass,
      consecutiveFailures: site.consecutiveFailures,
      hasWaf: site.hasWaf,
      hasRateLimit: site.hasRateLimit,
      hasCaptcha: site.hasCaptcha,
      requiresAuth: site.requiresAuth,
      requiresSucuri: site.requiresSucuri,
      overrideInterval: site.overrideInterval,
      overrideDifficulty: site.overrideDifficulty,
      overrideTrafficClass: site.overrideTrafficClass,
    },
    activeSearchCount,
    recentMatchYield,
  });

  const nextCrawlAt = new Date(Date.now() + priority.intervalMinutes * 60 * 1000);

  await prisma.monitoredSite.update({
    where: { id: siteId },
    data: {
      crawlIntervalMin: priority.intervalMinutes,
      nextCrawlAt,
    },
  });
}

/**
 * Recalculate priority for ALL enabled sites.
 * Used during initial setup or after configuration changes.
 */
export async function recalculateAllPriorities(): Promise<void> {
  const sites = await prisma.monitoredSite.findMany({
    where: { isEnabled: true },
    select: { id: true },
  });

  for (const site of sites) {
    await recalculateSitePriority(site.id);
  }
}
