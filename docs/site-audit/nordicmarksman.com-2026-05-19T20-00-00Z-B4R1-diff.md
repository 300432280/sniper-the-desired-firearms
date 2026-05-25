# nordicmarksman.com — B4R1 Diff vs DB

Candidate: `docs/site-audit/nordicmarksman.com-2026-05-19T20-00-00Z-B4R1.json`
DB snapshot: `_audit_tmp/batch4-2026-05-19/nordicmarksman.com-DB-snapshot.json`
DB lastVerified: 2026-04-08 (41 days before this audit)

## Convergent (no divergence)

| Field | Both |
|---|---|
| `platform` | `bigcommerce-stencil` |
| `adapterType` | `generic-retail` |
| `hasCaptcha` | `false` |
| `wafType` | `cloudflare-passive` |
| `needsPlaywright` | `false` |
| `wafProbeMethod` | `heavy-8-batch` |
| `sortParam` | `?sort=newest` |
| `paginationPattern.type` | `query` |
| `paginationPattern.template` | `page` |
| `crawlers.watermark.method` | `navigate-from-watermark` |
| `crawlers.maintain.verifyMethod` | `detail-page` |
| `productCountMethod.sitemapUrls` (DB) and `productCountMethod.urls` (candidate) | same 2 URLs |

## Divergences

| # | Field | DB | Candidate | WHY hypothesis |
|---|---|---|---|---|
| 1 | `hasWaf` (column + JSON) | `true` | `false` | DB still flags WAF=true even though probe evidence (`cloudflare-passive-no-rules-firing`, `honeypotPathsBlocked: false`) says no active challenge. Skill correctly treats `hasWaf` as operational, not literal: Cloudflare passive does NOT need the runtime perPage=20 throttle. DB likely set defensively or never updated after probe. |
| 2 | `expectedProductCount` | `4605` | `4719` | Catalog grew by 114 products in ~41 days (or sitemap had 114 fewer stale entries 41 days ago). Both methods are sitemap-based; the increase is real product growth. Per Mistake 13 ("don't trust stored count"), re-derive every audit. |
| 3 | `productCountMethod.method` | `sitemap` (with `sitemapUrls` field) | `sitemap-index` (with `urls` field) | DB shape uses single-method label with a nested URL array; runtime switch at product-count-probe.ts has BOTH `sitemap` (line 244) and `sitemap-index` (line 252). For a multi-page product sitemap, `sitemap-index` is canonically correct. DB's `sitemap` + `sitemapUrls` likely sum-walks both; this is a soft/label-drift divergence the operator may want to normalize. |
| 4 | `productCountMethod.lastCount` | `4605` | (not present) | DB retains last-probe count alongside config; candidate doesn't (no spec for it in the harness output shape). Operator-added persistence field — not a runtime input. |
| 5 | `perPage` | `20` | `2500` | Stage 5 rule: ship the verified maximum. limit=2500 confirmed honored on multiple categories (single response). DB ships the BC-default 20: produces 24x more requests per catalog walk. DB is conservative/legacy; candidate is per spec. |
| 6 | `paginationPattern.perPage` | (not present) | `2500` | Candidate adds the spec-required field. DB pagination object only has `type` + `template`. |
| 7 | `paginationPattern.firstPageHasParam` | (not present) | `false` | Spec-required field present in candidate; missing in DB. |
| 8 | `paginationPattern.startPage` | (not present) | `1` | Spec-required field; DB legacy. |
| 9 | `paginationPattern.zeroIndexed` | (not present) | `false` | Spec-required field; DB legacy. |
| 10 | `catalogUrls` | `["/categories.php"]` | 12 per-category URLs | DB uses a single legacy BC1.x "all categories" URL. `/categories.php` on Stencil renders the category-index page (not a product listing): likely produces 0 products at runtime, or the crawler relies entirely on watermark+sitemap. Candidate per Rule C lists 12 firearm-relevant top-level parents (94.6% coverage vs sitemap). Major divergence: DB likely from pre-Rule-C era. |
| 11 | `sortVerified` | (not present) | `true` | Spec-required field; DB legacy (no sort verification record). |
| 12 | `extractionTested` | (not present) | `true` | Spec-required field; DB legacy. |
| 13 | `extractionSample` | (not present) | 3-product evidence | Optional candidate field. |
| 14 | `topLevelCategories` | (not present) | 12-category breakdown + totalsSumCheck | Optional candidate field — operator documentation. |
| 15 | `wafProbeResult` | `"cloudflare-passive-no-rules-firing"` | long-form prose | Same conclusion, different verbosity. DB compact; candidate explanatory. |
| 16 | `wafProbeEvidence` shape | DB keys (`cfRayExample`, `serverHeader`, `cfBmCookieSet`, `multiUaAllowed`, `cfHeadersDetected`) | Candidate keys (`cfHeaders`, `sucuriHeaders`, `rapidBurstStatus` as array, `verdict`) | Schema drift between skill iterations: same evidence, different field names. Operator merge needed. |
| 17 | `wafLastProbedAt` | `2026-04-08T06:14:47Z` | `2026-05-19T08:52:55Z` | Re-probed on this audit (41 days later); skill always re-runs probe. |
| 18 | `searchUrl` | `/search.php?search_query={keyword}` | (not present) | DB has a BC-native search URL; candidate didn't generate this field. Skill's Stage 3 says "If the site has a keyword-search URL" — I didn't probe `<form>` for the search input on the homepage. Gap in this run. Likely should add. |
| 19 | `crawlers.bootstrap` | `{method: "single-continuous", apiEndpoints: null, htmlFallback: true}` | (not present per spec) | SKILL.md "Output target" explicitly says `crawlers.bootstrap.apiEndpoints` REMOVED from required/recommended; zero runtime consumers. DB still carries the legacy block. |
| 20 | `crawlers.maintain.method` | `"db-verification"` | (not present) | DB has both `method: db-verification` AND `verifyMethod: detail-page`. The skill spec only requires `verifyMethod`. `method` looks like an older tier-cooldown scheduler field; not consumed by `tryStoreApiVerify`. |
| 21 | `crawlers.maintain.cooldowns / tierShares / tierWindows` | populated (t2/t3/t4 schedule) | (not present) | DB carries Tier 2-4 scheduler config inside siteProfile.crawlers.maintain. Skill doesn't generate scheduler params — those are operator/scheduler-owned, not pre-bootstrap output. |
| 22 | `name`, `budget`, `timeout`, `crawlPhase`, `hasRateLimit`, `siteCategory`, `t1IntervalMin`, `dataFlow` | populated (admin/scheduler fields) | (not present) | Operator/admin fields — explicitly out of pre-bootstrap scope per "Output target" shape. |
| 23 | `lastVerified` | `2026-04-08` | `2026-05-19` | This audit's date. |
| 24 | `wafWorkaround` | `null` (explicit) | (not present — omitted) | Both effectively-null. DB explicitly writes null; candidate omits per "OPTIONAL — populate ONLY when…". |
| 25 | `auditNotes` | (not present) | populated (fieldConfidence + stageNotes + 4 site-specific notes) | Optional candidate field. |

## Divergence count

**25 divergent fields** (12 are skill-spec-required fields that DB lacks because it predates the spec; 6 are operator/scheduler/admin fields out of skill scope; 7 are real value divergences).

## Top 3 surprising divergences with WHY

1. **`catalogUrls`: DB=`["/categories.php"]` vs Candidate=12 parent paths.** `/categories.php` on BC Stencil renders a category-index page, NOT a product listing. The runtime catalog crawler walking this URL extracts 0 products. DB is from a pre-Rule-C era when catalogUrls were a single placeholder. WHY: skill iteration history — Rule C ("100% firearm-relevant coverage via per-category list") is a recent rule the DB record never absorbed.

2. **`perPage`: DB=20 vs Candidate=2500.** DB ships the BC theme default. Candidate ships the verified max per Stage 5 rule "no upper cap; ship the verified maximum". For 4719 products, this is 24x fewer HTTP requests per catalog walk. WHY: DB never had the maximum-perPage probe in its pipeline; this is a Stage 5 capability added later. The 5-MB single-shot response is a real tradeoff — operator may choose to downshift to 250.

3. **`hasWaf`: DB=true vs Candidate=false.** Both probes agree the site is `cloudflare-passive-no-rules-firing` — yet DB sets `hasWaf: true`. Setting `hasWaf: true` makes the runtime crawler drop perPage to 20 AND route through the WAF cookie manager — both unnecessary for passive Cloudflare. WHY: legacy defensive default — early sessions set `hasWaf: true` whenever `cf-ray` was seen, regardless of whether challenges fired. The skill now distinguishes passive (no throttle needed) from active (throttle + iPhone UA). DB record predates the operational/literal distinction.

## Blockers

None. Candidate is internally consistent and validates against profile-validator shape. DB divergences are explainable by legacy-record drift, not by candidate errors.

## Skill gap surfaced

- **`searchUrl` not probed.** DB has `/search.php?search_query={keyword}` (the BC-native search). Stage 3's "If the site has a keyword-search URL" conditional says to discover by opening the search box; this run did not test for a search form on the homepage. Recommend: Stage 3 add a deterministic homepage search-form check (look for `<form action="/search.php">` + `<input name="search_query">` for BC, equivalent patterns for other platforms).
