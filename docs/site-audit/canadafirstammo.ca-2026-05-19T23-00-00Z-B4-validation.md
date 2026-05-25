# canadafirstammo.ca — Batch-4 Validation (2026-05-19T23:00Z)

Single validation round. Live + adversarial probes against post-fix DB.

## Verdict per fix

### 1. expectedProductCount = 132 — PASS
Live `GET /wp-json/wc/store/v1/products?per_page=1` returned `X-WP-Total: 132` (Chrome 120). Matches DB. 962/132 ratio (13.7%) is below the `product-count-probe.ts:521-525` bootstrap-trap threshold; fix avoids that trap.

### 2. productCountMethod = wc-store-api-header — PASS
Endpoint live, header present, value matches `expectedProductCount`. Method canonical (passes `profile-validator.ts` C5 allowlist).

### 3. WP REST surface (962) is hidden + drafts — CONFIRMED
`GET /wp-json/wp/v2/product?per_page=1` returns `X-WP-Total: 962` AND `X-WP-TotalPages: 962` — 7.3x the Store API visible count. Store API filters to in-stock/published/catalog-visible. R3 evidence holds; abandoning WP REST as the count surface is correct.

### 4. hasWaf flip true → false — PASS
4 rotating production UAs (Chrome 120, Safari 17, Firefox 121, Edge 120) all 200 on both Store API and `/?s=ammo&post_type=product`. `cf-ray` header present (CF in front) but no challenge / 403 / 429. CF bot rule only fires on sqlmap/python UAs per R3. Flip justified.

### 5. sortVerified = true (boolean) — PASS
`profile-validator.ts:116` reads `p.sortVerified === true`. Old object shape fails `===`. New boolean shape now satisfies the strict check. `sortParam` also set.

### 6. searchUrl = '/?s={keyword}&post_type=product' — PASS
Live GET returns 200, HTML 368KB, `archive search search-results post-type-archive-product` body class confirms WooCommerce search archive. `Showing 10 of 12 results` for `ammo`; 10 unique `/product/...` links extracted.

## Adversarial findings

- **Shop-all is incomplete:** `/product-category/shop-all/page/10/` reports `Showing 111 of 111 results`. Confirms R3 — shop-all covers only 111/132 (~84%). Bootstrap must union all 10 `catalogUrls`, not rely on shop-all alone. siteProfile already lists 10 — no DB change, flag for bootstrap coverage assertion.
- No WAF challenge observed on any rotating UA / endpoint combination tested.

## Overall: PASS — all 5 DB fixes verified live. Watch item: shop-all-only crawl under-covers by ~16%; multi-category union required.
