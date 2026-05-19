# R3 Adversarial Counter — fishingworldgc.ca

**Probe time:** 2026-05-15T12:35-12:50Z
**R2 under review:** `docs/site-audit/fishingworldgc.ca-2026-05-15T09-21-18Z-R2-corrections.json`
**Prior R3 also reviewed:** `docs/site-audit/fishingworldgc.ca-2026-05-13T09-09-35Z-R3-counter.md` (2-day-old, different timestamp series)
**Method:** Fresh skeptic. Different probes than R2. NO DB writes. 500-800ms delay. Inconclusive > fabricated.

---

## Summary

- Corrections attempted: 8
- Counter-claims: 0
- All 8 survived. R2's verdict holds.
- Prior R3 (2026-05-13) also reviewed; no contradiction.

---

## REQUIRED verifications

### A. perPage method comparison (R1 slug-regex vs R2 div-class) — REQUIRED

Fresh fetch of `/collections/all?page=1` (HTTP 200, 430,436 bytes). Counted three different ways:

| Method | Count | Notes |
|---|---:|---|
| `<div class="product-card product-card-wrapper ">` (in-stock cards) | 19 | R2's "strict wrapper" — but missed sold-out variant |
| `<div class="product-card product-card-wrapper  item--sold-out">` | 5 | sold-out variant of same wrapper |
| **Total product-card wrappers (in-stock + sold-out)** | **24** | matches R2's 24, fully accounts for both |
| `<div class="product-card__image-with-placeholder-wrapper">` (1 per card) | 24 | second independent confirmation |
| `href="/collections/<x>/products/<slug>"` distinct | 24 | third confirmation |
| ANY `/products/<slug>` substring (R1's regex) | 34 | inflated by header search forms / cross-collection refs / OG tags |
| Footer `<span class="filters-toolbar__product-count">` literal | **1992 products** | full-site total |

**Master walk via `/products.json`?limit=250&page=1..8 = exactly 1992 unique handles.**
**`/collections/all` HTML walk pages 1..84 = exactly 1992 unique handles** (84th page empty; per-page handle count 24 on every one of pages 1-83).

1992 / 24 = exactly 83 pages. R2's perPage=24 is correct. R1's 34 came from regex bleeding into header/footer/related-product `/products/` tokens. **No counter.**

### B. /collections/all coverage on 3 NEW sub-collections — REQUIRED

R2 walked: all-guns, all-ammo-1, shooting-miscellaneous-1, hunting-accessories, magazines-1.
R3 walked 3 **different** sub-collections via `/collections/<h>/products.json?limit=250`:

| Sub-collection | products_count (collections.json) | Walked unique handles | In master /products.json? | In /collections/all HTML walk? |
|---|---:|---:|:---:|:---:|
| 12ga-1 | 226 | 95 | 95/95 | **95/95** |
| rings-mounts | 164 | 119 | 119/119 | **119/119** |
| scopes-1 | 139 | 91 | 91/91 | **91/91** |

Union: **305 handles. ZERO outside `/collections/all`.**

Note: per-collection `/products.json` caps at 250 per page but only returns page 1 worth of items (sub-collection-level cap exposes only 95-119 even when product count reports 139-226). This is a known Shopify quirk and re-confirms R2's "sub-collection HTML pagination is soft-capped" side-note. The cap does NOT affect `/collections/all`, which reached all 1992. **No counter on catalogUrls=['/collections/all'].**

### C. `verifyMethod` runtime path: 'detail-page' vs 'json-ld' — REQUIRED

Read `worker.ts:381-400` and `worker.ts:759-775`:

- **Line 397** (literal): `if (!maintainConfig || maintainConfig.verifyMethod !== 'store-api') return null;`
- **Line 763**: `const verifyMethod = entry?.siteProfile?.crawlers?.maintain?.verifyMethod;`
- **Line 764**: `if (!verifyMethod) { ...skip... return; }` — **truthy check only.**
- **Line 768**: `// verifyMethod === 'detail-page' — visit each product URL via Playwright` — **this is a COMMENT, not a check.**
- **Line 769**: `verifyProductsViaPlaywright(...)` — called unconditionally for any truthy non-'store-api' value.

**Verdict:** `'detail-page'` and `'json-ld'` route to the IDENTICAL Playwright path today. There is no runtime branch on the label. R2's claim that "`'detail-page'` is the documented canonical" is supportable (comment-based), but R2 marked this "high confidence" R1-wins; honest framing is **label-canonical, zero runtime impact, low operational urgency**. Prior R3 (2026-05-13) flagged this same nuance ("framing tightened"). **No counter on direction; mild reframing on severity — same as prior R3.**

---

## Per-correction verdicts

1. `paginationPattern.perPage = 24` — SURVIVED. 24 wrappers/page on every one of 83 pages.
2. `perPage (top-level) = 250` — SURVIVED. `product-count-probe.ts:276` literal `m.perPage || 250` confirmed; runtime walk endpoint = `/products.json`.
3. `catalogUrls = ['/collections/all']` — SURVIVED. 3 new sub-collections, 305 handles, zero outside.
4. `hasWaf = false` — SURVIVED (not re-probed; R2 + prior R3 agreed via independent methods).
5. `expectedProductCount = 1992` — SURVIVED. Master /products.json walk = 1992; /collections/all HTML walk = 1992; footer literal = "1992 products". Triple agreement.
6. `productCountMethod.method = shopify-products-walk` — SURVIVED. `product-count-probe.ts:69` type literal + `:272` switch case both spell it `shopify-products-walk`. DB's `products-json-walk` has no case arm => falls to default => null.
7. `crawlers.maintain.verifyMethod = detail-page` — SURVIVED with severity reframing (see C above). Same runtime path as `json-ld`.
8. `productCountMethod.endpoint = /products.json` — SURVIVED. `product-count-probe.ts:275` default.

---

## Strongest counter-claims (none load-bearing)

- **#7 verifyMethod severity:** R2 said "high confidence" R1-wins, but both `'detail-page'` and `'json-ld'` reach the same Playwright function via the truthy-only check at `worker.ts:764`. The "win" is label-canonical (matches the comment on line 768), not a bug fix. This is the same softening prior R3 (2026-05-13) recommended.
- **Open question on 5-product gap (R2 said /collections/all = 1987):** With my href-based extraction (`/collections/all/products/<handle>`), `/collections/all` walk = **1992** (matches master). R2's count of 1987 likely used a different extractor that missed 5 edge cases. Not a counter to any correction — the 1992 figure is now confirmed by THREE independent methods. R2's open-question paragraph is partly obsolete: there is no 5-product real gap; it's an extraction-method gap.

---

## Code reads (verbatim line refs)

- `backend/src/services/product-count-probe.ts:69` — `method: 'shopify-products-walk';` (type)
- `backend/src/services/product-count-probe.ts:272` — `case 'shopify-products-walk': {`
- `backend/src/services/product-count-probe.ts:275-276` — `endpoint || '/products.json'`; `m.perPage || 250`
- `backend/src/services/worker.ts:397` — `if (!maintainConfig || maintainConfig.verifyMethod !== 'store-api') return null;`
- `backend/src/services/worker.ts:763-764` — `const verifyMethod = entry?...verifyMethod; if (!verifyMethod) return;`
- `backend/src/services/worker.ts:768` — comment-only; `:769` calls Playwright

---

## Files

- `_audit_tmp/r3-2/all-page1.html` — fresh /collections/all?page=1 (430,436 bytes)
- `_audit_tmp/r3-2/ca-{1..84}.html` — full /collections/all HTML walk (1992 handles)
- `_audit_tmp/r3-2/pj-{1..8}.json` — master /products.json walk (1992 handles)
- `_audit_tmp/r3-2/sub-{12ga-1,rings-mounts,scopes-1}-{1..5}.json` — 3 NEW sub-collection walks
- `_audit_tmp/r3-2/cols.json` — collections inventory (250 collections)
