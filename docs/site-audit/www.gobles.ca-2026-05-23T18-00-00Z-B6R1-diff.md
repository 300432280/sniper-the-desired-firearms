# B6R1 diff — www.gobles.ca (BLIND vs DB)

Run: 2026-05-23 (R1 blind). Candidate: `docs/site-audit/www.gobles.ca-2026-05-23T18-00-00Z-B6R1.json`. DB snapshot: `_audit_tmp/batch6-2026-05-23/www.gobles.ca-DB-snapshot.json`.

## Agreements (no divergence)

| Field | Both |
|---|---|
| `platform` | `lightspeed-ecom` |
| `adapterType` | `generic-retail` |
| `hasCaptcha` | `false` |
| `needsPlaywright` | `false` |
| `wafProbeMethod` | `heavy-8-batch` |
| `wafType` | `cloudflare-passive` |
| `sortParam` | `?sort=newest` |
| `crawlers.watermark.method` | `navigate-from-watermark` |
| `crawlers.maintain.verifyMethod` | `detail-page` |
| `paginationPattern.type` | `suffix-replace` |
| `paginationPattern.match` | `?sort=newest` |
| `paginationPattern.template` | `page{N}.html?sort=newest` |

## Divergences

| # | Field | R1 (mine) | DB | WHY |
|---|---|---|---|---|
| 1 | `catalogUrls` count | **74 URLs** (47 firearms/<brand\|type> + 7 simple + 20 knives/<brand>) | **9 URLs** (just 9 top-level parents) | DB note claims "parent categories are inclusive (all child products appear in parent)" — my blind probe of `/firearms/` and `/knives/` returned 0 `product-figure` cards (subcategory tiles only). DB has `categoryStats./firearms/.products: 452` and `/knives/.products: 144` — proving the DB walker DOES find products under parents. **Root cause: my extraction regex matched only `class="product-figure"` which appears on the inner card; parent pages likely use different markup OR I missed a wrapper. R2 must walk `/firearms/` with the actual production extractor (`generic-retail.ts extractCatalogProducts`), not a raw regex.** If DB is correct, the 74-URL list is massively over-specified and the simple 9-URL spine is the right answer. |
| 2 | `hasWaf` | `false` (operational) | `true` (DB column) | DB sets `hasWaf: true` together with `wafType: cloudflare-passive` — the EXACT anti-pattern flagged by Stage 2 rule B10 ("hasWaf:true + wafType:*-passive INVALID combination"). My R1 followed B10: operational hasWaf=false, informational wafType=cloudflare-passive, `auditNotes.dbColumnFlips.hasWaf=false` ready for promotion. **DB needs the column flip.** |
| 3 | `expectedProductCount` | `3770` (sitemap `.html` count) | `3577` (DB `category-page-walk` walkTotal) | Two different surfaces. DB walked categories and got 3577; sitemap has 3770 `.html` URLs. Sitemap is +193 (5.4%) which exceeds the 5% drift gate. DB itself notes `delta: "1% (OOS/hidden)"` between walk (3577) and sitemap (3615) at audit time — sitemap drift since 2026-04-12 inflated to 3770. **Live re-walk needed.** Sitemap likely includes OOS / variant URLs the category walk hides. |
| 4 | `productCountMethod.method` | `generic-product-sitemap` | `category-page-walk` | `category-page-walk` is NOT in the 11 runtime-recognized methods in `product-count-probe.ts:148-451` — falls through to `default: return null` silently disabling the count probe. My R1 used canonical `generic-product-sitemap` with `.html` pattern (Mistake 1). **DB shape is broken per B6.** |
| 5 | `perPage` | `100` (probed `?limit=100` returned 100) | `24` (default) | DB ships default page-1 count; my R1 probed maximum verifiable `?limit=N` per Stage 5 anti-pattern ("don't ship page-1 default"). `?limit=100` cleanly returned 100 cards; `?limit=250` silently caps to 24. **Operational improvement: 4× fewer requests** for same coverage. |
| 6 | `searchUrl` | omitted (not probed in R1) | `/search?q={keyword}` | I skipped the deterministic searchUrl cascade (B4) to stay inside 20-min budget. DB's value is plausible Lightspeed pattern but **not B3 junk-keyword diff-tested**. R2/R3 must run the junk-keyword diff to confirm it isn't silently ignored. |
| 7 | `ageGate` block | `{detected:false, type:null, bypassCookie:null}` (explicit) | not present | DB omits the field entirely; my R1 emits explicit `false` per Stage 3 contract. Cosmetic. |
| 8 | `crawlers.bootstrap` | omitted (per skill: zero runtime consumers) | present (`{method:"single-continuous", apiEndpoints:null, htmlFallback:true}`) | Skill removed `crawlers.bootstrap` from required/recommended fields (operator-documentation residue). DB has legacy block; safe to leave but not part of R1 emission. |
| 9 | `wafProbeEvidence` | rich blob (cfHeaders, perUaStatusTimeline, honeypotPathsBlocked, untestedAttackSurfaces) | absent | DB has only `wafProbeResult` one-liner; my R1 emits structured evidence per Stage 2 contract. |
| 10 | `categoryStats` | omitted (operator audit-trail residue) | present (per-cat pages+products from a prior walk) | Rule B not a runtime field. DB has it as documentation. My R1 captures the same info in `auditNotes.topLevelCategoriesInferred`. |
| 11 | `wafLastProbedAt` | `2026-05-25T03:02:35Z` (fresh) | `2026-04-12` (43 days stale) | Re-probed per B8 freshness rule. No migration detected (both say `cloudflare-passive`). |
| 12 | DB-only fields (not in skill scope) | n/a | `budget`, `timeout`, `crawlPhase`, `categoryStats`, `t1IntervalMin`, `hasRateLimit`, `totalSiteProductCount`, `dataFlow`, `crawlers.maintain.cooldowns/tierShares/tierWindows` | Operator-managed runtime tuning; out of pre-bootstrap scope. |

## Top 3 WHYs

1. **catalogUrls 9 vs 74** — DB's 9 parent-only spine claims inclusiveness (and has matching per-cat product counts in `categoryStats`); my blind probe saw `/firearms/` and `/knives/` parents return 0 cards via raw `class="product-figure"` regex. Either the production extractor reaches a wider marker set (likely — `.product-element` is in `generic-retail.ts` per DB notes) OR DB is stale. R2 must walk `/firearms/` with the actual `extractCatalogProducts` to settle.
2. **hasWaf true vs false** — DB has the B10-invalid pair (`hasWaf:true` + `wafType:cloudflare-passive`); my R1 correctly splits them per skill rule. Real runtime cost in DB today: perPage drop 50→20, forced Playwright, WAF cookie cache — all unnecessary.
3. **productCountMethod broken** — DB ships `"category-page-walk"` which is not in `product-count-probe.ts` switch (lines 148-451); silently disables count probe end-to-end (B6 violation). My R1 uses canonical `generic-product-sitemap`.

## Blockers

- None for R2/R3. catalogUrls divergence (#1) is the load-bearing investigation: R2 must confirm whether `/firearms/` parent IS inclusive (via the production extractor) or whether the brand-leaf spine is mandatory.

## Divergence count

**12 fields differ** (5 substantive: catalogUrls, hasWaf, expectedProductCount, productCountMethod.method, perPage; 5 schema/cleanup: searchUrl, ageGate, bootstrap, wafProbeEvidence, categoryStats; 2 freshness: wafLastProbedAt, DB-only tuning).
