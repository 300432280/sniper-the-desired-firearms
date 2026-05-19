# R1 Blind Diff - pavillonchassepeche.ca

**Candidate:** `docs/site-audit/pavillonchassepeche.ca-2026-05-13T08-30-12Z-R1.json`
**DB reference:** `MonitoredSite{domain='pavillonchassepeche.ca'}.siteProfile` (lastVerified `2026-04-12`)
**Run:** R1 blind, 2026-05-13. Calibration only - no DB writes.

## Convergent (no divergence)

| Field | Both say | Why this matches |
|---|---|---|
| `platform` | `woocommerce` | WC 10.7.0 plugin marker stable since DB capture. |
| `adapterType` | `woocommerce` | Same. |
| `hasWaf` | `false` | DB notes "LiteSpeed direct"; R1 8-batch confirmed no CDN/WAF markers. |
| `hasCaptcha` | `false` | Neither sees a CAPTCHA gating the catalog path. |
| `needsPlaywright` | `false` | Plain HTTP returns full product markup. |
| `wafType` | `null` | Same - no WAF vendor to record. |
| `paginationPattern.type` | `path` | `/page/{N}/` works; query forms NOOP. |
| `paginationPattern.template` | `/page/{N}/` | Same. |
| `sortParam` | `?orderby=date` | 3-outcome counter-control honored. |
| `sortVerified` | `true` | Same. |
| `crawlers.watermark.method` | `api-date-since-watermark` | WP REST `?after=` two-probe verified. |
| `crawlers.bootstrap.apiEndpoints` | productDiscovery `/wp-json/wp/v2/product` + priceEnrichment `/wp-json/wc/store/v1/products` | Same endpoints. |
| `searchUrl` | `/?s={keyword}&post_type=product` | R1 carried from DB (not freshly verified - flagged medium confidence). |

## Divergent

| # | Field | DB value | R1 value | One-line WHY |
|---|---|---|---|---|
| 1 | `catalogUrls` (scope) | 6 URLs covering all top-level cats (chasse + liquidation + peche + clothing + plein-air + salines), all `/en/` prefix | 2 URLs covering firearm-relevant only (chasse + salines), FR (no `/en/`) | Skill Rule C scope says "firearm-relevant" only - peche/clothing/plein-air are excluded. DB takes a broader full-catalog stance. |
| 2 | `catalogUrls` (language) | All `/en/product-category/<en-slug>/` | All `/categorie-produit/<fr-slug>/` | Site is WPML bilingual FR/EN; FR is the apex default (canonical homepage URL is FR). DB uses EN translations; R1 uses FR canonical because that's what the homepage and taxonomy API return. |
| 3 | `expectedProductCount` | `1318` | `1245` | DB used `/wp-json/wp/v2/product` (admin REST, includes drafts) - today reads 1253. R1 chose WC Store API customer-visible (1245). Either defensible; 73 product delta also reflects ~month of inventory turnover. |
| 4 | `productCountMethod.endpoint` | `/wp-json/wp/v2/product` with `wpRestTotal/enScopeTotal/storeApiTotal/rootScopeTotal` audit fields | `/wp-json/wc/store/v1/products` (just method/endpoint/header) | Skill prefers the customer-visible (Store API) count. DB stuffed multiple raw probe totals into the method object - operator audit-trail residue (Rule B violation). |
| 5 | `perPage` | `100` | `36` | DB conflates API per_page (100 works on WP REST) with HTML perPage. HTML archive (Elementor loop) is fixed at 36 and ignores `?per_page=`. R1 records the HTML-runtime value because `paginationPattern` describes HTML pagination. |
| 6 | `paginationPattern.perPage` | absent (only `type` + `template`) | `36` | Schema requires `perPage` inside `paginationPattern` (see SKILL.md Output target). DB is missing the field. |
| 7 | `paginationPattern.firstPageHasParam/startPage/zeroIndexed` | absent | `false`/`1`/`false` | DB profile is older schema; R1 fills the full discriminated union. |
| 8 | `crawlers.maintain.verifyMethod` | `json-ld` | `store-api` | Skill Stage 3 derived rule: WC platform -> verifyMethod=`store-api`. DB's `json-ld` is a deprecated method that worker.ts may no longer route; latest skill explicitly maps WC to `store-api`. |
| 9 | `crawlers.maintain.verifyEndpoint` | absent | `/wp-json/wc/store/v1/products` | Required when verifyMethod is `store-api`. |
| 10 | `wafLastProbedAt` | `2026-04-12` (date only) | `2026-05-13T08:19:51Z` (full ISO) | Fresher run, full ISO. |
| 11 | `lastVerified` | `2026-04-12` | `2026-05-13` | Fresher. |
| 12 | `wafProbeEvidence` | absent | populated (server header, status burst, honeypot notes) | DB has `wafProbeResult` string only; R1 also emits the structured evidence subset. |
| 13 | `userAgentOverride` | absent | `null` | DB omits; R1 explicit null per schema. |
| 14 | `ageGate` | absent | `{detected:false, type:null, bypassCookie:null}` | DB omits; R1 explicit per schema. |
| 15 | DB extras NOT in R1 | `siteProfile.name`, `budget:60`, `timeout:15000`, `crawlPhase:'bootstrap'`, `multilingual:'wpml'`, `siteCategory:'retailer'`, `t1IntervalMin:17`, `expectedInStockCount:1291`, `hasRateLimit:false`, `dataFlow.steps[]`, `crawlers.maintain.cooldowns/tierShares/tierWindows`, `crawlers.bootstrap.method/htmlFallback`, `notes` string with operator history | absent | These are MonitoredSite-level operator fields and tier-scheduler runtime config, NOT pre-bootstrap output. Per Rule B they belong outside the candidate siteProfile. |
| 16 | `topLevelCategories` | absent | populated with 6-category audit + firearm-relevance per-row | New schema field per current SKILL.md. |
| 17 | `extractionTested/extractionSample` | absent | populated | New schema field per current SKILL.md. |
| 18 | productCountMethod extras (`wpRestTotal`, etc) | present (audit residue) | absent | Rule B residue - DB profile carried operator scratch into runtime field. |

## Most surprising divergences

1. **Language scope**: DB picked the English (`/en/...`) URLs, R1 picked French (canonical apex). Both work because WPML serves both; runtime crawler will index either side. The skill never told me to prefer the localized variant - and the FR side IS the canonical (no /en/ in apex URL). DB choice is operator-set, not derivable from probes.
2. **Scope philosophy (firearm-relevant vs full catalog)**: DB has 6 catalog URLs covering 100% of the 1245-product catalog. R1 has 2 covering 461 firearm-relevant products. SKILL.md Rule C explicitly says "firearm-relevant" - but a 461/1245 = 37% scope feels narrow on a hunting-and-fishing site whose name is literally "Pavillon Chasse et Peche" (Hunting and Fishing Pavilion). The skill is right per its rule; the DB takes a broader stance.
3. **`crawlers.maintain.verifyMethod = json-ld` (DB)**: deprecated; worker.ts now routes via `store-api`/`detail-page` enum. DB has stale schema here.

## R1 partial flags

None. All stages completed.

`_partial: false`
