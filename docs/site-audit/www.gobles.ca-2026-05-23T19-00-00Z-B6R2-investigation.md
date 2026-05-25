# B6R2 investigation — www.gobles.ca (LIVE)

Run: 2026-05-25T03:28Z. Persona: `testing-api-tester`. Inputs: R1 diff + R1 candidate + DB snapshot. Method: live HTTP with production `extractCatalogProducts` selector list (cheerio replication of `generic-retail.ts:931-967`). 22 GETs total + 13 supplementary GETs. 800ms delay. CF-RAY captured on every response.

## TL;DR

R1 was right on 6 fields (`hasWaf=false`, `wafType=cloudflare-passive`, `productCountMethod=generic-product-sitemap`, `expectedProductCount=3770`, `perPage=100`, `sortParam=?sort=newest`). DB is wrong on the same 6 PLUS its **catalogUrls 9-URL parent spine is structurally broken at runtime** — both `/firearms/` and `/knives/` parents return ZERO product cards via production extractor. R1's 74-URL leaf spine is closer but still has 4 zero-yield non-leaf containers; R2 recommends a refined 90-URL spine (74 - 4 zero-yield + 20 sub-action leaves).

## 1. catalogUrls — load-bearing investigation

### Test 1: `/firearms/` parent across 5 variants

| URL | bytes | products extracted | selector hits |
|---|---|---|---|
| `/firearms/` | 136855 | 0 | none |
| `/firearms/?sort=newest` | 136871 | 0 | none |
| `/firearms/?limit=100` | 136869 | 0 | none |
| `/firearms/?sort=newest&limit=100` | 136885 | 0 | none |
| `/firearms/page1.html?sort=newest` | 136881 | 0 | none |

All 5 variants returned 200 OK with full-body HTML and ZERO product cards via the full production SELECTORS list (`.product-element`, `.productborder`, `.product-thumb`, `.product-layout`, `[data-product-id]`, `li[class*="product"]`, etc.). The HTML contains 57 category-tile class instances and 0 product-card markers. This is by site design — `/firearms/` is a category landing page that links to brand/type subcategories, not products.

### Test 2: control extractions prove the selector logic is correct

| URL | bytes | products |
|---|---|---|
| `/ammunition/?limit=100` | 723016 | 100 |
| `/optics/?limit=100` | 713446 | 100 |
| `/reloading/?limit=100` | 680552 | 100 |
| `/firearms/winchester/?sort=newest` | 211578 | 17 |
| `/firearms/centerfire-rifles/bolt-action/?limit=100` | 734457 | 100 |

All extract via `.product-element` selector (LightSpeed Developer/custom theme — line 949 in `generic-retail.ts`). Confirms the selector + the extraction logic are correct.

### Test 3: R1's 74-URL list spot-check (13 representative URLs)

| URL | products |
|---|---|
| `/firearms/centerfire-rifles/?limit=100` | **0** (zero-yield, has sub-actions) |
| `/firearms/lever-action/?limit=100` | 29 (leaf, OK) |
| `/firearms/shotguns/?limit=100` | **0** (zero-yield, has sub-actions) |
| `/firearms/rimfire-rifles/?limit=100` | **0** (zero-yield, has sub-actions) |
| `/firearms/muzzleloading-rifles/?limit=100` | 14 (leaf, OK) |
| `/knives/buck/?limit=100` | 29 (leaf, OK) |
| `/knives/leatherman/?limit=100` | **0** (likely stock-out, not structure) |
| `/knives/victorinox/?limit=100` | 11 (leaf, OK) |
| `/optics/?limit=100` | 100 (leaf, OK) |
| `/reloading/?limit=100` | 100 (leaf, OK) |
| `/firearms/ruger/?limit=100` | 16 (leaf, OK) |
| `/firearms/savage-stevens/?limit=100` | 69 (leaf, OK) |
| `/firearms/centerfire-rifles/bolt-action/?limit=100` | 100 (sub-leaf, NOT in R1's 74) |

R1's list has **4 confirmed structural zero-yield entries** (centerfire-rifles, shotguns, rimfire-rifles, combination) AND is MISSING the 20 sub-action leaves they should be replaced with (saved /firearms/ HTML enumerates: bolt-action / break-action / falling-block / lever-action / pump-action / semi-auto under centerfire-rifles and rimfire-rifles, plus action types under shotguns and combination).

### Verdict

**Refined spine: R2 = R1 (74) - 4 zero-yield + 20 sub-action leaves = 90 URLs.** R3 must verify all 90 yield non-zero counts and dedup union >= 3770 * 0.95.

**Critical: DB's 9-URL spine puts /firearms/ and /knives/ as catalogUrls. Both return 0 at runtime → ~596 products (16.7%) silently invisible to bootstrap/maintain crawlers.** The `categoryStats./firearms/.products: 452` number in DB is either stale or comes from a walker mechanism not represented by the URL endpoint shipped in catalogUrls — either way it's misleading; the URL itself produces zero.

## 2. hasWaf — DB column flip required

DB has `hasWaf:true` + `wafType:cloudflare-passive` — the exact B10-invalid combination. R1's verdict: split into operational `hasWaf:false` + informational `wafType:cloudflare-passive`. R2 confirms via 22 consecutive 200-OK requests with CF-RAY present, no challenges, no honeypot 403s during walk (honeypot 403s from R1's heavy probe were rule-selective on `/wp-login.php`, `/xmlrpc.php`, `/.env`, `/.git/config`, `/phpinfo.php` — NOT on legitimate catalog/product pages).

CF-RAY timeline for 10-page sustained walk on `/ammunition/`:
```
p1=200/a0117351b8d0abca
p2=200/a0117358be01abca
p3=200/a011735f8b50abca
p4=200/a01173666869abca
p5=200/a011736d6daeabca
p6=200/a01173742ab0abca
p7=200/a011737b7fc8abca
p8=200/a01173827dc9abca
p9=200/a01173896aa7abca
p10=200/a011739088c8abca
```

Monotonic, no challenges, no blocks. R1's verdict stands; DB column flip required.

## 3. productCountMethod — DB shape broken

DB ships `productCountMethod.method: "category-page-walk"`. Cross-reference against `product-count-probe.ts:110-117`:

```
VALID_METHOD_NAMES = [
  'wp-rest-header', 'json-api-count', 'json-api-length',
  'html-pagination', 'sitemap', 'sitemap-index',
  'generic-product-sitemap', 'ecwid-storefront-search',
  'shopify-products-walk', 'bigcommerce-graphql-count',
  'woocommerce-store-api-count',
]
```

`category-page-walk` is NOT in the list. With current `validateMethod()` at L140-170, the profile would THROW on probe attempt — silently disabled before that validator was added (B6 violation). R1's canonical `generic-product-sitemap` + `\\.html$` pattern matches the runtime switch at L313-335 (extracts `<loc>...</loc>` then filters by regex). Local sitemap copy: 6383 total `<loc>`, 3770 matching `.html` = R1's `expectedProductCount: 3770`.

## 4. expectedProductCount

DB: 3577. R1: 3770. Drift: +193 (+5.4%). Sitemap is authoritative AND matches the runtime productCountMethod path. DB's own note acknowledges 1% OOS/hidden delta — sitemap is the inclusive surface aligned with `detail-page` verifyMethod (which can confirm OOS/restock on URLs that disappear from category walks). **R1 verdict accepted.**

## 5. perPage

`?limit=100` confirmed honored on 4 distinct categories returning exactly 100 cards (where stock allows). DB ships 24 (page-1 default) = 4x request waste. **R1 verdict accepted.**

## 6. searchUrl

B3 junk-keyword diff:
- `/search?q=zzqqxxnonexistent12345` → 0 products + noResultsCopy true
- `/search?q=glock` → 6 products + noResultsCopy true (template boilerplate matches even on hits)

Pattern works. Production scrapers must count products, not detect copy. **DB value `/search?q={keyword}` accepted.**

## Verdict counts

- **R1 verdicts supported as-is**: 6 (hasWaf, wafType, productCountMethod.method, expectedProductCount, perPage, sortParam)
- **R1 verdicts refined**: 1 (catalogUrls: 74 -> 90)
- **R1 verdicts rejected**: 0
- **DB verdicts refuted**: 4 substantive (hasWaf, productCountMethod, catalogUrls, perPage)
- **DB column flips needed**: hasWaf true->false

## Top 3 evidence-backed findings

1. **DB catalogUrls 9-parent spine is RUNTIME-BROKEN.** `/firearms/` and `/knives/` both return 0 product cards via production SELECTORS across 5 URL variants. `categoryStats./firearms/.products: 452` in DB is misleading — the URL itself produces zero. Promotion of refined leaf spine is load-bearing for catalog completeness (~16.7% recovery).
2. **R1's 74-URL list has 4 zero-yield non-leaf containers** (centerfire-rifles, shotguns, rimfire-rifles, combination) and is missing 20 sub-action leaves that ARE non-empty. R2 spine = 90 URLs.
3. **`category-page-walk` is not a runtime-recognized productCountMethod.** Either throws (post-validator) or silently disables count probe (pre-validator). B6 violation in DB. R1's `generic-product-sitemap` shape matches the runtime switch at `product-count-probe.ts:313-335` and counts exactly 3770 `.html` <loc> entries.

## Blockers for R3

None. R3 must: walk all 90 R2 URLs, dedup union, confirm coverage >= 95% vs sitemap 3770, and attack the assumption that sitemap is the right inclusive surface (could variant URLs inflate it? — Lightspeed uses one `.html` per product so this is unlikely).

## Files referenced

- Probe scripts: `_audit_tmp/batch6-2026-05-23/gobles-r2-probe.ts`, `_audit_tmp/batch6-2026-05-23/gobles-r2-probe2.ts`
- Probe results: `_audit_tmp/batch6-2026-05-23/gobles-r2-probe-results.json`, `_audit_tmp/batch6-2026-05-23/gobles-r2-probe2-results.json`
- Production extractor: `backend/src/services/scraper/adapters/generic-retail.ts:931-967` (SELECTORS) + `:949` (`.product-element` for LightSpeed Developer theme)
- Production count probe: `backend/src/services/product-count-probe.ts:110-117` (VALID_METHOD_NAMES), `:313-335` (generic-product-sitemap switch)
- Saved HTML: `_audit_tmp/batch6-2026-05-23/gobles-firearms.html` (zero product cards, 57 subcat tiles), `_audit_tmp/batch6-2026-05-23/gobles-ammo.html` (24 `.product-element` cards confirmed)
