# Pre-Bootstrap Output — store.theshootingcentre.com

> **Result:** ready for operator review.
> 9 required + 7 recommended validator checks expected to pass. Cloudflare in front (rule-selective only), no CAPTCHA, no age-gate. **7,018 storefront-visible products** discovered across **7 top-level categories**. New-item watermark via `navigate-from-watermark` (`?sort=newest` honored, monotonic descending BC product IDs).

---

## At a glance

| What | Value |
|---|---|
| Site runs on | **BigCommerce Stencil** (uses `generic-retail` adapter) |
| Protections in front | Cloudflare **passive** (legitimate traffic unblocked; only honeypot/SQLi/XSS rule-selective 403s) — `hasCaptcha=false`, no age-gate |
| Catalog | **7,018 products** across **7 top-level categories** (in-stock storefront-visible; sitemap inflates to 16,985 by including OutOfStock) |
| Page walking | query-style → `?page={N}` · `perPage=100` |
| Sort | **`?sort=newest`** · verified honored via 3-outcome counter-control |
| New-item crawl | `crawlers.watermark.method = navigate-from-watermark` |
| Re-verify in maintain phase | `crawlers.maintain.verifyMethod = detail-page` (BC has no public batch product API) |

---

## Identity

The skill matched the homepage signals to **BigCommerce Stencil** via four independent markers: a `<meta name='platform' content='bigcommerce.stencil'>` declaration, the `cdn11.bigcommerce.com/s-stx5s5fhga` Stencil-storefront CDN host, the `x-bc-store-id: 1000882963` response header, and the `BC-Ray: 1` Stencil-edge marker. BC Stencil has no dedicated FA adapter, so it falls back to `generic-retail`.

| field | value |
|---|---|
| `platform` | `bigcommerce-stencil` |
| `adapterType` | `generic-retail` |

---

## Access — getting in safely

Cloudflare is in front of every response, but legitimate traffic is unblocked. Plain HTTP fetches with the default desktop UA succeed across all eight probe batches; no Playwright required.

| field | value | meaning |
|---|---|---|
| `hasWaf` | **`true`** | Cloudflare is in front (cf-ray on every response) |
| `wafType` | **`cloudflare-passive`** | rule-selective only; legitimate traffic 200 OK |
| `wafLastProbedAt` | `2026-05-09T14:10:05Z` | when the 8-batch probe ran |
| `wafProbeMethod` | `heavy-8-batch` | which probe method |
| `hasCaptcha` | **`false`** | no reCAPTCHA / hCaptcha / Turnstile in homepage HTML |
| `captchaType` | `null` | — |
| `ageGate.detected` | **`false`** | no interstitial age-confirmation gate |
| `userAgentOverride` | `null` | default desktop UA works |
| `needsPlaywright` | **`false`** | static HTML is enough |

> **Probe evidence** (`wafProbeEvidence`): every batch returned a `cf-ray` header (`server: cloudflare`, `cf-cache-status`, `__cf_bm` cookie). Legitimate batches were ALL 200: homepage, 4 different UAs (desktop / iPhone / `python-requests/2.31.0` / `curl/8.1.2`), a 10-request burst across cache-busted URLs, a barebones GET with no `Accept-Language` / `Accept-Encoding`, and an absent-UA GET. Cloudflare WAF rules fired on honeypot paths (`/wp-admin`, `/wp-login.php`, `/.env`, `/.git/config`, `/phpinfo.php`) and on the `?id=1 UNION SELECT 1,2,3` / `?q=<script>alert(1)</script>` payloads — all returned a 403 `<title>Attention Required! | Cloudflare</title>` page. None of these paths are touched during a normal catalog crawl, so the runtime classification is **passive**.

---

## Catalog discovery — where the products are

**`catalogUrls`** — 7 URLs, one per top-level category. Each carries the canonical `?sort=newest&limit=100` suffix so a single fetch is paginated newest-first at 100 products per page (5x faster than the default 20):

| Category | Products (walked) | URL |
|---|---:|---|
| Gear | **2,265** | `/gear/?sort=newest&limit=100` |
| Gun Parts & Accessories | 1,634 | `/gun-parts-accessories/?sort=newest&limit=100` |
| Firearms | 974 | `/firearms/?sort=newest&limit=100` |
| Ammunition | 964 | `/ammunition/?sort=newest&limit=100` |
| Optics Accessories | 625 | `/optics-accessories/?sort=newest&limit=100` |
| Optics | 501 | `/optics/?sort=newest&limit=100` |
| Reloading | 74 | `/reloading/?sort=newest&limit=100` |

**`topLevelCategories.totalsSumCheck`:**

> Sum of per-category walked counts = **7,037** across the 7 top-level categories above (limit=100, ?sort=newest).
> Walked unique = **7,018** — cross-category overlap is **19 products (0.27%)**.
> `/clearance` was excluded per the skill's filter-subset rule (overlaps with all other categories).
> BigCommerce `xmlsitemap.php` reports 16,985 product URLs across 3 pages, but probe-sampling 5 sitemap-only URLs showed all 5 are `availability="OutOfStock"`. BC Stencil category pages hide out-of-stock products by default, so the walked count (7,018) is the runtime-canonical inventory.

**`extractionSample`** — 3 sample products from `/firearms/` page 1 (positions 1, 10, 20), all 4 required fields populated:

| `title` | `price` | `stockStatus` |
|---|---:|---|
| Adler Arms RF-224 TAC Rifle, Black: 22 LR, 11.7" Barrel, Model RF224TACBLK | $449.00 | `in_stock` |
| Antique Galand Revolver: 380 Short CF, 3.75" Barrel, SER# 12184 | $2,600.00 | `in_stock` |
| Benelli ETHOS Upland A.I. Shotgun: 20 Gauge-3", 28" Barrel, Model 12651 | $3,730.00 | `in_stock` |

`extractionTested = true`.

---

## Pagination & sort — how to traverse

| field | value | meaning |
|---|---|---|
| `paginationPattern.type` | **`query`** | `?page=N` query param (not path-style) |
| `paginationPattern.template` | `page` | param NAME only — full URL is `<catalogUrl>&page=N` |
| `paginationPattern.perPage` | **`100`** | products per page (max selectable in `<select name="limit">`) |
| `paginationPattern.firstPageHasParam` | `false` | page 1 = the catalog URL bare (no `&page=1` needed) |
| `paginationPattern.startPage` | `1` | not zero-indexed |
| `paginationPattern.zeroIndexed` | `false` | — |
| `sortParam` | **`?sort=newest`** | query-form sort, baked into catalog URLs |
| `sortVerified` | **`true`** | proved honored via 3-outcome counter-control |

> **How sort was verified:** the BC Stencil `<select name="sort">` exposes `[featured, newest, bestselling, alphaasc, alphadesc, avgcustomerreview, priceasc, pricedesc]`. Default sort is `alphaasc` (alpha A-Z), NOT newest — exactly the BC Stencil false-negative case Mistake 29 warns about. Counter-control test on `/firearms/`: default first product = `adler-arms-rf-224-tac-rifle-black`; `?sort=newest` first product = `sako-90-finnlight-rifle-stainless-7mm-prc`; counter-control `?sort=priceasc` first product = `charles-daly-101-shotgun-vision-green`. All three differ → `?sort=newest` is honored. Pagination zero-overlap also confirmed: `/firearms/?sort=newest&page=2` returned 100 products entirely distinct from page 1.

---

## Inventory size

| field | value |
|---|---|
| `expectedProductCount` | **`7018`** |
| `productCountMethod` | `catalog-walk-only` |

> Derived by walking the 7 top-level catalog URLs at `?sort=newest&limit=100` until each category's last page returned a partial result. Per-category last pages: firearms p10=74, ammunition p10=64, optics p6=1, optics-accessories p7=25, gun-parts-accessories p17=34, reloading p1=74, gear p23=65. Total = 7,037 cards; unique = 7,018 (cross-category dupes = 19). The BigCommerce `xmlsitemap.php` reports 16,985 entries, but the extra 9,967 are OutOfStock products that BC Stencil category pages hide; the walked count is what the runtime crawler will actually see.

---

## Crawler config — runtime behavior

| Phase | field | value | what it means |
|---|---|---|---|
| **Tier 1 (new items)** | `crawlers.watermark.method` | **`navigate-from-watermark`** | paginate `?sort=newest` to find watermark, walk back to index new products |
| Bootstrap | `crawlers.bootstrap.apiEndpoints` | `null` | no public BC storefront API — pure HTML walk |
| **Maintain** | `crawlers.maintain.verifyMethod` | **`detail-page`** | each verify is a Playwright (or HTTP) detail-page fetch |
| Maintain | `crawlers.maintain.verifyEndpoint` | `null` | BC has no batch product API on the storefront |

> `crawlers.watermark.reason`: *BC Stencil exposes `?sort=newest` in the catalog page `<select name='sort'>`, verified honored via 3-outcome counter-control (default `alphaasc` → newest changed first product from 'Adler Arms RF-224' to 'Sako 90 Finnlight'; counter-control `priceasc` returned 'Charles Daly 101 Shotgun' — different from both). Page-1 vs page-2 zero-overlap confirmed. Newest-sort listing has monotonic descending product IDs (32503, 32488, 32487, 32486, 32485, 32484, 32483, 32482, 32481, 32480) usable as `sourceId` for navigate-from-watermark.*

---

## Platform extras

Both omitted — neither applies to a BigCommerce Stencil retailer:

| field | omitted because |
|---|---|
| `classifiedRules` | `adapterType` is not `classifieds-*` |
| `ecwidStoreId` | `platform` is not `ecwid-*` |

---

## Provenance

| field | value |
|---|---|
| `profileVersion` | `1` |
| `lastVerified` | `2026-05-09` |
| `auditNotes.runId` | `audit-2026-05-09T14-34-45Z` |
| `auditNotes.harnessVersion` | AI-driven, post-2026-04-27 pivot |
| `auditNotes.drivenByAIDirectly` | `true` |

**`auditNotes.fieldConfidence`** — every field's confidence level:

| field | confidence |
|---|---|
| `platform`, `adapterType` | verified |
| `hasWaf`, `wafType` | verified-via-8-batch-probe |
| `hasCaptcha`, `ageGate` | verified |
| `expectedProductCount`, `productCountMethod` | verified-via-walk |
| `catalogUrls` | verified-via-page1-dedup-walk |
| `paginationPattern` | verified-via-zero-overlap-test |
| `sortParam` | verified-via-3-outcome-counter-control |
| `extractionTested` | verified |
| `watermarkMethod` | verified-via-monotonic-product-id-and-sort |
| `maintainVerifyMethod` | derived-from-platform |

**`auditNotes.stageNotes`** — what happened at each of the 9 stages:

1. **Stage 1 (Canonical URL):** apex `https://store.theshootingcentre.com/` returned 200 cleanly with `<link rel="canonical" href="https://store.theshootingcentre.com/">`. The `www.` variant did not resolve (curl exit 6 ENOTFOUND). `canonicalOrigin = https://store.theshootingcentre.com`.
2. **Stage 2 (WAF + CAPTCHA):** heavy 8-batch probe ran cleanly with `cf-ray` on every response. All legitimate batches (1a homepage, 2a-2d UAs, 3 burst x10, 5 barebones, 8 noUA) returned 200. WAF rules fired on `/wp-admin`, `/.env`, `/.git/config`, `/phpinfo.php`, `?id=1 UNION SELECT...`, `?q=<script>alert(1)</script>` — all returned 403 with the Cloudflare "Attention Required" page. Classified as `cloudflare-passive` (legitimate traffic unblocked; rule-selective only). No CAPTCHA markers.
3. **Stage 3 (Platform):** `bigcommerce-stencil` identified by 4 multi-marker matches: `<meta name='platform' content='bigcommerce.stencil'>`, `cdn11.bigcommerce.com/s-stx5s5fhga` (Stencil store hash), `x-bc-store-id: 1000882963` response header, `BC-Ray: 1` header. `adapterType=generic-retail`. No age-gate detected. Maintain `verifyMethod=detail-page` (BC has no public storefront product API — `/api/storefront/products` returned 404).
4. **Stage 4 (Catalog URLs):** 8 top-level category candidates from homepage mega-nav (`navPages-action` "All X" links): firearms, ammunition, optics, optics-accessories, gun-parts-accessories, reloading, gear, clearance. `/clearance` dropped per skill rule (filter-subset). Page-1 dedup walk (`limit=100`): each of the 7 kept categories contributed 9.7%-13.1% NEW unique → all kept. Sub-segment paths (`/firearms/rifles`, etc.) NOT included to avoid mid-page overlap with their parent.
5. **Stage 5 (Pagination):** tested `?page=2` → returned 100 products entirely different from page 1 (zero-overlap confirmed). `paginationPattern.type=query`, `template='page'`, `perPage=100`, `firstPageHasParam=false`, `startPage=1`, `zeroIndexed=false`. `perPage=100` chosen as the highest selectable in the BC Stencil `<select name='limit'>`.
6. **Stage 6 (Sort):** `<select name='sort'>` exposed on catalog pages with options `[featured, newest, bestselling, alphaasc, alphadesc, avgcustomerreview, priceasc, pricedesc]`. Default = `alphaasc` (NOT newest — Mistake 29 BC Stencil false-negative warning is exactly relevant). 3-outcome test on `/firearms/`: default `Adler Arms RF-224`; `?sort=newest` `Sako 90 Finnlight`; counter-control `?sort=priceasc` `Charles Daly 101 Shotgun`. All differ → sort honored. `sortParam='?sort=newest'`, `sortVerified=true`.
7. **Stage 7 (Watermark method):** `navigate-from-watermark`. Reasoning: (a) sort verified honored upstream; (b) BC product IDs visible in `<img src>` URLs as `cdn11.bigcommerce.com/.../products/{N}/` — newest-sort firearms page 1 shows IDs 32503, 32488, 32487, 32486, 32485, 32484, 32483, 32482, 32481, 32480 (monotonically descending integer `sourceId`); (c) no public BC storefront API for date filtering.
8. **Stage 8 (Product count):** `catalog-walk-only`. Walked all 7 top-level categories at `limit=100` → 7,037 total cards, 7,018 unique URLs (cross-category overlap = 19 / 0.27%). BC `xmlsitemap.php` lists 16,985 unique `<loc>` entries but probe-sampled 5/5 sitemap-only URLs returned `availability="OutOfStock"`. BC Stencil category pages hide out-of-stock products by default, so the walked count is the runtime-canonical inventory. `expectedProductCount=7018`, `productCountMethod=catalog-walk-only`.
9. **Stage 9 (Assembly + validate):** all 9 stages ran in order; runtime fields populated; validator pass to be confirmed by operator. JSON written to `docs/site-audit/store.theshootingcentre.com-2026-05-09T14-34-45-000Z.json`; report written to .md sibling.
