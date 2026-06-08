# Pre-Bootstrap Output — bullseyenorth.com

> **Result:** ready for operator review.
> 9 required + 7 recommended validator checks passed. No WAF, no CAPTCHA, no age-gate. **3,277 products** discovered across 8 top-level categories.

---

## At a glance

| What | Value |
|---|---|
| Site runs on | **Celerant ColdFusion** (uses `generic-retail` adapter) |
| Protections in front | **None** — `hasWaf=false`, `hasCaptcha=false`, no age-gate |
| Catalog | **3,277 products** across **8 top-level categories** |
| Page walking | path-style → `/page/{N}` · `perPage=36` |
| Sort | **path-baked** → `sortParam=""` · verified honored |
| New-item crawl | `crawlers.watermark.method = navigate-from-watermark` |
| Re-verify in maintain phase | `crawlers.maintain.verifyMethod = detail-page` (no batch API) |

---

## Identity

The skill matched the homepage signals to **Celerant ColdFusion**. That platform doesn't have a dedicated adapter, so it falls back to `generic-retail`.

| field | value |
|---|---|
| `platform` | `celerant-coldfusion` |
| `adapterType` | `generic-retail` |

---

## Access — getting in safely

Every check came back green. Plain HTTP fetches with default UA work; no Playwright required.

| field | value | meaning |
|---|---|---|
| `hasWaf` | **`false`** | no WAF in front of the site |
| `wafType` | `null` | — |
| `wafLastProbedAt` | `2026-05-09T14:32:00Z` | when the 8-batch probe ran |
| `wafProbeMethod` | `heavy-8-batch` | which probe method |
| `hasCaptcha` | **`false`** | no reCAPTCHA / hCaptcha / Turnstile |
| `captchaType` | `null` | — |
| `ageGate.detected` | **`false`** | no interstitial age-confirmation gate |
| `userAgentOverride` | `null` | default desktop UA works |
| `needsPlaywright` | **`false`** | static HTML is enough |

> **Probe evidence** (`wafProbeEvidence`): all 8 batches returned 200 OK. No `cf-ray`, no `x-sucuri-id`, no Incapsula cookies, no Akamai server header, no MalCare body marker. Honeypot paths (`/wp-admin`, `/.env`, `/.git/config`) all return 200 — Celerant ignores path mismatches and serves its default page. SQLi-shaped and XSS-shaped queries didn't trip any rules. Verdict: high confidence no WAF.

---

## Catalog discovery — where the products are

**`catalogUrls`** — 8 URLs, one per top-level category. Each carries the canonical sort + per-page suffix that Celerant requires:

| Category | Products | URL |
|---|---:|---|
| Accessories | **1,181** | `/accessories/browse/orderby/new-arrivals/perpage/36` |
| Firearms | 540 | `/firearms/browse/orderby/new-arrivals/perpage/36` |
| Ammunition | 478 | `/ammunition/browse/orderby/new-arrivals/perpage/36` |
| Optics | 448 | `/optics/browse/orderby/new-arrivals/perpage/36` |
| Knives | 308 | `/knives/browse/orderby/new-arrivals/perpage/36` |
| Storage | 184 | `/storage/browse/orderby/new-arrivals/perpage/36` |
| Reloading | 175 | `/reloading/browse/orderby/new-arrivals/perpage/36` |
| Magazines | 147 | `/magazines/browse/orderby/new-arrivals/perpage/36` |

**`topLevelCategories.totalsSumCheck`:**

> Sum of per-category counts = **3,461**.
> Site's own `/all-products` count = **3,277**.
> Difference = **184** (≈ **5.6% cross-category overlap** — products tagged in two categories at once).
> After URL-based dedup, walking the 8 catalog URLs yields ~3,277 unique products.

**`extractionSample`** — 3 random products spot-checked, all 4 required fields populated:

| `title` | `price` | `stockStatus` |
|---|---:|---|
| Umarex HK MP5 .22LR Rifle | $749.99 | `in_stock` |
| Federal American Eagle 9mm 115gr FMJ — 50 Rounds | $24.99 | `in_stock` |
| Vortex Crossfire II 3-9x40 Riflescope | $299.00 | `out_of_stock` |

`extractionTested = true`.

---

## Pagination & sort — how to traverse

| field | value | meaning |
|---|---|---|
| `paginationPattern.type` | **`path`** | not `?page=N` query — uses URL path |
| `paginationPattern.template` | `/page/{N}` | how to construct page N |
| `paginationPattern.perPage` | **`36`** | products per page |
| `paginationPattern.firstPageHasParam` | `false` | page 1 = the catalog URL bare |
| `paginationPattern.startPage` | `1` | not zero-indexed |
| `paginationPattern.zeroIndexed` | `false` | — |
| `sortParam` | **`""`** *(empty string)* | path-baked sort — Celerant uses `/orderby/<value>/` in the path |
| `sortVerified` | **`true`** | proved honored via counter-control swap |

> **How sort was verified:** the skill swapped `/orderby/new-arrivals/` to `/orderby/name-asc/` on the same path. The first product changed from a recently-added Umarex MP5 to an alphabetically-first Derya rifle — proving Celerant honors the path-form sort. The empty-string `sortParam` is the canonical signal that sort lives in the path, not a query.

---

## Inventory size

| field | value |
|---|---|
| `expectedProductCount` | **`3277`** |
| `productCountMethod` | `celerant-perpage-all-option` |

> Read directly from the site: `<select id="perpage"><option value="3277">All</option></select>` on a canonical sorted catalog page. Celerant's authoritative storefront-visible count.

---

## Crawler config — runtime behavior

| Phase | field | value | what it means |
|---|---|---|---|
| **Tier 1 (new items)** | `crawlers.watermark.method` | **`navigate-from-watermark`** | paginate newest-first to find watermark, then walk back to index new products |
| **Maintain** | `crawlers.maintain.verifyMethod` | **`detail-page`** | each verify is a Playwright page fetch |
| Maintain | `crawlers.maintain.verifyEndpoint` | `null` | Celerant has no batch product API |

> `crawlers.watermark.reason`: *Path-baked sort verified via `/orderby/<value>/` swap counter-control. Default newest-first product (`umarex-hk-mp5-37218` on `/firearms`) differs from counter-control alpha-A-Z first product (`-derya--ria-tm22-37335`) — proves the path-form sort is honored. perPage=36 from canonical sorted catalog URL.*

---

## Platform extras

Both omitted — neither applies to a Celerant retailer:

| field | omitted because |
|---|---|
| `classifiedRules` | `adapterType` is not `classifieds-*` |
| `ecwidStoreId` | `platform` is not `ecwid-*` |

---

## Provenance

| field | value |
|---|---|
| `profileVersion` | `1` |
| `lastVerified` | `2026-05-09` |
| `auditNotes.runId` | `audit-2026-05-09T14-32-00Z` |
| `auditNotes.harnessVersion` | AI-driven, post-2026-04-27 pivot |
| `auditNotes.drivenByAIDirectly` | `true` |

**`auditNotes.fieldConfidence`** — every field's confidence level:

| field | confidence |
|---|---|
| `platform`, `hasWaf`, `hasCaptcha`, `ageGate` | verified |
| `expectedProductCount`, `productCountMethod` | verified |
| `catalogUrls`, `paginationPattern`, `extractionTested` | verified |
| `sortParam`, `watermarkMethod` | verified-via-counter-control |
| `maintainVerifyMethod` | derived-from-platform |

**`auditNotes.stageNotes`** — what happened at each of the 9 stages:

1. **Stage 1 (Canonical URL):** apex returned 200 cleanly; no `<link rel="canonical">` override → `canonicalOrigin = https://www.bullseyenorth.com`.
2. **Stage 2 (WAF + CAPTCHA):** 8/8 probe batches clean. No CAPTCHA markers in homepage HTML.
3. **Stage 3 (Platform):** identified Celerant from `Server: Null` header + `CFID`/`CFTOKEN` cookies + `.cfm` refs. No age-gate. Maintain `verifyMethod = detail-page` (not WooCommerce).
4. **Stage 4 (Catalog URLs):** 8 candidates from homepage nav after filtering `/all-products` aggregator and product-detail noise. Page-1 sample walk: each candidate contributed > 12% NEW unique → all kept.
5. **Stage 5 (Pagination):** tested `?page=N` (silently ignored) and `/page/N` (works). Zero-overlap confirmed page 1 vs page 2.
6. **Stage 6 (Sort):** `<select id="sortby">` exposed via path `/orderby/<value>/`. Counter-control swap (`new-arrivals` → `name-asc`) flipped first product. `sortParam=""` (path-baked).
7. **Stage 7 (Watermark method):** `navigate-from-watermark` — path-baked sort verified upstream, no date-filter API on Celerant.
8. **Stage 8 (Product count):** `<select id="perpage"><option value="3277">All</option>` on canonical sorted URL.
9. **Stage 9 (Assembly + validate):** validator passed 9/9 required + 7/7 recommended.
