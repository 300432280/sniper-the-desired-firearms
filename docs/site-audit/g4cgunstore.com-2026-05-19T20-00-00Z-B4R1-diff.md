# B4R1 Diff — g4cgunstore.com (candidate vs DB siteProfile)

Candidate: `docs/site-audit/g4cgunstore.com-2026-05-19T20-00-00Z-B4R1.json`
DB snapshot: `_audit_tmp/batch4-2026-05-19/g4cgunstore.com-DB-snapshot.json` (DB `lastVerified: 2026-04-07`)

## Aligned (no divergence)
- `platform` = `woocommerce`
- `hasWaf` = `true`
- `hasCaptcha` = `false`
- `perPage` = 24
- `paginationPattern.type` = `path`
- `paginationPattern.template` = `/page/{N}` ~ `/page/{N}/` (DB drops trailing slash; runtime tolerant per catalog-crawler.ts:121-125)
- `productCountMethod.method` = `wp-rest-header`, endpoint `/wp-json/wp/v2/product`, header `x-wp-total`
- `crawlers.watermark.method` = `api-date-since-watermark`
- `crawlers.maintain.verifyEndpoint` = `/wp-json/wp/v2/product`
- Both note WC Store API is CF-blocked

## Divergent fields (8 total)

| # | Field | Candidate | DB | WHY hypothesis |
|---|---|---|---|---|
| 1 | `adapterType` | `woocommerce` | `generic-retail` | DB classifies by adapter capability (WC product extraction goes through generic-retail HTML pipeline) rather than platform tag; candidate followed skill table verbatim (woocommerce platform -> woocommerce adapter). DB is the operator's intentional override — WC HTML extraction goes via generic-retail because the WP REST custom data-flow handles the API path separately (see DB.dataFlow.steps). |
| 2 | `wafType` | `cloudflare-active` | `cloudflare-passive` | Candidate observed bot UA/curl UA/rapid burst all 403 from THIS audit IP today. DB note explicitly: "VERIFIED FALSE on 2026-04-07. Cloudflare is passive. HTTP 200 returned for every UA tested." Cloudflare WAF reputation is per-IP and per skill rule "WAF results are IP-dependent" — my audit IP appears flagged. DB's verdict from 2026-04-07 may still hold from the production crawler's actual IP. |
| 3 | `needsPlaywright` | `true` | `false` | Follows from #2: DB's passive-CF verdict means plain axios works for the production crawler; my active-CF verdict means Playwright/UA-override needed from my IP. Same underlying behavior, IP-dependent visibility. |
| 4 | `userAgentOverride` | `<iPhone Safari>` | (not present; null implied) | Same root cause as #2: passive-CF doesn't need a UA override; my active-CF forced me to lock to iPhone Safari. |
| 5 | `expectedProductCount` | 5846 | 5741 | Catalog grew by ~105 products in ~42 days (2026-04-07 -> 2026-05-19). DB count is stale, candidate is current — NOT a real disagreement, just a time delta. |
| 6 | `catalogUrls` | `["https://g4cgunstore.com/shop/"]` (1 URL) | 6 per-category URLs: firearms, ammunition, accessories, sights-optics, high-value-optics, iron-sights | Major divergence. DB's operator chose 6 per-category URLs (5739/5741 covered — 2-product gap is uncategorized). DB skipped /promotions/ (1148 — overlay subset) and used /sights-optics/ as parent containing high-value-optics+iron-sights. Candidate collapsed to /shop/ as single 100% spine. Per Rule C both are valid (operator's choice — per-category enables category-budget allocation in catalog-crawler.ts:378; single-spine is fewer URLs but cannot recover independently when one category rate-limits). DB's choice is more production-aware. **The candidate also missed /product-category/sights-optics/ entirely** — wp-rest-product_cat parent=0 result didn't include it; appears to be a different tree shape than DB inventoried (possibly a renamed/merged cat or one with parent != 0 today). |
| 7 | `crawlers.maintain.verifyMethod` | `detail-page` | `wp-rest` | DB uses `wp-rest` (an extended DB-specific value not in the skill's canonical enum). Custom `verifyBehavior` block: WP REST returns title/slug/thumbnail; price/stock enriched via HTML scrape of /product/{slug}/. Candidate followed skill table (Store API 403 -> detail-page fallback). DB's split (REST for identity + HTML for price/stock) is more efficient than full per-product detail-page; skill should enumerate this pattern as `wp-rest-then-detail-page` or similar. |
| 8 | `sortParam` | `?orderby=date` | `?orderby=date&order=desc` | Candidate omitted explicit `&order=desc` (WC default for `orderby=date` is DESC, so functionally equivalent). DB is explicit/safer against future WC version changes. |

## Blockers
None — candidate is well-formed against the validator shape. The biggest meaningful gap is candidate's missing per-category catalogUrls (operator-preference issue); the wafType/needsPlaywright gap is an IP-reputation artifact the operator should re-confirm from production IP.

## Top 3 surprising divergences

1. **`adapterType: woocommerce` vs DB's `generic-retail`** — WHY: skill table says woocommerce platform -> woocommerce adapter, but operator intentionally routes WC HTML extraction through generic-retail while using a custom WP REST `dataFlow.steps[]` for discovery. The DB split (`adapter: generic-retail` + custom dataFlow) is more capable than the binary `adapterType: woocommerce`. Skill should document the adapter-vs-dataFlow distinction explicitly.

2. **`needsPlaywright: true` vs DB's `false`** — WHY: my probe IP triggers Cloudflare active challenge mode (bot/curl UA -> 403, rapid burst -> 403, SQLi/XSS rules fire). DB's 2026-04-07 audit from a different IP saw all 200s with no challenges. Same WAF rules, different IP reputation. Per skill IP-dependent guidance, production crawler IP — not my audit IP — is the authority. Skill probe should output `auditIpFlagged: true/unknown` so reviewers can detect this case.

3. **`catalogUrls: ["/shop/"]` vs DB's 6 per-category URLs** — WHY: candidate took Rule C "smallest URL set" literally (one URL covers 100%). DB chose 6 because per-category catalogUrls enable independent token-budget allocation in catalog-crawler.ts:378 (each URL gets its own slice; one stuck category doesn't block others). The single-spine approach maximizes simplicity but loses scheduling fairness. Skill Rule C should add a tradeoff note: "per-category catalogUrls enable independent rate-limit recovery and finer scheduling; single-spine maximizes URL-count simplicity but couples all categories together."

## Divergence count: 8
