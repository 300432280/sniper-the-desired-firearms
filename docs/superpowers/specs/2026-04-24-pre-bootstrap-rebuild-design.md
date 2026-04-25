---
title: Pre-Bootstrap Pipeline Rebuild — Design Spec
status: draft
date: 2026-04-24
author: pair (user + Claude)
supersedes: .claude/skills/pre-bootstrap/SKILL.md (judgment layer, to be updated after impl)
relates_to:
  - .claude/catalog-url-discovery-playbook.md
  - .claude/agents/crawler-specialist.md
  - .claude/probe-rewrite-lessons.md
  - C:\Users\TNT\.claude\projects\d--VScode-Projects-firearm-alert\memory\project_next_session.md
---

# Pre-Bootstrap Pipeline Rebuild — Design Spec

## 1. Context

### 1.1 Why we are rebuilding

The 2026-04-21..04-24 session ended with the user declaring the probe work a mess
("the way you try to fix it, is just keep making more mess"). The core architectural
defect was a confused boundary between probe modules — Phase 2 (platform) and Phase 3
(sitemap) both ended up producing product counts via different methods, and patches
layered on top of patches (`deriveProductCount()` picker, composite tag bolt-ons,
"fleet drift" vocabulary) obscured rather than resolved the boundary problem.

This spec rebuilds the pipeline around the **site lifecycle** as the organizing
principle, not technical concerns. Each lifecycle stage is one "room" with a strict
single responsibility and a typed contract to the next room. No bolt-ons. No
overlapping ownership. No drift vocabulary.

### 1.2 Scope

**In scope:**
- Intake → access-identity → count → navigation → bootstrap.
- Full replacement of `backend/scripts/pre-bootstrap.ts` and its 9 probe modules.
- New `backend/scripts/bootstrap.ts` standalone utility for Room 5.
- Preservation and re-homing of proven pieces from the reverted session code
  (see §9 Cherry-Pick List).

**Out of scope:**
- Tier engine changes (watermark-crawler.ts, catalog-crawler.ts are unchanged).
- Per-stream Tier-1 watermarks (tier-engine concern; see §6.5).
- DB schema changes (use existing `MonitoredSite` columns + `siteProfile` /
  `crawlTuning` JSON fields).
- Changes to adapters (`generic-retail.ts`, `shopify.ts`, `woocommerce.ts`, etc.).
- Production code outside `backend/scripts/` (except where already changed for
  sgcaptcha / cookie capture in `playwright-fetcher.ts` — those stay).

### 1.3 Evidence base

This spec is grounded in:
- 7-phase audit process and 38 mistake patterns in
  `.claude/catalog-url-discovery-playbook.md`.
- 38 accumulated lessons in `.claude/agents/crawler-specialist.md`.
- Session-distilled anti-patterns in `.claude/probe-rewrite-lessons.md`.

---

## 2. The Site Lifecycle (4 rooms + door)

A site moves through 4 rooms, each gated by verified evidence. It cannot enter a
room until the previous room's gate passes. The door is a human review step,
followed by Room 5 (bootstrap, standalone utility) which populates `ProductIndex`
and hands the site off to the existing tier engine.

```
 URL ──► Room 1 ──► Room 2 ──► Room 3 ──► Room 4 ──► [ human gate ] ──► Room 5 ──► tier engine
         intake    access    geo+        navigation                    bootstrap
                   identity  count                                      (indexing)
```

### 2.1 Tier-1 direction (correct statement, once)

Tier 1's primary work is: **find the stored watermark, then walk FROM the watermark
TOWARD the newest product, indexing new products as it goes.**

- The "find" is a setup step, implementation-specific (API date filter, URL scan,
  or sourceId lookup).
- The "walk" is the data-capturing operation and always runs watermark → newest.
- Any description that says "paginate newest-first until hitting last-known" is
  describing only the URL-anchored locator substep and is **not** a complete or
  correct summary of T1.

`CLAUDE.md` and `architecture.md` have been corrected in-repo to reflect this.

### 2.2 Bootstrap vs Maintain

- **Bootstrap (Room 5, one-time):** single sweep of the whole catalog, index every
  product into `ProductIndex` with full info captured. Uses one crawler, not the
  4-tier engine. Ends when every product is captured with ≤3% drift vs the global
  count.
- **Maintain (post-bootstrap, steady state, OUT OF SCOPE for this spec):** tier
  engine takes over to keep all product info fresh — not just stock/price, but
  title changes, image updates, tag/category reassignment, OOS↔in-stock
  transitions, deletions (via stale detector), and any other field that can
  change after first index.
  - Tier 1 walks from watermark toward newest, new-product detection.
  - Tiers 2/3/4 refresh recent/aging/archive products on cooldown cycles.
  - Stale detector: cross-tier safe-window flags products missed by ALL tiers.

Bootstrap and maintain are implementation-separate. Room 5's only job is to get
every product fully indexed; the tier engine's job is everything after. The tier
engine itself is not modified by this spec.

---

## 3. Architecture

### 3.1 Folder layout

```
backend/scripts/
├── pre-bootstrap.ts                      # orchestrator (thin composition)
├── bootstrap.ts                          # Room 5 standalone utility
└── probe/
    ├── shared/                           # genuinely cross-cutting code only
    │   ├── fetch.ts                      # WAF-aware fetch (axios + Playwright + Redis cookie cache)
    │   ├── ua.ts                         # UA escalation ladder (7-step)
    │   ├── redis-cookies.ts              # Redis cookie accessor (waf-cookie-manager integration)
    │   ├── url-utils.ts                  # canonicalize, strip, fragment-preserve, isLikelyNavUrl
    │   ├── extract.ts                    # wraps production extractCatalogProducts
    │   └── types.ts                      # RoomInput / RoomOutput / cumulative state types
    ├── room1-intake/
    │   ├── index.ts                      # runRoom1(url) → IntakeState
    │   ├── validate-url.ts               # URL validation + canonical form
    │   └── profile-stub.ts               # in-memory profile stub (no DB yet)
    ├── room2-access-identity/
    │   ├── index.ts                      # runRoom2(IntakeState) → AccessIdentityState
    │   ├── canonical-host.ts             # apex vs www resolution w/ www-fallback on challenge
    │   ├── waf-detect.ts                 # header/body vendor classification (incl. Sucuri, Incapsula,
    │   │                                 #   sgcaptcha, Akamai, MalCare) + origin-rule exclusion
    │   ├── waf-heavy-probe.ts            # 8-batch probe (wraps heavy-waf-probe.sh)
    │   └── platform-detect.ts            # HTML markers + composite tags (celerant-coldfusion,
    │                                     #   ecwid-on-wordpress, drupal-commerce, etc.)
    ├── room3-geography-count/
    │   ├── index.ts                      # runRoom3(AccessIdentityState) → GeographyCountState
    │   ├── global-count.ts               # API/sitemap dispatch per platform
    │   ├── sitemap-parse.ts              # XML fetch (static-mode, not Playwright), filter <loc>,
    │   │                                 #   HEAD-test, index follow, byte-identical shard dedupe
    │   ├── catalog-urls.ts               # nav + taxonomy + category tree walk
    │   └── walk-verify.ts                # production walk, dedupe, ≤3% coverage gate
    ├── room4-navigation/
    │   ├── index.ts                      # runRoom4(GeographyCountState) → NavigationState
    │   ├── pagination-detect.ts          # 4-pattern test + 3-point verification (A/B/C/D)
    │   ├── sort-detect.ts                # read <select>, date-verified (not just ID-jump),
    │   │                                 #   survives pagination
    │   └── watermark-method.ts           # pick Method A / B / C
    └── room5-bootstrap/                  # NOTE: bootstrap.ts at scripts/ is the entry;
        ├── index.ts                      #   room5-bootstrap/* is invoked by bootstrap.ts
        ├── strategy-dispatch.ts          # pick API-walk vs HTML-walk vs hybrid per platform
        ├── detail-enrich.ts              # detail-page fallback for missing price/date
        └── index-products.ts             # write to ProductIndex + seed watermark
```

### 3.2 Core principles

1. **One folder per lifecycle stage.** The folder name IS the owner. Room 2 owns
   all access + identity code; Room 3 owns all count + geography code; etc. No
   overlap.
2. **Cross-cutting code moves to `shared/` only when ≥2 rooms actually need it.**
   Speculative reuse is rejected. Current `shared/` contents are the genuinely
   cross-cutting primitives (fetch, UA, URL, extract, types, redis-cookies).
3. **State flows forward only.** A later room does not mutate an earlier room's
   output. If Room 3 discovers Room 2 was wrong (e.g. platform misidentified),
   the orchestrator decides whether to re-enter Room 2 — individual rooms do not
   reach backward.
4. **Every emitted field has structured evidence.** Not `wafType: 'cloudflare-passive'`
   alone, but `wafType + wafProbeEvidence: { cfRayHeaders: [...], serverHeader,
   rapidBurstStatus, sqliRuleFired, ... }`. Evidence is a typed object, not prose.
5. **Each room has a single public entry point: `runRoom(input) → output`.**
   Internal modules are imports within the room folder. Other rooms import only
   the state type from the room folder's `index.ts` — they never reach into a
   room's sub-modules.
6. **The orchestrator is dumb.** It calls `runRoom1`, `runRoom2`, `runRoom3`,
   `runRoom4` in sequence; handles hand-off and error reporting; writes the
   probe-report and profile JSON. It contains no detection logic.

---

## 4. Room Contracts

### 4.1 Room 1: Intake

**Input:**
```ts
type Room1Input = { url: string };
```

**Output:**
```ts
type IntakeState = {
  inputUrl: string;          // what the user typed
  canonicalUrl: string;      // normalized form (scheme, trailing slash, etc.)
  timestamp: string;         // ISO timestamp (run marker)
  runId: string;             // uuid for this pipeline run
};
```

**Responsibility:** URL validation + canonicalization only. No DB writes. No HTTP.

**Pass criteria:** URL is well-formed; `canonicalUrl` resolves to a schema (http/https).

**Hard fail:** URL malformed, missing scheme that cannot be inferred, or points at
localhost / private IP ranges.

---

### 4.2 Room 2: Access & Identity

**Input:** `IntakeState`

**Output:**
```ts
type AccessIdentityState = IntakeState & {
  canonicalOrigin: string;       // apex vs www resolved (e.g., https://www.site.com)
  canonicalOriginResolution: {
    apexResponded: boolean;
    apexWasChallenged: boolean;  // true if apex body had CF/Sucuri/sgcaptcha markers
    wwwFallbackUsed: boolean;
    serverHeaders: { apex?: string; canonical?: string };
  };
  hasWaf: boolean;               // authoritative (column + evidence-backed)
  wafType: WafType | null;       // cloudflare-passive | cloudflare-active | sucuri
                                 // | sgcaptcha | incapsula | akamai | malcare | null
  wafProbeEvidence: {
    method: 'heavy-8-batch';
    timestamp: string;
    batches: HeavyProbeBatchResult[];  // raw per-batch output
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
  userAgentOverride: string | null;   // e.g. iPhone Safari for sgcaptcha / Sucuri-UA-filter
  accessMethod: 'axios-desktop' | 'axios-iphone' | 'playwright-chromium'
              | 'playwright-iphone-cookies' | 'playwright-real-chrome';
  platform: PlatformTag;              // bigcommerce-stencil | magento-2.x | lightspeed-ecom
                                     // | ecwid-on-wordpress | celerant-coldfusion
                                     // | drupal-commerce | woocommerce | shopify | etc.
  platformMarker: PlatformMarkerEvidence;      // single winner from detector registry (highest confidence)
};
```

**Detector Registry pattern (extensibility):**

`platformMarker` is NOT a hard-coded type listing every platform. It is the
evidence object produced by the detector that fired (single winner — highest
confidence), in the shape that detector defines. Adding a new platform requires
only registering a new detector — no edit to `AccessIdentityState`, no edit to
other detectors, no edit to consumers.

```ts
// shared/types.ts
type PlatformMarkerEvidence = {
  detectorId: string;            // e.g. 'bigcommerce-stencil', 'celerant-coldfusion'
  confidence: 'high' | 'medium' | 'low';
  signals: Record<string, unknown>;  // detector-defined evidence shape
  compositeRuleApplied?: string;     // when a composite (multi-detector) rule won
};

// room2-access-identity/platform-detect.ts
interface PlatformDetector {
  id: PlatformTag;
  detect(input: { html: string; headers: Record<string,string>; cookies: string[]; })
    : Promise<{ matched: boolean; confidence: 'high'|'medium'|'low'; signals: Record<string,unknown> }>;
}

const detectors: PlatformDetector[] = [
  bigcommerceStencilDetector,
  bigcommerceBlueprintDetector,
  magento1xDetector,
  magento2xDetector,
  woocommerceDetector,
  shopifyDetector,
  ecwidOnWordpressDetector,
  celerantColdfusionDetector,
  drupalCommerceDetector,
  lightspeedClassicDetector,
  lightspeedEcomDetector,
  opencartDetector,
  volusionDetector,
  nopcommerceDetector,
  odooDetector,
  hikashopJoomlaDetector,
  xenforoDetector,
  godaddyOlsDetector,
  wixThunderboltDetector,
  // ← future platforms appended here. Zero changes to other code.
];
```

When a new platform is encountered (e.g., a Custom Magento variant or a new SaaS
storefront), the workflow is:

1. Identify ≥1 unique HTML marker, header, cookie, or asset URL pattern.
2. Add a new file `room2-access-identity/detectors/<platform-id>.ts` exporting a
   `PlatformDetector`.
3. Register it in the `detectors[]` array.
4. Add fixture HTML to `__test__/fixtures/<platform-id>.html` and a unit test.
5. Done.

The detector registry's append-only growth is documented as a contract — future
sessions extending the fleet (e.g., new auction platforms, new China-targeting
e-commerce SaaS) follow this exact procedure.

**Responsibility:**
1. Resolve canonical origin (apex vs www), with www-fallback when apex body has
   challenge markers (playbook Mistake: lockharttactical).
2. Run 8-batch heavy WAF probe, classify `wafType` from headers + body + UA
   behavior:
   - Active vs passive CF is decided by browser-UA challenge evidence ONLY
     (desktop Chrome + iPhone Safari). Bot-UA 403s from CF Bot Fight Mode do
     NOT count as active. (Fixes dantesports/doubletapsports/g4c misclassification.)
   - Sucuri, Incapsula, sgcaptcha, Akamai, MalCare each have vendor-specific
     detectors from headers + body.
   - Origin-level rules (mod_security blocking SQLi/XSS, Wordfence) do **NOT**
     set `hasWaf=true` unless a vendor header is also present. (Fixes
     budgetshooter/corwin/icollector/international.)
   - Consistency guard: `if wafType != null then hasWaf = true`.
3. Identify platform via HTML markers + composite rules (celerant-coldfusion,
   ecwid-on-wordpress, drupal-commerce, etc.).
4. Pick access method by escalating the UA ladder until a real product page is
   returned.

**Pass criteria:**
- `wafType` classified with evidence (or `null` + evidence that no vendor headers
  exist across all 8 batches).
- `platform` identified with ≥1 confirmed marker.
- `accessMethod` verified by an actual HTTP fetch returning product-shaped HTML.

**Soft warn:** confidence `medium` on WAF vendor or platform — proceed, flag in
report.

**Hard fail:** no access method on the full 7-step UA ladder returns real product
HTML. (Site unreachable without manual operator arrangement — e.g., MalCare
origin block.)

---

### 4.3 Room 3: Count & Geography

**Input:** `AccessIdentityState`

**Output:**
```ts
type GeographyCountState = AccessIdentityState & {
  globalProductCount: number;
  globalProductCountMethod: CountMethod;  // wp-rest-header | wc-store-api-header
                                          // | shopify-count-json | shopify-products-walk
                                          // | ecwid-storefront-search | klevu-api
                                          // | bc-xmlsitemap | magento-toolbar
                                          // | celerant-perpage-all | generic-product-sitemap
                                          // | wix-store-products-sitemap | catalog-walk-only
  globalProductCountEvidence: {
    endpoint?: string;
    responseSample?: string;
    headerValue?: string;
    sitemapShards?: string[];
    sitemapTotalLocs?: number;
    sitemapProductLocs?: number;
    sitemapHeadSamples?: { url: string; status: number }[];
  };
  catalogUrls: string[];           // minimum overlap, 100% coverage of firearm-relevant
  catalogUrlSource: 'nav' | 'taxonomy-api' | 'category-tree-walk' | 'manual';
  catalogUrlWalkCounts: { url: string; uniqueProducts: number; pages: number }[];
  walkedUniqueCount: number;       // deduped across all catalogUrls
  driftPct: number;                // (globalCount - walkedCount) / globalCount × 100
  coverageStrategy: 'api-walk' | 'html-walk' | 'hybrid';
};
```

**Why "Geography & Count" not "Count & Geography":** geography (catalogUrls) can
be discovered without count. Count via API can be obtained without geography on
some platforms, but the count is **never confirmed** until the walk is executed
across the discovered catalogUrls. Walk-vs-count reconciliation is the room's
final and authoritative output. Hence: geography first (always), count second
(target value, validated by walk).

**Responsibility (in order):**

1. **Discover `catalogUrls`** via nav + taxonomy API + category tree walk. Never
   drop small categories. 100% firearm-relevant coverage, minimum overlap.
   Independent of count — runs first.

2. **Try API-first count** (uses fields/endpoints discovered in Room 2; does NOT
   require catalogUrls). Priority order, first one with a value wins:
   1. WP REST `x-wp-total`
   2. WC Store API `x-wp-total`
   3. Shopify `/products/count.json` → `count`
   4. Ecwid `POST /catalog/search` (no parentCategoryId) → `totalProductsCount`
   5. Klevu `meta.totalResultsFound`
   6. BC `/xmlsitemap.php?type=products` (multi-shard sum)
   7. Magento `/new-products.html` `<span class="toolbar-number">` (3rd occurrence)
   8. Celerant `?perpage=All` on a category (per-category sum of catalog pages)
   9. Wix `/store-products-sitemap.xml`
   10. Generic product sitemap (filter `<loc>` to product pattern, HEAD-test
       samples, follow sitemap-index, dedupe byte-identical shards by md5)

3. **Walk every `catalogUrl`** with production `extractCatalogProducts`, dedupe
   by canonical URL across all catalogUrls, compute `walkedUniqueCount`.

4. **Reconcile count and walk:**
   - If an API/sitemap count was obtained (steps 2.1–2.10): set
     `globalProductCount = <that value>`, `globalProductCountMethod = <which one>`.
     Compute `driftPct = |globalProductCount - walkedUniqueCount| / globalProductCount × 100`.
     Drift ≤ 3% confirms the API count and the walk agree. Drift > 3% triggers
     soft-warn or hard-fail per gate.
   - If no API/sitemap count was obtained: set `globalProductCount =
     walkedUniqueCount`, `globalProductCountMethod = 'catalog-walk-only'`,
     `driftPct = 0`. The walk IS the count.

**Relationship between Room 3 count and Room 5 indexed count:** Room 3's
`globalProductCount` is the **target** (expected value). Room 5's `productsIndexed`
is the **actual** (after the bootstrap walk completes). They must match within
the same 3% tolerance. If Room 5's actuals diverge from Room 3's target, that
indicates either the walk strategy is missing products, or the count method was
wrong — Room 5 fails its gate and the operator re-investigates Room 3.

**Pass criteria:** drift ≤ 3%; at least 1 catalogUrl; walk returned products from
every catalogUrl (no silent 0-extract categories — Mistake 38 sub-category tile
trap).

**Soft warn:** drift 3–5% — proceed, record per-category gap and missing-product
URL list.

**Hard fail:** drift > 5%, OR 0 catalogUrls discovered, OR any catalogUrl returns
0 products from the walk (sub-category tile page).

---

### 4.4 Room 4: Navigation

**Input:** `GeographyCountState`

**Output:**
```ts
type NavigationState = GeographyCountState & {
  paginationPattern: {
    type: 'query' | 'path' | 'offset-query' | 'suffix-replace' | null;
    template?: string;
    match?: string;
    perPage: number;
    firstPageHasParam: boolean;
    startPage: number;  // 0 or 1
  };
  paginationEvidence: {
    testA_page1_vs_page2:   { passed: boolean; sample: string[] };   // silent-ignore
    testB_pageN_vs_pageN_1: { passed: boolean; sample: string[] };   // clamp-to-last
    testC_overflow_vs_page1:{ passed: boolean; sample: string[] };   // wrap-around
    testD_perPage_sanity:   { passed: boolean; observedPerPage: number; expectedPerPage: number };
    totalPagesEstimate: number;
    totalPagesSource: 'widget-markup' | 'api-total' | 'sitemap-math' | 'walk-to-empty';
  };
  sortParam: string | null;  // e.g. "?product_list_order=new&product_list_dir=desc"
  sortEvidence: {
    selectHtml: string;
    candidateParams: string[];
    dateVerification: {
      method: 'api-date-field' | 'listing-html-date' | 'detail-page-date-spot-check'
            | 'sitemap-lastmod' | 'rss-feed' | 'sourceId-autoincrement';
      page1FirstDate: string;
      page1SecondDate: string;
      page1ThirdDate: string;
      survivesPagination: boolean;  // page 2 first date < page 1 last date
      monotonicallyDecreasing: boolean;
    } | null;                // null only when coverageStrategy is classifieds-adapter-only
    idJumpBefore: string;    // first product URL with default sort
    idJumpAfter: string;     // first product URL with proposed sort
  };
  watermarkMethod: 'api-date-since-watermark' | 'navigate-from-watermark' | 'full-catalog-sweep';
  watermarkMethodSelection: {
    reason: string;
    dateSourceForMethodA?: string;
    urlSortVerifiedForMethodB?: boolean;
    fallbackToMethodCReason?: string;
  };
};
```

**Responsibility:**
1. **Pagination** — test all 4 patterns (query / path / offset-query / suffix-replace),
   then run the 4-point verification for the winning pattern:
   - **Test A (silent-ignore):** first 3 products on page 1 vs page 2 — must differ.
   - **Test B (clamp-to-last):** first 3 products on page (N−1) vs page N — must differ.
   - **Test C (wrap-around):** first 3 products on page (N+2) vs page 1 — must NOT match.
   - **Test D (perPage sanity):** page (N−1) has exactly `perPage` products; page N has ≤ `perPage`.
2. **Sort** — read actual `<select>` HTML / `<a>` sort links, extract candidate
   params, verify via **date comparison** (not just ID-jump):
   - Preferred: API response returns per-product dates; page 1 first 3 dates are
     strictly decreasing.
   - Listing HTML: extract `datePublished` / posted-date / schema.org; verify same.
   - Fallback: fetch detail page of page 1 first product + page 2 first product,
     compare dates.
   - Counter-control: verify with a non-sort-default option (alphaasc / price-asc)
     returns a different order — distinguishes "sort honored" from
     "sort-is-default" (Mistake 29 three-outcome tree).
   - ID-jump alone is insufficient proof of direction — it only proves order changed.
3. **Watermark method selection:**
   - **Method A** if: API returns per-product dates AND supports `dateAfter=` filter.
   - **Method B** if: a sort (URL param or natural DOM order) is verified newest-first
     by date comparison, AND per-product dates are capturable (listing OR detail).
   - **Method C** if: no date source exists anywhere (listing, detail, sitemap lastmod,
     sourceId-autoincrement). Site will run full sweeps every cycle — acceptable
     but expensive.

**Pass criteria:** all 4 pagination tests pass; sort date-verification passes OR
Method C is selected with evidence that no date source exists; `watermarkMethod`
chosen with justification.

**Soft warn:** pagination only partially verified (e.g., `totalPages` unknown so
tests B/C can't run) — flag, proceed.

**Hard fail:** no pagination pattern works at all.

---

### 4.5 Room 5: Bootstrap (standalone utility)

**Input:** `NavigationState` (loaded from probe-output JSON)

**Output:**
```ts
type BootstrapState = NavigationState & {
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
    postDate: string;     // ISO timestamp — REQUIRED
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
```

**Responsibility:**
1. Load approved profile JSON (product of orchestrator post-Room-4).
2. Create the `MonitoredSite` DB row if it does not exist. (DB creation happens
   here, NOT in Room 1.)
3. Dispatch indexing by `coverageStrategy`:
   - **api-walk:** platform-specific API pagination (Shopify `/products.json`,
     WP REST + Store API two-pass, Ecwid `POST /catalog/search`).
   - **html-walk:** walk each `catalogUrl` via production `extractCatalogProducts`.
   - **hybrid:** API for count/URLs + HTML for metadata (BC Stencil pattern).
4. Per product, capture:
   - `url`, `title` — required.
   - `price` — required for `stockStatus=in_stock` products. If listing is missing
     price on an in-stock item, fetch detail page.
   - `date` (modified/published/created) — required for every product. If listing
     is missing date, fetch detail page.
   - `stockStatus`, `sourceId`, `thumbnail`, `tags` — best-effort.
5. Classify `productType` via existing classifier.
6. Upsert `ProductIndex` (unique by `siteId` + `url`).
7. Identify newest product (first in newest-first sort) and seed:
   - `site.lastWatermarkUrl = newestProduct.url` (DB column)
   - `site.crawlTuning.lastWatermarkDate = newestProduct.postDate` (JSON field)
8. Compute final drift. If ≤ 3%: set `isEnabled=true`, `nextCrawlAt=now()`, emit
   success report. If > 3%: leave `isEnabled=false`, emit failure report naming
   missing products and responsible categories.

**Pass criteria:**
- `finalDriftPct ≤ 3%`.
- Every in-stock product has `price` (non-null).
- Every product has `postDate` (non-null), OR the site was correctly classified
  as Method C with no date source anywhere.
- `lastWatermarkUrl` seeded.
- `lastWatermarkDate` seeded when Method A or Method B was chosen.

**Soft warn:** drift 3–5% — report but still set `isEnabled=true` if operator
confirms.

**Hard fail:** drift > 5% OR watermark-seed failed (no newest product could be
identified with a date).

**Explicitly NOT Room 5's job:**
- Running the tier engine (next scheduler tick picks up the site).
- Matching keywords (`matchNewProducts()` runs after tier engine sees products).
- Retrying individual failed products indefinitely (log + continue + report).

---

## 5. Data Flow

### 5.1 Cumulative typed state

Each room's output extends the previous room's output:

```
IntakeState
  ⊂ AccessIdentityState
     ⊂ GeographyCountState
        ⊂ NavigationState
           ⊂ BootstrapState
```

TypeScript enforces the dependency order at compile time. Any room's function
signature is `(previous) → current` with zero mutation.

### 5.2 Pipeline flow

```
URL → Room1 → IntakeState
     ↓
     Room2 → AccessIdentityState
     ↓
     Room3 → GeographyCountState
     ↓
     Room4 → NavigationState
     ↓
     orchestrator writes:
       - docs/pre-bootstrap-output/<domain>-profile.json  (full NavigationState)
       - docs/pre-bootstrap-output/<domain>-report.md     (human-readable)
     ↓
     [ HUMAN REVIEW — required ]
     ↓
     user grants permission → Claude runs: `npx tsx backend/scripts/bootstrap.ts <domain>`
     ↓
     bootstrap.ts loads profile.json → runs Room 5 → writes DB
     ↓
     site.isEnabled = true → next scheduler tick picks up the site
     ↓
     tier engine takes over
```

### 5.3 Orchestrator contract

`backend/scripts/pre-bootstrap.ts` is pure composition:

```ts
async function main(url: string) {
  const intake = await runRoom1(url);
  const access = await runRoom2(intake);
  const count  = await runRoom3(access);
  const nav    = await runRoom4(count);
  writeProfileJson(nav);
  writeHumanReport(nav);
}
```

No detection logic. No derived fields. No pickers. If a room returns
`{ roomFailed: true, reason, evidence }`, the orchestrator writes the failure
report and exits non-zero.

### 5.4 DB creation is deferred to Room 5

Per user decision: no DB row is created in Room 1. The profile JSON written after
Room 4 is the only artifact until bootstrap. This means a site that fails Rooms
1–4 leaves no trace in the DB — easy to re-run, no cleanup.

---

## 6. Watermark Method Selection Rule

### 6.1 Dates are mandatory

Per user decision: **dates are required for the pipeline to function.**

Rationale:
- Without a date source, sort=newest cannot be verified as actually newest-first
  (it can only be verified as "different from default").
- Without a date on the watermark product, the watermark's identity is fragile
  — it relies on URL-equality, which breaks the moment the site reorders products
  or changes URL slugs.
- The existing `watermark-crawler.ts` uses `lastWatermarkDate` as a fallback
  safety net; making it required eliminates a class of silent failures.

### 6.2 Date source priority (Room 4 + Room 5)

Check in order; first one that works wins:

1. **API date field** on every product (Shopify `published_at`, WP REST
   `modified`, Ecwid … no date, skip to next; WC Store API has per-product
   dates).
2. **Listing HTML date** (schema.org `datePublished`, posted-date classes,
   classifieds `.posted_date`).
3. **Detail-page date** (fetch detail page, extract date from body).
4. **Sitemap `<lastmod>`** when verified reliable (not regen-timestamped —
   check if 5 random entries share the same `<lastmod>`; if so, discard).
5. **`sourceId` auto-increment** (OpenCart `product_id`, WP `post_id`, Shopify
   `id`) — used as a pseudo-date ordering when no real date exists.

### 6.3 Method selection

| Condition | Method | Notes |
|---|---|---|
| API has date filter AND returns per-product dates (#1) | **A** | Fastest, gap-free |
| Any of #1–#5 yields per-product dates AND a newest-first sort can be verified | **B** | URL watermark + date safety net |
| None of #1–#5 yields dates | **C** | Full sweep every cycle; expensive but correct |

### 6.4 Detail-page enrichment (Room 5)

Room 5 enriches from detail pages when the listing source is missing required
fields. Strategy:

- **Batch by `catalogUrl`** — enrich all missing products from the same category
  in one scheduled batch. This amortizes WAF-cookie reuse (one cookie solve covers
  the whole batch) and lets the dispatcher reuse warm Playwright contexts when
  Playwright is in use.
- **Respect token budget** — reuse `token-budget.ts`. Bootstrap consumes from the
  same per-site hourly budget the tier engine uses, so the budget naturally
  prevents bootstrap from monopolizing the bucket and starving Tier 1 updates
  for already-bootstrapped sites running concurrently.
- **Concurrency ≤ 3** — meaning at most 3 detail-page HTTP fetches in flight at
  the same time **for one site**. Why 3 and not higher:
  - Most fleet sites run on shared hosts (LightSpeed, BC Stencil, custom PHP)
    that begin returning 503/429 between 4 and 8 concurrent requests from one
    client IP.
  - Cloudflare Bot Fight Mode and Sucuri rate-limit rules trigger on rapid
    bursts (heavy-probe Batch 3 documents this — 10 requests in 5s trips most
    rate-limit WAFs).
  - 3 concurrent matches the production crawler's safe ceiling and avoids
    needing site-specific tuning.
  - For sites with `requiresSucuri` or `hasRateLimit` flags set, drop to 1
    (sequential) — already enforced by `token-budget.ts` capacity calculation.
- **Per-product failure on enrich:** log + continue with the partial row written
  (best-effort); final drift check at Room 5 exit catches systemic failures.
  Single missing detail page does NOT halt bootstrap.

### 6.5 Per-stream watermark — known limitation, out of scope

For sites with multiple `catalogUrls` (most of the fleet — 12 BC Stencil sites
have 7-66 catalogUrls each), the existing tier engine stores **one** Tier-1
watermark at the site level (`MonitoredSite.lastWatermarkUrl`). Per-stream Tier-1
watermarks would let T1 track newest-product progress per category independently,
which matters when an aggregate newest-first URL doesn't exist or doesn't cover
all streams.

Verified by reading `backend/src/services/watermark-crawler.ts:380-419`: Method B
(navigate-from-watermark) calls `adapter.getNewArrivalsUrls()` which returns
candidate aggregate URLs (e.g., `/new-arrivals`, `/recent`, `/?orderby=date`),
walks them in order, breaks after the first one finds the watermark. Per-stream
watermark tracking is NOT implemented today.

Per-stream Tier 2-4 state (page ranges) IS implemented — see
`MonitoredSite.streamState` JSON and `backend/src/services/stream-detector.ts`.

**Decision for this spec:** per-stream Tier-1 watermarks are a tier-engine concern
and out of scope. Room 5 still bootstraps every catalogUrl correctly (it walks
all of them). Room 5 seeds **one** site-level watermark = the newest product
across all streams, so Method B continues to work for sites that have a working
aggregate newest-first URL. Sites where no aggregate newest-first URL exists
fall back to Method C (full-catalog-sweep), which is correct behavior under
the existing engine.

If/when per-stream Tier-1 watermarks are needed, the future feature requires
adding a `streamId` parameter to the watermark API and storing watermarks in
`streamState[streamId].watermarkUrl` — a separate design task.

---

## 7. Error Handling + Gating

### 7.1 Gate table

| Room | Pass | Soft warn | Hard fail |
|---|---|---|---|
| 1 | URL valid | — | URL malformed / localhost / private IP |
| 2 | `wafType` with evidence; `platform` with ≥1 marker; `accessMethod` fetches real HTML | medium-confidence flags | no access method works across full UA ladder |
| 3 | `drift ≤ 3%`; ≥1 catalogUrl; every catalogUrl returns products | drift 3–5% | drift > 5% OR no count method OR 0 catalogUrls OR tile-page category (Mistake 38) |
| 4 | all 4 pagination tests pass; sort date-verified OR Method C justified | pagination partial (tests B/C skipped when `totalPages` unknown) | no pagination works |
| 5 | `drift ≤ 3%`; price for in-stock; date for every product; watermark seeded | drift 3–5% | drift > 5% OR watermark seed failed |

### 7.2 Halt behavior

On hard fail:
1. Emit structured failure JSON with full state and per-room evidence.
2. Emit markdown report naming the failing room and the specific assertion.
3. Leave DB untouched (no partial row).
4. Exit non-zero (so CI / scripts detect failure).

### 7.3 Soft-warn behavior

Proceed to next room. Field the warning in the final `<domain>-report.md` under
a `Warnings` section. Human reviewing the report decides whether warnings block
enablement.

### 7.4 No auto-downgrade without evidence

If Room 4 selected Method A but Room 5 discovers dates aren't actually capturable,
Room 5 fails hard (not auto-downgrades). The discrepancy indicates Room 4's
date-verification was incomplete — rerun Room 4 with the enrichment signal, don't
silently pick a worse method.

---

## 8. Testing

### 8.1 Two-tier regression matrix

Two test sets — a fast "must-pass-before-commit" baseline and a comprehensive
"must-pass-before-milestone" fleet sweep. Both run live (no mocks).

#### Tier 1 — Smoke (5 sites, must pass before every commit that changes a room module)

| Site | Family | What's exercised |
|---|---|---|
| canadafirstammo.ca | WooCommerce + CF-passive | WP REST `x-wp-total`, Store API two-pass, OOS pass, Method A |
| aagcanada.ca | Shopify + CF-passive | `/products.json`, multilingual, `published_at` (not `created_at`) |
| theammosource.com | BC Stencil + CF-passive + OWASP | Sitemap multi-shard, BC sort-default gotcha, Mistake 29 counter-control |
| bullseyenorth.com | Celerant ColdFusion | HPE native-fetch fallback, `/orderby/` path sort, `?perpage=All`, CFID/CFTOKEN |
| gunpost.ca | Drupal classifieds + CF-active | Playwright WAF solve, facet URL trap, classifieds-gunpost adapter |

#### Tier 2 — Comprehensive fleet (24 sites, must pass before milestone close)

Every platform family in the fleet must be represented; every WAF vendor we have
detection for must have ≥1 live site.

**WooCommerce family (5 sites):**
| Site | Notable |
|---|---|
| canadafirstammo.ca | CF-passive baseline |
| doctordeals.ca | sgcaptcha + iPhone UA load-bearing |
| g4cgunstore.com | CF-passive, was wrongly disabled |
| gotenda.com | Sucuri WAF + 16K products + Mistake 38 sub-cat tile |
| thegundealer.ca | sgcaptcha PoW + waf-cookie-manager + 11K products |

**Shopify family (1 site — only one in fleet today):**
| Site | Notable |
|---|---|
| aagcanada.ca | CF-passive, multilingual |

**BigCommerce family (5 sites — Stencil and Blueprint variants):**
| Site | Notable |
|---|---|
| theammosource.com | BC Stencil, 48K sitemap, OWASP rules |
| firearmsoutletcanada.com | BC Stencil, retroactive platform correction |
| nordicmarksman.com | BC Stencil, `/categories.php` universal endpoint |
| store.theshootingcentre.com | BC Stencil, `?limit=50` honored |
| frontierfirearms.ca | BC Blueprint (legacy, NOT Stencil) |

**Magento family (3 sites — 1.x and 2.x):**
| Site | Notable |
|---|---|
| ellwoodepps.com | Magento 1.x, URL filter Mistake 11 |
| londerosports.com | Magento 2.x, sort value `new` (not `created_at`) |
| sail.ca | Magento 2.x + Searchspring overlay (hash sort) |

**LightSpeed family (3 sites — eCom and Classic):**
| Site | Notable |
|---|---|
| solelyoutdoors.com | LightSpeed eCom, `pageN.html` suffix-replace, Mistake 26 |
| gagnonsports.com | LightSpeed Classic, iPhone UA, suffix-replace fallback |
| jobrookoutdoors.com | Shoplightspeed (NOT Shopify), CF-passive |

**Other commerce platforms (8 sites):**
| Site | Family | Notable |
|---|---|---|
| bullseyenorth.com | Celerant ColdFusion | HPE, `/orderby/`, CFID cookies |
| canadasgunstore.ca | Activant/Epicor iNet | offset-query `?top=N` |
| northprosports.com | OpenCart | `?sort=p.date_added` (Mistake 21) |
| precisionoptics.net | Volusion | `?searching=Y` required (Mistake 24) |
| reliablegun.com | nopCommerce | CF-active, apex→www canonical |
| outfitters.goldnloan.com | Odoo | `?order=create_date+desc` literal `+` |
| lockharttactical.com | HikaShop on Joomla | apex challenged, www clean |
| durhamoutdoors.ca | CS-Cart legacy | `-N.html` suffix-replace, sort=4 |

**Custom + SPA + Wix + Ecwid (4 sites):**
| Site | Family | Notable |
|---|---|---|
| irunguns.ca | Custom PHP + jPages | client-side pagination, single-fetch |
| liangjian.ca | GoDaddy OLS SPA + mysimplestore | Playwright + internal API |
| surplusherbys.com | Wix Stores Thunderbolt | sub-cat pagination leak (Mistake 27) |
| triggersandbows.com | Ecwid-on-WordPress | Storefront API XHR-discovered |

**WAF coverage matrix (must include ≥1 site for each):**
| WAF vendor | Site |
|---|---|
| Cloudflare-passive | canadafirstammo.ca |
| Cloudflare-active | gunpost.ca, reliablegun.com |
| Sucuri | gotenda.com |
| SiteGround sgcaptcha | doctordeals.ca, thegundealer.ca |
| Akamai | (deferred — basspro/cabelas/canadiantire pending platform-detect inclusion) |
| MalCare (origin block) | dlaskarms.com (must correctly emit `wafType: 'malcare'` + permanent-limit verdict) |
| No-WAF baseline | northprosports.com |

### 8.2 Per-room unit tests with fixtures

- Each room folder has a `__test__/` directory with HTML/header fixture snapshots
  captured from the Tier-2 fleet.
- Each platform detector (in the registry) has its own fixture + test.
- Each WAF vendor detector has its own fixture + test (challenge body + headers
  captured).
- Unit tests call `runRoomN(fixture-input)` and assert the expected output fields
  + evidence shape.
- Unit tests run without live HTTP — fixtures committed to repo.

### 8.3 Full-pipeline dry-run harness

Two scripts in `backend/scripts/probe/__test__/`:

1. **`dry-run-smoke.ts`** — runs the full pipeline against the 5 Tier-1 sites
   live. Writes `<domain>-profile.json` for each. Asserts every one reaches "Room
   4 complete" without hard failures. Required before every commit that changes
   a room module.

2. **`dry-run-fleet.ts`** — runs the full pipeline against all 24 Tier-2 sites
   live. Writes `<domain>-profile.json` for each. Generates a single
   `fleet-report.md` summarizing pass/warn/fail per site. Required before
   milestone close (e.g., "Room 3 implementation complete", "Pipeline
   end-to-end complete").

Both scripts persist their output JSONs to `docs/pre-bootstrap-output/<run-id>/`
so historical dry-runs can be diff-compared across commits.

---

## 9. Cherry-Pick List from Reverted Code

After `git checkout backend/ package-lock.json` reverts the session's uncommitted
work, these proven pieces are lifted into the new structure. They are
re-implemented, not copy-pasted — the new room boundaries change their shape.

| From (current uncommitted) | To (new location) | Lift | Notes |
|---|---|---|---|
| `probe-access.ts` consistency guard (hasWaf↔wafType) | `room2-access-identity/waf-detect.ts` | ✓ | Drop-in |
| `probe-access.ts` CF active/passive uses desktop+iphone only | `room2-access-identity/waf-detect.ts` | ✓ | Critical fix |
| `probe-access.ts` Akamai detection (`server: AkamaiGHost`) | `room2-access-identity/waf-detect.ts` | ✓ | 3 Akamai sites in fleet |
| `probe-access.ts` MalCare body-detection | `room2-access-identity/waf-detect.ts` | ✓ | dlaskarms + future cases |
| `probe-access.ts` Sucuri / Incapsula UA-sweep overrides | `room2-access-identity/waf-detect.ts` | ✓ | Mistake 35 |
| `probe-access.ts` `resolveCanonicalOrigin()` www-fallback on challenge body | `room2-access-identity/canonical-host.ts` | ✓ | lockharttactical |
| `probe-access.ts` origin-rule exclusion | `room2-access-identity/waf-detect.ts` | ✓ | mod_security ≠ WAF |
| `probe-access.ts` COMPOSITE_RULES | `room2-access-identity/platform-detect.ts` | ✓ | Informative tags |
| `probe-fetch.ts` Redis cookie cache via `waf-cookie-manager` | `shared/redis-cookies.ts` + `shared/fetch.ts` | ✓ | Session's biggest win |
| `probe-fetch.ts` iPhone UA auto-switch on WAF-suspected | `shared/ua.ts` | ✓ | Mistake 30 Fix B |
| `probe-fetch.ts` native-fetch HPE fallback | `shared/fetch.ts` | ✓ | Celerant compatibility |
| `probe-platform.ts` XenForo + GoDaddy OLS static markers | `room2-access-identity/platform-detect.ts` | ✓ | Forum + SPA detection |
| `probe-platform.ts` API count extraction | `room3-geography-count/global-count.ts` | ✓ | Correctly scoped to R3 |
| `probe-sitemap.ts` static-mode XML fetch | `room3-geography-count/sitemap-parse.ts` | ✓ | No Playwright for XML |
| `probe-sitemap.ts` URL-pattern classification (CS-Cart, .html slugs, numeric-ID) | `room3-geography-count/sitemap-parse.ts` | ✓ | Broader coverage |
| `probe-sitemap.ts` WAF bail-out (all vendors) | `room3-geography-count/sitemap-parse.ts` | ✓ | Prevents pointless retries |
| `pre-bootstrap.ts` async `pickTestUrl` (Step 3d empirical extraction) | `room3-geography-count/catalog-urls.ts` | ✓ | Playbook-compliant |
| `pre-bootstrap.ts` `isLikelyNavUrl` | `shared/url-utils.ts` | ✓ | Generic utility |
| `pre-bootstrap.ts` `deriveProductCount` picker | ✗ DROP | — | Bandaid no longer needed |
| `pre-bootstrap.ts` transient-field stripper | `pre-bootstrap.ts` (new orchestrator) | ✓ | Clean JSON output |
| `probe-sort.ts` baseline-extraction passthrough | `room4-navigation/sort-detect.ts` | partial | Keep optimization, drop bolt-on shape |
| `playwright-fetcher.ts` cookie capture + sgcaptcha wait + iPhone UA opt | **stays in production code** | ✓ | Helps prod too — do not revert |
| `package.json` playwright-extra + stealth deps | ✗ DROP | — | Never integrated |

---

## 10. Out of Scope (explicit)

- **Tier engine changes.** `watermark-crawler.ts`, `catalog-crawler.ts`, and
  `stale-detector.ts` are not modified.
- **Per-stream Tier-1 watermarks.** Existing code stores one site-level Tier-1
  watermark; per-stream Tier-1 watermarks would be a tier-engine change. Out
  of scope (see §6.5 for the gap analysis).
- **DB schema changes.** No new columns. Reuse `MonitoredSite` columns +
  `siteProfile` / `crawlTuning` JSON fields.
- **Adapter changes.** `generic-retail.ts`, `shopify.ts`, `woocommerce.ts`, etc.
  are not modified. Room 5 calls them via the existing `extractCatalogProducts`
  + `fetchCatalogPage` interfaces.
- **New skills or agents.** The `pre-bootstrap` SKILL.md judgment layer will be
  updated after implementation to reflect the new room structure, but is not
  redesigned here.

**Note on price/date completeness:** Room 5's mandatory detail-page enrichment
(see §4.5 Step 4 + §6.4) guarantees that in-stock products have non-null `price`
and every product has non-null `date` when bootstrap exits. Therefore there is
no maintain-phase price-backfill mechanism to design — the gap doesn't exist.
If an in-stock product genuinely cannot have its price determined from listing
or detail page, that's a Room 5 hard fail (the site has not been bootstrapped
correctly), not a backlog item.

---

## 11. Appendix

### 11.1 Rollback reference

If implementation needs to restart from clean-slate:

```bash
git checkout backend/ package-lock.json

# Cleanup of scratch artifacts from previous session
rm -rf backend/scripts/pre-bootstrap-output/_*.md \
       backend/scripts/pre-bootstrap-output/_*.js \
       backend/scripts/pre-bootstrap-output/_*.json \
       backend/scripts/probe-modules/__test__/test-phase*.ts \
       backend/scripts/probe-modules/__test__/test-pre-bootstrap-*.ts \
       backend/scripts/probe-modules/_*.md \
       backend/get-ground-truth.js \
       backend/scripts/compare-before-after.js \
       backend/scripts/load-siteprofiles.js \
       backend/scripts/rerun-14.ts

# KEEP:
#   backend/scripts/pre-bootstrap-output/_remaining-issues.md  (user-owned)
#   .claude/probe-rewrite-lessons.md
#   .claude/catalog-url-discovery-playbook.md
#   .claude/agents/crawler-specialist.md
#   backend/src/services/scraper/playwright-fetcher.ts  (production cookie capture +
#                                                        sgcaptcha wait + iPhone UA
#                                                        changes stay — they help prod)
```

### 11.2 Success criteria for the rebuild

1. All 5 rooms implemented, each with `runRoomN` public entry and typed state.
2. Orchestrator `pre-bootstrap.ts` ≤ 150 lines (thin composition).
3. Bootstrap utility `bootstrap.ts` ≤ 200 lines.
4. **Tier-1 smoke regression passes on all 5 sites end-to-end** (canadafirstammo,
   aagcanada, theammosource, bullseyenorth, gunpost).
5. **Tier-2 fleet regression passes on all 24 sites end-to-end** before milestone
   close (see §8.1 Tier-2 fleet table).
6. Per-room unit tests cover ≥ 80% of branches.
7. `tsc --noEmit` clean after every room merge.
8. Final `<domain>-profile.json` for the 5 Tier-1 sites can be loaded by
   `bootstrap.ts` and indexes a site with drift ≤ 3%.
9. Detail-page enrichment in Room 5 produces `price` for every in-stock product
   and `date` for every product across the Tier-1 fleet.

---

## 12. Implementation Sequencing

High-level (detailed task breakdown happens in the implementation plan via
`superpowers:writing-plans`):

1. Set up `backend/scripts/probe/shared/` with `types.ts`, `fetch.ts`, `ua.ts`,
   `redis-cookies.ts`, `url-utils.ts`, `extract.ts`.
2. Room 1: intake (tiny, enables shape verification).
3. Room 2: access + identity, with detector registry. Tier-1 smoke at end.
4. Room 3: geography + count. Tier-1 smoke at end.
5. Room 4: navigation. Tier-1 smoke at end.
6. Orchestrator `pre-bootstrap.ts`. Full pipeline dry-run on Tier-1 smoke.
7. Room 5: bootstrap utility. Bootstrap 1 site end-to-end; verify DB state.
8. Bootstrap remaining Tier-1 sites; verify each.
9. Run Tier-2 fleet regression (24 sites) — milestone gate.
10. Update `.claude/skills/pre-bootstrap/SKILL.md` to reflect new structure.
11. Delete obsolete files (see §11.1 cleanup list).

Commit checkpoints: after each room's Tier-1 smoke passes + tsc clean.
Milestone gate: Tier-2 fleet regression passes before considering implementation complete.

---

**End of spec.**
