# R1 Blind Candidate vs DB Snapshot Diff — thegundealer.ca

Candidate: `docs/site-audit/thegundealer.ca-2026-05-22T20-00-00Z-B5R1.json`
DB snapshot: `_audit_tmp/batch5-2026-05-22/thegundealer.ca-DB-snapshot.json` (last DB-verified 2026-04-09; today 2026-05-22; DB is ~43 days stale)

## Field-by-field divergence

| # | Field | Candidate (R1 live) | DB snapshot | WHY |
|---|---|---|---|---|
| 1 | `hasWaf` (DB col + JSON) | `false` | `true` | DB says SiteGround sgcaptcha; live 8-batch probe today returns 200 on every batch with `cf-ray` only, NO sg-captcha challenge headers, NO meta-refresh, NO 202s. Site appears to have migrated off SiteGround sgcaptcha to Cloudflare passive. |
| 2 | `wafType` | `cloudflare-passive` | `siteground-sgcaptcha` | Same root cause as #1. WAF vendor changed live. DB note "iPhone UA load-bearing" no longer holds. |
| 3 | `userAgentOverride` | `null` | `Mozilla/5.0 (iPhone...)` | DB needed iPhone UA to bypass sgcaptcha; today desktop Chrome UA returns 200 on every batch including 10-burst. No UA gating. |
| 4 | `needsPlaywright` | `false` | `true` | Plain axios returns full Store API (11230) and HTML /shop/ (799KB with 24 products) on this audit IP. Playwright fallback not required. |
| 5 | `siteType` (DB col) | not emitted (not a SKILL target) | `js-rendered` | SKILL Stage 9 does not emit siteType; DB column should be reviewed for flip to `static` if migration confirmed. |
| 6 | `expectedProductCount` | `11230` | `11044` | DB count from 2026-04-09 (43 days ago). Live: WC Store API x-wp-total=11230, WP REST core=11230, sitemap loc=11230 — three-way agree. Net +186 products in 6 weeks. |
| 7 | `productCountMethod.method` | `wp-rest-header` | `wc-store-api-header` | Label drift only. Per SKILL B8/label-drift table, `wc-store-api-header` is NOT in the runtime 11-method switch and silently falls through to `default: return null` (count probe disabled). Canonical is `wp-rest-header` with `endpoint: /wp-json/wc/store/v1/products`. |
| 8 | `productCountMethod.endpoint` | `/wp-json/wc/store/v1/products` | `/wp-json/wc/store/v1/products?per_page=1` | Candidate stripped `?per_page=1` (the probe appends per_page itself). Either form works at runtime; both probe the same surface. |
| 9 | `productCountMethod.filterSupported` | not emitted | `true` | DB extra field not used by runtime probe; harmless residue. |
| 10 | `sortParam` | `?orderby=date` | `?orderby=date&order=desc` | DB added redundant `&order=desc` (WC orderby=date IS desc by default). Live 3-outcome counter-control verified `?orderby=date` alone yields newest-first descending IDs (213473/213467/213448). Both forms equivalent. |
| 11 | `sortVerified` | `true` | not emitted | DB never marked sortVerified; live verified via counter-control. |
| 12 | `paginationPattern.template` | `/page/{N}` | `/page/{N}/` | DB has trailing slash. Both resolve identically (WC redirects /page/N to /page/N/). Cosmetic. |
| 13 | `paginationPattern.perPage` | `24` | not in pattern (only top-level perPage=24) | Cosmetic; candidate also emits top-level `perPage:24` matching DB. |
| 14 | `paginationPattern.firstPageHasParam/startPage/zeroIndexed` | emitted | not emitted | DB schema incomplete; candidate filled per SKILL Stage 5 shape. |
| 15 | `catalogUrls` | 25 per-category URLs | `["https://thegundealer.ca/shop/"]` | DB single `/shop/` covers only 7327 customer-visible products (HTML title: "Showing 1-24 of 7327 results"). The 3903 hidden-from-shop firearm-relevant products (used-items, draws, auctions, promo cats) are unreachable via /shop/. Per Rule C the smallest set covering 100% firearm-relevant is the 25 per-category list. Caveat: DB watermark method is `api-date-since-watermark` so the watermark crawler walks WP REST core globally regardless of catalogUrls — but catalog/bootstrap walkers do use catalogUrls. |
| 16 | `crawlers.maintain.verifyMethod` | `store-api` | not emitted | DB never set crawlers.maintain block. Runtime worker.ts:tryStoreApiVerify reads this; missing = worker logs error and skips verification (per SKILL Stage 3). Material gap. |
| 17 | `crawlers.maintain.verifyEndpoint` | `/wp-json/wc/store/v1/products` | not emitted | Same as #16. |
| 18 | `crawlers.watermark.reason` | populated | not emitted | DB omits reason; only required when method=full-catalog-sweep, but candidate adds it as documentation of the Store API silent-ignore trap. |
| 19 | `wafLastProbedAt` | `2026-05-23T02:46:37Z` | `2026-04-09T07:16:57.719Z` | Re-probed today. |
| 20 | `wafProbeResult` | all 200 + cf-ray + cloudflare-passive verdict | "Cookie reuse CONFIRMED WORKING via waf-cookie-manager" | Different verdict reflects apparent WAF migration off sgcaptcha. |
| 21 | `wafProbeEvidence` | new shape (cfHeaders/honeypotPathsBlocked/rapidBurstTested/sustainedWalkPages/untestedAttackSurfaces) | DB sgcaptcha-era shape | Re-derived against current site. |
| 22 | `notes` (legacy field) | not emitted | long sgcaptcha-era note about iPhone UA load-bearing | Candidate intentionally drops the legacy `notes` field (audit-trail residue per Rule B; should be cleared on promotion if migration confirmed). |
| 23 | `totalSiteProductCount` | not emitted | `11044` | Redundant with expectedProductCount; not a SKILL-target field. |
| 24 | `extractionTested` | `true` | not emitted | New SKILL field. |
| 25 | `extractionSample` | 3 products | not emitted | New SKILL field. |
| 26 | `topLevelCategories` | 25 cats with WP REST counts + totalsSumCheck | not emitted | New SKILL recommended field. |
| 27 | `auditNotes.*` | populated (verifyMethodPolicy, expectedCountSurface, wcCategoryApi, shopVsStoreApiDelta, dbColumnFlips, fieldConfidence, stageNotes) | not emitted | New SKILL field. |
| 28 | `hasCaptcha` (DB col + JSON) | `false` + `captchaType: recaptcha-v3` | DB col `false`, JSON absent | Site loads reCAPTCHA v3 via Contact Form 7 site-wide but does not gate the catalog crawler path. Operational hasCaptcha=false; captchaType documented for triage UI. |
| 29 | `ageGate` | `{detected:false, type:null, bypassCookie:null}` | not emitted | No age-gate detected on homepage HTML. |

## Top 3 WHYs (most material)

1. **WAF migration (DB stale by 43 days).** DB says `wafType: siteground-sgcaptcha`, `userAgentOverride: iPhone`, `needsPlaywright: true` — all derived 2026-04-09. Today's live 8-batch probe returns 200 on every batch with desktop Chrome UA, only `cf-ray` headers, no sg-captcha challenge body. Site appears to have migrated off SiteGround sgcaptcha onto Cloudflare passive. If confirmed by R2 from production crawler IP, three runtime levers flip together (hasWaf false, userAgentOverride null, needsPlaywright false) — perPage cap is removed, no Playwright detour. The DB notes file describes a load-bearing iPhone UA + waf-cookie-manager wait-strategy fix that may no longer apply at all.

2. **catalogUrls = /shop/ misses ~3900 firearm-relevant products.** DB's single `/shop/` shows literally "Showing 1-24 of 7327 results" on HTML; Store API global = 11230; sitemap = 11230. The 3903 delta lives in catalog_visibility-excluded categories (used-items 196, draws 166, auctions 3, new-arrivals 162, promo/clearance/special-* totaling ~2900). For full firearm-relevant coverage per Rule C, catalogUrls needs the 25 top-level per-category list. (Caveat: DB watermark method is `api-date-since-watermark` so the watermark crawler walks WP REST core globally regardless of catalogUrls — but catalog/bootstrap walkers do use catalogUrls.)

3. **productCountMethod label drift = silent count-probe disabled.** DB stores `method: "wc-store-api-header"` which is NOT in the runtime 11-method switch at `product-count-probe.ts:148-451`. Per SKILL B8 validator gate and Mistake-table: unknown method names land on `default: return null` (line 446-451) and the count probe silently returns null. The drift coverage gate (`verifyBootstrapCoverage` at `product-count-probe.ts:521-525`) computes `ratio=null → isAcceptable=true`, disabling coverage detection end-to-end. Canonical label is `wp-rest-header`. R3 should re-test against the live runtime to confirm whether DB's `wc-store-api-header` string was already remapped via legacy compat shim, or whether this site has had a silently-disabled count probe since onboarding.

## Divergence count: 29 fields differ.

## Blockers / inconclusives

- **catalogUrls coverage proof DEFERRED**: did not walk all 25 per-category URLs to ID-dedup their unions vs the Store API global 11230 (would exceed 20-min budget). Confidence medium. Recommended R2 task: walk 3-5 of the per-category URLs through all pages, compare ID sets, confirm union approaches 11230.
- **perPage maximum NOT probed**: candidate ships perPage=24 (page-1 default observed). SKILL Stage 5 mandates probing maximum verifiable limit. R2 should probe `?per_page=50/100/250` on Store API and HTML overrides.
- **WAF re-verification from production crawler IP required**: candidate's `hasWaf=false` is "from THIS audit IP". DB notes sgcaptcha-classified history. Production crawler IP may still see sgcaptcha if previously allowlisted on the OLD WAF and CF is now selective. Mandatory R2/R3 task.
- **Sustained 50-page-per-UA walk NOT run** (B9): single-snapshot 8-batch probe is insufficient to rule out CF UA-reputation escalation after 60s. Recommended R2.
- **Store API per-cat allOption (B11 strict)**: candidate's allOption values come from WP REST product_cat.count (admin per-term, non-recursive) while expectedProductCount comes from Store API global. Surface mismatch documented but not reconciled. R2 should re-fetch each top-level cat via `GET /wp-json/wc/store/v1/products?category=N&per_page=1` and read x-wp-total to align.
