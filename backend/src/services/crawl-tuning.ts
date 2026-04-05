/**
 * Crawl Tuning — per-site overrides for token budget and tier intervals.
 *
 * Each site can store a partial JSON in `crawlTuning`. Missing fields
 * fall back to TUNING_DEFAULTS. The `resolveTuning()` function merges
 * site overrides over defaults.
 */

export const TUNING_DEFAULTS = {
  baseBudget: 60,                   // Tokens per hour
  tier1IntervalMin: null as number | null,  // null = computed from BASE_RATES × capacity
  tier1ReservePct: 70,              // % of effective budget reserved for Tier 1

  // T2-T4 budget shares (maintain phase: DB verification; bootstrap phase: listing crawl)
  // T2 gets remainder tokens that can't be evenly divided
  t2SharePct: 42.5,                 // Tier 2 share of catalog tokens (recent: 1-7 days)
  t3SharePct: 32.5,                 // Tier 3 share of catalog tokens (aging: 8-20 days)
  t4SharePct: 25,                   // Tier 4 share of catalog tokens (archive: 21+ days)

  // Maintain-phase tier product-age windows (days since firstSeenAt)
  // Products are partitioned by how old they are, NOT by when last verified.
  // Within each tier, products are verified in staleVerifiedAt ASC order (oldest verification first).
  maintainT2MinDays: 0,             // T2 checks products first seen 0-7 days ago (new listings)
  maintainT2MaxDays: 7,
  maintainT3MinDays: 7,             // T3 checks products first seen 7-20 days ago (contiguous with T2)
  maintainT3MaxDays: 20,
  maintainT4MinDays: 20,            // T4 checks products first seen 20+ days ago (contiguous with T3)
  maintainT4MaxDays: null as number | null, // No upper limit

  // Maintain-phase cooldowns (hours between full verification cycles per tier)
  // Prevents hammering small sites. If cycle not complete before cooldown ends, continue where left off.
  maintainT2CooldownHrs: 3,
  maintainT3CooldownHrs: 5,
  maintainT4CooldownHrs: 9,

  // Watermark (T1) tuning
  wmKnownThreshold: 40,            // Consecutive already-seen products before Tier 1 stops
  wmOldDateThreshold: 25,          // Consecutive listings older than watermark date before stopping

  // Error threshold for product verification
  maxVerifyErrors: 5,              // After N consecutive errors, mark product as deleted
};

export type CrawlTuning = typeof TUNING_DEFAULTS;

/**
 * Merge site-specific crawlTuning JSON over global defaults.
 * Unknown keys are ignored. Missing or null fields use defaults.
 */
export function resolveTuning(raw: unknown): CrawlTuning {
  const result = { ...TUNING_DEFAULTS };
  if (!raw || typeof raw !== 'object') return result;

  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(TUNING_DEFAULTS) as Array<keyof CrawlTuning>) {
    if (key in obj && obj[key] != null) {
      (result as any)[key] = obj[key];
    }
  }

  return result;
}
