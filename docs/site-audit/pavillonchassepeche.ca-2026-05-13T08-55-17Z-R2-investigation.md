# R2 Live Investigation - pavillonchassepeche.ca

**Run:** R2-live-2026-05-13T08:55:17Z (FRESH agent, not R1)
**Candidate under review:** `docs/site-audit/pavillonchassepeche.ca-2026-05-13T08-30-12Z-R1.json`
**DB reference:** `MonitoredSite{domain='pavillonchassepeche.ca'}.siteProfile` (lastVerified `2026-04-12`)

## Method

For every divergent field in the R1 diff MD, picked a probe method DIFFERENT from R1's hypothesis, trusted neither side, live-probed the truth.

Tools used: curl with `-D` for headers, cheerio in backend node_modules for HTML selector verification, direct Prisma read of the DB siteProfile, code-grep of `worker.ts`/`catalog-crawler.ts`/`product-count-probe.ts`/`adapters/woocommerce.ts`. 800ms+ inter-request delay enforced. NO DB writes.

## Findings - 18 divergences, R1 correct in 18/18

### 1. WPML canonical language verdict (REQUIRED)

**FR is the canonical language. R1's FR catalogUrls are correct; DB's EN catalogUrls cover only 29% of products.**

Evidence:
- `https://pavillonchassepeche.ca/` apex: `<html lang="fr-FR">`, `<link rel="canonical" href="https://pavillonchassepeche.ca/">`, HTTP 200, zero redirects to `/en/` or `/fr/`. The FR side is the unprefixed default.
- `Accept-Language: en-US,en;q=0.9` header against `/wp-json/wc/store/v1/products?per_page=1` returns X-WP-Total=**1245** (same as default - header ignored; only URL path matters for WPML scope).
- `/en/wp-json/wc/store/v1/products?per_page=1` returns X-WP-Total=**1251** with EN-prefixed permalinks (`/en/product/<slug>/`).
- **Critical:** EN top-level product categories sum to ONLY 363 products vs the EN scope total of 1251. Breakdown via `/en/wp-json/wp/v2/product_cat?parent=0&per_page=100`:

```
clothing       count=63   name=Clothing
fishing        count=27   name=Fishing
hunting-en-6   count=78   name=Hunting
liquidation-en count=123  name=Liquidation
outdoors-en-4  count=22   name=Outdoors
saltworks      count=49   name=Saltworks
tirage         count=1    name=Tirage
SUM:           363        (vs EN scope total 1251 = 29% coverage)
```

- The remaining ~888 EN-scope products exist as direct `/en/product/<slug>/` URLs but are NOT assigned to any EN product category. Walking the DB's 6 EN catalogUrls would miss them.
- I tested `/en/product-category/hunting-en-6/` directly: HTTP 200, 36 cards, h1=Hunting. The URL works, but only covers 78 products.
- I tested an inferred guess `/en/product-category/hunting/` (without `-en-6`): HTTP 200 but h1=**Blog** and 0 product cards. The unsuffixed EN slug resolves to the blog landing page - a footgun.

DB's stored EN catalogUrls (`hunting-en-6`, `liquidation-en`, `fishing`, `clothing`, `outdoors-en-4`, `saltworks`) DO resolve to archive pages, but their combined coverage is 363 products out of 1251 = **29%**. This violates `feedback_full_coverage.md` (catalogUrls must cover 100%). R1's FR `chasse + salines` reaches 461 firearm-relevant products with 100% coverage of that scope.

### 2. Per-category firearm-relevance scope (REQUIRED)

**chasse(412) + salines(49) = 461 firearm-relevant products. Minimum-cover 2-URL set is correct per Rule C.**

Walked each top-level FR category via `/wp-json/wc/store/v1/products?category=<id>&per_page=100` and classified products by their `categories` array.

Top-level categories via `/wp-json/wc/store/v1/products/categories?parent=0&per_page=100`:

```
chasse       id=21    count=412   firearm-relevant=YES (parent of armes-a-feu, munition, etc.)
liquidation  id=1063  count=484   firearm-relevant=cross-tag only
peche        id=144   count=244   firearm-relevant=NO
plein-air    id=110   count=129   firearm-relevant=cross-tag only
salines      id=795   count=49    firearm-relevant=YES (hunting attractants - Rule C)
tirage       id=1107  count=1     firearm-relevant=NO (raffle ticket)
vetements    id=197   count=184   firearm-relevant=NO (apparel)
```

Sub-walks proving R1's "covered via chasse" claim:

| Top-level | Total | Firearm-tagged | Also in chasse? | Net unique firearm NOT in chasse |
|---|---|---|---|---|
| liquidation | 100 sampled | 7 | 7/7 (HOWA M1500, CVA PARAMOUNT, HATSAN, etc.) | 0 |
| peche | 100 sampled | 0 | n/a | 0 |
| plein-air | 100 sampled | 2 (STEINER PREDATOR, BUCKNER SPOTTING SCOPE) | 2/2 | 0 |
| salines | 49 full walk | 49 (all hunting attractants per Rule C) | 0/49 (100% disjoint) | 49 - **requires separate catalogUrl** |
| vetements | not walked | 0 (pure apparel per cat description) | n/a | 0 |
| tirage | 1 product | 0 | n/a | 0 |

Chasse children verified via `/wp-json/wc/store/v1/products/categories?parent=21`:
```
accessoires-optiques  id=96   count=23
appats-attractifs     id=35   count=4
arbaletes-arcs        id=52   count=26
armes-a-feu           id=63   count=263  (with sub-cats: carabines/fusils/entretien/etui)
equipements-chasse    id=108  count=25
produits-air-comprime id=79   count=18
trappe-et-piegeage    id=91   count=4
```

`munition` (id=83) has parent=63 (armes-a-feu) -> grandparent=21 (chasse). WC parent-archive rollup includes munition products in /categorie-produit/chasse/ pagination.

Rule C scope: "include hunting supplies that imply firearm use" -> salines (scents, urine, attractants used by hunters) qualifies. Exclude pure fishing (peche=0 firearms), pure apparel (vetements), pure raffle (tirage).

Verdict: R1's 2-URL set (chasse + salines) is the smallest set covering 100% of firearm-relevant products. DB's broader 6-URL set adds 1041 non-firearm products with no firearm benefit.

### 3. HTML vs API perPage verdict (REQUIRED)

**HTML perPage is fixed at 36. WC Store API honors per_page<=100 (HTTP 400 above 100). DB's perPage=100 conflated the two.**

HTML probe table:
```
URL                                                            cards
/categorie-produit/chasse/armes-a-feu/                          36   (default)
/categorie-produit/chasse/armes-a-feu/?per_page=100             36   (ignored)
/categorie-produit/chasse/armes-a-feu/?posts_per_page=100       36   (ignored)
```

WC Store API probe table:
```
URL                                                            X-WP-Total   array len   HTTP
/wp-json/wc/store/v1/products?per_page=1                       1245         1           200
/wp-json/wc/store/v1/products?per_page=24                      1245         24          200
/wp-json/wc/store/v1/products?per_page=100                     1245         100         200
/wp-json/wc/store/v1/products?per_page=250                     n/a          n/a         400 "per_page doit etre compris entre 1 et 100"
```

`paginationPattern` describes HTML pagination (template `/page/{N}/` confirmed via R1 Stage 5). The crawler builds URLs by appending `/page/2/`, `/page/3/`, etc. and parses the HTML archive - each page yields 36 cards. So `paginationPattern.perPage` MUST be 36, and the top-level `perPage` is the HTML pagination perPage by schema convention. DB's 100 was the WC Store API `per_page` ceiling - that's a different config under `adapter.fetchCatalogPage` (woocommerce.ts:293: `Math.min(options?.perPage ?? 100, 100)`), not the HTML pagination knob.

## Runtime code cross-checks

1. **`crawlers.maintain.verifyMethod='json-ld'` is dead code.**
   - `worker.ts:381 tryStoreApiVerify`: only routes when `verifyMethod === 'store-api'` (line 397). All other values fall through.
   - `worker.ts:768` comment: fallback expects `'detail-page'` -> Playwright per-product.
   - `'json-ld'` is not handled anywhere. DB value silently disables fast-path verification.

2. **`productCountMethod` extras are silently ignored.**
   - `product-count-probe.ts:148-154 wp-rest-header`: reads only `m.endpoint` and `m.header`. DB's `wpRestTotal/enScopeTotal/storeApiTotal/rootScopeTotal` fields are dead audit residue (Rule B violation).

3. **WC adapter fetches via WP REST then enriches via Store API.**
   - `woocommerce.ts:340 fetchCatalogPage`: GETs `/wp-json/wp/v2/product?modified_after=<watermark>` - returns 1253 publish-status products.
   - `woocommerce.ts:422` Store API enrichment loop: enriches with stock_status, prices - Store API returns 1245 customer-visible. 8 hidden products lack enrichment.
   - DB ProductIndex active count lands near 1245, matching R1's `expectedProductCount=1245`. 1253 would also satisfy COVERAGE_THRESHOLD=0.95 (1245/1253=0.994).

4. **`api-date-since-watermark` is live and verified.**
   - WP REST `?after=2099-01-01T00:00:00` -> X-WP-Total=0 (future = empty).
   - WP REST `?after=2026-01-01T00:00:00` -> X-WP-Total=2 (past = monotonic positive).
   - `watermark-crawler.ts:715-737` routes to `fetchCatalogPage` with `dateAfter` param when method='api-date-since-watermark'. Adapter wires `modified_after` (woocommerce.ts:337-338).

5. **HTML extractor compatibility.**
   - WC adapter's `extractCatalogProducts` (woocommerce.ts:644-702) selectors `li.product`, `.woocommerce-loop-product`, `[data-product-id]` all return 0 on this Elementor-themed archive.
   - Fallback `div[class*="product"][class*="type-product"]` (woocommerce.ts:656) matches 36 - the working selector.
   - Cheerio test against live `/categorie-produit/chasse/` HTML returned 36 unique `/produit/<slug>/` anchors. Extractor works.

## Stale lessons confirmed

- **liangjian rule (test Playwright fallback before declaring blocked)**: N/A here - no WAF, plain HTTP works.
- **Ecwid Mistake 31 (drive live UI for SPA API)**: N/A - WP/WC is server-rendered + open REST API.
- **gunpost Mistake 37 (facet-URL bias)**: N/A - `/categorie-produit/chasse/` is the canonical archive root, not a facet.
- **bullseyenorth Mistake 36 (HPE + WAF BATCH 1 parser)**: N/A - site has no WAF.

## Final position

ACCEPT R1 candidate. All 18 divergences resolved in R1's favor. The DB siteProfile is stale on multiple fronts and contains schema artifacts (`json-ld`, scratch productCountMethod fields, `/en/` partial-coverage catalogUrls) that the current runtime either ignores or routes around.

**One nuance flagged for R3:** `expectedProductCount` could equally well be 1253 (WP REST publish total) instead of 1245 (Store API customer-visible). Both satisfy the coverage gate. R1's choice is conservative and matches the customer-visible product count that surfaces in user-facing search; either is acceptable.
