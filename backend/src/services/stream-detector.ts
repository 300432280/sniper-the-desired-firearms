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
import { detectTotalPagesFromHtml } from './catalog-crawler';

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
    // Join all meaningful segments to avoid collisions (e.g. /firearms/rifles vs /used/rifles)
    if (meaningful.length > 0) return meaningful.join('-');
    return segments[segments.length - 1] || undefined;
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

  // Step 1: Try API stream
  if (adapter.fetchCatalogPage) {
    // API streams that support date filtering use 'api' type (tiers partition by date range)
    // API streams without date filtering use 'html' type (tiers partition by page range)
    const streamType = adapter.supportsDateFilter !== false ? 'api' : 'html';
    streams.push({
      id: 'api',
      url: origin,
      type: streamType,
      category: undefined,
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

    const seenUrls = new Set<string>();
    const seenIds = new Set<string>();
    for (const url of rawUrls) {
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);

      const category = deriveCategoryFromUrl(url);
      const id = category || `html-${streams.length}`;

      // Deduplicate by stream id — two URLs mapping to the same id
      // (e.g. /ads and /ads?sort_by=...) would create conflicting tier states
      if (seenIds.has(id)) continue;
      seenIds.add(id);

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
 * Probe streams to discover totalPages at bootstrap time.
 * For HTML streams: fetch page 1 and detect pagination from HTML.
 * For page-partitioned API streams (Shopify): fetch page 1 to count products.
 * This avoids the "all tiers start at page 1" bootstrap problem.
 */
export async function probeStreamTotalPages(streams: Stream[], siteUrl: string): Promise<void> {
  const { adapter } = await getAdapterForUrl(siteUrl);

  for (const stream of streams) {
    if (stream.type === 'api') continue; // Date-partitioned APIs don't need page ranges

    try {
      if (adapter.fetchCatalogPage) {
        // Page-partitioned API (e.g. Shopify) — fetch page 1 to discover total
        const result = await adapter.fetchCatalogPage(new URL(siteUrl).origin, 1, { perPage: 250 });
        if (result.totalPages) {
          stream.totalPages = result.totalPages;
        } else if (result.products.length > 0 && result.products.length < 250) {
          stream.totalPages = 1; // Less than a full page = single page
        }
      } else if (stream.url) {
        // HTML stream — fetch and detect pagination
        const { fetchPage } = await import('./scraper/http-client');
        const html = await fetchPage(stream.url);
        if (html && html.length > 500) {
          const cheerio = await import('cheerio');
          const $ = cheerio.load(html);
          const detected = detectTotalPagesFromHtml($, stream.url);
          if (detected) stream.totalPages = detected;
        }
      }
    } catch {
      // Probe failure is non-fatal — tiers will discover pages on first crawl
    }

    // Rate limit between probes
    await new Promise(r => setTimeout(r, 500));
  }
}

/**
 * Initialize stream state for a site from detected streams.
 * Sets up tier states with page ranges from totalPages (if discovered during probe).
 */
export function initStreamState(streams: Stream[]): SiteStreamState {
  const tiers: Record<string, StreamTierState> = {};

  for (const stream of streams) {
    // If totalPages was discovered during probe, compute ranges upfront
    const ranges = stream.totalPages && stream.totalPages > 0
      ? computePageRanges(stream.totalPages)
      : null;

    for (const tier of [2, 3, 4] as const) {
      const key = `${stream.id}:${tier}`;
      const tierKey = `t${tier}` as 't2' | 't3' | 't4';
      const range = ranges ? ranges[tierKey] : null;

      tiers[key] = {
        streamId: stream.id,
        tier,
        currentPage: range ? range[0] : 1,
        pageRangeStart: range ? range[0] : 1,
        pageRangeEnd: range ? range[1] : undefined,
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
    // Single page: only T2 crawls it, T3/T4 have no work (start > end)
    return { t2: [1, 1], t3: [2, 1], t4: [2, undefined] };
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

  // Update tier boundaries for all tiers (idle or in-progress)
  for (const [tier, [start, end]] of [
    [2, ranges.t2],
    [3, ranges.t3],
    [4, ranges.t4],
  ] as const) {
    const key = `${streamId}:${tier}`;
    const ts = state.tiers[key];
    if (!ts) continue;
    ts.pageRangeStart = start;
    ts.pageRangeEnd = end;
    // If tier is in-progress but currentPage is outside its new range, reset to range start
    if (ts.status === 'in_progress' && (ts.currentPage < start || (end != null && ts.currentPage > end))) {
      ts.currentPage = start;
      ts.currentPageUrl = undefined;
    }
  }
}
