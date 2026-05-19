# R2 live investigation — internationalshootingsupplies.com

- Round: R2 (FRESH agent, no prior context from R1 author)
- Site: internationalshootingsupplies.com
- R1 candidate audited: `docs/site-audit/internationalshootingsupplies.com-2026-05-13T08-36-38Z-R1.json`
- R1 diff: `docs/site-audit/internationalshootingsupplies.com-2026-05-13T08-36-38Z-R1-diff.md`
- DB siteProfile lastVerified: `2026-04-12`
- Live probe window: `2026-05-13T08:35Z` to `2026-05-13T08:48Z`
- Tools used: curl (Chrome desktop UA), node + cheerio (in backend/), Prisma read-only (DB snapshot)
- Probe IP: residential (Canada)

This MD documents per-field methods + raw evidence. Corrections JSON: `internationalshootingsupplies.com-2026-05-13T08-49-31Z-R2-corrections.json`.

---

## Field 1 — `expectedProductCount`

R1 hypothesis: `2299` (WC Store API X-WP-Total). DB: `5111` (WP REST admin X-WP-Total, stale 2026-04-12).

R2 method: re-probe BOTH endpoints today + the OUT-of-stock variant of Store API to mathematically decompose the gap.

```
GET /wp-json/wc/store/v1/products?per_page=1            -> HTTP/1.1 200, X-WP-Total: 2299
GET /wp-json/wp/v2/product?per_page=1                   -> HTTP/1.1 200, X-WP-Total: 5230
GET /wp-json/wc/store/v1/products?per_page=1&stock_status=outofstock -> HTTP/1.1 200, X-WP-Total: 2931
```

Math: `2299 (in-stock) + 2931 (out-of-stock) = 5230 (admin total)`. Both halves are LIVE products.

Verified out-of-stock products are live by HTTP-fetching their detail pages (sample of 3):
```
/product/just-right-carbines-glock-m-lok-model-burnt-bronze-9mm-luger-18-6-threaded-barrel/  ->  200 OK, "stock out-of-stock", price=1399.99
/product/henry-h018x-410-lever-action-x-410-bore-2-1-2-19-8-barrel/                          ->  200 OK, "stock out-of-stock", price=1529.99
/product/black-creek-labs-mrx-bison-scout-5-56-nato-12-5-barrel/                              ->  200 OK, "stock out-of-stock", price=1019.99
```

VERDICT: Both R1 (`2299`) and DB (`5111`) wrong for different reasons. R1 omits 2931 out-of-stock-but-live products. DB is stale by 31 days. **CORRECTED: `5230`** (WP REST admin total, today's snapshot). This matches the SKILL.md Stage 8 `wp-rest-header` canonical method using the admin endpoint.

CONFIDENCE: high.

---

## Field 2 — `productCountMethod.endpoint`

R1 hypothesis: `/wp-json/wc/store/v1/products`. DB: `/wp-json/wp/v2/product`.

R2 method: align with Field 1 — for the runtime to keep `expectedProductCount` honest across restocks (which flip products between in-stock/out-of-stock without changing `status=publish`), we need the admin total.

VERDICT: DB endpoint is correct. **CORRECTED: `/wp-json/wp/v2/product`** with header `x-wp-total`. Bare shape only (no `wpRestTotal`/`storeApiTotal`/`dateFilterEvidence` residue per SKILL.md Rule B).

CONFIDENCE: high.

---

## Field 3 — `catalogUrls` (the strategy choice)

R1 hypothesis: 12 top-level URLs (`/product-category/firearms/`, etc.). R1 stage-4 note claimed "parent pagination DOES include descendants on page 2+".

DB: 79 leaf URLs.

R2 method: live-test the exact runtime path. The catalog-crawler hits `adapter.fetchCatalogPage` (API path) FIRST; HTML catalogUrls only fire as fallback. So the question is: does the HTML fallback work on R1's URL set?

Step 1 — fetch `/product-category/firearms/` page 1:
```
GET /product-category/firearms/  ->  HTTP/1.1 200
$('li.product').length = 6      // appears to be 6 product cards
data-product_id matches = 0     // but NO product ids -- they are subcategory tiles
"Showing N of M" text = none    // no result count -- confirms not a product listing page
```

Step 2 — parse the 6 li.product hits with the same logic as `woocommerce.ts:644 extractCatalogProducts`:
```
6 li.product items found
After applying isCategoryPageUrl filter (woocommerce.ts:676): 0 extracted
All 6 hrefs match /product-category/firearms/<child>/ -- subcategory tiles
Hrefs: handguns, rifles, shotguns, airguns-pal-not-required, airguns-pal-required, airsoft-guns-pal-not-required
```

Step 3 — trace runtime behavior with 0 products in catalog-crawler.ts:458-471:
```
products.length === 0 && !params.hasWaf
  -> break (line 471)
```
This means the crawler NEVER advances to page 2 for `/product-category/firearms/`. The 468 firearms products are LOST on the HTML fallback path.

Step 4 — verify DB's leaf strategy works:
```
GET /product-category/firearms/rifles/  ->  HTTP/1.1 200
data-product_id matches = 12 unique
"Showing 1-12 of 256 results"
```
Works correctly. Pagination via `getNextPageUrl` (woocommerce.ts:242-249) finds `.woocommerce-pagination a.next` and continues.

Step 5 — additional sanity check on R1's "Showing 13-24 of 468" claim:
```
GET /product-category/firearms/page/2/  ->  HTTP/1.1 200
data-product_id matches = 12 unique
"Showing 13-24 of 468 results"
```
TRUE — R1 was correct that page 2 has products. But the crawler can't reach page 2 because page 1 returns 0 -> breaks at line 471 before the `getNextPageUrl` call.

VERDICT: DB strategy is correct. R1 strategy breaks in production runtime. **CORRECTED to DB's 79 leaves + 1 added (`/product-category/firearms/handguns/` which DB omits).** Also kept path-only form per DB convention; URL-builder normalizes either form.

CONFIDENCE: high.

---

## Field 4 — `crawlers.maintain.verifyMethod` (HIGHEST-RISK FIELD)

R1 hypothesis: `store-api` (SKILL.md Stage 3 woocommerce default). DB documented: `detail-page` per 2026-04-03 incident note ("2898 products wrongly deactivated by Store API verify ... Switched to detail-page verification").

R2 method: live-test the EXACT runtime code path (`worker.ts:tryStoreApiVerify`, line 452-457: `axios.get('/wp-json/wc/store/v1/products', {params: {include: <ids>, per_page: CHUNK_SIZE}})`) on 35 known-in-stock and known-out-of-stock products.

### Sub-probe 4a — Known-in-stock products

Get newest 15 products from Store API:
```
GET /wp-json/wc/store/v1/products?per_page=20&orderby=date&order=desc
-> 20 products returned, all is_in_stock=true
IDs: 147172,147169,147163,147159,147155,147151,147147,147145,147141,147137,147133,147125,147106,147090,147077
```

Probe these 15 via Store API ?include= (the exact runtime call):
```
GET /wp-json/wc/store/v1/products?include=147172,147169,...,147077&per_page=20
-> HTTP/1.1 200, X-WP-Total: 15
-> 15 products returned, all is_in_stock=true
Missing from API: [] (none)
```
Result: 0% false-negative rate for in-stock products. Store API verify safely handles all of them.

### Sub-probe 4b — Known-older products (mixed stock)

Get 20 older products from WP REST page 100 (still status=publish):
```
GET /wp-json/wp/v2/product?per_page=20&orderby=date&order=desc&page=100&_fields=id,slug,status,catalog_visibility
-> 20 products, all status=publish
IDs: 72758,72548,72540,72537,72535,72520,72467,72463,72462,72452,72365,72361,72348,72347,72342,72297,71927,71818,71814,71812
```

Probe these 20 via Store API ?include=:
```
GET /wp-json/wc/store/v1/products?include=72758,72548,...,71812&per_page=20
-> HTTP/1.1 200, X-WP-Total: 6
-> 6 products returned
Missing from Store API: 14 IDs (72758, 72548, 72535, 72520, 72467, 72463, 72462, 72452, 72361, 72342, 71927, 71818, 71814, 71812)
```
**Result: 70% false-negative rate (14 of 20 published products not in Store API ?include).**

### Sub-probe 4c — Verify the missing products are LIVE

Pick 3 missing IDs and fetch their detail pages:
```
GET /product/just-right-carbines-glock-m-lok-model-burnt-bronze-9mm-luger-18-6-threaded-barrel/   ->  200 OK
  class="stock out-of-stock">Out of stock
  "price":"1399.99"
  <meta property="og:title" content="Just Right Carbines Glock M-LOK Model Burnt Bronze 9mm Luger 18.6 Threaded Barrel"

GET /product/henry-h018x-410-lever-action-x-410-bore-2-1-2-19-8-barrel/                            ->  200 OK
  class="stock out-of-stock">Out of stock
  "price":"1529.99"

GET /product/black-creek-labs-mrx-bison-scout-5-56-nato-12-5-barrel/                                ->  200 OK
  class="stock out-of-stock">Out of stock
  "price":"1019.99"
```
All 3 missing products are LIVE (HTTP 200, full price, valid title) — they're just out of stock.

### Sub-probe 4d — Confirm Store API filters by stock by default

```
GET /wp-json/wc/store/v1/products?include=72758,72548,72535,71814&per_page=20&stock_status=outofstock
-> 4 products returned (all 4 of the previously-missing IDs)
```
Confirmed: Store API's default behavior filters out `stock_status=outofstock`. Without the query param, only in-stock items return.

### Sub-probe 4e — Trace runtime worker.ts behavior

```
worker.ts:452-457   axios.get('/wp-json/wc/store/v1/products', params: {include, per_page: CHUNK_SIZE})  -- NO stock_status param
worker.ts:511-512   apiMap.get(product.sourceId)  -- for each product in chunk
worker.ts:537-546   if (apiProduct missing) { /* DO NOT increment verifyErrors or deactivate -- just skip */ }
```

The deactivation bug from 2026-04-03 has been FIXED (lines 537-546 comment explicitly references it). Today's `store-api` config is SAFE — missing products are now skipped, not deactivated.

But: the fast-path covers only 44% of products (the in-stock 2299). The remaining 56% (2931 out-of-stock) fall through to Playwright via the partial-fastpath branch at `worker.ts:752-758`. Net cost vs `detail-page`: similar (most of the work still goes to Playwright); minor savings from batch-API fast-path on in-stock half.

### Verdict

`store-api` is SAFE under current runtime but offers limited efficiency gain (44% fast-path coverage) because of stock-filtering behavior. `detail-page` is what DB picked post-incident and what the operator's recorded decision says. Preserve the operator's documented choice.

**CORRECTED: `detail-page`** (per DB).

CONFIDENCE: high. Reasoning: (a) operator history; (b) the efficiency gain of `store-api` is much less than expected because more than half the verify population is out-of-stock products that fall through to Playwright anyway; (c) running Playwright for everyone gives consistent observability vs the dual-path branching.

---

## Field 5 — `crawlers.watermark.method`

R1 and DB agree on `api-date-since-watermark`.

R2 sanity check (probed 2026-05-13T08:47Z):
```
GET /wp-json/wp/v2/product?per_page=1               ->  HTTP 200, X-WP-Total: 5230
GET /wp-json/wp/v2/product?after=2099-01-01T00:00:00 ->  X-WP-Total: 0
GET /wp-json/wp/v2/product?after=1999-01-01T00:00:00 ->  X-WP-Total: 5230
```
Three-outcome counter-control test confirms `?after` is honored. `adapter.fetchCatalogPage` (woocommerce.ts:288) implements this with `modified_after` param. `watermark-crawler.ts:715` will route to API method.

VERDICT: **MATCH `api-date-since-watermark`**. CONFIDENCE: high.

---

## Field 6 — `hasWaf` / `needsPlaywright`

R1: `false` / `false`. DB: `false` / silent.

R2 method: header probe of apex + 4 high-value paths.
```
GET https://internationalshootingsupplies.com/  ->  HTTP/1.1 200, Server: nginx, no cf-ray, no x-sucuri, no x-incapsula
GET /wp-json/wp/v2/product?per_page=1            ->  200 + X-WP-Total: 5230 (curl Chrome UA, no cookies)
GET /wp-json/wc/store/v1/products?per_page=1     ->  200 + X-WP-Total: 2299 (curl Chrome UA, no cookies)
GET /product-category/firearms/rifles/           ->  200 + 12 products (curl Chrome UA, no cookies)
GET /product/<sample>/                            ->  200 (curl Chrome UA, no cookies)
```
All clean — no WAF, no Playwright needed.

VERDICT: **MATCH `hasWaf=false`, `needsPlaywright=false`**. CONFIDENCE: high.

---

## Field 7 — `paginationPattern`, `sortParam`, `perPage`

Cosmetic divergences only:
- R1 `/page/{N}/` vs DB `page/{N}/` — both work via `getNextPageUrl` (parsed from HTML pagination links, not the template string).
- R1 `?orderby=date` vs DB `orderby=date` — both work via runtime URL-builder.
- R1 and DB both `perPage=12`.

R2 verified on `/product-category/firearms/rifles/`:
```
"Showing 1-12 of 256 results"  -- perPage=12 confirmed
/product-category/firearms/page/2/ -- /page/{N}/ pattern confirmed
?orderby=date returns different first slug than default -- sort honored confirmed
```

VERDICT: Both forms acceptable. **CORRECTED to R1's leading-slash forms** (cosmetically clearer). CONFIDENCE: high.

---

## Field 8 — `platform`, `adapterType`

R1: `woocommerce` / `woocommerce`. DB column: `woocommerce` / `woocommerce`. DB notes say "adapterType changed to generic-retail" but the actual column value is `woocommerce`.

R2 sanity check: WP REST + Store API both respond 200 — adapter has fetchCatalogPage support. WC adapter works.

VERDICT: **MATCH `woocommerce` / `woocommerce`**. DB notes are stale (the change was reverted or never persisted). CONFIDENCE: high.

---

## "BOTH wrong" findings

**1. `expectedProductCount`**: R1 = 2299 (in-stock only), DB = 5111 (stale). **Correct = 5230** (today's WP REST admin total).

**2. `catalogUrls` — partial both-wrong**: R1 has 12 URLs (catastrophic fallback breakage at page 1). DB has 79 URLs but omits `/product-category/firearms/handguns/` (one of the 6 firearms subcats visible on the live parent tile page). **Correct = 80 URLs** (DB's 79 + handguns).

---

## verifyMethod live test result (REQUIRED by mission spec)

Tested 35 products (15 known-in-stock newest + 20 mixed-stock older) via Store API ?include= (the exact runtime call shape in `worker.ts:452-457`):

| Group | Count | Returned | Missing | False-deactivation under old code | Safe under current code |
|---|---|---|---|---|---|
| Known in-stock (newest 15) | 15 | 15 | 0 | 0% | yes (just skips on missing) |
| Older mixed-stock (page 100) | 20 | 6 | 14 (70%) | would have deactivated 14 | yes (skips per worker.ts:537-546 fix) |

**Confirmed mechanism**: Store API defaults to `stock_status=instock`. Out-of-stock-but-LIVE products (2931 of 5230 = 56% of catalog) are filtered out. They render HTTP 200 on their detail pages with valid price and `class="stock out-of-stock"`.

**Today's runtime risk under `store-api`**: zero false-deactivations (worker.ts:537-546 already patched). But 56% of products fall through to Playwright via the partial-fastpath branch at worker.ts:752-758, so the efficiency advantage of `store-api` over `detail-page` is small.

**Recommended verifyMethod**: `detail-page` (preserves operator's 2026-04-03 documented decision; simpler observability; small cost delta).
