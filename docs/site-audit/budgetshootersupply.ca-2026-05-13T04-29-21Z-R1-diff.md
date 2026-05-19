# Calibration diff — budgetshootersupply.ca — R1 (2026-05-13)

**Candidate:** `docs/site-audit/budgetshootersupply.ca-2026-05-13T04-29-21Z-R1.json`
**DB profile last verified:** 2026-04-11

## Convergent (no divergence)
- `platform` = `woocommerce`
- `adapterType` = `woocommerce`
- `hasWaf` = `false`
- `hasCaptcha` = `false`
- `userAgentOverride` = `null`
- `needsPlaywright` = `false`
- `sortParam` = `?orderby=date`
- `sortVerified` = `true`
- `searchUrl` = `/?s={keyword}&post_type=product`
- `crawlers.watermark.method` = `api-date-since-watermark`
- `crawlers.maintain.verifyMethod` = `store-api`
- `crawlers.maintain.verifyEndpoint` = `/wp-json/wc/store/v1/products`
- `wafProbeMethod` = `heavy-8-batch`
- WAF probe verdict (no CDN, SQLi/XSS 403 from origin mod_security)

## Divergent fields (15)

| # | Field | DB | R1 | One-line why |
|---|---|---|---|---|
| 1 | `expectedProductCount` | `2756` | `1586` | DB counts WP REST `/wp/v2/product` x-wp-total (all-published incl. drafts/private); R1 used Store API customer-visible (today 1586, was 1598 in DB note - also slight inventory drift). |
| 2 | `productCountMethod.endpoint` | `/wp-json/wp/v2/product` | `/wp-json/wc/store/v1/products` | Same reason as #1 - DB tracks full inventory, R1 chose customer-visible. |
| 3 | `catalogUrls` | `["/products/"]` (1 URL, "HTML fallback reference only") | 22 per-category URLs | R1 picked top-level `product_cat` taxonomy URLs; DB picked a single global aggregator because WP REST `product_cat` doesn't recurse to children (DB chose API-only path). |
| 4 | `paginationPattern.type` | `api-page` | `path` | DB targets API crawl pagination (`?page=N`); R1 targets HTML category page pagination (`/page/N/`). |
| 5 | `paginationPattern.template` | `page={N}` | `/page/{N}/` | Same crawl-path divergence as #4. |
| 6 | `crawlers.bootstrap.method` | `single-continuous` + `htmlFallback: false` | absent | R1 produced only `apiEndpoints`, did not mark bootstrap method or htmlFallback flag. |
| 7 | `crawlers.bootstrap.apiEndpoints.productDiscovery` | `/wp-json/wp/v2/product` | key renamed to `wpRestProduct` (same endpoint) | R1 invented a different key naming convention. |
| 8 | `crawlers.bootstrap.apiEndpoints.priceEnrichment` | `/wp-json/wc/store/v1/products` | key renamed to `wcStoreProducts` | Same rename divergence. |
| 9 | `apiDateFilter` (object: param=`modified_after`, format=ISO8601, monotonic evidence) | present | absent | R1 only stated `?after=` in `crawlers.watermark.reason`; DB uses `modified_after` (different param), with full evidence. |
| 10 | `sortVerifiedMethod` | `api-id-jump` | absent | DB uses API id-jump (page1 first=96950, page2 first=94725, monotonic descending); R1 used HTML 3-outcome counter-control instead. |
| 11 | `htmlCrawlViable` | `false` | implicit `true` | DB declared the HTML shop is AJAX-loaded; R1 saw 12 real product cards per HTML category page and chose HTML path. R1 tested category pages NOT the `/products/` global shop - the DB note specifically said the shop page is broken, not category pages. |
| 12 | `htmlCrawlNote` ("Woodmart AJAX shop, only 5 sidebar widgets in static HTML; full product grid requires JS") | present | absent | DB note applies to `/products/` global; R1 tested `/product-category/<slug>/page/N/` which renders static HTML cards. Both can be true. |
| 13 | `theme` = `woodmart` | top-level field | only in `auditNotes.platformFingerprints` | R1 didn't surface theme as a discrete field. |
| 14 | `dataFlow` (2-step pipeline doc) | present | absent | DB has operator-curated data-flow doc; R1 doesn't emit it (it's audit-trail residue per Rule B, but DB treats it as runtime metadata). |
| 15 | `wafProbeEvidence` format | string summary | structured object | DB stores a prose line; R1 emits the structured object the SKILL.md specifies. |

## Cross-checked finding
DB note "WP REST API product_cat filter does NOT recurse into children" is CORRECT and IMPORTANT:
- `GET /wp-json/wp/v2/product?per_page=1&product_cat=162` (ammunition) returns `x-wp-total: 5` (only direct-assigned products, no children).
- `GET /wp-json/wc/store/v1/products?per_page=1&category=162` returns `x-wp-total: 98` (recurses into all 12 children).
R1 used Store API counts as evidence; OK for Store API runtime, but if the operator switches to WP REST `?product_cat=N` per-category bootstrap path, coverage would silently collapse. R1's `auditNotes.parentCategoryQuirk` mentioned the Woodmart tile-page behavior but missed the API-level recursion gotcha.

## Most surprising divergences

1. **DB's `productCountMethod` targets WP REST (full inventory, 2756) instead of Store API (customer-visible, 1586/1598).** SKILL.md priority order says "platform's customer-visible total" first. DB chose the broader count. R1 followed SKILL.md priority, but the difference (1170 products - 42% gap) is large enough that the operator definitely intended the broader count for back-in-stock alerting. Either SKILL.md priority needs a note for WooCommerce (Store API hides OOS), or DB needs to switch.

2. **`apiDateFilter.param` = `modified_after`, NOT `after`.** R1 verified the `?after=` filter works, but DB uses `?modified_after=` which captures both new products AND updates to existing products (more useful for watermark crawl). SKILL.md Stage 7 only mentions `?after=`, never `?modified_after=`. R1 missed the better param.

3. **`htmlCrawlViable: false` divergence on category pages.** DB universally declared HTML unreliable based on the `/products/` shop page (Elementor-built, only 7 unique products). R1 tested `/product-category/<slug>/page/N/` and saw 12 static product cards extracting cleanly, so it chose 22 category URLs. But DB's API-only design implicitly assumed all HTML paths are equally broken; both views coexist. The R1 catalogUrls list IS extractable but pushes work the DB profile deliberately routed to the API.

## SKILL.md harness gaps (3)

1. **Stage 7 doesn't mention `?modified_after=` as a watermark-filter alternative.** SKILL.md says "`<base>/wp-json/wp/v2/product?after=2099-01-01T00:00:00`" - but `?modified_after=` is the param real-world calibration uses because it catches stock-status updates and reprices, not just new products. Stage 7 needs an "additionally probe `?modified_after=`" step + record both in `apiDateFilter` (param + format + monotonic evidence).

2. **Stage 8 priority order doesn't address WC Store-vs-WP-REST count tradeoff.** SKILL.md lists `wp-rest-header` once with `/wc/store/v1/products` as primary example. For WooCommerce specifically there are TWO valid endpoints (`/wc/store/v1/products` = customer-visible, drops OOS; `/wp/v2/product` = all-published incl. drafts) with very different numerics. The skill should explicitly call out: pick the broader (`/wp/v2/product`) count if back-in-stock alerting matters, otherwise customer-visible. The R1 ran chose narrower without questioning.

3. **Stage 4 doesn't note WP REST `product_cat` filter does NOT recurse to children, while WC Store API category filter DOES recurse.** R1 fetched per-category counts via Store API (98 for ammunition incl. all subcat products) and used them as evidence of coverage. If the operator ran the same crawl against WP REST `?product_cat=162`, they would get 5 products - not 98 - and conclude the catalog crawl is broken. DB's `catalogUrlsNote` correctly captures this. Stage 4 should explicitly require the auditor to test recursion on the platform's specific API before choosing per-category URLs.
