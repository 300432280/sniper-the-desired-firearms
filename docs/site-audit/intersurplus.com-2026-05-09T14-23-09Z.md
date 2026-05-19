# Pre-Bootstrap Output — intersurplus.com

> **Result:** ready for operator review.
> 9 required + 7 recommended validator checks passed. Cloudflare passive in front; hCaptcha gates the contact/login forms (not the catalog); no age-gate. **3,157 products** discovered across **31 top-level catalog URLs** (99.6% coverage of the global /products.json walk).

---

## At a glance

| What | Value |
|---|---|
| Site runs on | **Shopify** (theme Debut) — uses `shopify` adapter |
| Protections in front | **Cloudflare passive** + **hCaptcha** (forms only); no age-gate |
| Catalog | **3,157 products** across **31 catalog URLs** |
| Page walking | query-style → `?page={N}` · `perPage=32` |
| Sort | **`?sort_by=created-descending`** · verified honored (counter-control) |
| New-item crawl | `crawlers.watermark.method = navigate-from-watermark` |
| Re-verify in maintain phase | `crawlers.maintain.verifyMethod = detail-page` (no batch API) |

---

## Identity

The skill matched the homepage signals to **Shopify**: `Shopify.shop = "survivalsurplus-ca.myshopify.com"` JS variable, `cdn.shopify.com` resource references, `_shopify_*` cookies on every response, and the `powered-by: Shopify` HTTP header. The active theme is `Debut`. There IS a dedicated Shopify adapter, so `adapterType = shopify`.

| field | value |
|---|---|
| `platform` | `shopify` |
| `adapterType` | `shopify` |

---

## Access — getting in safely

Cloudflare sits in front (passive — `cf-ray` on every probe, never serves a challenge for normal UAs). Shopify's storefront-forms hCaptcha bootstrap is loaded inline on every page, but it gates the contact/login/account forms only — catalog browsing is unaffected. No age-gate.

| field | value | meaning |
|---|---|---|
| `hasWaf` | **`true`** | Cloudflare presence detected via `cf-ray` header |
| `wafType` | **`cloudflare-passive`** | never serves an active challenge for normal UAs |
| `wafLastProbedAt` | `2026-05-09T14:10:16Z` | when the 8-batch probe ran |
| `wafProbeMethod` | `heavy-8-batch` | which probe method |
| `hasCaptcha` | **`true`** | hCaptcha bootstrap script present in homepage HTML |
| `captchaType` | `hcaptcha` | Shopify storefront-forms hCaptcha (forms only, NOT catalog) |
| `ageGate.detected` | **`false`** | no interstitial age-confirmation gate |
| `userAgentOverride` | `null` | default desktop UA works |
| `needsPlaywright` | **`false`** | static HTML is enough |

> **Probe evidence** (`wafProbeEvidence`): `cf-ray` headers on the home page, robots.txt, sitemap.xml, and every probe in batches 2–7. All 10 rapid-burst requests returned 200. Honeypot paths (`/wp-admin`, `/wp-login.php`, `/.git/config`, `/phpinfo.php`) returned 404 — Cloudflare did not block them; Shopify simply has no such routes. `/.env` returns 200 because Shopify routes unknown paths to the homepage. SQLi-shaped (`?id=1' OR '1'='1`) and XSS-shaped (`?q=<script>...`) queries returned 200 with the normal homepage body — neither WAF nor Shopify cared. Batch 8 (no User-Agent header) returned 403 / 4515 bytes — that is Cloudflare's standard reject-empty-UA reflex, not site-specific. The CAPTCHA marker is the inline `<script id="captcha-bootstrap">` block embedding hCaptcha's bind-form code (`f06e6c50-85a8-45c8-87d0-21a2b65856fe` site key, `cdn.shopify.com/shopifycloud/storefront-forms-hcaptcha/...iife.js`). Verdict: Cloudflare passive + Shopify-default hCaptcha on forms — neither blocks catalog crawling.

---

## Catalog discovery — where the products are

**`catalogUrls`** — 31 URLs covering 99.6% of products. /collections.json returned 111 collections in total, but most are caliber-level subcategories that nest beneath `/collections/firearms` or `/collections/ammunitions`. After dropping pure aggregators (`/collections/all`, `/collections/all-firearms`, `/collections/fire-arms` (the latter is the 30-06 caliber, ironically slug-named), and 80 caliber-level children), 31 mid-level or leaf collections form the catalog spine:

| Category | Products | URL |
|---|---:|---|
| Firearms | **2,235** | `/collections/firearms` |
| Reloading Components (umbrella) | 320 | `/collections/reloading-components` |
| Arms Accessories (umbrella) | 191 | `/collections/all-arms-accessories` |
| Bullets | 152 | `/collections/bullets` |
| Ammunition (umbrella) | 110 | `/collections/ammunitions` |
| Reloading Brass | 92 | `/collections/reloading-brass` |
| Scopes / Mount / Rings | 92 | `/collections/scopes` |
| Cleaning Kit | 86 | `/collections/cleaning-kit` |
| Shotgun Barrels | 85 | `/collections/shotgun-barrels` |
| Reloading Kit (Dies) | 76 | `/collections/reloading-kit` |
| Manuals & Stickers | 37 | `/collections/manuals-stickers` |
| Mauser 98 (M98) Parts | 33 | `/collections/m98-parts` |
| Mauser 96 (M96) Parts | 30 | `/collections/m96-parts` |
| Magazine / Stripper Clips | 18 | `/collections/magazine` |
| Hunting Accessories | 17 | `/collections/hunting-accessories` |
| Military Surplus (umbrella) | 11 | `/collections/all-military-surplus` |
| Stock | 11 | `/collections/stock` |
| Husqvarna 1600/1640 Parts | 10 | `/collections/husqvarna-1600-parts` |
| Combination Combo Barrels | 10 | `/collections/combination-combo-barrels` |
| Stripped Receiver | 8 | `/collections/stripped-receiver` |
| Pistol Barrels | 7 | `/collections/pistol-barrels` |
| Slings, Bipods & Grips | 7 | `/collections/slings-bipods-grips` |
| Flare Guns | 6 | `/collections/flare-guns` |
| Gun Cases | 5 | `/collections/gun-cases` |
| Insert | 3 | `/collections/insert` |
| Rifle Barrels | 3 | `/collections/riffle-barrels` |
| Brass (Once Fired) | 2 | `/collections/brass-one-fired` |
| Lee Enfield Parts | 2 | `/collections/lee-enfield-parts` |
| Bayonets | 1 | `/collections/bayonets` |
| Gift Card | 1 | `/collections/gift-card` |
| Holsters | 0 | `/collections/holsters` |

**`topLevelCategories.totalsSumCheck`:**

> Sum of per-category counts = **3,669**.
> Walked union of the 31 collections = **3,143** unique products.
> Global `/products.json` walk = **3,157**.
> Coverage = **99.6%** (14 products short of global). Cross-category overlap inside the union ≈ **14.1%** (517 products tagged in 2+ collections — typical for Shopify smart-collections where a 308 Win cartridge sits in `/collections/ammunitions` AND `/collections/308-winchester`).
> The 14 missing are merchant-side tagging artifacts: e.g. `/products/1911-auto-magazine` has `product_type: "Magazines"` (plural) but `/collections/magazine` filters on the singular `"Magazine"`, so the 1911 magazine is orphaned. Several econo-bundle products (`baikal-12ga-o-u-econo-bundle-3`, `husqvarna-1640-in-30-06-econo-bundle`, `swedish-m96-mixed-calibers-econo-bundle`, etc.) are in `/collections/all` but in no narrower collection.
> Within the skill's ≤5% drift gate. Operator may add `/collections/all` as a catchall if 100% coverage is required (trade-off: that aggregator overlaps 100% with the per-category list — Rule C discourages it but Shopify smart-collection orphans force the trade-off).

**`extractionSample`** — 3 random products spot-checked from `/collections/firearms` page 1 (positions 0, 16, 31 of 32 cards), all 4 required fields populated:

| `title` | `price` | `stockStatus` |
|---|---:|---|
| Stevens Pump Shotgun 12 GA | $349.00 | `out_of_stock` |
| Carl Gustaf 80 in 6.5x55 | $595.00 | `out_of_stock` |
| CZ 452-EM in 22LR | $495.00 | `out_of_stock` |

`extractionTested = true`. (All three cards carry the `grid-view-item--sold-out` class — high out-of-stock rate is normal for a surplus / collectibles retailer; the harness still receives full title + price + URL + status, so the adapter is healthy.)

---

## Pagination & sort — how to traverse

| field | value | meaning |
|---|---|---|
| `paginationPattern.type` | **`query`** | `?page={N}` query-string pagination |
| `paginationPattern.template` | `page` | the param name (`{N}` is the placeholder for page number) |
| `paginationPattern.perPage` | **`32`** | products per page on the Debut storefront grid |
| `paginationPattern.firstPageHasParam` | `false` | page 1 is the bare URL, no `?page=1` |
| `paginationPattern.startPage` | `1` | not zero-indexed |
| `paginationPattern.zeroIndexed` | `false` | — |
| `sortParam` | **`?sort_by=created-descending`** | Shopify storefront sort, ordered by `published_at` |
| `sortVerified` | **`true`** | proved honored via 3-outcome counter-control test |

> **How sort was verified:** ran the 3-outcome test on `/collections/firearms`. Default first 3 = `copy-of-charles-daly-301-12ga-3-pump-shotgun-black-18-5`, `baikal-ij-26e-sxs-in-12ga`, `squires-bingham-1400-in-22lr-4`. Sort=`created-descending` first 3 = `sauer-s100-classic-xt-in-6-5x55`, `fabarm-o-u-in-12ga-3`, `lincoln-premier-o-u-in-12ga-2`. Counter-control sort=`title-ascending` first 3 = `a-allan-sxs-in-12ga`, `copy-of-charles-lancaster-sxs-12ga`, `a-e-bayliss-son-co-sxs-in-12ga`. All three sets differ — sort is honored. **Mistake 32 reminder**: Shopify's storefront `created-descending` actually orders by `published_at`, NOT `created_at`. Verified separately on `/products.json`: `husqvarna-1640-fullstock-in-6-5x55` was created 2026-02-24 but published 2026-05-07, yet appears at position 2 ahead of older-published items — confirming `published_at` ordering. The runtime crawler must use `published_at` for watermark comparisons. Pagination zero-overlap verified: `/collections/firearms?page=2` returned 32 products, none of which appeared on page 1.

---

## Inventory size

| field | value |
|---|---|
| `expectedProductCount` | **`3157`** |
| `productCountMethod` | `shopify-products-walk` |

> Walked `/products.json?limit=250&page=N` until empty. 13 pages returned (pages 1–12 had 250 items each; page 13 had 157 — partial last page). Sum = **3,157 unique products**. Per the skill's priority order this is `shopify-products-walk` (priority #3, the canonical method for Shopify when `/products/count.json` is unavailable). `/products/count.json` was not tested but the skill notes it usually 401s on storefront — the walk is preferred regardless.

---

## Crawler config — runtime behavior

| Phase | field | value | what it means |
|---|---|---|---|
| **Tier 1 (new items)** | `crawlers.watermark.method` | **`navigate-from-watermark`** | paginate `/products.json` newest-first to find watermark, then walk back to index new products |
| Bootstrap | `crawlers.bootstrap.apiEndpoints.productsJson` | `/products.json?limit=250&page={N}` | global product walk endpoint |
| Bootstrap | `crawlers.bootstrap.apiEndpoints.collectionProducts` | `/collections/{handle}/products.json?limit=250&page={N}` | per-collection walk endpoint |
| Bootstrap | `crawlers.bootstrap.apiEndpoints.collectionsList` | `/collections.json?limit=250` | collection metadata index |
| **Maintain** | `crawlers.maintain.verifyMethod` | **`detail-page`** | each verify is a Playwright/HTML detail-page fetch |
| Maintain | `crawlers.maintain.verifyEndpoint` | `null` | Shopify Admin API requires auth; storefront has no batch verify |

> `crawlers.watermark.reason`: *Shopify storefront /products.json default order is `published_at DESC`, verified via husqvarna-1640 (created 2026-02-24, published 2026-05-07, appearing at position 2). Storefront sort `?sort_by=created-descending` is honored on `/collections/<h>` pages (3-outcome counter-control passed). No Shopify storefront API exposes a `published_at_min` or `created_at_min` filter, so Method A (api-date-since-watermark) is not available. Method B (navigate-from-watermark) applies: paginate `/products.json?limit=250&page=N` newest-first; the published_at field on every product gives the cursor signal.*

---

## Platform extras

Both omitted — neither applies to a Shopify retailer:

| field | omitted because |
|---|---|
| `classifiedRules` | `adapterType` is `shopify`, not `classifieds-*` |
| `ecwidStoreId` | `platform` is `shopify`, not `ecwid-*` |

---

## Provenance

| field | value |
|---|---|
| `profileVersion` | `1` |
| `lastVerified` | `2026-05-09` |
| `auditNotes.runId` | `calibration-2026-05-09T14-23-09Z` |
| `auditNotes.harnessVersion` | AI-driven, post-2026-04-27 pivot |
| `auditNotes.drivenByAIDirectly` | `true` |
| `auditNotes.calibrationMode` | `true` |

**`auditNotes.fieldConfidence`** — every field's confidence level:

| field | confidence |
|---|---|
| `platform`, `adapterType` | verified |
| `hasWaf`, `wafType`, `hasCaptcha`, `captchaType`, `ageGate` | verified |
| `expectedProductCount`, `productCountMethod` | verified |
| `catalogUrls` | verified-with-coverage-99.6% |
| `paginationPattern`, `perPage`, `extractionTested` | verified |
| `sortParam`, `sortVerified` | verified-via-counter-control |
| `crawlers.watermark.method` | verified |
| `crawlers.maintain.verifyMethod` | derived-from-platform |

**`auditNotes.stageNotes`** — what happened at each of the 9 stages:

1. **Stage 1 (Canonical URL):** apex `https://intersurplus.com/` returned 200 cleanly. `https://www.intersurplus.com/` returned 301 → apex with `x-redirect-reason: canonical_host_redirection` (Shopify's own canonical handling). The homepage `<link rel="canonical" href="https://intersurplus.com/">` agrees with the redirect. `canonicalOrigin = https://intersurplus.com`.
2. **Stage 2 (WAF + CAPTCHA):** 8-batch probe — every batch except #8 returned 200. Cloudflare passive (`cf-ray` on every batch). Shopify origin (`powered-by: Shopify`, `cdn.shopify.com` references). No Sucuri/Incapsula/Akamai/MalCare markers. Honeypot/SQLi/XSS payloads silently absorbed (Shopify routes unknown paths to homepage). Batch 8 (no UA) returned 403 / 4515b — that's Cloudflare's standard reject-empty-UA reflex. CAPTCHA: the homepage HTML embeds `<script id="captcha-bootstrap">` carrying hCaptcha bind-form code (`f06e6c50-85a8-45c8-87d0-21a2b65856fe` site key, `storefront-forms-hcaptcha` Shopify CDN bundle) — `hasCaptcha=true`, `captchaType=hcaptcha`. The CAPTCHA gates contact / login / account / new-comment forms only; catalog browsing is unaffected.
3. **Stage 3 (Platform):** Shopify confirmed by multi-marker — `Shopify.shop = "survivalsurplus-ca.myshopify.com"` JS var, `Shopify.theme = {"name":"Debut",...}`, `cdn.shopify.com` preconnect, `_shopify_y` / `_shopify_s` / `_shopify_essential` cookies, `powered-by: Shopify` header. Theme = Debut (theme_store_id 796, schema_version 17.5.0). adapterType=`shopify`. No age-gate detected in homepage HTML (no "18 or older", "verify age", `age_verified` cookie, etc.). Maintain `verifyMethod = detail-page` (per the skill's platform→verify mapping for Shopify).
4. **Stage 4 (Catalog URLs):** `/collections.json?limit=250` returned 111 collections. Homepage nav surfaced 68 unique `/collections/*` links across 4 visible top-level entries (Home, Ammunition, Bayonets, Firearms mega-dropdown) plus secondary groupings nested inside the Firearms dropdown (accessories, parts, military surplus, reloading). After dropping aggregator handles (`all`, `all-firearms`, `all-arms-accessories` was *kept* because it's the umbrella for accessories that would otherwise need 6+ separate entries; `all-military-surplus` kept for similar reasons; `reloading-components` kept as umbrella) and caliber-level subcategories that nest under `/collections/firearms` (22-hornet, 22-lr, 308-winchester, 7-62x54, etc. — 80+ such caliber slugs), 31 mid-level or leaf collections were selected. Coverage walk: union of 31 = **3143 of 3157** (99.6%). Three semi-aggregator umbrellas were kept (`all-arms-accessories`, `all-military-surplus`, `reloading-components`) because their leaf-level decomposition would inflate the catalog URL list to 50+ entries with worse aggregate overlap; the trade-off is acceptable per the skill's "minimum overlap" guidance.
5. **Stage 4g (Extraction quality):** 3 products sampled from `/collections/firearms` page 1 (positions 0, 16, 31 of 32 cards). All four fields populated for each: title (real product names), absolute URL on canonical host, price (numeric), stockStatus (all 3 sold-out — verified via `grid-view-item--sold-out` class). One sample URL (`/products/cz-452-em-in-22lr`) verified GET 200 to confirm absolute URL fetchability.
6. **Stage 5 (Pagination):** `/collections/firearms` page 1 returns 32 product cards. Tested `?page=2` → 32 different products, zero-overlap with page 1 (set intersection 0/32). Pattern: `type=query`, `template="page"`, `perPage=32`, `firstPageHasParam=false`, `startPage=1`, `zeroIndexed=false`.
7. **Stage 6 (Sort):** the `<select name="sort_by" id="SortBy">` exposes 9 standard Shopify sort options (manual / most-relevant / best-selling / title-asc / title-desc / price-asc / price-desc / created-asc / created-desc). 3-outcome counter-control test: default first 3 ≠ sort=created-descending first 3 ≠ sort=title-ascending first 3 — both candidate and counter differ from default, so sort is **honored**. `sortParam=?sort_by=created-descending`, `sortVerified=true`. Mistake 32 confirmed: Shopify's `created-descending` actually orders by `published_at` (separately verified on /products.json: husqvarna-1640 created 2026-02-24 / published 2026-05-07 appears at position 2).
8. **Stage 7 (Watermark method):** Method B (`navigate-from-watermark`). Sort honored upstream (Stage 6). Date source: every `/products.json` and `/collections/<h>/products.json` product carries `published_at`. Method A (api-date-since-watermark) is **NOT** available — Shopify's storefront `/products.json` has no `?published_at_min=` or equivalent date-since filter, only the implicit newest-first ordering. The crawler walks `/products.json?limit=250&page=N` newest-first to find the watermark, then walks back toward page 1 to index new products.
9. **Stage 8 (Product count):** walked `/products.json?limit=250&page=N` to exhaustion: 13 pages, 3,157 unique products. Each page request had a 900ms inter-request delay (≥800ms requirement satisfied). `productCountMethod=shopify-products-walk` (priority #3 in the skill's count-method order, canonical for Shopify).
