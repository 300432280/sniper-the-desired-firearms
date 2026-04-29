---
name: pre-bootstrap
description: AI-driven per-site audit producing siteProfile JSON for operator review (NOT direct DB write)
---

# Pre-Bootstrap Site Onboarding

## Usage

```
/pre-bootstrap <url>
```

## Architecture

- **Orchestrator** (`backend/scripts/pre-bootstrap.ts`) runs 9 probe modules under `backend/scripts/probe-modules/` and emits ONE `PreBootstrapEvidence` blob — raw signals, no verdicts on what to store in the profile.
- **This SKILL is the judgment layer** — reads the evidence, applies 38 playbook Mistakes, produces the final `siteProfile` JSON.
- **Validation gate** (`backend/src/services/profile-validator.ts`) runs before the DB write and blocks on any `severity: 'required'` failure.

The orchestrator is intentionally thin. Platform-specific branching (`if platform === 'woocommerce' …`) belongs in THIS file, not in the modules. The modules emit structured, cross-referenceable evidence; the skill decides meaning.

## Design Principles (non-negotiable)

1. **Generic probes, domain-judgment in skill** — no firearm/gun/ammo keywords in the orchestrator or modules.
2. **Profile is single source of truth** — every site-specific quirk lives in the profile JSON. Never hardcode `if (domain === '...')`.
3. **Schema versioned** — every profile gets `profileVersion: 1`.
4. **Per-field confidence** — every judgment records `verified` / `inferred` / `default`.
5. **Validation gate before DB write** — required failures abort. No exceptions.
6. **`hasWaf` is a DB COLUMN** — `crawl-scheduler.ts:209,282,576` reads `site.hasWaf`, not `siteProfile.hasWaf`. Update BOTH.

## 6 Audit Phases (conceptual; mapped to 9 mechanical steps below)

| Phase | Name | Mechanical steps used |
|---|---|---|
| 0 | Read existing profile + canonical URL | Step 1 (orchestrator preamble) |
| 1 | WAF probe + platform detection | Steps 1-2 (`probe-access`, `probe-platform`) |
| 2 | API accessibility (NEW explicit phase) | Step 2 sub-judgment + extra curl probes (see Phase 2 detail below) |
| 3 | Catalog URL discovery | Steps 3-4 (`probe-sitemap`, `probe-catalog-urls`) |
| 4 | Pagination detection | Step 9 (`probe-pagination`) |
| 5 | Sort param + watermark method | Step 8 (`probe-sort`) + watermark decision table |
| 6 | Coverage verification + multi-method count cross-check | Steps 6-7 + count cross-check (NEW) |

Output: candidate siteProfile JSON written to `docs/site-audit/<domain>-<timestamp>.json` PLUS a sibling `<domain>-<timestamp>-evidence.json` with per-phase raw evidence. **The skill does NOT write to DB.** The downstream `audit-review-pipeline.ts` (Task 3) gates the DB write.

## 9-Step Process

### Step 1: Run the orchestrator

```bash
cd backend && npx tsx scripts/pre-bootstrap.ts <url> 2>/dev/null
```

Output: `backend/scripts/pre-bootstrap-output/<domain>.json` (also JSON to stdout).

The orchestrator runs modules in this dependency order:

| # | Module | Emits | Key evidence paths |
|---|--------|-------|--------------------|
| 1 | `probe-access` | canonicalOrigin, WAF verdict, UA sweep | `access.canonicalOrigin`, `access.hasWaf`, `access.wafType`, `access.recommendedUa`, `access.uaOverrideReason`, `access.playwrightRequired`, `access.robotsTxt.sitemapLines`, `access.wafEvidence.setCookieMarkers`, `access.wafEvidence.heavyProbeRawOutput` |
| 2 | `probe-platform` | marker list + API accessibility | `platform.markers[]`, `platform.topCandidates[]`, `platform.jsOverlayDetected[]`, `platform.generatorMeta`, `platform.apiEndpointsReachable.{wpJsonWcStore,wpJsonWpV2,shopifyProducts,bcGraphQL,ecwidStorefront,magentoRest}` |
| 3 | `probe-sitemap` | product-URL count + sample | `sitemap.totalProductUrls`, `sitemap.productUrlSample[]`, `sitemap.confidence` |
| 4 | `probe-catalog-urls` | nav/API/sitemap category candidates | `catalogUrls.candidates[]`, `catalogUrls.taxonomyApiReachable`, `catalogUrls.totalCandidates` |
| 5 | `pickTestUrl` (inline) | single testUrl for modules 6-9 | `testUrl`, `testUrlReason` |
| 6 | `probe-rendering` | static vs Playwright verdict | `rendering.needsPlaywright`, `rendering.verdict`, `rendering.reason` |
| 7 | `probe-extraction` | products, sort-select, pagination-marker | `extraction.productCount`, `extraction.productCountRaw`, `extraction.subcategoryTilesFound`, `extraction.hasSortSelect`, `extraction.sortSelects[]`, `extraction.paginationCandidates[]`, `extraction.fetchMethod` |
| 8 | `probe-sort` | sort scheme + ranked newest candidates | `sort.sortScheme`, `sort.sortOptions[]`, `sort.rankedNewest[]`, `sort.verdict`, `sort.newestCandidates[]`, `sort.alphaControlResult`, `sort.baselineFirstProduct` |
| 9 | `probe-pagination` | pattern object + zero-overlap proof | `pagination.paginationPattern`, `pagination.zeroOverlap`, `pagination.totalPagesObserved`, `pagination.page1ProductCount`, `pagination.verdict` |

Each module runs in try/catch — single-module failure does NOT abort the run. Check `evidence.moduleErrors[]` for any captured exceptions.

### Step 2: Validate evidence completeness

Before doing any judgment, confirm the evidence blob is usable:

- `evidence.moduleErrors` is empty (or only contains non-critical modules).
- `evidence.access.canonicalOrigin` present.
- `evidence.platform.markers.length > 0` OR `evidence.platform.topCandidates.length > 0`.
- `evidence.catalogUrls.totalCandidates > 0`.
- `evidence.extraction.productCount > 0` (unless `evidence.extraction.subcategoryTilesFound >= 5`, which is a known "walked to a tile-only parent" state — handled below).

If any fatal gap, stop and investigate the module that failed. Common causes: heavy-waf-probe.sh timing out on slow Cloudflare backends (extends Mistake 36 defect pattern — increase `HEAVY_PROBE_TIMEOUT_MS`), Playwright not installed (see `probe-fetch.ts`), site behind a challenge no module can bypass (fall back to Mistake 38 WAF-Playwright pattern).

### Phase 2 detail: API accessibility — explicit verification (NEW)

After `probe-platform` reports `apiEndpointsReachable.*`, run ONE additional verification curl per API your judgment plans to use. This catches Mistake 33 (subagent fabricated 405 on internationalshootingsupplies WP REST API).

| API | Verification curl | Expect |
|---|---|---|
| WP REST | `curl -sI '<base>/wp-json/wp/v2/product?per_page=1'` | 200 + `x-wp-total` header (number) |
| WC Store API | `curl -sI '<base>/wp-json/wc/store/v1/products?per_page=1'` | 200 + `x-wp-total` header (number) |
| Shopify | `curl -s '<base>/products.json?limit=1'` | JSON with `products[]` array (length 0 or 1) |
| Shopify count | `curl -s '<base>/products/count.json'` | JSON with numeric `count` field |
| Ecwid | `curl -s -X POST '<storefrontApiBase>/catalog/search' -H 'Content-Type: application/json' -d '{"lang":"en","pagination":{"offset":0,"limit":1}}'` | JSON with numeric `totalProductsCount` |
| BigCommerce GraphQL | `curl -sI '<base>/graphql'` | 200 (we use sitemap for count, but accessibility flags the path) |

**Record in evidence:** for each API your skill plans to depend on, the verification status code + first 200 bytes of body. If verification fails, do NOT silently downgrade adapter — flag it as a Phase 2 hard fail and abort.

**Reason this is its own phase:** Phase 1 detects markers; Phase 2 confirms accessibility. The two were conflated in earlier rooms (Room 2 + Room 3 both produced count via overlapping methods — see spec §1.1). Separating them avoids the Mistake 33 fabrication trap and the api-vs-html count drift trap.

### Step 3: Decide `adapterType`

Use this decision table. Apply rows top-down; first match wins.

| Condition (from evidence blob) | `adapterType` | Notes |
|---|---|---|
| `platform.markers` contains `woocommerce` AND `platform.apiEndpointsReachable.wpJsonWcStore.status === 200` with a valid `x-wp-total` | `woocommerce` | Standard WC — API-first |
| `platform.markers` contains `woocommerce` AND WP REST returns 307/403/challenge AND `access.wafType` is one of `sucuri`/`cloudflare-active`/`sgcaptcha`/`incapsula` | `woocommerce` | Keep the WC adapter — its `ensureCookies` solves WAF at runtime (Mistake 38). Do NOT downgrade to generic-retail. |
| `platform.markers` contains `shopify` AND `/products.json` returns 200 with products | `shopify` | Use `published_at` for date filtering (Mistake 32) |
| `platform.markers` contains `bigcommerce-stencil` OR `bigcommerce-blueprint` | `generic-retail` | BC Stencil: 3-outcome sort test (Mistake 29) |
| `platform.markers` contains `drupal` OR `drupal-commerce` AND homepage HTML contains `node--type-classified` / `gunpost-teaser` / `classified-teaser` | `classifieds-gunpost` | Generic Drupal-classifieds adapter (Mistake 37) |
| `platform.markers` contains `celerant-coldfusion` OR (`coldfusion` AND `access.wafEvidence.setCookieMarkers.cfid === true`) | `generic-retail` | Celerant has no open API (Mistake 36) |
| `platform.markers` contains `ecwid` | `generic-retail` + `apiAlternative.type: 'ecwid-storefront-api'` | Ecwid XHR pattern (Mistake 31) |
| `platform.markers` contains `magento-1.x` / `magento-2.x` / `opencart` / `volusion` / `lightspeed-ecom` / `odoo` / `wix-stores` / `godaddy-ols` / `aspnet` / `nopcommerce` | `generic-retail` | Platform-specific sort/pagination traps below |
| Otherwise | `generic-retail` | Most permissive fallback |

Forum/auction adapters (`forum-xenforo`, `forum-vbulletin`, `auction-hibid`, `auction-icollector`, `auction-generic`) are not covered by the orchestrator's retail-oriented modules — onboard those manually.

### Step 4: Build platform-specific profile fields (Mistake-by-field map)

For each field, the relevant Mistakes:

| Field | Mistakes | Evidence paths |
|---|---|---|
| `platform` | 22, 31 | `platform.markers[]`, `platform.topCandidates[0]`, `platform.generatorMeta` |
| `hasWaf` / `wafType` | 3, 23, 28, 30, 35 | `access.hasWaf`, `access.wafType`, `access.wafEvidence.headerServers[]`, `access.wafEvidence.setCookieMarkers` |
| `userAgentOverride` | 30 (Fix B) | `access.recommendedUa === 'iphone'` → set iPhone Safari UA string |
| `sortParam` | 2, 20, 21, 24, 25, 29, 32 | `sort.rankedNewest[0]`, `sort.sortScheme`, `sort.sortOptions[]`, `sort.verdict` |
| `paginationPattern` | 14, 26, 27, 37 | `pagination.paginationPattern`, `pagination.zeroOverlap` |
| `expectedProductCount` | 1, 13, 29, 37 | `platform.apiEndpointsReachable.wpJsonWcStore.xWpTotal`, `platform.apiEndpointsReachable.shopifyProducts.count`, `platform.apiEndpointsReachable.ecwidStorefront.totalProductsCount`, `sitemap.totalProductUrls`, `pagination.totalPagesObserved * perPage + lastPageItems` |
| `catalogUrls` | 4, 5, 12 (full coverage rule) | `catalogUrls.candidates[]` — do NOT drop small categories |
| `crawlers.watermark.method` | 8, 16, 17, 34 | derived from `sort.verdict` + API availability (table in Step 6) |
| `needsPlaywright` | 19, 38 | `access.playwrightRequired` OR `rendering.needsPlaywright` |

**Per-field confidence**: `verified` (proven via live test — Step 7 cross-checks), `inferred` (single evidence source, no contradicting signals), `default` (safe default, not tested).

### Step 5: When to write one-off UI-drive scripts

The modular probe cannot capture every site-internal XHR/JS signal. For these canonical cases, write a one-off Playwright harness BEFORE building the profile:

| Scenario | Evidence trigger | Reference script | Mistake |
|---|---|---|---|
| Ecwid-on-WordPress | `platform.markers` contains `ecwid` AND `platform.apiEndpointsReachable.ecwidStorefront.totalProductsCount > 0` | `backend/scripts/tb-real-ui4.ts` — click sort `<select id="ec-products-sort">`, capture `storefront-api/v1/<storeId>/catalog/search` POST body | 31 |
| Searchspring overlay | `platform.jsOverlayDetected` contains `searchspring` | Drive sort dropdown, capture `page.url()` hash fragment (`#/sort:field:dir`) | 25 |
| SiteGround sgcaptcha | `access.wafType === 'sgcaptcha'` | `backend/scripts/tgd-7tests.ts` — 7-test matrix proving iPhone UA + cookie replay | 30 |
| Klevu overlay | `platform.jsOverlayDetected` contains `klevu` | Playwright XHR capture against `eucs<N>.ksearchnet.com` (alflahertys precedent) | — |
| Custom SPA with no exposed sort | `rendering.needsPlaywright === true` AND `sort.sortScheme === 'js-only'` | `page.click()` sort dropdown, log `page.on('request', …)` | 19 |

These harnesses produce site-specific facts that the skill inlines into the profile (e.g., `ecwidStorefrontApiBase`, `searchspring` hash format). Do NOT ship the harness to production — it's a discovery tool.

### Step 6: Assemble the `siteProfile`

Target shape (required + strongly recommended fields):

```jsonc
{
  "profileVersion": 1,
  "platform": "<from platform.markers — vendor-specific tag>",
  "adapterType": "<from Step 3>",
  "hasWaf": <access.hasWaf>,
  "wafType": "<access.wafType>",
  "wafLastProbedAt": "<ISO now>",
  "wafProbeMethod": "heavy-8-batch",
  "wafProbeResult": "<one-line verdict>",
  "wafProbeEvidence": { /* subset of access.wafEvidence */ },
  "userAgentOverride": "<iPhone UA string if access.recommendedUa === 'iphone'>",
  "needsPlaywright": <access.playwrightRequired || rendering.needsPlaywright>,
  "expectedProductCount": <see Mistake map in Step 4>,
  "productCountMethod": "wp-rest-x-total | shopify-json | ecwid-storefront-api | sitemap | pagination-walk",
  "catalogUrls": [<from catalogUrls.candidates, full coverage>],
  "extractionTested": true,
  "sortParam": "<from sort.rankedNewest[0]>",
  "sortVerified": <sort.verdict === 'honored' || 'honored-default-is-newest'>,
  "perPage": <integer or null for API-only>,
  "paginationPattern": <pagination.paginationPattern>,
  "crawlers": {
    "watermark": {
      "method": "navigate-from-watermark | api-date-since-watermark | full-catalog-sweep",
      "reason": "<REQUIRED if full-catalog-sweep>"
    },
    "bootstrap": {
      "apiEndpoints": { /* adapter-specific */ }
    }
  },
  "lastVerified": "<ISO today>"
}
```

**Watermark method decision**:

| Condition | Method | Notes |
|---|---|---|
| WooCommerce + WP REST or Store API `after=` filter works | `api-date-since-watermark` | Verify fallback trigger (Mistake 34) |
| Shopify with `published_at` monotonic | `api-date-since-watermark` | Use `published_at`, NOT `created_at` (Mistake 32) |
| `sort.verdict === 'honored'` OR `'honored-default-is-newest'` + `pagination.zeroOverlap === true` | `navigate-from-watermark` | Set `sortParam` |
| Ecwid with `sortBy:'addedTimeDesc'` | `navigate-from-watermark` | Storefront API offset walk (Mistake 31) |
| No sort, no API date filter | `full-catalog-sweep` | MUST set `reason` |

Platform-specific additions: `ecwidStoreId`, `ecwidStorefrontApiBase`, `apiAlternative.bodyTemplate` (Ecwid); `wafWorkaround: { method: 'cookie-cache', cookieTtlMinutes: 30, ... }` (WAF sites); `wafWorkaround: { method: 'undici-fallback', ... }` (Celerant/ColdFusion).

### Step 7: Run the validation gate

```typescript
import { validateSiteProfile } from '../src/services/profile-validator';
const result = validateSiteProfile(profile);
if (!result.valid) {
  // result.failed contains all severity: 'required' failures
  // STOP — do not write to DB
}
```

The validator checks 16 fields (9 required + 7 recommended). Required failures abort the DB write. Recommended failures emit warnings but proceed.

Required checks: `platform`, `hasWaf`, `expectedProductCount`, `catalogUrls`, `paginationPattern`, `perPage`, `adapterType`, `crawlers.watermark.method`, `sortVerification` (sortVerified OR sortParam, unless `full-catalog-sweep` with `reason`).

### Step 8: Cross-reference platform-specific trap tables

Before declaring the profile done, confirm each evidence-path was checked against its platform's known quirks.

#### Sort traps

| Platform evidence | Trap | Rule | Mistake |
|---|---|---|---|
| `opencart` | `<select id="input-sort">` is incomplete; `p.date_added` works server-side but isn't listed | ALSO probe `p.date_added`/`p.product_id` via `sort.newestCandidates` ID-jump | 21 |
| `magento-2.x` / `magento-1.x` | Sort option values are merchant-customizable | Use `sort.sortOptions[].value` verbatim. Never assume `created_at` | 20 |
| `volusion` | Sort ignored without `searching=Y` | URL must include `searching=Y` + `sort=N` + `show=N` + `page=N` | 24 |
| `platform.jsOverlayDetected` contains `searchspring` | Real sort is hash fragment `#/sort:field:dir` | Bake hash into catalogUrl; `sortParam: ""` | 25 |
| `shopify` | Sort is `published_at`, not `created_at` | Test ALL timestamp fields for monotonicity | 32 |
| `bigcommerce-stencil` | Default = featured can equal newest → false negative | 3-outcome test: use `sort.alphaControlResult` counter-control | 29 |
| `celerant-coldfusion` | Sort is in URL PATH (`/orderby/<value>/`), not query. Multiple newest-style options. | `sort.sortScheme === 'path'`. `sort.rankedNewest[0]` is canonical — usually `new-arrivals` not `newest-rcvd` | 36 |
| `drupal` / `drupal-commerce` | Two URL forms expose same sort: `?sort_by=<col>&sort_order=DIR` (bare) vs `?sort=<col>&order=dir` (facet) | Prefer exposed-form on global URL. Re-read bare `/ads` sort if testUrl was facet-filtered | 37 |
| `rendering.needsPlaywright === true` + no sort `<select>` | Sort lives in JS, not markup | Write UI-drive script (Step 5) | 19 |
| `sort.sortOptions.length === 0` + custom PHP | "No sort UI" != "no sort possible" | Cross-reference DOM order against sitemap lastmod, POST endpoint baseline, etc. | 15, 18 |

#### Pagination traps

| Platform evidence | Trap | Rule | Mistake |
|---|---|---|---|
| `lightspeed-ecom` | `?page=N` silently ignored | `{type:'suffix-replace', match:'?sort=newest', template:'page{N}.html?sort=newest'}` — bake sort into BOTH match and template | 26 |
| `wix-stores` | Sub-category pagination leaks to global `/shop` | Use ONLY `/shop` with `?page=N` | 27 |
| `drupal` / `drupal-commerce` | 0-indexed + last page has partial items | `{type:'query', template:'page', zeroIndexed:true, firstPageHasParam:false}`. Total = `(totalPages - 1) * perPage + lastPageItems` | 37 |
| `volusion` | Pagination requires `searching=Y` alongside sort | Include `searching=Y` in URL | 24 |

Template format rules (Mistake 14): `{N}` is UPPERCASE, `query` type stores only param NAME (`'page'`, not `'?page={N}'`), `suffix-replace.match` is a literal string (not a regex).

#### Platform traps

| Platform evidence | Trap | Rule | Mistake |
|---|---|---|---|
| `bigcommerce-stencil` | Page-1 raw regex counts are ALWAYS double-render inflated | Use `extraction.productCount` (Set-deduped), NEVER `extraction.productCountRaw` | 29 |
| `celerant-coldfusion` | Malformed trailing-space headers break `undici` | `wafWorkaround: { method: 'undici-fallback' }` — `http-client.ts:344-347` handles it automatically | 36 |
| `ecwid` (any parent platform) | Parent categories in COLLAPSED view show subcategory tiles, not products | Always use leaf categories. `extraction.subcategoryTilesFound >= 5` is the diagnostic | 31 |
| `woocommerce` + `access.wafType` in JS-challenge set | Sub-category tile pages have no sort select (tile-only pages) | Walk deeper to leaf before sort/pagination testing. `extraction.subcategoryTilesFound` flags this | 38 |
| `godaddy-ols` / SPA | Static HTML returns 0 products but site renders in browser | Test `rendering.needsPlaywright` FIRST. Production `fetchWithPlaywright()` fallback auto-fires when static HTML >5KB returns 0 products | 19 |

#### Product count traps

| Source | Trap | Rule | Mistake |
|---|---|---|---|
| sitemap on classifieds | Sitemap lags live listing by 1-3 days | Use `productCountMethod: 'pagination-walk'`, NOT sitemap | 37 |
| sitemap any platform | Raw `<loc>` count over-counts (nav, feeds, categories) | `probe-sitemap` already filters via `NEGATIVE_PATTERNS`; trust `sitemap.totalProductUrls` not raw count | 1 |
| stored `expectedProductCount` on re-audit | Stale — never re-verified | Always re-derive from API/sitemap/walk. Never trust the stored value | 13 |
| BC Stencil page-1 extraction | `productCountRaw` doubles real count (hidden quick-view modal) | Use `extraction.productCount` (Set-deduped) | 29 |

#### WAF traps

| Evidence | Trap | Rule | Mistake |
|---|---|---|---|
| Stored `wafType: 'sucuri'` from pre-audit era | 0/3 verified correct in Batch B | Treat as UNVERIFIED. Check `access.wafEvidence.headerServers[]` + `setCookieMarkers` | 35 |
| Single 200 response | Cloudflare-passive is still CF (one flip = active) | Always use the 8-batch heavy probe (`access.wafEvidence.heavyProbeRawOutput` presence) | 23 |
| `access.wafType === 'sgcaptcha'` | Desktop UA gets 1 cookie (fails); iPhone gets 10 (works) | `userAgentOverride` MUST be iPhone Safari | 30 Fix B |
| DB=0 on existing site | Platform/WAF/notes fields are ALL suspect | Re-verify EVERY stored field against live HTML | 28 |

### Step 9: Output candidate JSON for review (NOT DB write)

The skill writes TWO files:

```bash
mkdir -p docs/site-audit
```

```javascript
const fs = require('fs');
const path = require('path');

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const domain = '<canonical-domain>';

fs.writeFileSync(
  path.join('docs', 'site-audit', `${domain}-${ts}.json`),
  JSON.stringify(profile, null, 2)
);

fs.writeFileSync(
  path.join('docs', 'site-audit', `${domain}-${ts}-evidence.json`),
  JSON.stringify(evidence, null, 2)
);

console.log(`Candidate profile written: docs/site-audit/${domain}-${ts}.json`);
console.log(`Run review pipeline:`);
console.log(`  npx tsx backend/scripts/audit-review-pipeline.ts docs/site-audit/${domain}-${ts}.json`);
```

**The skill terminates here.** DB writes happen ONLY after `audit-review-pipeline.ts` (Task 3) passes all 5 stages AND operator approves.

---

## All 38 Playbook Mistakes — Quick Reference

The judgment rules above are sourced from these Mistakes. See `.claude/catalog-url-discovery-playbook.md` for the full narrative. Persona-form lessons live in `.claude/agents/crawler-specialist.md`.

| # | Topic | Judgment rule |
|---|-------|---------------|
| 1 | Sitemap `<loc>` blind count | Filter to product URLs only (module does this via NEGATIVE_PATTERNS) |
| 2 | Guessing sort param names | Read `sort.sortOptions[]` verbatim; never guess |
| 3 | Stale `wafType` from notes | Re-verify every re-audit via heavy-probe |
| 4 | Dismissing categories by name | Never drop without product keyword search |
| 5 | Missing product categories | Start from taxonomy tree, not guesswork |
| 6 | Skipping retry on intermittent servers | Module 1 retries; skill trusts retry results |
| 7 | "Site is dead" on hard 403 | UA sweep tests 5 UAs; `access.playwrightRequired` covers the rest |
| 8 | Guessing page-1 = newest | `sort.verdict` + `pagination.zeroOverlap` required for `navigate-from-watermark` |
| 9 | catalogUrls are for HTML fallback | API-first sites still need catalogUrls |
| 10 | Hardcoding rotatable keys | Self-healing extraction from HTML only |
| 11 | Previous agent's diagnosis | Always verify against live HTML — don't inherit |
| 12 | Dropping a category by name | Three-part process: walk, filter, check uniqueness |
| 13 | Stored `expectedProductCount` | Always re-derive; never trust the stored value |
| 14 | Pagination template format | `{N}` uppercase, `query` type stores param name only |
| 15 | Client-side-paginated single page | jPages/bootpag detected → `paginationPattern: null` |
| 16 | AJAX rabbit holes | Plain GET first; don't chase embedded endpoints |
| 17 | Cursor not exposed | Cursor field must live in URL/HTML/API response |
| 18 | "No sort UI" != "no sort possible" | Cross-reference DOM order against independent signals |
| 19 | SPA without Playwright test | `rendering.needsPlaywright` + production `fetchWithPlaywright()` |
| 20 | Magento merchant-custom sort values | Read `sort.sortOptions[].value` verbatim |
| 21 | OpenCart hidden `p.date_added` | Also probe `p.date_added` via extraCandidates |
| 22 | Odoo generator meta + stored tags | Grep `platform.generatorMeta` + all markers before trusting stored `platform` |
| 23 | `hasWaf: false` from single 200 | Heavy 8-batch probe is mandatory |
| 24 | Volusion `searching=Y` | Required in URL for sort + pagination |
| 25 | Searchspring hash fragment | `#/sort:field:dir` — not a query param |
| 26 | LightSpeed `?page=N` silent ignore | `suffix-replace` with sort baked into match+template |
| 27 | Wix sub-category leak | Use ONLY `/shop` top-level |
| 28 | DB=0 stale-signal cascade | Re-verify platform + WAF + notes + sitemap + catalogUrls |
| 29 | BC Stencil inflation + false-negative sort | `productCount` not `productCountRaw`; 3-outcome test with alphaControlResult |
| 30 | SiteGround sgcaptcha + iPhone UA | `userAgentOverride` = iPhone; `waf-cookie-manager` waits for URL to leave challenge path |
| 31 | Ecwid `sortBy` camelCase | Drive Playwright UI to capture real API field names |
| 32 | Shopify `published_at` | Not `created_at` — test both for monotonicity |
| 33 | Subagent API claims | Verify with one curl before profile write |
| 34 | `apiCrawlUsed` flag | Trace `catalog-crawler.ts:292` flow for the specific empty-result failure mode |
| 35 | Stored `wafType: 'sucuri'` | 0/3 verified — treat all stored types as unverified |
| 36 | Celerant malformed headers + sitemap undercount | `undici-fallback`; use `<select id="perpage">` "All" option for count |
| 37 | Drupal classifieds facet trap + sitemap lag | Global URL, bare-form sort param, pagination-walk count |
| 38 | JS-challenge WAF + Playwright fallback | Keep WC adapter (runtime `ensureCookies`); `wafWorkaround.method: 'cookie-cache'`; walk past tile-only parents |

---

## Quick Validation Checklist

Before declaring a profile complete, all of these must be true:

- [ ] Heavy 8-batch probe ran (`access.wafEvidence.heavyProbeRawOutput` non-empty)
- [ ] Platform verified against `platform.markers[]` + `platform.generatorMeta` (not stored tag)
- [ ] Each API endpoint your judgment plans to use was independently re-verified with one curl (Phase 2)
- [ ] `expectedProductCount` derived from authoritative source (`platform.apiEndpointsReachable.*`, `sitemap.totalProductUrls`, or `pagination.totalPagesObserved * perPage + lastPageItems`)
- [ ] Every `catalogUrls` entry exists in `catalogUrls.candidates[]` or was manually added for full-coverage
- [ ] `extraction.productCount > 0` on the testUrl (or `subcategoryTilesFound >= 5` with a documented deeper catalogUrl)
- [ ] `pagination.zeroOverlap === true` on page 2
- [ ] `sort.verdict === 'honored'` OR `'honored-default-is-newest'` (or `full-catalog-sweep` with `reason`)
- [ ] If `access.recommendedUa === 'iphone'`: `userAgentOverride` set to iPhone Safari string
- [ ] `hasWaf` on BOTH DB column AND profile JSON
- [ ] `profileVersion: 1`, `lastVerified: <today>`
- [ ] `validateSiteProfile(profile).valid === true`

---

## File References

| File | Purpose |
|------|---------|
| `backend/scripts/pre-bootstrap.ts` | Orchestrator — composes 9 modules, emits evidence blob |
| `backend/scripts/probe-modules/probe-access.ts` | UA sweep, heavy WAF probe, canonical origin |
| `backend/scripts/probe-modules/probe-platform.ts` | Marker scan, API endpoint probes |
| `backend/scripts/probe-modules/probe-sitemap.ts` | Product-URL-filtered sitemap count |
| `backend/scripts/probe-modules/probe-catalog-urls.ts` | Nav/taxonomy/sitemap candidates |
| `backend/scripts/probe-modules/probe-rendering.ts` | Static vs Playwright verdict |
| `backend/scripts/probe-modules/probe-extraction.ts` | Products, sort-select, pagination-marker |
| `backend/scripts/probe-modules/probe-sort.ts` | Sort scheme + ID-jump ranked newest |
| `backend/scripts/probe-modules/probe-pagination.ts` | Pattern object + zero-overlap proof |
| `backend/scripts/probe-modules/probe-fetch.ts` | Shared fetch primitive with axios/native-fetch/Playwright escalation |
| `backend/scripts/heavy-waf-probe.sh` | 8-batch WAF probe (subprocess) |
| `backend/src/services/profile-validator.ts` | Validation gate (16 checks) |
| `backend/src/services/crawl-scheduler.ts` | Reads `site.hasWaf` DB column (lines 209, 282, 576) |
| `backend/src/services/catalog-crawler.ts` | `buildPaginatedUrl` (lines 118-166), HTML fallback (lines 327, 403-421) |
| `backend/src/services/watermark-crawler.ts` | Playwright fallback (lines 143-159) |
| `backend/src/services/scraper/adapters/generic-retail.ts` | `extractCatalogProducts`, `getNewArrivalsUrls` (lines 209-239) |
| `backend/src/services/scraper/waf-cookie-manager.ts` | Domain-agnostic WAF bypass (line 113+) |
| `backend/scripts/tb-real-ui4.ts` | Ecwid UI-drive discovery harness (Mistake 31) |
| `backend/scripts/tgd-7tests.ts` | sgcaptcha regression harness (Mistake 30) |
| `.claude/catalog-url-discovery-playbook.md` | Full playbook with all 38 mistakes |
| `.claude/agents/crawler-specialist.md` | Crawler persona with critical lessons |
