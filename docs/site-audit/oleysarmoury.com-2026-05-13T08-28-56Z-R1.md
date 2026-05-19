# Pre-Bootstrap Output — oleysarmoury.com

> **Result:** ready for operator review (R1 blind run). Validator: all 9 required fields present. **No WAF**, **no CAPTCHA**, **no age gate**. Platform = **BigCommerce Stencil** (`x-bc-store-id: 1000335807`). Catalog = **3,482 products** across **18 top-level catalog URLs**. Sort = `?sort=newest` (default order IS newest). perPage = 100 honored. Watermark method = `navigate-from-watermark`.

---

## 1. At a glance

| What | Value |
|---|---|
| Platform / adapter | **`bigcommerce-stencil`** -> `generic-retail` |
| Protections | **No WAF (Cloudflare-passive)**, no CAPTCHA, no age gate |
| Catalog size | **3,482** products across **18** top-level categories |
| Page walking | `?page=N` query, perPage **100** (honored end-to-end) |
| Sort | `?sort=newest` — default IS newest |
| New-item crawl | `navigate-from-watermark` |
| Maintain verify | `detail-page` (no BC GraphQL token leaked) |

---

## 2. Identity

| field | value |
|---|---|
| `platform` | `"bigcommerce-stencil"` |
| `adapterType` | `"generic-retail"` |

Homepage declares `<meta name='platform' content='bigcommerce.stencil' />` and `x-bc-store-id: 1000335807`; `cdn11.bigcommerce.com/s-6j8taxjw04` references everywhere; `BCData` JS global. Per skill platform-to-adapter table, BC Stencil routes to `generic-retail` (the `.card` selector in `generic-retail.ts:67` handles BC Stencil product cards).

---

## 3. Access — getting in safely

| field | value | meaning |
|---|---|---|
| `hasWaf` | **`false`** | Cloudflare-passive only; not actively blocking. Operational decision per skill rule. |
| `wafType` | `"cloudflare-passive"` | Informational. cf-ray on every probe, no challenges. |
| `wafLastProbedAt` | `"2026-05-13T08:19:34Z"` | 8-batch heavy probe |
| `wafProbeMethod` | `"heavy-8-batch"` | |
| `hasCaptcha` | **`false`** | No reCAPTCHA/hCaptcha/Turnstile script tags found |
| `captchaType` | `null` | |
| `ageGate.detected` | **`false`** | No "I am 18 or older" / DOB / `age_verified=` cookie |
| `userAgentOverride` | `null` | Default Chrome desktop UA works |
| `needsPlaywright` | **`false`** | Plain curl returns 368KB of product cards on homepage; static HTML extraction works |

> 8-batch heavy probe: BATCH 1 headers show `Server: cloudflare`, `cf-ray`, `cf-cache-status: DYNAMIC`, no `x-sucuri-*`, no `Incapsula`. BATCH 2-3 multi-UA + 10-burst all returned 200 in ~0.2-0.5s. BATCH 4 honeypots: `/wp-admin /wp-login.php /.env /.git/config` -> 403 (BigCommerce origin response — those paths never exist on a BC store; not a CDN challenge). `/xmlrpc.php /phpinfo.php` -> 404 (standard BC 404 template). BATCH 5-8 (no-UA, SQLi, XSS, no-encoding) all clean 200. No body-level WAF markers (MalCare/Wordfence/sgcaptcha/Incapsula).

---

## 4. Catalog discovery — where the products are

| catalog URL | walked unique products |
|---|---:|
| `/firearms/` | 571 |
| `/ammunition/` | 836 |
| `/optics/` | 381 |
| `/accessories/` | 1,302 |
| `/bargain-bin/` | 241 |
| `/clearance/` | 142 |
| `/air-guns-and-supplies/` | 46 |
| `/decals/` | 31 |
| `/trail-cameras/` | 12 |
| `/blinds-stands-accessories/` | 11 |
| `/training-aid/` | 4 |
| `/air-soft/` | 2 |
| `/steambow/` | 2 |
| `/consignment/` | 2 |
| `/consignment-non-firearm/` | 0 |
| `/cleaning-and-maintenance/` | 0 |
| `/secure-firearms-storage/` | 0 |
| `/unwanted-firearms/` | 0 |

**totalsSumCheck:** sum of walked uniques = **3,583** raw -> union deduped = **3,482** (~2.9% overlap, driven mostly by `/clearance/` and `/bargain-bin/` items that also appear in their home categories). Products sitemap `<loc>` count = **3,482** — **exact match** to the walked union. `/bargain-bin/` alone contributes 237 unique products not reachable from any other top-level category and `/clearance/` contributes 21 — both REQUIRED for 100% coverage (Rule C). `/swag/` (64 hoodies/hats) excluded as pure apparel per Rule C scope. Empty (0-product) listing categories kept per Rule C "empty != dead".

**`extractionTested`** = **`true`**. Sample (page 1 of `/firearms/`):

| url | title | price | stockStatus |
|---|---|---:|---|
| `/cz-600-plus-alpha-223-24/` | CZ 600 Plus Alpha 223 24" | $1,249.99 | `out_of_stock` |
| `/cz-457-ergo-17-hmr-5r-poly-525mm-1-2-x20/` | CZ 457 ERGO 17 HMR 5R POLY 525MM 1/2"X20 | $999.99 | `in_stock` |
| `/morrison-lever-weston-44-mag-20-10-1-walnut-laser-engraved/` | Morrison Lever Weston 44 Mag 20" 10+1 Walnut Laser Engraved | $1,099.99 | `in_stock` |

Price extracted via `<span data-product-price-without-tax class="price price--withoutTax">$X,XXX.XX</span>`; stockStatus via productView `in_stock` / `out_of_stock` markers.

---

## 5. Pagination & sort — how to traverse

| field | value | meaning |
|---|---|---|
| `paginationPattern.type` | `"query"` | `?page=N` style |
| `paginationPattern.template` | `"page"` | Param NAME only per Mistake 14 |
| `paginationPattern.perPage` | **`100`** | Verified by walk (5x100+71 = 571 in `/firearms/`) |
| `paginationPattern.firstPageHasParam` | `false` | `/firearms/` (no `?page=1`) is page 1 |
| `paginationPattern.startPage` | `1` | |
| `paginationPattern.zeroIndexed` | `false` | |
| `perPage` | **`100`** | Same as paginationPattern.perPage |
| `sortParam` | `"?sort=newest"` | `<select name="sort"><option value="newest">Newest Items` |
| `sortVerified` | **`true`** | 3-outcome counter-control test |

> Sort 3-outcome counter-control test on `/firearms/?limit=12`: `defaultFirst3 == sortedFirst3` (both led with `cz-600-plus-alpha-223-24`, `cz-457-ergo-17-hmr-5r-poly-525mm-1-2-x20`, `morrison-lever-weston-44-mag-20-10-1-walnut-laser-engraved`); `counterFirst3` (sort=alphaasc) led with `mossberg-patriot-270-synthetic`, `henry-homesteader-9mm-...`, `scsa-taipan-x-c-223-wylde-...` — different. Verdict = `honored-default-is-newest` (default IS newest-first). Cache-bust `&_=<rand>` appended to defeat CDN caches. **Caveat on pagination element:** the on-page `aria-label="Page X of 6"` label is hardcoded against BC's default ~50/page and does NOT update when `?limit=100` is used — actual pagination IS honored (zero overlap p1<->p2), but the human-visible label is misleading. Trust the walk, not the label.

---

## 6. Inventory size

| field | value |
|---|---|
| `expectedProductCount` | **`3,482`** |
| `productCountMethod` | `{ method: "sitemap", url: "https://oleysarmoury.com/xmlsitemap.php?type=products&page=1" }` |

> Source: `GET /xmlsitemap.php` returns a sitemapindex pointing to `?type=products&page=1` (single page). `grep -c "<loc>"` on the products sitemap returns **3,482**. Validated against full walk of all 18 catalogUrls: walked union deduped = 3,482 — exact match (0% drift). `productCountMethod` value `"sitemap"` exists in the runtime switch at `backend/src/services/product-count-probe.ts`.

---

## 7. Crawler config — runtime behavior

| Phase | field | value | what it means |
|---|---|---|---|
| watermark | `crawlers.watermark.method` | **`"navigate-from-watermark"`** | Default DOM order is newest-first AND `?sort=newest` is honored. Walk from page 1 forward indexing new products until first known watermark. |
| bootstrap | `crawlers.bootstrap.apiEndpoints` | `{}` | No usable platform API (BC GraphQL token not leaked to homepage; HTML walk is canonical). |
| maintain | `crawlers.maintain.verifyMethod` | `"detail-page"` | BC -> not WC/Shopify, fallback to detail-page Playwright verify per skill table. |
| maintain | `crawlers.maintain.verifyEndpoint` | `null` | No batch API. |

> Watermark rationale: Stage 6 verdict `honored-default-is-newest` proves the listing's natural order on default load IS newest-first; Stage 5 zero-overlap test proves `?page=N` actually paginates a different product set. `navigate-from-watermark` is appropriate. No `full-catalog-sweep` reason needed.

---

## 8. Platform extras

| field | value |
|---|---|
| `classifiedRules` | omitted (`adapterType` is `generic-retail`, not `classifieds-*`) |
| `ecwidStoreId` | omitted (not Ecwid) |
| `wafWorkaround` | omitted (no malformed-header issue — BC + Cloudflare emit clean HTTP) |
| `productUrlSchemes` | omitted (single canonical product URL form: `/<slug>/`) |
| `searchUrl` | omitted (no search URL discovered during stages; can be added in R2 if needed) |

---

## 9. Provenance

| field | value |
|---|---|
| `profileVersion` | `1` |
| `lastVerified` | `"2026-05-13"` |
| `auditNotes.runId` | `"R1-2026-05-13T08-28-56Z"` |
| `auditNotes.probeIp` | `audit-station (Canadian residential, May 2026)` |

**Field confidence:** all listed fields = `high` (live evidence captured per stage; sitemap matches walked union exactly).

**Stage notes:**

1. Stage 1 — Canonical = `https://oleysarmoury.com` (apex 200 clean; www -> 301 -> apex). Per `<link rel='canonical' href='https://oleysarmoury.com/' />`.
2. Stage 2 — 8-batch heavy probe ran clean (all 200 on real pages; honeypot 403s are BC-origin not CDN). cf-ray present -> Cloudflare-passive (informational). `hasWaf: false` per operational rule.
3. Stage 3 — Platform fingerprint: `<meta name='platform' content='bigcommerce.stencil' />` + `x-bc-store-id` + `cdn11.bigcommerce.com/s-6j8taxjw04` + `BCData` JS global. Adapter = `generic-retail`.
4. Stage 4 — 18 top-level catalogUrls; walked end-to-end at `?limit=100`; union 3,482 matches sitemap exactly. `/swag/` excluded (apparel). Empty listing categories retained per Rule C.
5. Stage 5 — `?page=N` query, perPage=100 honored (zero overlap p1<->p2 on `/firearms/`). `?limit=250` capped at 100 (BC server limit + quick-view doubling).
6. Stage 6 — Sort 3-outcome counter-control verdict: `honored-default-is-newest`. `sortParam="?sort=newest"`, `sortVerified=true`.
7. Stage 7 — `navigate-from-watermark` (default DOM is already newest-first; sort confirmed honored as backup).
8. Stage 8 — `expectedProductCount: 3482` from products sitemap; `productCountMethod: {method:"sitemap", url:"..."}`. Walked union = sitemap count exactly (0% drift).
9. Stage 9 — Candidate + this report written to `docs/site-audit/` per skill. NOT promoted to DB (operator gates promotion).
