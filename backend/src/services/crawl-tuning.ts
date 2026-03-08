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
  t2CooldownHrs: 5,                // Hours between Tier 2 cycle starts
  t3CooldownHrs: 9,                // Hours between Tier 3 cycle starts
  t4CooldownHrs: 17,               // Hours between Tier 4 cycle starts
  t2SharePct: 35,                   // Tier 2 share of catalog tokens
  t3SharePct: 35,                   // Tier 3 share of catalog tokens
  t4SharePct: 30,                   // Tier 4 share of catalog tokens
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
