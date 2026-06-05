# Pre-Bootstrap Output — kodiakdefence.com

> **Result:** ready-with-operator-action. Validator score **100/100**, 21/21 checks pass, 0 failures. Site is **WooCommerce 10.7.0** on WordPress 6.9.4, **181 products total**, single catalog URL `/shop/` covers 100%. **Active WAF = Imunify360** (new wafType for this codebase — JS challenge on every interior path, including `/wp-json/*` API endpoints). Production WAF cookie manager + Playwright auto-handles the challenge once `hasWaf: true` is set. **Two operator actions required before promotion** — see Section 9.

---

## 1. At a glance

| What | Value |
|---|---|
| **Platform / adapter** | `woocommerce` 10.7.0 on WordPress 6.9.4 (`adapterType: woocommerce`) |
| **Protections** | `hasWaf=true` (`imunify360`), `hasCaptcha=false`, `ageGate.detected=false` |
| **Catalog size** | **181** products, **1** catalog URL (`/shop/`) covering 100% |
| **Page walking** | `path` style `/shop/page/{N}/`, perPage **16**, lastPage **12** |
| **Sort** | `?orderby=date` honored (newest-first); **sortVerified=true** |
| **New-item crawl** | `api-date-since-watermark` via WP REST `modified_after` |
| **Maintain verify** | `store-api` against `/wp-json/wc/store/v1/products` (operator may switch to `detail-page` for restock detection) |

---

## 2. Identity

| field | value |
|---|---|
| `platform` | `"woocommerce"` |
| `adapterType` | `"woocommerce"` |

Three independent signals lock the platform: `<meta name="generator" content="WooCommerce 10.7.0">`, `<meta name="generator" content="WordPress 6.9.4">`, and 173 `woocommerce-*` CSS class references on the homepage. Theme is `dt-the7` (The7 by DreamTeam). The platform → adapter mapping is the default — no `auditNotes.adapterTypeOverride` is set.

---

## 3. Access — getting in safely

| field | value | meaning |
|---|---|---|
| `hasWaf` | **`true`** | Active WAF challenges every interior path |
| `wafType` | `"imunify360"` | Imunify360 plugin (Linux-based hosting WAF; NEW for this codebase — no dedicated handler) |
| `wafLastProbedAt` | `"2026-05-25T17:03:24.000Z"` | Today |
| `wafProbeMethod` | `"heavy-8-batch"` | Plus extended manual probes on `/shop/`, `/product-category/*`, `/wp-json/*` |
| `hasCaptcha` | `false` | No reCAPTCHA / hCaptcha / Turnstile scripts on homepage |
| `captchaType` | `null` | n/a |
| `ageGate.detected` | `false` | No click-through or DOB form |
| `userAgentOverride` | `null` | Playwright's built-in Chrome 131 UA works; no override needed |
| `needsPlaywright` | **`true`** | Imunify360 JS challenge requires browser to solve |

> **Probe evidence summary:** The standard 8-batch probe on `/` saw nginx-only, 200 status across all UAs, no `cf-ray`, no `x-sucuri`, no plugin body markers — looked clean. Extended manual probes on interior paths uncovered the real picture: `/shop/`, `/product-category/firearms/`, `/cart/`, `/contact/`, `/wp-json/*` ALL return HTTP **200 with a 4744-byte JS-reload interstitial** titled "One moment, please..." — Imunify360's challenge page. JSON API paths additionally return `{"message":"Access denied by Imunify360 bot-protection. IPs used for automation should be whitelisted"}` with HTTP 200 before challenge solve. The existing `waf-cookie-manager.ts` Playwright-warm-then-cache flow handles this: homepage `goto` with `networkidle` solves the challenge (~6-7s), captured cookies authenticate subsequent API calls (verified live: WC Store API and WP REST both return 200 + real data through the warmed page context). Honeypot paths return 403; SQLi/XSS-shaped query strings return 415 from nginx (separate origin-tier filter, NOT WAF-driven).

---

## 4. Catalog discovery — where the products are

| Category (root) | id | products | permalink |
|---|---|---|---|
| Gun Parts | 23 | 93 | `https://kodiakdefence.com/product-category/gun-parts/` |
| Accessories | 22 | 81 | `https://kodiakdefence.com/product-category/accessories/` |
| Magpul-USA | 21 | 63 | `https://kodiakdefence.com/product-category/magpul-usa/` |
| Rifles | 18 | 16 | `https://kodiakdefence.com/product-category/rifles/` |
| Magazines | 34 | 15 | `https://kodiakdefence.com/product-category/magazines/` |
| Uncategorized | 15 | 8 | `https://kodiakdefence.com/product-category/uncategorized/` |
| Deal | 35 | 2 | `https://kodiakdefence.com/product-category/deal/` |

`topLevelCategories.totalsSumCheck`: sum-of-root-cat-counts = **278**, expectedProductCount = **181**, overlap = **97** (products multi-tagged across roots — e.g. every Magpul-USA item also tags Accessories+Gun Parts). Per Rule C, the smallest URL set that covers 100% of firearm-relevant products is **one URL** — `/shop/` — because it returns ALL 181 products (confirmed via WC Store API `x-wp-total: 181` AND HTML `Showing 1-16 of 181 results`). The per-category list above is recorded for operator reference but is NOT the `catalogUrls`.

**Stale nav links:** the homepage also links to `/product-category/handguns/` and `/product-category/handguard-wk180c/` (the latter is a child of gun-parts). Both render as soft-200 with `<title>Page not found - Kodiak Defence</title>` and zero products — filtered out per B1 live-URL gate.

**Extraction sample (3 random products from page 1 of `/shop/`):**

| url | title | price | stockStatus |
|---|---|---|---|
| `https://kodiakdefence.com/shop/2-5mm-long-arm-bondhus-wrench/` | `2.5MM LONG ARM BONDHUS WRENCH` | **2.50** | `in_stock` |
| `https://kodiakdefence.com/shop/alcor-223-non-restricted/` | `Alcor 223 Non-Restricted` | **1499.99** | `in_stock` |
| `https://kodiakdefence.com/shop/wk180c-lower-parts-kit-with-external-bolt-catch/` | `WK180C Lower Parts Kit with External Bolt Catch` | `null` | `in_stock` |

`extractionTested = true`. All three samples yield title, URL, stockStatus. Two yield price; one has no price (HTML doesn't render a price for that product — Store API may have it).

> **Adapter selector gap (operator action):** KDC's product cards are `<article class="post-N type-product ...">` nested inside `<div class="wf-cell">`. The WC adapter `extractCatalogProducts` SELECTORS array at [`woocommerce.ts:648-657`](../../backend/src/services/scraper/adapters/woocommerce.ts) does NOT include an `<article>` matcher; the closest entry is `div[class*="product"][class*="type-product"]` which matches `<div>` not `<article>`. **HTML extraction will return 0 products** until `'article[class*="type-product"]'` is added to the SELECTORS array. The WC Store API path (used for maintain verify + watermark via `/wp-json/wc/store/v1/products`) is unaffected and works correctly.

---

## 5. Pagination & sort — how to traverse

| field | value | meaning |
|---|---|---|
| `paginationPattern.type` | `"path"` | URL path segment, not query param |
| `paginationPattern.template` | `"/page/{N}/"` | `/shop/` + this = `/shop/page/2/`, `/shop/page/3/`, ... |
| `paginationPattern.perPage` | `16` | Theme fixed; no `?perpage=N` override |
| `paginationPattern.firstPageHasParam` | `false` | Page 1 = `/shop/` (no `/page/1/`) |
| `paginationPattern.startPage` | `1` | Conventional 1-indexed |
| `paginationPattern.zeroIndexed` | `false` | Page numbering starts at 1 |
| `perPage` | `16` | Same as `paginationPattern.perPage` |
| `sortParam` | `"?orderby=date"` | WooCommerce default sort param, newest-first |
| `sortVerified` | **`true`** | 3-outcome counter-control test passed |

> **Sort verification:** I drove three live fetches with cache-bust querystrings. **Default** (`/shop/?_cb=1`) returned product IDs `[58081, 58077, 58079]` — Bondhus wrench accessories, menu_order. **`?orderby=date&_cb=2`** returned `[60845, 60840, 60838]` — descending post IDs, confirms newest-first. **`?orderby=price&_cb=3`** (counter-control) returned `[57822, 55638, 55664]` — low-price items. All three first-3 lists are distinct → sort is honored AND the default is NOT already newest. Pagination zero-overlap confirmed too: `/shop/` first-16 IDs and `/shop/page/2/` first-16 IDs are fully disjoint sets.

---

## 6. Inventory size

| field | value |
|---|---|
| `expectedProductCount` | **`181`** |
| `productCountMethod` | `{ "method": "wp-rest-header", "endpoint": "/wp-json/wc/store/v1/products", "header": "x-wp-total" }` |

> **Count source (live):** `GET /wp-json/wc/store/v1/products?per_page=1` through warmed Playwright context returns `x-wp-total: 181`, `x-wp-totalpages: 181`. Cross-checked against WP REST core (`/wp-json/wp/v2/product?per_page=1` → `x-wp-total: 181`) and against the HTML result-count on `/shop/page/1/` (`"Showing 1-16 of 181 results"`) and `/shop/page/12/` (`"Showing 177-181 of 181 results"`). All three surfaces agree. The endpoint pairs with `crawlers.maintain.verifyMethod: store-api` per the SKILL.md B8 rule (Store API ↔ Store API endpoint; the validator's `endpointPairsVerifyMethod` check passes).

---

## 7. Crawler config — runtime behavior

| Phase | field | value | what it means |
|---|---|---|---|
| Watermark | `crawlers.watermark.method` | **`"api-date-since-watermark"`** | New-item crawl walks WP REST `modified_after` window |
| Watermark | `crawlers.watermark.dateFilterApi` | `"wp-rest-core"` | Hits `/wp-json/wp/v2/product` (matches runtime hardcode at `woocommerce.ts:337`) |
| Watermark | `crawlers.watermark.dateFilterField` | `"modified_after"` | Catches restocks + price changes, not just new-product creation |
| Maintain | `crawlers.maintain.verifyMethod` | `"store-api"` | Batch API check; ~1 req per 10 products. **Restock alerts NOT guaranteed** for store-api (worker.ts:549 OOS-transition early-return). |
| Maintain | `crawlers.maintain.verifyEndpoint` | `"/wp-json/wc/store/v1/products"` | Store API endpoint |

> **Watermark verification:** Two-probe test confirmed `modified_after` honored on WP REST core — `?modified_after=2099-01-01T00:00:00&per_page=1` returned `x-wp-total: 0` (empty body); `?modified_after=1999-01-01T00:00:00&per_page=1` returned `x-wp-total: 181` (full body). Same result on WC Store API with `?after=` parameter. **Reason for picking Method A:** the WC adapter at `woocommerce.ts:337` hardcodes `modified_after` against WP REST core, the date filter is honored, and the site is small (181 products) so the new-items window walk is sub-second per probe.

---

## 8. Platform extras

| field | value | reason |
|---|---|---|
| `classifiedRules` | (not emitted) | adapterType=`woocommerce`, not classifieds-* |
| `ecwidStoreId` | (not emitted) | platform=`woocommerce`, not ecwid-* |
| `wafWorkaround` | (not emitted) | nginx headers are well-formed; no `HPE_INVALID_HEADER_TOKEN` cascade |
| `productUrlSchemes` | (not emitted) | All products use single URL form `/shop/<slug>/` |
| `searchUrl` | (not emitted — see note) | WooCommerce default `/?s={keyword}&post_type=product` exists but is gated by Imunify360 JS challenge for non-warmed clients; user-search workflow needs `hasWaf: true` to route through the cookie manager. Omitted to avoid documenting an unverified URL. Operator may add `"searchUrl": "/?s={keyword}&post_type=product"` if the user-search workflow already runs through Playwright. |
| `bigcommerce` | (not emitted) | not BC |

---

## 9. Provenance

| field | value |
|---|---|
| `profileVersion` | `1` |
| `lastVerified` | `"2026-05-25"` |
| `auditNotes.runId` | `"pre-bootstrap-2026-05-25-kodiakdefence"` |
| `auditNotes.probeIp` | audit-IP (operator MUST re-confirm WAF behavior from production crawler IP — Imunify360 maintains per-IP allow-lists) |
| `auditNotes.expectedCountSurface` | `"wc-store-api"` |
| `auditNotes.wcCategoryApi` | `"store-api"` |
| `auditNotes.dbColumnFlips` | `{ hasWaf: true, wafType: "imunify360", wafWorkaround: null }` |

**Field confidence:**

| field | confidence |
|---|---|
| `platform`, `adapterType`, `hasWaf`, `wafType`, `hasCaptcha`, `ageGate`, `needsPlaywright`, `catalogUrls`, `paginationPattern`, `perPage`, `sortParam`, `sortVerified`, `expectedProductCount`, `productCountMethod`, `crawlers.watermark.method` | **high** (live-probed this session) |
| `crawlers.maintain.verifyMethod` | **policy-decision** (operator chooses store-api vs detail-page) |

**Stage notes (one per stage):**

1. **Stage 1 — Canonical URL:** Both apex and www return 200 on Chrome 120 production UA. Homepage emits `<link rel="canonical" href="https://kodiakdefence.com/">` declaring apex as canonical. No `hreflang` (single-locale site). Server is nginx. Canonical origin = `https://kodiakdefence.com`.
2. **Stage 2 — WAF:** 8-batch heavy probe on `/` saw nginx-only, no CDN headers, no plugin body markers — false-clean. Extended probe across 6 interior paths uncovered Imunify360 JS challenge on every non-`/` GET. New wafType for this codebase.
3. **Stage 3 — Platform:** 3 generator meta tags (AIOSEO, WordPress 6.9.4, WooCommerce 10.7.0), 173 `woocommerce-*` class refs, dt-the7 theme. adapterType=`woocommerce`.
4. **Stage 4 — Catalog URLs:** 181 products globally. `/shop/` is the single 100% coverage URL (verified via WC Store API `x-wp-total: 181` AND HTML result-count). 7 root categories total, multi-tag overlap = 97. Two stale `/product-category/*` URLs filtered out (Page not found titles per B1).
5. **Stage 5 — Pagination:** Path-style `/shop/page/{N}/`, perPage=16, lastPage=12. Page 2 product set fully disjoint from page 1.
6. **Stage 6 — Sort:** `?orderby=date` honored; 3-outcome counter-control test all distinct (default `[58081,58077,58079]` vs date `[60845,60840,60838]` vs price `[57822,55638,55664]`).
7. **Stage 7 — Watermark method:** WP REST `?modified_after` two-probe: 2099→0, 1999→181. `api-date-since-watermark` viable; matches runtime hardcode.
8. **Stage 8 — Product count:** `wp-rest-header` against `/wp-json/wc/store/v1/products` → `x-wp-total: 181`. Matches HTML and WP REST core.
9. **Stage 9 — Validation:** validateSiteProfile → valid:true, score:100, 21/21 passed checks, 0 failures, 0 warnings.

**Operator decisions required before promotion:**

1. **Patch WC adapter SELECTORS** at `backend/src/services/scraper/adapters/woocommerce.ts:648-657` — add `'article[class*="type-product"]'` so HTML extraction works on KDC's `<article>` wrapper. Without this, the HTML walk path returns 0 products. (The Store API path used by watermark + maintain is unaffected.)
2. **Pick `verifyMethod`** — `store-api` (default, restock alerts NOT guaranteed per worker.ts:549) vs `detail-page` (slower, restock alerts work). Small site (181 products), low expected restock volume → store-api is likely acceptable. Operator decides.
3. **Re-confirm WAF from production crawler IP** — Imunify360 maintains per-IP reputation. The audit IP returned the JS challenge on every interior path; production IP may be allow-listed (or further restricted). One Playwright test from production crawler IP confirms.
4. **Optional: add `'One moment, please'` to the isBlocked regex** at `catalog-crawler.ts:419` for defense-in-depth (today, KDC's 4744-byte challenge body slips past the existing markers; the WC adapter's `ensureCookies()` path still catches it via `hasWaf:true`, so this is belt-and-suspenders).
