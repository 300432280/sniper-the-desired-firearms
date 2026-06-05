# Pre-Bootstrap Output — sail.ca

> **Result: READY (with 2 documented runtime gaps).** Validator: 9/9 required pass. Magento 2 + Searchspring SPA, no active WAF (gentle probe only), reCAPTCHA site-wide but non-gating. **Whole store = 18,777 products; firearm-relevant (Hunting dept) = 3,223.** catalogUrls scoped to ONE URL (`/en/hunting`) covering 3,223 unique products at 0% drift. `needsPlaywright: true` (HTML category pages are Searchspring-rendered). **Scope flag: DB count ~18,944 is whole-store and WRONG for a firearms monitor — true target is 3,223.**

---

## 1. At a glance

| What | Value |
|---|---|
| Platform / adapter | **Magento 2** / `generic-retail` |
| Protections | hasWaf **false** (gentle probe), reCAPTCHA v3 site-wide (non-gating), no age-gate |
| Catalog size | **3,223** firearm-relevant (Hunting); 18,777 whole-store |
| Page walking | Searchspring SPA → **needsPlaywright true**; query pagination, **perPage 24** (hard cap) |
| Sort | `sort.created_at=desc` (Newest), **verified honored** |
| New-item crawl | **navigate-from-watermark** |
| Maintain verify | **detail-page** (Magento, non-WC) |

---

## 2. Identity

| field | value |
|---|---|
| `platform` | `"magento-2.x"` |
| `adapterType` | `"generic-retail"` |

Magento 2 confirmed via `static/version1780492192/` cache-path fingerprint + `text/x-magento-init` script blocks. Magento maps to `generic-retail` per the platform→adapter table; matches DB.

---

## 3. Access — getting in safely

| field | value | meaning |
|---|---|---|
| `hasWaf` | **`false`** | No CDN/WAF challenge on gentle GET |
| `wafType` | `null` | No cf-ray / x-sucuri / Akamai headers observed |
| `wafProbeMethod` | `"gentle-single-get"` | **Heavy 8-batch NOT run** (W2R1 anti-ban constraint) |
| `hasCaptcha` | **`false`** | reCAPTCHA present site-wide; does not gate catalog crawl |
| `captchaType` | `"recaptcha-v3"` | informational |
| `ageGate.detected` | `false` | no age interstitial |
| `userAgentOverride` | `null` | desktop Chrome UA works |
| `needsPlaywright` | **`true`** | Static HTML returns 0 product cards (Searchspring SPA) |

> Gentle detection only: apex `sail.ca` 301→`https://www.sail.ca/en/`; PHPSESSID cookie, `x-frame-options: SAMEORIGIN`, no CDN-WAF headers. **Operator must re-run the heavy probe from the production IP before promotion** — WAF verdict is IP-dependent and this run used gentle single-GET detection only.

---

## 4. Catalog discovery — where the products are

Single firearm-relevant catalog URL: **`https://www.sail.ca/en/hunting`** (Searchspring `hierarchy="Hunting"` → 3,223 products).

Hunting subtree (Searchspring `category_hierarchy` facet, counts double-count multi-tagged items):

| sub-node | count |
|---|---|
| Hunting>Species | 683 |
| Hunting>Firearms | 539 |
| Hunting>Scope & Shooting Accessories | 507 |
| Hunting>Hunting Accessories | 439 |
| Hunting>Attractants, Urine & Feeders | 429 |
| Hunting>Firearm accessories | 384 |
| Hunting>Hunting Clothing | 339 |
| Hunting>Game Calls | 174 |
| Hunting>Crossbows & Bows | 150 |
| Hunting>New Arrivals | 122 |
| Hunting>Hunting knives & Tools | 93 |
| Hunting>Airguns | 78 |
| Hunting>Decoys | 72 |
| Hunting>Hunting Boots | 48 |
| Hunting>Tactical | 7 |

> **Coverage proof:** full 135-page Searchspring walk of `/en/hunting` returned **3,223 unique uids == pagination.totalResults (3,223)**, 0% drift. One URL achieves 100% firearm-relevant coverage = minimum URL set.

Extraction sample (Searchspring API + Playwright-rendered HTML both yield these):

| title | price | stockStatus |
|---|---|---|
| SXP Extreme Defender Pump-Action Shotgun | 749.99 | unknown |
| 301 Single-Shot Shotgun | null | unknown |
| Game Steel 12 ga. Shotshells | null | unknown |

`extractionTested = true` (Playwright render: `.product-item`=39, `a.product-item-link`=61 on `/en/hunting/firearms`).

---

## 5. Pagination & sort — how to traverse

| field | value | meaning |
|---|---|---|
| `paginationPattern.type` | `"query"` | `?page=N` |
| `paginationPattern.template` | `"page"` | param name only |
| `paginationPattern.perPage` | **`24`** | Searchspring hard-caps pageSize at 24 (requested 100/200/300 all returned 24) |
| `paginationPattern.firstPageHasParam` | `false` | |
| `paginationPattern.startPage` | `1` | |
| `sortParam` | `"sort.created_at=desc"` | Searchspring Newest sort |
| `sortVerified` | **`true`** | |

> Sort verified: default first-5 vs `sort.created_at=desc` first-5 DIFFER; page1/page2 uid overlap = 0 (clean pagination). `sort.newest` (wrong field) was ignored — confirms the field name `created_at` is the real one read from the API `sorting.options` array (label "Newest").

---

## 6. Inventory size

| field | value |
|---|---|
| `expectedProductCount` | **`3223`** (firearm-relevant, Hunting) |
| `productCountMethod` | `sitemap-index` over 2 EN product sitemaps |

> **Count mismatch is deliberate and flagged.** `productCountMethod` (sitemap-index) returns the WHOLE-STORE 18,777 — the only runtime-reachable method today. The firearm-relevant 3,223 is obtainable only via the foreign-origin Searchspring API, which the runtime count probe cannot reach (`json-api-count` prepends `${origin}`, no absolute-URL guard). See Provenance gaps.

---

## 7. Crawler config — runtime behavior

| Phase | field | value | meaning |
|---|---|---|---|
| watermark | `crawlers.watermark.method` | `navigate-from-watermark` | sort.created_at=desc verified honored |
| maintain | `crawlers.maintain.verifyMethod` | `detail-page` | Magento non-WC → Playwright detail-page |
| maintain | `crawlers.maintain.verifyEndpoint` | `null` | no store-api on Magento storefront |

> watermark reason: "Searchspring sort.created_at=desc verified honored (Newest differs from default); listing carries product URLs with monotonic created order. API perPage=24, page param pagination."

---

## 8. Platform extras

| field | value |
|---|---|
| `classifiedRules` | n/a (not a classifieds site) |
| `ecwidStoreId` | n/a |
| Searchspring siteId | `s8zq1c` (documented in auditNotes; no runtime field) |

---

## 9. Provenance

| field | value |
|---|---|
| `profileVersion` | 1 |
| `lastVerified` | 2026-06-03 |
| runId | W2R1-sail-2026-06-03 (Phase A R1 blind) |
| probeIp | audit-IP (not production) |

**Two runtime gaps (require code fix before firearm-relevant counting works):**
1. **Count probe foreign-origin gap** — `product-count-probe.ts:265` `json-api-count` does `${origin}${m.endpoint}` with no `startsWith('http')` guard (unlike `sitemap-index:312`). Searchspring API is on `s8zq1c.a.searchspring.io`, unreachable. Firearm-relevant count probe is effectively disabled; whole-store sitemap-index is the fallback.
2. **Catalog scope** — DB count ~18,944 = whole store. For a firearms monitor it is wrong scope. `~33% indexed / parked since April` is consistent with an unscoped whole-store Playwright walk (135+ pages × Playwright = too slow). Scoping to `/en/hunting` (3,223) is the fix.

Stage notes:
1. Canonical = `https://www.sail.ca`; apex 301→/en/; x-default=/en/.
2. WAF: gentle only, no challenge; heavy probe deferred per anti-ban constraint.
3. Platform: Magento 2 (static/version path); reCAPTCHA non-gating; no age gate.
4. Catalog: `/en/hunting` single URL, 3,223 unique (0% drift) via Searchspring walk.
5. Pagination: `?page=N`, perPage capped at 24 by Searchspring.
6. Sort: `sort.created_at=desc` verified (differs from default + counter-control).
7. Watermark: navigate-from-watermark (sort honored).
8. Count: firearm-relevant 3,223; whole-store 18,777; method gap documented.
9. Assembly: validator 9/9 pass.
