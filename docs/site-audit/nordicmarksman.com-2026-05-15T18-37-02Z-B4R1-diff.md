# Diff — nordicmarksman.com Candidate vs DB siteProfile

**Candidate**: `docs/site-audit/nordicmarksman.com-2026-05-15T18-37-02Z-B4R1.json`
**DB**: `MonitoredSite{domain:'nordicmarksman.com'}`
**Run**: Batch 4 / Round 1 BLIND
**Date**: 2026-05-15

## Divergent fields (one-line WHY each)

| Field | Candidate | DB | Why divergent |
|---|---|---|---|
| `hasWaf` (column) | `false` | `true` | DB COLUMN says true; DB JSON `siteProfile.hasWaf` also true; but `wafType` in DB is `cloudflare-passive` which per skill Stage 2 rule should map to `hasWaf=false` (operational, not literal). DB is inconsistent with itself (passive + true). Candidate applies the rule correctly. |
| `siteProfile.hasWaf` | `false` | `true` | Same as above - DB tagged passive Cloudflare as `hasWaf:true`, candidate per skill rule treats passive as `hasWaf:false`. |
| `perPage` | `50` | `20` | DB shipped 20 (BC Stencil default page-1 product count). Candidate verified `?limit=500` returns 441 (full firearms cat) and `?limit=2500` returns 1438 (full accessories) - sites honors high values. 50 chosen as conservative-but-better baseline. DB is the floor; candidate raises it. |
| `paginationPattern.perPage` | `50` | (absent) | DB pagination block omits perPage; candidate includes it (skill Stage 5 requires it). |
| `paginationPattern.firstPageHasParam` | `false` | (absent) | DB omits; candidate includes. |
| `paginationPattern.startPage` | `1` | (absent) | DB omits; candidate includes. |
| `paginationPattern.zeroIndexed` | `false` | (absent) | DB omits; candidate includes. |
| `catalogUrls` | 11 per-category URLs with `?sort=newest` | `["/categories.php"]` | DB has a placeholder `/categories.php` (BC's all-categories listing page - NOT a product listing; this is a stale incomplete profile from initial onboarding). Candidate has 11 firearm-relevant category URLs covering 95.0% of products (4475 of 4711) per Stage 4 Rule C. |
| `expectedProductCount` | `4711` | `4605` | Sitemap delta: DB count (4605) was from 2026-04-08; candidate (4711) is current. +106 products added in 37 days = ~2.9 products/day, consistent with active retailer. Re-derivation per Mistake 13. |
| `productCountMethod.method` | `sitemap-index` | `sitemap` | DB uses `sitemap` with array `sitemapUrls`. Candidate uses canonical `sitemap-index` with `urls` field per [`product-count-probe.ts:212`](../../backend/src/services/product-count-probe.ts) switch case for multi-file sitemaps. DB's "sitemap+sitemapUrls" is a label-drift hybrid; runtime case at line 204 reads `m.url` (singular). The DB shape would fall through to default and silently return null. |
| `productCountMethod.urls` | array `["/xmlsitemap.php?type=products&page=1", "...page=2"]` | `sitemapUrls` field | Field name divergence: canonical key per runtime is `urls`, DB uses `sitemapUrls`. |
| `productCountMethod.lastCount` | (absent) | `4605` | DB carries a `lastCount` observability field; candidate omits (not in canonical method shape per Stage 8). |
| `wafProbeResult` | `cloudflare-passive: cf-ray on every batch...` (verbose) | `cloudflare-passive-no-rules-firing` (terse) | Both equivalent; format/verbosity differs. |
| `wafProbeEvidence` shape | `cfHeaders`, `sucuriHeaders`, `rapidBurstStatus` (array), `honeypotPathsBlocked` (array), `noUaStatus` | `cfRayExample`, `serverHeader`, `cfBmCookieSet`, `multiUaAllowed`, `cfHeadersDetected`, `rapidBurstStatus` (string), `honeypotPathsBlocked` (boolean) | Two different evidence schemas (DB run on 2026-04-08, candidate on 2026-05-15). Candidate matches `example-output.json` shape. |
| `wafLastProbedAt` | `2026-05-15T18:26:09Z` | `2026-04-08T06:14:47Z` | Candidate is current. |
| `lastVerified` | `2026-05-15` | `2026-04-08` | Candidate is current. |
| `searchUrl` | (omitted - not auto-discovered) | `/search.php?search_query={keyword}` | DB has it; candidate didn't probe search URL during this run. BC Stencil canonical is `/search.php?search_query={keyword}` - DB is correct. Candidate gap. |
| `crawlers.maintain.method` | (omitted) | `db-verification` | DB carries an extra `method` field alongside `verifyMethod`; candidate omits per Stage 3 minimal-output rule. |
| `crawlers.maintain.cooldowns` / `tierShares` / `tierWindows` | (omitted) | filled tier config | These are operator-set runtime tunings (Tier 2/3/4 sweep schedule), NOT pre-bootstrap outputs. Candidate correctly omits per Rule B (audit-trail residue). |
| `crawlers.bootstrap.method` / `htmlFallback` | (omitted) | `single-continuous` / `true` | Operator runtime config, candidate omits per Rule B. |
| `crawlers.bootstrap.apiEndpoints` | `{sitemapIndex, productsSitemaps, categoriesSitemap}` populated | `null` | DB has `null`; candidate populates with BC sitemap URLs (useful for bootstrap to seed product list). |
| `dataFlow` | (omitted) | populated | DB has `dataFlow.steps[]` documenting extraction provenance - operator audit-trail residue. Candidate omits per Rule B. |
| `topLevelCategories` | populated (13 categories with allOption counts + notes) | (absent) | Candidate provides operator documentation per Stage 4f recommended block; DB doesn't carry it. |
| `extractionTested` / `extractionSample` | populated | (absent) | Candidate provides Stage 4g spot-check evidence; DB omits. |
| `auditNotes` | populated (`runId`, `probeIp`, `fieldConfidence`, `stageNotes`) | (absent) | Candidate provides per-run audit metadata; DB omits. |
| `siteCategory` / `crawlPhase` / `hasRateLimit` / `budget` / `timeout` / `t1IntervalMin` / `name` / `domain` (within siteProfile) | (omitted) | populated | DB carries MonitoredSite operator-set runtime tuning fields inside siteProfile JSON; candidate omits per Rule B (these are operator-promotion concerns, not pre-bootstrap-skill output). |

## Summary

**Divergent field count: 24** (mix of substantive differences and skill-omitted operator-residue).

### Most surprising divergences

1. **`hasWaf=true` in DB despite `wafType=cloudflare-passive`** - DB is self-inconsistent: it tags Cloudflare passive but flips the boolean to true. Per skill Stage 2 rule "cf-ray AND all 200 AND no plugin markers -> `hasWaf: false`", the candidate flips it to false to avoid the runtime cost (catalog-crawler drops perPage to 20 + routes through WAF cookie manager). The DB's `perPage:20` is the visible consequence of `hasWaf:true`. This is the operationally most impactful divergence.

2. **`catalogUrls: ["/categories.php"]` in DB** - that's not a product listing URL; it's BC's category index page. The DB profile is essentially incomplete/placeholder from initial onboarding 37 days ago. Candidate provides the actual 11 firearm-relevant top-level category URLs with `?sort=newest` baked in.

3. **`productCountMethod` schema mismatch** - DB stores `{method:'sitemap', sitemapUrls:[...], lastCount:4605}`. Runtime case for plural sitemaps is `sitemap-index` with `urls` field (`product-count-probe.ts:212`). If runtime ever runs the count probe against the DB shape, the `sitemap` case at line 204 reads `m.url` (singular) and would fall through. Hidden runtime bug masked by `lastCount` cache.

## Suggested SKILL.md harness gaps

1. **Stage 3 should auto-probe `searchUrl`.** Candidate omitted it (not auto-discovered). DB had `/search.php?search_query={keyword}` which is the BC Stencil canonical. The skill's Stage 3 "If the site has a keyword-search URL" guidance is contingent ("Discovery: open the site's search box...") but a platform-deterministic table for BC Stencil/Shopify/WC/Magento would close the gap automatically - same way `crawlers.maintain.verifyMethod` is platform-deterministic.

2. **Stage 5 perPage guidance could be sharper.** The skill says "ship the largest verified value, no upper cap." Candidate verified `limit=2500` honored but shipped 50 as a "conservative baseline." Either the skill should explicitly require the largest verified value (current wording) and not allow operator-conservatism in the candidate, OR it should provide a `recommendedPerPage` companion field separate from `paginationPattern.perPage` so the candidate carries both the ceiling AND a safer runtime starting value. Current ambiguity made the candidate hedge.

3. **Stage 4 OOS-hidden-on-Stencil should be a first-class platform quirk.** Stage 4h lists Shopify/WC/Wix/Volusion/LightSpeed quirks but not BC Stencil's "OOS hidden on category pages" (the 5%-edge sitemap-vs-walk gap seen here). Add a BC Stencil bullet to Stage 4h pointing explicitly to "sitemap includes OOS; category walks don't - gap proves OOS, not coverage failure" so future audits don't burn discovery time investigating the gap.
