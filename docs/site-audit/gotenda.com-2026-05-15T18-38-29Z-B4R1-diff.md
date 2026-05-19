# Diff: candidate (B4R1) vs DB siteProfile - gotenda.com

**Candidate:** `docs/site-audit/gotenda.com-2026-05-15T18-38-29Z-B4R1.json`
**DB row:** `MonitoredSite` where `domain='gotenda.com'`
**Validator on candidate:** valid=true, score=100, no failures

Each row: `field | candidate | DB | one-line WHY hypothesis`.

## Top-level MonitoredSite columns

| field | candidate | DB | WHY |
|---|---|---|---|
| `adapterType` | `woocommerce` | `woocommerce` | match |
| `hasWaf` | `true` | `true` | match (Sucuri detected live + DB) |
| `hasCaptcha` | `false` | `true` | DB sets true based on script-tag presence; SKILL Stage 2 final paragraph says hasCaptcha is operational - recaptcha-v3 from Contact Form 7 doesn't gate /shop or /product-category/, so operational=false |

## siteProfile fields

| field | candidate | DB | WHY |
|---|---|---|---|
| `platform` | `woocommerce` | `woocommerce` | match |
| `adapter` / `adapterType` | `woocommerce` | `woocommerce` | match |
| `wafType` | `sucuri` | `sucuri` | match |
| `hasWaf` | `true` | `true` | match |
| `wafLastProbedAt` | `2026-05-15T18:26:42Z` | (missing) | candidate adds fresh probe timestamp; DB profile predates the field |
| `wafProbeMethod` | `heavy-8-batch` | (missing) | same - DB profile predates this field |
| `wafProbeResult` | one-line summary | (missing) | same |
| `wafProbeEvidence` | structured object (headers, cookie name, rapid-burst status) | (missing) | same - Rule B residue from older audit format wasn't captured |
| `wafWorkaround.method` | `cookie-cache` | `cookie-cache` | match |
| `wafWorkaround.reason` | one-line | DB has multi-step + cookieTtlMinutes=30 + storeApiAvailable=true | DB carries operator-curated runtime detail; skill schema is shape-only |
| `captchaType` | `recaptcha-v3` | (missing in profile JSON; `hasCaptcha=true` column) | candidate records the type explicitly while declaring not gating |
| `ageGate` | `{detected:false,type:null,bypassCookie:null}` | (missing) | candidate adds explicit Stage-3 negative; DB predates schema |
| `userAgentOverride` | iPhone Safari UA | (missing) | candidate adds explicit override; DB relies on default |
| `needsPlaywright` | `false` | `true` | DB conservatively true because Sucuri solver needs Playwright once. Candidate reads needsPlaywright as RUNTIME field - production HTTP path is plain after waf-cookie-manager solves. Two valid readings; spec leans candidate's way (`needsPlaywright` describes runtime catalog fetch, not bootstrap solver) |
| `expectedProductCount` | `16588` | `16440` | DB stale (last verified 2026-04-07 = ~5wk old). Site has grown ~148 products. Both are wp-rest-header readings at different times |
| `productCountMethod.method` | `wp-rest-header` | `sitemap-index` | Different valid methods. wp-rest-header is faster (1 request, x-wp-total header); sitemap-index sums 17 sitemap files. Sitemap can over-count (includes hidden/oos); wp-rest-header is the customer-visible count. SKILL Stage 8 priority #1 is the platform's customer-visible total |
| `productCountMethod.endpoint` | `/wp-json/wc/store/v1/products` | (n/a - sitemap method) | follows from method choice |
| `productCountMethod.urls` | (n/a - single endpoint) | 17 product-sitemap*.xml | follows from method choice |
| `catalogUrls[0]` | `/product-category/firearms-canada/` | `/product-category/firearms/` | **DB URL is 404** - actual slug is `firearms-canada`. DB has stale slugs |
| `catalogUrls[1]` | `/product-category/accessories/` | `/product-category/accessories/` | match |
| `catalogUrls[2]` | `/product-category/ammunition-for-sale-in-canada-tenda-canada/` | `/product-category/ammunition/` | **DB URL is 404** - actual slug includes the long Canadian SEO suffix |
| `catalogUrls[3]` | `/product-category/gun-optics-canada/` | `/product-category/optic/` | **DB URL is 200 but DIFFERENT slug** - `/optic/` is a separate (legacy?) category; canonical optic category per taxonomy API is `/gun-optics-canada/` (count=2258) |
| `catalogUrls[4]` | `/product-category/knives-tools/` | `/product-category/knives/` | **DB URL is 404** - actual slug is `knives-tools` |
| `catalogUrls[5]` | `/product-category/reloading/` | `/product-category/reloading/` | match |
| `catalogUrls[6]` | `/product-category/hunting-outdoor/` | `/product-category/hunting-outdoor/` | match |
| `catalogUrls[7]` | (not included) | `/shop/` | DB includes /shop/ as safety net per its notes; candidate excludes per Rule C "NOT a single all-products aggregator". With Mistake-38 tile-only pattern handled by MAX_CONSECUTIVE_EMPTY_PAGES, the 7 categories cover firearm-relevant 100%. /shop/ is overlapping aggregator |
| catalog count | 7 | 8 (4 wrong + 4 right) | DB has 4 dead URLs and one redundant aggregator |
| `sortParam` | `?orderby=date` | `?orderby=date&order=desc` | both work; candidate uses shorter form (matches HTML default `selected='selected'` on `<option value="date">`). DB adds `&order=desc` for safety (WC default IS desc for date but explicit is safer) |
| `sortVerified` | `true` | (missing) | candidate adds explicit field per Stage 6; DB profile predates |
| `perPage` | `24` | `100` | **Live probe shows site silently caps at 24** (?per_page=100 ignored, returned 24 products). DB value is fiction or refers to /wp-json/wc/store/v1/products perPage cap (which CAN do 100), but catalog HTML walking is locked at 24 |
| `paginationPattern.type` | `path` | `path` | match |
| `paginationPattern.template` | `/page/{N}` | `/page/{N}` | match |
| `paginationPattern.perPage` | `24` | (missing) | candidate adds explicit field |
| `paginationPattern.firstPageHasParam` | `false` | (missing) | candidate adds explicit field |
| `paginationPattern.startPage` | `1` | (missing) | candidate adds explicit field |
| `paginationPattern.zeroIndexed` | `false` | (missing) | candidate adds explicit field |
| `crawlers.watermark.method` | `api-date-since-watermark` | `api-date-since-watermark` | match |
| `crawlers.watermark.reason` | full two-probe verdict | (missing) | candidate adds Stage 7 evidence; DB omits |
| `crawlers.bootstrap.apiEndpoints.productDiscovery` | `/wp-json/wp/v2/product` | `/wp-json/wp/v2/product` | match |
| `crawlers.bootstrap.apiEndpoints.priceEnrichment` | `/wp-json/wc/store/v1/products` | `/wp-json/wc/store/v1/products` | match |
| `crawlers.bootstrap.method` | (n/a - not in spec) | `single-continuous` | DB carries runtime tier-config that's outside the candidate's schema |
| `crawlers.bootstrap.htmlFallback` | (n/a) | `true` | same - DB runtime detail |
| `crawlers.maintain.verifyMethod` | `store-api` | `store-api` | match |
| `crawlers.maintain.verifyEndpoint` | `/wp-json/wc/store/v1/products` | `/wp-json/wc/store/v1/products` | match |
| `crawlers.maintain.method` | (n/a) | `db-verification` | DB runtime tier-config outside candidate scope |
| `crawlers.maintain.cooldowns` / `tierShares` / `tierWindows` / `verifyBehavior` | (n/a) | populated | DB runtime tier-config outside candidate scope |
| `dataFlow.steps` | (n/a) | populated | DB operator narrative; Rule B residue |
| `searchUrl` | `/?s={keyword}&post_type=product` | `/?s={keyword}&post_type=product` | match |
| `topLevelCategories` | full 12-entry array w/ included/excluded notes | (missing) | candidate adds Stage-4 documentation block |
| `extractionTested` | `true` | (missing) | candidate adds Stage-4g spot-check |
| `extractionSample` | 3-product sample | (missing) | candidate adds explicit samples |
| `lastVerified` | `2026-05-15` | `2026-04-07` | candidate is today (DB is ~5wk stale) |
| `profileVersion` | `1` | (missing) | candidate adds explicit version |
| `auditNotes` | runId, fieldConfidence, stageNotes | (missing) | candidate adds operator review trail |
| `siteCategory` | (n/a) | `retailer` | DB column - outside candidate schema |
| `budget` | (n/a) | `180` | DB tier-budget column - outside candidate schema |
| `timeout` | (n/a) | `30000` | DB runtime column - outside candidate schema |
| `hasRateLimit` | (n/a) | `false` | DB column - outside candidate schema |
| `t1IntervalMin` | (n/a) | `17` | DB tier-config column - outside candidate schema |
| `enrichmentChunkSize` | (n/a) | `50` | DB column - outside candidate schema |
| `notes` (freeform) | (omitted per Rule B) | long DB narrative | DB freeform - candidate omits per Rule B (audit-trail residue) |

## Summary

- **Total divergent fields:** 24 (6 substantive content differences; 18 are presence-only - candidate adds explicit fields that the older DB profile predates, or DB carries runtime tier-config outside candidate schema)
- **Substantive divergences (live evidence required):**
  1. `catalogUrls`: 4 of DB's 7 category URLs are 404 (wrong slugs from a different theme/era). Candidate verified all 7 return 200.
  2. `expectedProductCount`: 16588 (live, today) vs 16440 (5wk-stale DB). Site grew ~148 products.
  3. `perPage`: 24 (live, ?per_page=100 ignored) vs 100 (DB fiction). Theme locks HTML catalog at 24/page.
  4. `hasCaptcha`: false (operational) vs true (script-tag-presence). Spec defines operational.
  5. `needsPlaywright`: false (runtime catalog fetch) vs true (DB conservative for solver). Production waf-cookie-manager solves Sucuri once.
  6. `productCountMethod`: wp-rest-header (1 request) vs sitemap-index (17 sitemaps). Both work; wp-rest-header is Stage 8 priority 1.
- **Convergent:** platform, adapterType, hasWaf, wafType, sortParam (semantic match), paginationPattern.type/template, crawlers.watermark.method, crawlers.bootstrap+maintain endpoints, searchUrl, wafWorkaround.method.

## Critical findings (action items for R2)

1. **DB catalogUrls slug drift**: 4 of 8 URLs return 404. This means the production crawler is silently walking ZERO products through 4 of its 8 starting points. Sub-question for R2: how has the DB profile worked in practice? Likely the WC adapter's WP REST product discovery in bootstrap covers everything, and the 4 working HTML category URLs cover the watermark walk; or the consecutive-empty-page tolerance has been masking the failure. Either way the dead URLs should be removed.
2. **DB perPage=100 likely never honored on HTML**: production may be issuing `?per_page=100` and silently getting 24 - wasting a query param and getting 4x fewer products/request than it expects. May explain why htmlFallback=true is needed.
3. **`needsPlaywright` interpretation gap**: SKILL.md says it's a runtime field. DB has it true because Sucuri solver needs Playwright once. Decision required: tighten the SKILL.md definition or accept both readings as equally valid.
4. **No /shop/ in candidate**: DB notes say "/shop/ retained as safety net... overlap test was inconclusive". The candidate's Rule C interpretation excludes aggregators; if the production crawler relies on /shop/ for uncategorized products, that's a coverage gap.
