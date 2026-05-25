# R1 vs DB diff — rdsc.ca — 2026-05-22T20:00:00Z

Candidate: `docs/site-audit/rdsc.ca-2026-05-22T20-00-00Z-B5R1.json`
DB snapshot: `_audit_tmp/batch5-2026-05-22/rdsc.ca-DB-snapshot.json` (lastVerified 2026-04-08)

## Field-by-field divergence

| # | Field | R1 (candidate) | DB (snapshot) | One-line WHY |
|---|---|---|---|---|
| 1 | `hasWaf` (column + JSON) | `false` | `true` (siteProfile.hasWaf AND column_hasWaf) | DB has wafType=cloudflare-passive AND hasWaf=true together — operationally inconsistent per skill B10; cloudflare-passive does not block, so hasWaf should be false. R1 emits `dbColumnFlips.hasWaf:false`. |
| 2 | `platform` | `magento-2.x` | `magento2` | Separator drift; skill canonical uses hyphenated `magento-2.x` per Stage 3 platform table. |
| 3 | `perPage` | `48` | `24` | R1 probed limits; only 24 and 48 are honored on rdsc; 48 is the verified maximum per Stage 5 rule; DB stored page-1 default. |
| 4 | `paginationPattern.perPage` | `48` | `24` | Same as #3 — verified max not page-1 default. |
| 5 | `catalogUrls` | 9 per-top-level URLs (firearms-ammunition, optics-mounts, handgun-parts, semi-auto-rifle-parts, precision-rifle-parts, lever-action-parts, shotgun-parts, gear-kit, clean-maintain) | `["/new-products.html"]` single aggregator | Both reach 100% coverage (DB aggregator 9343 = R1 union 9000 + 343 special-tax products). Skill Rule C prefers the per-top-level spine because it's the site's own category structure; DB chose the single all-products aggregator for runtime simplicity. Either valid; operator runtime decision. |
| 6 | `expectedProductCount` | `9343` | `9089` | Live count drifted +254 since DB lastVerified 2026-04-08 (~6 weeks); R1 measured 9343 today on /new-products.html toolbar. |
| 7 | `productCountMethod.method` | `html-pagination` | `magento2-toolbar-count` | DB method name is NOT in the canonical 11-method runtime switch (skill B6 / Stage 8 validator gate); falls through to default→null silently. R1 uses canonical `html-pagination` with explicit selector. |
| 8 | `sortParam` | `?product_list_order=new&product_list_dir=desc` | `?product_list_order=new` | R1 includes both axis and direction (matches Magento toolbar config orderDefault:new + directionDefault:desc); DB omits direction. Functionally equivalent at runtime since desc is Magento default for `new` order. |
| 9 | `captchaType` | `recaptcha-v2` (informational) | (absent) | reCaptcha-v2 script present in Magento login popup HTML (Magento_ReCaptchaFrontendUi); does not gate catalog so hasCaptcha=false; skill Stage 3 still records captchaType for operator triage. |
| 10 | `wafProbeEvidence.rapidBurstTested` + `untestedAttackSurfaces` | `true` + caveats listed | absent | New skill B9 fields not present in 2026-04-08 DB shape. |
| 11 | `productUrlSchemes` | present (canonical/sitemapForm/categoryForm) | absent | Same product reachable as `/<slug>.html` (sitemap) and `/<category>/<slug>.html` (category listing) — dedup needed; R1 documents both forms. |
| 12 | `topLevelCategories` | 9-category breakdown with allOption counts | absent | Skill Stage 4f recommends documenting per-category for operator review. |
| 13 | `paginationPattern.firstPageHasParam`/`startPage`/`zeroIndexed` | present | absent | R1 emits full schema; DB has minimal pagination shape. |
| 14 | `wafProbeEvidence` cf headers shape | `cfHeadersDetected: [server, CF-RAY x3]` | `cfHeadersDetected: [server, cf-ray, cf-cache-status]` + `cfRayExample` field | Cosmetic field-name drift; same underlying evidence. |
| 15 | `lastVerified` / `wafLastProbedAt` | 2026-05-22 | 2026-04-08 | Expected — re-audit timestamps. |
| 16 | `wafWorkaround` | `null` (explicit) | `null` (explicit) | Match. |
| 17 | `needsPlaywright` | `false` | `false` | Match. |
| 18 | `hasCaptcha` | `false` | `false` | Match. |
| 19 | `adapterType` | `generic-retail` | `generic-retail` | Match. |
| 20 | `crawlers.watermark.method` | `navigate-from-watermark` | `navigate-from-watermark` | Match. |
| 21 | `crawlers.maintain.verifyMethod` | `detail-page` | `detail-page` | Match. |
| 22 | `searchUrl` | `/catalogsearch/result/?q={keyword}` | `/catalogsearch/result/?q={keyword}` | Match. |

## Divergence count: 14 substantive + 2 timestamp = **16 total**

## Blockers
None. All probes returned 200; no rate-limit triggered; sustained-walk not run (B9 untested attack surface, documented in evidence).

## Top 3 WHYs

1. **hasWaf=true with wafType=cloudflare-passive in DB is an internally inconsistent state** (skill B10 catches this) — cloudflare-passive does NOT actively block the crawler so hasWaf should be false to avoid silent perPage 50→20 throttle and unnecessary WAF cookie cache invocation.
2. **DB perPage=24 leaves performance on the table** — Magento toolbar default is 24 but the site honors 48; using 48 halves request count for a full catalog walk (188 pages instead of 376 for 9343 products).
3. **DB productCountMethod.method `magento2-toolbar-count` is not in the runtime switch's canonical 11** — silently falls through to `default: return null`, disabling the count probe and the bootstrap coverage gate (`verifyBootstrapCoverage` ratio=null → isAcceptable=true → coverage check disabled end-to-end).
