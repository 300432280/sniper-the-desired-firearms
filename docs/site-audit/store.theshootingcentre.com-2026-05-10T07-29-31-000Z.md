# Pre-Bootstrap Output — store.theshootingcentre.com

> **Result:** ready for operator review.
> 9/9 required + 7/7 recommended validator checks passed (score=100). Cloudflare passive WAF + rule-selective hardening (no challenge required), no CAPTCHA, no age-gate. **16,985 products** (sitemap-authoritative, OOS-inclusive) discovered across **8 top-level categories**.

---

## At a glance

| What | Value |
|---|---|
| Site runs on | **BigCommerce Stencil** (uses `generic-retail` adapter) |
| Protections in front | **Cloudflare passive** + rule-selective 403 on injection/honeypot paths; no challenge, no CAPTCHA, no age-gate |
| Catalog | **16,985 products** across **8 top-level categories** |
| Page walking | query-style → `?page={N}` · `perPage=100` (max `<select name="limit">` option) |
| Sort | `?sort=newest` (3-outcome counter-control verified honored) |
| New-item crawl | `crawlers.watermark.method = navigate-from-watermark` |
| Re-verify in maintain phase | `crawlers.maintain.verifyMethod = detail-page` (no public BC batch API) |

---

## Identity

The skill matched homepage signals to **BigCommerce Stencil** — `cdn11.bigcommerce.com/s-stx5s5fhga` asset prefix, `BC-Ray` response header, `x-bc-store-id: 1000882963`, and the `stencil-`-prefixed CSS class set. BC has no dedicated retail adapter in this codebase, so it falls back to `generic-retail`.

| field | value |
|---|---|
| `platform` | `"bigcommerce-stencil"` |
| `adapterType` | `"generic-retail"` |

---

## Access — getting in safely

8-batch heavy probe completed cleanly; Cloudflare is in front but operates in passive mode (no challenge, just header insertion). Honeypot paths and SQLi/XSS-shaped queries are blocked with 403 — that's Cloudflare's WAF Managed Rules acting on the URL/query, not a session challenge. Plain HTTP fetches with default desktop UA work; no Playwright required.

| field | value | meaning |
|---|---|---|
| `hasWaf` | **`true`** | Cloudflare in front |
| `wafType` | `"cloudflare-passive"` | header-only mode, no JS challenge |
| `wafLastProbedAt` | `"2026-05-10T07:19:28Z"` | when the 8-batch probe ran |
| `wafProbeMethod` | `"heavy-8-batch"` | which probe method |
| `hasCaptcha` | **`false`** | no reCAPTCHA / hCaptcha / Turnstile |
| `captchaType` | `null` | — |
| `ageGate.detected` | **`false`** | no interstitial age-confirmation gate |
| `userAgentOverride` | `null` | default desktop UA works |
| `needsPlaywright` | **`false`** | static HTML is enough |

> **Probe evidence** (`wafProbeEvidence`): every batch returned `cf-ray` and `cf-cache-status` headers and set the `__cf_bm` cookie. Batches 1, 2, 3, 5, 8 all 200 OK. Rapid burst (10 GETs in ~2s): 10/10 200. Batch 4 honeypot paths (`/wp-admin/`, `/wp-login.php`, `/.env`, `/.git/config`, `/phpinfo.php`) all return 403 (Cloudflare path-selective rules). Batch 6 UNION-SELECT and Batch 7 XSS-shaped query strings return 403 (Cloudflare rule-selective). No challenge body markers (`_cf_chl_opt`, `Just a moment...`), no `x-sucuri-id`, no `Incapsula incident ID`, no MalCare body marker. `botUaBlocked: false` (curl UA returns 200). Verdict: Cloudflare passive — keep default UA, no Playwright needed for catalog crawls.

---

## Catalog discovery — where the products are

**`catalogUrls`** — 8 URLs, one per top-level category from BC Stencil's `<ul class="navPages-list navPages-list--categories">`. Each URL bakes in `?sort=newest&limit=100` (canonical newest-first ordering at max per-page; runtime crawler appends `&page=N`).

| Category | In-stock count | URL |
|---|---:|---|
| Gear | **2,263** | `/gear/?sort=newest&limit=100` |
| Gun Parts & Accessories | 1,629 | `/gun-parts-accessories/?sort=newest&limit=100` |
| Firearms | 966 | `/firearms/?sort=newest&limit=100` |
| Ammunition | 962 | `/ammunition/?sort=newest&limit=100` |
| Optics-Accessories | 623 | `/optics-accessories/?sort=newest&limit=100` |
| Optics | 500 | `/optics/?sort=newest&limit=100` |
| Clearance | 146 | `/clearance/?sort=newest&limit=100` |
| Reloading | 74 | `/reloading/?sort=newest&limit=100` |

> **`topLevelCategories.totalsSumCheck`:**
>
> Sum of in-stock per-category counts (walked at `sort=newest&limit=100`) = **7,163**.
> Authoritative `bc-xmlsitemap` product count = **16,985**.
> Gap = 9,822 (~58%). The gap is OOS products — BC Stencil hides out-of-stock items from category listings by default, but `/xmlsitemap.php?type=products` includes ALL products. The 16,985 figure is the operator's chosen authoritative inventory size because OOS items must be tracked for restock alerts. `/clearance/` overlaps with the other categories at runtime (it's a sale-filter view); cross-category dedup happens via product URL during crawl indexing.

**`extractionSample`** — 3 products spot-checked from `/firearms/?sort=newest&limit=100` page 1 (positions 1, 50, 100). All 4 required fields populate; JSON-LD `availability` cross-confirmed:

| `title` | `price` | `stockStatus` |
|---|---:|---|
| Sako 90 Finnlight Rifle, Stainless: 7mm PRC, 24.5" Barrel, Model SYBX9969A1R37Y0 | $2,670.00 | `in_stock` |
| Ruger American Rifle Gen II Standard Rifle: 6mm Creedmoor, 20" Barrel, Model 46912 | $979.00 | `in_stock` |
| Tikka T3x Varmint Rifle, Stainless: 22-250 Rem, 23.7" Barrel, Model TFTT1352A73C9G6 | $2,425.00 | `in_stock` |

`extractionTested = true`.

> **Categories considered and dropped:** `/gunsmithing/` is a services info page (h1=Services, h2=Rifles/Pistols/Shotguns service descriptions, 0 product cards) — not a catalog URL. Brand-shortcut homepage links (`/browning/`, `/federal/`, `/hornady/`, `/leupold/`, `/magpul/`, `/sitka-gear/`, `/tikka/`, `/vortex-optics/`, `/weatherby/`, `/yeti/`) are brand-filter views overlapping with the per-category catalog list — dropped.

---

## Pagination & sort — how to traverse

| field | value | meaning |
|---|---|---|
| `paginationPattern.type` | **`"query"`** | standard `?page=N` query param |
| `paginationPattern.template` | `"page"` | param NAME only (per Mistake 14 — not `"?page={N}"`) |
| `paginationPattern.perPage` | **`100`** | max `<select name="limit">` option, verified honored |
| `paginationPattern.firstPageHasParam` | `false` | page 1 = bare catalog URL (no `&page=1` needed) |
| `paginationPattern.startPage` | `1` | not zero-indexed |
| `paginationPattern.zeroIndexed` | `false` | — |
| `sortParam` | **`"?sort=newest"`** | newest-first across the standard BC Stencil sort options |
| `sortVerified` | **`true`** | proved honored via 3-outcome counter-control |

> **How sort was verified (3-outcome counter-control test, `/firearms/`):**
> The `<select name="sort" id="sortsb">` exposed 8 options: `featured | newest | bestselling | alphaasc | alphadesc | avgcustomerreview | priceasc | pricedesc`. The default on `/firearms/` is `alphaasc` (selected attribute). Three fetches:
> - Default (no params) → first product `Adler Arms RF-224 TAC` (alpha A start, confirms `alphaasc` default)
> - `?sort=newest` → first product `Sako 90 Finnlight Rifle`
> - `?sort=alphadesc` (counter-control) → first product `Zastava Yugoslavian SKS 59/66` (alpha Z start)
>
> All three first-products differ → sort honored. This specifically defeats the BC Stencil "Mistake 29" trap where default = "Featured" can equal "Newest" by coincidence; here the default is `alphaasc`, the counter-control is the alpha-Z opposite, and the newest result is distinct from both.
>
> **Pagination zero-overlap test** (also on `/firearms/?sort=newest&limit=100`): page 1 first 3 = `Sako 90 / Franchi Momentum / Derya TM22`, page 2 first 3 = `Tikka T3x Tact A1 / Tikka T3x Hunter / Sako S20 Precision`, set-intersection of full p1 ∩ p2 product URL sets = **0 of 100**. Pagination honored.
>
> **perPage verification:** `<select name="limit" id="limitsb">` options: 8/12/16/20/40/100. Selected default 20. Fetched `?sort=newest&limit=100` and counted product cards via `<h4 class="card-title">` → exactly **100 cards** returned. Largest dropdown option is honored; perPage=100.

---

## Inventory size

| field | value |
|---|---|
| `expectedProductCount` | **`16985`** |
| `productCountMethod` | `"bc-xmlsitemap"` |

> **Source:** `/xmlsitemap.php` (sitemap index) lists 3 product sitemap pages — `type=products page=1/2/3`. Fetched all three; counted `<loc>` entries:
> - p1 = 3,132
> - p2 = 9,997
> - p3 = 3,856
> - **Total = 16,985**
>
> All `<loc>` entries have product-shape URLs (`/<slug>/` directly off the canonical origin); no category/brand/info-page URLs leak into the products sitemap. This count is OOS-inclusive — BC Stencil hides OOS from category listings (which is why the sum of walked per-category counts is only 7,163) but includes every product in `/xmlsitemap.php?type=products`. The OOS-inclusive number is the operator's chosen authoritative inventory size because OOS products must be tracked for restock alerts. Per the Stage 8 priority table, `bc-xmlsitemap` (#7) is preferred over `catalog-walk-only` (#12).

---

## Crawler config — runtime behavior

| Phase | field | value | what it means |
|---|---|---|---|
| **Tier 1 (new items)** | `crawlers.watermark.method` | **`"navigate-from-watermark"`** | paginate `?sort=newest&page=N` to find the watermark, then walk back to index new products |
| Bootstrap | `crawlers.bootstrap.apiEndpoints` | `null` | no public BC batch API — pure HTML walk |
| **Maintain** | `crawlers.maintain.verifyMethod` | **`"detail-page"`** | each verify is a Playwright/HTTP page fetch |
| Maintain | `crawlers.maintain.verifyEndpoint` | `null` | BC has no public batch product API |

> `crawlers.watermark.reason`: *BC Stencil has no public date-filter API (Storefront GraphQL is auth-gated). Sort=newest verified honored via 3-outcome counter-control on `/firearms/` (default alphaasc Adler vs newest Sako vs counter alphadesc Zastava — three distinct first-product slugs). Pagination `?page=N` zero-overlap verified between p1 and p2 with `sort=newest&limit=100`. `perPage=100` verified honored (max `<select name="limit">` option, returns exactly 100 cards on page 1).*

---

## Platform extras

| field | omitted because |
|---|---|
| `classifiedRules` | `adapterType` is not `classifieds-*` |
| `ecwidStoreId` | `platform` is not `ecwid-*` |

---

## Provenance

| field | value |
|---|---|
| `profileVersion` | `1` |
| `lastVerified` | `"2026-05-10"` |
| `auditNotes.runId` | `"audit-2026-05-10T07-29-31Z"` |
| `auditNotes.harnessVersion` | AI-driven, post-2026-04-27 pivot, calibration re-run with operator corrections |
| `auditNotes.drivenByAIDirectly` | `true` |

**`auditNotes.fieldConfidence`** — every field's confidence level:

| field | confidence |
|---|---|
| `platform`, `hasWaf`, `hasCaptcha`, `ageGate` | verified |
| `expectedProductCount` | verified-via-sitemap |
| `productCountMethod` | operator-mandated-bc-xmlsitemap |
| `catalogUrls`, `extractionTested` | verified |
| `paginationPattern` | verified-via-zero-overlap |
| `perPage` | verified-via-100-card-fetch |
| `sortParam` | verified-via-counter-control |
| `watermarkMethod` | verified |
| `maintainVerifyMethod` | derived-from-platform |

**`auditNotes.stageNotes`** — what happened at each of the 9 stages:

1. **Stage 1 (Canonical URL):** apex `store.theshootingcentre.com` returned 200 cleanly with no `<link rel="canonical">` override → `canonicalOrigin = https://store.theshootingcentre.com`.
2. **Stage 2 (WAF + CAPTCHA):** 8/8 baseline batches 200; rapid burst 10/10 200. `cf-ray` on every request → Cloudflare. Honeypot paths (`/wp-admin/`, `/wp-login.php`, `/.env`, `/.git/config`, `/phpinfo.php`) return 403 (Cloudflare path-selective). `UNION SELECT` and `<script>alert(1)</script>` query strings return 403 (Cloudflare rule-selective). No challenge bodies, no Sucuri/Incapsula/Akamai/MalCare markers. No CAPTCHA in homepage HTML. `wafType: "cloudflare-passive"`, `hasCaptcha: false`.
3. **Stage 3 (Platform):** identified BigCommerce Stencil from `cdn11.bigcommerce.com` asset prefix, `BC-Ray` response header, `x-bc-store-id: 1000882963`, and `stencil-`-prefixed CSS classes. No age-gate (homepage grep for age-verification markers returns 0 hits). Maintain `verifyMethod = detail-page`.
4. **Stage 4 (Catalog URLs):** 8 candidates from `<ul class="navPages-list navPages-list--categories">` `has-subMenu` entries — firearms, optics, ammunition, reloading, gun-parts-accessories, optics-accessories, gear, clearance. `/gunsmithing/` (services info page, 0 product cards) and brand-shortcut homepage links (`/browning/`, `/federal/`, `/hornady/`, `/leupold/`, `/magpul/`, `/sitka-gear/`, `/tikka/`, `/vortex-optics/`, `/weatherby/`, `/yeti/`) dropped. Extraction spot-check on 3 random firearms detail pages: all 4 fields populate, JSON-LD availability cross-confirmed. `extractionTested = true`.
5. **Stage 5 (Pagination):** `?page=N` query honored on `/firearms/?sort=newest&limit=100`. p1 vs p2 set-intersection = 0/100. `perPage=100` (max `<select name="limit">` option, verified by card count on returned page 1).
6. **Stage 6 (Sort):** `<select name="sort" id="sortsb">` exposed 8 options. Default on `/firearms/` is `alphaasc`. 3-outcome counter-control: default=Adler (alpha A), `?sort=newest`=Sako, counter `?sort=alphadesc`=Zastava (alpha Z). All three distinct → sort honored, `sortParam = "?sort=newest"`, `sortVerified = true`.
7. **Stage 7 (Watermark method):** Method A unavailable (no public date-filter API on BC). Method B (`navigate-from-watermark`) qualifies — Stage 6 honored + Stage 5 zero-overlap pagination + sort=newest monotonic.
8. **Stage 8 (Product count):** operator-mandated `bc-xmlsitemap` per Stage 8 priority order #7. Fetched `/xmlsitemap.php` index → 3 product sitemap pages (`type=products page=1/2/3`). `<loc>` counts: 3,132 + 9,997 + 3,856 = **16,985**. OOS-inclusive (required for restock alerts). `expectedProductCount=16985`, `productCountMethod="bc-xmlsitemap"`.
9. **Stage 9 (Assembly + validate):** validator passed 9/9 required + 7/7 recommended (score=100). Both artifacts written to `docs/site-audit/`.
