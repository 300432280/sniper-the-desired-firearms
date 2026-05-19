# Pre-Bootstrap Output — greatnorthgunco.ca

> **Result:** ready for operator review (with workaround caveats).
> All 16 validator checks pass (`valid: true, score: 100`). **Imunify360 Bot Protection** challenges every catalog + API endpoint, requiring stealth Playwright. No reCAPTCHA gate, no age-gate. WordPress 6.9.4 + WooCommerce 10.7.0. **4,292 all-time products** in WP REST (516 customer-visible) across 17 product categories. Single `/shop/` catalog URL covers 100% of the customer-visible catalog.

---

## At a glance

| What | Value |
|---|---|
| Site runs on | **WooCommerce 10.7.0** on WordPress 6.9.4 (giga-store-pro theme, LiteSpeed cache) |
| Protections in front | **Imunify360 Bot Protection** challenges `/shop/`, `/product/*`, `/wp-json/*`. Origin LiteSpeed. **`hasWaf=true`**, stealth Playwright required. |
| Catalog | **4,292 all-time products** (WP v2 admin REST `x-wp-total`); 516 customer-visible (WC Store API). |
| Page walking | path-style `/page/{N}/` · `perPage=24` (theme-capped; `?ppp=N` ignored) |
| Sort | **`?orderby=date`** — verified honored, default order IS newest |
| New-item crawl | **`crawlers.watermark.method = api-date-since-watermark`** (WC Store API `?after=<ISO>` date filter, two-probe verified) |
| Re-verify in maintain phase | `crawlers.maintain.verifyMethod = detail-page` (matches DB choice — Store API verify was unreliable in past) |

---

## Identity

WC markers in homepage HTML: `<meta name="generator" content="WooCommerce 10.7.0">`, `woocommerce-` classes, `wp-content/plugins/woocommerce`, `/wp-json/wc/store/v1/` endpoints. Theme: `giga-store-pro`. Maps to native `woocommerce` adapter.

| field | value |
|---|---|
| `platform` | `woocommerce` |
| `adapterType` | `woocommerce` |

---

## Access — getting in safely

The site uses **Imunify360** (CloudLinux's WAF + Bot Protection) in front of catalog + API endpoints. Homepage and sitemaps pass through (LiteSpeed origin). Catalog endpoints return an 11–12KB JS challenge page from `openresty/1.29.2.3` titled "One moment, please...", with anti-bot detection (`navigator.webdriver`, headless-UA regex, plugin/mime prototype, languages, outerWidth zero). Plain axios/curl gets blocked; **stealth Playwright** (init scripts overriding `navigator.webdriver=undefined`, `outerWidth=1920`, plugin/mimeType prototypes via `Object.create`) bypasses cleanly.

| field | value | meaning |
|---|---|---|
| `hasWaf` | **`true`** | Imunify360 challenge gates all crawler-relevant endpoints |
| `wafType` | `"imunify360"` | CloudLinux Imunify360 Bot Protection (not in skill enum — informational) |
| `wafLastProbedAt` | `2026-05-15T18:26:23Z` | when the 8-batch probe ran |
| `wafProbeMethod` | `heavy-8-batch` | which probe method |
| `hasCaptcha` | **`false`** | reCAPTCHA v3 script tag is present site-wide (Contact Form 7), but it does NOT gate the catalog crawl path |
| `captchaType` | `recaptcha-v3` | informational only |
| `ageGate.detected` | **`false`** | no interstitial age-confirmation gate |
| `userAgentOverride` | `null` | desktop Chrome UA passes once stealth shims are applied |
| `needsPlaywright` | **`true`** | plain HTTP returns the Imunify challenge page; Playwright + stealth init scripts required |

> **Probe evidence** (`wafProbeEvidence`): all 8 BATCH-1 header probes returned 200 OK with no CDN markers (`cf-ray`, `x-sucuri-id`, etc. absent). Rapid-burst 10 sequential GETs all 200. Honeypot paths `/.env` and `/.git/config` returned generic LiteSpeed 403 (origin filter, not WAF). SQLi/XSS payloads passed unobstructed. BUT a second probe layer found that `/shop/`, `/product/*`, `/product-category/*`, and `/wp-json/*` all return `openresty/1.29.2.3` 200 with an 11,468-byte JS challenge page (title "One moment, please..."; form action `/z0f76a1d14fd21a8fb5fd0d03e0fdc3d3cedae52f`). Imunify360 anti-bot script (function `a0K`, target div `f03s36su46c0`) runs 7 checks: `webdriverCheck`, `userAgentCheck` (/headless|bytespider/i), `appVersionCheck`, `pluginArraySpoofing`, `mimeTypeArraySpoofing`, `noLanguage`, `zeroOuterDimensions`. Headless Playwright fails webdriver/outerWidth/plugins by default; with `addInitScript` shims it passes and `/shop/` returns 24 product cards + WC Store API returns `x-wp-total=516`.

---

## Catalog discovery — where the products are

**`catalogUrls`** — single URL: `/shop/`. Proven 100%-coverage of customer-visible products (516). Per-category split was considered but `/shop/` is simpler and provably complete.

| Category | Products | URL |
|---|---:|---|
| Used Firearms | **295** | `/product-category/used-firearms/` |
| New Knives | 66 | `/product-category/new-knives/` |
| Accessories Parts | 29 | `/product-category/accessories-parts/` |
| New Scopes | 26 | `/product-category/new-scopes/` |
| Surplus | 19 | `/product-category/surplus/` |
| Lee-Enfield Parts | 19 | `/product-category/lee-enfield-parts/` |
| Bayonets | 17 | `/product-category/bayonets/` |
| Uncategorized | 16 | `/product-category/uncategorized/` |
| New Firearms | 10 | `/product-category/new-firearms/` |
| Used Scopes | 9 | `/product-category/used-scopes/` |
| Mauser Parts | 4 | `/product-category/mauser-parts/` |
| Several Available Surplus | 3 | `/product-category/several-available-surplus/` |
| New Shotguns | 1 | `/product-category/new-shotguns/` |
| Several Available | 1 | `/product-category/several-available/` |
| Ljungman Parts | 1 | `/product-category/ljungman-parts/` |
| Ammunition | 0 | `/product-category/ammunition/` |
| Sale | 0 | `/product-category/sale/` |

**`topLevelCategories.totalsSumCheck`:**

> Sum of WC `product_cat` counts = **516**. Matches WC Store API `x-wp-total = 516` exactly.
> WP v2 admin REST `/wp-json/wp/v2/product` returns `x-wp-total = 4292` (includes drafts / private / sold-archive items hidden from storefront by `catalog_visibility`).
> All 17 product categories are firearm-relevant (firearms, knives/bayonets, scopes, parts, surplus, ammunition). No exclusions.
> `/shop/` is the canonical aggregator: 22 pages × 24 per page = 528 max slots, page 22 partial, dedup'd unique = 516.

**`extractionSample`** — 3 random products spot-checked from rendered `/shop/` HTML, all 4 required fields populated:

| `title` | `price` | `stockStatus` |
|---|---:|---|
| Husqvarna 1640 in 30-06 | $475.00 | `in_stock` |
| Sako L61R in 7 Rem Mag | $435.00 | `in_stock` |
| ATA Arms Over/Under Shotgun in 12ga (Ejectors) | $399.99 | `in_stock` |

`extractionTested = true`.

---

## Pagination & sort — how to traverse

| field | value | meaning |
|---|---|---|
| `paginationPattern.type` | `path` | path-segment style |
| `paginationPattern.template` | `/page/{N}` | append to base URL |
| `paginationPattern.perPage` | `24` | per page (theme-capped; `?ppp=100` is silently ignored) |
| `paginationPattern.firstPageHasParam` | `false` | page 1 = bare `/shop/` |
| `paginationPattern.startPage` | `1` | first page index |
| `paginationPattern.zeroIndexed` | `false` | pages are 1-based |
| `perPage` | `24` | (mirror of `paginationPattern.perPage`) |
| `sortParam` | `?orderby=date` | newest-first query param |
| `sortVerified` | **`true`** | 3-outcome counter-control test passed |

> **Sort verification** (3-outcome with cache-bust):
> - `default` (no param): first product = `husqvarna-1640-in-30-06-10`
> - `?orderby=date` (newest candidate): first product = `husqvarna-1640-in-30-06-10` (SAME as default)
> - `?orderby=price` (counter-control): first product = `enfield-no1-safety-screw` (DIFFERENT)
>
> Verdict: `honored-default-is-newest`. Default order IS newest-first, and `?orderby=date` is also honored. Independent cross-check: `husqvarna-1640-in-30-06-10` has the most recent `lastmod` in `/product-sitemap5.xml` (2026-05-15T13:19:48Z), confirming default IS newest.
>
> **Pagination verification** (page-1 vs page-2 zero-overlap): page 2 returns 24 entirely distinct products (`lightweight-husqvarna-1640-in-30-06`, `baikal-ij-26-sxs-in-12ga-8`, etc.) → pagination is honored, not a NOOP.

---

## Inventory size

| field | value |
|---|---|
| `expectedProductCount` | **`4292`** |
| `productCountMethod` | `{ method: "wp-rest-header", endpoint: "/wp-json/wp/v2/product", header: "x-wp-total" }` |

> **Count source:** `GET https://greatnorthgunco.ca/wp-json/wp/v2/product?per_page=1` (via warmed Playwright session) returned `x-wp-total: 4292`. Verified against `/sitemap_index.xml` → 5 product sitemaps (`product-sitemap.xml..5.xml`) → deduped `<loc>` count = 4292 (exact match). WC Store API `x-wp-total=516` is the customer-visible subset (storefront `catalog_visibility` filter hides ~3,776 sold/private/archive items). Matches DB siteProfile's choice of method (admin REST, all-time count).

---

## Crawler config — runtime behavior

| Phase | `field` | value | what it means |
|---|---|---|---|
| Watermark | `crawlers.watermark.method` | **`api-date-since-watermark`** | Fast path: WC Store API `?after=<ISO>` date filter walks only new products since last crawl. Two-probe verified: `after=2099-01-01 → x-wp-total=0`; `after=1999-01-01 → x-wp-total=516`. |
| Bootstrap | `crawlers.bootstrap.apiEndpoints.productDiscovery` | `/wp-json/wp/v2/product` | Admin REST — provides title, URL, thumbnail, categories, sourceId (NO price/stock) |
| Bootstrap | `crawlers.bootstrap.apiEndpoints.priceEnrichment` | `/wp-json/wc/store/v1/products` | Store API enrichment — provides price, regularPrice, stockStatus |
| Maintain | `crawlers.maintain.verifyMethod` | `detail-page` | Per DB note: Store API verify produced 3691 false-positive deactivations in April 2026; detail-page is the safe fallback |
| Maintain | `crawlers.maintain.verifyEndpoint` | `null` | (detail-page method does not need an endpoint) |

> **Watermark `reason`:** N/A (Method A `api-date-since-watermark` is chosen; reason is required only for `full-catalog-sweep`).

---

## Platform extras

| field | value |
|---|---|
| `classifiedRules` | (not applicable — adapter is woocommerce, not classifieds-*) |
| `ecwidStoreId` | (not applicable — platform is woocommerce, not ecwid-*) |
| `wafWorkaround` | `null` (no malformed headers; Imunify challenge handled via `needsPlaywright=true` + stealth shims, not curl-spawn fallback) |
| `productUrlSchemes` | (not applicable — single `/product/<slug>/` form) |
| `searchUrl` | `/?s={keyword}&post_type=product` (WordPress default search) |

---

## Provenance

| field | value |
|---|---|
| `profileVersion` | `1` |
| `lastVerified` | `2026-05-15` |
| `auditNotes.runId` | `greatnorthgunco.ca-2026-05-15T18-40-47Z-B4R1` |
| `auditNotes.probeIp` | `audit-host` |

### Field confidence

| field | confidence |
|---|---|
| `platform` | high |
| `adapterType` | high |
| `hasWaf` | high |
| `wafType` | high |
| `hasCaptcha` | high |
| `needsPlaywright` | high |
| `expectedProductCount` | high |
| `productCountMethod` | high |
| `catalogUrls` | high |
| `sortParam` | high |
| `sortVerified` | high |
| `perPage` | high |
| `paginationPattern` | high |
| `crawlers.watermark.method` | high |

### Stage notes

1. **Stage 1:** apex 200 LiteSpeed; www 301 → apex. canonical = `https://greatnorthgunco.ca`.
2. **Stage 2:** 8-batch probe header-layer clean (no cf-ray, sucuri, Akamai, SQLi/XSS/rate-limit). Honeypots return generic LiteSpeed 403 (origin filter, not WAF). BUT `/shop/`, `/wp-json/*`, `/product*/*` return `openresty/1.29` with 11–12KB JS challenge — **Imunify360 Bot Protection**. Stealth Playwright (init scripts overriding `navigator.webdriver`, `outerWidth`, plugins/mimeTypes prototypes) bypasses cleanly.
3. **Stage 3:** WordPress 6.9.4 + WooCommerce 10.7.0 (giga-store-pro theme). Yoast SEO, LiteSpeed Cache, reCAPTCHA v3 site-wide via CF7 (informational only). No age-gate. `needsPlaywright=true`.
4. **Stage 4:** `catalogUrls = ['/shop/']` proven 100%-coverage of customer-visible 516 (sum of 17 `wp/v2/product_cat` counts = 516 exact). 22 pages × 24 = 528 max. All 17 categories firearm-relevant.
5. **Stage 5:** pagination type=`path`, template `/page/{N}` (project convention — DB uses same, no trailing slash). perPage=24, theme-capped (`?ppp=100` ignored). Page-1 vs page-2 zero-overlap PASSED.
6. **Stage 6:** 3-outcome test with cache-bust verdict = `honored-default-is-newest`. `?orderby=date` accepted and matches default. Independently cross-checked against sitemap `lastmod`: husqvarna-1640 has most recent lastmod = page-1-first-product → confirmed.
7. **Stage 7:** WC Store API two-probe via warmed Playwright session — `after=2099 → 0`, `after=1999 → 516`. `api-date-since-watermark` verified.
8. **Stage 8:** `expectedProductCount=4292` via `wp-rest-header` on `/wp-json/wp/v2/product`. Matches sitemap dedup (4292). Customer-visible is 516; chose admin REST to match DB-baseline approach. **Known gap:** runtime probe's `wp-rest-header` arm uses plain axios (no Playwright fallback) — will hit Imunify with `hasWaf=true`. Operator must either patch the probe or switch method to `catalog-walk-only` (which DOES respect `hasWaf → Playwright`).
9. **Stage 9:** validator passes `valid: true, score: 100`.

### Known gaps

- Runtime `product-count-probe.ts` `wp-rest-header` arm uses plain axios, not Playwright. Operator must patch to honor `hasWaf=true` or switch productCountMethod.
- DB siteProfile (2026-04-07) has `hasWaf=false`. Either Imunify360 was added since, or the prior probe IP wasn't challenged. Re-confirm from production crawler IP before promoting `hasWaf=true` to DB.
