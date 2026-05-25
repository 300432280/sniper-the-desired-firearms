# B5R1 Diff — store.prophetriver.com (2026-05-22)

Candidate: `docs/site-audit/store.prophetriver.com-2026-05-22T20-00-00Z-B5R1.json`
DB snapshot: `_audit_tmp/batch5-2026-05-22/store.prophetriver.com-DB-snapshot.json` (lastVerified 2026-04-08)

## Field-by-field divergence

| # | Field | DB | Candidate | 1-line WHY |
|---|---|---|---|---|
| 1 | `column_hasWaf` | `true` | `false` | DB column contradicts DB's own `wafType: "cloudflare-passive"`; B10 says column MUST flip with type; CF-passive = informational, all 8 batches 200, no challenges. |
| 2 | `siteProfile.hasWaf` | `true` | `false` | Same B10 contradiction surfaced inside the JSON profile too. |
| 3 | `perPage` | `20` | `100` | DB's `20` is the hasWaf=true throttle floor; live probe shows `?limit=50` and `?limit=100` honored, `?limit=250` silently caps at 100. |
| 4 | `paginationPattern.perPage` | (absent) | `100` | DB only stores `type/template`; runtime URL builder needs `perPage` set. |
| 5 | `paginationPattern.firstPageHasParam` | (absent) | `false` | Bare `/ammunition/` returns page 1 with no param; DB omission. |
| 6 | `paginationPattern.startPage` | (absent) | `1` | Standard BC Stencil 1-indexed. |
| 7 | `paginationPattern.zeroIndexed` | (absent) | `false` | Same; required field per skill schema. |
| 8 | `expectedProductCount` | `13766` | `13974` | Site grew +208 products since DB lastVerified 2026-04-08 (44 days); sitemap-index walk produced exact 10000+3974. |
| 9 | `productCountMethod.method` | `"sitemap-xml"` | `"sitemap-index"` | DB value not in runtime switch (`product-count-probe.ts` cases) → silently returns null → coverage gate disabled; canonical name is `sitemap-index` with `urls` array. |
| 10 | `productCountMethod.urls` | (DB has nested `pages[]` object) | `["...&page=1","...&page=2"]` | DB nested shape mismatches `sitemap-index` runtime shape (`m.urls` scalar string array per B6 shape gate). |
| 11 | `catalogUrls[0..1]` case | `/rifles/`,`/shotguns/` | `/Rifles/`,`/Shotguns/` | Live homepage nav links use capitalised paths `/Rifles/` `/Shotguns/`; lowercase aliases also 200 but capitalised is canonical per HTML. |
| 12 | `catalogUrls` ordering | DB lists rifles/shotguns/ammo/accessories first | Candidate lists rifles/shotguns/ammo first then reloading | Order is cosmetic; not a real divergence but flagged for completeness. |
| 13 | `siteProfile.searchUrl` | `/search?q={keyword}` | omitted | `/search.php` is in robots.txt `Disallow` list; DB's `/search?q=` was never live-verified per B4 cascade; candidate omits rather than ship unverified. |
| 14 | `crawlers.bootstrap` block | `{method, apiEndpoints, htmlFallback}` | omitted | Per skill Output-target note: `crawlers.bootstrap.apiEndpoints` has zero runtime consumers; operator-documentation only. |
| 15 | `crawlers.maintain.cooldowns / tierShares / tierWindows` | DB has these | candidate omitted | Operator-tier-policy fields not part of pre-bootstrap deliverable. |
| 16 | `crawlers.maintain.method` | `"db-verification"` | (absent — only verifyMethod set) | DB `method: db-verification` not documented in skill schema; runtime reads `verifyMethod`, `method` likely operator residue. |
| 17 | `wafWorkaround` | `{method:"direct-http", notes, steps}` | `null` | Per B10: when re-audit reclassifies WAF, candidate emits explicit `null` to clear stale workaround on promotion; DB's `direct-http` block is operationally inert but a maintenance trap. |
| 18 | `auditNotes.dbColumnFlips` | n/a | implicit via `hasWaf=false` + `wafWorkaround=null` | Candidate signals column flip needed on promotion. |
| 19 | `topLevelCategories` block | absent | present (12 entries with per-cat counts) | DB never populated operator-doc; candidate adds page-walk-derived counts. |
| 20 | `extractionTested` / `extractionSample` | absent | `true` + 3 products | Stage-4g requirement; DB never recorded. |
| 21 | `dataFlow.steps[].api` | `"HTML scraping"` | absent | Operator residue, not a pre-bootstrap deliverable. |
| 22 | `name` | `"Prophet River"` | absent | Set by MonitoredSite create, not by pre-bootstrap output. |
| 23 | `budget`, `timeout`, `t1IntervalMin`, `hasRateLimit`, `crawlPhase`, `siteCategory`, `siteType`, `requiresAuth`, `requiresSucuri` | DB has | candidate omits | All ops/scheduler config, not pre-bootstrap fields. |
| 24 | `lastVerified` | `2026-04-08` | `2026-05-22` | This audit refreshes. |

**Total divergence count: 24** (16 substantive + 8 cosmetic/ops-only).

## Top 3 substantive WHYs

1. **`column_hasWaf: true` while `wafType: cloudflare-passive`** — classic B10 trap (DB column not flipped when type was downgraded from active to passive). Heavy-8-batch on this audit: cf-ray on every 200, XSS query returns server-level 400, honeypot 403 is BC platform behavior (admin paths), rapid-burst 10/10 200, all UAs 200. CF does NOT actively block. Operationally, `hasWaf:true` is forcing `perPage=20` (B10 cost path) for no benefit; flipping to false unlocks `perPage=100`.

2. **`productCountMethod.method: "sitemap-xml"`** is not in the runtime switch — `product-count-probe.ts` has 11 canonical cases and `sitemap-xml` lands on `default: return null`, silently disabling the count probe (B6 shape gate). Canonical method for BC's xmlsitemap.php is `sitemap-index` with a top-level `urls: string[]` (per Stage-8 table), NOT the DB's nested `pages: [{url, urls}]` shape which silently misses the runtime contract.

3. **`expectedProductCount` 13766 → 13974 (+208)** — natural inventory growth over 44 days. Catalog grew ~0.34 products/day, well within steady-state for a 14K-SKU BC store. No coverage-gap signal; refresh only.

## Blockers
None. Site is unprotected (passive CF only), platform is well-supported (BC Stencil), pagination + sort + count all verified, extraction passes 3-sample check. Ready for R2 live cross-check.

## Inconclusive / untested-by-harness
- `/handguns/` returns 0 product cards and 0 subcategory tiles in body. Labelled as "landing-only" in candidate, excluded from catalogUrls. R2 should confirm whether the site has any actual handgun listings that need a separate route.
- `searchUrl` left null — operator should run the B4 cascade against `/search.php?search_query={keyword}` (BC Stencil default) before promoting; DB's existing `/search?q={keyword}` was never live-verified.
- Sustained multi-UA 50-page walk not run (B9). Candidate flags `wafProbeEvidence.untestedAttackSurfaces` accordingly.
- Path-traversal, large-body-POST, shellshock-UA probes not attempted (no harness allowance and not in heavy-WAF-probe.sh scope).
