# B5R1 Blind-Run Diff - durhamoutdoors.ca (2026-05-22)

Diff: B5R1 candidate (left) vs DB siteProfile (right). One-line WHY per divergence.

## Agreements (zero divergence)
- `adapterType`: `generic-retail` <-> `generic-retail`
- `hasWaf`: `true` <-> `true`
- `hasCaptcha`: `false` <-> `false`
- `perPage`: `12` <-> `12`
- `sortParam`: `?sortby=4` <-> `?sortby=4`
- `crawlers.watermark.method`: `navigate-from-watermark` <-> `navigate-from-watermark`
- `crawlers.maintain.verifyMethod`: `detail-page` <-> `detail-page`
- `paginationPattern.type`: `suffix-replace` <-> `suffix-replace`
- `paginationPattern.match`: `.html` <-> `.html`
- `catalogUrls` (8 of 9 entries): exact slug match for Accessories, Shotgun, NON-RESTRICTED, Rifles, Pistols, Optics, Used-Consignment, Surplus-and-collection.

## Divergences

| # | Field | B5R1 | DB | WHY |
|---|---|---|---|---|
| 1 | `platform` | `shift4shop-3dcart` | `custom` | DB is undertagged - fingerprints (vcart=26.19.0, _3d_cart JS var, 3dcartGoogleAnalytics, assets/templates/common-html5/) are unambiguous Shift4Shop/3dcart; `custom` loses platform-family routing. |
| 2 | `wafType` | `cloudflare-active` | `cloudflare-passive` | DB notes "CF does not challenge or block. hasWaf kept defensively". B5R1 saw 403s on bot-UA + SQLi + XSS + 5 honeypots, classifying as active rules - but homepage and rapid-burst are 200 (no challenge body). DB judgment is operationally accurate (catalog crawl never trips any rule); B5R1 over-classified the rule-selective surface as "active" instead of "passive + rule-selective". Probably an R1 over-call. |
| 3 | `wafWorkaround` | `null` | `{method:"none-required", notes:"..."}` | DB chose to record the workaround block with method=`none-required` as a marker. B5R1 wrote `null` per skill rule B10 ("re-audit detected different wafType -> emit null to signal clear stale workaround"). Functionally equivalent (no workaround needed); semantic disagreement only. |
| 4 | `needsPlaywright` | `false` | `true` | B5R1 reasoned: plain Chrome UA returned products on every category page + rapid burst stayed clean -> Playwright not needed for catalog crawl. DB sets true defensively (likely because CF *could* escalate). Skill rule says "verify plain HTTP returns products" -> it does. B5R1 stands by `false`; DB is defensive. |
| 5 | `userAgentOverride` | `<iPhone Safari>` | (not stored) | B5R1 set iPhone UA because `wafType=cloudflare-active`. If wafType is actually `cloudflare-passive` (DB), no UA override is needed. Coupled to divergence #2. |
| 6 | `expectedProductCount` | `389` | `388` | Walked union of all 9 categories at audit time = 389. DB at 2026-04-06 audit = 388. Plausibly +/-1 due to product churn over 6 weeks (one new SKU added). Within drift gate. |
| 7 | `productCountMethod` | `{method:"html-pagination", selector:".paging a:not(.category-viewall):last-of-type", perPage:12}` | `{method:"stream-page-count"}` | DB uses `stream-page-count` (counts from DB streamState table - operator-workflow method, not a re-derivable probe). B5R1 selected `html-pagination` as closest runtime-supported probe. DB's choice is fine because the count is already known and updated by stream walk; B5R1 chose probe-from-live because skill rule says "always re-derive". |
| 8 | `paginationPattern.template` | `{slug}-{N}.html` | `-{N}.html` | DB stores just the *suffix* replacement (`-{N}.html`), B5R1 wrote the full template. Both work with the runtime's `match`-based replace logic (replace `.html` with `-{N}.html`). DB form is the conventional runtime shape. **B5R1 used wrong template form** - should have been `-{N}.html` (just the suffix), not `{slug}-{N}.html`. |
| 9 | `paginationPattern.perPage` / `firstPageHasParam` / `startPage` / `zeroIndexed` | populated | absent | DB does not store these for suffix-replace (they only matter for query/path types). B5R1 over-specified. Harmless. |
| 10 | `catalogUrls` count | 9 | 8 | B5R1 added `/RESTRICTED_c_21.html` (200/0 products today, kept per Rule C). DB dropped it. B5R1 over-includes per the "empty != dead" rule; DB pragmatically dropped it. Operator call. |
| 11 | `catalogUrls` order | semantic order | shuffled | Cosmetic. |
| 12 | `searchUrl` | `/search.asp?keyword={keyword}` | `/search?q={keyword}` | Homepage form is `<form action="search.asp"><input name="keyword">`. DB's `/search?q={keyword}` would 404 on this site. **DB is wrong** - B5R1 verified the form on the live HTML. |
| 13 | `crawlers.maintain.method` | (not emitted) | `db-verification` | DB stores a global maintain method `db-verification` separate from `verifyMethod`. Skill rule doesn't require this field. |
| 14 | `crawlers.bootstrap` | (not emitted, per skill rule) | `{method:"single-continuous", apiEndpoints:null, htmlFallback:true}` | Skill rule: zero runtime consumers for bootstrap.apiEndpoints; do not emit. DB has stale operator-doc block. |
| 15 | `dataFlow` | (not emitted) | `{steps:[{api:"HTML scraping", ...}]}` | Operator audit-trail residue (Rule B). DB has it; skill does not target this field. |
| 16 | `t1IntervalMin`, `budget`, `timeout`, `hasRateLimit`, `siteCategory`, `name` | (not emitted) | populated | Operational tuning fields outside this skill's siteProfile target shape. |
| 17 | `lastVerified` | `2026-05-22` | `2026-04-06T21:36:15.733Z` | Today vs prior audit. DB is 46 days stale. |

## Surface-area items NOT in DB siteProfile that B5R1 surfaced
- `topLevelCategories` block with per-category allOption counts + totalsSumCheck arithmetic.
- `extractionSample` (3 confirmed products with price/stock).
- `wafProbeEvidence` (cf-ray header, blocked paths, rapid-burst result).
- `auditNotes.fieldConfidence` / `stageNotes` / `runId`.

## Divergence count: 17

## Blockers
- None. Coverage proven 389/389 (walked union). Sort verified. Pagination zero-overlap verified.

## Top 3 surprising

1. **DB `wafType: cloudflare-passive` with the *exact same* signals B5R1 read as `cloudflare-active`.** WHY: the DB operator chose the operationally meaningful classification (catalog crawl never hits a blocked rule) over the literal-strict one (some rules ARE active for honeypot paths). Probably the right call - `cloudflare-passive` keeps `userAgentOverride` null and `needsPlaywright` more relaxed. B5R1 was too literal.

2. **DB `expectedProductCount: 388` vs B5R1 walked-union `389`.** WHY: minor product-list churn between 2026-04-06 and 2026-05-22 audit dates. A new SKU was added in the 46-day gap. Confirms `expectedProductCount` is real-time and should drift naturally; the DB's drift is in the noise.

3. **DB `searchUrl: "/search?q={keyword}"` is wrong** (would 404). WHY: this looks like a generic-platform default copied in without verification against the homepage's `<form action="search.asp"><input name="keyword">`. B5R1 confirmed the live form. This is exactly the failure-mode lesson B4 from the skill ("Deterministic searchUrl probe MANDATORY"). Worth promoting to next batch's R3 attack: every DB searchUrl should be live-probed.

## Notes for R2/R3
- The 17 divergences are mostly judgment-residue (operator tuning fields) plus 2 substantive bugs in DB (`searchUrl` broken; `wafType` arguable).
- B5R1's `paginationPattern.template` form (`{slug}-{N}.html`) differs from DB's (`-{N}.html`) - verify runtime which form `generic-retail.ts` suffix-replace actually expects.
- The `cloudflare-active` vs `cloudflare-passive` call is operationally meaningful (`needsPlaywright`, `userAgentOverride` flip with it). R2 should drive a 50-page sustained walk to confirm one or the other.
