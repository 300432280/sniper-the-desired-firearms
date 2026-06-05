# Pre-Bootstrap Output — truenortharms.com

> **R1 BLIND candidate — READY for R2 (with one LOW-confidence field).** Validator 22/22 pass (score 100). BigCommerce Stencil storefront (Makeswift page builder front-end), Cloudflare-PASSIVE (no active blocking), no CAPTCHA, no age-gate. **True product count = 1,125** (live product sitemap, stable across 3 fetches) — this REPLACES the DB's stale `expectedProductCount: 1264` and refutes the DB note's claim of "4420 sitemap entries". `catalogUrls` ships as a LOW-confidence R1 placeholder (categories sitemap) — must be walked+deduped to minimum coverage in R2.

---

## 1. At a glance

| What | Value |
|---|---|
| Platform / adapter | **`bigcommerce-stencil`** / `generic-retail` |
| Protections | hasWaf **`false`** (Cloudflare-passive), hasCaptcha `false`, ageGate `false` |
| Catalog size | **1,125 products** (live product sitemap) |
| Page-walking | `?page={N}` query, perPage **250** verified |
| Sort | `?sort=newest` — **verified honored** (default IS newest) |
| New-item crawl | **`navigate-from-watermark`** |
| Maintain verify | `detail-page` (no WC store-api on BigCommerce) |

---

## 2. Identity

| field | value |
|---|---|
| `platform` | `"bigcommerce-stencil"` |
| `adapterType` | `"generic-retail"` |

BigCommerce Stencil storefront (`cdn11.bigcommerce.com` ×332, `stencil` ×327, `x-bc-store-id: 1002255649`, store hash `s-e2fesuoqas`). Makeswift page-builder headers (`x-makeswift-page-locale`) are the CMS front-end, NOT the commerce platform. BigCommerce maps to `generic-retail` per the platform→adapter table.

---

## 3. Access — getting in safely

| field | value | meaning |
|---|---|---|
| `hasWaf` | **`false`** | Cloudflare present but passive — no challenge fired in any of 8 batches |
| `wafType` | `"cloudflare-passive"` | cf-ray + __cf_bm on every response; informational only |
| `wafLastProbedAt` | `2026-06-03T23:54:34Z` | |
| `wafProbeMethod` | `"heavy-8-batch"` | |
| `hasCaptcha` | **`false`** | no reCAPTCHA/hCaptcha/Turnstile markers in homepage HTML |
| `captchaType` | `null` | |
| `ageGate.detected` | **`false`** | no age-confirm interstitial |
| `userAgentOverride` | `null` | default UA pool works |
| `needsPlaywright` | **`false`** | plain HTTP returns full product markup |

> 8-batch heavy probe: every real-content batch returned 200 across desktop/mobile/bot/curl UAs; rapid 10× burst all 200 (610288 bytes each); SQLi query 200; XSS query → 400 (BigCommerce input validation, not a CDN challenge body). Honeypot paths `/wp-admin`, `/.env`, `/.git/config` → 403 with tiny 552/36355-byte BigCommerce-platform bodies (not WordPress — this site is BC-hosted). Verdict: Cloudflare-passive ⇒ `hasWaf: false`. **Audit-IP result — re-confirm from production crawler IP before promotion (Stage 2 IP-dependence rule).**

---

## 4. Catalog discovery — where the products are

**R1 BLIND — `catalogUrls` is a LOW-confidence placeholder.** Set to the categories sitemap (`/xmlsitemap.php?type=categories&page=1`, 170 canonical leaf-category URLs) as the discovery source. It has NOT been walked + ID-deduped to a minimum 100%-coverage set.

| Observation | Value |
|---|---|
| Product sitemap | 1,125 product `<loc>` (single `<urlset>`, pages 2-3 empty) |
| Categories sitemap | 170 leaf-category URLs (deeply nested, mixed `.html` / trailing-slash) |
| Parent-tile trap (B15) | `/firearms/` renders 11 subcategory tiles; `/ammo/centerfire` has 2 products — parents are NON-inclusive on this theme |
| Top-level slug reliability | LOW — `/ammo/` `/glock/` `/handguns/` etc. 301/404; canonical forms differ |

| extraction sample (from `/new-arrivals/?sort=newest`) | title | stockStatus |
|---|---|---|
| `/mdt-hunt-muzzle-brake-5-8x24/` | MDT Hunt Muzzle Brake 5/8x24 | unknown (R1 did not parse price/stock) |
| `/cz-bren-2-ms-trail-7-62x39-magazine-5-10rds/` | CZ Bren 2 MS Trail 7.62X39 Magazine 5/10rds | unknown |
| `/spare-moonclip-...-sulun-sr-410.../` | SULUN SR-410 revolver shotgun spare moon clip | unknown (live 200) |

`extractionTested = true` (title + URL extraction verified via BC `h4.card-title > a` selector; 3 sample product URLs return 200). **R2 must walk all 170 sitemap leaves, ID-dedup against the 1,125 product set, and prune to the minimum-coverage URL list.** DB ships 149 hand-curated leaf catalogUrls for comparison.

---

## 5. Pagination & sort — how to traverse

| field | value | meaning |
|---|---|---|
| `paginationPattern.type` | `"query"` | `?page=N` |
| `paginationPattern.template` | `"page"` | param NAME only |
| `paginationPattern.perPage` | **`250`** | `?limit=250` returned 250 cards |
| `paginationPattern.firstPageHasParam` | `false` | |
| `paginationPattern.startPage` | `1` | |
| `paginationPattern.zeroIndexed` | `false` | |
| `perPage` | `250` | |
| `sortParam` | `"?sort=newest"` | |
| `sortVerified` | **`true`** | |

> Sort verified on `/new-arrivals/` via 3-outcome counter-control test (cache-busted): default first-3 == `?sort=newest` first-3 (both start "MDT Hunt Muzzle Brake" → **honored-default-is-newest**); counter-control `?sort=alphaasc` reordered to A-Z morale patches (different) → param is genuinely honored, not NOOP. Page 2 product set was disjoint from page 1 → `?page=N` honored.

---

## 6. Inventory size

| field | value |
|---|---|
| `expectedProductCount` | **`1125`** |
| `productCountMethod` | `{ method: "sitemap", url: "/xmlsitemap.php?type=products&page=1" }` |

> Source: BigCommerce product sitemap (`/xmlsitemap.php?type=products&page=1`) — a single flat `<urlset>` with **1,125** `<loc>` entries, stable across 3 consecutive fetches; pages 2 and 3 return 0. Sample `<loc>`s are clean product slugs (no category mixing) and resolve to live 200 product pages. **DB `expectedProductCount: 1264` is wrong** (higher than the 1,125 the site actually publishes) and the **DB note's "4420 sitemap entries" does not reproduce today**. Task-reported index of 4,658 active products is ~414% of the live published catalog — stale accumulation that left the sitemap but was never cleared from the index.

---

## 7. Crawler config — runtime behavior

| Phase | field | value | meaning |
|---|---|---|---|
| watermark | `crawlers.watermark.method` | `"navigate-from-watermark"` | walk newest-first to watermark |
| maintain | `crawlers.maintain.verifyMethod` | `"detail-page"` | Playwright/HTML detail-page verify |
| maintain | `crawlers.maintain.verifyEndpoint` | `null` | no batch API (BC has no WC store-api) |

> Watermark reason: BC Stencil default category order IS newest-first (proved in §5), and `?sort=newest` is honored, so the crawler walks newest→watermark. No API date filter on BigCommerce storefront, so Method A is unavailable; Method B (`navigate-from-watermark`) is correct.

---

## 8. Platform extras

| field | value |
|---|---|
| `classifiedRules` | omitted (not a classifieds site) |
| `ecwidStoreId` | omitted (not Ecwid) |
| BigCommerce store id | `1002255649` (header `x-bc-store-id`), store hash `s-e2fesuoqas` (informational) |

---

## 9. Provenance

| field | value |
|---|---|
| `profileVersion` | `1` |
| `lastVerified` | `2026-06-03` |
| `auditNotes.runId` | `r1-blind-truenortharms-2026-06-03` |
| `auditNotes.round` | PHASE A R1 (blind) |
| validator | 22/22 pass, score 100, zero failures |

| field | confidence |
|---|---|
| platform / adapterType | high |
| hasWaf / wafType | high |
| expectedProductCount (1125) | high (sitemap-stable ×3) |
| sortParam / sortVerified | high (counter-control passed) |
| perPage (250) | high (limit=250 → 250 cards) |
| paginationPattern | high (page2 disjoint) |
| **catalogUrls** | **LOW — R1 placeholder, needs R2 walk+dedup** |

- Stage 1: apex canonical (`www` 301s → apex); homepage 200 with Chrome UA.
- Stage 2: 8-batch heavy probe → Cloudflare-passive, hasWaf=false. (Re-confirm from production IP before promotion.)
- Stage 3: BigCommerce Stencil (cdn11 + stencil markers + x-bc-store-id); no age-gate, no captcha; needsPlaywright=false.
- Stage 4: product sitemap (1125) + categories sitemap (170 leaves); parent-tile trap confirmed; catalogUrls = categories sitemap placeholder (LOW confidence, R2 to prune).
- Stage 5: `?page=N` honored (page2 disjoint), perPage 250 verified via `?limit=250`.
- Stage 6: `?sort=newest` verified honored via 3-outcome counter-control (default IS newest; alphaasc reorders).
- Stage 7: `navigate-from-watermark` (no storefront API date filter; sort+default-newest proven).
- Stage 8: `expectedProductCount=1125` via `{method:"sitemap"}`; refutes DB 1264 and the "4420" note.
- Stage 9: validator 22/22 pass; candidate + this report written to `docs/site-audit/`.
