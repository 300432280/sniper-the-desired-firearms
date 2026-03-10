/**
 * Stream Priority — General-purpose staleness-based rotation.
 *
 * Picks the stream whose tier data is oldest (most stale).
 * Self-balancing: small streams finish fast and don't come back for a while,
 * large streams take longer but get proportionally more attention.
 *
 * This is the default priority function. Domain-specific plugins
 * (e.g. stream-priority-firearms.ts) can override it.
 */

import type { Stream, StreamPriority } from './scraper/types';

/**
 * Default staleness-based stream priority.
 * Returns streams sorted by lastRefreshedAt ascending (most stale first).
 * Streams that have never been refreshed go first.
 */
export const stalenessPriority: StreamPriority = (streams) => {
  return [...streams].sort((a, b) => {
    // Never-refreshed streams go first
    if (!a.lastRefreshedAt && !b.lastRefreshedAt) return 0;
    if (!a.lastRefreshedAt) return -1;
    if (!b.lastRefreshedAt) return 1;
    // Most stale (oldest lastRefreshedAt) first
    return new Date(a.lastRefreshedAt).getTime() - new Date(b.lastRefreshedAt).getTime();
  });
};

/**
 * Pick the highest-priority stream for a given tier.
 * Returns null if no streams are eligible (all in cooldown).
 */
export function pickStream(
  streams: Array<Stream & { lastRefreshedAt?: string }>,
  priorityFn: StreamPriority = stalenessPriority,
): (Stream & { lastRefreshedAt?: string }) | null {
  const sorted = priorityFn(streams);
  return sorted[0] ?? null;
}
