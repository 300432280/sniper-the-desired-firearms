// backend/scripts/probe/shared/types.ts
// Cumulative state types per spec §5.1.
// Each room's output extends the previous room's output. No mutation.

// ─── Room 1: Intake ──────────────────────────────────────────────────────────
export type IntakeState = {
  inputUrl: string;
  canonicalUrl: string;
  timestamp: string;
  runId: string;
};

// ─── Room 2: Access & Identity ──────────────────────────────────────────────
export type WafType =
  | 'cloudflare-passive' | 'cloudflare-active'
  | 'sucuri' | 'sgcaptcha' | 'incapsula' | 'akamai' | 'malcare'
  | 'cloudflare-passive-with-owasp'
  | null;

export type AccessMethod =
  | 'axios-desktop' | 'axios-iphone'
  | 'playwright-chromium'
  | 'playwright-iphone-cookies'
  | 'playwright-real-chrome';

export type PlatformTag = string;  // detector registry-issued IDs (e.g. 'bigcommerce-stencil')

export type HeavyProbeBatchResult = {
  batchId: number;
  description: string;
  status: number | null;
  headers: Record<string, string>;
  bodySnippet: string;  // first 2KB
  durationMs: number;
};

export type PlatformMarkerEvidence = {
  detectorId: PlatformTag;
  confidence: 'high' | 'medium' | 'low';
  signals: Record<string, unknown>;
  compositeRuleApplied?: string;
};

export type AccessIdentityState = IntakeState & {
  canonicalOrigin: string;
  canonicalOriginResolution: {
    primaryResponded: boolean;        // primary = the input host (may be apex OR www)
    primaryWasChallenged: boolean;
    wwwFallbackUsed: boolean;
    serverHeaders: { primary?: string; canonical?: string };
  };
  hasWaf: boolean;
  wafType: WafType;
  wafProbeEvidence: {
    method: 'heavy-8-batch';
    timestamp: string;
    batches: HeavyProbeBatchResult[];
    cfHeaders?: string[];
    sucuriHeaders?: string[];
    sgCaptchaDetected?: boolean;
    incapsulaCookies?: string[];
    akamaiServer?: boolean;
    malcareInBody?: boolean;
    rapidBurstStatus: string;
    sqliRuleFired: boolean;
    xssRuleFired: boolean;
    botUaBlocked: boolean;
    honeypotPathsBlocked: boolean;
  };
  needsPlaywright: boolean;
  userAgentOverride: string | null;
  accessMethod: AccessMethod;
  platform: PlatformTag;
  platformMarker: PlatformMarkerEvidence;  // single winner from detector registry (highest confidence)
};

// ─── Room 3: Geography & Count ──────────────────────────────────────────────
export type PaginationPattern = {
  type: 'query' | 'path' | 'offset-query' | 'suffix-replace' | null;
  template?: string;
  match?: string;
  perPage: number;
  firstPageHasParam: boolean;
  startPage: number;
  zeroIndexed?: boolean;
};

export type CountMethod =
  | 'wp-rest-header' | 'wc-store-api-header'
  | 'shopify-count-json' | 'shopify-products-walk'
  | 'ecwid-storefront-search' | 'klevu-api'
  | 'bc-xmlsitemap' | 'magento-toolbar'
  | 'celerant-perpage-all' | 'generic-product-sitemap'
  | 'wix-store-products-sitemap' | 'catalog-walk-only';

export type GeographyCountState = AccessIdentityState & {
  catalogUrls: string[];
  catalogUrlSource: 'nav' | 'taxonomy-api' | 'taxonomy-api+nav-merge' | 'category-tree-walk' | 'multi-source' | 'manual';
  catalogUrlWalkCounts: Array<{ url: string; uniqueProducts: number; pages: number }>;
  walkedUniqueCount: number;
  globalProductCount: number;
  globalProductCountMethod: CountMethod;
  globalProductCountEvidence: {
    endpoint?: string;
    responseSample?: string;
    headerValue?: string;
    sitemapShards?: string[];
    sitemapTotalLocs?: number;
    sitemapProductLocs?: number;
    sitemapHeadSamples?: Array<{ url: string; status: number }>;
  };
  driftPct: number;
  coverageStrategy: 'api-walk' | 'html-walk' | 'hybrid';
  paginationPattern: PaginationPattern;
  paginationEvidence: {
    testA_page1_vs_page2: { passed: boolean; sample: string[] };
    testB_pageN_vs_pageN_1: { passed: boolean; sample: string[] };
    testC_overflow_vs_page1: { passed: boolean; sample: string[] };
    testD_perPage_sanity: { passed: boolean; observedPerPage: number; expectedPerPage: number };
    totalPagesEstimate: number;
    totalPagesSource: 'widget-markup' | 'api-total' | 'sitemap-math' | 'walk-to-empty';
  };
};

// ─── Room 4: Navigation ─────────────────────────────────────────────────────

export type WatermarkMethod =
  | 'api-date-since-watermark'
  | 'navigate-from-watermark'
  | 'full-catalog-sweep';

export type DateVerificationMethod =
  | 'api-date-field' | 'listing-html-date' | 'detail-page-date-spot-check'
  | 'sitemap-lastmod' | 'rss-feed' | 'sourceId-autoincrement';

export type NavigationState = GeographyCountState & {
  sortParam: string | null;
  sortEvidence: {
    selectHtml: string;
    candidateParams: string[];
    dateVerification: {
      method: DateVerificationMethod;
      page1FirstDate: string;
      page1SecondDate: string;
      page1ThirdDate: string;
      survivesPagination: boolean;
      monotonicallyDecreasing: boolean;
    } | null;
    idJumpBefore: string;
    idJumpAfter: string;
  };
  watermarkMethod: WatermarkMethod;
  watermarkMethodSelection: {
    reason: string;
    dateSourceForMethodA?: string;
    urlSortVerifiedForMethodB?: boolean;
    fallbackToMethodCReason?: string;
  };
};

// ─── Room 5: Bootstrap ──────────────────────────────────────────────────────
export type BootstrapState = NavigationState & {
  productsIndexed: number;
  indexingStrategyUsed: 'api-walk' | 'html-walk' | 'hybrid';
  detailEnrichmentStats: {
    productsEnriched: number;
    avgDetailFetchMs: number;
    detailFetchFailures: number;
  };
  newestProduct: {
    url: string;
    sourceId?: string;
    postDate: string | null;
    title: string;
    price?: number;
  };
  finalDriftPct: number;
  durationMs: number;
  dbWrites: {
    productIndexRows: number;
    monitoredSiteCreated: boolean;
    lastWatermarkUrlSet: boolean;
    lastWatermarkDateSet: boolean;
    isEnabledSet: boolean;
  };
};

// ─── Room failure ──────────────────────────────────────────────────────────
export type RoomFailure = {
  roomFailed: true;
  roomNumber: 1 | 2 | 3 | 4 | 5;
  reason: string;
  evidence: Record<string, unknown>;
  timestamp: string;
};

export type RoomResult<T> = T | RoomFailure;
