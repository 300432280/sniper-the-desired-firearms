/**
 * Token Budget System — per-site request budget with tier allocation.
 *
 * Each site has a base hourly budget (default 60 req/hr), scaled by capacity.
 * Tier 1 (new items) reserves 70% of the effective budget.
 * Remaining 30% (+ unused Tier 1 tokens) flows to catalog tiers (2-4).
 *
 * The min_gap ensures requests are evenly spaced within each hour.
 */

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

const TIER1_RESERVATION = 0.70;
const HOUR_MS = 60 * 60 * 1000;

// Catalog tier shares of remaining budget (after Tier 1)
const CATALOG_SHARES = { tier2: 0.35, tier3: 0.35, tier4: 0.30 };

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
export function getTier1Remaining(siteId: string, baseBudget: number, capacity: number): number {
  const budget = getBudget(siteId, baseBudget, capacity);
  const tier1Budget = Math.floor(budget.effectiveBudget * TIER1_RESERVATION);
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
 * Distributes remaining tokens proportionally based on which tiers are active.
 */
export function allocateCatalogTokens(
  siteId: string,
  baseBudget: number,
  capacity: number,
  activeTiers: { tier2: boolean; tier3: boolean; tier4: boolean },
): TierAllocation {
  const budget = getBudget(siteId, baseBudget, capacity);
  const tier1Budget = Math.floor(budget.effectiveBudget * TIER1_RESERVATION);
  const tier1Remaining = Math.max(0, tier1Budget - budget.tier1Used);

  // Catalog tiers get: base catalog allocation + unused Tier 1 overflow
  const catalogBase = budget.effectiveBudget - tier1Budget;
  const catalogTotal = Math.max(0, catalogBase + (tier1Budget - budget.tier1Used) - (budget.tokensUsed - budget.tier1Used));
  // Simplify: total remaining after Tier 1 usage
  const remaining = Math.max(0, budget.effectiveBudget - budget.tokensUsed);
  const catalogRemaining = Math.max(0, remaining - tier1Remaining);

  // Count active tiers and their shares
  const active: Array<{ key: 'tier2' | 'tier3' | 'tier4'; share: number }> = [];
  if (activeTiers.tier2) active.push({ key: 'tier2', share: CATALOG_SHARES.tier2 });
  if (activeTiers.tier3) active.push({ key: 'tier3', share: CATALOG_SHARES.tier3 });
  if (activeTiers.tier4) active.push({ key: 'tier4', share: CATALOG_SHARES.tier4 });

  const allocation: TierAllocation = { tier1: tier1Remaining, tier2: 0, tier3: 0, tier4: 0 };

  if (active.length === 0 || catalogRemaining <= 0) return allocation;

  const totalShare = active.reduce((sum, t) => sum + t.share, 0);
  for (const t of active) {
    allocation[t.key] = Math.floor(catalogRemaining * (t.share / totalShare));
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
