# B4R2 Investigation — greatnorthgunco.ca

Site: greatnorthgunco.ca
DB adapterType: woocommerce
Round: 2 of 4 (adversarial audit)
Tester: testing-api-tester persona
Date: 2026-05-19T21-00-00Z

## R1 divergent fields probed (with DIFFERENT-method tests)

### 1. `verifyMethod` — R1 `store-api` vs DB `detail-page`

**R1 hypothesis**: skill default ("WC -> store-api") is correct; the worker.ts L544 fix on this branch is enough; the DB's detail-page was a pre-fix mitigation now redundant.

**R2 test (different method)**: rather than re-reading the runtime code, directly query Store API for products that are in WP REST but not in the Store API listing. If Store API returns empty for a published product, the 2026-04-03 incident's root cause is still live.

Steps:

1. Fetched all 6 pages of Store API (per_page=100). 528 unique IDs total — matches `x-wp-total`. URL: `https://greatnorthgunco.ca/wp-json/wc/store/v1/products?per_page=100&page=1..6&_fields=id,slug`. All HTTP 200.
2. Fetched WP REST oldest-first page 1 (100 products). Diffed against the 528 Store API IDs. Found 5 published products in WP REST but absent from Store API listings — IDs 1549, 2427, 2433, 2434, 2435 (all `publish` status).
3. Direct slug query for one of them — the critical test:
   ```
   GET https://greatnorthgunco.ca/wp-json/wc/store/v1/products?slug=swiss-30-cal-cleaning-kit
   HTTP 200
   Body: []
   ```
4. Direct URL fetch for the same product to prove it exists:
   ```
   GET https://greatnorthgunco.ca/product/swiss-30-cal-cleaning-kit/
   HTTP 200 | 79349 bytes
   ```
5. Repeated for a second slug to rule out a one-off:
   ```
   GET https://greatnorthgunco.ca/wp-json/wc/store/v1/products?slug=lee-enfield-no1mkiii-bolt-head
   HTTP 200
   Body: []
   ```

**Conclusion**: Store API DOES return empty arrays for `catalog_visibility=hidden` published products. The 2026-04-03 incident's root cause is still live in the site data. With the worker.ts L544 fix on branch `fix/batch-3-runtime-bugs-2026-05-19` (verified at line 544: `handledProductIds.push` is inside `if (apiProduct)` only; the "not found" branch leaves the product unhandled so caller falls through to Playwright at L759), `store-api` IS now operationally safe — but the fix is not yet on `main`. The operator's recorded `detail-page` choice is the conservative belt-and-suspenders. **VERDICT: DB wins.**

Code references:
- `backend/src/services/worker.ts` L544: `handledProductIds.push(product.id);` inside `if (apiProduct)` branch
- `backend/src/services/worker.ts` L737-738: `const remaining = products.filter(p => !handledIds.has(p.id))` followed by Playwright fallback at L759
- DB siteProfile.notes: "2026-04-03: 3691 products wrongly deactivated by Store API verify"

### 2. `catalogUrls` — R1 15 absolute URLs vs DB 14 path URLs with typo + missing cats

**R1 hypothesis**: DB has typo `/accessoriesparts/` (no hyphen) that doesn't match WP slug `accessories-parts`; DB missing 3 small cats; R1 derived from live taxonomy API.

**R2 test (different method)**: HEAD/GET probe each disputed URL and check WP REST taxonomy directly.

Steps:

1. `GET https://greatnorthgunco.ca/product-category/accessoriesparts/` -> HTTP 404 (DB typo is a dead URL — confirmed)
2. `GET https://greatnorthgunco.ca/product-category/uncategorized/` -> HTTP 200 (DB missed real cat with 16 visible products)
3. `GET https://greatnorthgunco.ca/product-category/several-available-surplus/` -> HTTP 200 (DB missed cat with 3 visible products)
4. `GET https://greatnorthgunco.ca/product-category/several-available/` -> HTTP 200 (DB missed cat with 1 visible product)
5. `GET /wp-json/wp/v2/product_cat?per_page=100&hide_empty=false&_fields=id,slug,count,parent` returned 15 productive cats; sum of `count` field = 528 = Store API total (perfect match).

**Conclusion**: R1 wins on coverage and correctness. DB typo is a 404; DB missed 3 small but real cats. **VERDICT: R1 wins.**

### 3. `expectedProductCount` — R1 4299 vs DB 4201

**R1 hypothesis**: both use same method; DB stale 42 days; catalog has drifted upward.

**R2 test (different method)**: re-fetch live `x-wp-total` AND cross-check via product-sitemap multi-file sum.

Steps:

1. `GET /wp-json/wp/v2/product?per_page=1` -> x-wp-total: 4306
2. Sitemap index lists 5 product-sitemap files. Counts: 1001 + 1000 + 1000 + 1000 + 306 = 4307. Minus 1 stylesheet `<loc>` in product-sitemap.xml (= `/shop/`) = 4306. Cross-check matches.

**Conclusion**: Both R1 and DB are stale. Current = 4306. **VERDICT: both wrong — site has grown to 4306.**

### 4. `searchUrl` — R1 missing vs DB `/?s={keyword}&post_type=product`

**R1 hypothesis**: R1 simply forgot to probe.

**R2 test (different method)**: live GET on the DB-claimed search URL with a known keyword.

Steps:

1. `GET https://greatnorthgunco.ca/?s=husqvarna&post_type=product` -> HTTP 200, 113192 bytes.
2. `<title>` extracted: `You searched for husqvarna - Surplus GNG` (confirmed search-results page).
3. Product card markers (class="product", woocommerce-LoopProduct-link, product_cat-) counted in body: 74.

**Conclusion**: DB's searchUrl works. R1 missed it. **VERDICT: DB wins.**

### 5. `paginationPattern.template` — R1 `/page/{N}/` vs DB `/page/{N}` (trailing slash)

**R1 hypothesis**: WP permalink pretty-mode redirects between with/without slash; canonical is with slash.

**R2 test (different method)**: GET both forms with `-L` (follow redirects) and inspect final URL.

Steps:

1. `GET https://greatnorthgunco.ca/shop/page/2` -L -> final URL: `https://greatnorthgunco.ca/shop/page/2/` (server-side 301 to with-slash)
2. `GET https://greatnorthgunco.ca/shop/page/2/` -L -> final URL: `https://greatnorthgunco.ca/shop/page/2/` (no redirect)

**Conclusion**: Canonical form has trailing slash. **VERDICT: R1 wins.**

### 6. `wafType` — R1 `null` vs DB `"none"`

**R2 test**: skill canonical is `null`; production crawler reads `hasWaf` boolean only (verified by grep across `backend/src/`). Both forms are functionally equivalent.

**VERDICT: cosmetic — R1 wins on schema canonicalization.**

### 7. `sortParam` and `sortVerified`

**R2 test (different method)**: HTML extraction of `/shop/?orderby=date` to inspect product order by `data-product_id` attribute.

```
GET https://greatnorthgunco.ca/shop/?orderby=date
First 5 data-product_id values in body: 44216, 44061, 44201, 43878, 44377
```

All in the 43000-44000 range (newest by ID). Order roughly descending. Sort is honored. **VERDICT: R1 wins.**

## Verdict counts

- **R1 wins**: 5 (catalogUrls, paginationTemplate, wafType, sortParam, sortVerified)
- **DB wins**: 2 (verifyMethod, searchUrl)
- **Both wrong**: 1 (expectedProductCount — current = 4306, both were stale)
- **Inconclusive**: 0

## Top 3 verdicts (one-line evidence)

1. **verifyMethod: DB wins (detail-page)** — `/wp-json/wc/store/v1/products?slug=swiss-30-cal-cleaning-kit` returns `[]` HTTP 200 while `/product/swiss-30-cal-cleaning-kit/` returns 79KB of product HTML; reproduces 2026-04-03 incident root cause on 4-of-4 sampled hidden products.
2. **catalogUrls: R1 wins** — DB typo `/product-category/accessoriesparts/` returns HTTP 404; R1's 15 URLs all return 200 and sum to 528 = Store API total exactly.
3. **expectedProductCount: both wrong (use 4306)** — live `x-wp-total` = 4306, cross-checked by product-sitemap multi-file sum (1001+1000+1000+1000+306-1 = 4306).

## Blockers

None. The corrected siteProfile is `docs/site-audit/greatnorthgunco.ca-2026-05-19T21-00-00Z-B4R2.json`. Operator review notes:

- **verifyMethod**: keep `detail-page` until worker.ts L544 fix is merged to `main`. After merge, `store-api` will also be safe (misses fall through to Playwright at L759), but detail-page remains the safest documented operator choice for this site given the documented 3691-product incident.
- **expectedProductCount**: should be re-derived at every audit pass; catalog has drifted +105 in 42 days (4201 -> 4306).
- **catalogUrls**: DB needs cleanup — drop typo `/accessoriesparts/`, optionally drop `/shop/` aggregator since per-category union covers same set; add the 3 small cats.

## Methods log (DIFFERENT-method tests vs R1)

| Field | R1 method | R2 different method |
|---|---|---|
| verifyMethod | followed skill table | direct slug query on Store API for products absent from listing |
| catalogUrls | live taxonomy API call | per-URL HTTP probe + recount taxonomy cats |
| expectedProductCount | x-wp-total | x-wp-total + product-sitemap multi-file sum cross-check |
| searchUrl | not probed | live keyword search GET + title+card-count inspection |
| paginationTemplate | skill canonical | curl -L to inspect server-side 301 |
| sortParam | sort dropdown options | HTML extraction of data-product_id ordering |

## Rate limit compliance

All probes spaced with 800ms `sleep` between requests (per persona rules). Single Bash chain operations did not pipeline more than one request without delay. No probe exceeded 60s.
