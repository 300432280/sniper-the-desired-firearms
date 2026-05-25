# aagcanada.ca — B5R1 Diff (candidate vs DB snapshot)

| # | Field | Candidate (B5R1) | DB snapshot | WHY (1-line hypothesis) |
|---|---|---|---|---|
| 1 | `hasWaf` (DB column) | `false` | `true` | DB column-flip lag — B10 rule: column did not flip together with `wafType: cloudflare-passive` (operationally non-blocking). Skill correctly emits `dbColumnFlips.wafWorkaround=clear`; same column-flip applies to `hasWaf`. |
| 2 | `hasWaf` (JSON field) | `false` | `true` | Same as #1 — historical pre-B10 audit set both `wafType=cloudflare-passive` AND `hasWaf=true`; today's skill says cloudflare-passive should not set `hasWaf=true` (would needlessly drop perPage 50->20). |
| 3 | `expectedProductCount` | `565` | `574` | Catalog drifted between 2026-04-11 (DB lastVerified) and 2026-05-22 (today) — 9 products net removed (~1.5%) over 6 weeks. Within 5% drift gate. |
| 4 | `productCountMethod` | `{method:"shopify-products-walk", endpoint:"/products.json", perPage:250}` | `{method:"api-walk", endpoint:"/products.json?limit=250", pages:3, sitemapCount:575}` | DB uses non-canonical label `api-walk` (not in product-count-probe.ts:148-451 switch — would fall through to `default: return null`, silently disabling coverage gate). Skill emits canonical `shopify-products-walk`. |
| 5 | `catalogUrls` | `["/collections/all"]` | 13 per-category URLs (no /collections/all) | Two valid architectures: DB chose per-category spine (13 URLs), skill chose `/collections/all` (proven 100% coverage). Both are valid coverage solutions. Skill prefers minimum URL count when one URL provably covers 100%. |
| 6 | `perPage` | `250` | `12` | DB uses HTML render perPage (12 = Shopify HTML default for grid). Skill ships verified maximum `?limit=250` (Shopify hard cap) -> fewer requests for same coverage. |
| 7 | `paginationPattern.perPage` | `250` | not present (DB has `apiPerPage:250` + `htmlPerPage:12`) | DB tracks both API and HTML perPage as separate fields. Skill shape per Stage 5 has single `perPage` matching what the runtime walker uses. |
| 8 | `searchUrl` | not emitted | `/search?q={keyword}&type=product` | Skill Stage 3 B4 search probe was not executed (gap in this audit). DB value is the Shopify default form action; skill should have verified it. |
| 9 | `crawlers.maintain.verifyMethod` | `detail-page` | not present | DB profile pre-dates Stage 3 verifyMethod derivation; absence = worker.ts hard-skip on verification. Skill correctly emits `detail-page` per Shopify platform->verify table. |
| 10 | `crawlers.maintain.verifyEndpoint` | `null` | not present | Same as #9 — DB never had the field. |
| 11 | `wafProbeEvidence` shape | structured object | freeform string ("server: cloudflare + cf-ray on all responses; all 200 except batch 8...") | DB pre-dates the structured evidence requirement. Skill emits structured per Stage 2. |
| 12 | `wafLastProbedAt` | `2026-05-23T02:45:33Z` | `2026-04-11T05:28:57Z` | 6 weeks stale on DB — pre-bootstrap re-verifies every audit per Mistake 3/35. |
| 13 | `lastVerified` | `2026-05-22` | `2026-04-11` | Same as #12. |
| 14 | `wafType` | `cloudflare-passive` | `cloudflare-passive` | Match. |
| 15 | `hasCaptcha` | `false` | `false` | Match. DB column also `false`. |
| 16 | `captchaType` | `"hcaptcha"` | not emitted | DB does not record CAPTCHA type. Skill Stage 2 emits informational hCaptcha (Shopify storefront form gating). |
| 17 | `ageGate` | `{detected:false, type:null, bypassCookie:null}` | not emitted | DB pre-dates ageGate field. Confirmed absent on live site. |
| 18 | `userAgentOverride` | `null` | not emitted | DB pre-dates; runtime defaults to UA rotation when null. |
| 19 | `needsPlaywright` | `false` | `false` | Match. |
| 20 | `platform` | `"shopify"` | `"shopify"` | Match. |
| 21 | `adapterType` | `"shopify"` | DB field `adapter:"shopify"` (column also `shopify`) | Naming drift (`adapter` vs `adapterType`). Validator accepts either. |
| 22 | `sortParam` | `"?sort_by=created-descending"` | `"?sort_by=created-descending"` | Match. |
| 23 | `sortVerified` | `true` | `true` | Match. |
| 24 | `sortEvidence` | not emitted (operator audit-trail residue per Rule B) | `"default first=replica-boots-1, created-descending first=no-pal-antique-1881-enfield-martini-henry-mk-ii"` | Rule B: skill does NOT emit operator audit-trail residue (`sortEvidence`, `sortVerifiedAt`, `sortVerifiedMethod`). DB carries these as operator notes; skill keeps stageNotes inside `auditNotes`. |
| 25 | `crawlers.watermark.method` | `"navigate-from-watermark"` | `"navigate-from-watermark"` | Match. |
| 26 | `crawlers.bootstrap.apiEndpoints` | not emitted (Rule B — zero runtime consumers) | `{sitemap, collections, productDiscovery}` | DB carries the legacy field. Skill explicitly excludes per Stage 9 Output target note (records in `auditNotes.discoveredApiEndpoints` instead). |
| 27 | `topLevelCategories` | structured (15 categories, source, totalsSumCheck) | not emitted (DB has informal `catalogUrlStats` map) | DB stores per-slug counts as `catalogUrlStats`. Skill emits the canonical `topLevelCategories` documentation block. |
| 28 | `multilingual` | recorded in stage1 notes | `["en","zh","fr"]` top-level field | DB has dedicated field; skill mentions in stageNotes only (no top-level multilingual schema in profile-validator). |
| 29 | `siteCategory` / `siteType` | not emitted | `"retailer"` | DB columns set by enable-new-site script; not a pre-bootstrap output field. |
| 30 | `t1IntervalMin` / `budget` / `timeout` | not emitted | 17 / 60 / 15000 | Operational tuning, not pre-bootstrap output. |
| 31 | `dataFlow` | not emitted | DB documents API steps | Not a profile-validator field; operator documentation only. |
| 32 | `extractionTested` + `extractionSample` | emitted (Stage 4g) | not present in DB | Skill Stage 4g spot-check is new since DB was created. |

## Divergence count
- **Total divergent fields:** 32 rows above
- **True semantic divergences** (substantive operational difference): **6** — #1/#2 (hasWaf column-flip), #3 (count drift), #4 (productCountMethod canonical name), #5 (catalogUrls architecture), #6 (perPage tuning), #9/#10 (verifyMethod derived).
- **Shape/schema drift** (DB pre-dates current schema): #11, #16-18, #21, #24, #26-32 (~16 rows).
- **Stale-timestamp** (re-audit refresh): #12, #13.
- **Matches:** #14, #15, #19, #20, #22, #23, #25 (7 fields match exactly).

## Blockers
- None. Audit ran end-to-end within wall budget. No WAF challenge, no rate-limit, no auth gate.

## Top 3 surprising divergences (with WHY)
1. **DB `hasWaf=true` despite `wafType=cloudflare-passive`** — exact scenario B10 flags as "DB column flip lag". The pre-B10 audit on 2026-04-11 set the column `true` even with passive WAF, costing perPage 50->20 throttle for no protection benefit. Operator should flip DB column to `false` on promotion.
2. **DB `productCountMethod.method = "api-walk"` is not in product-count-probe.ts switch** — B6 shape gate would reject this. Falls to `default: return null` -> `verifyBootstrapCoverage` computes `ratio=null -> isAcceptable=true` -> coverage gate silently disabled. Same family as wolverine's `category-walk-dedupe` bug.
3. **DB catalogUrls excludes `/collections/all`** — DB enumerated 13 per-category URLs (including aggregators `new-arrival`, `sale`). Skill proved `/collections/all` is the 100% coverage spine (565 IDs match sitemap + global /products.json walk) and dropped 13 redundant URLs to 1. Both architectures are valid; minimum-URL principle favors skill's choice.

## Auditor notes
- Validator: **valid=true, score=100, 18/18 checks passed, 0 failures**.
- Wall budget: ~7 minutes (well under 20 min limit).
- All values backed by live probes captured during Stages 1-8; no DB snapshot reads before candidate write.
- Skill gap surfaced: Stage 3 B4 `searchUrl` probe was not executed in this run (would have produced/verified `/search?q={keyword}&type=product`).
