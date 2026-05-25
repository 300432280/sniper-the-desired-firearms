# gotenda.com B4R2 Investigation

Run: 2026-05-19T22:30:00Z
Methodology: live probes via `backend/scripts/_tmp-gotenda-r2-probe.ts` + `_tmp-gotenda-r2-probe2.ts`. Sucuri solved once via headless Playwright, cookies reused across all axios probes. 800ms inter-request delay enforced.

## Verdict counts (9 divergent fields)

- R1 wins: 5 (`expectedProductCount`, `productCountMethod`, `perPage`, `catalogUrls`, `hasCaptcha`)
- DB wins: 3 (`sortParam`, `wafWorkaround`, `searchUrl`)
- Inconclusive: 1 (`paginationPattern` — both forms work)
- Both wrong: 0

## Field-by-field verdicts with evidence

### 1. `expectedProductCount` — R1 wins (16615)

R1's WHY: inventory grew. R2 method: query TWO independent surfaces.

| Surface | x-wp-total / count |
|---|---|
| `GET /wp-json/wc/store/v1/products?per_page=1` | **16615** (status 200) |
| `GET /wp-json/wp/v2/product?per_page=1` | **16615** (status 200) |
| Sitemap-index sum (17 sitemap files, summed `<loc>`) | **16616** (1-product drift) |

DB's 16,440 is 6 weeks stale; live count grew by 175.

### 2. `productCountMethod` — R1 wins (wp-rest-header)

R1's WHY: skill stage 8 prioritises 1-request surface. R2 method: run BOTH methods, compare counts AND request cost.

- `wp-rest-header`: 1 HTTP request → 16615 (matches Store API ground truth)
- `sitemap-index`: 17 HTTP requests (sitemap1 to sitemap17) → 16616
- Code: `product-count-probe.ts:189` (wp-rest-header switch case) and `:252` (sitemap-index). Both are valid switch arms.

DB's hardcoded list of 17 sitemap URLs is brittle: when the merchant adds product 16,616 → the sitemap index regenerates and the DB's `urls[]` could miss a `product-sitemap18.xml` file. wp-rest-header is invariant.

### 3. `perPage` — R1 wins (24)

R1's WHY: HTML default observed. R2 method (different): probe `?per_page=100` directly.

```
GET /shop/?per_page=24  -> status=200, li.product=24
GET /shop/?per_page=100 -> status=200, li.product=24   <- param ignored
```

WC's HTML archive caps at the theme-configured 24; `?per_page` is honored only by the JSON Store API (`woocommerce.ts:293` clamps API to `min(perPage??100, 100)`). For HTML-walked sites the runtime-correct value is 24. DB's `perPage:100` would cause page-count math to mis-compute total pages (16615/100=167 vs real 693).

### 4. `catalogUrls` — R1 wins (single `/shop/`)

R1's WHY: budget-skipped per-category walk. R2 method (different): walk EVERY candidate slug and read `lastPage` from pagination nav, plus check Store API category endpoint for ground truth.

```
DB slugs:
  /product-category/firearms/         status=404
  /product-category/ammunition/       status=404
  /product-category/optic/            status=200  li.product=24  lastPage=3
                                      canonical=/product-category/gun-deals-promotions-canada/may-specials/optic/
                                      (a PROMO sub-sub-category, not firearm optics)
  /product-category/knives/           status=404
  /product-category/accessories/      status=200  li.product=11  lastPage=1
  /product-category/reloading/        status=200  li.product=7   lastPage=1
  /product-category/hunting-outdoor/  status=200  li.product=7   lastPage=1
  /shop/                              status=200  li.product=24  lastPage=693

R1 live-taxonomy slugs:
  /product-category/firearms-canada/                               status=200  li.product=6  lastPage=1
  /product-category/ammunition-for-sale-in-canada-tenda-canada/    status=200  li.product=6  lastPage=1
  /product-category/gun-optics-canada/                             status=200  li.product=7  lastPage=1
  /product-category/knives-tools/                                  status=200  li.product=9  lastPage=1
```

Both DB and R1 category lists are MISLEADING. Every `/product-category/*` slug returns `lastPage=1` — they are CURATED LANDING PAGES with hero blocks of 6-11 products, NOT walkable category indexes. Production crawl of those URLs would index 6-11 products per category, not thousands.

Only `/shop/` is a real catalog index: lastPage=693 × perPage=24 = 16,632 ~ x-wp-total 16,615.

Bonus: Store API category endpoint `/wp-json/wc/store/v1/products/categories?per_page=100` returns only **1** top-level category (`accessories`), not the 15 that R1's `topLevelCategories` block claims. The 15-category list was likely scraped from menu HTML; those `count` values aggregate through nested sub-categories and do not correspond to walkable URLs.

R1's collapse to `/shop/` is the correct call.

### 5. `paginationPattern` — Inconclusive (both forms identical)

R1's WHY: zero-overlap test confirmed both work. R2 method (different): fetch page-1, `?paged=2`, and `/page/2/`; compare slug sets directly.

```
page1 (24 slugs):     consignment-adler-rf-224..., consignment-akdas-alcor-223..., proof-research-elevation-tfde...
?paged=2 (24 slugs):  cz-457-at-one-varmint..., cz-457-varmint-precision-trainer..., cz-600-mdt-6mm-creedmoor...
/page/2/ (24 slugs):  cz-457-at-one-varmint..., cz-457-varmint-precision-trainer..., cz-600-mdt-6mm-creedmoor...

overlap (?paged=2 vs page1) = 0
overlap (/page/2/ vs page1) = 0
overlap (?paged=2 vs /page/2/) = 24/24 (identical sets)
```

Both forms semantically identical. DB's note "?page=N silently ignored" refers to the WP `?page=` query var (single-post pagination); `?paged=` is the WC archive pagination var, which IS honored. Keep DB path-style `/page/{N}` for theme-override safety (no functional difference today).

### 6. `sortParam` — DB wins (`?orderby=date&order=desc`)

R1: `?orderby=date`. DB: `?orderby=date&order=desc`. Both produce identical page-1 (WC defaults `order=desc`). DB's explicit `&order=desc` is theme-override-safe. Adopted DB form.

### 7. `hasCaptcha` — R1 wins (false)

R1's WHY: skill operational rule. R2 method: confirm catalog reachable without solving captcha. Yes — the headless Playwright session solved Sucuri JS challenge but never encountered any captcha gate; all 70+ subsequent requests succeeded with just the Sucuri cookies. recaptcha-v3 is purely a passive risk-score telemetry that never blocks read paths. `hasCaptcha=false` per operational rule.

### 8. `wafWorkaround` — DB wins (restored)

R1 omitted; skill reserves the `wafWorkaround` field for malformed-header curl-spawn fallback. But the production code at `product-count-probe.ts:172-180` and `woocommerce.ts:300-310` consults `siteProfile.wafWorkaround` to drive the cookie-cache flow. Operator residue, but production-needed. Restored DB value.

### 9. `searchUrl` — DB wins (restored)

R1 omitted (skill makes optional). DB value `/?s={keyword}&post_type=product` is the canonical WP search URL. Not live-tested but uncontroversial. Restored.

## Top 3 verdicts (1-line evidence each)

1. **catalogUrls = R1 wins** — DB has 3 slugs returning 404 (firearms, ammunition, knives) + 4 lastPage=1 landing pages; ONLY `/shop/` (lastPage=693) is a real walkable catalog.
2. **perPage = R1 wins** — `GET /shop/?per_page=100` returns 24 `li.product` (same as `?per_page=24`); WC HTML archive ignores the param. DB's 100 would break HTML page-count math.
3. **expectedProductCount = R1 wins** — TWO independent surfaces (`store/v1/products` and `wp/v2/product`) both return `x-wp-total: 16615`; sitemap-walk confirms 16,616 (1-drift). DB's 16,440 is 6 weeks stale.

## Blockers

None. Site is fully crawlable; B4R2 profile is promotable after operator restores tier-scheduling / dataFlow fields and re-confirms Sucuri verdict from production crawler IP.

## Probe scripts

- `backend/scripts/_tmp-gotenda-r2-probe.ts` — catalog slug / perPage / count / pagination overlap tests
- `backend/scripts/_tmp-gotenda-r2-probe2.ts` — Store API category list + per-slug lastPage probe

Both are scratch files, to be deleted at session cleanup.
