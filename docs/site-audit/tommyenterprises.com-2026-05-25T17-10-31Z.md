# Pre-Bootstrap Output — tommyenterprises.com

> **Result: READY (operator review).** Validator passed 21/21 checks, score 100. Platform `woocommerce` on Cloudflare-passive CDN (no active WAF / no CAPTCHA / no age-gate). Customer-visible catalog = 121 products (Store API global = 122; 1 catalog_visibility=hidden). 23 top-level categories, but `catalogUrls` collapses to a single `/shop/` URL (6 pages x 21 = full coverage). Sort honored, default = newest-first. Watermark via WP REST `modified_after`. Audit IP only — operator should reconfirm WAF verdict from production crawler IP before promotion.

---

## 1. At a glance

| What | Value |
|---|---|
| Platform / adapter | **`woocommerce`** / **`woocommerce`** (Flatsome theme on WP 7.0 + WC 10.7.0) |
| Protections | hasWaf **`false`**, wafType `cloudflare-passive`, hasCaptcha **`false`** (recaptcha-v3 on contact forms only), ageGate **`false`** |
| Catalog size | **`122`** products (Store API total); 121 customer-visible (one catalog_visibility=hidden) |
| Catalog URLs | **1** entry (`/shop/`) covering 100% — full per-category breakdown in `topLevelCategories.categories[]` |
| Page-walking | `/page/{N}/` path-style, **`perPage = 21`** (Flatsome theme locks; `?per_page` ignored), 6 pages total |
| Sort | **`?orderby=date`** (default-newest-first), `sortVerified = true` via 3-outcome counter-control |
| New-item crawl method | **`api-date-since-watermark`** via WP REST core `?modified_after=<ISO>` |
| Maintain verify method | **`store-api`** at `/wp-json/wc/store/v1/products` (tradeoff noted in auditNotes) |

---

## 2. Identity

| `field` | value |
|---|---|
| `platform` | `"woocommerce"` |
| `adapterType` | `"woocommerce"` |

The homepage emits both `<meta name="generator" content="WordPress 7.0" />` and `<meta name="generator" content="WooCommerce 10.7.0" />`, plus WC body classes (`woocommerce-shop`, `wp-theme-flatsome`, `wp-child-theme-flatsome-child`) and the canonical `/wp-json/wc/store/v1/...` REST surface. Platform-to-adapter mapping follows the SKILL.md Stage 3 default for `woocommerce`. No override needed.

---

## 3. Access — getting in safely

| `field` | value | meaning |
|---|---|---|
| `hasWaf` | **`false`** | No active challenge surfaced in 8-batch heavy probe |
| `wafType` | `"cloudflare-passive"` | cf-ray header present + all 200; passive only |
| `wafLastProbedAt` | `"2026-05-25T17:03:31Z"` | Today (this session) |
| `wafProbeMethod` | `"heavy-8-batch"` | See `wafProbeEvidence` |
| `hasCaptcha` | **`false`** | reCAPTCHA-v3 loaded sitewide via CF7 plugin but does NOT gate the catalog crawl path |
| `captchaType` | `"recaptcha-v3"` | Informational for operator triage UI |
| `ageGate.detected` | **`false`** | No interstitial; firearm-parts site doesn't gate |
| `userAgentOverride` | `null` | Default UA rotation pool works (no UA discrimination observed) |
| `needsPlaywright` | **`false`** | Plain HTTP GET returns full product markup with prices + stock status |

> **Probe evidence.** All 8 batches returned HTTP 200 (single-GET fingerprint, 4-UA matrix, 10-burst rapid, 5 honeypot paths, suspicious-fingerprint barebones GET, SQLi-shaped query, XSS-shaped query, no-UA). `cf-ray` and `Server: cloudflare` present everywhere; `CF-Cache-Status: HIT` on the homepage indicates pass-through caching. The 403s on `/xmlrpc.php`, `/.env`, `/.git/config`, `/phpinfo.php` are origin WP / Cloudflare path-rule level (not CDN WAF challenges) — they did NOT trigger when normal product paths were fetched. No `MalCare`, `Wordfence`, `sgcaptcha`, or `Incapsula` markers in any of the 8 batch response bodies. Rapid 10-burst returned all 200 (no rate-limit kicked in within the probe window). **Skill rule: `hasWaf: true` + `wafType: cloudflare-passive` is invalid (B10) — emitting `hasWaf: false` here.** Untested attack surfaces (auth-bypass, path-traversal, large-body POST, shellshock UA) flagged in `wafProbeEvidence.untestedAttackSurfaces`. Operator MUST reconfirm from the production crawler IP before promotion since WAF results are IP-dependent.

---

## 4. Catalog discovery — where the products are

| # | id | slug | name | allOption (Store API count) |
|---:|---:|---|---|---:|
| 1 | 49 | `handguards-and-grips` | Handguards and Grips | 55 |
| 2 | 22 | `gsg-16` | GSG-16 | 33 |
| 3 | 48 | `stocks` | Stocks | 22 |
| 4 | 67 | `derya-tm22` | Derya TM22 | 21 |
| 5 | 73 | `derya-tm22-feather` | Derya/RIA TM22 Feather | 15 |
| 6 | 15 | `universal` | Universal | 13 |
| 7 | 65 | `henry-survival-ar7` | Henry Survival AR7 | 12 |
| 8 | 50 | `kits` | Kits | 12 |
| 9 | 69 | `henry-lever-rifles` | Henry Lever Rifles | 11 |
| 10 | 72 | `henry-homesteader` | Henry Homesteader | 10 |
| 11 | 79 | `adler-rf224` | Adler RF224 | 7 |
| 12 | 74 | `akdas-alcor` | Akdas Alcor | 7 |
| 13 | 57 | `barrel-shrouds` | Barrel Shrouds | 6 |
| 14 | 51 | `sights` | Sights | 6 |
| 15 | 76 | `taipan-x` | Taipan X | 6 |
| 16 | 70 | `derya-tm22la` | Derya TM22LA | 5 |
| 17 | 52 | `gsg15` | GSG-15 | 4 |
| 18 | 90 | `taipan-evo` | Taipan EVO | 4 |
| 19 | 75 | `citadel-ad500` | Adler/Citadel AD500 | 3 |
| 20 | 78 | `chimera-223` | Celik Chimera 223 | 2 |
| 21 | 91 | `derya-tm22-flash` | Derya TM22 Flash | 1 |
| 22 | 25 | `kriss-vector` | Kriss Vector | 0 |
| 23 | 23 | `wk-180c-1` | WK-180c Gen 1 | 0 |

> **totalsSumCheck.** Sum of 23 top-level counts = 255 — overcounts because products carry multiple categories (one TM22 handguard sits in BOTH `handguards-and-grips` and `derya-tm22`). Customer-visible global total = 121 (HTML `Showing 1-21 of 121 results`); Store API global total = 122 (one catalog_visibility=hidden product). 121/122 = 99.2% drift, within the 5% gate. **catalogUrls collapses to a single `/shop/` URL** because the per-category list would crawl 30-50 pages worth of overlap to cover the same 121 products — no coverage benefit from per-category. Stage 4d walk-and-dedup of `/shop/` pages 1..6 returned exactly 121 unique product IDs.

### Extraction sample (Stage 4g)

| url | title | price | stockStatus |
|---|---|---:|---|
| `/product/full-length-10-mlok-handguard-for-tm22-a-12/` | Full Length (10in) Mlok Handguard for TM22-A-12 | 85.00 | `in_stock` |
| `/product/8-cylindrical-handguard-for-tm22/` | 8in Cylindrical Handguard for TM22 | 70.00 | `in_stock` |
| `/product/fixed-stock-and-grip-adapter-kit-for-citadel-ad500/` | Fixed stock and grip adapter kit for Citadel AD500 | 120.00 | `in_stock` |

`extractionTested = true`

---

## 5. Pagination & sort — how to traverse

| `field` | value | meaning |
|---|---|---|
| `paginationPattern.type` | `"path"` | Path-style `/page/N/` (WordPress standard rewrite) |
| `paginationPattern.template` | `"/shop/page/{N}/"` | Leading slash required per validator C7; `{N}` UPPERCASE per Mistake 14 |
| `paginationPattern.perPage` | **`21`** | Flatsome theme `large-columns-3` grid; `?per_page` query is silently ignored — verified |
| `paginationPattern.firstPageHasParam` | `false` | Page 1 is `/shop/` (no `/page/1/`) |
| `paginationPattern.startPage` | `1` | |
| `paginationPattern.zeroIndexed` | `false` | |
| `perPage` | **`21`** | Matches `paginationPattern.perPage` |
| `sortParam` | `"?orderby=date"` | Default-selected option in `<select name="orderby">` |
| `sortVerified` | **`true`** | 3-outcome counter-control passes |

> **Sort verification.** Read `<select name="orderby">` from `/shop/` HTML: options are `popularity, rating, date (selected), price, price-desc`. Fired 3 fetches with cache-bust nonces: `default` first-5 IDs = `[6216,6115,6109,5939,5865]`, `?orderby=date` first-5 IDs identical, `?orderby=price` first-5 IDs = `[1084,4501,195,142,173]` (clearly different). Verdict: **honored-default-is-newest** — `date` IS already the default, and a non-newest counter-control changes the order. Within-page IDs descend monotonically (e.g. page 1: 6216 to 2571), across-page IDs descend (page 1 last = 2571, page 2 first = 2566). Pagination page-1-vs-page-2 zero-overlap test also passed (0 shared IDs).

---

## 6. Inventory size

| `field` | value |
|---|---|
| `expectedProductCount` | **`122`** |
| `productCountMethod` | `{method: "wp-rest-header", endpoint: "/wp-json/wc/store/v1/products", header: "x-wp-total"}` |

> **Source.** `GET https://tommyenterprises.com/wp-json/wc/store/v1/products?per_page=1` returns response header `x-wp-total: 122`. Cross-confirmed with WP REST core `/wp-json/wp/v2/product?per_page=1` (also `x-wp-total: 122` — no admin/customer divergence on this small site). Customer-visible HTML count is 121 (one product is `catalog_visibility=hidden` from the shop loop but still indexed via API). Bracketed-array form `?stock_status[0]=instock&stock_status[1]=outofstock` also returns 122 — no OOS-included divergence. The pair with `crawlers.maintain.verifyMethod = "store-api"` keeps the count surface and the verifier surface aligned per SKILL.md B8.

---

## 7. Crawler config — runtime behavior

| Phase | `field` | value | what it means |
|---|---|---|---|
| watermark | `crawlers.watermark.method` | **`"api-date-since-watermark"`** | WP REST `?modified_after=<ISO>` filter is honored — two-probe verified |
| watermark | `crawlers.watermark.dateFilterApi` | `"wp-rest-core"` | Filter applied against `/wp-json/wp/v2/product` (the runtime adapter at `woocommerce.ts:337` hardcodes this surface) |
| watermark | `crawlers.watermark.dateFilterField` | `"modified_after"` | Catches restocks + price changes; NOT `?after` (which catches only new posts and misses 44x restocks per SKILL.md B7) |
| maintain | `crawlers.maintain.verifyMethod` | **`"store-api"`** | Fast batch verify via `/wc/store/v1/products`; restock alerts may miss OOS transitions for products the API never sees |
| maintain | `crawlers.maintain.verifyEndpoint` | `"/wp-json/wc/store/v1/products"` | Store API surface; matches `productCountMethod.endpoint` per B8 pair-rule |

> **Why `api-date-since-watermark`.** Two-probe verified: `?modified_after=2099-01-01` returns `x-wp-total: 0` (impossible future), `?modified_after=1999-01-01` returns `x-wp-total: 122` (matches global). Both endpoints honored. Default sort is newest-first AND ID-monotonic, so Method B (`navigate-from-watermark`) would also work — but Method A (`api-date-since-watermark`) is the higher-priority choice since the API exists and honors the filter cleanly. No `full-catalog-sweep` needed.

---

## 8. Platform extras

| field | value | reason |
|---|---|---|
| `classifiedRules` | (omitted) | Not a classifieds site; `adapterType = "woocommerce"` |
| `ecwidStoreId` | (omitted) | Not an Ecwid storefront |
| `wafWorkaround` | (omitted) | Site emits standard HTTP headers; no Celerant-style malformed-header parse error |
| `productUrlSchemes` | (omitted) | Single canonical URL form `/product/<slug>/` |
| `searchUrl` | (deferred to operator) | Likely `/?s={keyword}&post_type=product` (WP/WC default) — not probed this session to honor 60min budget. Operator can add after a 1-minute B4 probe: read homepage `<form action="/" method="get"><input name="s">` plus a junk-keyword diff test. |

---

## 9. Provenance

| `field` | value |
|---|---|
| `profileVersion` | `1` |
| `lastVerified` | `2026-05-25` |
| `auditNotes.runId` | `2026-05-25T17-10-31Z` |
| `auditNotes.probeIp` | `audit-host (operator must reconfirm WAF from production crawler IP)` |
| `auditNotes.wcCountSurface` | `store-api` |
| `auditNotes.expectedCountSurface` | `store-api` |
| `auditNotes.wcCategoryApi` | `store-api` |

### Field confidence

| field | confidence |
|---|---|
| `platform` | high |
| `hasWaf` | high (8-batch probe, audit-IP only) |
| `catalogUrls` | high (full 6-page walk dedup = 121 unique IDs matching HTML count) |
| `expectedProductCount` | high (cross-validated WP REST + Store API both return 122) |
| `paginationPattern` | high (page-1 vs page-2 zero-overlap verified) |
| `sortParam` | high (3-outcome counter-control verified) |
| `crawlers.watermark.method` | high (two-probe `modified_after` verified) |
| `crawlers.maintain.verifyMethod` | high (default for WC; operator tradeoff acknowledged) |

### Stage notes

1. **Stage 1 — Canonical URL.** Apex `https://tommyenterprises.com/` returns 200 cleanly with Chrome 120 UA; `<link rel="canonical" href="https://tommyenterprises.com/" />` declares apex as canonical. `https://www.tommyenterprises.com/` also returns 200 but apex wins per canonical tag. `robots.txt` declares `Sitemap: https://tommyenterprises.com/wp-sitemap.xml`.
2. **Stage 2 — WAF + CAPTCHA.** 8-batch heavy probe (`.claude/skills/pre-bootstrap/heavy-waf-probe.sh`). All probes returned 200 except origin-blocked admin paths (`/xmlrpc.php`, `/.env`, `/.git/config`, `/phpinfo.php` — not CDN WAF). `cf-ray` present + `CF-Cache-Status: HIT` on homepage = cloudflare-passive. No plugin-WAF markers in any of the 8 batch bodies. reCAPTCHA-v3 script tag present but only used by CF7 contact forms (operationally non-blocking).
3. **Stage 3 — Platform.** WordPress 7.0 + WooCommerce 10.7.0 (both `<meta name="generator">` tags), Flatsome theme + Flatsome-Child child theme. No age-gate, no login-wall. `adapterType = "woocommerce"` per default table.
4. **Stage 4 — Catalog URLs.** WC Store API `/wp-json/wc/store/v1/products/categories?per_page=100&hide_empty=false` returned 26 categories (single page, no pagination headers — under the 100 default). 23 top-level (`parent=0`), 3 children of `henry-lever-rifles`. Stage 4d walked `/shop/` pages 1..6 yielding 121 unique product IDs (matches the HTML result-count line). Stage 4g extraction-quality spot-check passed on 3 random products (URL/title/price/stockStatus all populated via the WC adapter selectors). Per-category list deferred to documentation (`topLevelCategories.categories[]`); `/shop/` URL is the catalogUrl since it reaches 100% in 6 fetches vs 23 URLs x ~2 pages = ~30-50 fetches for the same coverage.
5. **Stage 5 — Pagination.** `/shop/page/2/` returned 21 products with zero ID overlap vs `/shop/` page 1. `?per_page=100` query param silently ignored (still 21 products) — Flatsome theme locks the perPage at 21. Type `path`, template `/shop/page/{N}/` (leading slash required by validator C7).
6. **Stage 6 — Sort.** `<select name="orderby">` exposes `popularity, rating, date (default-selected), price, price-desc`. 3-outcome counter-control fired with cache-bust nonces: `default == ?orderby=date != ?orderby=price` -> verdict `honored-default-is-newest`. `sortParam = "?orderby=date"`, `sortVerified = true`.
7. **Stage 7 — Watermark.** `?modified_after=2099-01-01T00:00:00` -> `x-wp-total: 0` (impossible future); `?modified_after=1999-01-01T00:00:00` -> `x-wp-total: 122` (matches global). Method A (`api-date-since-watermark`) selected. `dateFilterApi = wp-rest-core`, `dateFilterField = modified_after` per the runtime adapter at `woocommerce.ts:337`.
8. **Stage 8 — Product count.** `wp-rest-header` against `/wp-json/wc/store/v1/products` returns `x-wp-total: 122`. Customer-visible (HTML) is 121 (one catalog_visibility=hidden). Drift 1/122 = 0.8% — well within 5% gate. No reconciliation needed (walk count 121 < probe count 122; the inverse rule does not trigger). Pairs with `crawlers.maintain.verifyMethod = "store-api"` per B8.
9. **Stage 9 — Assembly.** Validator passed 21/21 checks at score 100. Wrote `docs/site-audit/tommyenterprises.com-2026-05-25T17-10-31Z.json` plus this `.md`.
