# Pre-Bootstrap Output — solelyoutdoors.com

> **Result:** ready for operator review.
> 9 required + 7 recommended validator checks passed. Cloudflare-passive WAF, no CAPTCHA, no age-gate. **1,761 products** discovered across 9 top-level categories (48 leaf catalog URLs because 7 of 9 parents are tile-only landing pages).

---

## At a glance

| What | Value |
|---|---|
| Site runs on | **Lightspeed eCom (Shoplightspeed)** Nova theme (uses `generic-retail` adapter) |
| Protections in front | **Cloudflare-passive** — `hasWaf=true`, `hasCaptcha=false`, no age-gate |
| Catalog | **1,761 products** across **9 top-level categories** (48 leaf catalog URLs) |
| Page walking | suffix-replace → `page{N}.html?sort=newest` · `perPage=24` |
| Sort | **`?sort=newest`** · verified honored via counter-control |
| New-item crawl | `crawlers.watermark.method = navigate-from-watermark` |
| Re-verify in maintain phase | `crawlers.maintain.verifyMethod = detail-page` (no batch API) |

---

## Identity

The skill matched the homepage signals to **Lightspeed eCom** (Shoplightspeed) Nova theme via `cdn.shoplightspeed.com` asset URLs, the `"(c) 2008-2026 Lightspeed Netherlands B.V."` copyright string, the `x-shop-id: 613284` origin response header, and the `.product-grid[class*="col-"]` Lightspeed Nova theme markers (already supported in `backend/src/services/scraper/adapters/generic-retail.ts:73`). Lightspeed eCom doesn't have a dedicated adapter — it falls back to `generic-retail`.

| field | value |
|---|---|
| `platform` | `"lightspeed-ecom"` |
| `adapterType` | `"generic-retail"` |

---

## Access — getting in safely

Cloudflare sits in front. Normal product/catalog GETs all return 200; Cloudflare's WAF active-rule layer fires on common honeypot paths and SQLi-shaped queries, but the canonical catalog crawl path is unaffected. No JS-challenge interstitial. Default desktop UA works fine.

| field | value | meaning |
|---|---|---|
| `hasWaf` | **`true`** | Cloudflare-passive — `cf-ray` on every request |
| `wafType` | `"cloudflare-passive"` | active rules exist but no challenge interstitial on normal pages |
| `wafLastProbedAt` | `"2026-05-09T10:38:19Z"` | when the 8-batch probe ran |
| `wafProbeMethod` | `"heavy-8-batch"` | which probe method |
| `hasCaptcha` | **`false`** | no reCAPTCHA / hCaptcha / Turnstile in homepage HTML |
| `captchaType` | `null` | — |
| `ageGate.detected` | **`false`** | no interstitial age-confirmation gate |
| `userAgentOverride` | `null` | default desktop UA works |
| `needsPlaywright` | **`false`** | static HTML is enough |

> **Probe evidence** (`wafProbeEvidence`): every batch returned 200 with `cf-ray` + `Server: cloudflare` + `__cf_bm` cookie. Honeypot paths (`/wp-login.php`, `/xmlrpc.php`, `/.env`, `/.git/config`, `/phpinfo.php`) all return **403** with the same 5498-byte canned body — clear Cloudflare WAF active-rule signature. `/wp-admin/` returns 404 (origin app, not WAF). `?id=1' OR '1'='1` plain SQLi → 200, but `?id=1 UNION SELECT 1,2,3` → 403 (UNION rule fires). XSS payload → 200. No-UA → 200. Rapid burst (10 req in ~7s) — all 200, no 429. No Sucuri / Incapsula / Akamai / MalCare markers. The origin sets `x-shop-id: 613284` (Lightspeed eCom shop ID, useful for storefront API discovery if needed in future).

---

## Catalog discovery — where the products are

**`catalogUrls`** — 48 URLs. The site has 9 top-level nav categories, but **7 of 9 are tile-only landing pages** (`/firearms/`, `/ammunition/`, `/reloading/`, `/opitcs-plus/`, `/knivesaxesflashlights-tools/`, `/shooting-firearm-acessories/`, `/archeryairgunsairsoft-slingshots/`) that show subcategory tiles instead of products even with `?sort=newest&limit=24` applied. The other 2 (`/camping/`, `/hunting/`) aggregate child products on the parent. Catalog URLs are the leaf subcategories of the tile-only parents + the 2 aggregating parents themselves.

| Category (top-level) | Tile-only? | Page-1 (parent) | Leaf catalog URLs |
|---|---|---:|---:|
| `/ammunition` | yes | 0 | 5 |
| `/archeryairgunsairsoft-slingshots` | yes | 0 | 4 |
| `/camping` | no (aggregates) | 19 | 1 (parent itself) |
| `/firearms` | yes | 0 | 4 |
| `/hunting` | no (aggregates) | 24 | 1 (parent itself) |
| `/knivesaxesflashlights-tools` | yes | 0 | 11 |
| `/opitcs-plus` | yes | 0 | 10 |
| `/reloading` | yes | 0 | 7 |
| `/shooting-firearm-acessories` | yes | 0 | 6 |

Each catalogUrl bakes in `?sort=newest` because the Lightspeed default sort is `popular` (Most viewed), not date — without baking sort, the watermark crawl would walk popularity-ordered, not newest-first.

**`topLevelCategories.totalsSumCheck`:**

> Sitemap.xml reports **1,761 product URLs** at root-level `/<slug>.html`.
> Cross-check via `/collection/` aggregator walk = **73 full pages × 24 + 9 final-page items = 1,761** — exact match (0 drift).
> 8 currently-empty subcategories (e.g. `/shooting-firearm-acessories/handgun-parts/`, `/knivesaxesflashlights-tools/saws/`, `/hunting/blinds-camouflage/`) excluded from catalogUrls — they returned 0 products at audit time and the page rendered "No products" canned message. Operator should re-run pre-bootstrap if any of those gain inventory.

**`extractionSample`** — 3 random products spot-checked from `/firearms/non-restricted/?sort=newest`, all 4 required fields populated:

| `title` | `price` | `stockStatus` |
|---|---:|---|
| Henry Henry Big Boy Brass 44 Mag/44 SPL 20" BBL Octagon Lever Action Rifle | C$1,549.99 | `in_stock` |
| MAKASI RIFLE MK-15 Billet Receiver 5.56 18.6" Barrel Pre-Order | C$200.00 | `in_stock` |
| Beretta 1301 Tactical MOD 2, GRY - 12GA, 2-3/4" or 3" 18.5" BBL | C$2,140.00 | `in_stock` |

`extractionTested = true`. The Lightspeed Nova theme `.product-grid[class*="col-"]` selector at `generic-retail.ts:73` already supports this storefront — no new selector required.

---

## Pagination & sort — how to traverse

| field | value | meaning |
|---|---|---|
| `paginationPattern.type` | **`"suffix-replace"`** | not `?page=N` query — Lightspeed silently ignores it (Mistake 26) |
| `paginationPattern.template` | `"page{N}.html?sort=newest"` | sort baked into both match and template |
| `paginationPattern.match` | `"?sort=newest"` | the substring on the page-1 URL replaced to build page N |
| `paginationPattern.perPage` | **`24`** | products per page from `<input name="limit" value="24">` |
| `paginationPattern.firstPageHasParam` | `true` | page 1 = catalog URL with `?sort=newest` already on |
| `paginationPattern.startPage` | `1` | not zero-indexed |
| `paginationPattern.zeroIndexed` | `false` | — |
| `sortParam` | **`"?sort=newest"`** | newest-first sort |
| `sortVerified` | **`true`** | proved honored via counter-control swap |

> **How sort and pagination were verified:** on `/firearms/non-restricted/`, the `<select name="sort">` exposes options `default | popular (selected) | newest | lowest | highest | asc | desc`. Default first product was `norinco-type-81-sr-...`; `?sort=newest` first product was `henry-big-boy-brass-...`; counter-control `?sort=lowest` first product was `makasi-rifle-mk-15-...` — three different first products, proving the sort is honored (not the BC-Stencil "default-IS-newest" false-negative case). Pagination test: `?page=2&sort=newest` returned the same products as page 1 (silently ignored — Mistake 26 reproduced). `/page2.html?sort=newest` returned a completely different product set (`charles-daly-n4s-bullpup-...` first). Zero-overlap confirmed page 1 vs page 2.

---

## Inventory size

| field | value |
|---|---|
| `expectedProductCount` | **`1761`** |
| `productCountMethod` | `"generic-product-sitemap"` |

> Counted from `/sitemap.xml` filtered to root-level `/<slug>.html` URLs (1,761). Cross-check: walking the global `/collection/` aggregator (which Lightspeed exposes as a sort-able all-products listing) gives 73 full pages × 24 perPage + 9 last-page items = 1,761 — **exact match with sitemap**. Lightspeed eCom does not expose a public `/products/count.json` or REST product endpoint to query directly; sitemap is the canonical authoritative source for this storefront.

---

## Crawler config — runtime behavior

| Phase | field | value | what it means |
|---|---|---|---|
| **Tier 1 (new items)** | `crawlers.watermark.method` | **`"navigate-from-watermark"`** | paginate newest-first to find watermark, then walk back to index new products |
| Bootstrap | `crawlers.bootstrap.apiEndpoints` | `null` | no platform API — pure HTML walk |
| **Maintain** | `crawlers.maintain.verifyMethod` | **`"detail-page"`** | each verify is a Playwright/HTTP page fetch (Lightspeed has no batch product API) |
| Maintain | `crawlers.maintain.verifyEndpoint` | `null` | — |

> `crawlers.watermark.reason`: *Stage 6 sort verdict = honored (default `norinco-type-81-sr` ≠ `?sort=newest` `henry-big-boy-brass` ≠ `?sort=lowest` `makasi-rifle-mk-15` — counter-control proved sort is honored on `/firearms/non-restricted/`). Pagination via `suffix-replace /pageN.html?sort=newest` verified zero-overlap page 1 vs page 2. Independent newest-first signal confirmed via `/index.rss` feed (RSS items in `<pubDate>` DESC order) — first RSS item dated `Fri, 08 May 2026 22:47:07 +0000`, matching the audit-day expectation. Lightspeed eCom does not expose a date-filter REST API, so Method A (`api-date-since-watermark`) is unavailable; Method B (`navigate-from-watermark`) is the right fit.*

---

## Platform extras

Both omitted — neither applies to a Lightspeed retailer:

| field | omitted because |
|---|---|
| `classifiedRules` | `adapterType` is not `classifieds-*` |
| `ecwidStoreId` | `platform` is not `ecwid-*` |

> Note: the `x-shop-id: 613284` Lightspeed shop ID is recorded in `wafProbeEvidence.originHeader` for future reference if the operator decides to explore Lightspeed's customer-API; it is NOT a runtime field.

---

## Provenance

| field | value |
|---|---|
| `profileVersion` | `1` |
| `lastVerified` | `"2026-05-09"` |
| `auditNotes.runId` | `"audit-2026-05-09T10-52-43Z"` |
| `auditNotes.harnessVersion` | `"AI-driven, post-2026-04-27 pivot"` |
| `auditNotes.drivenByAIDirectly` | `true` |

**`auditNotes.fieldConfidence`** — every field's confidence level:

| field | confidence |
|---|---|
| `platform`, `hasWaf`, `hasCaptcha`, `ageGate` | verified |
| `expectedProductCount`, `productCountMethod` | verified (2 sources agree exactly) |
| `catalogUrls`, `extractionTested` | verified |
| `paginationPattern`, `sortParam` | verified-via-counter-control |
| `watermarkMethod` | derived (Stage 6 + Stage 5 both passed) |
| `maintainVerifyMethod` | derived-from-platform |

**`auditNotes.stageNotes`** — what happened at each of the 9 stages:

1. **Stage 1 (Canonical URL):** apex `solelyoutdoors.com` returned 301 → `https://www.solelyoutdoors.com/` (200 OK). canonicalOrigin = `https://www.solelyoutdoors.com`.
2. **Stage 2 (WAF + CAPTCHA):** 8-batch heavy probe. `cf-ray` on every batch + `Server: cloudflare`. Honeypot paths `/wp-login.php` `/xmlrpc.php` `/.env` `/.git/config` `/phpinfo.php` = 403 (5498-byte canned). UNION-select SQLi = 403; plain SQLi quote / XSS / no-UA = 200. No CAPTCHA in HTML. wafType = `cloudflare-passive` (active rules but no challenge interstitial on normal pages).
3. **Stage 3 (Platform):** identified `lightspeed-ecom` (Shoplightspeed) Nova theme via `cdn.shoplightspeed.com` asset URLs + `Lightspeed Netherlands B.V.` copyright + `x-shop-id: 613284` origin header + `.product-grid[class*="col-"]` Nova theme markers (already supported in `generic-retail.ts:73`). adapterType = `generic-retail`. Maintain `verifyMethod = detail-page`.
4. **Stage 4 (Catalog URLs):** homepage nav yielded 9 top-level paths. 7 are tile-only parents (`/firearms/`, `/ammunition/`, `/reloading/`, `/opitcs-plus/`, `/knivesaxesflashlights-tools/`, `/shooting-firearm-acessories/`, `/archeryairgunsairsoft-slingshots/`) — recursed to leaf subcategories. `/camping/` + `/hunting/` parents aggregate child products (kept as own catalog URLs). Total **48 leaf catalog URLs** after excluding 8 currently-empty subcategories. `/collection/`, `/promotions/`, `/hot-sales/`, `/pal-course/` excluded (aggregator / sale / non-product service). All catalogUrls bake in `?sort=newest` because Lightspeed default sort is `popular`, not `newest`.
5. **Stage 5 (Pagination):** tested `?page=2&sort=newest` (silently ignored — same products as page 1) AND `/page2.html?sort=newest` (works — different products) on `/firearms/non-restricted/`. **Mistake 26 confirmed**: Lightspeed needs `suffix-replace`. paginationPattern.type = `suffix-replace`, template = `page{N}.html?sort=newest`, match = `?sort=newest`, perPage = 24.
6. **Stage 6 (Sort):** `<select name="sort">` exposed values `default | popular (selected) | newest | lowest | highest | asc | desc`. Default `popular` ≠ `?sort=newest` ≠ `?sort=lowest` first product (3-outcome counter-control test passed). sortParam = `?sort=newest`, sortVerified = `true`.
7. **Stage 7 (Watermark method):** `navigate-from-watermark`. Sort verified (Stage 6). Pagination verified (Stage 5). Independent newest-first signal: `/index.rss` with `<pubDate>` per item in DESC order. No date-filter API on Lightspeed eCom storefront → Method A (api-date-since-watermark) not available → Method B is the right choice.
8. **Stage 8 (Product count):** `/sitemap.xml` product-URL count = **1,761** (filtered to root-level `/<slug>.html` pattern). Cross-check via `/collection/` aggregator walk = 73 full pages × 24 + 9 final-page items = 1,761 — **exact match (0 drift)**. productCountMethod = `generic-product-sitemap`.
9. **Stage 9 (Assembly + validate):** candidate JSON + this markdown report assembled. profileVersion = 1, lastVerified = 2026-05-09. 9 required + 7 recommended runtime fields populated.
