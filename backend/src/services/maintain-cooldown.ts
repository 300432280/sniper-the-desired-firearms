/**
 * Shared maintain-phase cooldown tracking.
 * Extracted from worker.ts to avoid circular import between scheduler and worker.
 */

const maintainCooldowns = new Map<string, number>();

/** Check if a maintain tier is in cooldown */
export function isMaintainTierInCooldown(siteId: string, tier: 2 | 3 | 4): boolean {
  const key = `${siteId}:${tier}`;
  const cooldownEnd = maintainCooldowns.get(key);
  if (!cooldownEnd) return false;
  if (Date.now() >= cooldownEnd) {
    maintainCooldowns.delete(key);
    return false;
  }
  return true;
}

/** Set cooldown for a maintain tier */
export function setMaintainTierCooldown(siteId: string, tier: 2 | 3 | 4, cooldownHours: number): void {
  const key = `${siteId}:${tier}`;
  maintainCooldowns.set(key, Date.now() + cooldownHours * 3600000);
}
