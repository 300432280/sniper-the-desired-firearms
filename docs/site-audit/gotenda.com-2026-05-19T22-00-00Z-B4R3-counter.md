# gotenda.com B4R3 Counter

Run: 2026-05-19T22:00:00Z
Method: Live Playwright (Sucuri-solved cookies) + axios reuse via `_tmp-gotenda-r3-probe.ts` and `_tmp-gotenda-r3-probe2.ts`. 800ms delay enforced.

## Counter-claim counts (9 R2 verdicts)

- COUNTERED: **1** (`catalogUrls` — R2 wrongly collapsed to `/shop/`)
- Couldn't disprove: **8** (`expectedProductCount`, `productCountMethod`, `perPage`, `paginationPattern`, `sortParam`, `hasCaptcha`, `wafWorkaround`, `searchUrl`)

## Top counter: catalogUrls — R2 IS WRONG

R2 said: "Every `/product-category/` slug returns `lastPage=1` — curated landing pages; only `/shop/` is walkable; Store API returns only 1 top-level category (accessories)."

R3 disproves on three independent axes:

**1. Page 1 vs page 2 of a category are different layouts.** R2 read `lastPage` from page 1 only, where the theme displays a 6-card hero block with no pagination nav. Page 2 onward is a standard 24-per-page archive with full pagination.

```
GET /product-category/firearms-canada/         status=200 cards=6  lastPage=null
GET /product-category/firearms-canada/page/2/  status=200 cards=24 lastPage=167
   showResults="Showing 25-48 of 3997 results"
GET /product-category/firearms-canada/page/10/ status=200 cards=24 lastPage=167
   showResults="Showing 217-240 of 3997 results"
```

Zero overlap between page 1 and page 2 → page 1 is NOT a "curated landing page that replaces the catalog index" — it's the theme's hero treatment for page 1 only.

**2. Store API confirms 8 real top-level categories with non-trivial counts.**
R2's claim "only 1 top-level category (accessories)" came from a single page-1 fetch of `/wp-json/wc/store/v1/products/categories?per_page=100` which has 172 total entries across 2 pages. Walking page 2 reveals the rest:

```
x-wp-total=172 x-wp-totalpages=2
parent=0 (top-level):
  firearms-canada                              count=3997
  accessories                                  count=3344
  ammunition-for-sale-in-canada-tenda-canada   count=2288
  gun-optics-canada                            count=2255
  knives-tools                                 count=1529
  gun-deals-promotions-canada                  count=1475  (promo, exclude)
  reloading                                    count=1426
  hunting-outdoor                              count=1075
  tenda-alpha                                  count=596   (sub-brand, optional)
  tenda-strike                                 count=403   (sub-brand, optional)
```

Sum of 8 buyable top-level categories ~= 15,913, vs `x-wp-total=16615` → adds up with some products in multiple categories.

**3. DB slugs `/firearms/`, `/ammunition/`, `/knives/` are genuine 404s** (re-verified with desktop Chrome UA, iPhone UA + `?paged=2`) — so the DB slug LIST is stale, but the DB DESIGN (per-category catalogUrls) is correct. R1's slugs are the live ones.

**Net counter:** R2's collapse to single `/shop/` works but throws away real per-category structure. Production catalog should be **8 R1-style slugs** (`firearms-canada`, `accessories`, `ammunition-for-sale-in-canada-tenda-canada`, `gun-optics-canada`, `knives-tools`, `reloading`, `hunting-outdoor`, plus `/shop/` as safety net), each starting at `/page/2/` or treating page 1 as hero. R2's `topLevelCategories` block lists only 1 entry — should be 8.

## Couldn't disprove

- **expectedProductCount=16615**: 3 independent surfaces agree (store/v1, wp/v2/product, sitemap-index 16,616). Two store/v1 fetches were stable.
- **productCountMethod=wp-rest-header**: 1 HTTP request vs 17 for sitemap-index; both agree.
- **perPage=24** for HTML: `?per_page=24`, `=48`, `=100`, `?count=48`, `?show=48` ALL return 24 `li.product`. Theme caps HTML output regardless of querystring. R2 correct. (Note: API `perPage` is separately clamped to 100 in `woocommerce.ts:293` — these are distinct values; a single `perPage` field is ambiguous.)
- **paginationPattern**: `/shop/page/693/` returns 7 cards (last page) and `/page/694/` returns 404 → path-style works.
- **sortParam, hasCaptcha, wafWorkaround, searchUrl**: not retested; R2 evidence stands.

## Top 3 counters (1 line each)

1. **catalogUrls=[`/shop/`] is wrong** — `/product-category/firearms-canada/page/2/` returns 24 cards, lastPage=167, "3997 results". R2 read page-1 hero block only.
2. **`topLevelCategories` lists 1 category, should list 8** — Store API `/wp-json/wc/store/v1/products/categories` has 172 entries across 2 pages; R2 fetched only page 1.
3. **DB slugs `/firearms/`, `/ammunition/`, `/knives/` are stale 404s** (not WAF-gated) — true; R1's `-canada` / `-tools` / `-tenda-canada` suffixes are the live taxonomy. R1 was right.

## Untested R2 claims

- Sucuri "Playwright bypasses cleanly" — accepted; my probe solved on first navigation.
- `crawlers.watermark.method=api-date-since-watermark` — not retested.
- `verifyMethod=store-api` operational implications — not retested.

## Scratch files (delete at cleanup)

- `backend/scripts/_tmp-gotenda-r3-probe.ts`
- `backend/scripts/_tmp-gotenda-r3-probe2.ts`
