/**
 * Stream Priority — Firearms Industry Plugin.
 *
 * Domain-specific priority: firearms streams (3x weight) > ammunition (2x) > rest (1x).
 * Ties broken by staleness (most stale first).
 *
 * This plugin is decoupled from the general-purpose tier engine.
 * Swap it for other industries without touching engine code.
 */

import type { Stream, StreamPriority } from './scraper/types';

/** Domain-specific stream weights. Higher = more important. */
const STREAM_WEIGHTS: Record<string, number> = {
  firearms: 3,
  rifles: 3,
  handguns: 3,
  shotguns: 3,
  pistols: 3,
  ammunition: 2,
  ammo: 2,
  // Everything else defaults to 1
};

/**
 * Get the weight for a stream based on its category or ID.
 * Checks both the stream.category and stream.id fields.
 */
function getWeight(stream: Stream): number {
  const category = (stream.category || stream.id || '').toLowerCase();
  // Check exact match first
  if (STREAM_WEIGHTS[category]) return STREAM_WEIGHTS[category];
  // Check if category contains a weighted keyword
  for (const [keyword, weight] of Object.entries(STREAM_WEIGHTS)) {
    if (category.includes(keyword)) return weight;
  }
  return 1;
}

/**
 * Firearms industry stream priority.
 * Sorts by weight (descending), then by staleness (ascending).
 */
export const firearmsPriority: StreamPriority = (streams) => {
  return [...streams].sort((a, b) => {
    const aW = getWeight(a);
    const bW = getWeight(b);
    if (aW !== bW) return bW - aW; // Higher weight first

    // Tie-break by staleness (most stale first)
    if (!a.lastRefreshedAt && !b.lastRefreshedAt) return 0;
    if (!a.lastRefreshedAt) return -1;
    if (!b.lastRefreshedAt) return 1;
    return new Date(a.lastRefreshedAt).getTime() - new Date(b.lastRefreshedAt).getTime();
  });
};
