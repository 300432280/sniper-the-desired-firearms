# Pre-Bootstrap Output — store.theshootingcentre.com

> **Result: READY (calibration / R1 blind).** Validator 22/22 passed, score 100, zero warnings. BigCommerce Stencil store (Calgary Shooting Centre, store hash `s-stx5s5fhga`). Cloudflare **passive** (every probe 200, no challenge) → `hasWaf: false`. No CAPTCHA, no age-gate. **17,305 products** (re-counted from product sitemap; DB's 16,985 is ~1.9% stale-low, NOT a 41%-cap problem). 8 top-level categories. `?sort=newest` verified honored. `?page=N` pagination, `?limit=100` honored.

---

## 1. At a glance

| What | Value |
|---|---|
| Platform / adapter | **`bigcommerce-stencil`** → `generic-retail` (intentional override) |
| Protections | Cloudflare **passive** (`hasWaf: false`), no CAPTCHA, no age-gate |
| Catalog size | **17,305** products (product sitemap, re-counted) |
| Page walking | `?page=N` query pagination, **`perPage: 100`** honored |
| Sort | **`?sort=newest`** verified honored (monotonic descending IDs) |
| New-item crawl | **`navigate-from-watermark`** |
| Maintain verify | `detail-page` (Playwright) |

---

## 2. Identity

| field | value |
|---|---|
| `platform` | `"bigcommerce-stencil"` |
| `adapterType` | `"generic-retail"` |

BigCommerce Stencil confirmed by `x-bc-store-id: 1000882963`, `BC-Ray` header, `cdn11.bigcommerce.com/s-stx5s5fhga` CDN, `stencil/` asset paths, and `x-makeswift-page-locale` (Makeswift page builder). `adapterType` is `generic-retail` — the operator's intentional mapping (BC Stencil routes through generic-retail for stable HTML extraction); this matches the DB and is carried forward.

---

## 3. Access — getting in safely

| field | value | meaning |
|---|---|---|
| `hasWaf` | **`false`** | Cloudflare present but passive; flipping `true` would needlessly throttle the crawler |
| `wafType` | `"cloudflare-passive"` | informational; crawler routes on `hasWaf` only |
| `wafLastProbedAt` | `"2026-06-04"` | this run |
| `wafProbeMethod` | `"gentle-single-get-multi-ua"` | **heavy 8-batch probe deliberately skipped (IP-ban safety)** |
| `hasCaptcha` | `false` | no reCAPTCHA/hCaptcha/Turnstile in homepage HTML |
| `captchaType` | `null` | — |
| `ageGate.detected` | `false` | no age-verification interstitial |
| `userAgentOverride` | `null` | default UA works for all 4 production UAs |
| `needsPlaywright` | `false` | plain HTTP returns full product HTML |

> `cf-ray` + `__cf_bm` cookie + `cf-cache-status: DYNAMIC` present on every response; all 4 production UAs (Chrome 120, Firefox 121, Safari 17, iPhone) returned HTTP 200 on `/firearms/?page=2`. No challenge body, no 403/503. `rapidBurstTested: false` (gentle policy). hasWaf=false is from passive evidence only — operator must re-confirm from the production crawler IP before promotion.

---

## 4. Catalog discovery — where the products are

| category (top-level) | path |
|---|---|
| Firearms | `/firearms/` |
| Ammunition | `/ammunition/` |
| Optics | `/optics/` |
| Optics Accessories | `/optics-accessories/` |
| Gun Parts & Accessories | `/gun-parts-accessories/` |
| Reloading | `/reloading/` |
| Gear | `/gear/` |
| Clearance | `/clearance/` |

8 top-level categories from `/xmlsitemap.php?type=categories` (203 categories total; 8 single-segment top-level). BC Stencil parent categories **aggregate subtree products** — `/firearms/?limit=100` and `/ammunition/?limit=100` each render 100 products with multi-page pagers, confirming parents are not tile-only. All 8 are firearm-relevant. `totalsSumCheck`: sum-vs-sitemap (8 parents → 17,305) NOT walked under blind/gentle constraint — deferred to R2/R3.

**extractionSample:**

| url | title | price | stockStatus |
|---|---|---|---|
| `.../trijicon-bright-tough-night-sights-sig-sauer-8-front-8-rear/` | Trijicon Bright & Tough Night Sights – Sig Sauer #8 Front / #8 Rear | 135.00 | out_of_stock |
| `.../mossberg-590-shockwave-7-shot-shotgun-12-gauge-3-18-5-barrel-model-50639/` | Mossberg 590 Shockwave – 7-Shot Shotgun 12 Ga | 603.00 | in_stock |
| `.../skb-iseries-1209-mil-spec-pistol-case/` | SKB iSeries 1209 Mil-Spec Pistol Case | 129.00 | out_of_stock |

`extractionTested = true` (Stage 10 runtime-fetch simulation deferred; spot-check via product-detail JSON-LD/og passed for all 3).

---

## 5. Pagination & sort — how to traverse

| field | value | meaning |
|---|---|---|
| `paginationPattern.type` | `"query"` | `?page=N` |
| `paginationPattern.template` | `"page"` | param name only (BC standard) |
| `paginationPattern.perPage` | **`100`** | `?limit=100` honored (100 products rendered) |
| `paginationPattern.firstPageHasParam` | `false` | bare category URL is page 1 |
| `paginationPattern.startPage` | `1` | — |
| `paginationPattern.zeroIndexed` | `false` | — |
| `perPage` | `100` | mirrors paginationPattern.perPage |
| `sortParam` | `"?sort=newest"` | from `<select name="sort">` option `value="newest"` |
| `sortVerified` | **`true`** | 3-outcome counter-control |

> Sort verified via 3-outcome counter-control (cache-bust on `/ammunition/`): default (alphaasc) first-5 = `32687,26827,23223,23227,15929`; **`?sort=newest`** first-5 = `32782,32781,32780,32778,32769` (monotonic descending — newest-first); counter `?sort=pricedesc` first-5 = `30580,31964,31352,30789,31354`. All three distinct → `newest` is honored, not a NOOP. Pagination zero-overlap confirmed: `/firearms/?page=1` vs `?page=2` = 20 vs 20 product IDs, 0 overlap.

---

## 6. Inventory size

| field | value |
|---|---|
| `expectedProductCount` | **`17,305`** |
| `productCountMethod` | `{ method: "sitemap-index", urls: ["/xmlsitemap.php?type=products&page=1","&page=2","&page=3"] }` |

> Source: `/xmlsitemap.php` returns a sitemap index with 3 product sub-sitemaps. `type=products&page=1` = 3,132 `<loc>`, `page=2` = 9,997, `page=3` = 4,176 → **17,305 unique product URLs** (dedup confirmed; only 7 multi-segment entries). The customer-visible category HTML does not expose a clean catalog total; the sitemap is authoritative and includes OOS items (BC Stencil hides OOS on category pages). DB `expectedProductCount: 16,985` is ~1.9% low — the catalog grew since 2026-04-08, not a stale/wrong value and **not** a 41%-indexed cap of the true total.

---

## 7. Crawler config — runtime behavior

| Phase | field | value | what it means |
|---|---|---|---|
| Watermark | `crawlers.watermark.method` | `"navigate-from-watermark"` | paginate `?sort=newest` from page 1 backward to the watermark |
| Maintain | `crawlers.maintain.verifyMethod` | `"detail-page"` | Playwright per-product detail-page verify (non-WC platform) |
| Maintain | `crawlers.maintain.verifyEndpoint` | `null` | no batch API verify endpoint |

> Watermark reason: `?sort=newest` verified honored (first-5 product IDs `32782,32781,32780,32778,32769` descend monotonically); default `alphaasc` and counter `pricedesc` both differ from newest. Numeric `data-product-id` is a reliable newest-first proxy, so `navigate-from-watermark` is appropriate (no API date filter needed; BC `/products.json` not used).

---

## 8. Platform extras

| field | value |
|---|---|
| `classifiedRules` | omitted (not a classifieds site) |
| `ecwidStoreId` | omitted (not Ecwid) |
| `searchUrl` | not re-verified this run (DB has `/search?q={keyword}`; B3/B4 junk-keyword diff deferred to R2 — `/search.php` is robots-Disallowed) |

---

## 9. Provenance

| field | value |
|---|---|
| `profileVersion` | `1` |
| `lastVerified` | `2026-06-04` |
| `auditNotes.runId` | `w2r1-theshootingcentre-2026-06-03` |
| `auditNotes.mode` | `blind-round-1-calibration` |
| `auditNotes.probeIp` | audit IP (not production crawler IP) |

**fieldConfidence:**

| field | confidence |
|---|---|
| platform | high |
| adapterType | high (intentional BC→generic-retail override) |
| hasWaf | medium (passive CF, gentle probe only) |
| expectedProductCount | high (17,305 re-counted from sitemap) |
| catalogUrls | medium (parents aggregate; full ID-walk not done under blind constraint) |
| sortParam | high (counter-control + monotonic IDs) |
| perPage | high (`?limit=100` honored) |
| paginationPattern | high (page1/page2 zero overlap) |

**stageNotes:**
1. Stage 1 — apex returns 200 cleanly (Chrome 120); canonical = apex. robots.txt declares no `Sitemap:`; BC default `/xmlsitemap.php` used.
2. Stage 2 — Cloudflare passive (cf-ray, `__cf_bm`, DYNAMIC; 4/4 UAs 200 on paginated URL). No CAPTCHA/age-gate in 425 KB homepage. Heavy probe skipped (IP-ban safety).
3. Stage 3 — `bigcommerce-stencil` (x-bc-store-id, BC-Ray, cdn11/s-stx5s5fhga, stencil paths, makeswift). `generic-retail` adapter (DB-confirmed override). needsPlaywright=false.
4. Stage 4 — 8 top-level categories from category sitemap (203 total). Parents aggregate subtree (100 products/page, deep pagers). Extraction spot-check (3 products) all pass.
5. Stage 5 — `?page=N` query pagination; page1 vs page2 = 0 overlap. `?limit=100` honored (100 rendered).
6. Stage 6 — `?sort=newest` honored (3-outcome counter-control, cache-bust; monotonic descending IDs).
7. Stage 7 — `navigate-from-watermark` (sort honored + monotonic numeric IDs as newest proxy).
8. Stage 8 — `expectedProductCount = 17,305` (product sitemap: 3132+9997+4176; 17,305 unique). DB 16,985 ~1.9% low (catalog grew), not stale/wrong.
9. Stage 9 — candidate assembled; validator `valid: true`, score 100, 0 failures, 0 warnings. Stage 10 runtime-fetch simulation deferred (blind/gentle constraint).
