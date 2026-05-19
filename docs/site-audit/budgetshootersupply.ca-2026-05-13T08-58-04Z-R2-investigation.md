# R2 Investigation — budgetshootersupply.ca

**Audited:** 2026-05-13T08:58:04Z  **vs R1:** 2026-05-13T04-29-21Z-R1  **vs DB:** 2026-04-11 lastVerified

---

## Investigation method summary

| Field | R1 method | R2 cross-check method (different) |
|---|---|---|
| expectedProductCount | Store API x-wp-total | Live WP REST + Store API + compare to DB stored value |
| productCountMethod | SKILL.md priority order | Runtime woocommerce.ts source read |
| apiDateFilter | absent | Live 2-pair probe (after vs modified_after at past/future + 7d/30d) + runtime grep |
| catalogUrls | enumerate top-level taxonomy | Live extraction test via WooCommerceAdapter on each URL class |
| htmlCrawlViable | implicit true | Run real adapter against /products/ + parent-tile + leaf cat |
| paginationPattern | observed /page/N/ | Runtime buildPaginatedUrl source read - verify api-page handler exists |
| sortVerifiedMethod | HTML 3-outcome counter-control | Live API id-jump on per_page=100 page 1/2 |
| WP REST vs Store API recursion | unconfirmed | Two live header probes on Ammunition cat 162 |

---

## Field 1: expectedProductCount

R1: 1586 (Store API). DB: 2756 (2026-04-11).

Live probe (2026-05-13 08:44Z):

```
$ curl -sI 'https://budgetshootersupply.ca/wp-json/wp/v2/product?per_page=1'
HTTP/1.1 200 OK
X-WP-Total: 2808

$ curl -sI 'https://budgetshootersupply.ca/wp-json/wc/store/v1/products?per_page=1'
HTTP/1.1 200 OK
X-WP-Total: 1586
```

Verdict: 2808 (live, third truth). DB stale by ~52. R1 chose narrower customer-visible count. Runtime woocommerce.ts:340 discovers via WP REST, so broader count is correct ground truth for coverage gate.

Confidence: high.

---

## Field 2: apiDateFilter - ?after= vs ?modified_after= (REQUIRED TEST)

R1: absent (only mentions ?after= in a free-text reason string). DB: `{param: "modified_after", format: "ISO8601", monotonic: true}`.

Live cross-check (2026-05-13):

```
?after=2099-01-01T00:00:00            -> x-wp-total: 0     (filter honored)
?after=1999-01-01T00:00:00            -> x-wp-total: 2808  (full backlog)
?modified_after=2099-01-01T00:00:00   -> x-wp-total: 0     (filter honored)
?modified_after=1999-01-01T00:00:00   -> x-wp-total: 2808  (full backlog)

Realistic windows (the watermark crawler's actual use case):
?after=2026-05-06T08:45:28            -> x-wp-total: 7     (NEW products in 7d)
?modified_after=2026-05-06T08:45:28   -> x-wp-total: 311   (NEW + UPDATED in 7d)

?after=2026-04-13T08:45:28            -> x-wp-total: 42    (NEW in 30d)
?modified_after=2026-04-13T08:45:28   -> x-wp-total: 821   (NEW + UPDATED in 30d)
```

44x difference at 7d. 20x at 30d. modified_after captures restocks, price changes, and any product modification - the exact events back-in-stock alerts care about.

Runtime binding (canonical source of truth):

```ts
// backend/src/services/scraper/adapters/woocommerce.ts:337
if (options?.dateAfter) params.modified_after = options.dateAfter;
```

The runtime hardcodes modified_after. Whatever value the profile stores in apiDateFilter.param is descriptive metadata; for the profile to be self-consistent with runtime, it MUST say modified_after.

Verdict: DB correct, R1 missed. Required shape:

```json
{"param":"modified_after","format":"ISO8601","monotonic":true,
 "evidence":"?modified_after=last-7d -> 311 products vs ?after=last-7d -> 7 products"}
```

SKILL.md harness gap: Stage 7 (.claude/skills/pre-bootstrap/SKILL.md lines 611, 652) probes only ?after=. For WooCommerce, must probe BOTH and prefer modified_after.

Confidence: high.

---

## Field 3: catalogUrls - WC Store API vs WP REST recursion (REQUIRED TEST)

R1: 22 /product-category/<slug>/ URLs. DB: ["/products/"] + htmlCrawlViable=false + note "WP REST product_cat does NOT recurse into children".

Live recursion test on Ammunition (cat 162, has 12 sub-cats):

```
GET /wp-json/wp/v2/product?per_page=1&product_cat=162
  -> X-WP-Total: 5     (direct-assigned only)

GET /wp-json/wc/store/v1/products?per_page=1&category=162
  -> X-WP-Total: 98    (recurses into 12 children)

Sub-cat list (parent=162):
  10-gauge-shotgun-slug-ammo (0), 12-gauge-blanks (1), 12-gauge-buckshot-ammo (4),
  12-gauge-shotgun-slug-ammo (1), 12-gauge-shotshell-ammo (2), 20-guage-shotgun-ammo (2),
  28-guage-shotgun-ammo (1), 410-gauge-shotgun-ammo (9), Centerfire Pistol (23),
  Centerfire Rifle (49), Rimfire (6), Surplus (0)  -> sum 98
```

Verdict: DB recursion observation 100% correct. 19.6x coverage gap. If anyone replaces R1's HTML walk with a per-category WP REST ?product_cat=N API crawl, coverage silently collapses 95%.

Live extraction test (real WooCommerceAdapter.extractCatalogProducts):

```
URL: /product-category/ammunition/page/2/         -> 12 products extracted (real grid)
URL: /product-category/ammunition/                -> 0  products extracted (parent-tile, wd-with-subcat)
URL: /products/                                   -> 0  products extracted (AJAX shop, sidebar only)

Walk: /product-category/pal-ups/ page 1..18:
  p1=12, p2=12, ..., p10=14, ..., p18=9, p19=404
  Total ~225 products  (WC Store API count for pal-ups = 213; ~12 sidebar collisions)
```

Parent-tile category list (wd-with-subcat detected on page 1):

- ammunition
- bullet-casting-loading-tools-components-categories
- rifle-pistol-reloading-components
- rifle-pistol-reloading-tools-lubes
- shotshell-reloading-components

These 5 of 22 categories yield 0 products on page 1 but render real grid from page 2 onward. The catalog-crawler Playwright fallback at catalog-crawler.ts:435 handles page-1 emptiness when html.length > 5000 and products.length === 0.

Runtime grep:

```
$ grep -r htmlCrawlViable backend/src    # 0 matches
$ grep -r htmlFallback backend/src       # 0 matches
$ grep -r 'crawlers\.bootstrap' backend/src/services    # 0 matches
```

DB htmlCrawlViable=false is documentation-only - the runtime walks catalogUrls via HTML regardless. So DB ["/products/"] produces 0 products forever at catalog-crawler runtime.

Verdict: R1's 22 URLs is correct runtime catalog spine. DB's single URL is broken for catalog-crawler. Both R1 and DB miss the parent-tile-quirk note in htmlCrawlNote.

Confidence: high.

---

## Field 4: paginationPattern

R1: `{type: 'path', template: '/page/{N}/'}`. DB: `{type: 'api-page', template: 'page={N}'}`.

Runtime source (buildPaginatedUrl in catalog-crawler.ts:118-165):

- Handles 'query', 'path', 'offset-query', 'suffix-replace'.
- No 'api-page' branch - falls through to default 'query' style.
- DB config type=api-page + template=page={N} produces /products/?page=2 (wrong: WC uses /page/N/ path segment).

profile-validator.ts:15 lists 'api-page' as a valid type, but it's a schema check, not a runtime handler. Validator says yes, runtime says fall-through.

Live HTML pagination markup:

```
<a class="page-numbers" href="https://budgetshootersupply.ca/product-category/ammunition/page/3/">3</a>
```

Verdict: R1 correct (path/{N}/). DB choice passes validation but executes wrong shape.

Confidence: high.

---

## Field 5: sortVerifiedMethod

R1: absent / HTML 3-outcome counter-control. DB: api-id-jump + evidence.

Live re-verification:

```
WP REST per_page=100, orderby=date, order=desc:
  page 1: first id=97796 (date 2026-05-07) ... last id=95713 (date 2026-03-05)
  page 2: first id=95706 (date 2026-03-05)
  Monotonically descending across page boundary.
```

DB stored evidence (page1 first=96950, page2 first=94725) was correct for 2026-04-11 snapshot; numbers shifted with new product additions, pattern preserved.

Verdict: DB's api-id-jump is canonical evidence for a WC site. R1's HTML 3-outcome is weaker.

Confidence: high.

---

## Field 6: productCountMethod endpoint

R1: /wp-json/wc/store/v1/products (Store API, 1586). DB: /wp-json/wp/v2/product (WP REST, 2808).

Reasoning:

1. Coverage gate alignment. Runtime woocommerce.ts:340 calls /wp-json/wp/v2/product for both discovery and watermark. If count source is Store API (1586) and DB will only ever hold customer-visible products via the catalog walk, ratio is fine; but if any backfill ever indexes from WP REST, ratio drops to 1586/2808 = 0.56 and coverage gate fails forever.
2. Back-in-stock alerts. Store API hides OOS = 1222 hidden products. Back-in-stock alerts MUST exist on the 1222 hidden products, so they belong in expectedProductCount.

Verdict: DB correct (WP REST). R1's choice silently drops 1222 products from the coverage population.

Confidence: high.

---

## Field 7: theme (top-level field)

R1: only inside auditNotes.platformFingerprints. DB: top-level theme=woodmart.

SKILL.md treats theme as a discrete profile field (Mistake 39 added 2026-04-26: theme is not platform - theme affects extraction selectors and parent-tile behavior, materially relevant here).

Verdict: DB correct.

Confidence: high.

---

## Field 8: htmlCrawlViable + htmlCrawlNote (refined)

Verdict: Set htmlCrawlViable=true AND keep a refined note. DB's note was correct for /products/ but mis-applied as universal; R1 omitted any note. Refined note:

> Woodmart theme: /products/ shop page is AJAX-loaded (woodmart-ajax-shop-on), only 5 sidebar widget refs in static HTML. BUT /product-category/<slug>/page/N/ DOES render static product grids (12 per page via .wd-product). 5 of 22 categories have parent-tile mode on page 1 (wd-with-subcat); those pages yield 0 products but real products appear from page 2 onward. Catalog-crawler Playwright fallback at line 435 handles those 5 page-1 cases.

Confidence: high.

---

## Field 9: crawlersBootstrap (documentation-only)

Runtime grep: 0 references. R1 omitted entirely; DB has full shape. Keep DB shape but mark as documentation-only - apiEndpoints, htmlFallback, method are NOT consumed by runtime. R1 used different key naming (wpRestProduct, wcStoreProducts); DB names (productDiscovery, priceEnrichment) are more descriptive.

Confidence: medium (recommendation; field is doc-only).

---

## Field 10: dataFlow (documentation-only)

DB has 2-step pipeline doc; R1 omitted. Keep DB shape, update product count 2756 to 2808.

Confidence: medium.

---

## Field 11: wafProbeEvidence shape

DB: prose summary string. R1: structured object per SKILL.md.
Both contain same operational verdict. SKILL.md harness expects structured. Recommend R1 shape.

Confidence: high.

---

## Cross-check artifacts

- Runtime files inspected: backend/src/services/catalog-crawler.ts (lines 80-166, 380-480, 715-770), backend/src/services/watermark-crawler.ts (lines 700-776), backend/src/services/scraper/adapters/woocommerce.ts (lines 22, 320-370, 644-707), backend/src/services/product-count-probe.ts (full read), backend/src/services/profile-validator.ts (lines 1-100).
- Live HTML fetches: /products/ (HTTP 200, 1156072B), /product-category/ammunition/ (HTTP 200, 1143279B, wd-with-subcat detected), /product-category/ammunition/page/2/ (HTTP 200, 1194938B), /product-category/pal-ups/page/2..18/ (walk completed, ~225 products), /shop/ (HTTP 404 confirms DB note).
- WP REST product_cat endpoint: 24 top-level cats returned, 12 sub-cats of Ammunition.
- API id-jump proof JSON saved to /tmp/p1.json and /tmp/p2.json.

---

## Top corrections (priority order)

1. catalogUrls - DB's ["/products/"] yields 0 products at runtime. Adopt R1's 22-URL list.
2. paginationPattern - DB's api-page falls through to wrong-shape URL. Adopt R1's path / /page/{N}/.
3. expectedProductCount - Both stale or wrong-source. Use live 2808 (WP REST x-wp-total).
4. apiDateFilter - R1 missed; DB has it. Required to document the modified_after runtime contract.
5. productCountMethod.endpoint - Keep DB's /wp-json/wp/v2/product over R1's Store API; runtime calls WP REST.
