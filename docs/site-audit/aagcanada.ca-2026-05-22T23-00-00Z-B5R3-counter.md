# aagcanada.ca - B5R3 Counter (adversarial disproof of R2)

Run: 2026-05-23T03:00-03:35Z. Auditor: engineering-code-reviewer.

Rule: 3x-broaden every R2 numerical claim, mark harness-blocked probes as `untested-by-harness`, re-test most-recent merged fix (`ee63f12 fix(runtime): five batch-3 R4 verdict bugs` -> introduced `validateMethod`) against this site.

## Verdict counts
- COUNTER: 0
- couldn't-disprove: 6 (all R2 corrections survived adversarial testing)
- untested-by-harness: 1 (search-result template verified live, but full search adapter exec not run)

## Per-correction adversarial tests

### R2 #1 - `productCountMethod = "shopify-products-walk"` -- couldn't-disprove
- R2 claim: DB `"api-walk"` would now throw via `validateMethod()` (recently merged in `ee63f12`); canonical is `shopify-products-walk`.
- Adversarial test: Direct grep of `backend/src/services/product-count-probe.ts:110-122` -- VALID_METHOD_NAMES contains exactly the 11 R2 cited; `"api-walk"` not present. `validateMethod()` at L129-137 throws `Error: [productCountProbe] unknown product-count method: "api-walk"`. Switch case at L300-315 handles `shopify-products-walk` with `endpoint || '/products.json'`, `perPage || 250`, dedupe-by-id, walk-until-empty. Re-test against current `origin/main` HEAD (post-`ee63f12`): the hard-throw fires before any switch dispatch, so DB profile crashes the probe.
- Verdict: R2 correct.

### R2 #2 - `expectedProductCount = 565` -- couldn't-disprove
- R2 claim: 565 unique across `/collections/all` walk + sitemap + `/collections/firearms` cross-check.
- Adversarial test (3x broadening: 4th independent surface, 12-walk sustained vs R2's 4, different day from R2): Walked **root `/products.json?limit=250&page=N`** (NOT `/collections/all/products.json` as R2 used) for pages 1-5: p1=250, p2=250, p3=65, p4=0, p5=0; unique ID count = **565**. Re-pulled `sitemap_products_1.xml?from=7803662499951&to=15015141802095` independently: 566 `<url>` entries -> 565 with `<loc>` matching `/products/...`. Cross-collection union of 5 firearm-relevant collections (firearms+bayonet+magazine-clips+scope-sights+tactical-gear) = 178 unique IDs, 0 missing from `/collections/all`. Three independent surfaces (root products.json, sitemap, sub-collection union) all consistent with 565.
- Verdict: R2 correct.

### R2 #3 - `hasWaf = false` -- couldn't-disprove
- R2 claim: Sustained 4-page walk against `/collections/all/products.json` at 800-1900ms = all 200; no challenge.
- Adversarial test (3x: 12 pages vs 4, rotated 3 UAs Windows/Mac/Linux Firefox, 850ms delay): 12/12 = HTTP 200. No Cloudflare interstitial, no cf-mitigated header, no 429. Tested on root `/products.json` AND `/collections/all/products.json` AND `/collections/all` HTML AND `/search?q=rifle` -- all 200 across rotated UAs. Cloudflare passive-only confirmed.
- Verdict: R2 correct. `hasWaf=false` survives.

### R2 #4 - `catalogUrls = ["/collections/all"]` -- couldn't-disprove
- R2 claim: `/collections/all` contains every product in 13-URL spine; 1-URL is operationally cheaper.
- Adversarial test (broaden subset coverage from R2's 1 collection to 5): Union of firearms+bayonet+magazine-clips+scope-sights+tactical-gear = 178 unique product IDs. Set-difference against `/collections/all` 565-ID universe: **0 missing**. R2's R1 claim holds under broader coverage.
- Verdict: R2 correct.

### R2 #5 - `perPage = 250` and `paginationPattern.perPage = 250` -- couldn't-disprove
- R2 claim: Shopify hard cap = 250; live walks returned exactly 250 per page.
- Adversarial test: Confirmed via root `/products.json?limit=250` walk -- p1, p2 = 250 exact rows; p3 = 65 (last page < perPage); p4 = empty. Shopify `/products.json` honors limit=250; DB `htmlPerPage=12` was HTML-render-grid, not API.
- Verdict: R2 correct.

### R2 #6 - `crawlers.maintain.verifyMethod = "detail-page"` -- couldn't-disprove
- R2 claim: Shopify has no public per-product verify endpoint; detail-page is the only path; `worker.ts:769-781` requires verifyMethod.
- Adversarial test: Read `worker.ts:765-781` -- if verifyMethod missing, error logged + return (no verification). If present (any value), `verifyProductsViaPlaywright` is called. So `detail-page` triggers playwright detail-page render; null silently disables verify. R2 selecting `detail-page` matches platform default in Stage 3 table.
- Verdict: R2 correct.

### R2 #7 - `searchUrl = "/search?q={keyword}&type=product"` -- untested-by-harness
- R2 claim: live-tested URL returns HTTP 200 with product cards.
- Adversarial test: `GET /search?q=rifle&type=product` -> HTTP 200, 302 KB HTML; grep returns multiple `href="/products/<handle>"` matches in result-set HTML. Format consistent with Shopify search template. **However**: end-to-end runtime adapter search call NOT executed (would require full scraper harness boot). Result template structure confirmed live, runtime adapter consumption left as `untested-by-harness` per calibration rule 2.
- Verdict: live HTTP layer matches R2; runtime adapter parse path is harness-blocked from this auditor seat.

## Most-recent-merged-fix re-test (calibration rule 3)
- HEAD = `6851ac7 Merge fix/batch-3-runtime-bugs-2026-05-19 into main`. The fix that matters here is `ee63f12 fix(runtime): five batch-3 R4 verdict bugs` which introduced `validateMethod` in `product-count-probe.ts:129-137`. Without this commit, DB `"api-walk"` falls to the `default` branch and returns `null` silently. With this commit (now in main), it throws loudly. R2's correction `shopify-products-walk` is required for the probe to function under both regimes (silent-null AND throw).

## Top 3 (no counters - R2 holds)
1. **shopify-products-walk**: VALID_METHOD_NAMES grep at `product-count-probe.ts:110-122` confirms DB `"api-walk"` throws under current HEAD. R2 corrects this; cannot be disproved.
2. **565 count**: Four independent surfaces (root `/products.json` walk, `/collections/all` walk from R2, sitemap_products_1.xml, sub-collection union of 5 collections) all agree on 565. 3x broadening (12 pages, rotated UAs, sub-collection union) cannot reduce confidence.
3. **hasWaf=false**: 12/12 sustained walk at 850ms rotated across 3 production-grade UAs, no challenge / no rate-limit / no cf-mitigated. Cloudflare is decoration-only on this host.

## Adversary's note
R2 is unusually clean. Every numerical claim verified from a different surface than R2 used, every code path traced to a specific line + switch case. The only legitimate "we didn't fully test" leftover is the search adapter's end-to-end product-extraction (live HTML proves the template; harness-blocked from confirming the adapter parses it).
