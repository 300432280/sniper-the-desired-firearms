# Pre-Bootstrap Output — shooterschoice.com

> **Result: READY (with one flagged surface-pairing tension).** Validator `valid: true` (9/9 required pass; 1 recommended-severity B8 warning). WooCommerce on WordPress, Cloudflare-passive (no active block on crawl path), no CAPTCHA gate, no age-gate. **True total product corpus = 11,409** (full admin/OOS-inclusive); **customer-visible = 4,518**. Sort verified, pagination verified, watermark = `api-date-since-watermark`.

---

## 1. At a glance

| What | Value |
|---|---|
| Platform / adapter | **woocommerce** / `woocommerce` |
| Protections | Cloudflare **passive** (no WAF block on crawl path), reCAPTCHA-v3 site-wide (not gating), no age-gate |
| Catalog size | **11,409 total corpus** (4,518 customer-visible; 6,891 OOS catalog-hidden) |
| Page-walking | path pagination `/page/{N}/`, **40/page** |
| Sort | `?orderby=date` — **verified honored** |
| New-item crawl | **`api-date-since-watermark`** (WP REST `modified_after`) |
| Maintain verify | **`store-api`** (`/wp-json/wc/store/v1/products`) |

---

## 2. Identity

| field | value |
|---|---|
| `platform` | `"woocommerce"` |
| `adapterType` | `"woocommerce"` |

Homepage carries `wp-content/plugins/woocommerce` (18 references) and Yoast sitemap. Default platform→adapter mapping (woocommerce → woocommerce); no override.

---

## 3. Access — getting in safely

| field | value | meaning |
|---|---|---|
| `hasWaf` | **`false`** | Cloudflare present but passive — catalog/API path always 200 |
| `wafType` | `"cloudflare-passive"` | informational; CF managed-rule path-selective only |
| `wafLastProbedAt` | `2026-06-03` | |
| `wafProbeMethod` | `"heavy-8-batch"` | |
| `hasCaptcha` | **`false`** | reCAPTCHA-v3 loads site-wide but does not gate catalog/API |
| `captchaType` | `"recaptcha-v3"` | informational (`api.js?render=` site key in homepage) |
| `ageGate.detected` | **`false`** | no age interstitial |
| `userAgentOverride` | `null` | all 4 production UAs returned 200 |
| `needsPlaywright` | **`false`** | plain HTTP returns full product markup + working APIs |

> Cloudflare `cf-ray` on every 200. `/shop/` returned 200 across Chrome/Safari/iPhone/Firefox and a 6x rapid burst (all 200). CF managed rules fire path-selectively on attack-shaped requests (`/.env` 403, `/.git/config` 403, `?s=<script>` 403) but the SQLi-shaped `?s='OR 1=1--` returned 200 and **no catalog or API path is blocked**. Setting `hasWaf:true` would needlessly drop perPage 50->20 and force Playwright — not warranted. NOTE: DB currently has `hasWaf:true` + `wafType:"wordfence-on-cloudflare-passive"`; live probe found no Wordfence body markers and no active block — see divergence table in the audit return.

---

## 4. Catalog discovery — where the products are

Top firearm-relevant departments (customer-visible counts via WC Store API categories; full 35-cat list in JSON):

| count | category path |
|---|---|
| 1065 | `/category/4027-accessories/` |
| 612 | `/category/4021-ammunition/` |
| 545 | `/category/4023-reloading/` |
| 484 | `/category/4022-firearms/` |
| 352 | `/category/4026-clothing/` |
| 347 | `/category/tbsbow-accessories/` |
| 315 | `/category/4030-optics/` |
| 196 | `/category/tbsbows/` |
| 113 | `/category/4031-knives-cutlery/` |

`totalsSumCheck`: `/shop/` HTML "of **4518** results" (113 pages x 40). `brand` (4,450) and `uncategorized` (424) are cross-cutting facets, excluded from the spine. **The HTML catalog path reaches only the 4,518 customer-visible products; the remaining 6,891 OOS products are catalog-hidden and reachable only via the WP REST / Store-API-bracketed surface.**

Extraction sample (via Store API, firearms dept):

| url | title | price | stockStatus |
|---|---|---|---|
| `.../used-winchester-90-22-wrf/` | USED WINCHESTER 90 .22 WRF | 1295.00 | in_stock |
| `.../used-winchester-67-22-lr-3/` | USED WINCHESTER 67 .22 LR | 195.00 | in_stock |

`extractionTested = true`.

---

## 5. Pagination & sort — how to traverse

| field | value | meaning |
|---|---|---|
| `paginationPattern.type` | `"path"` | `/page/{N}/` segment |
| `paginationPattern.template` | `"/page/{N}/"` | leading slash present (valid) |
| `paginationPattern.perPage` | `40` | WC theme default; no perPage UI override |
| `paginationPattern.firstPageHasParam` | `false` | |
| `paginationPattern.startPage` | `1` | |
| `paginationPattern.zeroIndexed` | `false` | |
| `sortParam` | `"?orderby=date"` | "Sort by latest" |
| `sortVerified` | **`true`** | |

> Sort verified via 3-outcome + cross-surface: HTML `/shop/` default (`menu_order`) first post-ids `106425, 121508, 125088`; `/shop/?orderby=date` first post-ids `264838, 264836, 264835` (descending = newest). The HTML date-sort first id (264838) **matches the Store API `orderby=date&order=desc` first id (264838)** — sort honored, not NOOP. Pagination: `/shop/page/2/` first id `263613`, disjoint from page 1.

---

## 6. Inventory size

| field | value |
|---|---|
| `expectedProductCount` | **`11409`** |
| `productCountMethod` | `{method:"wp-rest-header", endpoint:"/wp-json/wp/v2/product", header:"x-wp-total"}` |

> **TRUE TOTAL = 11,409.** Live `GET /wp-json/wp/v2/product?per_page=1` -> `x-wp-total: 11409`. Cross-confirmed: Store API bracketed all-statuses (`stock_status[0]=instock&[1]=outofstock&[2]=onbackorder`) -> `x-wp-total: 11409`. Breakdown: in-stock 4,414; out-of-stock 6,891; Store API default (customer-visible) 4,518. The prior "~62% coverage" observation is the customer-visible HTML surface (4,518) measured against the full corpus — NOT a missing-products gap. **Surface-pairing caveat (B8):** with `verifyMethod:store-api`, the validator recommends pairing the count endpoint with the Store API surface (which would yield 4,518). The candidate keeps 11,409 (the true total) to match the DB; R2/R3 must adjudicate the count-surface vs verify-surface pairing — see `auditNotes.validatorB8Flag`.

---

## 7. Crawler config — runtime behavior

| Phase | field | value | what it means |
|---|---|---|---|
| watermark | `crawlers.watermark.method` | **`api-date-since-watermark`** | WP REST `modified_after` filter |
| watermark | `crawlers.watermark.dateFilterField` | `modified_after` | catches restocks + price changes |
| maintain | `crawlers.maintain.verifyMethod` | `store-api` | batch API verify |
| maintain | `crawlers.maintain.verifyEndpoint` | `/wp-json/wc/store/v1/products` | |

> Watermark `api-date-since-watermark` verified via two-probe: `modified_after=2099-01-01` -> `x-wp-total: 0`; `modified_after=1999-01-01` -> `x-wp-total: 11409`. Filter honored on WP REST core.

---

## 8. Platform extras

| field | value |
|---|---|
| `classifiedRules` | n/a (not a classifieds site) |
| `ecwidStoreId` | n/a (not Ecwid) |
| `searchUrl` | `/?s={keyword}&post_type=product` (WP/WC default; NOT junk-diff-tested this run — verify in R2) |

---

## 9. Provenance

| field | value |
|---|---|
| `profileVersion` | `1` |
| `lastVerified` | `2026-06-03` |
| `auditNotes.runId` | `R1-blind-2026-06-03` |
| `auditNotes.probeIp` | audit IP (re-confirm WAF from production IP before promotion) |

`fieldConfidence`: platform/adapterType/hasWaf/expectedProductCount/sortParam/paginationPattern/watermark = **high**; catalogUrls = **medium** (`/shop/` covers customer-visible 4,518; full corpus needs the API path).

Stage notes:
1. Canonical — apex 200, www 301->apex; `<link rel=canonical>`=apex. robots Sitemap=`/sitemap_index.xml`.
2. WAF — Cloudflare-passive; honeypot/XSS path-selective 403s; catalog path clean across 4 UAs + burst. reCAPTCHA-v3 site-wide, non-gating.
3. Platform — WooCommerce (18x plugin refs). adapterType woocommerce. needsPlaywright false (plain HTTP works).
4. Catalog — 35 top-level cats; `brand`/`uncategorized` are facets; `/shop/` = customer-visible spine (4,518). Full corpus 11,409 only via API.
5. Pagination — path `/page/{N}/`, perPage 40; page-2 disjoint from page-1.
6. Sort — `?orderby=date` honored (HTML id 264838 == Store API date-desc id 264838; != menu_order default).
7. Watermark — `api-date-since-watermark` (WP REST modified_after two-probe 0/11409).
8. Count — 11,409 (WP REST x-wp-total == Store API bracketed all-statuses). Customer-visible 4,518.
9. Assembly — validator valid:true; 1 recommended B8 surface-pairing warning documented for R2/R3.
