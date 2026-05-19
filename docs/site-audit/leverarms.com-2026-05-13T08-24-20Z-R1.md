# Pre-Bootstrap Output — leverarms.com

> **Result:** ready for operator review.
> 9 required + 7 recommended validator checks expected pass. No active WAF, no CAPTCHA, no age-gate. **356 products** discovered across **6 top-level categories** (5 true + the in-house `all-product` aggregator), 100% coverage verified.

---

## At a glance

| What | Value |
|---|---|
| Site runs on | **WordPress 6.9.4 + WooCommerce 10.7.0** (uses `woocommerce` adapter) |
| Protections in front | **Cloudflare-passive** — `hasWaf=false` (operationally), `hasCaptcha=false`, no age-gate |
| Catalog | **356 products** across **6 top-level categories** |
| Page walking | path-style → `/page/{N}/` · `perPage=16` HTML / `100` Store API cap |
| Sort | **`?orderby=date`** · verified honored (3-outcome counter-control) |
| New-item crawl | `crawlers.watermark.method = api-date-since-watermark` |
| Re-verify in maintain phase | `crawlers.maintain.verifyMethod = store-api` |

---

## Identity

The skill matched the homepage signals to **WooCommerce** (generator meta + `wp-content/plugins/woocommerce` assets + working WC Store API).

| field | value |
|---|---|
| `platform` | `woocommerce` |
| `adapterType` | `woocommerce` |

---

## Access — getting in safely

Cloudflare sits in front (cf-ray on every response, `__cf_bm` cookies), and Cloudflare's managed-rules WAF fires on attack payloads (SQLi UNION, XSS). None of the crawler paths trip a rule — homepage, `/product-category/*`, `/wp-json/wc/store/v1/*` all return 200 cleanly. Operationally treated as no WAF.

| field | value | meaning |
|---|---|---|
| `hasWaf` | **`false`** | Cloudflare-passive; crawler paths never blocked |
| `wafType` | `"cloudflare-passive"` | informational |
| `wafLastProbedAt` | `2026-05-13T08:20:16Z` | when 8-batch probe ran |
| `wafProbeMethod` | `heavy-8-batch` | which probe method |
| `hasCaptcha` | **`false`** | no CAPTCHA on crawler paths |
| `captchaType` | `null` | — |
| `ageGate.detected` | **`false`** | no age-confirmation interstitial |
| `userAgentOverride` | `null` | default desktop UA works |
| `needsPlaywright` | **`false`** | plain HTTP returns valid JSON + HTML |

> **Probe evidence** (`wafProbeEvidence`): cf-ray + cf-cache-status present on every response. Rapid-burst 10 GETs all 200. Batches 6b (UNION SELECT) and 7a (`<script>` payload) blocked with 403 nginx body (NOT a Cloudflare challenge HTML) — Cloudflare's managed rules. Honeypots `.env`, `.git/config`, `xmlrpc.php` all 403. No-UA returns 200. No plugin-WAF body markers (no MalCare / Wordfence). Catalog and API paths clean.

---

## Catalog discovery — where the products are

**`catalogUrls`** — 6 URLs, all 6 needed for 100% coverage (proven by full Store-API walk + ID-level union):

| Category | Walked unique | URL |
|---|---:|---|
| All Product (aggregator) | **331** | `/product-category/all-product/` |
| Kit (accessories/parts/optics/cleaning) | 216 | `/product-category/kit/` |
| Ammo | 124 | `/product-category/ammo/` |
| All Surplus | 104 | `/product-category/all-surplus/` |
| Guns (rifles/shotguns/handguns/used) | 34 | `/product-category/guns/` |
| Food (Peak Refuel freeze-dried) | 11 | `/product-category/food/` |

**`topLevelCategories.totalsSumCheck`:**

> Union of all 6 = **356 unique product IDs** = WC Store API `x-wp-total` (0% drift).
> `all-product` covers 331/356; 25 products fall outside `all-product` and require the 5 true top-level cats.
> `all-product` contributes 9 unique products NOT in the union of the other 5.
> All 6 URLs kept — each contributes >=1 unique product. No category dropped.

**`extractionSample`** — 3 products from guns page 1, all 4 required fields populated (standard WC `woocommerce-loop-product__title` + `.woocommerce-Price-amount` + `instock` class):

| `title` | `price` | `stockStatus` |
|---|---:|---|
| post-4152 (bolt-action rifle, guns p1) | $805.99 | `in_stock` |
| post-2135 (semi-auto rifle, guns p1) | $499.99 | `in_stock` |
| post-36834 (semi-auto rifle, guns p1) | $599.99 | `in_stock` |

`extractionTested = true`.

---

## Pagination & sort — how to traverse

| field | value | meaning |
|---|---|---|
| `paginationPattern.type` | **`path`** | URL-path style, not query |
| `paginationPattern.template` | `/page/{N}/` | standard WordPress permalink form |
| `paginationPattern.perPage` | **`16`** | HTML category default (no per-page selector) |
| `paginationPattern.firstPageHasParam` | `false` | page 1 = bare category URL |
| `paginationPattern.startPage` | `1` | — |
| `paginationPattern.zeroIndexed` | `false` | — |
| `sortParam` | **`"?orderby=date"`** | WooCommerce-standard query-form sort |
| `sortVerified` | **`true`** | proved via 3-outcome counter-control |

> **How sort was verified:** with cache-bust `&_=<nonce>`: default first-3 IDs = `[4152, 2135, 36834]`. `?orderby=date` first-3 = `[53271, 53140, 53134]` (descending newest IDs). `?orderby=price` first-3 = `[50371, 53129, 51179]`. Three distinct sequences confirms the param is honored, default is popularity (not date), and sort isn't NOOP.

---

## Inventory size

| field | value |
|---|---|
| `expectedProductCount` | **`356`** |
| `productCountMethod` | `{ method: "wp-rest-header", endpoint: "/wp-json/wc/store/v1/products", header: "x-wp-total" }` |

> Read from the WC Store API: `GET /wp-json/wc/store/v1/products?per_page=1` -> response header `x-wp-total: 356`. Verified by walking all 4 pages of 100 -> 356 unique IDs (0% drift). Note `/wp-json/wp/v2/product` (admin REST) reports 971 — that includes drafts/private; the Store API value is the customer-visible total and the correct one for runtime.

---

## Crawler config — runtime behavior

| Phase | field | value | what it means |
|---|---|---|---|
| **Tier 1 (new items)** | `crawlers.watermark.method` | **`api-date-since-watermark`** | use Store API `?after=<ISO date>` to filter newest-first |
| Bootstrap | `crawlers.bootstrap.apiEndpoints` | `{products: "/wp-json/wc/store/v1/products", categories: "/wp-json/wp/v2/product_cat"}` | full WP/WC API access |
| Maintain | `crawlers.maintain.verifyMethod` | **`store-api`** | batch verify via Store API (fast) |
| Maintain | `crawlers.maintain.verifyEndpoint` | `/wp-json/wc/store/v1/products` | endpoint for batch verify |

> **Why `api-date-since-watermark`:** WC two-probe passed. `GET /wp-json/wp/v2/product?after=2099-01-01T00:00:00&per_page=1` -> `x-wp-total: 0`. `GET ...?after=1999-01-01T00:00:00&per_page=1` -> `x-wp-total: 971`. Date filter is honored. The watermark crawler filters by `after=<last seen product date>` ascending and walks forward toward newest.

---

## Platform extras

| field | value | reason |
|---|---|---|
| `classifiedRules` | *(omitted)* | not a classifieds adapter |
| `ecwidStoreId` | *(omitted)* | not an Ecwid site |
| `wafWorkaround` | *(omitted)* | headers parse cleanly, no `HPE_INVALID_HEADER_TOKEN` |
| `productUrlSchemes` | *(omitted)* | single canonical `/shop/<category-path>/<slug>/` form |
| `searchUrl` | *(omitted — not derived this run)* | WC default `/?s={keyword}&post_type=product` is standard; operator can add if needed |

---

## Provenance

| field | value |
|---|---|
| `profileVersion` | `1` |
| `lastVerified` | `2026-05-13` |
| `auditNotes.runId` | `R1-2026-05-13T08-24-20Z` |
| `auditNotes.probeIp` | audit-host (single-IP; production WAF re-confirm recommended) |

**Field confidence:**

| field | confidence |
|---|---|
| `platform` | high |
| `hasWaf` | high |
| `catalogUrls` | high |
| `paginationPattern` | high |
| `sortParam` | high |
| `expectedProductCount` | high |
| `crawlers.watermark.method` | high |

**Stage notes:**

1. Stage 1: apex 200 + www->apex 200 (302 follow). `<link rel="canonical">` declares `https://leverarms.com/`. Canonical = apex.
2. Stage 2: heavy-8-batch ran 2026-05-13T08:20:16Z. cf-ray + `__cf_bm` on every response. Rapid burst 10x 200. BATCH 6b UNION 403, BATCH 7 XSS 403 (rule-selective, generic nginx body). BATCH 4 honeypots 403. BATCH 8 no-UA 200. No plugin-WAF body markers. Verdict: Cloudflare-passive, operationally `hasWaf=false`.
3. Stage 3: `<meta name="generator" content="WordPress 6.9.4">` and `<meta name="generator" content="WooCommerce 10.7.0">`. WC Store API `/wp-json/wc/store/v1/products` returns valid JSON. `adapterType=woocommerce`.
4. Stage 4: `/wp-json/wp/v2/product_cat` returned 42 categories; 6 top-level (`parent=0`). Walked each via Store API `category=<id>` param. Union of all 6 = 356 = global Store API `x-wp-total` (0% drift). Each contributes uniquely (smallest = `food` with 11). No category dropped.
5. Stage 5: `/product-category/guns/page/2/` STATUS 200. Page-1 (16 IDs) vs page-2 (16 IDs) overlap = 0. Pattern = `/page/{N}/`. perPage = 16 (no per-page selector on HTML).
6. Stage 6: 3-outcome test with cache-bust `&_=<nonce>`. default = `[4152, 2135, 36834]`; `?orderby=date` = `[53271, 53140, 53134]`; `?orderby=price` = `[50371, 53129, 51179]`. Three distinct sequences -> `orderby=date` honored.
7. Stage 7: WC two-probe: `?after=2099-01-01` -> x-wp-total=0; `?after=1999-01-01` -> x-wp-total=971. Date filter honored. `method=api-date-since-watermark`.
8. Stage 8: WC Store API `per_page=1` -> `x-wp-total: 356`. Walk confirmed 356 unique IDs across 4 pages of 100. `productCountMethod` object matches `wp-rest-header` arm in `backend/src/services/product-count-probe.ts`.
9. Stage 9: candidate JSON + this MD written to `docs/site-audit/`. Validator run by operator.
