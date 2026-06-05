# Wave 2 — Round 2 (live) Ledger — 2026-06-04

R2 = fresh testing-api-tester, gentle probes, runtime-code-traced. READ-ONLY.
R2 MATERIALLY revised R1's "all easy re-enables": 4 sites are clear, 3 have STRUCTURAL coverage blockers.

## CLEAR — apply fixes + re-enable (Phase B)

### thegundealer.ca (woocommerce) — EASY
- Safe to re-enable (WP REST 200, x-wp-total=11279; "search 404" is stale + search!=catalog). count->11279 (WP REST full corpus). productCountMethod wc-store-api-header->wp-rest-header (was silent-null). perPage 24->100. reset consecutiveFailures.

### gagnonsports.com (lightspeed) — EASY + IMPORTANT
- ADD the /firearms/* tree (6 productive leaves: air-guns 15, centerfire-rifles 47, rimfire-rifles 38, shotguns 79, used-rifles 39, used-shotguns 21 = 239; ~209 net-new firearm SKUs DB was missing). Keep DB 22 leaves (firearms tree subsumes old gun catalogUrls). perPage 100->24. count ~2915 (re-derive on bootstrap). archery + air-guns = operator scope flags. pagination suffix-replace confirmed. Re-enable safe.

### gobles.ca (lightspeed) — EASY + 2 real fixes
- catalogUrls: type-leaf UNION brand-leaf required (~499 firearms; brand-only catches O/U shotguns type tree misses). Fix 2 dead-404 knives URLs (numeric->brand slug).
- PAGINATION BUG (fulcrum-class, loses 83/category): bake page-1 params. paginationPattern -> {type:suffix-replace, match:"1.html?limit=100&sort=newest", template:"{N}.html?limit=100&sort=newest", perPage:100}; each catalogUrl ends page1.html?limit=100&sort=newest. firstPageHasParam is INERT (drop). count 3770->3876 (generic-product-sitemap valid — gobles SHOWS OOS so HTML reaches full sitemap). Re-enable safe. (rel=next param-drop in watermark getNextPageUrl = runtime concern, flag.)

### sail.ca (magento2 + Searchspring SPA) — RE-SCOPE then enable
- RE-SCOPE: catalogUrls 7-leaf -> ["/en/hunting"] (one URL = all 3223; DB 7 leaves cover 54.3%, miss 1474 firearm-relevant). count 18944->3223. perPage 100->24. needsPlaywright true (keep). productCountMethod stays sitemap-index (whole-store fallback; json-api-count harness gap blocks firearm-relevant count — see below). MUST re-scope BEFORE enabling or it re-stalls on the 780-page whole-store walk.

## STRUCTURAL BLOCKERS — need R3 + OPERATOR DECISION (do NOT blindly enable)

### store.prophetriver.com (bigcommerce-stencil, no GraphQL) — 6-PAGE CAP
- R1's count was a MEASUREMENT ERROR (5414). True sitemap = 14197; DB 13974 correct — KEEP ~14197.
- BLOCKER: BC Stencil hard-caps category pagination at 6 pages -> 12 top-level catalogUrls reach ~6700 max (47% of 14197). Subcat/brand facets are JS-hydrated (not static). Failure events unrecoverable (30d prune) but live path works -> safe to enable mechanically, but coverage ceiling is structural.
- DECISION: (a) bake ?limit=100 (~6700 reachable) + accept partial + set count to reachable; (b) multi-sort walk; (c) opt into GraphQL apiAlternative (JWT present?). R3 to explore.

### store.theshootingcentre.com (bigcommerce-stencil, no GraphQL) — COUNT-SURFACE FORK
- Surface = HTML category walk (apiAlternative=null -> GraphQL unused despite JWT present). BC hides OOS on category pages -> HTML reaches ~7482 in-stock browsable; sitemap = 17305 (incl ~10K OOS). Pairing 17305 with HTML surface reads ~43% forever.
- productCountMethod bc-xmlsitemap (bare string)->sitemap-index (NOT generic-product-sitemap — trailing-slash URLs). hasWaf true->false (R1 challenge marker = benign CF beacon). perPage 50->100. +/clearance/ (8 catalogUrls).
- DECISION: (a) opt into bigcommerce-graphql apiAlternative -> reach 17305 full; OR (b) keep HTML + set count = browsable ~7482. R3/operator.

### rdsc.ca (magento2) — QUERY PAGINATION BOT-GATED
- R1 MATERIALLY WRONG: ?p=N / ?product_list_limit / ?product_list_order are ALL INERT from our crawler (axios AND Playwright single-goto) — ?p=2 returns byte-identical page-1. Query-pagination walk reaches 24/9487 = 0.25%. This is why it stalled in March.
- count 9487 (toolbar). productCountMethod: DB {.toolbar-number, NO url} silent-nulls (defaults to homepage); R1's sitemap is CATEGORY-CONTAMINATED (over-counts 11247). Correct VERIFIED method: {html-pagination, selector:".toolbar-amount", perPage:1, url:"/new-products.html", regex:"of\\s+([\\d,]+)"} -> 9487.
- BLOCKER: no crawler-reachable traversal proven. NOT safe to enable as-is (would re-stall at 0.25%).
- R3 MUST: test full-browser Playwright (real navigation + cookies, not single-goto) to see if pagination works; inspect the pager's AJAX/XHR; find a non-query route. If none -> full-catalog-sweep/blocked candidate.

## CROSS-CUTTING (Wave 2 R2)
- **The BC count-surface fork is THE Wave-2 theme** (prophetriver, theshootingcentre): BC-no-GraphQL runtime HTML-walks -> reaches browsable/in-stock (or page-capped) subset, NOT the sitemap global. For accurate coverage either opt into GraphQL OR set count to the reachable browsable set. (gobles is the exception — it SHOWS OOS so HTML reaches the full sitemap.)
- **productCountMethod silent-null** recurs everywhere: bc-xmlsitemap bare-string (theshootingcentre), missing-url (rdsc DB), wrong-pattern generic-product-sitemap on trailing-slash (oleys/theshootingcentre). Need: method must have a `url`, a canonical name, and a pattern matching real <loc> shape.
- **Query-param pagination can be origin-inert/bot-gated** (rdsc Magento) — R1 "links exist" != "walk works". Must fetch ?p=2 and diff vs page-1.
- **harness gap (sail)**: product-count-probe.ts:265 json-api-count lacks the startsWith('http') absolute-URL guard (line 312 has it) -> foreign-origin Searchspring/Algolia count blocked.
- **Lightspeed page-1 pagination gap** (gobles): buildPaginatedUrl returns page-1 catalogUrl unchanged -> bare default-sort page 1 vs param page 2+ drops items 25-100/category. Bake params into the page-1 catalogUrl.

## OPEN FOR R3 (adversarial)
- rdsc: find a working crawler traversal or declare blocked/full-catalog-sweep.
- prophetriver: confirm the 6-page cap; best reachable strategy + count basis.
- theshootingcentre: GraphQL-opt-in vs browsable-count decision; verify ~7482 browsable union (cross-cat dedup).
- All count bases + the 4 clear sites' fixes (sanity adversarial pass).
