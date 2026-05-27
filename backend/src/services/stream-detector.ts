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
export async function detectStreams(siteUrl: string, options?: { hasWaf?: boolean; siteProfile?: any }): Promise<Stream[]> {
  const { adapter } = await getAdapterForUrl(siteUrl);
  const origin = new URL(siteUrl).origin;
  const streams: Stream[] = [];
  const profile = options?.siteProfile;

  // Step 1: Use the API stream when siteProfile DECLARES API-based crawl
  // methods. siteProfile is the single source of truth for site capability
  // -- we do NOT probe the live API here. If the profile says "use API"
  // (via crawlers.maintain.verifyMethod === 'store-api' or
  // crawlers.watermark.method === 'api-date-since-watermark'), we trust it.
  //
  // This matters because the API path runs Store API enrichment which
  // carries stock status; the HTML path on minimalist catalog themes
  // (Tommy Enterprises -- title+price only, no "Add to cart" text) cannot
  // read stock at all and silently flags everything as out-of-stock.
  // Bootstrap exists to make stock data ready for maintain, so we MUST use
  // API whenever the profile says it's available.
  const profileDeclaresApi =
    profile?.crawlers?.maintain?.verifyMethod === 'store-api'
    || profile?.crawlers?.watermark?.method === 'api-date-since-watermark';

  // An explicit `apiAlternative` (mysimplestore / ecwid-storefront-api /
  // bigcommerce-graphql) is a third API trigger. These are page-partitioned
  // JSON APIs that GenericRetail.fetchCatalogPage already dispatches on.
  // Without this trigger the stream-detector emitted them as HTML streams
  // (e.g. liangjian.ca /shop/ols/products is a SPA -- HTML returns 0
  // products and the Playwright fallback only renders ~15 cards from the
  // first page of React state), so 1,800+ products never reached
  // ProductIndex even though the JSON API serves them in 8 pages at
  // perPage=250.
  const hasApiAlternative = !!profile?.apiAlternative?.type;

  if ((profileDeclaresApi || hasApiAlternative) && adapter.fetchCatalogPage) {
    // For apiAlternative-only sites the adapter's static `supportsDateFilter`
    // does not represent the API alternative's capability (mysimplestore
    // ignores dateAfter/dateBefore; bootstrap doesn't send them; maintain
    // uses page-range tier partitioning per catalog-crawler.ts:686). Force
    // 'api' so crawlStreamTier (catalog-crawler.ts:683) dispatches to
    // fetchCatalogPage. For profileDeclaresApi sites preserve the existing
    // supportsDateFilter-driven behavior (Shopify -> 'html', WooCommerce -> 'api').
    const streamType: 'api' | 'html' =
      hasApiAlternative
        ? 'api'
        : (adapter.supportsDateFilter !== false ? 'api' : 'html');
    streams.push({
      id: 'api',
      url: origin,
      type: streamType,
      category: undefined,
    });
    return streams;
  }

  // Step 2: Profile-supplied catalogUrls as HTML streams. Used when the
  // profile does NOT declare API access (or the adapter lacks fetchCatalogPage).
  // Each catalog URL becomes its own stream so T2/T3/T4 can partition by page range.
  if (profile?.catalogUrls?.length) {
    const seenIds = new Set<string>();
    for (const rawUrl of profile.catalogUrls as string[]) {
      const url = rawUrl.startsWith('http') ? rawUrl : `${origin}${rawUrl}`;
      const category = deriveCategoryFromUrl(url);
      const id = category || `profile-${streams.length}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      streams.push({ id, url, type: 'html', category });
    }
    if (streams.length > 0) return streams;
    // Empty or invalid catalogUrls -- fall through to adapter detection
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
export async function probeStreamTotalPages(streams: Stream[], siteUrl: string, options?: { hasWaf?: boolean }): Promise<void> {
  const { adapter } = await getAdapterForUrl(siteUrl);

  for (const stream of streams) {
    if (stream.type === 'api') continue; // Date-partitioned APIs don't need page ranges

    try {
      if (adapter.fetchCatalogPage) {
        // Page-partitioned API (e.g. Shopify) — fetch page 1 to discover total
        const result = await adapter.fetchCatalogPage(new URL(siteUrl).origin, 1, { perPage: 250, hasWaf: options?.hasWaf });
        if (result && result.totalPages) {
          stream.totalPages = result.totalPages;
        } else if (result && result.products.length > 0 && result.products.length < 250) {
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
export function initStreamState(streams: Stream[], crawlPhase?: string): SiteStreamState {
  const tiers: Record<string, StreamTierState> = {};
  // Bootstrap uses T4 ONLY. The polling logic in
  // backend/scripts/enable-new-site.ts:streamStateLooksComplete() depends on
  // this -- it checks `${streams[0].id}:4`. If you extend the bootstrap
  // tierList to [2,3,4], also update streamStateLooksComplete to match, or
  // the polling will report "done" on a T2/T3 completion that fires before
  // T4 actually finishes.
  const isBootstrap = crawlPhase === 'bootstrap';
  const tierList = isBootstrap ? [4] as const : [2, 3, 4] as const;

  for (const stream of streams) {
    // Bootstrap walks the WHOLE catalog from page 1 (no tier partitioning -- see
    // worker.ts:186-188 "No date filters, no tier partitioning. One stream, one
    // pagination cursor"). Skipping computePageRanges here is mandatory: ranges
    // place T4 starting at t3End+1, which is past page 1 and skips the bulk of
    // the catalog. Bug observed 2026-05-25 on tommyenterprises.com -- detected
    // totalPages=2, computePageRanges gave T4=[3, undefined], bootstrap walked
    // page 3 (past end of catalog) -> 0 products -> falsely marked complete.
    // For maintain phase, ranges remain useful (T2/T3/T4 each cover a slice).
    const ranges = isBootstrap
      ? null
      : (stream.totalPages && stream.totalPages > 0
          ? computePageRanges(stream.totalPages)
          : null);

    for (const tier of tierList) {
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
 * Add T2 and T3 tier entries to a streamState if missing. Used when
 * transitioning a site from bootstrap (T4-only) to maintain (T2+T3+T4).
 * Preserves existing T4 progress; only fills in the gaps.
 *
 * For api streams the new tier entries get currentPage=1/no range (date
 * filtering handles partitioning). For html streams with a known totalPages,
 * page ranges are computed via computePageRanges -- same shape initStreamState
 * would have produced.
 */
export function ensureMaintainTiers(state: SiteStreamState): SiteStreamState {
  for (const stream of state.streams) {
    const ranges = stream.type === 'html' && stream.totalPages && stream.totalPages > 0
      ? computePageRanges(stream.totalPages)
      : null;
    for (const tier of [2, 3, 4] as const) {
      const key = `${stream.id}:${tier}`;
      if (state.tiers[key]) continue;
      const tierKey = `t${tier}` as 't2' | 't3' | 't4';
      const range = ranges ? ranges[tierKey] : null;
      state.tiers[key] = {
        streamId: stream.id,
        tier,
        currentPage: range ? range[0] : 1,
        pageRangeStart: range ? range[0] : 1,
        pageRangeEnd: range ? range[1] : undefined,
        status: 'idle',
      };
    }
  }
  return state;
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
