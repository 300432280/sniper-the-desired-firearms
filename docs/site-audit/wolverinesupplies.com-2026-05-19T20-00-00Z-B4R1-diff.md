# B4R1 Diff — wolverinesupplies.com

Candidate: `docs/site-audit/wolverinesupplies.com-2026-05-19T20-00-00Z-B4R1.json`
DB snapshot: `_audit_tmp/batch4-2026-05-19/wolverinesupplies.com-DB-snapshot.json` (lastVerified 2026-04-11, ~38 days stale)

## Divergences (candidate vs DB)

| Field | Candidate | DB | WHY (1-line hypothesis) |
|---|---|---|---|
| `hasWaf` (column + JSON) | `false` | `true` | **DIVERGENCE.** DB chose defensive `true` despite Cloudflare-passive (200s everywhere); skill Stage 2 says `hasWaf=true` ONLY when WAF actively blocks. DB sets `hasWaf:true` AND `wafType:cloudflare-passive` (internal contradiction); candidate aligns with skill rule. |
| `expectedProductCount` | `8169` | `5739` | **DIVERGENCE — methodology choice.** DB chose category-walk-dedupe count (in-stock-only). Candidate chose sitemap (OOS-inclusive). Skill Stage 8 explicitly accepts sitemap. ~38 days have passed and sitemap grew 8054→8169. |
| `productCountMethod` | `{method:"sitemap", url:"/xmlsitemap.php?type=products&page=1"}` | `"category-walk-dedupe"` (bare string) | **DIVERGENCE.** DB value is a bare string NOT in the runtime probe switch's 11 canonical method names → falls through to `default: return null` (probe silently disabled). Candidate uses canonical object shape the runtime recognizes. |
| `sitemapProductCount` | not in candidate | `8054` | Extra DB field documenting sitemap count separately. Skill schema omits this — operator audit-trail residue. Sitemap drifted 8054→8169 (+115) in ~38 days; new products added. |
| `paginationPattern.template` | `"page"` | not set; DB uses `param:"page"` | DB uses non-canonical key `param`; runtime spec is `template`. Same value, key drift. |
| `paginationPattern.perPage` | `100` | not present in pagination block | DB stores perPage at JSON top-level (100) but not inside `paginationPattern`. Candidate duplicates per the skill spec. |
| `paginationPattern.startPage` | `1` | DB uses `firstPage:1` | DB uses non-canonical `firstPage`; runtime spec is `startPage`. Same value. |
| `paginationPattern.zeroIndexed` | `false` | absent in DB | Candidate includes explicit field per schema; DB omits. |
| `bcStoreId` | absent | `"1003335859"` | DB stores BC store ID; not a required/recommended schema field. Operator-doc / useful for future BC GraphQL work. |
| `catalogUrls` order | nav-order | DB order differs (AIRGUNSM 3rd, FIREARMS-ACCESSORIES 5th) | Cosmetic — both lists contain identical 14 URLs (set equality). |
| `topLevelCategories` | present, per-category in-stock counts | not in DB (DB uses `catalogUrlStats` instead) | DB has `catalogUrlStats` map; candidate has `topLevelCategories.categories[]` array. Same intent, schema evolved. |
| `extractionTested` + `extractionSample` | present | absent | New skill field; DB predates it. |
| `crawlers.maintain` block | `{verifyMethod:"detail-page", verifyEndpoint:null}` | absent | DB lacks maintain config → runtime worker logs error and skips verification (per CLAUDE.md lesson). Candidate adds it. |
| `crawlers.watermark.sortParam` | absent (sortParam is top-level) | `"?sort=newest"` nested under watermark | DB nests sortParam inside watermark AND at top-level. Schema drift; runtime reads top-level. |
| `auditNotes.*` block | rich (runId, fieldConfidence, stageNotes, verifyMethodPolicy) | absent | New skill output not in DB. |
| `wafProbeEvidence` | structured object | bare string | Schema evolution — structured vs string. |
| Field `notes` | absent (skill doesn't emit prose `notes`) | long prose string | Skill Rule B classifies `notes` as operator audit-trail residue — skill correctly omits. |
| `parentChildNote` / `parentChildInclusion` / `canonicalNote` / `sitemapNote` / `sortVerifiedAt` / `sortVerifiedMethod` | absent | DB has all 6 | Operator audit-trail residue per Rule B; correctly omitted. |
| `wafProbeMethod` | `"heavy-8-batch"` | `"heavy-8-batch"` | MATCH. |
| `wafProbeResult` | full one-line verdict + reasoning | `"cloudflare-passive"` | Same intent; candidate is richer. |
| `platform` | `"bigcommerce-stencil"` | `"bigcommerce-stencil"` | MATCH. |
| `adapterType` (column + JSON) | `"generic-retail"` | `"generic-retail"` | MATCH. |
| `wafType` | `"cloudflare-passive"` | `"cloudflare-passive"` | MATCH. |
| `hasCaptcha` (column + JSON) | `false` | `false` | MATCH. |
| `sortParam` (top-level) | `"?sort=newest"` | `"?sort=newest"` | MATCH. |
| `sortVerified` | `true` | `true` | MATCH. |
| `perPage` | `100` | `100` | MATCH. |
| `needsPlaywright` | `false` | `false` | MATCH. |
| `crawlers.watermark.method` | `"navigate-from-watermark"` | `"navigate-from-watermark"` | MATCH. |
| `paginationPattern.type` | `"query"` | `"query"` | MATCH. |
| `paginationPattern.firstPageHasParam` | `false` | `false` | MATCH. |
| `catalogUrls` (as set) | 14 URLs | 14 URLs | MATCH (set equality, different order). |
| `ageGate` | `{detected:false, ...}` | absent | DB predates ageGate field; defaults to undefined/false-equivalent. |
| `profileVersion` | `1` | absent in DB | New field. |
| `lastVerified` | `"2026-05-19"` | `"2026-04-11T01:07:09.759Z"` | Expected — DB ~38 days stale. |

**Divergence count: 19 (4 hard disagreements + 15 schema-drift/omission).**

## Top 3 surprising divergences

1. **`hasWaf` semantic disagreement (candidate=false, DB=true).** DB operator set `hasWaf:true` defensively while `wafType:cloudflare-passive` says "no active blocking" — an internal contradiction. Skill Stage 2 explicitly says: "Setting `hasWaf:true` has runtime cost: `catalog-crawler.ts` drops perPage to 20 and routes through the WAF cookie manager. Cloudflare-passive does NOT need it." DB is paying that cost unnecessarily (perPage 100→20 = 5× more requests for the same crawl). **WHY**: prior operator likely set defensively before the skill's explicit guidance, or to play safe across IP variance — but Cloudflare-passive on a BC origin should be `false`.

2. **`expectedProductCount` 8169 vs 5739 (sitemap vs walk).** Both methodologies have evidence; the skill explicitly accepts BOTH paths but warns against downranking sitemap "just because the count is higher." DB chose the lower walk-derived count to make the runtime 5% drift gate pass cleanly. Candidate chose sitemap because runtime DOES support `sitemap` as one of 11 valid methods AND the DB's `productCountMethod` (`"category-walk-dedupe"`) is NOT a runtime-recognized method — it lands on `default: return null`, silently disabling the probe. **WHY**: DB favored "count matches runtime walk"; candidate favored "probe actually works at runtime". This is a real schema-vs-runtime mismatch the operator should resolve.

3. **`productCountMethod` schema gap.** DB has bare string `"category-walk-dedupe"`; the runtime switch at `backend/src/services/product-count-probe.ts:188-446` has 11 canonical method names — `category-walk-dedupe` is NOT one of them. The closest runtime equivalent is `stream-page-count` (walks catalogUrls + dedupes, needs `siteId`). **WHY**: DB pre-dates the discriminated-union enforcement; this is a Mistake 28 candidate (re-verify every stored field on re-audit). Operator should migrate to `stream-page-count` (preserves walk-derived 5739) or `sitemap` (switch to OOS-inclusive 8169).

## Summary

- **Strong matches**: platform, adapter, sortParam, sortVerified, perPage, needsPlaywright, watermark method, paginationPattern.type/firstPageHasParam, catalogUrls set (14 identical), wafType, hasCaptcha, captcha=false, ageGate=none.
- **Real disagreements**: `hasWaf` (DB over-cautious), `expectedProductCount`/`productCountMethod` (DB chose unrecognized bare-string method → silently disabled at runtime).
- **Schema drift**: paginationPattern key names (`template` vs `param`, `startPage` vs `firstPage`), nested vs top-level `sortParam`, `wafProbeEvidence` shape (object vs string).
- **Skill omissions of audit-trail residue**: `notes`, `parentChildNote`, `canonicalNote`, `sortVerifiedAt`, etc. — these are operator-doc fields the skill correctly does not generate.

## Blockers
None — all 14 catalogUrls walked successfully, sort verified, pagination verified, sitemap accessible. No WAF blocking. No DB writes made.
