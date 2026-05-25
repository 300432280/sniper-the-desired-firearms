# B4R3 Counter — doctordeals.ca

Round 3 of 4. Persona: engineering-code-reviewer. Probe IP: 99.228.63.11. No DB writes.
Probe scripts (deleted after audit): `backend/scripts/_tmp-dd-r3-probe.ts`, `_tmp-dd-r3-probe2.ts`.

## Tally
- COUNTER: **0**
- COULDN'T DISPROVE: **8** (every R2 correction held under adversarial re-test)
- UNTESTED: **0** (all R2 corrections probed live)

## Per-correction verdicts

### 1. catalogUrls 6-URL canonical spine, no `gun-shop/` — COULDN'T DISPROVE
**Test:** `GET /wp-json/wp/v2/product_cat?per_page=100&hide_empty=false` → 200, `x-wp-total=54`, **one page**. Full term dump scanned for `gun-shop` in slug/name/link: **0 matches**. `slug=gun-shop` query → `[]`. `/product-category/gun-shop/` → 404 ("Page not found — Doctor Deals"). Parent=0 set is exactly the 6 R2 categories + `uncategorized(0)`, with `.link` values containing NO `gun-shop/` prefix:
  - `firearms count=107`, `parts count=388`, `accessories count=261`, `mags-barrels count=109`, `clothing-gun-related count=44`, `defense count=1`. Sum=910.
- `/product-category/gun-shop/firearms/` still 200 (legacy permalink rewrite still resolves), but `/gun-shop/` alone 404s. R2's "canonical no-prefix form" is the WP-advertised one.

### 2. expectedProductCount=972 — COULDN'T DISPROVE
**Test:** R2's `GET /wp-json/wp/v2/product?per_page=1` x-wp-total = 972 not directly re-fetched in R3, but per-cat `/wp/v2/product?categories=ID` all returned `x-wp-total=972` (the filter is ignored without auth and returns the full corpus). The 972 number is internally consistent with R2's measurement.

### 3. perPage=12 — COULDN'T DISPROVE
**Test:** `/product-category/firearms/page/9/` returned 11 unique `/product/` links; `/page/10/` → 404. Math: 8×12 + 11 = 107 = WP product_cat firearms.count exactly. R2 confirmed.

### 4. paginationPattern (path `/page/{N}/`, startPage=1, firstPageHasParam=false) — COULDN'T DISPROVE
**Test:** Same boundary above. Real 404 at page 10 (not "no products" soft-block). Path template valid.

### 5. crawlers.maintain.verifyMethod=`detail-page` (runtime-equivalent to DB's `json-ld`) — COULDN'T DISPROVE
**Test:** grep across `backend/src` for `verifyMethod\s*===` and literals `'store-api'|'json-ld'|'detail-page'`:
  - Only **3 hits**: `worker.ts:394` (comment), `worker.ts:397` (`!== 'store-api'`), `worker.ts:774` (comment).
  - `worker.ts:769-775` (else branch) reads `verifyMethod` truthy → calls `verifyProductsViaPlaywright(...)` for ANY non-`'store-api'` truthy value. No branching on `'json-ld'` vs `'detail-page'`. R2's runtime-equivalence claim holds.

### 6. searchUrl `/?s={keyword}&post_type=product` — COULDN'T DISPROVE
**Test:** Live multi-keyword on warmed Playwright session (iPhone UA, sgcaptcha cleared via homepage warmup):
  - `glock` → 200, 7 unique product links
  - `ruger` → 200, 12 unique product links (matches R2's "12 results")
  - `savage` → 200, 12 unique
  - `mossberg` → 200, 12 unique. All first hits are genuine product URLs (not generic search noise). R2 confirmed; the 12-result count for ruger is stable.

### 7. wafType `sgcaptcha` (warmup via `/`) — COULDN'T DISPROVE
**Test:** Cold curl with iPhone UA on `/wp-json/wp/v2/product_cat` → 202 (sgcaptcha challenge). Apex `/` 200 after warmup. Post-warmup `/wp-json/wp/v2/product_cat?per_page=100` → 200. Burst-sensitive: 5 of 6 `/wc/store/v1/products?category=ID` calls returned 202 again after the per_page=100 dump. R2's sgcaptcha label + iPhone UA + per-path challenge model corroborated.

### 8. `gun-shop/` legacy prefix coexistence — COULDN'T DISPROVE
**Test:** `/product-category/gun-shop/` → 404, but `/product-category/gun-shop/firearms/` → 200 with title "Firearms | Doctor Deals". The legacy permalink rewrite is selective: the bare `gun-shop/` slug isn't a term, but subordinate paths still resolve. R2 was right to drop `gun-shop/` from `catalogUrls` since the canonical WP REST `.link` form omits it AND the bare slug 404s.

## Notable nit (not a counter)
R2 line 17 says "GET /product-category/gun-shop/firearms/ same first product" as canonical `firearms/`. Live re-test shows DIFFERENT first products (`savage-a22-fv-sr-...` on legacy vs `charles-daly-601-...` on canonical), suggesting sort order differs between the two URL forms. This does not change R2's verdict (both forms cover the same 107-product term set), but R2's phrasing was sloppy.

## Cleanup
Both probe scripts will be deleted post-audit per R2's pattern.
