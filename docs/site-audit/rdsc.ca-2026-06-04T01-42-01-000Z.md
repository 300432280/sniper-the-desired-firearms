# Pre-Bootstrap Output — rdsc.ca

> **Result: READY to crawl (but currently PARKED).** Validator 22/22 pass (score 100, 0 failures). Magento 2.x, Cloudflare-**passive** (no active filtering), no CAPTCHA, no age-gate. **9,521 products** across 11 firearm-relevant top-level categories, fully reachable via a single newest-first catalog URL `/new-products.html`. **The ~0.4% coverage is NOT a crawlability problem — the site is operationally disabled (`isEnabled=false`) and bootstrap never ran.** Phase-A R1 gentle WAF probe only (single GET per URL).

---

## 1. At a glance

| What | Value |
|---|---|
| Platform / adapter | **Magento 2.x** -> `generic-retail` |
| Protections | Cloudflare-**passive**, no WAF block, no CAPTCHA, no age-gate |
| Catalog size | **9,521** products (sitemap union); cross-checked 9,487 / 9,517 / DB 9,343 |
| Catalog spine | **1 URL** -- `/new-products.html` (100% coverage, newest-first) |
| Page walking | `?p={N}` query pagination, **perPage 48** (verified honored) |
| Sort | `?product_list_order=new` -- **verified honored** (counter-control) |
| New-item crawl | **`navigate-from-watermark`** |
| Maintain verify | `detail-page` (Magento, non-WC) |
| **Why parked** | **`isEnabled=false`, bootstrap never started -- operational, not technical** |

---

## 2. Identity

| field | value |
|---|---|
| `platform` | `"magento2"` |
| `adapterType` | `"generic-retail"` |

Magento 2.x confirmed by multiple markers (`Magento_PageBuilder`, `Magento_Ui`, `/static/version1779888742`, `require.config`, 60+ `mage-*` classes). Magento maps to `generic-retail` per the platform->adapter table (Magento has no dedicated adapter). Matches DB.

---

## 3. Access — getting in safely

| field | value | meaning |
|---|---|---|
| `hasWaf` | **`false`** | Cloudflare present but passive -- does not block the crawler |
| `wafType` | `"cloudflare-passive"` | informational; crawler routes on `hasWaf` boolean only |
| `wafLastProbedAt` | `2026-06-04T01:35:10Z` | this session (gentle) |
| `wafProbeMethod` | `"gentle-single-get"` | **single GET per URL only** (Phase-A R1 IP-safety; no 8-batch heavy probe) |
| `hasCaptcha` | **`false`** | no reCAPTCHA/hCaptcha/turnstile in homepage HTML |
| `captchaType` | `null` | -- |
| `ageGate.detected` | **`false`** | no age-verification interstitial |
| `userAgentOverride` | `null` | desktop Chrome 120 works cleanly |
| `needsPlaywright` | **`false`** | plain HTTP returns full server-rendered product markup |

> Every crawl-path URL (`/`, two category pages, a product detail, `/new-products.html`) returned clean HTTP 200 with `cf-ray` + `server: cloudflare` + `cf-cache-status: DYNAMIC` and no challenge body / `cf-mitigated` header. **Gentle probe only** -- heavy 8-batch + sustained-load + production-IP confirmation deferred to R2/R3. A prior DB heavy-8-batch probe (2026-04-08) independently returned cloudflare-passive, corroborating `hasWaf=false`.

---

## 4. Catalog discovery — where the products are

| category | products (`of N` toolbar) | path |
|---|---|---|
| Manufacturers (all-products spine) | 9,517 | `/manufacturers.html` |
| Semi-Auto Rifle Parts | 1,862 | `/semi-auto-rifle-parts.html` |
| Firearms & Ammunition | 1,756 | `/firearms-ammunition.html` |
| Gear & Kit | 1,220 | `/gear-kit.html` |
| Optics & Mounts | 1,212 | `/optics-mounts.html` |
| Precision Rifle Parts | 1,196 | `/precision-rifle-parts.html` |
| Handgun Parts | 1,138 | `/handgun-parts.html` |
| Clean & Maintain | 272 | `/clean-maintain.html` |
| Lever-Action Parts | 260 | `/lever-action-parts.html` |
| Shotgun Parts | 212 | `/shotgun-parts.html` |
| Clearance | 51 | `/clearance.html` |

> **`totalsSumCheck`:** `/new-products.html` toolbar = 9,487 and `/manufacturers.html` = 9,517 each independently reach ~100% of the 9,521-product sitemap union (every product carries a manufacturer and appears in the new-products widget). The 10 firearm sub-categories sum to ~9,179 *with overlap* (one product can sit in several). `catalogUrls` = `["/new-products.html"]` -- a single 100%-coverage spine that is newest-first by default and paginates cleanly to p=198 (48x197+31 = 9,487 = toolbar total).

**Extraction sample (Stage 4g):**

| url | title | price | stockStatus |
|---|---|---|---|
| `/5-11-tactical-36-double-rifle-case-black.html` | 5.11 Tactical, 36" Double Rifle Case, Black | 269.99 | in_stock |
| (category card) | -- | 64.99 | unknown |
| (category card) | -- | 319.99 | unknown |

`extractionTested = true` -- product detail yields title + `data-price-amount` + "In stock"; category cards carry `data-price-amount`.

---

## 5. Pagination & sort — how to traverse

| field | value | meaning |
|---|---|---|
| `paginationPattern.type` | `"query"` | `?p=N` query parameter |
| `paginationPattern.template` | `"p"` | param NAME only |
| `paginationPattern.perPage` | `48` | verified via `?product_list_limit=48` -> 48 cards |
| `paginationPattern.firstPageHasParam` | `false` | page 1 = bare URL |
| `paginationPattern.startPage` | `1` | 1-indexed |
| `paginationPattern.zeroIndexed` | `false` | -- |
| `perPage` | `48` | matches paginationPattern |
| `sortParam` | `"?product_list_order=new"` | newest-first |
| `sortVerified` | **`true`** | counter-control proved honored |

> **Pagination:** page 1 vs `?p=2` on `/semi-auto-rifle-parts.html` returned 24 fully disjoint product IDs (zero overlap). `/new-products.html` walks to p=198 (last page 31 cards). **perPage:** `?product_list_limit=48` returns 48 (honored); `?product_list_limit=36` fell back to 24 (36 is not a Magento-allowed option, not a server cap). **Sort:** `?product_list_order=new` first-5 `[2171619, 2171620, ...]` != `?product_list_order=name&dir=asc` first-5 `[57071, 57109, ...]` -> sort honored, not NOOP. Default listing order is already newest-first by entity ID (near-monotonic descending; tiny local swaps are same-batch sequential SKUs).

---

## 6. Inventory size

| field | value |
|---|---|
| `expectedProductCount` | **9,521** |
| `productCountMethod` | `{method:"generic-product-sitemap", url:"/sitemap-1-1.xml", pattern:"\\.html?(?:$|[?#])"}` |

> Count derived from the Magento sitemap-index: SM1 (`/sitemap-1-1.xml`, 7,346 image-tagged product entries) + SM2 (`/sitemap-1-2.xml`, 2,175) = **9,521 distinct product URLs, zero overlap**, all root-level single-segment `.html`. Cross-checks: `/new-products.html` toolbar 9,487; `/manufacturers.html` toolbar 9,517; DB `expectedProductCount` 9,343 -- all within ~2%. **The DB 9,343 is REAL** (a slightly older snapshot). Candidate uses 9,521 (freshest, OOS-inclusive). *Note: candidate points `productCountMethod.url` at `/sitemap-1-1.xml` -- this is ~SM1 only (7,346); for the full count the runtime should use `sitemap-index` over both child files OR the existing DB `html-pagination` on `/new-products.html` `.toolbar-number` (9,487). Flagged as a method-shape refinement for R2 -- see inconclusive fields.*

---

## 7. Crawler config — runtime behavior

| Phase | field | value | what it means |
|---|---|---|---|
| Watermark | `crawlers.watermark.method` | **`navigate-from-watermark`** | walk newest-first listing, stop at watermark |
| Maintain | `crawlers.maintain.verifyMethod` | `detail-page` | per-product detail-page verification (Playwright/HTML) |
| Maintain | `crawlers.maintain.verifyEndpoint` | `null` | no batch API (Magento, non-WC) |

> **Watermark reason:** "Default listing order is newest-first by Magento entity ID ... `?product_list_order=new` verified honored via counter-control ... new products appear at top of `/new-products.html` page 1." `detail-page` verify catches OOS transitions + 404 deletions; no WC Store API exists for Magento and `/rest/` is robots-disallowed.

---

## 8. Platform extras

| field | value |
|---|---|
| `classifiedRules` | n/a (not a classifieds site) |
| `ecwidStoreId` | n/a (not Ecwid) |
| `searchUrl` | `/catalogsearch/result/?q={keyword}` (Magento standard; inherited from DB, not junk-keyword-diff-tested this session) |

---

## 9. Provenance

| field | value |
|---|---|
| `profileVersion` | 1 |
| `lastVerified` | 2026-06-04 |
| `runId` | phase-a-r1-wave2-2026-06-03 |
| `mode` | BLIND calibration (Phase A R1); gentle WAF only; READ-ONLY |
| `probeIp` | audit-host (NOT production crawler IP) |

**Field confidence**

| field | confidence |
|---|---|
| platform / adapterType | high |
| hasWaf | high (gentle-only; corroborated by prior DB heavy probe) |
| expectedProductCount | high |
| catalogUrls | high (full p=198 walk) |
| sortParam / sortVerified | high (counter-control) |
| perPage / paginationPattern | high (limiter verified; p1 n p2 = 0) |
| watermark.method | high |
| maintain.verifyMethod | medium (inherited from DB; not live-exercised) |
| productCountMethod | medium (sitemap method not run through runtime probe) |

**Low-coverage blocker (the headline finding)**

> The ~0.4% coverage (42 of ~9,521) is **operational, not technical**. The DB row has `isEnabled=false`, `crawlPhase="bootstrap"`, `bootstrapStartedAt=null`, `bootstrapCompletedAt=null`. The 42 indexed products were all first-seen **2026-03-01 ... 2026-03-20** (early pre-park activity); nothing has been added since, and `lastCrawlAt=2026-04-30`. **Bootstrap never ran to completion.** The site is fully crawlable today -- CF-passive, plain-HTTP extraction works, pagination + perPage + sort all verified, single catalogUrl reaches 100%. **Action: enable the site and trigger bootstrap. No code or profile fix is required for crawlability.**

**Stage notes**

1. Stage 1 -- apex `rdsc.ca` clean 200 (Chrome 120). robots.txt declares `Sitemap: https://www.rdsc.ca/sitemap.xml` (www). Both apex and www resolve 200; candidate uses path-relative URLs.
2. Stage 2 -- gentle probe only. `cf-ray` + `server: cloudflare` + `cf-cache-status: DYNAMIC` on every response; clean 200 across all crawl-path URLs; no challenge, no `cf-mitigated`. `hasWaf=false`. No CAPTCHA, no age-gate.
3. Stage 3 -- Magento 2.x (PageBuilder, Ui, `/static/version...`, `require.config`, `mage-*`). `generic-retail`. `needsPlaywright=false`. maintain `detail-page`.
4. Stage 4 -- `/new-products.html` toolbar 9,487 ~= full catalog; paginates to p=198. `/manufacturers.html` 9,517. 11 firearm-relevant top-level categories. Single catalogUrl spine.
5. Stage 5 -- `?p=N` (query, template `p`), perPage 48 verified. p1 vs p2 zero ID overlap.
6. Stage 6 -- `?product_list_order=new` verified honored via counter-control (`new` != `name`). Default order already newest by entity ID.
7. Stage 7 -- `navigate-from-watermark`: newest-first sort verified + ID-descending default; new items at top.
8. Stage 8 -- `expectedProductCount=9,521` (sitemap image-tagged union, OOS-inclusive). Cross-checks 9,487 / 9,517 / DB 9,343 all within 2%. **9,343 is REAL.**
9. Stage 9 -- candidate assembled; validator 22/22 pass. Blocker = operational (`isEnabled=false`), not crawlability.

**Inconclusive / deferred (gentle R1 scope)**

- `productCountMethod` runtime execution -- `generic-product-sitemap` over `/sitemap-1-1.xml` is SM1-only (7,346); for the full 9,521 use `sitemap-index` over both child sitemaps OR keep the DB `html-pagination` method. Not run through `product-count-probe.ts` this session.
- `maintain.verifyMethod` end-to-end -- `detail-page` inherited from DB; Magento detail-page verify path not exercised live.
- WAF under production-IP + sustained load -- gentle single-GET only; heavy-8-batch + sustained walk deferred to R2/R3.
- `searchUrl` -- inherited from DB; not junk-keyword-diff-tested (B3) this session.
