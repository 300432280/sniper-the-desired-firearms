# alflahertys.com — B4R1 Candidate vs DB Snapshot Diff (2026-05-19)

Candidate: `docs/site-audit/alflahertys.com-2026-05-19T20-00-00Z-B4R1.json`
DB snapshot: `_audit_tmp/batch4-2026-05-19/alflahertys.com-DB-snapshot.json`

## Summary

- Matches: `platform`, `adapterType`, `wafType` (cosmetic field), `hasCaptcha`, `expectedProductCount` (5262), `crawlers.watermark.method` (full-catalog-sweep), `crawlers.maintain.verifyMethod` (detail-page), `apiConfig.klevuApiKey`, `apiConfig.klevuEndpoint`, `searchUrl`.
- Divergences: 14 (see below).

## Field-by-field

| Field | Candidate (B4R1) | DB (current) | Verdict | WHY hypothesis |
|---|---|---|---|---|
| `hasWaf` | `false` | `true` | DIVERGE | Skill says hasWaf is operational, not literal — Cloudflare-passive (cf-ray + all 200) should be `false`. DB has it `true` but `wafType="cloudflare-passive"` AND `wafWorkaround.method="sucuri-cookie-cache"` — DB is internally inconsistent. Likely a prior operator set `hasWaf:true` to enable the Sucuri workaround path, then later changed `wafType` to cloudflare-passive without flipping `hasWaf` back. DB wins for safety; my candidate is technically more correct but riskier. |
| `wafWorkaround` | absent | `{method:"sucuri-cookie-cache", steps:[...], notes:"Sucuri WAF..."}` | DIVERGE | DB has stale Sucuri text from a prior platform classification. Real site is BC Stencil behind Cloudflare-passive — no Sucuri. Candidate correctly omits. Operator should remove the stale block. |
| `sortParam` | `null` | `"?sort=newest"` | DIVERGE | DB has a non-functional sort string (Klevu category-page.js only exposes RELEVANCE/PRICE_ASC/PRICE_DESC; NEWEST returns HTTP 500). Field is unused since `watermark.method=full-catalog-sweep`. Stale residue from an old discovery pass. |
| `perPage` | `36` (Klevu adapter default) | `20` | DIVERGE | Operator tuned down to 20 — probably for rate-limit safety on the Klevu endpoint. The Klevu adapter at `generic-retail.ts:285` defaults to 36 if profile leaves it blank; setting 20 reduces per-request payload. Operator preference, both work. |
| `needsPlaywright` | `false` | `true` | DIVERGE | The Klevu apiConfig branch in `generic-retail.ts:365` bypasses Playwright entirely at runtime — products come from Klevu API JSON directly. DB has `true` likely from when the site was first audited as "BC + Klevu JS overlay" before the apiConfig branch existed. Candidate reflects the post-Klevu-branch reality; DB is stale. |
| `paginationPattern` | `{type:"api-offset", template:"offset", perPage:36, ...}` | absent | DIVERGE | DB omits paginationPattern entirely. The runtime catalog crawler reads this; absence may default to a fallback or be tolerated by the Klevu adapter (which constructs offsets internally). Skill validator requires it; candidate is more correct. |
| `productCountMethod.method` | `"sitemap"` (url=/xmlsitemap.php?type=products&page=1) | `"klevu-api-count"` (endpoint=Klevu search URL, apiKey) | DIVERGE | Both work at runtime. SKILL.md lists `klevu-api-count` as method #10 in the canonical 11. DB chose Klevu API (consistent with adapter); candidate chose sitemap (cheaper, single GET, no POST). Both produce 5262. |
| `catalogUrls` (count) | 12 entries (top-level slugs, absolute URLs) | 6 entries (mix of top-level and sub-paths, relative paths) | DIVERGE | DB picked a specific narrower set (firearms/ammunition/optics/stocks-parts/storage/bargains) — a firearm-relevant subset NOT the full top-level list. Candidate picked all 12 top-level categories per Rule C ("100% firearm-relevant"). DB excludes camping/clothing/fishing/etc., which is arguably correct under Rule C's "include firearms-adjacent only" but the rule also says include `hunting supplies that imply firearm use` (DB excludes /hunting-gear/) and mixed categories (DB excludes /archery/ which contains airguns). Operator's narrower set is closer to the literal firearms shop list. |
| `catalogUrls` (URL form) | absolute `https://alflahertys.com/...` | relative `/...` | DIVERGE | DB stores path-only; runtime catalog crawler resolves against origin. Candidate stores absolute — both work. Stylistic. |
| `catalogUrls` (specific) | `/shooting-supplies-and-firearms/`, `/optics/`, `/archery/`, etc. | `/shooting-supplies-firearms-and-ammunition/firearms/`, `/shooting-supplies-firearms-ammunition/ammunition/`, `/shooting-supplies-firearms-and-ammunition/stocks-parts-barrels-kits/`, etc. | DIVERGE | DB uses LEAF sub-paths under multiple parent variants (three different parent paths: `/shooting-supplies-firearms-and-ammunition/`, `/shooting-supplies-firearms-ammunition/`, `/shooting-supplies-and-firearms/`). Candidate uses top-level parent only. Since Klevu wildcard SEARCH fetches all 5262 products globally regardless of entry URL, both achieve 100% coverage; DB's choice gives the operator-review pipeline more granular per-category telemetry. |
| `apiConfig.klevuCategoryPaths` | 12 top-level Klevu paths (`Optics`, `Fishing`, `Camping`, etc.) | 8 sub-category Klevu paths (`...;Firearms;Rifles`, `...;Firearms;Shotguns`, `...;Ammunition;Rimfire Ammunition`, etc.) | DIVERGE | DB targets specific firearm-relevant SUB-categories with deep `;` paths. Candidate has shallow top-level only. The Klevu adapter at `generic-retail.ts:287-303` looks up paths by URL slug match — DB's paths require sub-category URLs to be in `catalogUrls` to fire. Candidate provides broader coverage with less specificity. |
| `expectedProductCount` | `5262` | `5262` | MATCH | Both probes return same count. |
| `platform` | `"bigcommerce-stencil"` | `"bigcommerce-stencil"` | MATCH | Hyphen form consistent. |
| `wafType` | `"cloudflare-passive"` | `"cloudflare-passive"` | MATCH | Cosmetic field. |
| `wafProbeMethod` | `"heavy-8-batch"` | absent | DIVERGE | Skill records probe method; DB never persisted it. |
| `wafProbeEvidence` | populated (cf headers, burst status, etc.) | absent | DIVERGE | Same — audit-trail residue per skill Rule B; DB never persisted. |
| `wafProbeResult` | populated (one-line verdict) | absent | DIVERGE | Same. |
| `wafLastProbedAt` | `2026-05-19T08:53:04Z` | absent | DIVERGE | Skill records timestamp; DB never persisted. |
| `extractionTested` / `extractionSample` | `true` + 3 samples | absent | DIVERGE | Skill emits audit-trail residue; runtime ignores. |
| `topLevelCategories` | populated (12 cats + source + totalsSumCheck) | absent | DIVERGE | Documentation block; runtime ignores. |
| `auditNotes` | populated (runId, fieldConfidence, stageNotes) | absent | DIVERGE | Audit-trail residue. |
| `crawlers.bootstrap` | absent (skill says do NOT emit; zero runtime consumers) | `{method:"single-continuous", apiEndpoints:null, htmlFallback:true}` | DIVERGE | DB has the bootstrap block; SKILL.md explicitly removed it from required/recommended fields ("zero runtime consumers, operator documentation only"). DB carries legacy fields that skill no longer produces. |
| `crawlers.maintain.cooldowns`, `tierShares`, `tierWindows`, `method` | absent | populated (operator-tuned tier-engine knobs) | DIVERGE | These are runtime tier-engine knobs (not pre-bootstrap scope per skill). DB has them; candidate does not. |
| `dataFlow` | absent | populated (2-step API description) | DIVERGE | DB documentation field; not in skill output. |
| `budget`, `timeout`, `t1IntervalMin`, `siteCategory`, `name`, `notes`, `hasRateLimit` | absent | populated | DIVERGE | Operator/runtime knobs outside pre-bootstrap scope. |
| `column_hasWaf` | (no DB col write) | `true` | n/a | Skill never writes DB columns. |
| `column_adapterType` | (no DB col write) | `"generic-retail"` | n/a | Matches JSON field. |

## Divergence count

- Substantive divergences (skill candidate vs DB on a field both produce): 9 (`hasWaf`, `wafWorkaround`, `sortParam`, `perPage`, `needsPlaywright`, `paginationPattern`, `productCountMethod.method`, `catalogUrls` content + form, `apiConfig.klevuCategoryPaths` content).
- Audit-residue divergences (skill produces, DB does not carry): 7 (`wafProbeEvidence`, `wafProbeResult`, `wafProbeMethod`, `wafLastProbedAt`, `extractionTested+extractionSample`, `topLevelCategories`, `auditNotes`).
- Operator-knob divergences (DB carries, skill correctly omits): 10 (`budget`, `timeout`, `t1IntervalMin`, `cooldowns`, `tierShares`, `tierWindows`, `dataFlow`, `name`, `notes`, `hasRateLimit`, `siteCategory`, `crawlers.bootstrap`).
- Total field divergences across the union: 14 in the main table above, plus 8 omitted operator knobs.

## Top 3 surprising divergences with WHY

### 1. `hasWaf: false` (candidate) vs `true` (DB) — combined with `wafType` agreement

The DB has a contradiction: `hasWaf:true` + `wafType:"cloudflare-passive"` + `wafWorkaround.method:"sucuri-cookie-cache"`. Three fields, three different stories. Candidate set `hasWaf:false` because SKILL.md Stage 2 explicitly says "Cloudflare-passive (cf-ray + all 200 in every probe) does NOT need `hasWaf:true`" — setting it true drops perPage to 20 (matches DB perPage!) and routes through WAF cookie manager. WHY: the operator originally classified as Sucuri (wafWorkaround text says so), set `hasWaf:true`, later corrected `wafType` to cloudflare-passive after a re-audit but forgot to flip `hasWaf` back. The 20 perPage is the lingering side-effect.

### 2. `catalogUrls` count divergence + path structure (12 top-level vs 6 sub-paths under three different parents)

DB has 6 URLs spanning THREE different parent path forms: `/shooting-supplies-and-firearms/storage-transportation/`, `/shooting-supplies-firearms-and-ammunition/firearms/`, `/shooting-supplies-firearms-ammunition/ammunition/`. The site has three competing slug spellings for what is conceptually the same parent ("Shooting Supplies, Firearms & Ammunition"). Candidate used `/shooting-supplies-and-firearms/` only (the canonical-looking one from the nav). WHY: the site's category taxonomy was reorganized at some point and BC's URL aliases preserved old paths — the DB list is a "scrape-all-the-aliases" defensive list; candidate is a "scrape-the-canonical" minimal list. Operator's wins for safety against future re-alias.

### 3. `apiConfig.klevuCategoryPaths` shape (12 top-level for candidate vs 8 sub-category for DB)

DB drills into specific firearm-relevant sub-paths (Rifles, Shotguns, Long Range Precision, Used Firearms, Airguns 500FPS+, Centerfire/Rimfire/Shotgun Ammunition). Candidate stayed at top level. WHY: the operator decided that for narrow firearm-relevance filtering, the Klevu adapter's `_resolveKlevuCategoryPath` should match on URL sub-segments (`/rifles`, `/shotguns`, etc.) rather than top-level parents — this requires both the deeper catalogUrls AND the matching sub-segment slugs in klevuCategoryPaths. Candidate would route every category-page fetch through the wildcard SEARCH, missing the per-category filter signal the operator wired in. This is a real design difference: candidate is broader-and-simpler, DB is narrower-and-firearm-focused.

Skill's biggest miss: I did NOT walk individual category pages with Playwright to enumerate the deep Klevu category paths (Rifles/Shotguns/etc.) — I stopped at the wildcard-SEARCH global count. The skill calls this a "deferred coverage proof" in `topLevelCategories.totalsSumCheck`. A complete Stage 4 would have driven Playwright through each category to capture the live `klevu_pageCategory` string, then matched those against the firearm-relevant scope filter.
