// Bootstrap -> Maintain readiness check.
//
// Typed service the admin UI calls to preview readiness for every bootstrap
// site and to gate the transition itself. Pass/fail rules: DB coverage >= 95%,
// watermark set, all bootstrap tiers complete, data quality price/stock above
// the category-aware thresholds (forum/auction relaxed, retailer strict).

import axios from 'axios';
import { prisma } from '../lib/prisma';
import { probeExpectedProductCount } from './product-count-probe';
import { resolveUserAgent } from './scraper/http-client';

export interface ReadinessReport {
  ready: boolean;
  reasons: string[];
  dbActive: number;
  dbTotal: number;
  liveCount: number | null;
  coverage: number | null; // 0-100 percentage; null if liveCount unknown
  hasWatermark: boolean;
  tiersComplete: boolean;
  tierStatus: string[];
  priceCoverage: number; // 0-100
  stockCoverage: number;
  thumbCoverage: number;
  inStockCount: number;
  recentT1Finds: number; // last 20 CrawlEvents with matchesFound > 0 -- crawler-aliveness signal
}

/**
 * Lightweight live checks done on page load (parallel across sites). All four
 * indicators describe whether a recently-indexed product is actually fetchable
 * and looks like a product, plus whether the watermark URL is a real product
 * page rather than a 404 or category.
 *
 * Cost per site (a few HTTP requests to ONE host with the production UA):
 *   - 1 product fetch    (for urlOk + titleOk; one request gives both)
 *   - 1 watermark fetch
 */
export interface DeepLightReport {
  urlOk: boolean;        // a sample product URL returns 200
  titleOk: boolean;      // that response contains the product's stored title
  watermarkOk: boolean;  // lastWatermarkUrl returns 200 + looks like a product
  productUrl: string | null;
  watermarkUrl: string | null;
  notes: string[];
}

/**
 * Slower live check: simulates one maintain-phase verify cycle without DB
 * writes. For store-api adapters, batches up to K product IDs into one Store
 * API request; for detail-page sites, fetches K product URLs sequentially.
 * Run on demand via the Refresh button.
 */
export interface DeepVerifyReport {
  verifyOk: boolean;
  method: 'store-api' | 'detail-page';
  sampled: number;
  succeeded: number;
  failures: string[];
}

/**
 * Verification-method validation. Populated on the Refresh-row click. Reports
 * (a) whether siteProfile.crawlers.maintain.verifyMethod is declared and valid,
 * (b) whether it's actually usable end-to-end (3/3 products reachable through
 * the worker.ts:390-500 verify code path). The UI shows this as a distinct
 * "Method" pill so the operator can see at a glance whether the maintain
 * verify config is complete and proven.
 */
export interface VerifyMethodReport {
  /** "store-api" | "detail-page" | <whatever bogus value the profile has, or null when missing> */
  declared: string | null;
  /** Endpoint declared (only meaningful for store-api). */
  endpoint: string | null;
  /** declared is one of "store-api" | "detail-page" AND endpoint set when required. */
  presenceOk: boolean;
  /** End-to-end probe (3/3 products reachable through the verify path). Null when not yet probed. */
  usable: boolean | null;
  /** Overall: presenceOk && usable === true. */
  ok: boolean;
  notes: string[];
}

/**
 * Tier-1 watermark walk check. Branches by siteProfile.crawlers.watermark.method:
 *  - api-date-since-watermark: send a probe request with escalating dateAfter
 *    until >=2 products come back, then verify (a) all returned items are newer
 *    than dateAfter and (b) order=asc actually returns ascending dates.
 *  - navigate-from-watermark: fetch page 1 with the sort param applied, verify
 *    (a) first product's date > last product's date (newest-first) and (b) the
 *    current lastWatermarkUrl appears among extracted products on page 1
 *    (catches URL-normalization mismatches between catalog extraction and
 *    watermark storage -- the silent killer for this method).
 *  - full-catalog-sweep: implicit pass -- same machinery as T4. The T4-cycle
 *    indicator already proves the walk + extract works for this site.
 */
export interface WatermarkWalkReport {
  walkOk: boolean;
  method: 'api-date-since-watermark' | 'navigate-from-watermark' | 'full-catalog-sweep' | 'unknown';
  notes: string[];
  // Method-A details
  dateAfterUsed?: string;
  itemsReturned?: number;
  // Method-B details
  page1FirstDate?: string;
  page1LastDate?: string;
  watermarkOnPage1?: boolean;
  // Sort-axis assertion (Gap 2): verifies adapter-emitted postDate equals
  //   rawApiRow[siteProfile.sortAxis] for sampled products. Currently runs
  //   for WC api-date-since-watermark sites only (the platform where the axis
  //   is request-dependent and the A2 misalignment risk exists).
  //   null  → skipped (sortAxis profile field is null/missing, raw API
  //           refetch not supported for this platform, or sample too small)
  //   true  → emitted postDate matches rawApiRow[sortAxis] for sampled rows
  //   false → mismatch detected; check `notes` for offending sourceIds
  sortAxisOk?: boolean | null;
  sortAxisChecked?: string; // 'modified' | 'date' | 'published_at' (the axis we asserted against)
}

export interface BootstrapSiteSummary {
  id: string;
  domain: string;
  name: string;
  url: string;
  isEnabled: boolean;
  isPaused: boolean;
  adapterType: string;
  hasWaf: boolean;
  hasCaptcha: boolean;
  crawlPhase: string;
  addedAt: string;
  lastCrawlAt: string | null;
  consecutiveFailures: number;
  readiness: ReadinessReport;
  deepLight: DeepLightReport | null;       // populated by listBootstrapSitesWithReadiness
  deepVerify: DeepVerifyReport | null;     // populated only by refresh-readiness route
  watermarkWalk: WatermarkWalkReport | null; // populated only by refresh-readiness route
  verifyMethodCheck: VerifyMethodReport;   // presence on page-load; usability set by Refresh
}

/**
 * Price/stock coverage thresholds per site category. Forums and auctions
 * legitimately have many products with null price (members not yet posting
 * an asking price; sold lots that no longer show the hammer price); the 95%
 * retail threshold would never let them transition. Classifieds sit in
 * between -- usually priced but with some "make offer" / "best offer" items.
 */
function thresholdsForCategory(category: string): { price: number; stock: number } {
  switch (category) {
    case 'forum':
    case 'auction':
      return { price: 50, stock: 50 };
    case 'classified':
      return { price: 70, stock: 70 };
    case 'retailer':
    default:
      return { price: 95, stock: 95 };
  }
}

export async function checkMaintainReadiness(
  siteId: string,
  opts: { liveProbe?: boolean } = {},
): Promise<ReadinessReport> {
  const site = await prisma.monitoredSite.findUnique({
    where: { id: siteId },
    select: {
      id: true,
      url: true,
      hasWaf: true,
      crawlPhase: true,
      siteCategory: true,
      siteProfile: true,
      lastWatermarkUrl: true,
      streamState: true,
    },
  });
  if (!site) {
    throw new Error(`Site not found: ${siteId}`);
  }

  const reasons: string[] = [];
  const profile = (site.siteProfile as any) ?? {};

  // [1] DB counts
  const dbActive = await prisma.productIndex.count({ where: { siteId, isActive: true } });
  const dbTotal = await prisma.productIndex.count({ where: { siteId } });

  // [2] Live count: PREFER stored value to keep the page-load path DB-only.
  // The live probe is HTTP-based and triggers WAF cookie solves on protected
  // sites; running it for 65 sites in parallel on every page load blew past
  // the Next.js proxy timeout. Live probe only fires when opts.liveProbe is
  // explicitly set (Refresh-row button via refreshFullReadiness).
  let liveCount: number | null = null;
  if (typeof profile.expectedProductCount === 'number') {
    liveCount = profile.expectedProductCount;
  }
  if (opts.liveProbe && profile.productCountMethod) {
    try {
      const probed = await probeExpectedProductCount(
        site.url,
        profile.productCountMethod,
        { hasWaf: site.hasWaf, siteId },
      );
      if (probed !== null) liveCount = probed;
    } catch {
      // probe threw -- keep the stored value
    }
  }

  // [3] Coverage
  let coverage: number | null = null;
  if (typeof liveCount === 'number' && liveCount > 0) {
    coverage = Math.round((dbActive / liveCount) * 100);
    if (dbActive < liveCount * 0.95) {
      reasons.push(`coverage ${coverage}% < 95% (${dbActive}/${liveCount})`);
    }
  } else {
    reasons.push('live product count unavailable');
  }

  // [4] Watermark presence
  const hasWatermark = Boolean(site.lastWatermarkUrl);
  if (!hasWatermark) reasons.push('no lastWatermarkUrl');

  // [5] Bootstrap tier completion -- for bootstrap phase, T4 on EVERY stream must have
  // completed a round. Bootstrap is round-robin across all streams (worker.ts), and the
  // end-of-round coverage gate CLEARS every stream's lastCycleCompletedAt when it starts
  // a fresh retry round — so requiring all streams complete keeps the site in bootstrap
  // through retry rounds and only passes once the final round settles. Checking only
  // streams[0] (the old behavior) let a site transition to maintain after the first
  // stream finished while 48 other streams were still unindexed. 2026-06-01.
  let tiersComplete = false;
  const tierStatus: string[] = [];
  const ss = site.streamState as any;
  if (ss && Array.isArray(ss.streams) && ss.tiers) {
    if (site.crawlPhase === 'bootstrap') {
      if (ss.streams.length > 0) {
        let all = true;
        for (const stream of ss.streams) {
          const key = `${stream.id}:4`;
          const ts = ss.tiers[key];
          const completed = Boolean(ts && ts.lastCycleCompletedAt);
          tierStatus.push(`${key}=${completed ? 'done' : 'pending'}`);
          if (!completed) all = false;
        }
        tiersComplete = all;
      } else {
        reasons.push('streamState has no streams');
      }
    } else {
      // Already in maintain (re-check): all (stream, tier 2/3/4) complete
      let all = true;
      for (const stream of ss.streams) {
        for (const tier of [2, 3, 4]) {
          const key = `${stream.id}:${tier}`;
          const ts = ss.tiers[key];
          const completed = Boolean(ts && ts.lastCycleCompletedAt);
          tierStatus.push(`${key}=${completed ? 'done' : 'pending'}`);
          if (!completed) all = false;
        }
      }
      tiersComplete = all;
    }
  } else {
    reasons.push('no streamState (bootstrap not yet started?)');
  }
  if (!tiersComplete) reasons.push('bootstrap tier(s) not yet completed');

  // [6] Data quality on active products.
  // priceCoverage is computed against IN-STOCK products only -- on most retail
  // sites the category listing hides the price for out-of-stock items, so
  // OOS products legitimately have price=null in the DB. Including them in
  // the denominator made alsimmonsgunshop (47% OOS) look like a 53% price
  // failure when in reality all its in-stock products have prices.
  // stockCoverage and thumbCoverage stay on all-active denominator.
  // Both `null` and the string 'unknown' mean "we have no real stock signal"
  // for coverage purposes. Treat them identically. Previously only NULL was
  // counted, which let Ecwid-on-WordPress sites (whose /catalog/search API
  // doesn't expose stock — see generic-retail.ts:688) transition to maintain
  // with what looked like 100% stockCoverage but was functionally 0%. The
  // gate must block these transitions until the operator either backfills
  // stock (e.g. detail-page verify pass) or downgrades the site category.
  const noStock = await prisma.productIndex.count({
    where: {
      siteId, isActive: true,
      OR: [{ stockStatus: null }, { stockStatus: 'unknown' }],
    },
  });
  const noThumb = await prisma.productIndex.count({ where: { siteId, isActive: true, thumbnail: null } });
  const inStockCount = await prisma.productIndex.count({ where: { siteId, isActive: true, stockStatus: 'in_stock' } });
  const inStockWithPrice = await prisma.productIndex.count({
    where: { siteId, isActive: true, stockStatus: 'in_stock', price: { not: null } },
  });
  const priceCoverage = inStockCount > 0
    ? Math.round((inStockWithPrice / inStockCount) * 100)
    : 100; // no in-stock products -> price-quality check N/A; treat as pass
  const stockCoverage = dbActive > 0 ? Math.round(((dbActive - noStock) / dbActive) * 100) : 0;
  const thumbCoverage = dbActive > 0 ? Math.round(((dbActive - noThumb) / dbActive) * 100) : 0;

  const thresholds = thresholdsForCategory(site.siteCategory);
  if (priceCoverage < thresholds.price) {
    reasons.push(`price coverage ${priceCoverage}% < ${thresholds.price}% (${site.siteCategory} threshold)`);
  }
  if (stockCoverage < thresholds.stock) {
    reasons.push(`stock coverage ${stockCoverage}% < ${thresholds.stock}% (${site.siteCategory} threshold)`);
  }

  // [6.5] verifyMethod declared in siteProfile (required for maintain).
  // The verify worker (worker.ts:770) HARD-REQUIRES siteProfile.crawlers.maintain.verifyMethod.
  // When missing the worker logs an error and silently returns without writing a
  // CrawlEvent or updating any product -- the BullMQ job marks "completed", the
  // scheduler keeps re-queueing forever, and the site silently stops syncing.
  // Blocking transition when this is missing prevents the silent-fail scenario.
  const profileForVerify = (site.siteProfile as any) ?? {};
  const declaredVerifyMethod = profileForVerify.crawlers?.maintain?.verifyMethod;
  if (declaredVerifyMethod !== 'store-api' && declaredVerifyMethod !== 'detail-page') {
    reasons.push(
      `siteProfile.crawlers.maintain.verifyMethod missing or invalid (got: ${JSON.stringify(declaredVerifyMethod)}, required: "store-api" or "detail-page")`,
    );
  } else if (declaredVerifyMethod === 'store-api' && !profileForVerify.crawlers?.maintain?.verifyEndpoint) {
    reasons.push('siteProfile.crawlers.maintain.verifyEndpoint missing (required when verifyMethod="store-api")');
  }

  // [7] Crawler-aliveness diagnostic: of the last 20 CrawlEvents, how many
  // actually found products? Not a pass/fail gate -- a signal that helps the
  // operator tell "swept catalog, nothing new" (T4=done + 0/20 finds) apart
  // from "crawler is starved or broken" (T4=pending + 0/20 finds).
  const recentEvents = await prisma.crawlEvent.findMany({
    where: { siteId },
    orderBy: { crawledAt: 'desc' },
    take: 20,
    select: { matchesFound: true },
  });
  const recentT1Finds = recentEvents.filter(e => e.matchesFound > 0).length;

  return {
    ready: reasons.length === 0,
    reasons,
    dbActive,
    dbTotal,
    liveCount,
    coverage,
    hasWatermark,
    tiersComplete,
    tierStatus,
    priceCoverage,
    stockCoverage,
    thumbCoverage,
    inStockCount,
    recentT1Finds,
  };
}

/**
 * Transition a site from bootstrap to maintain phase. Returns transitioned=false
 * when the readiness check fails AND opts.skipReadinessCheck is not set. The UI
 * exposes the skip flag as an explicit "Force transition" affordance.
 *
 * Also fills in T2 and T3 tier entries on streamState if missing. Bootstrap
 * only initializes T4 (see stream-detector.ts initStreamState); without this
 * fill-in, T2/T3 maintain cycles never run after transition because the
 * scheduler skips tiers that have no tierState entry.
 */
export async function transitionSiteToMaintain(
  siteId: string,
  opts: { skipReadinessCheck?: boolean } = {},
): Promise<{ readiness: ReadinessReport; transitioned: boolean }> {
  const site = await prisma.monitoredSite.findUnique({
    where: { id: siteId },
    select: { id: true, domain: true, crawlPhase: true, streamState: true },
  });
  if (!site) throw new Error(`Site not found: ${siteId}`);
  if (site.crawlPhase !== 'bootstrap') {
    throw new Error(`Site ${site.domain} is not in bootstrap phase (current: ${site.crawlPhase})`);
  }

  const readiness = await checkMaintainReadiness(siteId);

  // HARD GATE 1 (presence): the verify worker requires verifyMethod be set.
  // Refuse transition when missing/invalid -- even with force -- because
  // entering maintain with a missing verifyMethod silently no-ops every
  // verify cycle (worker.ts:770) and the site stops syncing.
  const profile = (await prisma.monitoredSite.findUnique({
    where: { id: siteId }, select: { siteProfile: true },
  }))?.siteProfile as any;
  const vm = profile?.crawlers?.maintain?.verifyMethod;
  if (vm !== 'store-api' && vm !== 'detail-page') {
    return {
      readiness: {
        ...readiness,
        ready: false,
        reasons: [
          ...readiness.reasons.filter(r => !/verifyMethod/.test(r)),
          `BLOCKING: siteProfile.crawlers.maintain.verifyMethod = ${JSON.stringify(vm)} (must be "store-api" or "detail-page"). Hard-gated; not bypassable by force.`,
        ],
      },
      transitioned: false,
    };
  }
  if (vm === 'store-api' && !profile?.crawlers?.maintain?.verifyEndpoint) {
    return {
      readiness: {
        ...readiness,
        ready: false,
        reasons: [
          ...readiness.reasons.filter(r => !/verifyEndpoint/.test(r)),
          'BLOCKING: siteProfile.crawlers.maintain.verifyEndpoint missing (required for store-api). Hard-gated; not bypassable by force.',
        ],
      },
      transitioned: false,
    };
  }

  // HARD GATE 2 (usability): exercise the verify path end-to-end against 3
  // real products. Presence alone is not enough -- a site can have
  // verifyMethod="store-api" set but the endpoint actually be 404/403/WAF-
  // blocked, in which case maintain would still silently no-op. Running the
  // probe here costs a few HTTP calls / one Playwright session but transitions
  // are rare, and entering maintain with a broken verifyMethod is unsafe.
  // Also not bypassable by force.
  const probe = await runDeepVerifyCheck(siteId);
  if (!probe.verifyOk) {
    return {
      readiness: {
        ...readiness,
        ready: false,
        reasons: [
          ...readiness.reasons,
          `BLOCKING: verifyMethod="${vm}" failed end-to-end probe (succeeded ${probe.succeeded}/${probe.sampled}). Failures: ${probe.failures.slice(0, 3).join(' | ') || '(none captured)'}. Hard-gated; not bypassable by force.`,
        ],
      },
      transitioned: false,
    };
  }

  if (!readiness.ready && !opts.skipReadinessCheck) {
    return { readiness, transitioned: false };
  }

  const { ensureMaintainTiers, parseStreamState } = await import('./stream-detector');
  const parsedState = parseStreamState(site.streamState);
  const updatedState = parsedState ? ensureMaintainTiers(parsedState) : parsedState;

  await prisma.monitoredSite.update({
    where: { id: siteId },
    data: {
      crawlPhase: 'maintain',
      bootstrapCompletedAt: new Date(),
      ...(updatedState ? { streamState: updatedState as any } : {}),
    },
  });
  return { readiness, transitioned: true };
}

// ── Deep checks ─────────────────────────────────────────────────────────────

const DEEP_LIGHT_TIMEOUT_MS = 15_000;
const PRODUCT_PAGE_MARKERS = /Product|"price"|class=["'][^"']*price|<meta\s+property=["']og:type["']\s+content=["']product["']|itemtype=["'][^"']*\/Product/i;

/**
 * Normalize a string for fuzzy title matching between stored title and live
 * page HTML. Decodes the common HTML entities and collapses Unicode quote/
 * prime variants to plain ASCII -- this catches the case where the DB stores
 * `0.020″` (Unicode double prime) but the page serves `0.020&quot;`.
 */
function normalizeForTitleMatch(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#8243;/g, '"')   // double prime entity
    .replace(/&#8242;/g, "'")   // prime entity
    .replace(/[‘’‚‛]/g, "'") // smart single quotes
    .replace(/[“”„‟]/g, '"') // smart double quotes
    .replace(/[′]/g, "'")  // U+2032 prime
    .replace(/[″]/g, '"')  // U+2033 double prime
    .replace(/[–—]/g, '-'); // en/em dashes
}

async function runDeepLightCheck(siteId: string): Promise<DeepLightReport> {
  const notes: string[] = [];
  let urlOk = false;
  let titleOk = false;
  let watermarkOk = false;
  let productUrl: string | null = null;
  let watermarkUrl: string | null = null;

  const site = await prisma.monitoredSite.findUnique({
    where: { id: siteId },
    select: { domain: true, lastWatermarkUrl: true },
  });
  if (!site) {
    notes.push('site not found');
    return { urlOk, titleOk, watermarkOk, productUrl, watermarkUrl, notes };
  }

  const ua = resolveUserAgent(site.domain);
  const headers = { 'User-Agent': ua };

  // (a) Sample one recent, priced product and verify the URL returns a page
  // whose body contains the stored title.
  const sample = await prisma.productIndex.findFirst({
    where: { siteId, isActive: true, price: { not: null } },
    orderBy: { firstSeenAt: 'desc' },
    select: { url: true, title: true },
  });

  if (!sample) {
    notes.push('no active priced products to spot-check');
  } else {
    productUrl = sample.url;
    try {
      const r = await axios.get(sample.url, {
        timeout: DEEP_LIGHT_TIMEOUT_MS,
        validateStatus: () => true,
        headers,
      });
      if (r.status === 200) {
        urlOk = true;
        const html = typeof r.data === 'string' ? r.data : '';
        const needle = sample.title.length > 60 ? sample.title.slice(0, 60) : sample.title;
        // Normalize both sides: HTML entities + Unicode quote/prime variants.
        // Catches the case where DB stores Unicode `″` while page serves `&quot;`.
        const normNeedle = normalizeForTitleMatch(needle);
        const normHtml = normalizeForTitleMatch(html);
        if (normHtml.includes(normNeedle)) {
          titleOk = true;
        } else {
          notes.push(`title "${needle}" not found in response body (${html.length} bytes, normalized)`);
        }
      } else {
        notes.push(`product URL returned HTTP ${r.status}`);
      }
    } catch (e) {
      notes.push(`product URL fetch threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // (b) Watermark URL should return 200 + look like a product page (not 404 or category).
  if (!site.lastWatermarkUrl) {
    notes.push('no lastWatermarkUrl');
  } else {
    watermarkUrl = site.lastWatermarkUrl;
    try {
      const r = await axios.get(site.lastWatermarkUrl, {
        timeout: DEEP_LIGHT_TIMEOUT_MS,
        validateStatus: () => true,
        headers,
      });
      if (r.status === 200) {
        const html = typeof r.data === 'string' ? r.data : '';
        if (PRODUCT_PAGE_MARKERS.test(html)) {
          watermarkOk = true;
        } else {
          notes.push('watermark URL response did not match product-page markers');
        }
      } else {
        notes.push(`watermark URL returned HTTP ${r.status}`);
      }
    } catch (e) {
      notes.push(`watermark URL fetch threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { urlOk, titleOk, watermarkOk, productUrl, watermarkUrl, notes };
}

/**
 * Mirror the EXACT code path the maintain-phase verify worker uses
 * (worker.ts:390-500). If this returns verifyOk:false, production maintain
 * WILL fail on this site for the same reason; if it returns verifyOk:true,
 * production maintain will succeed.
 *
 *   - store-api path: GET ${verifyEndpoint}?include=id1,id2,id3 with WAF
 *     cookies (via ensureCookies) + PLAYWRIGHT_UA. Comma-joined `include`
 *     param matches the runtime exactly. Cookies are Redis-cached 90 min,
 *     so repeated Refresh clicks within that window reuse them.
 *   - detail-page path: uses fetchWithPlaywright, which is the same helper
 *     the production verify worker falls back to (worker.ts:769).
 */
async function runDeepVerifyCheck(siteId: string): Promise<DeepVerifyReport> {
  const failures: string[] = [];
  const site = await prisma.monitoredSite.findUnique({
    where: { id: siteId },
    select: { domain: true, url: true, siteProfile: true, hasWaf: true },
  });
  if (!site) {
    return { verifyOk: false, method: 'detail-page', sampled: 0, succeeded: 0, failures: ['site not found'] };
  }

  const profile = (site.siteProfile as any) ?? {};
  const declaredMethod = profile.crawlers?.maintain?.verifyMethod;
  if (declaredMethod !== 'store-api' && declaredMethod !== 'detail-page') {
    // Don't silently default to detail-page -- the production worker won't.
    // Fail loud so the Refresh-row "Verify" badge goes red and the operator
    // sees they need to declare verifyMethod in siteProfile.
    return {
      verifyOk: false,
      method: 'detail-page', // placeholder for the shape
      sampled: 0,
      succeeded: 0,
      failures: [
        `siteProfile.crawlers.maintain.verifyMethod is ${JSON.stringify(declaredMethod)} -- must be "store-api" or "detail-page". The maintain verify worker (worker.ts:770) hard-requires this; without it, the site will silently stop syncing the moment it transitions to maintain.`,
      ],
    };
  }
  const verifyMethod = declaredMethod;

  // Pool a larger candidate set of priced products. We try to confirm SAMPLE_K
  // of them through the maintain path; if any are stale (no longer in the
  // catalog), swap in the next candidate from the pool and try again. The
  // verify is green ONLY when all SAMPLE_K come back successfully -- giving
  // positive proof the maintain path can fetch K specific products.
  //
  // We do NOT filter by DB stockStatus='in_stock'. Bootstrap re-sweeps using
  // dateAfter skip unchanged products, so the stock marker can be stale (a
  // product OOS at crawl time but in-stock now will still be stockStatus=
  // 'out_of_stock' in DB). The Store API tells us what's actually in stock
  // right now; we use THAT as the source of truth. The maintain verify worker
  // will refresh the stale markers on its first cycle (worker.ts:517).
  const SAMPLE_K = 3;
  const POOL_SIZE = 15; // up to ~5 swap rounds, 3 at a time
  const candidates = await prisma.productIndex.findMany({
    where: { siteId, isActive: true, price: { not: null } },
    orderBy: { firstSeenAt: 'desc' },
    take: POOL_SIZE,
    select: { url: true, title: true, sourceId: true, price: true },
  });

  if (candidates.length < SAMPLE_K) {
    return {
      verifyOk: false,
      method: verifyMethod,
      sampled: candidates.length,
      succeeded: 0,
      failures: [`only ${candidates.length} priced product(s) available; need ${SAMPLE_K} to verify`],
    };
  }

  // Initial batch + remaining pool we draw replacements from.
  let batch = candidates.slice(0, SAMPLE_K);
  const pool: typeof candidates = candidates.slice(SAMPLE_K);
  const confirmed: typeof candidates = [];
  let attempts = 0;
  let succeeded = 0;
  const MAX_ATTEMPTS = 5;

  // Resolve origin from the stored site URL (not the domain, which may lack scheme)
  const origin = (() => { try { return new URL(site.url).origin; } catch { return null; } })();
  if (!origin) {
    return { verifyOk: false, method: verifyMethod, sampled: 0, succeeded: 0, failures: ['cannot resolve site origin'] };
  }

  if (verifyMethod === 'store-api') {
    const endpoint = profile.crawlers?.maintain?.verifyEndpoint || '/wp-json/wc/store/v1/products';

    // One-time WAF cookie solve before the loop -- same flow as worker.ts:425.
    const { ensureCookies } = await import('./scraper/waf-cookie-manager');
    const { PLAYWRIGHT_UA } = await import('./scraper/playwright-fetcher');
    const headers: Record<string, string> = { 'User-Agent': PLAYWRIGHT_UA };
    if (site.hasWaf) {
      try {
        const creds = await ensureCookies(site.domain, origin);
        headers['Cookie'] = creds.cookies;
        headers['User-Agent'] = creds.userAgent;
      } catch (err) {
        failures.push(`WAF cookie solve failed: ${err instanceof Error ? err.message : String(err)}`);
        return { verifyOk: false, method: verifyMethod, sampled: SAMPLE_K, succeeded: 0, failures };
      }
    }

    const apiUrl = `${origin}${endpoint}`;
    // Loop: query the current batch, mark hits as confirmed, swap misses
    // with fresh candidates from the pool. Continue until we have SAMPLE_K
    // confirmed, the pool is empty, or we hit MAX_ATTEMPTS.
    while (confirmed.length < SAMPLE_K && attempts < MAX_ATTEMPTS) {
      attempts++;
      const ids = batch.map(s => s.sourceId).filter((x): x is string => Boolean(x));
      if (ids.length === 0) {
        failures.push(`attempt ${attempts}: batch has no sourceId (Store API needs WC product IDs)`);
        break;
      }
      let response: any;
      try {
        response = await axios.get(apiUrl, {
          params: { include: ids.join(','), per_page: ids.length },
          headers,
          timeout: 15000,
          validateStatus: () => true,
        });
      } catch (e) {
        failures.push(`Store API fetch threw: ${e instanceof Error ? e.message : String(e)}`);
        break;
      }
      if (response.status !== 200 || !Array.isArray(response.data)) {
        failures.push(`Store API returned HTTP ${response.status}`);
        break;
      }
      const replacements: typeof candidates = [];
      for (const s of batch) {
        const found = response.data.find((p: any) => String(p.id) === String(s.sourceId));
        if (found && (found.prices?.price || found.price)) {
          confirmed.push(s);
        } else {
          // Missing -- try to swap in a replacement
          const next = pool.shift();
          if (next) {
            replacements.push(next);
            failures.push(`sourceId=${s.sourceId} no longer in catalog (swapped in ${next.sourceId})`);
          } else {
            failures.push(`sourceId=${s.sourceId} no longer in catalog (pool exhausted; can't replace)`);
          }
        }
      }
      batch = replacements;
      if (batch.length === 0) break;
    }
    succeeded = confirmed.length;
  } else {
    // detail-page path: same fetchWithPlaywright the production verify worker
    // falls back to (worker.ts:769). Prime WAF cookies first if needed.
    const { ensureCookies } = await import('./scraper/waf-cookie-manager');
    let wafUa: string | undefined;
    let wafCookies: string | undefined;
    if (site.hasWaf) {
      try { const creds = await ensureCookies(site.domain, origin); wafUa = creds.userAgent; wafCookies = creds.cookies; }
      catch { /* fetchWithPlaywright will retry */ }
    }
    // This gate can run from a cold-cache context (e.g. a standalone transition
    // script) where playwright-fetcher's resolvePlaywrightUa cannot see the site's
    // userAgentOverride. Pass it explicitly so UA-gated WAFs (e.g. SiteGround
    // sgcaptcha — doctordeals needs the iPhone UA) aren't served a challenge page
    // and misread as "no product markers".
    const verifyUa = wafUa || profile.userAgentOverride || undefined;
    const { fetchWithPlaywright } = await import('./scraper/playwright-fetcher');

    // Loop: try the batch. For each miss, swap in a replacement from pool.
    while (confirmed.length < SAMPLE_K && attempts < MAX_ATTEMPTS && batch.length > 0) {
      attempts++;
      const replacements: typeof candidates = [];
      for (let i = 0; i < batch.length; i++) {
        if (i > 0 || attempts > 1) await new Promise(r => setTimeout(r, 800));
        const s = batch[i];
        try {
          const pw = await fetchWithPlaywright(s.url, { timeout: 30000, userAgent: verifyUa, cookies: wafCookies });
          if (PRODUCT_PAGE_MARKERS.test(pw.html)) {
            confirmed.push(s);
          } else {
            const next = pool.shift();
            if (next) {
              replacements.push(next);
              failures.push(`${s.url}: no product markers in rendered HTML (swapped in ${next.url})`);
            } else {
              failures.push(`${s.url}: no product markers (pool exhausted; can't replace)`);
            }
          }
        } catch (e) {
          const next = pool.shift();
          if (next) {
            replacements.push(next);
            failures.push(`${s.url}: ${e instanceof Error ? e.message : String(e)} (swapped in ${next.url})`);
          } else {
            failures.push(`${s.url}: ${e instanceof Error ? e.message : String(e)} (pool exhausted)`);
          }
        }
      }
      batch = replacements;
    }
    succeeded = confirmed.length;
  }

  // Verify is GREEN only when all SAMPLE_K were positively confirmed through
  // the maintain path. If we exhausted the candidate pool without reaching K,
  // or the API/WAF failed mid-loop, verifyOk is false.
  return {
    verifyOk: succeeded >= SAMPLE_K,
    method: verifyMethod,
    sampled: confirmed.length + batch.length,
    succeeded,
    failures,
  };
}

/**
 * Build the VerifyMethodReport. presenceOk is computed from siteProfile (cheap).
 * usable is set by passing a pre-computed DeepVerifyReport (so we don't run
 * the expensive probe twice).
 */
function buildVerifyMethodReport(profile: any, deepVerify: DeepVerifyReport | null): VerifyMethodReport {
  const declared = profile?.crawlers?.maintain?.verifyMethod ?? null;
  const endpoint = profile?.crawlers?.maintain?.verifyEndpoint ?? null;
  const validValue = declared === 'store-api' || declared === 'detail-page';
  const endpointOk = declared === 'store-api' ? !!endpoint : true;
  const presenceOk = validValue && endpointOk;
  const usable = deepVerify ? deepVerify.verifyOk : null;
  const ok = presenceOk && usable === true;
  const notes: string[] = [];
  if (!validValue) notes.push(`verifyMethod = ${JSON.stringify(declared)} (must be "store-api" or "detail-page")`);
  if (declared === 'store-api' && !endpoint) notes.push('verifyEndpoint missing (required for store-api)');
  if (presenceOk && deepVerify) {
    if (deepVerify.verifyOk) notes.push(`probed end-to-end: ${deepVerify.succeeded}/${deepVerify.sampled} products reachable via ${deepVerify.method}`);
    else for (const f of deepVerify.failures.slice(0, 2)) notes.push(`probe failed: ${f}`);
  } else if (presenceOk && !deepVerify) {
    notes.push('presence OK; click Refresh to probe end-to-end');
  }
  return { declared, endpoint, presenceOk, usable, ok, notes };
}

/**
 * Method-aware watermark walk check. See WatermarkWalkReport for what each
 * branch tests and why.
 */
async function runWatermarkWalkCheck(siteId: string): Promise<WatermarkWalkReport> {
  const site = await prisma.monitoredSite.findUnique({
    where: { id: siteId },
    select: { domain: true, url: true, siteProfile: true, hasWaf: true, lastWatermarkUrl: true },
  });
  if (!site) return { walkOk: false, method: 'unknown', notes: ['site not found'] };

  const profile = (site.siteProfile as any) ?? {};
  const method: WatermarkWalkReport['method'] =
    profile.crawlers?.watermark?.method === 'api-date-since-watermark' ? 'api-date-since-watermark'
    : profile.crawlers?.watermark?.method === 'full-catalog-sweep' ? 'full-catalog-sweep'
    : 'navigate-from-watermark';

  // Method C: implicit pass via T4-cycle indicator (same machinery).
  if (method === 'full-catalog-sweep') {
    return {
      walkOk: true,
      method,
      notes: ['full-catalog-sweep shares T4 machinery; covered by the T4-cycle indicator'],
    };
  }

  const origin = (() => { try { return new URL(site.url).origin; } catch { return null; } })();
  if (!origin) return { walkOk: false, method, notes: ['cannot resolve site origin'] };

  const { getAdapterForUrl } = await import('./scraper/adapter-registry');
  const { adapter } = await getAdapterForUrl(site.url);

  // ── Method A: api-date-since-watermark ────────────────────────────────────
  if (method === 'api-date-since-watermark') {
    if (typeof (adapter as any).fetchCatalogPage !== 'function') {
      return { walkOk: false, method, notes: ['adapter has no fetchCatalogPage but watermark method is api-date-since-watermark'] };
    }
    // Escalating window: 7d -> 30d -> 90d -> 365d. Stop when >=2 items come back.
    const windows = [7, 30, 90, 365];
    let lastWindow = 0;
    let lastDateAfter = '';
    let lastProducts: any[] = [];
    for (const days of windows) {
      lastWindow = days;
      lastDateAfter = new Date(Date.now() - days * 86_400_000).toISOString();
      try {
        const cp = await (adapter as any).fetchCatalogPage(origin, 1, {
          sortBy: 'oldest', perPage: 10, dateAfter: lastDateAfter, hasWaf: site.hasWaf,
        });
        lastProducts = cp?.products || [];
        if (lastProducts.length >= 2) break;
      } catch (e) {
        return {
          walkOk: false, method,
          notes: [`fetchCatalogPage threw at window=${days}d: ${e instanceof Error ? e.message : String(e)}`],
          dateAfterUsed: lastDateAfter, itemsReturned: 0,
        };
      }
    }
    if (lastProducts.length < 2) {
      return {
        walkOk: false, method,
        notes: [`even with dateAfter=${lastWindow}d the API returned ${lastProducts.length} product(s) -- cannot verify ordering`],
        dateAfterUsed: lastDateAfter, itemsReturned: lastProducts.length,
      };
    }
    const dated = lastProducts.filter(p => p.postDate);
    if (dated.length < lastProducts.length) {
      return {
        walkOk: false, method,
        notes: [`${lastProducts.length - dated.length}/${lastProducts.length} returned products missing postDate -- cannot verify ordering`],
        dateAfterUsed: lastDateAfter, itemsReturned: lastProducts.length,
      };
    }
    const cutoff = new Date(lastDateAfter).getTime();
    // 1-day fudge for tz/clock skew between this host and the site's API.
    const allNewer = dated.every(p => new Date(p.postDate).getTime() >= cutoff - 86_400_000);
    let ascending = true;
    for (let i = 1; i < dated.length; i++) {
      if (new Date(dated[i].postDate).getTime() < new Date(dated[i - 1].postDate).getTime()) {
        ascending = false;
        break;
      }
    }
    const notes: string[] = [];
    if (!allNewer) notes.push('some returned products predate dateAfter -- API may be ignoring the date filter');
    if (!ascending) notes.push('returned products are not in ascending date order -- API may be ignoring order=asc');
    if (allNewer && ascending) notes.push(`date filter + asc ordering both work (${dated.length} items with dateAfter=${lastWindow}d)`);

    // ── Gap-2 sort-axis assertion ──────────────────────────────────────────
    // Verify that the adapter's emitted postDate equals rawApiRow[sortAxis] for
    // the first 3 returned products. Detects A2-style axis misalignment: e.g.
    // the WP REST API is sorted by `modified` (Method A always sets
    // orderby=modified + modified_after) but the adapter emits postDate from
    // `date` -- maintain-readiness would still see ascending order (modified
    // dates ARE ascending) but watermark-crawler.ts:244 newestDateSeen would
    // advance on the wrong field.
    let sortAxisOk: boolean | null = null;
    let sortAxisChecked: string | undefined;
    const sortAxis: string | null | undefined = profile.sortAxis;
    if (sortAxis && (adapter as any).name === 'WooCommerce') {
      sortAxisChecked = sortAxis;
      try {
        // Refetch the same page directly against WP REST -- bypasses the
        // adapter's post-processing so we see the raw row fields.
        const sample = lastProducts.slice(0, 3).filter(p => p.sourceId);
        if (sample.length === 0) {
          notes.push(`sortAxis check skipped: no sourceId on sampled products (axis=${sortAxis})`);
        } else {
          const wpResp = await axios.get(`${origin}/wp-json/wp/v2/product`, {
            params: {
              per_page: 10, page: 1,
              orderby: 'modified', order: 'asc',
              modified_after: lastDateAfter,
              include: sample.map(p => parseInt(p.sourceId!, 10)).filter(n => Number.isFinite(n)),
            },
            headers: { 'User-Agent': resolveUserAgent(new URL(origin).hostname), Accept: 'application/json' },
            timeout: site.hasWaf ? 30000 : 15000,
            validateStatus: s => s === 200,
          });
          if (!Array.isArray(wpResp.data) || wpResp.data.length === 0) {
            // Refetch returned 0 rows -- inconclusive, not a failure. walkOk unaffected.
            notes.push(`sortAxis check inconclusive: raw refetch returned 0 rows (axis=${sortAxis})`);
          } else {
            // Compare to date-precision (sub-second alignment is unreliable
            // when the row has been edited between fetches).
            const toDay = (s: any) => typeof s === 'string' ? s.slice(0, 10) : '';
            const rawById = new Map<string, any>();
            for (const r of wpResp.data) rawById.set(String(r.id), r);
            const mismatches: string[] = [];
            let compared = 0;
            let matchedRowsMissingAxis = 0;
            const missingAxisIds: string[] = [];
            for (const p of sample) {
              const raw = rawById.get(String(p.sourceId));
              // Raw row not found for this sourceId: benign skip (product may
              // have been deleted between calls). Does NOT count as a row whose
              // axis field is missing.
              if (!raw) continue;
              const rawAxisVal = raw[sortAxis];
              if (rawAxisVal === undefined) {
                // HARD FAILURE: row exists but the axis field the operator
                // declared in the profile is not present on the raw API row.
                // sortAxis is misconfigured for this site.
                matchedRowsMissingAxis++;
                missingAxisIds.push(String(p.sourceId));
                continue;
              }
              if (!rawAxisVal) continue; // empty string / null on the axis -- treat as inconclusive for this row
              compared++;
              if (toDay(p.postDate) !== toDay(rawAxisVal)) {
                mismatches.push(`sourceId=${p.sourceId}: postDate=${p.postDate} != raw.${sortAxis}=${rawAxisVal}`);
              }
            }
            if (matchedRowsMissingAxis > 0) {
              // At least one matched raw row lacked the declared axis field.
              // Profile is misconfigured -- fail loudly.
              sortAxisOk = false;
              notes.push(`sortAxis assertion FAILED: sortAxis='${sortAxis}' field not present on raw API row for sourceId(s)=${missingAxisIds.join(',')}; profile sortAxis is misconfigured`);
            } else if (compared === 0) {
              // All matched rows had axis missing or empty, OR no sourceIds
              // matched. We already handled matchedRowsMissingAxis>0 above, so
              // here either (a) no rawRows matched any sourceId, or (b) all
              // matched rows had empty axis values.
              const anyMatched = sample.some(p => rawById.has(String(p.sourceId)));
              if (anyMatched) {
                // Matched but axis empty/null on every one -- treat as hard
                // failure: the axis is declared but never populated.
                sortAxisOk = false;
                notes.push(`sortAxis assertion FAILED: no sampled raw row had sortAxis='${sortAxis}' field populated`);
              } else {
                notes.push(`sortAxis check inconclusive: 0/${sample.length} sampled products matched a raw row (axis=${sortAxis})`);
              }
            } else if (mismatches.length > 0) {
              sortAxisOk = false;
              notes.push(`sortAxis assertion FAILED (${mismatches.length}/${compared}): ${mismatches.join('; ')}`);
            } else {
              sortAxisOk = true;
              notes.push(`sortAxis assertion passed: postDate == raw.${sortAxis} for ${compared}/${sample.length} sampled products`);
            }
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const status: number | undefined = axios.isAxiosError(e) ? e.response?.status : undefined;
        const isTransient =
          /timeout|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i.test(msg) ||
          (axios.isAxiosError(e) && !e.response);
        if (isTransient) {
          sortAxisOk = null;
          notes.push(`transient error — sortAxis assertion skipped (${msg})`);
        } else if (status === 401 || status === 403) {
          sortAxisOk = null;
          notes.push(`auth gate (${status}) — sortAxis assertion skipped`);
        } else if (status === 429) {
          sortAxisOk = null;
          notes.push(`rate limited — sortAxis assertion skipped`);
        } else {
          // Any other non-200 (404, 500, 502, 503, ...) or non-classified
          // throw: the assertion infrastructure is broken for this site.
          // Fail loudly so the operator notices.
          sortAxisOk = false;
          notes.push(`sortAxis assertion FAILED: refetch returned unexpected error (${status ?? 'no-status'}: ${msg})`);
        }
      }
    } else if (sortAxis === null) {
      sortAxisOk = null;
      notes.push('sortAxis check skipped: profile sortAxis=null (platform has no date axis)');
    } else if (sortAxis === undefined) {
      sortAxisOk = null;
      notes.push('sortAxis check skipped: profile sortAxis missing — run backfill-sort-axis script');
    } else {
      sortAxisOk = null;
      notes.push(`sortAxis check skipped: raw-row refetch not implemented for adapter ${(adapter as any).name}`);
    }

    return {
      walkOk: (allNewer && ascending) && sortAxisOk !== false,
      method, notes,
      dateAfterUsed: lastDateAfter,
      itemsReturned: lastProducts.length,
      sortAxisOk,
      sortAxisChecked,
    };
  }

  // ── Method B: navigate-from-watermark ─────────────────────────────────────
  // Test: page 1 with sortParam returns products in newest-first order AND the
  // current lastWatermarkUrl appears among page-1 URLs (URL-consistency check).
  //
  // Dispatcher contract: adapter.fetchCatalogPage() returns null when the adapter
  // doesn't support API for this site (e.g. GenericRetail without Klevu/BC GraphQL
  // configured); callers MUST fall back to HTML extraction in that case (verified
  // 2026-05-31 on theammosource.com where API path returns null but HTML extracts
  // 52 products via `.card` selector). Same fall-through applies when the API
  // returns an empty products array.
  let products: any[] = [];
  let apiAttempted = false;
  if (typeof (adapter as any).fetchCatalogPage === 'function') {
    apiAttempted = true;
    try {
      const cp = await (adapter as any).fetchCatalogPage(origin, 1, {
        sortBy: 'newest', perPage: 10, hasWaf: site.hasWaf,
      });
      products = cp?.products || [];
    } catch (e) {
      return { walkOk: false, method, notes: [`fetchCatalogPage threw: ${e instanceof Error ? e.message : String(e)}`] };
    }
  }
  // Fall through to HTML path when API path returned nothing AND the adapter
  // exposes an HTML extractor. Covers: (a) adapter without fetchCatalogPage at all,
  // (b) fetchCatalogPage returns null (no API configured for this site),
  // (c) fetchCatalogPage returns {products: []} (empty API response).
  if (products.length === 0 && typeof (adapter as any).extractCatalogProducts === 'function') {
    const catalogUrls: string[] = Array.isArray(profile.catalogUrls) ? profile.catalogUrls : [];
    if (catalogUrls.length === 0) {
      return { walkOk: false, method, notes: [apiAttempted ? 'fetchCatalogPage returned null/empty AND no catalogUrls for HTML fallback' : 'no catalogUrls in siteProfile'] };
    }
    const sortParam: string | undefined = typeof profile.sortParam === 'string' ? profile.sortParam : undefined;
    const baseUrl = catalogUrls[0].startsWith('http') ? catalogUrls[0] : `${origin}${catalogUrls[0]}`;
    const sep = baseUrl.includes('?') ? '&' : '?';
    const fullUrl = sortParam ? `${baseUrl}${sep}${sortParam.replace(/^\?/, '')}` : baseUrl;
    try {
      const { fetchPageWithMeta } = await import('./scraper/http-client');
      const r = await fetchPageWithMeta(fullUrl, undefined, { difficultyRating: site.hasWaf ? 1 : 0 });
      const cheerio = await import('cheerio');
      const $ = cheerio.load(r.html);
      products = (adapter as any).extractCatalogProducts($, fullUrl) || [];
    } catch (e) {
      return { walkOk: false, method, notes: [`HTML fetch/extract failed: ${e instanceof Error ? e.message : String(e)}`] };
    }
  } else if (products.length === 0 && !apiAttempted) {
    // No API path AND no HTML extractor — adapter has neither.
    return { walkOk: false, method, notes: ['adapter has neither fetchCatalogPage nor extractCatalogProducts'] };
  }

  if (products.length < 2) {
    return { walkOk: false, method, notes: [`page 1 returned only ${products.length} product(s); need >=2 to verify sort`] };
  }

  const first = products[0];
  const last = products[products.length - 1];
  // Sticky-tolerant + partial-coverage sort check.
  //  - Drupal classifieds (gunpost.ca) promote featured/premium listings to
  //    positions 0-N on page 1 regardless of sort order. Treat the sort as
  //    "newest-first" if the MAX postDate among the first 5 items is greater
  //    than the LAST dated item's postDate.
  //  - BC Stencil (theammosource.com) only exposes postDate on the subset of
  //    cards whose image follows the `/products/N/M/IMG__x.{ts}.jpg` pattern
  //    (verified 2026-06-01 at ~54% per-card coverage with correct ordering on
  //    that subset). Use only products WITH postDate for sort verification —
  //    partial coverage is sufficient as long as ≥2 dated samples exist and
  //    the top-5-of-dated > last-dated relationship holds.
  // Fails when products are genuinely sorted oldest-first or unsorted.
  let sortOk: boolean | null = null;
  const productsWithDates = products.filter(p => p.postDate);
  if (productsWithDates.length >= 2) {
    const lastWithDate = productsWithDates[productsWithDates.length - 1];
    const lastDateMs = new Date(lastWithDate.postDate!).getTime();
    const topDatesMs = productsWithDates.slice(0, 5).map(p => new Date(p.postDate!).getTime()).filter(n => !isNaN(n));
    if (!isNaN(lastDateMs) && topDatesMs.length > 0) {
      sortOk = Math.max(...topDatesMs) > lastDateMs;
    }
  }

  const watermarkOnPage1: boolean = site.lastWatermarkUrl
    ? products.some(p => p.url === site.lastWatermarkUrl)
    : false;

  // High-churn classifieds tolerance: if the watermark URL isn't on page 1 but
  // a fresh fetch returns 200, the listing is still live — it just rolled off
  // page 1 due to churn (gunpost.ca posts hundreds of ads/day; the watermark
  // ages off page 1 within minutes of T1 setting it). Distinguishes
  // "rolled off due to churn" (acceptable) from "deleted from live" (real bug)
  // and from URL-normalization mismatches (the URL DOES return 200 unchanged).
  // Added 2026-05-31 per gunpost re-validator finding.
  let watermarkRolledOff = false;
  if (site.lastWatermarkUrl && !watermarkOnPage1) {
    try {
      const { fetchPageWithMeta } = await import('./scraper/http-client');
      const r = await fetchPageWithMeta(site.lastWatermarkUrl, undefined, { difficultyRating: site.hasWaf ? 1 : 0 });
      if (r.statusCode === 200) {
        watermarkRolledOff = true;
      }
    } catch (_) {
      // Fetch failed — keep watermarkOnPage1=false. Could be a transient WAF issue
      // but we can't distinguish from real deletion; conservative path is the
      // original RED so the operator sees the failure note.
    }
  }

  const notes: string[] = [];
  if (sortOk === null) notes.push('extracted products have no postDate -- cannot verify newest-first sort');
  else if (!sortOk) notes.push(`page 1 NOT newest-first: first=${first.postDate}, last=${last.postDate}`);
  if (!site.lastWatermarkUrl) notes.push('no lastWatermarkUrl stored -- cannot check URL consistency');
  else if (!watermarkOnPage1 && !watermarkRolledOff) notes.push('lastWatermarkUrl NOT on page-1 AND non-200 on fresh fetch -- watermark likely deleted from live or URL normalization mismatch');
  else if (!watermarkOnPage1 && watermarkRolledOff) notes.push('lastWatermarkUrl NOT on page 1 but fresh fetch returned 200 -- rolled off due to churn (acceptable for high-churn classifieds)');
  if (sortOk === true && (watermarkOnPage1 || watermarkRolledOff)) notes.push(`sort works (${products.length} items page-1) + watermark URL ${watermarkOnPage1 ? 'matches page-1 extraction' : 'rolled off but still live'}`);

  return {
    walkOk: sortOk === true && (watermarkOnPage1 || watermarkRolledOff),
    method, notes,
    page1FirstDate: first.postDate,
    page1LastDate: last.postDate,
    watermarkOnPage1: watermarkOnPage1 || watermarkRolledOff,
  };
}

/**
 * Full readiness refresh for a single site: mechanical + deepLight + deepVerify
 * + watermarkWalk + verifyMethodCheck. Called by the Refresh-row button.
 */
export async function refreshFullReadiness(siteId: string): Promise<{
  readiness: ReadinessReport;
  deepLight: DeepLightReport;
  deepVerify: DeepVerifyReport;
  watermarkWalk: WatermarkWalkReport;
  verifyMethodCheck: VerifyMethodReport;
}> {
  const [readiness, deepLight, deepVerify, watermarkWalk] = await Promise.all([
    checkMaintainReadiness(siteId, { liveProbe: true }),
    runDeepLightCheck(siteId),
    runDeepVerifyCheck(siteId),
    runWatermarkWalkCheck(siteId),
  ]);
  // Build verifyMethodCheck from the deepVerify we already ran (don't probe twice).
  const site = await prisma.monitoredSite.findUnique({ where: { id: siteId }, select: { siteProfile: true } });
  const verifyMethodCheck = buildVerifyMethodReport(site?.siteProfile ?? null, deepVerify);
  return { readiness, deepLight, deepVerify, watermarkWalk, verifyMethodCheck };
}

/**
 * List every bootstrap-phase site with its readiness report, for the admin UI.
 */
export async function listBootstrapSitesWithReadiness(): Promise<BootstrapSiteSummary[]> {
  const sites = await prisma.monitoredSite.findMany({
    where: { crawlPhase: 'bootstrap' },
    orderBy: { domain: 'asc' },
    select: {
      id: true,
      domain: true,
      name: true,
      url: true,
      isEnabled: true,
      isPaused: true,
      adapterType: true,
      hasWaf: true,
      hasCaptcha: true,
      crawlPhase: true,
      addedAt: true,
      lastCrawlAt: true,
      consecutiveFailures: true,
      siteProfile: true,
    },
  });

  // Page-load is DB-only. Live HTTP (deepLight, deepVerify, live probe of
  // expectedProductCount) all happen on explicit Refresh-row, NOT here.
  // Running them on every page load triggered WAF cookie solves on 65 sites
  // in parallel and blew past the Next.js proxy timeout (500 to the UI).
  const enriched = await Promise.all(sites.map(async (s): Promise<BootstrapSiteSummary> => {
    let readiness: ReadinessReport;
    try {
      readiness = await checkMaintainReadiness(s.id);
    } catch (err) {
      readiness = {
        ready: false,
        reasons: [`readiness check threw: ${err instanceof Error ? err.message : String(err)}`],
        dbActive: 0, dbTotal: 0, liveCount: null, coverage: null,
        hasWatermark: false, tiersComplete: false, tierStatus: [],
        priceCoverage: 0, stockCoverage: 0, thumbCoverage: 0, inStockCount: 0,
        recentT1Finds: 0,
      };
    }
    // Presence-only verifyMethodCheck on page-load (no probe -- usable=null).
    // Refresh-row fills in usable + ok by re-running this with deepVerify in hand.
    const { siteProfile, ...siteRest } = s as any;
    const verifyMethodCheck = buildVerifyMethodReport(siteProfile, null);

    return {
      ...siteRest,
      addedAt: s.addedAt.toISOString(),
      lastCrawlAt: s.lastCrawlAt ? s.lastCrawlAt.toISOString() : null,
      readiness,
      deepLight: null,      // populated only by Refresh-row
      deepVerify: null,     // populated only by Refresh-row
      watermarkWalk: null,  // populated only by Refresh-row
      verifyMethodCheck,
    };
  }));
  return enriched;
}
