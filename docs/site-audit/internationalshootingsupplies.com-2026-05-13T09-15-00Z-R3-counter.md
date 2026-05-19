# R3 adversarial counter — internationalshootingsupplies.com

- Round: R3 (FRESH skeptic, no prior R1/R2 context)
- Site: internationalshootingsupplies.com
- R2 corrections audited: `internationalshootingsupplies.com-2026-05-13T08-49-31Z-R2-corrections.json`
- R2 investigation: `internationalshootingsupplies.com-2026-05-13T08-49-31Z-R2-investigation.md`
- Live re-probe window: 2026-05-13T09:10Z to 2026-05-13T09:14Z
- Tool: curl (Chrome desktop UA), Read on backend source

---

## Per-correction adversarial attempts

### 1. `expectedProductCount = 5230` — COULDN'T DISPROVE

Re-probed all three endpoints today (probeAt 2026-05-13T09:11Z), no caching:
```
GET /wp-json/wp/v2/product?per_page=1                                -> 200, X-WP-Total: 5230
GET /wp-json/wc/store/v1/products?per_page=1                         -> 200, X-WP-Total: 2299
GET /wp-json/wc/store/v1/products?per_page=1&stock_status=outofstock -> 200, X-WP-Total: 2931
```
Math: 2299 + 2931 = 5230 EXACTLY. Triangulated. No room for error.

Alternative tested: could WP REST default include `private`/`draft` statuses to inflate total? No — WP REST anonymous strips non-public statuses. Both halves of the decomposition come from the same Store API (publish-only) and sum to the admin total.

VERDICT: R2 survives.

### 2. `productCountMethod.endpoint = /wp-json/wp/v2/product` — COULDN'T DISPROVE

Store API X-WP-Total = 2299 (in-stock-only, well-known platform behavior). To track restock dynamics (out-of-stock products flipping to in-stock without `status` change), the admin endpoint is the only honest source.

VERDICT: R2 survives.

### 3. `catalogUrls = 80 leaves` (incl. firearms/handguns) — COULDN'T DISPROVE

Tested ALTERNATIVE hypothesis: does `?orderby=date` rescue R1's parent-URL strategy by making page 1 return product cards instead of subcategory tiles?
```
GET /product-category/firearms/?orderby=date  ->  200, data-product_id count = 0, .product-category tiles = 6
```
NO. Sort param does not rescue. Page 1 is still all subcategory tiles.

Re-confirmed runtime break-on-zero behavior (catalog-crawler.ts:458-471):
- products.length === 0 && !params.hasWaf -> `break` at line 471
- `getNextPageUrl` is called ONLY in the WAF branch (line 464), NEVER in the non-WAF branch
- ISS has hasWaf=false (verified header probe), so the WAF branch never fires
- Therefore /firearms/ page 1 with 0 products = HARD STOP, never reaches page 2

R1's 12 parent URLs would lose 468 firearms + every other parent's products on HTML fallback. DB's 79 leaves + handguns is correct.

VERDICT: R2 survives.

### 4. `crawlers.maintain.verifyMethod = detail-page` — COULDN'T DISPROVE BUT FOUND R2 REASONING ERROR

R2 claims "56% of products fall through to Playwright via partial-fastpath branch at worker.ts:752-758, so the cost delta is small."

This is WRONG. Re-reading worker.ts:510-550 carefully:
- Line 549: `handledProductIds.push(product.id);` is OUTSIDE the if/else, runs UNCONDITIONALLY for every product in chunk
- Line 403: `withSourceId = products.filter(p => p.sourceId != null);` — ISS WC products all have numeric sourceIds
- Therefore `handled === products.length` (line 711) is TRUE — early-return at line 726 fires — Playwright NEVER called for out-of-stock products

Real behavior under `store-api`: 2931 out-of-stock products get NO data update (no lastSeenAt refresh, no stockStatus flip, no isActive check). They appear "verified" in logs but are silently stale.

This makes the gap LARGER, not smaller — `detail-page` is the more correct recommendation than R2 even argued. The 2026-04-03 incident note plus the silent-no-op behavior both point to detail-page.

VERDICT: R2's final answer (detail-page) survives. R2's reasoning had a flaw, but it pointed in the same direction.

### 5-8. `watermark.method`, `hasWaf`, `needsPlaywright`, `platform`, `adapterType`, `paginationPattern`, `sortParam`, `perPage` — COULDN'T DISPROVE

Header re-probe today (2026-05-13T09:13Z):
```
Server: nginx, no cf-ray, no x-sucuri, no x-incapsula  (hasWaf=false confirmed)
WP REST 200 + Store API 200 + product detail 200  (needsPlaywright=false confirmed)
```
WP REST + Store API both 200 → woocommerce adapter has fetchCatalogPage support.

VERDICT: All survive.

---

## Counter-claims summary

- Corrections attempted: 8 distinct fields
- Counter-claims landed: 0 (R2 corrections all hold)
- Reasoning flaws found: 1 (R2's "56% fall through to Playwright" is wrong — actual is 0% fall through; out-of-stock are silently no-op'd; this strengthens, not weakens, R2's `detail-page` recommendation)

### Strongest 2 observations
1. R2 silent-no-op gap (worker.ts:537-549): under `store-api` verify, all out-of-stock products are marked `handled` (line 549 unconditional) so the partial-fastpath fallback at line 730 NEVER fires for them. They get no DB update. This is safer than the pre-2026-04-03 deactivation bug but still leaves 56% of catalog with no verify-data refresh.
2. catalog-crawler.ts non-WAF break-on-zero: line 471's unconditional `break` outside the `if (params.hasWaf)` block means parent URLs returning 0-on-page-1 are unrecoverable regardless of `getNextPageUrl` availability. R1's strategy is structurally broken for ISS.

### REQUIRED — verifyMethod runtime-guard verdict
CONFIRMED. worker.ts:537-546 is a comment-only `else` branch that prevents deactivation when apiMap.get returns undefined for an out-of-stock product. The 2026-04-03 incident reasoning is documented inline. R2 correctly identified that `store-api` is SAFE under current runtime. Caveat (not flagged by R2): the safety comes with a silent no-op cost — 2931 out-of-stock products would never have `lastSeenAt`/`stockStatus`/`isActive` refreshed under store-api. `detail-page` is the right answer for ISS.

### REQUIRED — catalogUrls break-on-zero verdict
CONFIRMED. catalog-crawler.ts:458-471 has TWO branches:
- `if (params.hasWaf)` → counter-based: tries `getNextPageUrl`, retries up to MAX_CONSECUTIVE_EMPTY_PAGES (line 464-469)
- ELSE → `break` at line 471 unconditionally — no `getNextPageUrl` call

ISS has hasWaf=false, so the second branch fires. R1's parent URL `/product-category/firearms/` returns 0 product cards on page 1 (verified: 6 .product-category tiles, 0 data-product_id, even with `?orderby=date`). The runtime breaks at line 471 BEFORE ever calling getNextPageUrl. R2's claim is exactly correct. R1's strategy loses 468+ firearms products on the HTML fallback path. DB's 79-leaf strategy (+ handguns = 80) is required.
