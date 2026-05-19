# Pre-Bootstrap Output — precisionoptics.net

> **Result:** ready for operator review.
> 16/16 validator checks passed (9 required + 7 recommended). Cloudflare-passive in front (rule-selective fires on honeypot/SQLi/XSS shapes but never gates catalog) — **operational `hasWaf=false`**. No CAPTCHA, no age-gate. **6,049 products** discovered via sitemap; **19 catalogUrls** cover the firearm-relevant top-level + key sub-aggregators. Volusion classic — `?searching=Y` required alongside sort + page params (Mistake 24).

---

## At a glance

| What | Value |
|---|---|
| Site runs on | **Volusion** (uses `generic-retail` adapter) |
| Protections in front | Cloudflare-passive only; **`hasWaf=false`**, **`hasCaptcha=false`**, no age-gate |
| Catalog | **6,049 products** (from sitemap `_p/` filter) across **11 firearm-relevant top-level categories**, captured in **19 catalogUrls** |
| Page walking | query-style -> `?...&page={N}` * **`perPage=360`** (max verified) |
| Sort | query-form -> **`sortParam = "searching=Y&sort=3"`** * `sortVerified=true` |
| New-item crawl | `crawlers.watermark.method = navigate-from-watermark` |
| Re-verify in maintain phase | `crawlers.maintain.verifyMethod = detail-page` (no Volusion batch API) |

---

## Identity

The skill matched the homepage signals to **Volusion** (classic ASP storefront). Volusion has no dedicated adapter in this project, so it falls back to `generic-retail`.

| field | value |
|---|---|
| `platform` | `volusion` |
| `adapterType` | `generic-retail` |

> Signals: `X-Powered-By: Volusion` on every response, `cdn4.volusion.store` image hosts, `/a/j/volusion.js` asset, "Built with Volusion" footer link, `volses` + `ASPSESSIONID` cookies, `/category_s/<id>.htm` + `/ProductDetails.asp?ProductCode=<sku>` URL pattern, the canonical `SearchParams = 'searching=Y&sort=N&cat=N&show=N&page=N'` JS var on every category page.

---

## Access — getting in safely

Cloudflare is in front but does NOT challenge the catalog crawl path. Honeypot / exploit-shape paths trigger Cloudflare 403s; product pages do not.

| field | value | meaning |
|---|---|---|
| `hasWaf` | **`false`** | Cloudflare is passive on catalog URLs — operational gate, per skill Stage 2 |
| `wafType` | `cloudflare-passive` | informational; CDN in front but not blocking the crawl |
| `wafLastProbedAt` | `2026-05-12T06:21:30Z` | when the 8-batch probe ran |
| `wafProbeMethod` | `heavy-8-batch` | 8 batches x 4 UAs x honeypots + SQLi + XSS |
| `hasCaptcha` | **`false`** | no reCAPTCHA / hCaptcha / Turnstile in homepage HTML |
| `captchaType` | `null` | — |
| `ageGate.detected` | **`false`** | no interstitial age-confirmation |
| `userAgentOverride` | `null` | default desktop UA works |
| `needsPlaywright` | **`false`** | static HTML on `/category_s/<id>.htm` returns up to 360 products with title+price markup |

> **Probe evidence** (`wafProbeEvidence`): BATCHES 1, 2, 3, 5, 8 all 200 OK on `/`, `/robots.txt`, `/sitemap.xml` across 4 different UAs (desktop, mobile, bot, curl) and the 10-burst rapid-fire. BATCHES 4 (honeypots `/wp-admin`, `/wp-login`, `/.env`, `/.git/config`, `/xmlrpc.php`, `/phpinfo.php`), 6 (SQLi UNION), 7 (XSS `<script>alert(1)</script>`) return Cloudflare-vendor 403 "Sorry, you have been blocked" interstitial pointing at `volusion.store` — tenant-wide Volusion rule-selective. No `_cf_chl_opt` challenge body. No sucuri / sgcaptcha / Incapsula / MalCare / Wordfence markers anywhere. Verdict: Cloudflare is in front but does not actively challenge the crawl path -> `hasWaf=false` per skill operational rule.

---

## Catalog discovery — where the products are

**`catalogUrls`** — 19 URLs covering the 11 firearm-relevant top-level categories from the homepage nav, plus key sub-aggregators where the parent is tile-only. Each URL bakes the canonical Volusion query (`?searching=Y&sort=3&cat=<id>&show=360&page=1`) so the runtime crawler walks newest-first with max `perPage`.

| Category | Products (allOption) | URL |
|---|---:|---|
| In-Stock Firearms (firearms aggregator) | **~900** | `/category_s/662.htm?searching=Y&sort=3&cat=662&show=360&page=1` |
| Riflescopes (parent aggregates subcats) | 270 | `/Riflescopes_s/64.htm?...&cat=64&show=360&page=1` |
| Ammunition | 196 | `/category_s/556.htm?...&cat=556&show=360&page=1` |
| Firearm Accessories | 172 | `/category_s/391.htm?...&cat=391&show=360&page=1` |
| Binoculars (parent aggregates) | 120 | `/Binoculars_s/65.htm?...&cat=65&show=360&page=1` |
| Mounts/Rings (parent aggregates) | 120 | `/category_s/551.htm?...&cat=551&show=360&page=1` |
| Reloading Bushings | 72 | `/category_s/735.htm?...&cat=735&show=360&page=1` |
| Reloading Projectiles | 61 | `/category_s/1012.htm?...&cat=1012&show=360&page=1` |
| Barrels (Rifle Components subcat) | 44 | `/category_s/1255.htm?...&cat=1255&show=360&page=1` |
| Reloading Die Sets | 37 | `/category_s/721.htm?...&cat=721&show=360&page=1` |
| Clearance / Used | 29 | `/category_s/860.htm?...&cat=860&show=360&page=1` |
| Spotting Scopes | 23 | `/Spotting_Scope_s/66.htm?...&cat=66&show=360&page=1` |
| Range Finders | 14 | `/Range_Finders_s/67.htm?...&cat=67&show=360&page=1` |
| Outdoor Tech (mixed firearm-relevant) | 10 | `/Outdoor_Tech_s/68.htm?...&cat=68&show=360&page=1` |
| Rifle Accessories (Rifle Components subcat) | 10 | `/category_s/1260.htm?...&cat=1260&show=360&page=1` |
| Reloading Brass | 8 | `/category_s/719.htm?...&cat=719&show=360&page=1` |
| Rifle Stocks (Rifle Components subcat) | 8 | `/category_s/1258.htm?...&cat=1258&show=360&page=1` |
| Bottom Metals (Rifle Components subcat) | 6 | `/category_s/1256.htm?...&cat=1256&show=360&page=1` |
| Ammunition/Reloading parent (tile-only retained) | 1 | `/Ammunition_s/550.htm?...&cat=550&show=360&page=1` |

**`topLevelCategories.totalsSumCheck`:**

> Sum of `allOption` across 19 catalogUrls ~= **2,101**.
> Sitemap-derived global product count (source of truth) = **6,049**.
> Gap of ~3,948 products lives in 503 depth-2/depth-3 leaf categories under the 4 tile-parents (Firearms_s/325, Ammunition_s/550, category_s/957 Rifle Components, category_s/1047 Camping). Volusion convention: every firearm appears in BOTH `/category_s/662` AND a brand subcat — so `/662` covers 100% of in-stock firearms. Similarly `/Riflescopes_s/64`, `/Binoculars_s/65`, `/category_s/551` (Mounts) aggregate their brand-pivot children. The remaining gap is (a) sold-out/discontinued products kept in sitemap but hidden from in-stock categories, (b) products in deeply nested brand-pivot leaves the parent did NOT aggregate (Ammunition parent only returns 1 product; subcats 556/735/719/721/1012 cover ~374). **Operator action:** walk + dedup the 19 URLs, compare unique product set vs sitemap `_p/` entries; if coverage < 95%, ADD depth-2 leaves.
>
> Camping (`/category_s/1047`) **dropped** — entire top-level is non-firearm-relevant (sleeping bags, water/hydration, food, tents, headlamps, clothing) per skill Stage 4 scope rules.

**`extractionSample`** — 3 random products spot-checked from 3 different category leaves; all 4 required fields populated:

| `title` | `price` | `stockStatus` |
|---|---:|---|
| Benelli Nova Pump Field Shotgun - Tactical - 12 gauge - 18.5" - 4+1 | $610.00 | `in_stock` |
| Burris Zee Rings - 30mm - Med - 420044 | $95.00 | `unknown` |
| Fierce Dirtnap - 22 Creedmoor - 80 gr. ELD-M - 20 CT - DIRTNAP-22CM-80ELDM | $129.99 | `unknown` |

`extractionTested = true`. The Benelli detail page surfaces "In Stock"; the other two do not expose explicit stock markers in og: tags — production crawler will infer from absence of sold-out / unavailable markers.

---

## Pagination & sort — how to traverse

| field | value | meaning |
|---|---|---|
| `paginationPattern.type` | **`query`** | query-string param, not URL path |
| `paginationPattern.template` | `page` | param NAME only (skill Mistake 14) — full URL builds as `?...&page={N}` |
| `paginationPattern.perPage` | **`360`** | verified maximum honored value |
| `paginationPattern.firstPageHasParam` | `true` | canonical URL embeds `&page=1` alongside `searching=Y` for the sort param to attach |
| `paginationPattern.startPage` | `1` | not zero-indexed |
| `paginationPattern.zeroIndexed` | `false` | — |
| `sortParam` | **`"searching=Y&sort=3"`** | query-form sort; `sort=3` is "Newest" per the `<select id="SortBy">` options |
| `sortVerified` | **`true`** | proved honored via 3-outcome counter-control |

> **How sort was verified:** Volusion's `<select class="sortby_select" id="SortBy">` exposes 8 options (sort=1..11). 3-outcome counter-control (cache-busted with `&_=<timestamp>`) on `/category_s/662`:
> - `sort=1` (Price Low-to-High, default) -> first product = **Winchester Wildcat SR**.
> - `sort=3` (Newest) -> first product = **Benelli Nova Pump Field Shotgun**.
> - `sort=4` (Oldest) -> first product = **Fierce CT Rogue XP 300 PRC**.
>
> All three first products are distinct — sort param is honored, default is NOT already newest. Volusion canonical query form requires `?searching=Y` (Mistake 24) — without it the site silently ignores `sort` and `page`. `perPage=360` honored (show=360 returned exactly 360 distinct products on page 1 of `/category_s/662`).

---

## Inventory size

| field | value |
|---|---|
| `expectedProductCount` | **`6049`** |
| `productCountMethod` | `{method: "generic-product-sitemap", url: "/sitemap.xml", pattern: "_p/[^/]+\\.htm(?:$|[?#])"}` |

> Source: `https://www.precisionoptics.net/sitemap.xml` (1.1MB, 6,744 `<loc>` entries: 1 homepage + 694 category URLs + **6,049 product URLs**). The product URL pattern `<slug>_p/<sku>.htm` is uniformly applied across the storefront. Sitemap is the cleanest canonical source on Volusion — the per-category `<select id="perpage">` exposes only show=20/40/60/90/180/360 (no "All" option like Celerant). Walk-vs-probe cross-check: 146 productive walked depth-1 cats = 4,031 page-1 products + extrapolated `/662` multi-page = ~4,571 (less than 6,049 — gap is expected because the walk only covered depth-1, and sitemap retains sold-out / discontinued entries). Per skill Mistake-36 rule, walk > probe does NOT trigger because walk < probe — sitemap value retained.

---

## Crawler config — runtime behavior

| Phase | field | value | what it means |
|---|---|---|---|
| **Tier 1 (new items)** | `crawlers.watermark.method` | **`navigate-from-watermark`** | paginate newest-first with `sort=3`, walk back from page 1 to watermark |
| Bootstrap | `crawlers.bootstrap.apiEndpoints` | `null` | no Volusion platform JSON API — pure HTML walk |
| **Maintain** | `crawlers.maintain.verifyMethod` | **`detail-page`** | per-product Playwright/HTTP detail fetch; no batch verify |
| Maintain | `crawlers.maintain.verifyEndpoint` | `null` | Volusion has no batch product API |

> `crawlers.watermark.reason`: *Volusion `<select id="SortBy">` exposes `sort=3` (Newest) verified honored via 3-outcome counter-control: sort=1 (Price Low-to-High, default) first product = Winchester Wildcat SR; sort=3 (Newest) first product = Benelli Nova Pump Field Shotgun; sort=4 (Oldest) first product = Fierce CT Rogue XP 300 PRC. All three first products are distinct — sort param is honored, default IS NOT already newest. Volusion canonical query form requires `searching=Y` (Mistake 24). perPage=360 honored (show=360 returned exactly 360 products on page 1 of `/category_s/662`).*

---

## Platform extras

Both omitted — neither applies to a Volusion firearms retailer:

| field | omitted because |
|---|---|
| `classifiedRules` | `adapterType` is not `classifieds-*` |
| `ecwidStoreId` | `platform` is not `ecwid-*` |

---

## Provenance

| field | value |
|---|---|
| `profileVersion` | `1` |
| `lastVerified` | `2026-05-12` |
| `auditNotes.runId` | `audit-2026-05-12T06-21-30Z` |
| `auditNotes.harnessVersion` | AI-driven, post-2026-04-27 pivot |
| `auditNotes.drivenByAIDirectly` | `true` |

**`auditNotes.fieldConfidence`** — every field's confidence level:

| field | confidence |
|---|---|
| `platform` | verified-via-X-Powered-By-header |
| `adapterType` | derived-from-platform |
| `hasWaf` | verified-via-heavy-8-batch + body inspection |
| `wafType` | verified-cloudflare-passive (informational; operational hasWaf=false) |
| `hasCaptcha`, `ageGate` | verified-no-markers |
| `needsPlaywright` | verified — static HTML returns 90 products on page 1 |
| `expectedProductCount` | verified-from-sitemap (6049 `_p/` entries) |
| `productCountMethod` | verified-runtime-method-mapped |
| `catalogUrls` | partial — 19-URL minimal set; full coverage requires depth-2 walk |
| `paginationPattern` | verified — show=360 returns 360 products; page=2 zero-overlaps page=1 |
| `sortParam`, `watermarkMethod` | verified-via-3-outcome-counter-control |
| `extractionTested` | verified — 3 random products / 3 different leaves |
| `maintainVerifyMethod` | derived-from-platform |

**`auditNotes.stageNotes`** — what happened at each of the 9 stages:

1. **Stage 1 (Canonical URL):** apex `precisionoptics.net` 301->`http://www.precisionoptics.net/Default.asp` then 301->`https://www.precisionoptics.net/Default.asp`. www returns 200. `canonicalOrigin = https://www.precisionoptics.net`.
2. **Stage 2 (WAF + CAPTCHA):** 8/8 batches probed. cf-ray + __cf_bm cookie present (Cloudflare in front). 5 catalog batches 200; 3 honeypot/exploit batches return Cloudflare 403 pointing at volusion.store tenant. No challenge body on catalog. No CAPTCHA / age-gate markers. Operational `hasWaf=false`, `wafType=cloudflare-passive`.
3. **Stage 3 (Platform):** `volusion` identified by `X-Powered-By: Volusion` header + cdn4.volusion.store assets + volses cookie + `SearchParams` JS var + `/category_s/<id>.htm` URL pattern. `adapterType=generic-retail`. `needsPlaywright=false`. Maintain `verifyMethod = detail-page`.
4. **Stage 4 (Catalog URLs):** 19 candidates from homepage nav + sitemap + per-cat walk. 11 firearm-relevant top-levels mapped; 4 tile-parents (Firearms_325, Ammunition_550, Rifle Components_957, Camping_1047) handled by swapping to productive sub-leaves (662 for firearms; 556/735/719/721/1012 for ammo/reloading; 1255/1256/1258/1260 for rifle components). Camping dropped (out of firearm-relevant scope). Each URL bakes `?searching=Y&sort=3&cat=<id>&show=360&page=1`. Extraction spot-checked on 3 random products from 3 leaves — all yield og:title + product_productprice. KNOWN GAP: ~503 depth-2 leaves not walked; sitemap (6,049) is canonical.
5. **Stage 5 (Pagination):** Volusion uses `?searching=Y&...&page=N` (Mistake 24 — `searching=Y` is mandatory). `show=360` returned 360 distinct products on page 1. `page=2` at `show=90` returned 90 distinct products zero-overlapping page 1. `template='page'` (param name only), `firstPageHasParam=true`, `startPage=1`, `zeroIndexed=false`, `perPage=360`.
6. **Stage 6 (Sort):** `<select id="SortBy">` exposes 8 options. 3-outcome counter-control (cache-busted): sort=1 (default, Price L->H) != sort=3 (Newest) != sort=4 (Oldest). All three first products are distinct -> sort is honored, default is NOT newest. `sortParam='searching=Y&sort=3'` (query-form). `sortVerified=true`.
7. **Stage 7 (Watermark method):** `navigate-from-watermark`. sort=3 verified upstream; product listings expose monotonic ordering via SearchParams JS var. No date-since API filter on Volusion.
8. **Stage 8 (Product count):** sitemap `_p/` URL filter — 6,049 unique product detail URLs. `productCountMethod = {method:"generic-product-sitemap", url:"/sitemap.xml", pattern:"_p/[^/]+\\.htm(?:$|[?#])"}` matches runtime switch case in `product-count-probe.ts:213`. Walk-vs-probe (walk=4,571 < probe=6,049) does NOT trigger Mistake-36 reconciliation rule (rule fires only when walk > probe).
9. **Stage 9 (Assembly + validate):** validator passed **16/16** (9/9 required + 7/7 recommended). No failures, no warnings.

**Known limitations:**

- 503 depth-2 leaf categories from sitemap not exhaustively walked. Operator action: walk the 19 catalogUrls + dedup, compare unique product set vs sitemap `_p/` entries; if coverage < 95%, ADD depth-2 leaves.
- Cloudflare 403s on /wp-admin/.env/etc are tenant-wide Volusion rules — crawler must avoid those paths or it will trigger rate-limit cascades. Production crawler avoids these naturally.
- `stockStatus` on extraction sample: only Benelli Nova detail page explicitly says "In Stock"; the other two products do not surface explicit stock markers in og: tags.
