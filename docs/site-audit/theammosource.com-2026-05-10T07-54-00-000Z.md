# Pre-Bootstrap Output — theammosource.com

> **Result:** ready for operator review.
> 9 required + 7 recommended validator checks passed (score 100). **Cloudflare-passive** WAF (no challenges fire, just `cf-ray` headers). No CAPTCHA, no age-gate. **11,978 products** discovered across 27 top-level categories.

---

## At a glance

| What | Value |
|---|---|
| Site runs on | **BigCommerce Stencil** (uses `generic-retail` adapter) |
| Protections in front | **Cloudflare-passive** — `hasWaf=true`, `wafType="cloudflare-passive"`, no CAPTCHA, no age-gate |
| Catalog | **11,978 products** across **27 top-level categories** |
| Page walking | query-style → `?page={N}` · `perPage=50` |
| Sort | **`?sort=newest`** · verified honored (default = newest by coincidence; counter-control caught it) |
| New-item crawl | `crawlers.watermark.method = navigate-from-watermark` |
| Re-verify in maintain phase | `crawlers.maintain.verifyMethod = detail-page` (no batch API — BC Storefront API returns 404) |

---

## Identity

The skill matched homepage signals to **BigCommerce Stencil** unambiguously (CDN host, store-id header, BC-Ray header, Stencil CSS classes). BigCommerce has no dedicated adapter in this codebase, so it falls back to `generic-retail`.

| field | value |
|---|---|
| `platform` | `bigcommerce-stencil` |
| `adapterType` | `generic-retail` |

---

## Access — getting in safely

Cloudflare sits in front but is passive — every response carried `cf-ray` and a `__cf_bm` cookie, but no batch returned a challenge. Plain HTTP fetches with default desktop UA work; no Playwright required.

| field | value | meaning |
|---|---|---|
| `hasWaf` | **`true`** | Cloudflare in front of every response |
| `wafType` | **`"cloudflare-passive"`** | passive = headers/cookies only, no challenges fire |
| `wafLastProbedAt` | `2026-05-10T07:54:00Z` | when the 8-batch probe ran |
| `wafProbeMethod` | `heavy-8-batch` | which probe method |
| `hasCaptcha` | **`false`** | no reCAPTCHA / hCaptcha / Turnstile in homepage HTML |
| `captchaType` | `null` | — |
| `ageGate.detected` | **`false`** | no age-confirmation interstitial |
| `userAgentOverride` | `null` | default desktop UA works |
| `needsPlaywright` | **`false`** | static HTML returns full product cards |

> **Probe evidence** (`wafProbeEvidence`): all 8 batches returned 200 OK. `cf-ray` + `__cf_bm` set on every response — Cloudflare-passive (sits in front but does not actively challenge). Rapid burst of 10 GETs in ~2s — no rate-limit, all 200. SQLi-shaped (`?id=1' OR '1'='1`) and XSS-shaped (`?q=<script>...`) queries returned 200 with the same byte size as a clean `/` fetch — no rule fired. Multi-UA (desktop / mobile / bot) and no-UA all returned 200. Honeypot paths (`/wp-admin`, `/wp-login.php`, `/.env`, `/.git/config`) returned 403 from BigCommerce backend (not WAF) — same 552-byte BC error page; `xmlrpc.php` and `phpinfo.php` returned BC's 404 page (full HTML). No `x-sucuri-id`, no Incapsula cookies, no Akamai server header, no MalCare body marker. Verdict: Cloudflare-passive — pass-through to origin without active challenges.

---

## Catalog discovery — where the products are

**`catalogUrls`** — 27 URLs, one per top-level category, each carrying `?sort=newest` so watermark traversal hits newest-first immediately:

| Category | Products | URL |
|---|---:|---|
| Fishing | **4,464** | `/fishing/?sort=newest` |
| Firearms Accessories | 1,440 | `/firearms-accessories/?sort=newest` |
| Ammunition | 1,084 | `/ammunition/?sort=newest` |
| Scope Mounts & Rings | 681 | `/scope-mounts-rings/?sort=newest` |
| Reloading Supplies | 630 | `/reloading-supplies/?sort=newest` |
| Scopes, Optics, Binos and Sights | 546 | `/scopes-optics-binos-and-sights/?sort=newest` |
| Firearms | 499 | `/firearms/?sort=newest` |
| Knives, Multi-Tools & Slingshots | 273 | `/knives-multi-tools-slingshots/?sort=newest` |
| Hunting Supplies | 247 | `/hunting-supplies/?sort=newest` |
| MOTORCYCLE | 225 | `/motorcycle/?sort=newest` |
| Clothing, Glasses and Footwear | 206 | `/clothing-glasses-and-footwear/?sort=newest` |
| SNOWMOBILE | 181 | `/snowmobile/?sort=newest` |
| Power Sports & Engines | 178 | `/power-sports-engines/?sort=newest` |
| ATV | 169 | `/atv/?sort=newest` |
| Archery | 159 | `/archery/?sort=newest` |
| OEM Replacement Parts | 153 | `/oem-replacement-parts/?sort=newest` |
| Flashlights, Batteries & Illumination | 98 | `/flashlights-batteries-illumination/?sort=newest` |
| Camping & Outdoors | 80 | `/camping-outdoors/?sort=newest` |
| Novelty and Toys | 51 | `/novelty-and-toys/?sort=newest` |
| PPE and First Aid | 32 | `/ppe-and-first-aid/?sort=newest` |
| Cameras | 30 | `/cameras/?sort=newest` |
| Animal Protection | 19 | `/animal-protection/?sort=newest` |
| Marine | 16 | `/marine/-1/?sort=newest` |
| Military Surplus - Not Firearms | 16 | `/military-surplus-not-firearms/?sort=newest` |
| Bumper Stickers & Promo Stuff | 14 | `/bumper-stickers-promo-stuff/?sort=newest` |
| Tools & Equipment (Non Firearms) | 8 | `/tools-equipment-non-firearms/?sort=newest` |
| E-BIKE | 4 | `/e-bike/?sort=newest` |

**`topLevelCategories.totalsSumCheck`:**

> Sum of per-category page-walk counts (limit=250 walked) = **11,503**.
> Dedup unique across categories = **11,316**.
> BC `xmlsitemap.php?type=products` total = **11,978**.
> Drift sitemap-vs-walked = **662 = 5.5%** — consistent with OOS / hidden products kept in sitemap but excluded from active category listings (operator-flagged "feature, not noise").
> Cross-category overlap (sum 11,503 vs dedup 11,316) = **187 = 1.6%** — products tagged in two categories at once.

**`extractionSample`** — 3 random products from `/firearms/` page-1 spot-checked, all 4 required fields populated:

| `title` | `price` | `stockStatus` |
|---|---:|---|
| Stoeger Single Barrel Auto Eject, 12Ga 3", 28" Barrel, Walnut Stock | $310.00 | `in_stock` |
| Savage Axis II XP Bolt Action Rifle 30-06 SPRG, 22" Barrel, 3-9x40 Scope | $849.95 | `in_stock` |
| Weatherby 18i 12 Ga Semi-Auto Shotgun 3", 28" Barrel, Camo | $1,129.95 | `in_stock` |

`extractionTested = true`.

---

## Pagination & sort — how to traverse

| field | value | meaning |
|---|---|---|
| `paginationPattern.type` | **`query`** | `?page=N` query param |
| `paginationPattern.template` | `page` | param name only (per Mistake 14) — not `?page={N}` |
| `paginationPattern.perPage` | **`50`** | products per page (default theme: 52 articles incl. featured slot; canonical = 50) |
| `paginationPattern.firstPageHasParam` | `false` | bare `/firearms/` = page 1; no `?page=1` needed |
| `paginationPattern.startPage` | `1` | not zero-indexed |
| `paginationPattern.zeroIndexed` | `false` | — |
| `sortParam` | **`"?sort=newest"`** | newest-first sort baked into catalogUrls |
| `sortVerified` | **`true`** | proved honored via 3-outcome counter-control (BC Mistake 29) |

> **How sort was verified:** `<select id="sort" name="sort">` exposed 8 options (`featured` default, `newest`, `bestselling`, `alphaasc`, `alphadesc`, `avgcustomerreview`, `priceasc`, `pricedesc`). The 3-outcome counter-control test on `/firearms/`: default first product = `Ruger American Gen II ...` (sort=featured), `?sort=newest` first product = same `Ruger American Gen II ...`, but `?sort=alphaasc` first product changed to `Adler AD500 ...`. Verdict = **`honored-default-is-newest`** — default sort happens to equal newest by coincidence, the counter-control swap proves the engine actually re-sorts. This is exactly the BC Stencil false-negative trap (Mistake 29). Cross-confirmation: under `?sort=newest`, the first 12 `data-product-id` values are strictly descending (`284154, 283918, 283917, 282452, 282451, 282450, 282449, 282448, 282438, 282437, 282436, 282435`) — proving the engine emits newest IDs first.

---

## Inventory size

| field | value |
|---|---|
| `expectedProductCount` | **`11978`** |
| `productCountMethod` | `bc-xmlsitemap` |

> Read directly from the BigCommerce sitemap: `GET /xmlsitemap.php?type=products&page=1` returns 9,999 `<url>` entries; `&page=2` returns 1,979 — total 11,978. This is the canonical BC count source (Stage 8 priority #7) — sitemap-style methods include OOS products by design, which is a feature for monitoring (we want to track items that come back in stock), not noise. Walked dedup gave 11,316 (5.5% lower); per Stage 8 priority discipline, did NOT downrank `bc-xmlsitemap` to the walked count.

---

## Crawler config — runtime behavior

| Phase | field | value | what it means |
|---|---|---|---|
| **Tier 1 (new items)** | `crawlers.watermark.method` | **`navigate-from-watermark`** | sort=newest verified; paginate newest-first to find watermark, then walk back to index new products |
| Bootstrap | `crawlers.bootstrap.apiEndpoints` | `null` | no public Storefront API exposed (`/api/storefront/products` returns 404) — pure HTML walk |
| **Maintain** | `crawlers.maintain.verifyMethod` | **`detail-page`** | each verify is a Playwright/HTML page fetch; no batch API |
| Maintain | `crawlers.maintain.verifyEndpoint` | `null` | BC stores have no batch product API exposed publicly |

> `crawlers.watermark.reason`: *BigCommerce Stencil. sort=newest verified honored via 3-outcome counter-control: default sort=featured first product equals sort=newest first product (Ruger American Gen II), counter-control sort=alphaasc differs (Adler AD500). honored-default-is-newest verdict (BC Mistake 29). data-product-id strictly descending under sort=newest (firearms top-12: 284154, 283918, 283917, 282452, 282451, 282450, 282449, 282448, 282438, 282437, 282436, 282435). No public Storefront API for date-since filter (POST /api/storefront/products returns 404).*

---

## Platform extras

Both omitted — neither applies to a BigCommerce Stencil retailer:

| field | omitted because |
|---|---|
| `classifiedRules` | `adapterType` is not `classifieds-*` |
| `ecwidStoreId` | `platform` is not `ecwid-*` |

---

## Provenance

| field | value |
|---|---|
| `profileVersion` | `1` |
| `lastVerified` | `2026-05-10` |
| `auditNotes.runId` | `audit-2026-05-10T07-54-00-000Z` |
| `auditNotes.harnessVersion` | AI-driven, post-2026-04-27 pivot |
| `auditNotes.drivenByAIDirectly` | `true` |

**`auditNotes.fieldConfidence`** — every field's confidence level:

| field | confidence |
|---|---|
| `platform`, `hasWaf`, `hasCaptcha`, `ageGate` | verified |
| `expectedProductCount`, `productCountMethod` | verified |
| `catalogUrls`, `extractionTested` | verified |
| `paginationPattern` | verified-via-zero-overlap |
| `sortParam`, `watermarkMethod` | verified-via-counter-control |
| `maintainVerifyMethod` | derived-from-platform |

**`auditNotes.stageNotes`** — what happened at each of the 9 stages:

1. **Stage 1 (Canonical URL):** apex returned 200 cleanly; `<link rel="canonical" href="https://theammosource.com/">` confirmed in homepage HTML. www variant 301-redirects to apex. canonicalOrigin = `https://theammosource.com`.
2. **Stage 2 (WAF + CAPTCHA):** `cf-ray` + `__cf_bm` cookie on every response — `wafType=cloudflare-passive`. 8/8 probe batches all 200 (or expected 403/404 from BC backend on honeypot paths, not WAF). No CAPTCHA markers (no reCAPTCHA / hCaptcha / Turnstile) on homepage HTML. `hasCaptcha=false`.
3. **Stage 3 (Platform):** BigCommerce Stencil identified by `cdn11.bigcommerce.com` asset hosts, `x-bc-store-id=1000222338` header, `BC-Ray:1` header, `stencil-*` CSS classes (100+ refs in homepage HTML). `adapterType=generic-retail` (BC has no dedicated adapter). No age-gate markers in homepage HTML. Maintain `verifyMethod=detail-page` (BC Storefront API returns 404).
4. **Stage 4 (Catalog URLs):** 27 top-level categories curated from `<li class="navPages-item">` megamenu (filtered out static pages — Home/Warranty/Privacy/Terms/Shipping/Contact/GOC-store/Movie Prop Rentals — and the brand sub-list cluster that follows position 27). Each category probed with `?limit=250&page=N` walk; full walk gave 11,503 sum / 11,316 deduped unique. Smallest = E-BIKE @ 4 products (kept per Mistake 12 — never drop small categories). Largest = Fishing @ 4,464 / 18 pages.
5. **Stage 5 (Pagination):** tested `?page=N`. Page-1 vs page-2 zero-overlap confirmed (52 distinct each, 0 overlap). Default `/firearms/` has perPage=52 articles (typical BC theme: ~50 + featured slot). `paginationPattern.template=page` (param name only per Mistake 14). **Verified perPage cap:** `?limit=250` returns 250 distinct, `?limit=500` returns 499, `?limit=1000` returns 997, `?limit=2500` returns 1,059 (genuine firearms-cat ceiling). **No `<select name="limit">` exists on this BC theme** — `limit` is a free query param. Recorded `perPage=50` as the canonical default.
6. **Stage 6 (Sort):** `<select id="sort" name="sort">` exposed 8 options: `featured` (default) / `newest` / `bestselling` / `alphaasc` / `alphadesc` / `avgcustomerreview` / `priceasc` / `pricedesc`. 3-outcome counter-control test on `/firearms/`: default==newest first product (Ruger American Gen II), but alphaasc differs (Adler AD500) — **`honored-default-is-newest`** verdict (BC Mistake 29 caught). `sortParam="?sort=newest"` baked into catalogUrls to make watermark traversal explicit.
7. **Stage 7 (Watermark method):** `navigate-from-watermark` — sort=newest honored upstream, `data-product-id` strictly descending under newest sort (firearms top-12 IDs: `284154, 283918, 283917, 282452, 282451, 282450, 282449, 282448, 282438, 282437, 282436, 282435` — all descending), no public Storefront API for date filter (`POST /api/storefront/products` -> 404).
8. **Stage 8 (Product count):** `bc-xmlsitemap` canonical for BC (Stage 8 priority #7). `xmlsitemap.php?type=products` has 2 pages (page=1=9,999 urls, page=2=1,979 urls). `expectedProductCount=11,978`. Walked (per-category dedup) = 11,316; sitemap > walked by 5.5% — consistent with OOS / hidden products kept in sitemap but excluded from active category listings (operator-flagged feature, not noise). Did not downrank `bc-xmlsitemap` to walk count per Stage 8 priority discipline.
9. **Stage 9 (Assembly + validate):** validator passed 9/9 required + 7/7 recommended (score 100).
