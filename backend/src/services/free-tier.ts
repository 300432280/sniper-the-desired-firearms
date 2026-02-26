/**
 * FREE Tier Lifecycle — 14-day alert expiry and 3-alert cap.
 *
 * - FREE users can have up to 3 active alerts at any time
 * - Each alert auto-expires 14 days after creation
 * - "Search All Sites" counts as 1 alert toward the 3-alert limit
 * - After expiry: alert becomes inactive, no new notifications
 * - User can recreate the same keyword alert (resets 14-day clock)
 */

import { prisma } from '../lib/prisma';
import { pushEvent } from './debugLog';

const FREE_ALERT_LIMIT = 3;
const FREE_ALERT_DURATION_DAYS = 14;

// ── Alert Expiry ────────────────────────────────────────────────────────────

/**
 * Expire FREE user alerts that have passed their 14-day window.
 * Called by a daily cron job.
 */
export async function expireFreeAlerts(): Promise<{ expired: number }> {
  const now = new Date();

  // Find active searches from FREE users that have expiresAt in the past
  const expiredSearches = await prisma.search.findMany({
    where: {
      isActive: true,
      expiresAt: { lt: now },
      user: { tier: 'FREE' },
    },
    select: { id: true, keyword: true, userId: true },
  });

  if (expiredSearches.length === 0) return { expired: 0 };

  // Deactivate all expired searches
  await prisma.search.updateMany({
    where: { id: { in: expiredSearches.map(s => s.id) } },
    data: { isActive: false },
  });

  console.log(`[FreeTier] Expired ${expiredSearches.length} FREE user alerts`);
  pushEvent({
    type: 'info',
    message: `FREE tier: expired ${expiredSearches.length} alerts past 14-day window`,
  });

  return { expired: expiredSearches.length };
}

/**
 * Set expiresAt on a newly created FREE user search.
 * Called during search creation.
 */
export function computeExpiryDate(): Date {
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + FREE_ALERT_DURATION_DAYS);
  return expiry;
}

// ── Alert Cap Enforcement ───────────────────────────────────────────────────

/**
 * Check if a FREE user can create a new alert.
 * Returns the number of remaining alert slots.
 *
 * "Search All" groups count as 1 alert toward the limit.
 */
export async function getFreeAlertSlots(userId: string): Promise<{
  activeCount: number;
  limit: number;
  remaining: number;
  canCreate: boolean;
}> {
  // Count active alerts, but group "Search All" by searchAllGroupId
  const activeSearches = await prisma.search.findMany({
    where: { userId, isActive: true },
    select: { id: true, searchAllGroupId: true },
  });

  // Count unique alert slots used:
  // - Searches with searchAllGroupId: each unique group = 1 slot
  // - Searches without searchAllGroupId: each = 1 slot
  const groupIds = new Set<string>();
  let singleCount = 0;

  for (const search of activeSearches) {
    if (search.searchAllGroupId) {
      groupIds.add(search.searchAllGroupId);
    } else {
      singleCount++;
    }
  }

  const activeCount = groupIds.size + singleCount;
  const remaining = Math.max(0, FREE_ALERT_LIMIT - activeCount);

  return {
    activeCount,
    limit: FREE_ALERT_LIMIT,
    remaining,
    canCreate: remaining > 0,
  };
}
