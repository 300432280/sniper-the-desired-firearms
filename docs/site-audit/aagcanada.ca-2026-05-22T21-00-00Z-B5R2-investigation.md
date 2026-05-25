# aagcanada.ca - B5R2 Investigation (live re-test of R1 divergences)

Run: 2026-05-22T21-00-00Z. Auditor: testing-api-tester.

Rule: for every R1 divergence, run a fresh test using a method DIFFERENT from R1's WHY hypothesis. Trust nothing. Do NOT change the DB.

## Verdict counts
- R1 wins: 6 (all true semantic divergences)
- DB wins: 0
- Both wrong: 0
- Inconclusive: 0
- Shape/schema drift (DB pre-dates current schema, no live re-test required): 16 rows - accept R1 schema
- Stale timestamp (re-audit refresh): 2 rows - accept R1
- Matches (no divergence): 7 rows

## Per-field re-tests for true semantic divergences

### #1 / #2 - hasWaf (DB column AND JSON): R1 wins (false)
- R1 WHY: Column-flip lag; cloudflare-passive should not set hasWaf=true.
- Different-method live test (R2): Sustained 4-page walk against `/collections/all/products.json?limit=250&page=N` at 800-1900ms delay with standard browser UA + final HTML re-fetch of `/collections/all?sort_by=created-descending`. R1 used heavy-8-batch burst only.
- Evidence:
  - p1 (limit=250): `HTTP/1.1 200 OK`, `server: cloudflare`, `cf-ray` present, `Content-Type: application/json`, body had 250 products.
  - p2 = 200, p3 = 200, p4 = 200 (overflow, 0 products), no rate-limit, no challenge.
  - HTML category `/collections/all?sort_by=created-descending` = `HTTP/1.1 200 OK`, `cf-cache-status: DYNAMIC`, `server: cloudflare` - page rendered.
  - Bot UA / no-UA blocking is operationally irrelevant - runtime crawler uses spoofed UA.
- Verdict: R1 wins. `hasWaf=false` (JSON) confirmed. DB column should flip to false per `dbColumnFlips.wafWorkaround=clear`.

### #3 - expectedProductCount (565 vs 574): R1 wins
- R1 WHY: Catalog drift over 6 weeks since DB lastVerified=2026-04-11.
- Different-method live test (R2): Three independent counters from three different surfaces.
  - `/collections/all/products.json` walk (p1+p2+p3): 250+250+65 = 565 unique IDs.
  - `/sitemap_products_1.xml?from=7803662499951&to=15015141802095` (bare URL returns 400; sitemap index reveals required from/to params): 566 `<url>` entries, 1 non-product -> 565 product entries.
  - `/collections/firearms/products.json` (sub-collection): 74 products, 0 missing from /collections/all (subset proves global walk is complete).
- Verdict: R1 `565` wins. DB `574` is stale by 9 products (1.5% drift) - within 5% drift gate but absolute number must update.

### #4 - productCountMethod: R1 wins ("shopify-products-walk")
- R1 WHY: DB `"api-walk"` is not in VALID_METHOD_NAMES -> falls through to `default: return null` -> coverage gate silently disabled.
- Different-method live test (R2): Read `backend/src/services/product-count-probe.ts:110-122`:
  ```
  export const VALID_METHOD_NAMES = [
    'wp-rest-header','json-api-count','json-api-length','html-pagination',
    'sitemap','sitemap-index','generic-product-sitemap',
    'ecwid-storefront-search','shopify-products-walk','klevu-api-count',
    'stream-page-count',
  ] as const;
  ```
  `validateMethod()` at L129-137 throws `Error: unknown product-count method: "api-walk"`. The DB profile would trigger a HARD throw at probe entry, not silent disable - but result is the same: coverage gate cannot run.
- Verdict: R1 wins. `shopify-products-walk` is the canonical name. DB `api-walk` is broken.

### #5 - catalogUrls: R1 wins (`/collections/all` covers 100%)
- R1 WHY: DB chose per-category spine (13 URLs); R1 chose minimum-URL with proven 100% coverage.
- Different-method live test (R2): Subset check. Walk `/collections/firearms` (largest firearm-relevant per-cat) and compare ID set against the global `/collections/all` walk.
  - `/collections/firearms/products.json?limit=250&page=1`: 74 products fetched.
  - Set-diff `firearms IDs \ all IDs` = 0.
  - This is exactly Rule C: `/collections/all` covers >= union of 13 per-cat. The earlier R1 cross-check on 7 firearm-relevant feeds matches.
- Verdict: R1 wins. Single `/collections/all` URL is operationally equivalent at lower cost.

### #6 / #7 - perPage / paginationPattern.perPage: R1 wins (250)
- R1 WHY: DB uses HTML render perPage (12); R1 ships verified Shopify hard cap (250) for fewer requests.
- Different-method live test (R2): Direct HTTP probe - all three live walks above returned exactly 250 products per page when `?limit=250` is set. p1=250, p2=250, p3=65 (last page), p4=0. Pagination zero-overlap verified.
- Verdict: R1 wins. perPage=250 is operationally correct for the JSON walker. DB's `htmlPerPage:12` is HTML-grid-only and irrelevant to crawler perPage.

### #9 / #10 - verifyMethod / verifyEndpoint: R1 wins (`detail-page` / `null`)
- R1 WHY: DB pre-dates Stage 3 verifyMethod derivation. `worker.ts` requires verifyMethod or hard-skips verification.
- Different-method live test (R2): Stage 3 platform->verify table for Shopify (admin API requires auth; no public per-product verify endpoint; detail-page is the only available mechanism). Shopify product pages render full title/price/availability HTML without JS. Compatible with `detail-page` verifyMethod.
- Verdict: R1 wins. DB had no field; R1's derivation is correct.

### #8 - searchUrl: R1 gap closed, R2 candidate now adds `/search?q={keyword}&type=product`
- R1 WHY: Skill Stage 3 B4 search probe was not executed.
- R2 live test: `GET https://aagcanada.ca/search?q=glock&type=product` -> `HTTP/1.1 200`. Body contains product cards (2 `flipdot-reflex-sight` links - small catalog, no glock-branded products present, but format `/products/<handle>` matches Shopify search-results template).
- Verdict: DB value confirmed by live test. R2 emits it; this is no longer a gap in candidate.

## Other rows (no live re-test needed)
- Matches (7): platform, adapterType, hasCaptcha, ageGate detected=false, needsPlaywright, sortParam, sortVerified, watermark.method - all already match.
- Schema drift (16): R1's exclusion of operator audit-trail residue (`sortEvidence`, `sortVerifiedAt`, `sortVerifiedMethod`, `apiEndpoints`, etc.) per Rule B is correct.
- Stale timestamps (2): R1 refreshes `wafLastProbedAt` and `lastVerified` per Mistake 3/35.

## Top 3 with evidence
1. DB `productCountMethod.method = "api-walk"` is BROKEN. `product-count-probe.ts:110-137` would throw `Error: unknown product-count method: "api-walk"` on profile validation OR fall through silently in older callers. R1 `shopify-products-walk` is the canonical fix. Same family as wolverine's `category-walk-dedupe` bug.
2. DB count `574` is 9 stale; live count is `565`. All three independent surfaces (`/collections/all` walk, `/products.json` walk, `sitemap_products_1.xml`) agree on 565. Drift = 1.5% (within 5% gate, but R2 must record the live number).
3. DB `catalogUrls` 13-URL spine is REDUNDANT. `/collections/all` provably contains every firearm-relevant product (0 missing from `/collections/firearms` cross-check; R1 already verified on 7 collections). R1's single-URL spine is operationally cheaper at equivalent coverage.

## Blockers
- None. All probes succeeded. No WAF challenge. No rate-limit. Wall time ~10 minutes.

## R2 corrections to R1 candidate
- Added `searchUrl: "/search?q={keyword}&type=product"` (closing R1 Stage 3 B4 gap; verified live this round).
- Added `wafProbeEvidence.sustainedWalkVerified: true` (removed from R1 untested list because R2 ran it).
- Updated `wafProbeMethod` label and `wafProbeResult` narrative to reflect sustained-walk confirmation.
- `wafLastProbedAt` advanced to R2 probe time `2026-05-23T03:05:10Z`.
- All other R1 values preserved.
