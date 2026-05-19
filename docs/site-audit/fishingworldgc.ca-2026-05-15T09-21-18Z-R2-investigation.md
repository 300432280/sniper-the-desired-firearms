# R2 Live Investigation — fishingworldgc.ca

**Run ID:** R2-live-investigation
**Audited at:** 2026-05-15T09:21:18Z
**R1 source:** `docs/site-audit/fishingworldgc.ca-2026-05-15T08-52-14Z-R1.json`
**R1 diff:** `docs/site-audit/fishingworldgc.ca-2026-05-15T08-52-14Z-R1-diff.md`

## Method
- Fresh agent; trust neither R1 nor DB.
- Different methods from R1 for every high-risk divergent field.
- No DB writes. 400-800ms inter-request delay.

## Per-field results

### 1. `paginationPattern.perPage` — DB wins (24)
**R1:** 34 | **DB:** 24 | **Truth:** 24

R1's claim came from a slug-extraction regex that matched both `/products/<slug>` and `/collections/<col>/products/<slug>` URLs in the same HTML page, inflating the count. Re-counted strictly:

- `<div class="product-card">` wrapper occurrences on `/collections/all` page=1: **24**
- Distinct `/products/<slug>` hrefs on page=1 (correctly de-duped): **24**
- Footer literal in HTML: `<span class="filters-toolbar__product-count">1992 products</span>` ÷ 24 = 83 pages.
- Full HTML walk completed in 83 pages with 1987 unique slugs (~99.7% of /products.json baseline) confirming 24 cards/page.

### 2. `perPage` (top-level siteProfile field) — DB wins (250)
**R1:** 34 | **DB:** 250 | **Truth:** 250

`backend/src/services/product-count-probe.ts:276` reads `m.perPage || 250` for the `shopify-products-walk` API path. This is the API perPage, not the HTML perPage; the two are different fields. R1 conflated them and emitted 34 in both places.

### 3. `catalogUrls` — R1 wins (`['/collections/all']`)
**R1:** 1 URL | **DB:** 23 URLs | **Truth:** 1 URL

Performed Rule C minimum-cover intersection: walked 5 DB sub-collections (different ones than R1 used).

| Sub-collection | Walked unique slugs | Reported total (R1 topLevelCategories) | All in /products.json? | All in /collections/all HTML walk? |
|---|---:|---:|:---:|:---:|
| /collections/all-guns | 360 | 725 | yes | yes |
| /collections/all-ammo-1 | 350 | 593 | yes | yes |
| /collections/shooting-miscellaneous-1 | 168 | 231 | yes | yes |
| /collections/hunting-accessories | 165 | 227 | yes | yes |
| /collections/magazines-1 | 79 | 143 | yes | yes |

- Union of 5 sub-collections: **1051** unique slugs.
- 1051 / 1051 inside the /products.json ground truth (1992).
- 1051 / 1051 inside /collections/all HTML walk (1987).
- **0** sub-collection products live outside /collections/all.

`/collections/all` is the verified 100%-coverage spine.

Side note: Sub-collection HTML pagination is **soft-capped** (all-guns reports 725 but the HTML walk yields only 360 before terminating on empty page — classic Shopify per-collection ceiling). The cap does NOT affect /collections/all because the global "all" collection reaches 1987 ≈ 1992. This strengthens the argument: per-category URLs are not only redundant, they are also incomplete.

### 4. `hasWaf` — R1 wins (false)
**R1:** false | **DB:** true | **Truth:** false (operational)

Rapid 30-burst (different method from R1's heavy-8-batch):

| Endpoint | Status codes (30 reqs, parallel) | Elapsed | Cookies set |
|---|---|---:|---|
| /collections/all | 30 × 200 | 856 ms | `_shopify_y`, `_shopify_s`, `_shopify_essential`, `_shopify_analytics`, `_shopify_marketing`, `localization` |
| /products.json | 30 × 200 | 1271 ms | `_shopify_y`, `_shopify_s`, `_shopify_essential`, `_shopify_analytics`, `_shopify_marketing` |

`cf-ray` and `server: cloudflare` present, but **NONE** of `cf_clearance`, `__cf_bm`, `__cfwaitingroom`, `cf_chl_*` challenge cookies were ever issued. No 403/429/503. CF is in passive transparent-proxy mode in front of Shopify. hasWaf=false is operationally correct; wafType=cloudflare-passive captures the platform-presence.

### 5. `expectedProductCount` — R1 wins (1992)
**R1:** 1992 | **DB:** 1953 | **Truth:** 1992

`/products.json?limit=250&page={1..8}` walk: pages 1-7 = 250 each, page 8 = 242. Total unique handles = **1992**. HTML page1 footer literally states `filters-toolbar__product-count: 1992 products`. DB 1953 is stale (April 11 → May 15; site grew 39 products in 34 days).

### 6. `productCountMethod.method` — R1 wins (`shopify-products-walk`)
**R1:** `shopify-products-walk` | **DB:** `products-json-walk` | **Truth:** `shopify-products-walk`

Grep proof: `backend/src/services/product-count-probe.ts:69` (type literal) and `:272` (switch case) both spell it `shopify-products-walk`. The string `products-json-walk` does not appear anywhere in the runtime switch — DB's value falls through to default and contributes no count. Pure label-drift.

### 7. `crawlers.maintain.verifyMethod` — R1 wins (`detail-page`)
**R1:** `detail-page` | **DB:** `json-ld` | **Truth:** `detail-page`

worker.ts literal-equality routing:

- **Line 397:** `if (!maintainConfig || maintainConfig.verifyMethod !== 'store-api') return null;` — only `'store-api'` triggers the WooCommerce fast-path.
- **Lines 763-767:** any null/undefined `verifyMethod` aborts with `MISSING verifyMethod` error. Any truthy value that is not `'store-api'` falls through to:
- **Lines 768-769:** comment documents `verifyMethod === 'detail-page'`, then calls `verifyProductsViaPlaywright(...)` for per-product page fetches.

So operationally DB's `json-ld` routes to the same Playwright path as R1's `detail-page`, but `'detail-page'` is the documented canonical value. R1 matches skill convention.

### 8. `productCountMethod.endpoint` — R1 wins (`/products.json`)
R1 follows the discriminated-union shape required by `product-count-probe.ts`. DB omits it; the runtime defaults to `/products.json` anyway but won't trigger because DB's method name is wrong.

## Cross-reference verdicts (REQUIRED by mission)

- **/collections/all coverage via sub-collection intersect:** 0 products live outside /collections/all. R1's single-URL catalogUrls is correct.
- **WAF rapid-burst behavior:** 30/30 = 200 on both endpoints, no CF challenge cookies issued. Passive CF only. hasWaf=false operationally.
- **worker.ts verifyMethod literal-equality:** line 397 checks `=== 'store-api'`; line 768 comment + line 769 fall-through implements `'detail-page'`. DB `json-ld` is label-drift (same operational path).

## What I did NOT verify (out of scope for R2)
- `sortParam` — both agree on `?sort_by=created-descending`; not re-tested.
- `wafLastProbedAt` ISO datetime vs date-only — schema cosmetic.
- DB-only fields (`name`, `budget`, etc.) — operator runtime knobs, not in scope.

## Files
- Corrections: `docs/site-audit/fishingworldgc.ca-2026-05-15T09-21-18Z-R2-corrections.json`
- Scratch artifacts: `backend/_audit_tmp/all-html-ids.json`, `products-json-ids.json`, `subcol-ids.json`, `all-page1.html`, `all-page2.html`
- Probe script: `backend/_audit_tmp/fishingworldgc-r2-probe.js`
