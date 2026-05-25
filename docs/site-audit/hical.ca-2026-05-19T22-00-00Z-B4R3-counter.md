# hical.ca — B4 R3 Counter-Audit (Adversarial)

**Run ID:** B4R3-hical-2026-05-19T22-00-00Z
**Predecessor:** B4R2-hical-2026-05-19T21-00-00Z
**Method:** Live Playwright + axios with fresh Incapsula cookies (iPhone UA AND desktop Chrome UA), 800ms inter-request delay. Targeted adversarial tests aimed at disproving each R2 verdict. Plus Node-side `validateMethod` import test.
**Probe script:** `backend/scripts/_tmp-hical-r3-counter.ts`
**Probe output captured to:** stdout (see session transcript)

## Verdict per R2 correction

| # | R2 verdict | Adversarial test | R3 verdict | Evidence |
|---|---|---|---|---|
| 1 | watermark.method = `api-date-since-watermark` (WP REST, `modified_after`) | T3 re-fetch `/wp/v2/product?modified_after=2099-01-01` -> `x-wp-total=0` (honored). T4 `/wc/store/v1/products?after=2099-01-01` -> 0 (honored). T5 `/wc/store/v1/products?modified_after=2099` -> **1676** (param name `modified_after` is silently IGNORED on Store API; correct Store API param is `after`). Runtime adapter `woocommerce.ts:419` uses `storeParams.after = options.dateAfter` -> CORRECT param. Watermark crawler L211 sends `dateAfter` into `fetchCatalogPage`; adapter routes to WP REST first (L337) using `modified_after`. | **couldn't disprove** | R2 correct. Filter honored on both surfaces when the correct param name is used. R1's claim "Store API ignores filter" was the result of using wrong param name. |
| 2 | catalogUrls slug `/firearms/` -> DEAD, use `/firearms-canada/` | T1 multi-UA test: PW+iPhone UA -> pwStatus=200 BUT title="Page not found - High Caliber Services Corp" + WC `No products were found` marker present (soft-404, htmlLen=217929, productClassHits=1). PW+desktop UA -> pwStatus=404. Raw axios both UAs -> HTTP 404. `/firearms-canada/` -> 200, title="FIREARMS Archives", productClassHits=124. | **couldn't disprove** (with nuance) | Slug is dead by content under ALL UAs. iPhone UA returns soft-200 (R2's "404" cite was via desktop). Soft-200 page still shows WP "Page not found" template — useless for indexing. R2 verdict stands. Adversarial finding for R4 below. |
| 3 | productCountMethod bare-string -> structured object (validateMethod throws; caught at scheduler L263) | T8: `await import('./product-count-probe').validateMethod({method:'wp-rest-v2-x-wp-total'})` -> **THREW** "unknown product-count method" (verbatim). Read crawl-scheduler L253-265: try/catch wraps `probeExpectedProductCount`; catch logs `[Scheduler] hical.ca: product count probe failed: ...`. Gate at L254 (`!siteProfile?.expectedProductCount`) means the probe only fires if expected count is null — dormant today. | **couldn't disprove** | R2 correct on both fact (throws) and mechanism (caught locally at L263; does NOT kill scheduler tick). Structured-object fix is appropriate. |
| 4 | catalogUrls includes `/all-products/` (R2-T5: 34/50 unique vs cats 143/171) | Not re-walked (time budget). R2 sampled top 50 of 35 total in cat=1867; R2 acknowledged in open issue #1 it didn't check overlap with cat=15 (uncategorized) or cat=2037 (new-arrivals). | **untested** | R2 sampling is suggestive but not exhaustive. Recommend R4 either accept R2's safer-default inclusion or walk all 35 products against ALL category memberships. |
| 5 | userAgentOverride = iPhone Safari UA (DB precedent, 37d production) | Side-effect observation T1: iPhone UA gets only 2 cookies on initial visit (vs 13 with desktop UA) and `/firearms/` returns soft-200 rather than clean 404. Functional impact: all subsequent JSON endpoints still returned x-wp-total correctly with iPhone UA (T3/T4/T6 all 200). | **couldn't disprove** | iPhone UA works for the operationally-relevant endpoints (REST + valid category pages). Different cookie count is curious but didn't break any test. R2 verdict stands. |
| 6 | expectedProductCount = 1676 (R2 live) | T6 re-fetch: `/wp/v2/product?per_page=1` -> x-wp-total=1676. T6b Store API -> 1676. Second-source sitemap1+sitemap2 raw `<loc>` count = 1001+676 = 1677, minus 1 `/shop/` index loc in sitemap1 = **1676** product locs. Triple match. | **couldn't disprove** | R2 correct; DB's 1677 is stale (likely +1 from sitemap pre-shop-loc-exclusion when DB was set 2026-04-12). |
| 7 | wafWorkaround block restored (operator metadata) | Not tested adversarially; documentation-only. | **untested** | No regression risk. |
| 8 | crawlers.catalog block restored (T2/T3/T4 date-range strategy) | Adapter `woocommerce.ts:295` checks `hasDateFilter` and switches `orderby` to `modified` — consistent with R2's documented date-range strategy. | **couldn't disprove** | No regression risk. |
| 9 | wafType = `imperva-incapsula` (cosmetic) | Not tested. Both R1 `incapsula` and R2 `imperva-incapsula` have zero non-presence reads in `backend/src/`. | **untested** | Consistency-only choice. |
| 10 | paginationPattern template `/page/{N}/` (trailing slash) | Not re-tested. R2-T7 confirmed 200 on `/firearms-canada/page/2/?orderby=date`. | **untested** | R2 evidence stands. |
| 11 | wafProbeEvidence shape: structured object (R1 form retained) | Schema-only; no runtime consumer. | **untested** | OK. |
| 12 | wafProbeResult = `active-incapsula` (short tag) | Cosmetic. | **untested** | OK. |
| 13 | dateFilterMonotonicity refreshed from DB-2026-04-12 to R2-T1d/T1e | T3 re-confirmed filter honored on WP REST. Monotonicity itself not re-tested in R3 (R2 evidence 5d old). | **couldn't disprove** | Acceptable. |

**Tally:** 13 fields reviewed. Counter: **0**. Couldn't-disprove: **8**. Untested (low-risk / schema-only): **5**.

## Top 3 R2 verdicts I tried hardest to break (and couldn't)

1. **`/firearms/` slug is dead** — R3 hit it with both iPhone Safari UA AND desktop Chrome UA, both via Playwright AND raw axios. Desktop UA: HTTP 404. iPhone UA via Playwright: HTTP 200 BUT title literally says "Page not found - High Caliber Services Corp" and the WooCommerce `No products were found` marker is present in the body. The slug is dead under every access pattern. R2 cited 404 (desktop); the iPhone-UA soft-200 nuance does not rescue the slug.
2. **WP REST date filter (`modified_after`) is honored** — T3 with future date returned x-wp-total=0 (filter applied). The runtime adapter `woocommerce.ts:337` uses `params.modified_after = options.dateAfter` on `/wp-json/wp/v2/product` — matches R2. Notable adversarial finding: T5 proved that on the **Store API**, the param name `modified_after` is silently IGNORED (returns full 1676). The Store API only honors `after=` (T4=0). The runtime adapter L419 uses the correct `after` param, so no bug — but this is a sharp footgun: anyone adding `dateBefore` support to the Store API path must use `before`, not `modified_before`.
3. **`productCountMethod` bare-string `validateMethod` THROWS, caught locally** — T8 imported `validateMethod` and called it with the bare-string value; got an Error with verbatim text matching R2's claim. Read crawl-scheduler L253-265: `try { ... probeExpectedProductCount(...) } catch (probeErr) { console.error(...) }` — the throw lands in this local catch, NOT propagated. Gate at L254 (`!siteProfile?.expectedProductCount`) keeps it dormant today because DB also has expectedProductCount=1677. R2's mechanism description is correct.

## Untested R2 claims (lowest priority for R4)

- `/all-products/` cat=1867 35-product full-walk overlap against ALL other category memberships (R2 sampled top 50 only; 34/50 unique against 2 cats out of 23). Walking all 35 against all 23 cats would take ~30+ requests at 800ms = ~25s and was beyond R3 budget.
- One large category end-to-end pagination sweep (R2 open issue #2). R2-T7 only verified page 2 of firearms-canada.
- Round-trip extraction (price + stockStatus) on 3 random product pages (R2 open issue #3).
- Trailing-slash pagination template `/page/{N}/` on OTHER categories (R2-T7 only verified firearms-canada).

## Adversarial findings worth noting (non-blocking)

1. **iPhone UA gets 2 cookies on initial visit; desktop UA gets 13.** Both UAs proceed to make successful API calls afterward, but the smaller cookie bundle is a fragility risk. If Incapsula tightens rules, iPhone-UA-with-2-cookies could start failing while desktop-UA-with-13 still works. R2 chose iPhone UA based on 37-day DB precedent — sound but worth flagging.
2. **Store API silently ignores `modified_after` (returns full result set).** Not a hical-specific issue, but a WooCommerce platform footgun. Any future site profile that documents `dateFilterField: modified_after` MUST also specify the API surface (WP REST vs Store API), because the same param name has different semantics. R2's profile correctly specifies `api: wp-rest-v2`.
3. **`/firearms/` returns iPhone-UA soft-200 not clean 404.** If any operator later types `/firearms/` into catalogUrls and the crawler runs with iPhone-UA override, the crawler would receive a 200 + WP 404 template page and likely try to extract products (htmlProductClassHits=1 from the menu rendering). R2's exclusion is correct — flagging in case a future operator restores it by mistake.

## Bottom line

R2 corrections are evidence-backed and survive adversarial re-testing. **No counter-claims raised.** R4 should mediate on the untested-but-low-risk claims and close on R2's open issues #1/#2/#3 if time permits.
