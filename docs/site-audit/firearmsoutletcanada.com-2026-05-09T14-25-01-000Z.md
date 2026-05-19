# Pre-Bootstrap Output — firearmsoutletcanada.com

> **Result:** ready for operator review.
> 9 required + 7 recommended validator checks populated. **Cloudflare-passive** in front (no active rules), no CAPTCHA, no age-gate. **3,414 products** indexed via BigCommerce sitemap; 13 top-level catalog URLs cover 87% directly with the remaining 13% reachable through the BC product sitemap.

---

## At a glance

| What | Value |
|---|---|
| Site runs on | **BigCommerce Stencil** (uses `generic-retail` adapter) |
| Protections in front | **Cloudflare-passive** only — no active rules, no CAPTCHA, no age-gate |
| Catalog | **3,414 products** across **13 top-level categories** |
| Page walking | query-style → `?page={N}` · `perPage=52` (configurable up to 1000 via `?limit=N`) |
| Sort | query-form → `sortParam="?sort=newest"` · verified honored via counter-control |
| New-item crawl | `crawlers.watermark.method = navigate-from-watermark` |
| Re-verify in maintain phase | `crawlers.maintain.verifyMethod = detail-page` (no batch API without auth) |

---

## Identity

The skill matched the homepage signals to **BigCommerce Stencil**. That platform doesn't have a dedicated adapter, so it falls back to `generic-retail` (which already carries Stencil card selectors).

| field | value |
|---|---|
| `platform` | `bigcommerce-stencil` |
| `adapterType` | `generic-retail` |

Strong fingerprints: `<meta name='platform' content='bigcommerce.stencil' />` in the `<head>`, `x-bc-store-id: 1003133358` response header, all assets served from `cdn11.bigcommerce.com/s-ezlzxhcsxg/stencil/...`, and `data-stencil-stylesheet` markers on every CSS link.

---

## Access — getting in safely

Cloudflare is in front (cf-ray on every response, `Server: cloudflare`) but only in passive mode. All 8 probe batches returned 200; honeypot 403s come from BigCommerce origin (552-byte error body), not from a CF rule. Plain HTTP fetches with default desktop UA work; no Playwright required.

| field | value | meaning |
|---|---|---|
| `hasWaf` | **`true`** | Cloudflare in front of the origin |
| `wafType` | **`cloudflare-passive`** | CDN routing only — no active blocking rules verified |
| `wafLastProbedAt` | `2026-05-09T14:09:25Z` | when the 8-batch probe ran |
| `wafProbeMethod` | `heavy-8-batch` | which probe method |
| `hasCaptcha` | **`false`** | no reCAPTCHA / hCaptcha / Turnstile |
| `captchaType` | `null` | — |
| `ageGate.detected` | **`false`** | no interstitial age-confirmation gate |
| `userAgentOverride` | `null` | default desktop UA works |
| `needsPlaywright` | **`false`** | static Stencil HTML is enough |

> **Probe evidence** (`wafProbeEvidence`): all 8 batches returned 200 OK with `cf-ray` and `Server: cloudflare` on every response. No challenge body, no `_cf_chl_opt`, no `x-sucuri-id`, no Incapsula cookies, no Akamai server header, no MalCare body marker. Rapid-burst (10 sequential GETs in ~2s) all 200 — no rate-limit. SQLi-shaped (`?id=1' OR '1'='1`) and XSS-shaped (`?q=<script>alert(1)</script>`) queries didn't trip any rules. Multi-UA (desktop, mobile, bot, curl) and no-UA all returned identical 200/446219-byte body. Honeypot paths (`/wp-admin/`, `/wp-login.php`, `/.env`, `/.git/config`) returned 403 with a tiny 552-byte response — that is BigCommerce origin's "unknown PHP path" reply, not a CF challenge. Verdict: Cloudflare in DNS/CDN mode only, no active WAF rules. High confidence.

---

## Catalog discovery — where the products are

**`catalogUrls`** — 13 URLs, one per top-level menu item (operator's `navPages-action` mega-menu structure). Each carries `?sort=newest` so the runtime crawler walks newest-first by default:

| Category | Products (page-walk, limit=1000) | URL |
|---|---:|---|
| Firearms | **928** | `/firearms?sort=newest` |
| Gear & Kit | 480 | `/gear-kit?sort=newest` |
| Ammo | 397 | `/ammo?sort=newest` |
| Rifle Parts | 318 | `/rifle-parts?sort=newest` |
| Optics | 196 | `/optics?sort=newest` |
| Shotgun Parts | 176 | `/shotgun-parts?sort=newest` |
| Magazines & Clips | 137 | `/magazines-clips?sort=newest` |
| Storage & Maintenance | 136 | `/storage-maintenance?sort=newest` |
| Emergency & Survival Gear | 106 | `/emergency-survival-gear?sort=newest` |
| Reloading | 95 | `/reloading?sort=newest` |
| Pistol Parts | 17 | `/pistol-parts?sort=newest` |
| Pre-Owned | 7 | `/pre-owned?sort=newest` |
| Sales & Clearance | (overlap aggregator) | `/on-sale?sort=newest` |

**`topLevelCategories.totalsSumCheck`:**

> Sum of per-category counts (excluding `/on-sale` aggregator) = **2,993** unique URLs across 11 cats.
> Union (de-duped) = **2,983** (≈ **0.3% cross-cat overlap** — very clean).
> BC sitemap (`xmlsitemap.php?type=products`) = **3,414**.
> Gap = **431 products** (~13%) live only in subcategories that the BC Stencil parent listing hides — verified by walking `/optics` (196 products) vs `/optics/binoculars` (19 products, only 9 of which appear on the parent). The breadcrumb on a missing product (`vortex-solo-r-t-8x36-tactical-monocular`) confirms `Home > OPTICS > Binoculars` hierarchy. Decision: keep the 13 top-level catalogUrls for runtime browse; rely on `bc-xmlsitemap` for authoritative count. Adding the 79 known sub/sub-sub categories would yield ~92 catalog URLs with high overlap and limited runtime value over a single sitemap fetch.

**`extractionSample`** — 3 products spot-checked from `/firearms` page 1 (cards 0, mid-25, 44), all 4 required fields populated:

| `title` | `price` | `stockStatus` |
|---|---:|---|
| CZ 600+ Alpha - 8x57 IS, 20" [6004-2011-REK1AAAX] | $1,299.95 | `in_stock` |
| Charles Daly Honcho Tactical Pump - 20GA, 14" Barrel [CF930.418] | $249.95 | `in_stock` |
| Sulun Arms SR-45 Revolver - .45 APC, 9.8", 5-shot [SR-45] | $1,099.95 | `out_of_stock` |

`extractionTested = true`. Stencil card markup is stable: title from `title=` attribute on `<a class="image-link desktop">`, price from `<span data-product-price-without-tax>`, stock from `out_of_stock_btn` class on the card's add-to-cart button.

---

## Pagination & sort — how to traverse

| field | value | meaning |
|---|---|---|
| `paginationPattern.type` | **`query`** | URL query param, not path |
| `paginationPattern.template` | `page` | param NAME only — the runtime appends `?page={N}` |
| `paginationPattern.perPage` | **`52`** | default products per page on Stencil category pages |
| `paginationPattern.firstPageHasParam` | `false` | page 1 = the catalog URL bare (no `?page=1` needed) |
| `paginationPattern.startPage` | `1` | not zero-indexed |
| `paginationPattern.zeroIndexed` | `false` | — |
| `sortParam` | **`?sort=newest`** | query-form sort fragment (BC Stencil convention) |
| `sortVerified` | **`true`** | proved honored via counter-control test |

> **How sort was verified:** BC Stencil's default sort is `featured`, which on this storefront coincidentally returns the same first 3 products as `?sort=newest` (a CZ 600+ Alpha series). The naive default-vs-newest comparison would falsely conclude "sort param ignored" (Mistake 29: the BC Stencil false-negative case). Counter-control swap test caught it — both `?sort=alphaasc` (first product = `adler-arms-ad500-...`) and `?sort=pricedesc` (first product = `beretta-dt11-sporting-...`) returned totally different first-3, proving the `sort` param IS honored. The page-1 vs page-2 zero-overlap test on `?sort=newest` also passed (52 unique products each, 0 intersection). Pagination AND sort both verified honored.

---

## Inventory size

| field | value |
|---|---|
| `expectedProductCount` | **`3414`** |
| `productCountMethod` | `bc-xmlsitemap` |

> Read directly from the site: `GET /xmlsitemap.php?type=products&page=1` returns 3,414 `<loc>` entries, every one of which is a product-shaped URL (`.html` or trailing-slash with hyphenated slug). BC's authoritative storefront-visible count. Reconciliation: walked-13-categories yielded 2,983 unique URLs (87% of sitemap); the 13% gap is subcategory-only products hidden on parent listings, NOT a cap-detection signal (Mistake 36 only fires when walked-count exceeds probe-count by ≥5% — this is the inverse).

---

## Crawler config — runtime behavior

| Phase | field | value | what it means |
|---|---|---|---|
| **Tier 1 (new items)** | `crawlers.watermark.method` | **`navigate-from-watermark`** | paginate `?sort=newest` newest-first to find watermark, then walk back to index new products |
| Bootstrap | `crawlers.bootstrap.apiEndpoints.productSitemap` | `/xmlsitemap.php?type=products&page=1` | full product URL list (3,414 entries) |
| Bootstrap | `crawlers.bootstrap.apiEndpoints.categorySitemap` | `/xmlsitemap.php?type=categories&page=1` | category structure (283 entries — includes brands/aliases) |
| Bootstrap | `crawlers.bootstrap.apiEndpoints.sitemapIndex` | `/xmlsitemap.php` | sitemap index (5 child sitemaps: pages, products, categories, brands, news) |
| **Maintain** | `crawlers.maintain.verifyMethod` | **`detail-page`** | each verify is a Playwright/HTML fetch of the product page |
| Maintain | `crawlers.maintain.verifyEndpoint` | `null` | BC GraphQL Storefront requires auth — no public batch product API |

> `crawlers.watermark.reason`: *Sort `?sort=newest` verified honored via counter-control swap (`?sort=alphaasc` and `?sort=pricedesc` each produce different first-3 from default; default coincidentally equals newest — Mistake 29 false-negative case caught). Pagination `?page=N` proved honored via zero-overlap test on `/firearms?sort=newest`. No public BC date-filter API available (Storefront GraphQL requires auth token).*

---

## Platform extras

Both omitted — neither applies to a BigCommerce Stencil retailer:

| field | omitted because |
|---|---|
| `classifiedRules` | `adapterType` is not `classifieds-*` |
| `ecwidStoreId` | `platform` is not `ecwid-*` |

Note: a Klevu JS search overlay (apiKey `klevu-170794377708517081`) is loaded for the on-site quick-search modal, but Klevu does NOT render category-page products — those come from server-rendered Stencil HTML. No Klevu-specific config needed.

---

## Provenance

| field | value |
|---|---|
| `profileVersion` | `1` |
| `lastVerified` | `2026-05-09` |
| `auditNotes.runId` | `audit-2026-05-09T14-25-01-000Z` |
| `auditNotes.harnessVersion` | AI-driven, post-2026-04-27 pivot |
| `auditNotes.drivenByAIDirectly` | `true` |

**`auditNotes.fieldConfidence`** — every field's confidence level:

| field | confidence |
|---|---|
| `platform`, `adapterType` | verified |
| `hasWaf`, `wafType`, `hasCaptcha`, `ageGate`, `needsPlaywright` | verified |
| `expectedProductCount`, `productCountMethod` | verified |
| `paginationPattern`, `extractionTested`, `perPage` | verified |
| `sortParam`, `sortVerified` | verified-via-counter-control |
| `catalogUrls` | verified-with-coverage-note (87% direct walk; 13% via sitemap) |
| `crawlers.watermark.method` | verified |
| `crawlers.maintain.verifyMethod` | derived-from-platform |

**`auditNotes.stageNotes`** — what happened at each of the 9 stages:

1. **Stage 1 (Canonical URL):** `https://www.firearmsoutletcanada.com/` 301-redirects to `https://firearmsoutletcanada.com/`; the homepage's `<link rel="canonical" href="https://firearmsoutletcanada.com/" />` confirms apex is canonical → `canonicalOrigin = https://firearmsoutletcanada.com`.
2. **Stage 2 (WAF + CAPTCHA):** 8/8 probe batches clean; `cf-ray` on every response → cloudflare-passive verdict. No reCAPTCHA / hCaptcha / Turnstile in homepage HTML. Honeypot 403s came from BigCommerce origin, not a WAF rule.
3. **Stage 3 (Platform):** identified BC Stencil from explicit `<meta name='platform' content='bigcommerce.stencil' />` + `x-bc-store-id` header + `cdn11.bigcommerce.com/s-ezlzxhcsxg/stencil/` asset URLs. No age-gate. Maintain `verifyMethod = detail-page` (no public batch product API on BC without auth).
4. **Stage 4 (Catalog URLs):** 13 candidates from operator's `navPages-action` mega-menu (firearms, ammo, optics, pistol-parts, rifle-parts, shotgun-parts, magazines-clips, gear-kit, emergency-survival-gear, storage-maintenance, reloading, on-sale, pre-owned). Per-category page-walk (limit=1000) yielded 2,993 sum / 2,983 union products (87% sitemap coverage). Brand-prefix URLs (`/brands/<vendor>`) and category aliases (`/9mm-luger`, `/45-acp`, etc.) excluded as filter-subset overlap. The 13% gap to sitemap is BC Stencil's subcategory-hiding theme behavior — sitemap remains authoritative for count.
5. **Stage 5 (Pagination):** `?page=N` query-form. Page 1 vs page 2 of `/firearms?sort=newest` zero-overlap confirmed (52 unique cards each, 0 intersection). `?limit=N` is also honored (limit=1000 returned all 928 /firearms products on page 1) — useful for bulk fetches but `perPage=52` is the operator-default.
6. **Stage 6 (Sort):** `<select name='sort' id='sort'>` exposes 8 BC Stencil sort options. Counter-control test (Mistake 29 false-negative case) confirmed `?sort=newest` IS honored — default Featured coincidentally matches, but `?sort=alphaasc` and `?sort=pricedesc` each shifted the first-3 products entirely. `sortParam = '?sort=newest'`, `sortVerified = true`.
7. **Stage 7 (Watermark method):** `navigate-from-watermark` — sort verified + pagination verified gives reliable newest-first walk. No BC date-filter API available without auth.
8. **Stage 8 (Product count):** `bc-xmlsitemap` — `/xmlsitemap.php?type=products&page=1` has 3,414 product-shaped `<loc>` entries; `?page=2` returns 404 (single sitemap page). Walked-categories = 2,983 (sub-set, NOT cap-detection scenario).
9. **Stage 9 (Assembly + validate):** 9/9 required + 7/7 recommended fields populated. profileVersion=1, lastVerified=2026-05-09. Calibration mode if site already has a DB row — operator runs the diff downstream.
