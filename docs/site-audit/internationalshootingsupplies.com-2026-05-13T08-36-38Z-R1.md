# Pre-Bootstrap Output — internationalshootingsupplies.com

> READY — validator pass (9/9 required, 7/7 recommended). WooCommerce + Astra theme, **no CDN WAF**, **no operational CAPTCHA**, **no age-gate**. Customer-visible catalog = **2,299 products** across 12 top-level categories. WC Store API + WP REST both expose date-filter (`?after=`), `<select name="orderby"><option value="date">` honored. Watermark = `api-date-since-watermark`.

---

## 1. At a glance

| What | Value |
|---|---|
| Platform / adapter | **`woocommerce`** / **`woocommerce`** |
| Protections | hasWaf **`false`** (no CDN; BPS WP plugin is rule-selective on SQLi only) - hasCaptcha **`false`** (reCAPTCHA-v3 present but not gating catalog) - ageGate **`false`** |
| Catalog size | **2,299** customer-visible / 5,230 admin-incl-drafts |
| Catalog spine | **12** top-level category URLs |
| Pagination | **`path`** `/page/{N}/` - **perPage 12** (theme-locked) |
| Sort | `?orderby=date` - **`sortVerified: true`** |
| Watermark | **`api-date-since-watermark`** (WC Store API `?after=<ISO>` honored) |
| Maintain | **`store-api`** verify on `/wp-json/wc/store/v1/products` |

---

## 2. Identity

| `field` | value |
|---|---|
| `platform` | `"woocommerce"` |
| `adapterType` | `"woocommerce"` |

WooCommerce confirmed via 122 `woocommerce` markers in homepage HTML, `wp-content/plugins/woocommerce` paths, WC Store API `/wp-json/wc/store/v1/products` returns product JSON with `X-WP-Total: 2299`. Theme is Astra.

---

## 3. Access — getting in safely

| `field` | value | meaning |
|---|---|---|
| `hasWaf` | **`false`** | No CDN WAF in front; BPS WordPress plugin returns 403 on SQLi/XSS query strings but catalog paths return 200 unaffected |
| `wafType` | `null` | No vendor (no cf-ray, no x-sucuri, no Incapsula) |
| `wafLastProbedAt` | `"2026-05-13T08:18:48Z"` | Heavy 8-batch probe timestamp |
| `wafProbeMethod` | `"heavy-8-batch"` | 8 batches |
| `hasCaptcha` | **`false`** | reCAPTCHA-v3 script tag present site-wide via Contact Form 7 plugin but does NOT gate the catalog crawl path |
| `captchaType` | `"recaptcha-v3"` | Informational — `<script src="...google.com/recaptcha/api.js?render=...">` |
| `ageGate.detected` | **`false`** | No age-gate / login-wall markers in homepage HTML |
| `userAgentOverride` | `null` | No UA workaround required |
| `needsPlaywright` | **`false`** | Plain HTTP returns product JSON cleanly |

> 8-batch probe evidence: nginx; all rapid-burst GETs 200; no cf-ray/x-sucuri/Incapsula in BATCH 1; SQLi (`?id=1' OR '1'='1`) and XSS (`?q=<script>...`) payloads return 403 with `BPS Plugin 403 Error Page` body — BulletProof Security WordPress plugin firing rule-selectively; honeypot `/.env`, `/.git/config` → 403; `/xmlrpc.php` → connection reset (server-level). All catalog crawl paths (`/`, `/product-category/*`, `/wp-json/wc/store/v1/products`) returned 200.

---

## 4. Catalog discovery — where the products are

| Category | wpV2Count | wcStoreCount | id |
|---|--:|--:|--:|
| `/product-category/firearms/` | 468 | 473 | 32 |
| `/product-category/ammunition/` | 14 | 14 | 34 |
| `/product-category/parts/` | 2281 | 310 | 281 |
| `/product-category/reloading-components/` | 2283 | 8 | 75 |
| `/product-category/reloading-equipment/` | 486 | 491 | 80 |
| `/product-category/shooting-accessories/` | 1015 | 687 | 90 |
| `/product-category/hunting-accessories/` | 253 | 253 | 61 |
| `/product-category/optics/` | 49 | 50 | 65 |
| `/product-category/novelties/` | 44 | 44 | 974 |
| `/product-category/bows/` | 0 | 0 | 1087 |
| `/product-category/iss-packages/` | 0 | 0 | 340 |
| `/product-category/uncategorized/` | 1 | 1 | 1271 |

> **totalsSumCheck:** Global X-WP-Total = **2,299** customer-visible / 5,230 admin (incl drafts). HTML walk of all 12 top-level cats covers ~1,522 product IDs (66%) via direct-only WC Store API (`?category=ID` does NOT include descendants). Walking 79 non-manufacturer leaf cats yields 2,244 unique IDs (97.6%). 55 products are top-level orphans tagged only with brand. Runtime WC Store API path achieves 100% coverage; HTML catalogUrls are fallback only. Skipped: `/product-category/manufacturers/` — parent returns empty body; brand children overlap with top-level cats.

| URL | Title | Price | Stock |
|---|---|--:|---|
| `/product/uberti-1894-carbine-30-30-win-20-barrel/` | A. Uberti 1894 Carbine 30-30 Win 20 Barrel | 2249.99 | `in_stock` |
| `/product/antler-arms-expedition-bear-mb42-6-5-cr-22-barrel/` | Antler Arms Expedition Bear MB42 6.5 CR 22 Barrel | 2799.99 | `in_stock` |
| `/product/antler-arms-wild-mountain-coyote-mb42-7mm-prc-24-barrel-w-adjustable-cheekpiece/` | Antler Arms Wild Mountain Coyote Adjustable MB42 7mm PRC 24 Barrel | 3329.99 | `in_stock` |

`extractionTested: true`

---

## 5. Pagination & sort — how to traverse

| `field` | value | meaning |
|---|---|---|
| `paginationPattern.type` | `"path"` | URL segment append, not query |
| `paginationPattern.template` | `"/page/{N}/"` | Insert page number into path |
| `paginationPattern.perPage` | **`12`** | Astra theme default; not overridable via `?count` or `?products_per_page` |
| `paginationPattern.firstPageHasParam` | `false` | Page 1 = bare URL (no `/page/1/`) |
| `paginationPattern.startPage` | `1` | First page is 1, not 0 |
| `paginationPattern.zeroIndexed` | `false` | |
| `perPage` | **`12`** | Same as `paginationPattern.perPage` |
| `sortParam` | `"?orderby=date"` | Standard WooCommerce `<select name="orderby">` value |
| `sortVerified` | **`true`** | 3-outcome counter-control test passed |

> Sort verification on `/product-category/firearms/rifles/` (256 products): default first3 = `[uberti-1894-carbine-30-30-win-20-barrel, adler-arms-ad-500s-gray-308-win-20-barrel, adler-arms-ad-500tact-308-win-20-barrel]`; `?orderby=date` first3 = `[used-china-type-56-sks-jungle-carbine-7-62x39-20-5-barrel, consignment-remington-700-custom-308-win-20-barrel, consignment-chiappa-wildlands-1892-alaskan-takedown-44-rem-mag-12-barrel]`; `?orderby=price` (counter-control) first3 = `[chiappa-little-badger-22lr, consignment-winchester-model-67a-22-s-l-lr-27-barrel, savage-arms-mark-ii-f-22lr]`. All three distinct - verdict `honored`. Pagination zero-overlap confirmed via rifles `/page/2/`.

---

## 6. Inventory size

| `field` | value |
|---|---|
| `expectedProductCount` | **`2299`** |
| `productCountMethod` | `{method: "wp-rest-header", endpoint: "/wp-json/wc/store/v1/products", header: "x-wp-total"}` |

> Source: `GET https://internationalshootingsupplies.com/wp-json/wc/store/v1/products?per_page=1` returns header `X-WP-Total: 2299` (customer-visible). The admin `/wp-json/wp/v2/product?per_page=1` returns `X-WP-Total: 5230` (includes drafts/private — not used for tracking).

---

## 7. Crawler config — runtime behavior

| Phase | `field` | value | what it means |
|---|---|---|---|
| Watermark | `crawlers.watermark.method` | **`"api-date-since-watermark"`** | Filter WC Store API by `?after=<ISO>` to find products created after last seen |
| Bootstrap | `crawlers.bootstrap.apiEndpoints.wcStore` | `"/wp-json/wc/store/v1/products"` | Customer-visible product list |
| Bootstrap | `crawlers.bootstrap.apiEndpoints.wpRest` | `"/wp-json/wp/v2/product"` | WP admin REST (incl drafts) |
| Bootstrap | `crawlers.bootstrap.apiEndpoints.productCat` | `"/wp-json/wp/v2/product_cat"` | Taxonomy tree |
| Maintain | `crawlers.maintain.verifyMethod` | `"store-api"` | Batch-verify product existence via WC Store API |
| Maintain | `crawlers.maintain.verifyEndpoint` | `"/wp-json/wc/store/v1/products"` | Same endpoint as bootstrap |

> Watermark reason: WC Store API `/wp-json/wc/store/v1/products?after=<ISO>` honored — two-probe verified: `?after=2099-01-01` returned `X-WP-Total: 0`, `?after=1999-01-01` returned `X-WP-Total: 2299` (= global). WP REST `/wp-json/wp/v2/product?after=<ISO>` also honored (0 / 5,230). HTML sort `?orderby=date` ALSO works as a backup path. No need for `navigate-from-watermark` or `full-catalog-sweep`.

---

## 8. Platform extras

| `field` | value |
|---|---|
| `classifiedRules` | omitted (not a classifieds adapter) |
| `ecwidStoreId` | omitted (not an Ecwid store) |
| `wafWorkaround` | omitted (no malformed headers detected) |
| `productUrlSchemes` | omitted (single canonical URL form `/product/<slug>/`) |
| `searchUrl` | omitted (no public keyword-search URL identified in this audit) |

---

## 9. Provenance

| `field` | value |
|---|---|
| `profileVersion` | `1` |
| `lastVerified` | `"2026-05-13"` |
| `auditNotes.runId` | `"iss-2026-05-13T08-36-38Z-R1"` |
| `auditNotes.probeIp` | residential audit IP (BPS plugin echoed it in 403 page; production crawler IP MUST be re-confirmed before promotion) |
| `auditNotes.catalogCoverageNote` | HTML catalogUrls cover ~66% via direct-only; runtime WC API path achieves 100% |

### fieldConfidence

| field | confidence |
|---|---|
| `platform` | high |
| `adapterType` | high |
| `hasWaf` | high |
| `wafType` | high |
| `hasCaptcha` | high |
| `expectedProductCount` | high |
| `productCountMethod` | high |
| `catalogUrls` | medium (66% HTML coverage gap acknowledged) |
| `paginationPattern` | high |
| `sortParam` | high |
| `watermarkMethod` | high |

### stageNotes

1. **Stage 1** — apex 200 OK clean; `<link rel=canonical>` declares apex; canonical = `https://internationalshootingsupplies.com`.
2. **Stage 2** — heavy-8-batch probe ran 2026-05-13 08:18-08:21 UTC; nginx; no cf-ray/x-sucuri/Incapsula. SQLi/XSS payloads → 403 (BPS Plugin rule-selective); honeypot `.env`/`.git/config` → 403; xmlrpc → connection reset. Catalog paths all 200. hasWaf=false.
3. **Stage 3** — 122 `woocommerce` markers in HTML; Astra theme; reCAPTCHA-v3 via Contact Form 7 (script tag present but does NOT gate catalog - `hasCaptcha=false`); no age-gate; WC Store API returns product JSON; needsPlaywright=false.
4. **Stage 4** — 205 `product_cat` records; 13 top-level (12 productive after excluding `manufacturers`). HTML walk of top-level cats yields 1,522 unique IDs (66%) because WC Store API `?category=ID` is direct-only; HTML pagination of the parent category DOES include descendants. Walking 79 non-manufacturer leaf cats yields 2,244 unique (97.6%). 55 products are top-level orphans (brand-only tagging or empty `categories[]`). Chose 12 top-level cats as catalogUrls; runtime uses WC API for 100%.
5. **Stage 5** — `/page/{N}/` path style. Rifles page 1 vs page 2 → 0 overlap (12 unique each; "Showing 13-24 of 256 results"). perPage = 12 locked by theme.
6. **Stage 6** — `<select name="orderby">` options: `menu_order`, `popularity`, `date`, `price`, `price-desc`. 3-outcome cache-busted test on rifles: default ≠ `?orderby=date` ≠ `?orderby=price`. Verdict `honored`. `sortParam="?orderby=date"`.
7. **Stage 7** — WC Store API `?after=2099-01-01` → 0; `?after=1999-01-01` → 2,299. WP REST `?after=2099-01-01` → 0; `?after=1999-01-01` → 5,230. `crawlers.watermark.method=api-date-since-watermark`.
8. **Stage 8** — WC Store API `?per_page=1` returns `X-WP-Total: 2299` (customer-visible). `productCountMethod = {method:"wp-rest-header", endpoint:"/wp-json/wc/store/v1/products", header:"x-wp-total"}`.
9. **Stage 9** — Profile validator pass: 9/9 required + 7/7 recommended. Written to `.json` + `.md`.
