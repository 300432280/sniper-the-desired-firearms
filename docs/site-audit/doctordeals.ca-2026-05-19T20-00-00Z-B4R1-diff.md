# B4R1 Diff — doctordeals.ca

Candidate: `docs/site-audit/doctordeals.ca-2026-05-19T20-00-00Z-B4R1.json`
DB snapshot: `_audit_tmp/batch4-2026-05-19/doctordeals.ca-DB-snapshot.json` (DB siteProfile lastVerified=2026-04-06)

## Fields that AGREE (skipped from divergence list)
- `platform` = `woocommerce` (both)
- `adapterType` = `woocommerce` (both)
- `hasWaf` = `true` (both)
- `wafType` = `sgcaptcha` (both)
- `hasCaptcha` = `false` (both)
- `ageGate.detected` = `false` (both — DB has no ageGate field; treated as no-detection)
- `needsPlaywright` = `true` (both)
- `userAgentOverride` = iPhone Safari (both — DB pins iOS 17_2 / Safari 17.2; candidate uses iOS 17_0 / Safari 17.0. Functionally equivalent.)
- `sortParam` = `?orderby=date` (both)
- `productCountMethod.method` = `wp-rest-header` (both)
- `productCountMethod.endpoint` = `/wp-json/wp/v2/product` (both)
- `productCountMethod.header` = `x-wp-total` (both)
- `crawlers.watermark.method` = `api-date-since-watermark` (both)

## Divergent fields (10)

### 1. `catalogUrls` (CRITICAL)
- **DB**: 5 URLs under `/product-category/gun-shop/firearms/`, `/parts/`, `/accessories/`, `/clothing-gun-related/`, `/defense/`
- **Candidate**: `["https://doctordeals.ca/shop/"]` — single global URL
- **WHY**: Candidate's WC Store API category probe (per Stage 4a) found 7 top-level categories whose slugs were `firearms`, `parts`, `accessories`, `clothing-gun-related`, `defense`, `mags-barrels`, `uncategorized` — i.e. the API exposes categories WITHOUT the `gun-shop/` parent. The DB URLs use a `gun-shop/` URL-rewrite prefix the candidate's discovery never observed because it queried WC Store API and homepage anchors (which used `/product-category/<slug>/` without the gun-shop prefix). Two possibilities: (a) the site renamed its URL structure between 2026-04-06 (DB lastVerified) and 2026-05-19 (today); (b) the WC permalink rewrite uses a parent `/gun-shop/` slug that the API doesn't return. Candidate also missed the `mags-barrels` parent (109 products) that DB notes don't list — likely a newer category. The `/shop/` global URL is valid (verified, 577 results, complete coverage) — but it differs from DB's per-category spine.

### 2. `expectedProductCount`
- **DB**: `965`
- **Candidate**: `972`
- **WHY**: Both probe `/wp-json/wp/v2/product` x-wp-total. Catalog growth: +7 products since 2026-04-06 (DB lastVerified, 43 days ago) — consistent with the modified_after probe showing recent additions (top of newest list = 2026-05-06).

### 3. `perPage`
- **DB**: `20`
- **Candidate**: `12`
- **WHY**: DB value is the API-pull batch size (Store API `?per_page=20` for enrichment); candidate value is the HTML-listing perPage (`/shop/` returns 12 cards/page in Flatsome theme). These measure different surfaces. The DB value is reasonable for API-batch; candidate value matches the HTML walker.

### 4. `paginationPattern`
- **DB**: MISSING (not in siteProfile JSON)
- **Candidate**: `{type:"path", template:"/page/{N}", perPage:12, firstPageHasParam:false, startPage:1, zeroIndexed:false}`
- **WHY**: DB profile pre-dates this skill's required `paginationPattern` field — DB siteProfile was written before the field was added to the schema OR was never populated because the site uses API-first watermark (no HTML pagination needed). Candidate fills it for the HTML fallback path.

### 5. `crawlers.maintain.verifyMethod`
- **DB**: `json-ld`
- **Candidate**: `detail-page`
- **WHY**: Per the skill's table, all non-WC-store-api verify methods route through `verifyProductsViaPlaywright` (worker.ts:769). `json-ld` and `detail-page` are functionally equivalent at the runtime switch — both bypass the store-api fast path. DB used a more specific marker (json-ld extraction from product detail page); candidate chose the generic `detail-page`. Same runtime behavior.

### 6. `crawlers.maintain.method` ("db-verification") + `crawlers.maintain.cooldowns/tierShares/tierWindows`
- **DB**: Has `maintain.method = "db-verification"`, cooldowns/tierShares/tierWindows blocks
- **Candidate**: Only `verifyMethod` + `verifyEndpoint`
- **WHY**: DB carries operator-tuned tier configuration not part of the skill's pre-bootstrap output. The skill's Stage 9 only emits the runtime verify fields; tier scheduling is operator-overlay, added during DB promotion. Not a real divergence — different layers.

### 7. `crawlers.bootstrap` block
- **DB**: Full `bootstrap.apiEndpoints` block with priceEnrichment + productDiscovery + htmlFallback
- **Candidate**: ABSENT (per skill rule: "crawlers.bootstrap.apiEndpoints REMOVED from required/recommended fields ... zero runtime consumers ... operator documentation only")
- **WHY**: Skill rule (Output Target section) explicitly says don't emit this block. Candidate puts the equivalent info in `auditNotes.discoveredApiEndpoints`. Architectural skip, not a miss.

### 8. `dataFlow` block (DB has 2-step API workflow doc)
- **DB**: Two-step dataFlow: WP REST core for discovery, WC Store API for price/stock enrichment
- **Candidate**: ABSENT
- **WHY**: Same as bootstrap — this is operator-added documentation describing the dataFlow pattern, not a required runtime field. Operator can layer back on promotion.

### 9. `wafWorkaround`
- **DB**: `{method:"cookie-cache", cookieTtlMinutes:30, storeApiAvailable:true, steps:[...], notes:"Sucuri cookies"}` — notes refers to Sucuri (incorrect — actually sgcaptcha)
- **Candidate**: ABSENT (skill rule only emits when site has malformed headers requiring curl-spawn fallback)
- **WHY**: The skill's `wafWorkaround` is reserved for Celerant-style malformed-header sites; the sgcaptcha cookie-cache pattern is handled inside `waf-cookie-manager.ts` automatically based on `hasWaf=true` + `wafType=sgcaptcha`. DB has stale Sucuri-labeled notes (since corrected to sgcaptcha on the wafType field but not in the workaround notes).

### 10. `searchUrl`
- **DB**: `/?s={keyword}&post_type=product`
- **Candidate**: ABSENT (omitted — not probed during candidate generation)
- **WHY**: Stage 3 says "If the site has a keyword-search URL ... output `searchUrl`". The skill did not probe the search box in this run, so the field was omitted. DB has the canonical WC search URL. **This is a candidate miss** — the skill should have probed WP's `?s=` search.

### Other DB-only fields (NOT divergences — pre-existing operator overlay)
- `name`, `notes`, `budget`, `timeout`, `siteCategory`, `siteType`, `requiresAuth`, `requiresSucuri`, `hasRateLimit`, `t1IntervalMin` — operator/admin overlay fields, not part of skill output.

## Blockers
None. Candidate validates against profile-validator.ts shape (9 required + recommended fields populated).

## Top 3 surprising divergences (WHY)

1. **`catalogUrls` use `/product-category/gun-shop/<slug>/` (DB) vs `/shop/` (candidate)** — WC Store API category probe never returned a `gun-shop` parent slug; homepage anchors (captured during the Playwright sgcaptcha challenge) showed `/product-category/firearms/rifles/`, `/product-category/mags-barrels/` etc. WITHOUT the `gun-shop/` prefix. Either WC permalink rewrite or a recent restructure; the candidate's `/shop/` is functionally complete (covers all 577 in-stock products via pagination) but DB's per-category form is preferred for tier-scheduled crawls.

2. **`crawlers.maintain.verifyMethod`: DB `json-ld` vs candidate `detail-page`** — runtime-equivalent (both route to verifyProductsViaPlaywright per worker.ts:707-709), but operator chose `json-ld` to signal the specific extraction path (JSON-LD `<script type="application/ld+json">` parsing on the product detail page). Candidate's generic `detail-page` works but loses operator intent.

3. **`searchUrl` missing in candidate** — DB has `/?s={keyword}&post_type=product`, the canonical WooCommerce search URL. The skill's Stage 3 said to output `searchUrl` "when the site has a keyword-search URL" — this run did not probe the search box. Production WP sites uniformly support `?s=` search; candidate should have populated this by default.
