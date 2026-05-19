# Pre-Bootstrap Output — shooterschoice.com

> **Result:** ready for operator review.
> 9 required + 7 recommended validator checks passed (16/16, score 100). Cloudflare-passive in front but does not block normal traffic; reCAPTCHA v3 loaded site-wide via Contact Form 7 but does not gate the crawl path. **4,493 products** discovered, reachable from a single `/shop/` catalog URL spanning 15 firearm-relevant top-level categories.

---

## At a glance

| What | Value |
|---|---|
| Site runs on | **WooCommerce 10.7.0** (uses `woocommerce` adapter) |
| Protections in front | **Cloudflare passive** — `hasWaf=false` operationally; reCAPTCHA v3 informational (`hasCaptcha=false`); no age-gate |
| Catalog | **4,493 products** reachable from `/shop/` (single URL spine) |
| Page walking | path-style `/page/{N}/`; `perPage=40` HTML, `100` Store API |
| Sort | **`?orderby=date`** verified honored via counter-control |
| New-item crawl | `crawlers.watermark.method = api-date-since-watermark` |
| Re-verify in maintain phase | `crawlers.maintain.verifyMethod = store-api` |

---

## Identity

The homepage exposed unambiguous WooCommerce 10.7.0 signals — `wp-content/plugins/woocommerce/assets/client/blocks/wc-blocks.css?ver=wc-10.7.0`, `woocommerce-loop-product__title` cards on category pages, and `body class="... woocommerce woocommerce-page tax-product_cat ..."`. Theme is `kingler-theme` (Mistake 39: theme is not platform; platform stays `woocommerce`).

| field | value |
|---|---|
| `platform` | `woocommerce` |
| `adapterType` | `woocommerce` |

---

## Access — getting in safely

Cloudflare sits in front (`cf-ray` on every batch) but only fires on XSS-shaped payloads — normal crawler traffic walks the catalog cleanly. Plain HTTP fetches with default desktop UA work; no Playwright needed.

| field | value | meaning |
|---|---|---|
| `hasWaf` | **`false`** | Cloudflare is passive; `cf-ray` present but all 8 probe batches and rapid-burst pass cleanly; operational rule says do not bake `hasWaf=true` for passive Cloudflare |
| `wafType` | `cloudflare-passive` | informational |
| `wafLastProbedAt` | `2026-05-15T08:44:58Z` | when the 8-batch probe ran |
| `wafProbeMethod` | `heavy-8-batch` | shipped probe |
| `hasCaptcha` | **`false`** | reCAPTCHA v3 script tag present site-wide but does NOT gate catalog or Store API |
| `captchaType` | `recaptcha-v3` | informational; Contact Form 7 loads it for the contact form |
| `ageGate.detected` | **`false`** | no interstitial age-confirmation gate; pop-up on homepage is a Mailchimp email signup |
| `userAgentOverride` | `null` | default desktop UA works |
| `needsPlaywright` | **`false`** | static HTML returns full product cards and Store API JSON |

> **Probe evidence** (`wafProbeEvidence`): 8/8 batches return 200 on normal paths. Cloudflare passive on every batch (`cf-ray`, `server: cloudflare`, `cf-cache-status: DYNAMIC`). Rapid burst of 10 sequential GETs all 200 — no rate-limit. The XSS-shaped query `?q=<script>alert(1)</script>` returns a 17,925-byte 403 (Cloudflare WAF managed rule fired on the payload only); the SQLi-shaped queries return 200. Honeypot paths (`.env`, `.git/config`, `xmlrpc.php`) return a uniform 1,483-byte canned 403 from the origin (NOT Cloudflare's challenge body, which is much larger). `wp-admin` and `wp-login.php` return 200 (login page). No MalCare / Wordfence / Sucuri / Incapsula body markers found in any of the 8 batches. Verdict: Cloudflare passive — catalog crawler unaffected.

---

## Catalog discovery — where the products are

**`catalogUrls`** — single URL spine: `/shop/` reaches 100% of products in one paginated walk. The WC archive root returns `Showing 1-40 of 4493 results` on page 1, exactly matching the Store API `x-wp-total`. The 15 firearm-relevant top-level categories below are documented for operator reference; their union (sum=4603 with ~2.4% cross-category overlap) covers everything `/shop/` covers.

| Category | Products | URL (path) |
|---|---:|---|
| ACCESSORIES | **1,068** | `/category/4027-accessories/` |
| AMMUNITION | 612 | `/category/4021-ammunition/` |
| RELOADING | 542 | `/category/4023-reloading/` |
| FIREARMS | 454 | `/category/4022-firearms/` |
| CLOTHING | 354 | `/category/4026-clothing/` |
| TBSBow Accessories | 336 | `/category/tbsbow-accessories/` |
| OPTICS | 323 | `/category/4030-optics/` |
| TBSBows | 199 | `/category/tbsbows/` |
| TBSArrows & Components | 194 | `/category/tbsarrows-components/` |
| TBSHunting Accessories | 184 | `/category/tbshunting-accessories/` |
| KNIVES/CUTLERY | 116 | `/category/4031-knives-cutlery/` |
| TBSParts, Service, Tools | 74 | `/category/tbsparts-service-tools/` |
| TBS USED ACCESSORIES | 67 | `/category/tbs-used-accessories/` |
| TBSMisc. | 45 | `/category/tbsmisc/` |
| TBSTargets & Butts | 35 | `/category/tbstargets-butts/` |

**`topLevelCategories.totalsSumCheck`:**

> Sum of 15 firearm-relevant top-level category counts = **4,603**.
> `/shop/` archive shows "Showing 1-40 of **4,493** results" (matches WC Store API `x-wp-total: 4493`).
> Difference = **110** (~2.4% cross-category overlap from products tagged in two cats).
> Excluded from the catalog list: `brand` (count 4,433, parallel aggregator across all branded products), `uncategorized` (425 catch-all), and 8 typo-duplicate slugs with count <= 115. Chose `/shop/` as the single `catalogUrls` entry because it is the smallest URL set with proven 100% coverage.

**`extractionSample`** — 3 random products from `/shop/` page 1 (positions 0 / 20 / 39); all four required fields populated:

| `title` | `price` | `stockStatus` |
|---|---:|---|
| 1911 Pistol (fits most 1911 single stack models) | $54.95 | `in_stock` |
| 30.06-CLASSIC CROSSBOW CASE/OD GREEN | $64.99 | `in_stock` |
| AAE-ELITE CORDOVAN SM LH | $74.99 | `in_stock` |

`extractionTested = true`.

---

## Pagination & sort — how to traverse

| field | value | meaning |
|---|---|---|
| `paginationPattern.type` | **`path`** | WC default; `?page=N` not used, `/page/{N}/` is |
| `paginationPattern.template` | `/page/{N}/` | how to construct page N |
| `paginationPattern.perPage` | **`40`** | products per page on HTML (theme-hardcoded, `?count=N` ignored) |
| `paginationPattern.firstPageHasParam` | `false` | page 1 = catalog URL bare |
| `paginationPattern.startPage` | `1` | one-indexed |
| `paginationPattern.zeroIndexed` | `false` | — |
| `sortParam` | **`?orderby=date`** | newest-first via WC's standard `orderby` query |
| `sortVerified` | **`true`** | proved honored via 3-outcome counter-control |

> **How sort was verified:** 3-outcome counter-control with cache-bust nonce on `/category/4022-firearms/`. Default page-1 first ID = `210414` (alpha order). `?orderby=date` first ID = `263938`. `?orderby=price` (counter-control) first ID = `243626`. All three different — sort honored. Cross-check: `263938 > 256134` (page 2 first under default) `> 210414` — descending product ID = newest-first, matches WC convention.

---

## Inventory size

| field | value |
|---|---|
| `expectedProductCount` | **`4493`** |
| `productCountMethod` | `{method:"wp-rest-header", endpoint:"/wp-json/wc/store/v1/products", header:"x-wp-total"}` |

> Read directly from the WC Store API: `GET /wp-json/wc/store/v1/products?per_page=1` returned `x-wp-total: 4493`. Cross-checked: `/shop/` HTML shows "Showing 1-40 of 4493 results". Both numbers identical.

---

## Crawler config — runtime behavior

| Phase | field | value | what it means |
|---|---|---|---|
| **Tier 1 (new items)** | `crawlers.watermark.method` | **`api-date-since-watermark`** | call WC Store API with `?after=<watermark>` and walk results in ascending date order |
| Bootstrap | `crawlers.bootstrap.apiEndpoints` | `{products:"/wp-json/wc/store/v1/products", taxonomy:"/wp-json/wp/v2/product_cat", maxPerPage:100}` | WC Store API for products, WP REST for taxonomy |
| **Maintain** | `crawlers.maintain.verifyMethod` | **`store-api`** | batch verify ~10 products per request via Store API |
| Maintain | `crawlers.maintain.verifyEndpoint` | `/wp-json/wc/store/v1/products` | endpoint for the batch verify |

> `crawlers.watermark.reason`: *WC Store API `/wp-json/wc/store/v1/products` honors `?after=` filter. Two-probe verified: `?after=2099-01-01` returns `x-wp-total: 0`; `?after=1999-01-01` returns `x-wp-total: 4493` (= global count). Same filter is honored on the admin `/wp-json/wp/v2/product` endpoint (future=0, past=11370 including drafts). HTML `?orderby=date` also verified honored, so `navigate-from-watermark` is a viable fallback if the API ever changes.*

---

## Platform extras

| field | value / reason |
|---|---|
| `classifiedRules` | omitted — `adapterType` is `woocommerce`, not `classifieds-*` |
| `ecwidStoreId` | omitted — `platform` is `woocommerce`, not `ecwid-*` |
| `productUrlSchemes` | omitted — single URL scheme `/shop/<deep-path>/<slug>/` |
| `wafWorkaround` | omitted — Cloudflare passive only; no malformed headers requiring curl-spawn fallback |
| `searchUrl` | `/?s={keyword}&post_type=product` (WP search restricted to product type) |

---

## Provenance

| field | value |
|---|---|
| `profileVersion` | `1` |
| `lastVerified` | `2026-05-15` |
| `auditNotes.runId` | `audit-2026-05-15T08-53-56Z` |
| `auditNotes.harnessVersion` | AI-driven, post-2026-04-27 pivot, R1 blind run |
| `auditNotes.drivenByAIDirectly` | `true` |
| `auditNotes.probeIp` | audit machine (Windows host, residential ISP) — Cloudflare did not challenge; re-confirm WAF section from production crawler IP before promotion |

**`auditNotes.fieldConfidence`** — every field's confidence level:

| field | confidence |
|---|---|
| `platform` | verified |
| `adapterType` | derived-from-platform |
| `hasWaf`, `hasCaptcha` | verified-operational |
| `ageGate` | verified |
| `expectedProductCount`, `productCountMethod` | verified |
| `catalogUrls` | verified-via-result-count-match |
| `paginationPattern` | verified-via-page1-page2-zero-overlap |
| `sortParam`, `watermarkMethod` | verified-via-counter-control / verified-via-two-probe |
| `extractionTested` | verified |
| `maintainVerifyMethod` | derived-from-platform |

**`auditNotes.stageNotes`** — what happened at each of the 9 stages:

1. **Stage 1 (Canonical URL):** apex `shooterschoice.com` returns 200 cleanly; `www.shooterschoice.com` 301s to apex (`location: https://shooterschoice.com/`). `canonicalOrigin = https://shooterschoice.com`.
2. **Stage 2 (WAF + CAPTCHA):** 8-batch heavy probe. Cloudflare passive — `cf-ray` on every batch, all normal traffic 200, rapid burst clean, no plugin-WAF body markers. XSS-payload-only Cloudflare rule fires on `<script>` in the query but does NOT affect catalog crawl. reCAPTCHA v3 (Contact Form 7) is site-wide but does not gate the crawl path.
3. **Stage 3 (Platform):** WooCommerce 10.7.0 from `wp-content/plugins/woocommerce/assets/client/blocks/wc-blocks.css?ver=wc-10.7.0` + `woocommerce-loop-product__title` cards + body class `tax-product_cat`. Theme `kingler-theme` (theme is not platform). No age-gate; pop-up is a Mailchimp email-signup. `adapterType=woocommerce`. Maintain `verifyMethod=store-api`.
4. **Stage 4 (Catalog URLs):** `/shop/` returns "Showing 1-40 of 4493 results" — single URL hits 100% of products. Documented 15 firearm-relevant top-level categories (sum 4603) in `topLevelCategories.categories[]` for operator reference. Taxonomy API returned 1910 categories across 20 pages; excluded `brand` (4433 parallel aggregator), `uncategorized` (425), and 8 typo-duplicate slugs.
5. **Stage 4g (Extraction):** 3 random products from `/shop/` page 1 (positions 0/20/39); all four fields (`title`/`url`/`price`/`stockStatus`) populated. `extractionTested=true`.
6. **Stage 5 (Pagination):** `/page/{N}/` path form works. Page 1 first 5 IDs `[210414, 84018, 65609, 145943, 65620]` vs page 2 `[256134, 256135, 256138, 256140, 256141]` — zero overlap. `?count=N` query ignored (returns 40 anyway). HTML `perPage=40` (theme-hardcoded); WC Store API max `perPage=100`.
7. **Stage 6 (Sort):** `<select name="orderby" class="orderby">` with options `menu_order` (default) / `popularity` / `rating` / `date` / `price` / `price-desc`. 3-outcome counter-control with cache-bust: default p1 first ID `210414`, `?orderby=date` first ID `263938`, `?orderby=price` first ID `243626` — all three different => sort honored. `sortParam='?orderby=date'`, `sortVerified=true`.
8. **Stage 7 (Watermark method):** `api-date-since-watermark`. Two-probe on `/wp-json/wc/store/v1/products?after=<date>` — future=2099-01-01 returns `x-wp-total: 0`; past=1999-01-01 returns `x-wp-total: 4493`. Same probe on `/wp-json/wp/v2/product` — future=0, past=11370 (admin includes drafts). Filter honored.
9. **Stage 8 (Product count):** `wp-rest-header` on `/wp-json/wc/store/v1/products?per_page=1` returns `x-wp-total: 4493`. Cross-checked against `/shop/` HTML result-count ("1-40 of 4493 results"). `expectedProductCount=4493`.
10. **Stage 9 (Assembly):** validator passed 16/16 (9 required + 7 recommended, score 100). Output written to `docs/site-audit/`.
