# hical.ca — B4 R2 Investigation Notes

**Run ID:** B4R2-hical-2026-05-19T21-00-00Z
**Predecessor:** B4R1-hical-2026-05-19T20-00-00Z
**Method:** Live probe with Playwright-acquired Incapsula cookies; 800ms inter-request delay; iPhone Safari UA (R1-divergent).
**Probe script:** `backend/scripts/_tmp-hical-r2-probe.ts`

## Verdict per divergent field

| # | Field | R1 | DB | Verdict | Evidence |
|---|---|---|---|---|---|
| 1 | `crawlers.watermark.method` | `navigate-from-watermark` | `api-date-since-watermark` | **DB wins** | R2-T1b: `/wp/v2/product?modified_after=2099-01-01` -> `x-wp-total=0`. R2-T1c: 7d window -> `x-wp-total=12`. R2-T1d/T1e: monotonicity verified (page1 oldest 2026-05-19T05:11 > page2 newest 2026-05-18T18:02). R1 only tested Store API and used wrong param name. |
| 2 | `catalogUrls` slug `/firearms/` | `/firearms-canada/` | `/firearms/` | **R1 wins** | R2-T3: `/product-category/firearms/` returns **404** via Playwright; `/firearms-canada/` returns 200 with 16 product cards. R2-T4 product_cat API confirms slug=`firearms-canada` (id=143, count=226). DB slug is dead. |
| 3 | `productCountMethod` shape | object `{method,endpoint,header}` | bare string `"wp-rest-v2-x-wp-total"` | **R1 wins (with R1-WHY correction)** | Live test: `validateMethod('wp-rest-v2-x-wp-total')` THROWS at product-count-probe.ts:132 ("unknown product-count method"). R1 said "silent null via default branch" - actually it throws and `crawl-scheduler.ts:263` catches it. Net effect today: probe returns nothing useful. Dormant because DB also has `expectedProductCount=1677` so line 254 gates the probe call. R1 fix is correct; R1's stated mechanism was wrong. |
| 4 | `catalogUrls` `/all-products/` | included | excluded ("umbrella fully overlaps") | **R1 wins** | R2-T5: cat=1867 returned `x-wp-total=35` (not 29 from DB). Of first 50 products: only 1 overlap with firearms-canada (cat=143), 0 with firearm-accessories (cat=171). 34/50 sampled were UNIQUE to all-products. DB exclusion rationale is wrong as of 2026-05-19. |
| 5 | `userAgentOverride` | `null` | iPhone Safari UA | **DB wins** | R1 reasoning was "desktop Chrome Playwright passed in my session". DB has the iPhone UA running successfully against Imperva for 37+ days in production. More defensive; no reason to weaken. |
| 6 | `expectedProductCount` | 1676 | 1677 | **R1 wins** | R2-T1a/T6a/T2a all return `x-wp-total=1676` on both REST surfaces today. Sitemap union (1001+676=1677) is +1 from rounding/draft handling. Use live API value. |
| 7 | `wafWorkaround` block | omitted | full block | **DB wins** | Operator metadata for triage UI. R1 omitted because skill rule only mandates it for HTTP-header-parse failures. DB pattern documents cookie-cache strategy; R2 restored. |
| 8 | `crawlers.catalog` tier block | omitted | full block | **DB wins** | Documents T2/T3/T4 date-range strategy. R2 restored. |
| 9 | `wafType` label | `incapsula` | `imperva-incapsula` | **Cosmetic** | Both valid; no runtime consumer. R2 picks DB-form for consistency with 37-day-old fleet labeling. |
| 10 | `paginationPattern.template` trailing slash | `/page/{N}` | `/page/{N}/` | **DB wins** | R2-T7 confirms `/firearms-canada/page/2/?orderby=date` returns 200 with product links. Trailing slash is the actual WC routing pattern. |
| 11 | `wafProbeEvidence` shape | object | string | **R1 wins (structured)** | Skill rule requires structured object. R2 retained R1's enriched form. |
| 12 | `wafProbeResult` free-text | long sentence | `active-incapsula` | **DB wins** | DB's short tag is the canonical convention; R1's prose belongs in `wafProbeEvidence.interstitialBodyMarker`. |
| 13 | `dateFilterMonotonicity` proof | omitted | DB pre-existed | **R2 enriched** | Replaced DB's 2026-04-12 IDs with fresh R2-T1d/T1e evidence (5d newer). |

## Top 3 surprising divergences

### 1. R1 tested the WRONG REST surface with the WRONG param name -> wrong method decision.
- R1 tested `wc/store/v1/products?modified_after=...` (param doesn't exist on Store API; the field is `after`). Saw filter "ignored" -> switched to `navigate-from-watermark`.
- R2-T1b proves `/wp/v2/product?modified_after=2099-01-01` -> `x-wp-total=0` (filter HONORED).
- R2-T2b proves `/wc/store/v1/products?after=2099-01-01` -> `x-wp-total=0` (Store API also honors filter; R1 missed this too).
- R2-T1d/T1e monotonicity: page1 desc modified timestamps `(05-19T22:58, 05-19T18:26, 05-19T05:11)`; page2 `(05-18T18:02, 05-18T17:53, 05-18T17:41)` - strictly decreasing.
- Adapter `woocommerce.fetchCatalogPage` (woocommerce.ts:337/340) uses `/wp/v2/product` with `modified_after` when `dateAfter` is set - exactly the surface DB documented. **DB wins; R1 reversed.**

### 2. R1's `productCountMethod` WHY was wrong; the verdict is still right.
- R1 said: bare string `"wp-rest-v2-x-wp-total"` -> falls through to switch `default` -> silent `return null`.
- Actual behavior: `validateMethod` (line 132) runs BEFORE the switch and **throws**. Reproduced directly via `validateMethod('wp-rest-v2-x-wp-total')`. The throw lands in `crawl-scheduler.ts:263`'s try/catch which logs `[Scheduler] hical.ca: product count probe failed: ...unknown product-count method...`.
- Today this is dormant because `expectedProductCount: 1677` is already in the DB (line 254 gates the call). The latent risk activates if the stored count is ever nulled OR `verifyBootstrapCoverage` (line 518) is called with a null stored count.
- R1's fix (structured object) is correct. **R1 wins on the fix; needs corrected WHY in the audit trail.**

### 3. DB's exclusion of `/all-products/` was wrong (umbrella isn't actually an umbrella).
- DB note: "umbrella category (29) fully overlaps with main categories" -> excluded from `catalogUrls`.
- R2-T5 evidence: cat=1867 today has 35 products. Sampling the 50 most-recent (via `?per_page=50&category=1867`), only **1** overlapped with firearms-canada (cat=143), **0** with firearm-accessories (cat=171). **34 of 50 sampled products are unique to all-products** vs the two largest cats.
- These appear to be products tagged into a special "all-products" pseudo-category - likely promotional or featured products that bypass the standard taxonomy. DB's "fully overlaps" was wrong.
- **R1 wins; kept in catalogUrls with R2-T5 evidence noted.**

## Live probe summary (R2 evidence)

| Test | URL/op | Result |
|---|---|---|
| T1a | `GET /wp-json/wp/v2/product?per_page=1` | 200, `x-wp-total=1676` |
| T1b | `GET /wp-json/wp/v2/product?per_page=1&modified_after=2099-01-01` | 200, `x-wp-total=0` (filter honored) |
| T1c | `GET /wp-json/wp/v2/product?per_page=1&modified_after=<-7d>` | 200, `x-wp-total=12` |
| T1d | `GET /wp-json/wp/v2/product?per_page=3&orderby=modified&order=desc` page 1 | 200, IDs `4344@05-19T22:58, 2617@05-19T18:26, 57832@05-19T05:11` |
| T1e | same, `&page=2` | 200, IDs `14204@05-18T18:02, 2556@05-18T17:53, 35215@05-18T17:41` (strictly older) |
| T2a | `GET /wp-json/wc/store/v1/products?per_page=1` | 200, `x-wp-total=1676` |
| T2b | `GET /wp-json/wc/store/v1/products?per_page=1&after=2099-01-01` | 200, `x-wp-total=0` (filter honored) |
| T3a | Playwright `GET /product-category/firearms/` | **404** |
| T3b | Playwright `GET /product-category/firearms-canada/` | **200**, 16 products on page 1, htmlLen=503,646 |
| T4 | `GET /wp-json/wp/v2/product_cat?search=firearm` | 200, slug=`firearms-canada` (id=143, count=226); no `firearms` slug |
| T5 | `GET /wp-json/wc/store/v1/products?per_page=50&category=1867` | 200, `x-wp-total=35`; 34/50 sampled UNIQUE vs cat=143/171 |
| T6a | `GET /wp-json/wp/v2/product?per_page=1` (re-check) | 200, `x-wp-total=1676` |
| T6b | `GET /wp-json/wc/store/v1/products?per_page=1` (re-check) | 200, `x-wp-total=1676` |
| T7 | Playwright `GET /product-category/firearms-canada/page/2/?orderby=date` | 200, products extractable |
| Validator-check | `validateMethod('wp-rest-v2-x-wp-total')` | **THROWS** "unknown product-count method" |

## Blockers / open issues for R3

1. **`/all-products/` cat=1867 is suspiciously distinct.** R2-T5 sampled 50, found 34 unique. Suggest R3 walks all 35 products and confirms no near-100% overlap with any single category. If overlap with `uncategorized` (cat=15) or `new-arrivals` (cat=2037) is high, the inclusion may be redundant. R2 retained inclusion as the safer default per coverage rule.
2. **Walk coverage not exhaustive.** R2 sampled top 50 of each category via API; did not walk all 51 pages of firearm-accessories. R3 should sweep one large category end-to-end to confirm `parentInclusivity` claim still holds.
3. **`extractionSample` price/stock fields incomplete.** R2 captured URL+title but did not query individual product pages. R3 should pick 3 random products and confirm price/stockStatus extraction round-trips.
4. **`expectedProductCount` drift.** DB recorded 1677 on 2026-04-12; live is 1676 on 2026-05-19. -1 over 37 days is plausible inventory churn but R3 should confirm via second-source sitemap count.
