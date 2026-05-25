# greatnorthgunco.ca — Batch 4 Validation (single round)

Date: 2026-05-19T23:00:00Z
Snapshot: `_audit_tmp/batch4-validation-2026-05-19/greatnorthgunco.ca-POSTFIX.json`

## Fix verdicts

### 1. `catalogUrls = ['/shop/']` — PASS

- `GET /shop/page/23/` -> 200
- `GET /shop/page/24/` -> 404
- Boundary holds. perPage=24 x 23 pages = 552 visible-product slots, aligns with Store API X-WP-Total=532 (+1 trailing page).

### 2. `crawlers.maintain.verifyMethod = 'detail-page'` — PASS

Code trace (`backend/src/services/worker.ts`):

- L397: `if (maintainConfig.verifyMethod !== 'store-api') return null;` -> with `'detail-page'`, `tryStoreApiVerify` returns `null`.
- L709: `storeApiFastPath` is null -> falls into the `else` at L765.
- L769-775: reads `verifyMethod` from profile, then calls `verifyProductsViaPlaywright(products, ...)` against the FULL product set. Every product gets a real URL fetch.
- L544: `handledProductIds.push(product.id)` is inside `if (apiProduct) { ... }` (L513). The `else` branch (L545-555) is documented and does NOT push. Batch-3 fix is intact on `main`.

Hidden-slug evidence (3/3):
- Store API `?slug=lee-enfield-no4-bolt-head-size-1` -> `[]`; detail page -> 200
- Store API `?slug=lee-enfield-no4-magazine-catch` -> `[]`; detail page -> 200
- Store API `?slug=enfield-no1-mkiii-safety-spring` -> `[]`; detail page -> 200

Confirms Store API drops hidden-visibility products and detail-page is the only correct verifier here.

### 3. `expectedProductCount = 4312` + `productCountMethod = wp-rest-header` — PASS

- `HEAD /wp-json/wp/v2/product?per_page=1` -> `X-WP-Total: 4312` (matches profile exactly)
- `HEAD /wp-json/wc/store/v1/products?per_page=1` -> `X-WP-Total: 532` (visible-only; ~3780 hidden delta confirms catalog_visibility=hidden bulk)

### 4. `searchUrl = '/?s={keyword}&post_type=product'` — PASS

- `?s=lee+enfield&post_type=product` -> 200, 8 `woocommerce-loop-product__title` hits
- `?s=glock&post_type=product` -> 200, 2 hits
- (`?s=lee-enfield` returned "No products were found"; expected — that hyphenated literal is a slug fragment, not a search term.)

## Adversarial findings

None. All five fixes verified against live HTTP and source. The L544 conditional-push guard from `fix/batch-3-runtime-bugs-2026-05-19` (merged to `main`) is the load-bearing guarantee that detail-page mode actually runs Playwright on every queued product.
