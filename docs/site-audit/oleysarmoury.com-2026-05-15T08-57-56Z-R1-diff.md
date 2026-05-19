# R1 Diff - oleysarmoury.com (2026-05-15T08-57-56Z vs DB siteProfile)

Candidate JSON: `docs/site-audit/oleysarmoury.com-2026-05-15T08-57-56Z-R1.json`
DB profile last verified: 2026-04-12 (33 days old at audit time).

## Field-by-field

| Field | DB | Candidate (R1) | Same? | One-line WHY |
|---|---|---|---|---|
| `platform` | `bigcommerce-stencil` | `bigcommerce-stencil` | yes | Both derived from `<meta platform='bigcommerce.stencil'>` + cdn11.bigcommerce.com store-hash. |
| `adapterType` | `generic-retail` | `generic-retail` | yes | BC Stencil maps to generic-retail per Stage 3 table. |
| `hasWaf` (DB col) | `true` | `false` | **NO** | DB sets `true` while also recording `wafType: cloudflare-passive` - internally inconsistent. Skill Stage 2 spec: hasWaf is operational; Cloudflare-passive (cf-ray + all 200 in every probe; no plugin markers) MUST be `false` to avoid the catalog-crawler dropping perPage to 20. R1 fixes this by setting `false`. |
| `hasCaptcha` (DB col) | `false` | `false` | yes | No reCAPTCHA / hCaptcha / Turnstile script on homepage. |
| `wafType` | `cloudflare-passive` | `cloudflare-passive` | yes | Consistent. |
| `wafProbeResult` | "cloudflare-passive (cf-ray on all, honeypot 403s, no active challenges)" | "no-waf: all 8 batches 200 ...; cf-ray header not present on direct GET" | **NO** | DB claims cf-ray on every batch AND honeypot 403; R1's live probe today saw NO cf-ray header on the apex GET, honeypot path returned 404 (not 403), and all 8 batches passed clean. Either the front-edge config changed since 2026-04-12 or the DB description was approximate. |
| `wafLastProbedAt` | `2026-04-12` | `2026-05-15T08:46:06Z` | n/a (timestamp) | Re-probe artifact. |
| `wafProbeMethod` | `heavy-8-batch` | `heavy-8-batch` | yes | - |
| `ageGate` | absent | `{detected:false,type:null,bypassCookie:null}` | minor | DB simply omits; R1 records explicitly. No functional difference. |
| `userAgentOverride` | absent (so null) | `null` | yes | - |
| `needsPlaywright` | `false` | `false` | yes | Plain HTTP returns full product HTML. |
| `expectedProductCount` | `3368` | `3505` | **NO** | DB count from 2026-04-12 sitemap; R1's 2026-05-15 sitemap returned 3505 entries, and a full ID-deduped walk of the 14 retained categories also totalled 3505. Net +137 products in 33 days. |
| `productCountMethod` | `{method:"bc-xmlsitemap", endpoint:"/xmlsitemap.php?type=products&page=1", sitemapTotal:3368, categoryWalkTotal:3388}` | `{method:"sitemap", url:"https://oleysarmoury.com/xmlsitemap.php?type=products&page=1"}` | **partial** | DB uses canonical-method-name `bc-xmlsitemap` which is NOT in the runtime probe's switch (`product-count-probe.ts`); R1 uses the canonical `sitemap` method that IS in the switch. DB's label is label-drift (skill Stage 8 anti-pattern: unknown method silently disables count). |
| `catalogUrls` | 13 paths (relative) | 14 absolute URLs with `?limit=100&sort=newest` baked in | **NO** | DB drops `consignment-non-firearm`; R1 keeps it (200 + 0 products today; Rule C - empty != dead). DB stores bare paths; R1 stores absolute URLs with sort+limit pre-baked. DB list order differs but composition is otherwise the same (both correctly drop clearance/consignment overlap categories). |
| `perPage` | `100` | `100` | yes | `?limit=100` returns 100 unique IDs; `?limit=250` caps at 100. |
| `paginationPattern` | `{type:"query", template:"page", firstPageHasParam:false}` | `{type:"query", template:"page", perPage:100, firstPageHasParam:false, startPage:1, zeroIndexed:false}` | **partial** | Same `type`+`template`; R1 adds explicit `perPage`/`startPage`/`zeroIndexed` per skill spec (recommended fields). |
| `sortParam` | `?sort=newest` | `?sort=newest` | yes | Confirmed via 3-outcome cache-busted test. |
| `sortVerified` | `true` | `true` | yes | - |
| `crawlers.watermark.method` | `navigate-from-watermark` | `navigate-from-watermark` | yes | Sort-honored + monotonic-DESC product IDs. |
| `crawlers.bootstrap.apiEndpoints` | `null` (with `htmlFallback:true`) | `{sitemap:..., catalogPages:...}` | **partial** | DB uses adapter-specific `null+htmlFallback` shape; R1 documents the actual endpoints. Both functional; runtime reads what the worker code expects. |
| `crawlers.maintain.verifyMethod` | `detail-page` | `detail-page` | yes | - |
| `crawlers.maintain.verifyEndpoint` | absent | `null` | minor | Equivalent. |
| `apiAlternative` (BC GraphQL block) | full block: graphqlUrl `/graphql`, tokenScrapeUrl `/firearms/`, currencyCode `CAD`, tokenCacheTtlMs 1h | **NOT EMITTED** | **NO** | The DB profile contains a custom BC-Storefront-GraphQL primary path (operator-added enhancement). R1 did NOT discover this: searching the live HTML of `/firearms/` and homepage for `graphql`/`storefront`/`jwt`/`Storefront_api_token` returned zero matches today (token may be JS-injected, requiring Playwright). The canonical pre-bootstrap skill does not have a Stage for "discover platform-private GraphQL with scraped JWT", so this divergence is by design: R1 outputs the spec-required runtime fields; the GraphQL alternative-path discovery is operator-added scope outside the skill. |
| `bcStoreId` | `1000335807` | not emitted | **NO** | Same scope gap - skill spec does not output bcStoreId. R1 captured store-hash `s-6j8taxjw04` in wafProbeEvidence but the numeric BC store ID was not probed. |
| `searchUrl` | `/search.php?search_query={keyword}` | not emitted | **NO** | Skill Stage 3 says output searchUrl ONLY if the site has a keyword-search URL; we observed `<form action="/search.php">` with `name="search_query"` in homepage but did not formally output it. R1 should have emitted; gap to log. |
| `storeHash` | `s-6j8taxjw04` | not emitted | **NO** | Same scope gap (operator-added). Captured in wafProbeEvidence prose only. |
| `categoryStats` (per-cat page+product counts) | full block | absent | **NO** | DB records per-category stats; R1 puts comparable data in `topLevelCategories.categories[].allOption + uniqueHere` - equivalent purpose, different schema. |
| `dataFlow.steps` | 2-step BC-GraphQL-primary + HTML-fallback | absent | **NO** | Operator narrative field; outside skill scope. |
| `notes` (operator long-form) | full paragraph | absent | **NO** | Audit-trail residue per skill Rule B; correctly omitted. |
| `siteCategory` | `retailer` | absent | **NO** | Not a pre-bootstrap-skill output. |
| `t1IntervalMin`, `budget`, `timeout`, `crawlPhase`, `hasRateLimit`, `limitParam` | various values | absent | **NO** | Operator-tuned runtime fields, not pre-bootstrap output per Rule B. |
| `lastVerified` | `2026-04-12` | `2026-05-15` | n/a | Re-probe artifact. |

## Divergent-field summary (count)

15 field-level divergences:
1. `hasWaf` value disagreement (true vs false) - substantive.
2. `wafProbeResult` description disagreement - substantive (probe-state change or prior inaccuracy).
3. `expectedProductCount` (3368 vs 3505) - 33-day growth.
4. `productCountMethod` label drift (`bc-xmlsitemap` not in runtime switch; canonical is `sitemap`).
5. `catalogUrls` shape (relative paths vs absolute+baked-sort+limit) + inclusion of `consignment-non-firearm` (R1 keeps, DB drops).
6. `paginationPattern` field coverage (R1 fills `perPage`/`startPage`/`zeroIndexed`).
7. `crawlers.bootstrap.apiEndpoints` shape (DB `null`+htmlFallback vs R1 object).
8. `apiAlternative` BC-GraphQL block (DB has, R1 doesn't discover).
9. `bcStoreId` (DB has, R1 doesn't emit).
10. `searchUrl` (DB has, R1 doesn't emit - gap).
11. `storeHash` (DB has, R1 captures in prose only).
12. `categoryStats` (DB shape vs R1 `topLevelCategories.categories[]`).
13. `dataFlow.steps` (DB has, R1 doesn't - operator narrative).
14. `notes` long-form (R1 omits per Rule B - correct).
15. Runtime-tuning fields (t1IntervalMin / budget / timeout / etc.) (DB has, R1 omits per Rule B - correct).

## Three most surprising divergences

1. **DB has `hasWaf: true` but `wafType: cloudflare-passive`** - internally inconsistent. Per Stage 2 spec, Cloudflare-passive (no challenges seen anywhere) MUST be `hasWaf:false` so the crawler doesn't drop perPage to 20 unnecessarily. The DB is wrong here; the 33-day-stale `wafProbeResult` text mentioned "honeypot 403s" but the live probe today shows honeypot 404 (no WAF). Net: DB is slowing the crawler for no reason.
2. **DB has a fully-elaborated BC-Storefront-GraphQL primary-crawl path** (`apiAlternative.graphqlUrl=/graphql`, `tokenScrapeUrl=/firearms/`, 1h token cache) that the pre-bootstrap skill cannot discover today - the JWT token is not in the static HTML for `/firearms/` or `/`. Either it's JS-injected (requires Playwright) or the operator enhanced this manually. Skill scope ends at HTML fallback; GraphQL discovery is operator scope.
3. **Product count grew 3368 -> 3505 (+137 = 4.1%) in 33 days** without any DB profile re-verification - typical drift. The skill correctly re-derives every audit; the DB's `expectedProductCount` is the floor used by drift gates and should be refreshed.

## SKILL.md harness gaps observed

1. **No discovery path for platform-specific private APIs with JS-injected tokens** (BC GraphQL with `tokenScrapeUrl`, Klevu, Searchspring with auth). Stage 3/4 only checks public sitemap + REST + HTML rendering. The skill could add a Stage 3.5 "Platform private-API probe" that runs Playwright on a category page, scrapes for token markers (`storefront_api_token`, `Stencil_token`, `data-bc-token`), and outputs an `apiAlternative` block when found. Cost: one extra Playwright run per site; benefit: 30%+ faster crawl on BC stores where GraphQL works.
2. **Missing emission of `searchUrl` and `storeHash` / `bcStoreId` even when easily discoverable.** Stage 3's Ecwid path emits `ecwidStoreId`, but the BC-Stencil path has no analogous emit for `storeHash` / `bcStoreId`, and `searchUrl` requires manual operator notice. Add a "BC Stencil extras" subsection: scrape `<meta platform>` for store identifier and `<form action="/search.php">` for searchUrl during Stage 3.
3. **Operator-tuned runtime fields (t1IntervalMin, budget, timeout, crawlPhase, hasRateLimit) are NOT in the skill output, yet DB rows have them.** This is correct per Rule B (audit-trail residue), but the SKILL.md "Output target" comment block could explicitly list these as "operator-added during DB promotion, NOT skill output" so future audits don't mistake their absence as a gap.
