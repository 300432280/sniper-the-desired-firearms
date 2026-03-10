/**
 * Stream Detector — detects the best stream partition for a site.
 *
 * Step 1: Try single API stream (Shopify/WooCommerce endpoints)
 * Step 2: If no API, use adapter's catalog URLs as HTML streams
 * Step 3: Derive category from URL path for domain priority
 *
 * The detector is general-purpose. Domain-specific scoring
 * (e.g. preferring "firearms" streams) is handled by the priority plugin.
 */

import type { Stream, SiteStreamState, StreamTierState } from './scraper/types';
import { getAdapterForUrl } from './scraper/adapter-registry';

/**
 * Derive a category tag from a URL path segment.
 * E.g. "/product-category/firearms/" → "firearms"
 *       "/ammunition/" → "ammunition"
 */
function deriveCategoryFromUrl(url: string): string | undefined {
  try {
    const path = new URL(url).pathname.toLowerCase();
    // Strip leading/trailing slashes, get meaningful segments
    const segments = path.split('/').filter(Boolean);
    // Skip generic segments
    const skip = new Set(['shop', 'products', 'product', 'product-category', 'collections', 'category', 'all']);
    const meaningful = segments.filter(s => !skip.has(s));
    return meaningful[meaningful.length - 1] || segments[segments.length - 1] || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Detect streams for a site based on its adapter capabilities.
 *
 * API sites → single "api" stream (date filtering handles tier division)
 * HTML sites → one stream per catalog URL (page-range tier division)
 */
export async function detectStreams(siteUrl: string): Promise<Stream[]> {
  const { adapter } = await getAdapterForUrl(siteUrl);
  const origin = new URL(siteUrl).origin;
  const streams: Stream[] = [];

  // Step 1: Try API stream (preferred — single stream with date filtering)
  if (adapter.fetchCatalogPage) {
    streams.push({
      id: 'api',
      url: origin,
      type: 'api',
      category: undefined, // API stream covers all categories
    });
    return streams;
  }

  // Step 2: Use adapter's catalog URLs as HTML streams
  if (adapter.extractCatalogProducts) {
    const rawUrls: string[] = [];
    if (adapter.getCatalogUrls) {
      rawUrls.push(...adapter.getCatalogUrls(origin));
    } else if (adapter.getNewArrivalsUrls) {
      rawUrls.push(...adapter.getNewArrivalsUrls(origin));
    } else if (adapter.getNewArrivalsUrl) {
      rawUrls.push(adapter.getNewArrivalsUrl(origin));
    } else {
      rawUrls.push(`${origin}/shop/`);
    }

    const seen = new Set<string>();
    for (const url of rawUrls) {
      if (seen.has(url)) continue;
      seen.add(url);

      const category = deriveCategoryFromUrl(url);
      const id = category || `html-${streams.length}`;

      streams.push({
        id,
        url,
        type: 'html',
        category,
      });
    }
  }

  return streams;
}

/**
 * Initialize stream state for a site from detected streams.
 * Sets up empty tier states for each stream.
 */
export function initStreamState(streams: Stream[]): SiteStreamState {
  const tiers: Record<string, StreamTierState> = {};

  for (const stream of streams) {
    for (const tier of [2, 3, 4] as const) {
      const key = `${stream.id}:${tier}`;
      tiers[key] = {
        streamId: stream.id,
        tier,
        currentPage: 0,
        pageRangeStart: 1,
        status: 'idle',
      };
    }
  }

  return {
    streams,
    tiers,
    detectedAt: new Date().toISOString(),
  };
}

/**
 * Parse streamState from DB JSON, with fallback to empty state.
 */
export function parseStreamState(json: unknown): SiteStreamState | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  if (!Array.isArray(obj.streams)) return null;
  return {
    streams: obj.streams as Stream[],
    tiers: (obj.tiers as Record<string, StreamTierState>) || {},
    detectedAt: obj.detectedAt as string | undefined,
  };
}

/**
 * Compute tier page-range boundaries for an HTML stream based on total pages.
 * T2: pages 1 → ceil(total * 0.3)
 * T3: next ceil(total * 0.35)
 * T4: rest → end
 */
export function computePageRanges(totalPages: number): { t2: [number, number]; t3: [number, number]; t4: [number, number | undefined] } {
  if (totalPages <= 1) {
    return { t2: [1, 1], t3: [1, 1], t4: [1, undefined] };
  }
  const t2End = Math.max(1, Math.ceil(totalPages * 0.3));
  const t3End = Math.max(t2End + 1, Math.ceil(totalPages * 0.65));
  return {
    t2: [1, t2End],
    t3: [t2End + 1, t3End],
    t4: [t3End + 1, undefined], // open-ended
  };
}

/**
 * Update page ranges for all tiers of a stream after learning its total pages.
 */
export function updateStreamPageRanges(
  state: SiteStreamState,
  streamId: string,
  totalPages: number,
): void {
  const ranges = computePageRanges(totalPages);

  // Update stream's totalPages
  const stream = state.streams.find(s => s.id === streamId);
  if (stream) stream.totalPages = totalPages;

  // Update tier boundaries (only if idle — don't disrupt in-progress cycles)
  for (const [tier, [start, end]] of [
    [2, ranges.t2],
    [3, ranges.t3],
    [4, ranges.t4],
  ] as const) {
    const key = `${streamId}:${tier}`;
    const ts = state.tiers[key];
    if (ts && ts.status === 'idle') {
      ts.pageRangeStart = start;
      ts.pageRangeEnd = end;
    }
  }
}
