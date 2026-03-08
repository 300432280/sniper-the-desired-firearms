/**
 * Priority Engine v2 — Pressure/Capacity Model
 *
 * Replaces the old 11-multiplier interval formula with a continuous
 * pressure/capacity model. See RELEASE-PLAN Section 4 for full design.
 *
 * pressure = weighted average of failure signals from last 20 crawls
 * capacity = e^(-3 × pressure)  →  smooth 0.05-1.0 curve
 * interval = 60 / (base_rate × capacity)  →  Tier 1 new-items interval
 *
 * Token budget (Section 3) governs total throughput. This engine only
 * computes the Tier 1 crawl interval and the capacity factor.
 */

import { prisma } from '../lib/prisma';
import { resolveTuning } from './crawl-tuning';

// ── Types ────────────────────────────────────────────────────────────────────

export interface CrawlPriority {
  intervalMinutes: number;
  effectiveBudget: number;   // tokens/hour after capacity scaling
  minGapSeconds: number;     // minimum seconds between requests to this site
}

export type SiteCategory = 'retailer' | 'forum' | 'classified' | 'auction';

// ── Constants ────────────────────────────────────────────────────────────────

// Base rate = Tier 1 new-items crawls per hour by site category
const BASE_RATES: Record<SiteCategory, number> = {
  forum: 4,           // every 15 min
  classified: 4,      // every 15 min
  retailer: 2,        // every 30 min
  auction: 0.17,      // every ~6 hours
};

// Business hours in UTC (14-01 UTC = 9am-8pm EST)
// Crawl MORE during business hours to blend with real traffic
const BUSINESS_HOURS_UTC = [14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1];

const PRESSURE_WINDOW = 20; // Rolling window size for pressure computation

// ── Pressure Computation ─────────────────────────────────────────────────────

interface CrawlEventData {
  status: string;
  responseTimeMs: number | null;
  statusCode: number | null;
}

interface PressureOptions {
  /** WAF/Playwright sites have inherently higher latency — use a wider range */
  hasWaf?: boolean;
}

/**
 * Compute site pressure from rolling window of recent crawl events.
 *
 * pressure = 0.4 × failure_rate
 *          + 0.2 × block_rate
 *          + 0.2 × latency_score
 *          + 0.2 × extraction_failure_rate
 *
 * Returns value clamped to [0, 1].
 */
export function computePressure(events: CrawlEventData[], options?: PressureOptions): number {
  if (events.length === 0) return 0;

  const total = events.length;

  // failure_rate: HTTP errors (non-200 responses, timeouts)
  const failures = events.filter(e => e.status === 'fail' || e.status === 'timeout').length;
  const failureRate = failures / total;

  // block_rate: 429s, captchas, WAF blocks
  const blocks = events.filter(e =>
    e.status === 'blocked' || e.status === 'captcha' || e.statusCode === 429
  ).length;
  const blockRate = blocks / total;

  // latency_score: normalized 0-1
  // Standard sites: 500ms → 0, 10s → 1 (fast HTTP fetches)
  // WAF/Playwright sites: 5s → 0, 45s → 1 (Playwright overhead is normal)
  const responseTimes = events.map(e => e.responseTimeMs).filter((t): t is number => t != null);
  let latencyScore = 0;
  if (responseTimes.length > 0) {
    const avgMs = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
    if (options?.hasWaf) {
      latencyScore = Math.min(1, Math.max(0, (avgMs - 5000) / 40000));
    } else {
      latencyScore = Math.min(1, Math.max(0, (avgMs - 500) / 9500));
    }
  }

  // extraction_failure_rate: 200 OK but 0 products extracted (suspicious empty response)
  const extractionFailures = events.filter(e =>
    e.status === 'success' && e.statusCode === 200
  ).length === 0 ? 0 : events.filter(e =>
    // We don't have matchesFound in this interface — this maps to the 'success' status
    // with empty extraction. For now, use status signals only.
    // extraction failures show as status='fail' with a 200 statusCode
    e.status === 'fail' && e.statusCode != null && e.statusCode >= 200 && e.statusCode < 300
  ).length;
  const extractionFailureRate = extractionFailures / total;

  const pressure = 0.4 * failureRate
    + 0.2 * blockRate
    + 0.2 * latencyScore
    + 0.2 * extractionFailureRate;

  return Math.min(1, Math.max(0, pressure));
}

// ── Capacity Computation ─────────────────────────────────────────────────────

/**
 * Convert pressure to capacity using exponential decay.
 * capacity = e^(-3 × pressure)
 *
 * | Pressure | Capacity | Interpretation         |
 * |----------|----------|------------------------|
 * | 0.0      | 1.00     | Fully healthy          |
 * | 0.1      | 0.74     | Occasional hiccups     |
 * | 0.2      | 0.55     | Some resistance        |
 * | 0.3      | 0.41     | Moderate issues        |
 * | 0.5      | 0.22     | Significant pushback   |
 * | 0.7      | 0.12     | Heavy resistance       |
 * | 1.0      | 0.05     | Nearly blocked         |
 */
export function computeCapacity(pressure: number): number {
  return Math.exp(-3 * pressure);
}

// ── Crawl Priority Computation ───────────────────────────────────────────────

/**
 * Compute the Tier 1 crawl interval and token budget for a site.
 * Replaces the old 11-multiplier computeCrawlPriority().
 */
export function computeCrawlPriority(params: {
  siteCategory: SiteCategory;
  capacity: number;
  baseBudget: number;
  tier1IntervalMin?: number | null;
  hourUtc?: number;
}): CrawlPriority {
  const { siteCategory, capacity, baseBudget, tier1IntervalMin } = params;
  const hourUtc = params.hourUtc ?? new Date().getUTCHours();

  // Effective token budget: base × capacity, floor at 5
  const effectiveBudget = Math.max(5, Math.floor(baseBudget * capacity));
  const minGapSeconds = Math.round(3600 / effectiveBudget);

  // Per-site tier 1 interval override from crawlTuning
  if (tier1IntervalMin != null) {
    return { intervalMinutes: tier1IntervalMin, effectiveBudget, minGapSeconds };
  }

  // Base rate for this site type
  const baseRate = BASE_RATES[siteCategory] ?? BASE_RATES.retailer;

  // target_rate = base_rate × capacity
  const targetRate = baseRate * capacity;

  // interval = 60 / target_rate (minutes)
  let interval = targetRate > 0 ? 60 / targetRate : 1440;

  // Peak hour modulation: crawl more during business hours
  if (BUSINESS_HOURS_UTC.includes(hourUtc)) {
    interval *= 0.85;
  } else {
    interval *= 1.2;
  }

  // Clamp to [15 min, 1440 min (24 hours)]
  interval = Math.max(15, Math.min(1440, Math.round(interval)));

  return { intervalMinutes: interval, effectiveBudget, minGapSeconds };
}

// ── Site Priority Recalculation ──────────────────────────────────────────────

/**
 * Recalculate pressure, capacity, and interval for a single site.
 * Called after each crawl completes.
 */
export async function recalculateSitePriority(siteId: string): Promise<void> {
  const site = await prisma.monitoredSite.findUnique({ where: { id: siteId } });
  if (!site || !site.isEnabled) return;

  // Fetch last N crawl events for pressure computation
  const recentEvents = await prisma.crawlEvent.findMany({
    where: { siteId },
    orderBy: { crawledAt: 'desc' },
    take: PRESSURE_WINDOW,
    select: { status: true, responseTimeMs: true, statusCode: true },
  });

  // Compute pressure and capacity (WAF sites get wider latency tolerance)
  const pressure = computePressure(recentEvents, { hasWaf: site.hasWaf });
  const capacity = computeCapacity(pressure);

  // Compute interval and budget using per-site tuning
  const tuning = resolveTuning(site.crawlTuning);
  const siteCategory = (site.siteCategory || 'retailer') as SiteCategory;
  const priority = computeCrawlPriority({
    siteCategory,
    capacity,
    baseBudget: tuning.baseBudget,
    tier1IntervalMin: tuning.tier1IntervalMin,
  });

  const nextCrawlAt = new Date(Date.now() + priority.intervalMinutes * 60 * 1000);

  await prisma.monitoredSite.update({
    where: { id: siteId },
    data: {
      pressure,
      capacity,
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

