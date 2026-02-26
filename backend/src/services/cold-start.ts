/**
 * Cold Start — determines crawl budget for newly added sites.
 *
 * Phase 1 — Probe (Hours 0-6):  10 req/hr, Tier 1 only
 * Phase 2 — Ramp  (Hours 6-48): min(BASE_BUDGET, 10 + hours×2), all tiers
 * Phase 3 — Steady (Hour 48+):  Full BASE_BUDGET, normal operation
 */

export type ColdStartPhase = 'probe' | 'ramp' | 'steady';

export interface ColdStartStatus {
  phase: ColdStartPhase;
  hoursSinceAdded: number;
  /** Effective budget cap for this phase (before capacity scaling) */
  budgetCap: number;
  /** Whether catalog tiers (2-4) are allowed */
  catalogAllowed: boolean;
}

const PROBE_HOURS = 6;
const STEADY_HOURS = 48;
const PROBE_BUDGET = 10;
const RAMP_BASE = 10;
const RAMP_INCREMENT = 2; // +2 req/hr per hour

/**
 * Determine the cold start phase and budget cap for a site.
 */
export function getColdStartStatus(
  addedAt: Date,
  baseBudget: number,
  coldStartOverride: boolean,
): ColdStartStatus {
  // Admin override skips cold start entirely
  if (coldStartOverride) {
    return { phase: 'steady', hoursSinceAdded: Infinity, budgetCap: baseBudget, catalogAllowed: true };
  }

  const hoursSinceAdded = (Date.now() - addedAt.getTime()) / (60 * 60 * 1000);

  if (hoursSinceAdded < PROBE_HOURS) {
    return {
      phase: 'probe',
      hoursSinceAdded,
      budgetCap: PROBE_BUDGET,
      catalogAllowed: false,
    };
  }

  if (hoursSinceAdded < STEADY_HOURS) {
    const rampBudget = Math.min(baseBudget, RAMP_BASE + Math.floor(hoursSinceAdded) * RAMP_INCREMENT);
    return {
      phase: 'ramp',
      hoursSinceAdded,
      budgetCap: rampBudget,
      catalogAllowed: true,
    };
  }

  return {
    phase: 'steady',
    hoursSinceAdded,
    budgetCap: baseBudget,
    catalogAllowed: true,
  };
}

/**
 * Get the effective budget for a site, applying cold start cap before capacity scaling.
 * Usage: effectiveBudget = max(5, floor(getColdStartBudget(...) × capacity))
 */
export function getColdStartBudget(
  addedAt: Date,
  baseBudget: number,
  coldStartOverride: boolean,
): number {
  const status = getColdStartStatus(addedAt, baseBudget, coldStartOverride);
  return status.budgetCap;
}
