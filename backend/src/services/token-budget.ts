/**
 * Token Budget System — per-site request budget with tier allocation.
 *
 * Each site has a base hourly budget (default 60 req/hr), scaled by capacity.
 * Tier 1 (new items) reserves a configurable % of the effective budget.
 * Remaining tokens (+ unused Tier 1 tokens) flow to catalog tiers (2-4).
 *
 * All percentages/shares are configurable per-site via CrawlTuning.
 * The min_gap ensures requests are evenly spaced within each hour.
 */

import { CrawlTuning, TUNING_DEFAULTS } from './crawl-tuning';

// ── Types ────────────────────────────────────────────────────────────────────

export interface TokenBudgetState {
  /** Effective tokens available this hour (base × capacity, floor 5) */
  effectiveBudget: number;
  /** Tokens consumed this hour across all tiers */
  tokensUsed: number;
  /** Tokens consumed by Tier 1 this hour */
  tier1Used: number;
  /** Hour window start (ms since epoch) */
  windowStart: number;
  /** Minimum seconds between requests to this site */
  minGapSeconds: number;
  /** Timestamp of last request to this site (ms since epoch) */
  lastRequestAt: number;
}

export interface TierAllocation {
  tier1: number;
  tier2: number;
  tier3: number;
  tier4: number;
}

// ── In-memory budget tracking ────────────────────────────────────────────────

const budgets = new Map<string, TokenBudgetState>();

const HOUR_MS = 60 * 60 * 1000;

// ── Budget Operations ────────────────────────────────────────────────────────

/**
 * Get or initialize the token budget for a site.
 */
export function getBudget(siteId: string, baseBudget: number, capacity: number): TokenBudgetState {
  const now = Date.now();
  let budget = budgets.get(siteId);

  // Reset if hour window expired
  if (!budget || now - budget.windowStart > HOUR_MS) {
    const effectiveBudget = Math.max(5, Math.floor(baseBudget * capacity));
    budget = {
      effectiveBudget,
      tokensUsed: 0,
      tier1Used: 0,
      windowStart: now,
      minGapSeconds: Math.round(3600 / effectiveBudget),
      lastRequestAt: 0,
    };
    budgets.set(siteId, budget);
  }

  return budget;
}

/**
 * Check if a request can be made right now (respects min_gap and budget).
 */
export function canRequest(siteId: string, baseBudget: number, capacity: number): boolean {
  const budget = getBudget(siteId, baseBudget, capacity);
  const now = Date.now();

  // Budget exhausted
  if (budget.tokensUsed >= budget.effectiveBudget) return false;

  // Min gap not elapsed
  if (budget.lastRequestAt > 0) {
    const elapsed = (now - budget.lastRequestAt) / 1000;
    if (elapsed < budget.minGapSeconds) return false;
  }

  return true;
}

/**
 * Consume a token for a given tier.
 */
export function consumeToken(siteId: string, tier: 1 | 2 | 3 | 4): void {
  const budget = budgets.get(siteId);
  if (!budget) return;

  budget.tokensUsed++;
  if (tier === 1) budget.tier1Used++;
  budget.lastRequestAt = Date.now();
}

/**
 * Get remaining tokens for Tier 1 this hour.
 */
export function getTier1Remaining(siteId: string, baseBudget: number, capacity: number, tuning?: CrawlTuning): number {
  const budget = getBudget(siteId, baseBudget, capacity);
  const reservePct = (tuning?.tier1ReservePct ?? TUNING_DEFAULTS.tier1ReservePct) / 100;
  const tier1Budget = Math.floor(budget.effectiveBudget * reservePct);
  return Math.max(0, tier1Budget - budget.tier1Used);
}

/**
 * Get remaining tokens for catalog tiers (2-4) this hour.
 * Includes unused Tier 1 tokens that flow downstream.
 */
export function getCatalogRemaining(siteId: string, baseBudget: number, capacity: number): number {
  const budget = getBudget(siteId, baseBudget, capacity);
  const totalRemaining = budget.effectiveBudget - budget.tokensUsed;
  return Math.max(0, totalRemaining);
}

/**
 * Compute token allocation for active catalog tiers.
 * Distributes remaining tokens based on per-site tuning shares.
 * Tier 2 gets the larger of its share or whatever remains after T3+T4.
 */
export function allocateCatalogTokens(
  siteId: string,
  baseBudget: number,
  capacity: number,
  activeTiers: { tier2: boolean; tier3: boolean; tier4: boolean },
  tuning?: CrawlTuning,
): TierAllocation {
  const t = tuning ?? TUNING_DEFAULTS;
  const reservePct = t.tier1ReservePct / 100;
  const t2Share = t.t2SharePct / 100;
  const t3Share = t.t3SharePct / 100;
  const t4Share = t.t4SharePct / 100;

  const budget = getBudget(siteId, baseBudget, capacity);
  const tier1Budget = Math.floor(budget.effectiveBudget * reservePct);
  const tier1Remaining = Math.max(0, tier1Budget - budget.tier1Used);

  // Catalog tiers get: base catalog allocation + unused Tier 1 overflow
  const catalogBase = budget.effectiveBudget - tier1Budget;
  const catalogTotal = Math.max(0, catalogBase + (tier1Budget - budget.tier1Used) - (budget.tokensUsed - budget.tier1Used));
  // Simplify: total remaining after Tier 1 usage
  const remaining = Math.max(0, budget.effectiveBudget - budget.tokensUsed);
  const catalogRemaining = Math.max(0, remaining - tier1Remaining);

  const allocation: TierAllocation = { tier1: tier1Remaining, tier2: 0, tier3: 0, tier4: 0 };

  if (catalogRemaining <= 0) return allocation;

  // Allocate Tier 3 and Tier 4 first by their shares
  if (activeTiers.tier3) {
    allocation.tier3 = Math.floor(catalogRemaining * t3Share);
  }
  if (activeTiers.tier4) {
    allocation.tier4 = Math.floor(catalogRemaining * t4Share);
  }

  // Tier 2 gets the larger of: its share, or whatever remains after T3+T4
  if (activeTiers.tier2) {
    const baseShare = Math.floor(catalogRemaining * t2Share);
    const afterT3T4 = catalogRemaining - allocation.tier3 - allocation.tier4;
    allocation.tier2 = Math.max(baseShare, afterT3T4);
  }

  return allocation;
}

/**
 * Get seconds until next request is allowed.
 */
export function secondsUntilNextRequest(siteId: string, baseBudget: number, capacity: number): number {
  const budget = getBudget(siteId, baseBudget, capacity);
  if (budget.tokensUsed >= budget.effectiveBudget) return Infinity;
  if (budget.lastRequestAt === 0) return 0;

  const elapsed = (Date.now() - budget.lastRequestAt) / 1000;
  return Math.max(0, budget.minGapSeconds - elapsed);
}

/**
 * Reset all budgets (used in testing or when restarting).
 */
export function resetAllBudgets(): void {
  budgets.clear();
}
