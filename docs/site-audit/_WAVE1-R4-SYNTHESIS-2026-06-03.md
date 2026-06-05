# Wave 1 — Round 4 Synthesis (final corrections + lessons) — 2026-06-03

6 near-ready parked sites. 4-round adversarial audit (R1 blind testing-api-tester -> R2 live testing-api-tester
-> R3 engineering-code-reviewer adversarial -> R4 orchestrator synthesis). All R2 corrections survived R3;
deltas noted below. READ-ONLY through R4; DB writes happen in Phase B.

## CROSS-CUTTING LESSONS LEARNED (the SKILL.md / runtime / harness gaps)

### L1 (SKILL.md) — count-surface rule: expectedProductCount MUST match the surface the RUNTIME crawls
- WooCommerce -> runtime walks WP REST `/wp-json/wp/v2/product` global = FULL corpus incl OOS. count = WP REST x-wp-total. (pavillon 1253, rangeview 5454, shooterschoice 11409.)
- BigCommerce WITH `apiAlternative.type='bigcommerce-graphql'` -> runtime uses GraphQL `products` global walk = customer-visible = products sitemap. count = sitemap total. (oleys 3509.) [Full coverage is the `products` query, NOT `newestProducts` which is T1-only + 50/page-capped.]
- BigCommerce WITHOUT GraphQL apiAlternative -> generic-retail.fetchCatalogPage returns null -> runtime HTML-walks category pages = IN-STOCK browsable union only (OOS excluded from category listings; NO indexer reads the products sitemap). count = in-stock category union, NOT sitemap. (wolverine ~5754; truenortharms 1125.)
- Picking count method by platform alone ("BC->sitemap") is WRONG when the runtime can't reach that surface. wolverine sitemap=8235 but reachable~5754 -> using 8235 reports ~70% forever.

### L2 (SKILL.md + harness) — productCountMethod must be validated against the site's ACTUAL <loc> URL shape + canonical key
- `generic-product-sitemap` default pattern is `\.html?(?:$|[?#])`; on trailing-slash product URLs (oleys) it matches 0 -> silent null. The method object key must be `url` (not `endpoint`). The R2-proposed `generic-product-sitemap` fix would have re-introduced the silent-null on both counts. Correct generic fix for a product-only sitemap with non-.html URLs = `{method:"sitemap", url:"..."}`.
- Non-canonical method labels (bc-xmlsitemap, dual-api, wp-rest-api, wc-store-api-header) throw in validateMethod -> caught -> null (silent). Already a known theme; reconfirmed.

### L3 (SKILL.md + harness) — heavy 8-batch WAF probe BANS IP-reputation WAFs
- Imunify360 (pavillon) hard-banned our crawl IP on the heavy probe's burst/SQLi/XSS/honeypot batches (transient, recovered). For already-onboarded sites use GENTLE header-only detection. The heavy probe should gate off its aggressive batches when the site is already in DB / when an IP-reputation marker (imunify, openresty 415) appears.

### L4 — hasWaf=true + cloudflare-passive is an invalid combo (over-throttles); flipping to false is a behavior switch
- rangeview + shooterschoice had stale hasWaf=true (+ stale labels: shooterschoice "wordfence" with zero markers; rangeview "requiresSucuri" col on a Cloudflare site). Flip to false. NOTE: false disables cookie-acquisition + 307/403 retry paths (safe while CF stays passive). All WAF verdicts are this-IP (= production IP) — fine.

### L5 — catalogUrls are runtime-INERT for API-first paths (WooCommerce API, BC GraphQL); load-bearing ONLY for BC-no-GraphQL HTML walk
- Don't over-optimize inert catalogUrls. DO ensure completeness on HTML-walk sites (wolverine keep-14; /shop-all/ misses newest).

### L6 — index-bloat cleanup is glacial by design for generic-retail (no fast bulk path, correct per the 4956-incident rule)
- truenortharms: 3675 dead rows clear at <=10/tick via daily stale-check ~ 1 year. The bulk-reconciliation fast path is gated to woocommerce/shopify only. Fast safe purge needs a separate per-product-confirmed-404 pass (operator decision).

## PER-SITE FINAL CORRECTIONS (Phase B apply list)

### pavillonchassepeche.ca (woocommerce) — NEAR-READY (~100% indexed)
- expectedProductCount 1318 -> **1253**; expectedInStockCount 1291 -> 1226.
- catalogUrls: KEEP broad (6 EN or 7 FR incl tirage) — NOT 3. [operator locale choice; inert]
- hasWaf already false (no change). productCountMethod wp-rest-header (ok).

### rangeviewsports.ca (woocommerce) — NEAR-READY (~98%)
- expectedProductCount 5407 -> **5454**.
- perPage 500 -> **100**. hasWaf true -> **false**; clear `requiresSucuri` column.
- catalogUrls 10-cat -> **["/shop/"]** (inert; ~99.5%/340pg). searchUrl ok.

### shooterschoice.com (woocommerce) — BACKFILL (62% of 11409)
- expectedProductCount 11370 -> **11409** (WP REST full corpus).
- hasWaf true -> **false**; wafType -> **cloudflare-passive** (drop wordfence).
- catalogUrls inert (keep). FOLLOW-UP: confirm stock-only flip bumps WP `modified` (restock lynchpin, 60% OOS).

### wolverinesupplies.com (bigcommerce-stencil, no GraphQL) — BACKFILL (~73%)
- expectedProductCount 8193 -> **in-stock category union (~5754; set to reached active at crawl plateau)** — NOT sitemap 8235, NOT hand-pick 5689. productCountMethod -> pagination-walk basis (not sitemap).
- catalogUrls KEEP the 14. perPage -> 100 (no-op for type:query). hasWaf false (confirmed). Normalize streamState www.->apex (minor).

### oleysarmoury.com (bigcommerce-stencil, GraphQL) — BACKFILL (~60%)
- expectedProductCount 3368 -> **3509**.
- productCountMethod bc-xmlsitemap -> **{method:"sitemap", url:"/xmlsitemap.php?type=products&page=1"}** (NOT generic-product-sitemap — would silent-null on trailing-slash URLs + endpoint/url key mismatch). [R3 corrected R2 here]
- hasWaf already false. sortParam keep ?sort=newest/true (R1 NOOP refuted). catalogUrls cleanup (add firearms cats, drop /decals//swag/) optional/inert.

### truenortharms.com (bigcommerce-stencil, no GraphQL) — SPECIAL: INDEX BLOAT
- expectedProductCount 1264 -> **1125**. productCountMethod KEEP sitemap-index (valid). catalogUrls drop `/vip-club/` (404).
- Reset frozen T4 `firearms:4` (in_progress page 90) -> idle/page 1 on enable, else computeSafeWindow stays pinned.
- INDEX BLOAT: 4658 active vs 1125 live; ~3570-3675 confirmed-dead (97% 404 on two independent samples). Restart-crawl is SAFE (bulk path gated to wc/shopify; generic-retail skips it; 983 live rows protected). CLEANUP = OPERATOR DECISION: (a) slow default (daily stale-check 10/tick ~ 1yr) or (b) fast safe per-product-confirmed-404 pass (~3675 paced fetches). Coverage stays inflated until cleaned.

## R4 CONTESTED-FIELD RESOLUTIONS (R2 vs R3)
- oleys productCountMethod: R3 wins (sitemap, not generic-product-sitemap). APPLIED to final list.
- wolverine count: R3 refinement (in-stock union ~5754 via reached-active, not R2's 5689 hand-pick). APPLIED.
- rangeview /shop/ coverage: R3 wording (~99.5%, 340pg) — inert, no material change.
- All other fields: R3 "couldn't disprove" -> R2 stands.
