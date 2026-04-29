---
name: catalog-urls-full-coverage-design-rule
description: catalogUrls MUST cover 100% of products with minimum overlap. Discovery method is flexible (API, nav crawl, taxonomy recursion, sitemap mining) as long as efficient and non-banning. catalogUrls feed Tier 1 crawl on sites without sufficient API access.
type: feedback
originSessionId: 0e25b91d-3faf-45c8-a84d-fc6dca43f333
---
# catalogUrls = full coverage with minimum overlap (T1 dependency)

**Rule:** The set of `catalogUrls` discovered by Room 3 MUST cover 100% of the site's products with minimum overlap. Discovery method is flexible — API, nav crawl, taxonomy tree recursion, sitemap mining, /shop-2/-style "view all" pages — whatever combination is most efficient. Two hard constraints: efficient (don't probe needlessly) and non-banning (respect rate limits, no parallel hammering).

**Why:** User clarified on 2026-04-26 after seeing canadafirstammo (WooCommerce) Room 3 hard-fail with drift 86.59% (walked 129 vs API 962):
> *"eventually I need all the catalog URL to cover all the products with minimum overlap, I don't care how you discovery them, as long as it is efficient and respect the target site won't get us banned. the catalog URL will be used later for T1 to crawl (for site that doesn't have enough api access)"*

This means catalogUrls are NOT just "HTML fallback for API sites" (the playbook Mistake 9 framing) — they are the PRIMARY crawl path for any site without sufficient API access. T1 walks them to find new products. If they don't cover 100%, T1 silently misses products forever.

**How to apply:**

1. **Discovery is multi-source, not single-source:** Don't return immediately on first successful API call. Combine taxonomy API + nav crawl + (when needed) "view all" page + (when needed) sitemap-derived collections. Merge into one set, dedupe.
2. **Verify coverage before declaring success:** for sites where parent listing doesn't include child products (e.g. Minimog WooCommerce theme, BC Stencil truenortharms), include leaf categories. Walk-test: page 1 of parent vs page 1 of one child — if child has products NOT in parent, child must be in catalogUrls.
3. **Minimum overlap, not zero overlap:** some duplication is OK if a product appears in multiple natural categories. But don't include both `/firearms/` and `/firearms/rifles/` if `/firearms/` already covers all rifles.
4. **NEVER drop categories for being "too small"** — even 1-product categories must be in the set if they contain a unique product. (Already in `feedback_full_coverage.md` and crawler-specialist persona.)
5. **Efficiency constraint:** the cost of probing many candidate URLs adds up. Batch the verification probes (e.g. all top-level cats fetch in parallel within rate limits, then leaf-cat probing only for cats where parent doesn't include children).
6. **Anti-ban constraint:** 2-3s delay between fetches per site (already enforced for fleet probing). NO parallel hammering of the same site. Standard browser UA. Heavy probe tools (heavy-waf-probe.sh) are sequential by design.
7. **Walk-verify drift gate semantics:** spec §4.3's drift = |walked - globalCount| / globalCount × 100 ≤ 5% pass criterion still applies. If walking the discovered catalogUrls doesn't reach the API-reported globalProductCount, that's evidence catalog discovery is incomplete OR the count probe is wrong — investigate, don't soften the gate.
8. **For sites where catalog walking can't be exhaustive** (jPages SPAs, single-product custom PHP sites, some classifieds with infinite scroll): prefer API/sitemap as the count source AND list catalogUrls as best-effort entry points. Document this in the profile so T1 knows to use API path.

**T1 dependency context:** `backend/src/services/watermark-crawler.ts` and the catalog tier engine read `siteProfile.catalogUrls` to know what to walk for new-product detection. If catalogUrls misses a category, T1 never sees products in that category until a manual rescue. Past incidents (truenortharms 92% coverage user-rejected; doctordeals "Sights" category dismissed by name) cost real product visibility.

**Affected files:**
- `backend/scripts/probe/room3-geography-count/catalog-urls.ts` — must do multi-source discovery + leaf-cat detection
- `backend/scripts/probe/room3-geography-count/walk-verify.ts` — drift gate consumes catalogUrls coverage
- `MonitoredSite.siteProfile.catalogUrls` — DB column consumed by T1 watermark-crawler

**Current gap (2026-04-26):** Room 3 catalog discovery only takes top-level WP REST `product_cat` entries with parent === 0. Nav-merge added (one-shot for /training/-type missing top-level cats). Subcategory recursion / "view all" page detection / leaf-cat verification still missing.
