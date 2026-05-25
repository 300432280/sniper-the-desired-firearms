# B4R2 Investigation — doctordeals.ca

Round: 2 of 4 (adversarial). Persona: testing-api-tester. Probe IP: 99.228.63.11. No DB writes.

## Method (different from R1)
R1 used WC Store API `/wp-json/wc/store/v1/products/categories` (recursive) + homepage anchors during the sgcaptcha challenge. R2 directly drives the live URLs through Playwright (iPhone UA, sgcaptcha solved via homepage warmup) and queries the **non-recursive WP REST core `/wp-json/wp/v2/product_cat`** taxonomy + walks pagination on both URL forms to ground-truth the routing.

Probe scripts: `backend/scripts/_tmp-doctordeals-r2-probe.ts` + `_tmp-doctordeals-r2-probe2.ts` (deleted after audit).

## Verdicts (10 divergences)

### 1. `catalogUrls` — BOTH WRONG
- **Live evidence**:
  - `GET /product-category/gun-shop/` → **404** (page can't be found). "gun-shop" is NOT a real WP taxonomy term.
  - `GET /wp-json/wp/v2/product_cat?slug=gun-shop&hide_empty=false` → `[]` (empty array, status 200). Confirms no term exists.
  - `GET /product-category/firearms/` → 200, first product `savage-a22-fv-sr-22-lr-...`
  - `GET /product-category/gun-shop/firearms/` → 200, **same first product**, same pagination depth (page 9 last on both, page 10 → 404 on both). WP permalink rewrite resolves the `gun-shop/` prefix to the canonical category page.
  - WP REST `product_cat?slug=firearms` returns `"link":"https://doctordeals.ca/product-category/firearms/"` — canonical form has NO `gun-shop/` prefix.
- **Top-level WP terms (parent=0)**: `accessories(261)`, `clothing-gun-related(44)`, `defense(1)`, `firearms(107)`, `mags-barrels(109)`, `parts(388)`, `uncategorized(0)` — 6 real categories totaling **910 products**.
- **DB's 5 URLs miss `mags-barrels` entirely** (109 products dropped) and use the legacy `gun-shop/` rewrite prefix.
- **R1's single `/shop/`** works (covers all customer-visible products via pagination) but loses the category-spine structure called for by the `catalogUrls` design rule (project memory: `feedback_catalog_urls_full_coverage.md` — "topLevelCategories spine, NOT a single all-products mega-URL").
- **Verdict: BOTH WRONG.** Correct value is the 6-URL spine using the canonical no-prefix form: `/product-category/firearms/`, `/parts/`, `/accessories/`, `/mags-barrels/`, `/clothing-gun-related/`, `/defense/`. The legacy `gun-shop/` form still 200s but the canonical form is what WP REST advertises.

### 2. `expectedProductCount` — R1 wins
- Live `/wp-json/wp/v2/product?per_page=1` x-wp-total = **972**. DB's 965 is stale (lastVerified 2026-04-06). R1 wins; net +7 products.

### 3. `perPage` — R1 wins (different surfaces, but skill field semantics is HTML)
- HTML `/shop/` returns 12 product links/page (Flatsome theme). Verified live: `/product-category/firearms/page/9/` returns 11 (last page tail of 107 = 8×12+11).
- DB's `20` is the **WC Store API enrichment batch size** (`storeApiChunkSize`/`?per_page=20` for `/wp-json/wc/store/v1/products`).
- These measure DIFFERENT surfaces. The skill output's `perPage` field is the HTML listing perPage (used for pagination math) → R1's `12` is correct for that field. DB's `20` is a misnamed API-batch field.

### 4. `paginationPattern` — R1 wins
- Live walk confirms path-template `/page/{N}/` with no `?page=` param. `/product-category/firearms/page/10/` → 404 (real boundary). `firstPageHasParam=false`, `startPage=1`. DB never populated this field. R1's value is correct.

### 5. `crawlers.maintain.verifyMethod` — RUNTIME-EQUIVALENT (R1 wins for skill output)
- `worker.ts:381` `tryStoreApiVerify` only checks `verifyMethod === 'store-api'`. Everything else falls through to `worker.ts:765` else-branch, which checks for ANY truthy verifyMethod and calls `verifyProductsViaPlaywright(products, ...)` unconditionally — there is NO branching on the literal `'json-ld'` vs `'detail-page'` strings (grep across `backend/src` confirms only one literal `=== 'store-api'` exists; `json-ld`/`detail-page` strings appear only in comments).
- Both DB's `json-ld` and R1's `detail-page` route to the same Playwright detail-page verifier. DB's `json-ld` is an operator-intent marker; R1's `detail-page` is the generic skill output.
- **Verdict: R1 WINS for the skill output.** Runtime behavior is identical. DB's value is not wrong, just more specific.

### 6. `crawlers.maintain.method` / `cooldowns` / `tierShares` / `tierWindows` — not-a-divergence
- Per skill rules, Stage 9 only emits `verifyMethod` + `verifyEndpoint`. The cooldown/tier-share/tier-window blocks are operator-tuned, layered on at DB promotion. Different layers.

### 7. `crawlers.bootstrap` block — not-a-divergence
- Skill explicitly removed `crawlers.bootstrap.apiEndpoints` (zero runtime consumers in `backend/src/`). DB's block is operator documentation only. Equivalent info in R1's `auditNotes.discoveredApiEndpoints`.

### 8. `dataFlow` block — not-a-divergence
- Same as #7. Not part of validator-required output.

### 9. `wafWorkaround` — R1 wins (correctly omitted)
- Skill rule: only emit `wafWorkaround` for Celerant-style malformed-header sites. sgcaptcha cookie-cache is handled inside `waf-cookie-manager.ts` automatically when `hasWaf=true` + `wafType=sgcaptcha`. DB's notes mention "Sucuri" — stale and incorrect label.

### 10. `searchUrl` — DB WINS (R1 candidate miss)
- Live `/?s=ruger&post_type=product` → 200, 12 results, first hit = `ruger-10-22-...` (canonical WP search hits work).
- Live `/?s=ammo&post_type=product` → 200, 2 results (matches DB note "site doesn't sell ammo").
- R1 omitted this field entirely. DB's `/?s={keyword}&post_type=product` is the canonical WC search URL and verified live.

## Summary

- **R1 wins**: 5 (expectedProductCount, perPage, paginationPattern, verifyMethod, wafWorkaround-omission)
- **DB wins**: 1 (searchUrl)
- **Both wrong**: 1 (catalogUrls — neither used canonical no-prefix spine including `mags-barrels`)
- **Not-a-divergence**: 3 (operator-overlay fields: maintain.method/cooldowns, bootstrap, dataFlow)
- **Inconclusive**: 0

## Coverage check on corrected catalogUrls
Canonical 6-URL spine sum = 910 (sum of `count` per parent=0 term in WP REST product_cat). WP REST total products = 972. Delta = 62 products in "uncategorized" / OOS / drafts visible via admin REST. Production T1 uses `api-date-since-watermark` against WP REST `/wp/v2/product` which sees all 972 — the catalogUrls are HTML-fallback stream only. Per `feedback_catalog_urls_full_coverage.md` the spine is correct; runtime watermark covers the gap.

## Blockers
None.
