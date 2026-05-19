# canadafirstammo.ca - B4R1 Candidate vs DB siteProfile Diff

**Candidate**: `docs/site-audit/canadafirstammo.ca-2026-05-15T18-39-00Z-B4R1.json`
**DB row**: `MonitoredSite.domain='canadafirstammo.ca'` (read 2026-05-15 18:43Z)
**DB lastVerified**: 2026-04-11 (34 days stale)

## Divergent fields

| Field | Candidate (B4R1) | DB siteProfile | Verdict | One-line WHY |
|---|---|---|---|---|
| `hasWaf` (DB column) | `false` | `true` | **CANDIDATE LIKELY RIGHT** (operational) | DB column = `true`, but DB JSON `wafWorkaround.method: "none"` and `wafType: "cloudflare-passive"` agree with candidate; SKILL Stage 2 says Cloudflare-passive should be `hasWaf: false` to avoid the runtime perPage=20 penalty in `catalog-crawler.ts`. DB column has not been updated to match the JSON. |
| `expectedProductCount` | `132` | `962` | **DB MAY BE INTENTIONAL** | Candidate uses customer-visible store API (`/wc/store/v1/products` x-wp-total=132). DB uses WP REST `/wp/v2/product` x-wp-total=962 (incl. drafts/private). Skill Stage 8 priority order = customer-visible first. Operator may have chosen 962 for full inventory tracking. |
| `productCountMethod.endpoint` | `/wp-json/wc/store/v1/products` | `/wp-json/wp/v2/product` | derived from above | Candidate prefers customer-visible total to reduce false-positive new-product alerts on drafts. |
| `catalogUrls` count | 4 URLs (min-cover proven 132/132) | 10 URLs (every top-level cat except gunsmithing/uncategorized) | **DB MORE DEFENSIVE** | Candidate proved 100% coverage with 4 URLs via greedy min-cover walk. DB list is 10 URLs (verbose but redundant - every product appears in multiple). Either works; DB resilient if a single cat disappears. |
| `catalogUrls` URL form | absolute (`https://canadafirstammo.ca/...`) | path-only (`/product-category/...`) | STYLE | Skill allows either per Stage 9 ("absolute or path URLs"). |
| `crawlers.bootstrap.apiEndpoints` shape | `{storeApi, wpRest}` | `{priceEnrichment, productDiscovery}` + `htmlFallback:true` + `method:single-continuous` | **DB RICHER** - harness gap | Skill Stage 3 just says "adapter-specific"; DB has the actual operator-decided 2-step data flow (WP REST discovers, WC Store API enriches) which the skill doesn't ask for. |
| `crawlers.maintain` extras | none | `cooldowns`, `tierShares`, `tierWindows`, `verifyBehavior.{onFound,onNotFound,canDetectDeletion}` | **OUT OF SCOPE** | Tier scheduling fields are operator-set runtime knobs (`crawl-scheduler.ts`), not pre-bootstrap targets per Rule B. |
| `wafLastProbedAt` | `2026-05-15T18:27:13Z` (full ISO) | `2026-04-11` (date only) | **CANDIDATE BETTER** | DB used date-only string; skill output uses full ISO timestamp per Stage 2. |
| `wafProbeEvidence` | structured object | freeform string | **CANDIDATE BETTER** | DB was hand-written; skill format is structured per Stage 2 record block. |
| `sortVerified` | `true` (boolean) | `{method, results:{...per-cat...}, verifiedAt, notes}` | **DB CONTAINS RESIDUE** (Rule B) | DB has operator audit-trail residue (per-category 3-outcome results object). Runtime field is boolean. |
| `paginationVerified` | absent | present (audit-trail object) | **DB CONTAINS RESIDUE** | Rule B says don't produce audit-trail residue. |
| `dataFlow` | absent | present (2-step API description) | **REDUNDANT** | Documents what `bootstrap.apiEndpoints` already implies. Operator notes, not runtime. |
| `searchUrl` | absent | `?s={keyword}&post_type=product` | **CANDIDATE MISSED** | Skill Stage 3 has optional `searchUrl`; I didn't probe the WP default `/?s=` keyword search. Real harness gap. |
| `extractionSample` | 3 products with full sourceId/price/stock | absent | **CANDIDATE BETTER** | Stage 4g spec; DB never recorded this. |
| `topLevelCategories` | full 12-cat tree with counts + totalsSumCheck | absent | **CANDIDATE BETTER** | Stage 4f spec; DB never recorded this. |
| `t1IntervalMin`, `budget`, `timeout`, `crawlPhase`, `siteCategory`, `hasRateLimit`, `name` | absent | present | **OUT OF SCOPE** | Operator scheduling/identity fields; not pre-bootstrap deliverables. |

## Agreement (no divergence)

`platform=woocommerce`, `adapterType=woocommerce`, `wafType=cloudflare-passive`, `hasCaptcha=false`, `userAgentOverride=null`, `needsPlaywright=false`, `sortParam=?orderby=date`, `perPage=12`, `paginationPattern.{type=path, template=/page/{N}/, firstPageHasParam=false}`, `crawlers.watermark.method=api-date-since-watermark`, `crawlers.maintain.{verifyMethod=store-api, verifyEndpoint=/wp-json/wc/store/v1/products}`.

## Summary

- **Candidate matches DB on every core runtime field** (platform, adapter, sort, pagination, watermark method, maintain config).
- **Top divergences are operator-discretion**: count source (customer-visible 132 vs total inventory 962), and catalogUrls breadth (4 min-cover vs 10 redundant).
- **DB column `hasWaf:true` contradicts DB JSON `wafType:cloudflare-passive` + `wafWorkaround.method:none`** - likely a stale flip set defensively at first onboard, never corrected. Candidate is operationally correct.
- **Real skill gap**: skill should auto-populate `searchUrl: "/?s={keyword}&post_type=product"` for any `platform=woocommerce` (universal WP default).
