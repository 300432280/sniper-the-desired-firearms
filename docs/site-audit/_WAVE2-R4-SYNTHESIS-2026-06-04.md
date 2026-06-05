# Wave 2 — Round 4 Synthesis (Phase-B apply spec) — 2026-06-04

R3 adversarial REVERSED 2 of R2's 3 "structural blockers" (prophetriver, rdsc = false blockers / R2 artifacts)
and corrected real errors in the clear-4. Final per-site Phase-B spec below. Operator chose: FIX the shared
BC-GraphQL stock mapping (affects theshootingcentre + oleys).

## CROSS-CUTTING LESSONS (Wave 2)
- **"widget shows N pages" != "walk caps at N"** (prophetriver): BC Stencil pagination is a sliding window; "Next" advances past the visible numbers. Must fetch ?page=N past the window and diff. R2 wrongly inferred a 6-page cap.
- **www<->apex redirect that STRIPS the query string** (rdsc): stored url=www.rdsc.ca -> crawler builds www...?p=N -> 301 to apex drops ?p=N -> page-1 loop forever (0.25%). Generic trap. Check "does the redirect preserve the query string?"; use canonicalHost. THIS is rdsc's real root cause, not bot-gating.
- **BC-GraphQL stock mapping bug** (generic-retail.ts:856-857): reads availabilityV2.status (="Available" for visible, not stocked) instead of inventory.isInStock -> marks whole catalog in_stock, kills restock detection. Affects ALL bigcommerce-graphql sites (oleys live now + theshootingcentre). FIX: query inventory{isInStock}, derive stock from it (fallback to status). Shared-code -> 3-role harness + fleet regression.
- **productCountMethod silent-null** (recurring): must have a `url`, canonical name, and a pattern matching the real <loc> shape. gagnon .showing_result absent (dead); rdsc DB no-url (defaults to homepage); thegundealer wc-store-api-header (works generically but rename).
- **Lightspeed page-1 pagination gap** (gobles/gagnon): buildPaginatedUrl returns page-1 catalogUrl unchanged -> bare default-sort p1 vs param p2+ -> drops/misorders. Bake page-1 params into the catalogUrl. DB gobles template literal "pageN.html" never substitutes {N} (doubly broken).
- **Searchspring defaultPerPage != cap** (sail): cap is 100 not 24.
- **harness gap (sail)**: product-count-probe.ts:265 json-api-count lacks startsWith('http') guard (line 312 has it).

## PHASE-B PER-SITE SPEC (final)

### thegundealer.ca (woocommerce) — APPLY + ENABLE (easy)
expectedProductCount->11279; productCountMethod->wp-rest-header; perPage->100; enable + reset consecutiveFailures.

### prophetriver.com (bigcommerce-stencil, HTML walk) — APPLY + ENABLE (R2 blocker was false)
KEEP count ~14197 (DB 13974 ok; R1's 5414 was wrong); productCountMethod sitemap-index (pages 1+2) correct; optional: bake ?limit=100 into the 12 catalogUrls (5x token saving, not required); leave apiAlternative unset; enable + reset failures. Reaches 99.7% via "Next"-link walk.

### rdsc.ca (magento2) — APPLY + ENABLE (R2 blocker was false; host bug)
**url -> apex `https://rdsc.ca`** (drop www — THE load-bearing fix). Reset streamState (currently junk: a categories.php BC URL on a Magento2 site) -> re-detect /new-products.html?p=N spine. perPage->24 (or bake ?product_list_limit=48 into the page-1 catalogUrl). productCountMethod->{html-pagination, url:"/new-products.html", selector:".toolbar-amount", perPage:1, regex:"of\\s+([\\d,]+)"} -> 9487. count 9487. Fix lastWatermarkUrl host too. enable + reset failures. Reaches 100%.

### gobles.ca (lightspeed) — APPLY + ENABLE (high-confidence)
catalogUrls = type-leaf + brand-leaf union, each baked as `<leaf>page1.html?limit=100&sort=newest`; fix 2 dead knife URLs (numeric->brand slug /knives/boker/ /knives/browning/). paginationPattern->{type:"suffix-replace", match:"1.html?limit=100&sort=newest", template:"{N}.html?limit=100&sort=newest", perPage:100} (DB's literal "pageN.html" is broken). count 3770->3876 (generic-product-sitemap, /sitemap.xml, pattern \.html$). drop firstPageHasParam (inert). enable + reset failures.

### gagnonsports.com (lightspeed) — APPLY + ENABLE (use R3's CORRECT leaf paths)
catalogUrls = DB 22 + 8 firearms leaves (R3-verified paths, NOT R2's abbreviated ones which 404):
`/firearms/new-firearms/{air-guns,centerfire-rifles,restricted-firearms,rimfire-rifles,shotguns}/` + `/firearms/used-firearms/{used-restricted,used-rifles,used-shotguns}/`. perPage->24. Bake page-1 sort param (same as gobles: catalogUrls end page1.html?sort=newest; pattern match "1.html?sort=newest"). count method .showing_result is DEAD (null-gate; acceptable but note) — or set a working sitemap/walk count. archery + air-guns = operator scope (keep for now). enable + reset failures.

### sail.ca (magento2 + Searchspring SPA) — APPLY + ENABLE (re-scope + pin count)
catalogUrls -> ["/en/hunting"] (covers all 3223; DB 7 leaves miss 45%). **PIN expectedProductCount=3223** (NOT left at sitemap-index whole-store 18777, else 17% coverage-gate deadlock forever). perPage->100 (NOT 24; Searchspring cap is 100 — but verify the Playwright SPA honors page-size before committing). needsPlaywright true. enable + reset failures. (json-api-count harness-gap patch is a separate optional code fix to enable firearm-relevant auto-count.)

### theshootingcentre.com (bigcommerce-stencil) — AFTER the GraphQL code fix
apiAlternative.type='bigcommerce-graphql' (graphqlOrigin via JWT cors, currencyCode CAD, tokenScrapeUrl '/'); expectedProductCount->17305; productCountMethod->sitemap-index (/xmlsitemap.php?type=products pages 1-3, MUST entity-decode &amp;amp;); hasWaf->false; perPage->100; catalogUrls 7->8 (+/clearance/, HTML fallback). PREREQ: the shared inventory.isInStock mapping fix must land + pass oleys regression first.

## SHARED CODE FIX (3-role harness; operator-approved)
generic-retail.ts ~770-796 (productsQuery): add `inventory { isInStock }` to the query.
generic-retail.ts ~856-857 (stock mapping): derive stock_status from `inventory.isInStock` (true->in_stock, false->out_of_stock); fall back to availabilityV2.status only when inventory absent.
Regression: re-verify oleys (live BC-graphql) stock_status now reflects real OOS; check any other bigcommerce-graphql fleet sites. tsc clean + tests.
