# Pre-Bootstrap Output — internationalshootingsupplies.com

> **Result:** ready (16/16 validator passes). Canadian WooCommerce 10.7.0 storefront on Astra theme. No CDN WAF, no CAPTCHA gate, no age gate. BulletProof Security plugin blocks SQLi/XSS payloads at app layer only (does not affect catalog crawl). 2,314 customer-visible products across 9 top-level categories; runtime walks 77 leaf-category catalog URLs (parent URLs show subcat tiles only). Path-style pagination, query-style sort, WP REST `?after=` watermark.

---

## 1. At a glance

| What | Value |
|---|---|
| Platform / adapter | **`woocommerce`** / `woocommerce` |
| Protections | hasWaf=**`false`**, hasCaptcha=`false` (recaptcha-v3 sitewide via CF7, non-gating), ageGate=`false` |
| Catalog size | **`2,314`** products (WC Store API customer-visible) |
| Catalog URLs | **`77`** leaf categories (98.3% coverage; 40-product 1.7% gap) |
| Pagination | path `/page/{N}/`, perPage **`12`** |
| Sort | `?orderby=date` (verified 3-outcome, **`sortVerified=true`**) |
| Watermark | **`api-date-since-watermark`** (WP REST `?after=` two-probe passed) |
| Maintain verify | `store-api` via `/wp-json/wc/store/v1/products` |

---

## 2. Identity

| field | value |
|---|---|
| `platform` | `"woocommerce"` |
| `adapterType` | `"woocommerce"` |

WooCommerce 10.7.0 detected via `wp-content/plugins/woocommerce/assets/client/blocks/wc-blocks.css?ver=wc-10.7.0` and many WC plugin assets in homepage HTML. Theme = `astra` (parent) + `astra-child`. `adapterType` mapping for WC sites is `woocommerce` per the platform-to-adapter table.

---

## 3. Access — getting in safely

| field | value | meaning |
|---|---|---|
| `hasWaf` | **`false`** | No CDN WAF gating the catalog crawler |
| `wafType` | `null` | No CDN; informational note for BPS plugin in auditNotes |
| `wafLastProbedAt` | `2026-05-15T09:05:23.928Z` | This run |
| `wafProbeMethod` | `"heavy-8-batch"` | All 8 batches executed |
| `wafProbeResult` | one-line composite verdict (see evidence) | Composite verdict |
| `hasCaptcha` | **`false`** | reCAPTCHA v3 loaded sitewide via CF7 but does not gate product pages |
| `captchaType` | `"recaptcha-v3"` | Script tag `google.com/recaptcha/api.js?render=...` present in homepage |
| `ageGate.detected` | `false` | No age-gate markers in homepage HTML |
| `userAgentOverride` | `null` | Default desktop UA works for all paths |
| `needsPlaywright` | **`false`** | Plain HTTP returns 200 + products on leaf catalog URLs and product detail pages |

> **wafProbeEvidence summary**: server header `nginx` only — no `cf-ray`, `x-sucuri-id`, `incapsula`, `AkamaiGHost`. Homepage `X-Cache: HIT`. SQLi payload (`?id=1' OR '1'='1`) and XSS payload (`?q=<script>...`) return **403** with body containing `bpsMessage` + `BPS Plugin 403 Error Page` — BulletProof Security WordPress plugin, app-layer payload filter (NOT a CDN WAF). Honeypot paths `/.env` and `/.git/config` return generic nginx 403; `/xmlrpc.php` connection reset. Rapid burst 10 GETs in 2s all returned 200 with consistent ~1.1s timing. No-UA and bot UA both returned 200. No plugin-WAF body markers (MalCare/Wordfence) on any batch.

---

## 4. Catalog discovery — where the products are

| Top-level cat | Direct API count | Notes |
|---|---|---|
| `/product-category/ammunition/` | 14 | parent-only tagged products |
| `/product-category/firearms/` | 473 | parent + descendant tagged; parent p1 shows tiles only |
| `/product-category/hunting-accessories/` | 252 | parent + descendant |
| `/product-category/manufacturers/` | 249 | brand axis (overlapping with product axes) |
| `/product-category/novelties/` | 44 | small leaf |
| `/product-category/optics/` | 50 | parent + descendant |
| `/product-category/parts/` | 308 | parent + descendant |
| `/product-category/reloading-components/` | 8 | parent + descendant |
| `/product-category/reloading-equipment/` | 491 | parent + descendant |
| `/product-category/shooting-accessories/` | 687 | parent + descendant |
| `/product-category/uncategorized/` | 1 | residue, excluded |

> **totalsSumCheck**: WC Store API global count = **2,314** customer-visible products. Sum of 9 productive non-manufacturers top-level cats = 2,327 (0.6% cross-tag overlap with brand axis). Final `catalogUrls` = **77 non-manufacturer leaf categories** summing to **2,274 products = 98.3% coverage**. The 40-product (1.7%) gap is products tagged ONLY to a parent cat without any leaf — these are unreachable via leaf walking. Parent URLs CANNOT be used as catalogUrls because Astra theme renders subcategory tiles on parent page 1 (0 products) — runtime `catalog-crawler.ts:471` bails on `products.length === 0` for non-WAF sites. Manufacturer leaves (1,613 products) excluded — pure brand axis, fully overlaps with product axes.

| Sample product (extractionSample) | title | category |
|---|---|---|
| `/product/aguila-6-5-creedmoor-140gr-fmjbt-20-round-box/` | Aguila 6.5 Creedmoor 140Gr FMJBT 20 Round Box | rifle-ammo |
| `/product/uberti-1894-carbine-30-30-win-20-barrel/` | Uberti 1894 Carbine 30-30 Win 20 Barrel | firearms/rifles |
| `/product/cz-600-trail-fde-223-rem-16-barrel-m15x1-threaded-muzzle/` | CZ 600 Trail FDE 223 Rem 16 Barrel M15x1 Threaded Muzzle | firearms/rifles |

`extractionTested = true` — sample product titles and URLs verified extractable via standard WC `li.product` + `woocommerce-loop-product__title` selectors used by `woocommerce.ts:extractCatalogProducts`.

---

## 5. Pagination & sort — how to traverse

| field | value | meaning |
|---|---|---|
| `paginationPattern.type` | `"path"` | URL path segment, not query param |
| `paginationPattern.template` | `"/page/{N}/"` | Append to catalogUrl |
| `paginationPattern.perPage` | **`12`** | Astra default; no `<select>` to override |
| `paginationPattern.firstPageHasParam` | `false` | Page 1 is bare URL `/product-category/X/Y/` |
| `paginationPattern.startPage` | `1` | 1-indexed |
| `paginationPattern.zeroIndexed` | `false` | |
| `perPage` | `12` | Same as above |
| `sortParam` | `"?orderby=date"` | Query-form sort, newest-first |
| `sortVerified` | **`true`** | 3-outcome counter-control passed |

> **Sort verification**: on `/product-category/firearms/rifles/`, default first 3 products = `[uberti-1894-carbine, adler-arms-rf-224-tac-gen-2-22-lr, adler-arms-rf-224-tac-gen-2-bronze]`. With `?orderby=date` first 3 = `[cz-600-trail-fde-223-rem, rossi-r95-trapper-444-mar, ruger-americanrifle-gen-ii-predator-308-win]` — different from default (sort honored). Counter-control `?orderby=price` returned `[chiappa-little-badger-22lr, consignment-winchester-model-67a, savage-arms-mark-ii-f-22lr]` — also different from default. Cache-bust nonce appended to all three URLs.

> **Pagination verification**: `/product-category/firearms/rifles/page/2/` returned 12 distinct products (`antler-arms-*` series) — zero overlap with page 1's `adler-arms-*` series.

---

## 6. Inventory size

| field | value |
|---|---|
| `expectedProductCount` | **`2,314`** |
| `productCountMethod` | `{method: "wp-rest-header", endpoint: "/wp-json/wc/store/v1/products", header: "x-wp-total"}` |

> **Source**: `GET https://internationalshootingsupplies.com/wp-json/wc/store/v1/products?per_page=1` returned response header `X-WP-Total: 2314`. Verified twice during Stage 7 watermark probe. Note: `/wp-json/wp/v2/product?per_page=1` (admin REST) returns `X-WP-Total: 5237` — that's the full inventory including drafts/private/non-public statuses. Per Stage 8 priority order, `wp-rest-header` with WC Store API endpoint is the customer-visible count and wins (priority 1). Sitemap product URL count = 5,237 (matches admin REST; includes non-public). The 2,314 vs 5,237 gap is expected on WC sites and does NOT trigger the Stage 8 cap-detection rule (that rule fires only when walked-count > probe-count, not the reverse).

---

## 7. Crawler config — runtime behavior

| Phase | field | value | meaning |
|---|---|---|---|
| watermark | `crawlers.watermark.method` | **`"api-date-since-watermark"`** | WP REST `?after=<ISO date>` walks forward from last seen date |
| bootstrap | `crawlers.bootstrap.apiEndpoints.wcStoreApi` | `"/wp-json/wc/store/v1/products"` | Customer-visible 2,314-product walk |
| bootstrap | `crawlers.bootstrap.apiEndpoints.wpRestApi` | `"/wp-json/wp/v2/product"` | Full 5,237-product walk if needed |
| maintain | `crawlers.maintain.verifyMethod` | `"store-api"` | Fast batch verification via WC Store API |
| maintain | `crawlers.maintain.verifyEndpoint` | `"/wp-json/wc/store/v1/products"` | Same endpoint as bootstrap customer-visible |

> **Watermark reason**: WP REST two-probe passed — `?after=2099-01-01T00:00:00` returns `x-wp-total: 0` (impossible-future returns nothing); `?after=1999-01-01T00:00:00` returns `x-wp-total: 5237` (matches global admin-REST total). The date filter is honored. Sort `?orderby=date` was also verified (Stage 6), so navigate-from-watermark would also work — but api-date-since-watermark is preferred (Method A, priority 1).

---

## 8. Platform extras

| field | value | reason |
|---|---|---|
| `classifiedRules` | (omitted) | Not a classifieds site |
| `ecwidStoreId` | (omitted) | Not an Ecwid site |
| `wafWorkaround` | (omitted) | No malformed-header issue |
| `productUrlSchemes` | (omitted) | Single canonical `/product/<slug>/` form |
| `searchUrl` | (omitted) | Out of scope for blind run; check operator review |

---

## 9. Provenance

| field | value |
|---|---|
| `profileVersion` | `1` |
| `lastVerified` | `2026-05-15` |
| `auditNotes.runId` | `R1-blind-skill-run-2026-05-15` |

**Field confidence**:

| field | confidence |
|---|---|
| `platform` | high |
| `adapterType` | high |
| `hasWaf` | high |
| `catalogUrls` | medium-high (98.3% coverage) |
| `sortParam` | high |
| `paginationPattern` | high |
| `expectedProductCount` | high |

**Stage notes**:

1. **Stage 1 — Canonical**: apex `https://internationalshootingsupplies.com` returns 200 cleanly; www subdomain fails TLS SNI (cert mismatch); homepage `<link rel="canonical">` confirms apex. Canonical = apex.
2. **Stage 2 — WAF/CAPTCHA**: 8-batch probe; no CDN markers (cf-ray/sucuri/incapsula/akamai absent); BulletProof Security WP plugin returns 403 on SQLi/XSS payloads (`BPS Plugin 403 Error Page` in body); honeypots return generic nginx 403; rapid burst all 200; recaptcha-v3 sitewide via CF7 non-gating.
3. **Stage 3 — Platform**: WooCommerce 10.7.0 (wc-blocks `?ver=wc-10.7.0`); Astra theme + child theme; no age-gate.
4. **Stage 4 — Catalog**: WC taxonomy API returned 207 categories across 3 pages; 13 top-level (10 productive); per-category counts re-queried via WC Store API (claimed `count` field was unreliable — Reloading Components claimed 2,283 but actual = 8); 79 non-manufacturer leaf categories with `count>0` then 77 after excluding `uncategorized`; parent URLs show subcategory tiles on p1 (cannot be used as catalogUrls); leaf-only sum = 2,274 / 2,314 = 98.3% coverage.
5. **Stage 5 — Pagination**: `/page/{N}/` path-form verified via `/product-category/firearms/rifles/page/2/` zero-overlap with page 1; perPage = 12 (Astra default; `?products_per_page=100` and `?posts_per_page=100` both ignored — server returns 12).
6. **Stage 6 — Sort**: `<select name="orderby">` exposes `popularity`, `date`, `price`, `price-desc`; 3-outcome counter-control test (default vs `?orderby=date` vs `?orderby=price`) with cache-bust nonce — all 3 outcomes returned distinct first-3 product sets — `honored`.
7. **Stage 7 — Watermark**: WP REST `?after=` two-probe passed (future=0, ancient=5237) — Method A `api-date-since-watermark`.
8. **Stage 8 — Count**: WC Store API `x-wp-total: 2314` — `wp-rest-header` method; sitemap shows 5,237 (admin/full); customer-visible 2,314 chosen per priority.
9. **Stage 9 — Assembly**: 16/16 validator passes; both files written; ready for audit-review-pipeline.
