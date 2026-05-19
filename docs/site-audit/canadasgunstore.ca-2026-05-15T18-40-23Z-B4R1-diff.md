# Diff — canadasgunstore.ca — B4 R1

Candidate: `docs/site-audit/canadasgunstore.ca-2026-05-15T18-40-23Z-B4R1.json`
DB: `MonitoredSite.siteProfile` (lastVerified 2026-04-06)

## Identical (or trivially equivalent)
- `adapterType` = `generic-retail` (both)
- `hasWaf` = `false` (both)
- `hasCaptcha` = `false` (both)
- `needsPlaywright` = `false` (both)
- `perPage` = `255` (both)
- `paginationPattern.type` = `offset-query` (both)
- `paginationPattern.template` = `top` (both)
- `sortParam` = `null` (both)
- `crawlers.watermark.method` = `full-catalog-sweep` (both)
- `crawlers.maintain.verifyMethod` = `detail-page` (both)

## Divergent (with WHY)

| # | Field | Candidate | DB | One-line WHY |
|---|---|---|---|---|
| 1 | `platform` | `activant-inet` | `custom` | Candidate uses a specific vendor tag (Activant/Epicor iNet, observed via `/inet/storefront/`, `INET_MOBILE` cookie, SSL CN `admin.activant-inet.com`); DB used a generic `custom` placeholder. |
| 2 | `expectedProductCount` | `2381` | `2361` | Walked the live outdoors `|30` aggregator today (2,381 unique by trailing-ID dedup, also matches site's own `"2,381 found"` text); DB note's per-dept sum `2,361` from 2026-04-06 is 39 days stale + walked named-depts only (sum-of-named-depts in candidate's audit = 2,369, also higher than DB's 2,361 — catalog has grown). |
| 3 | `productCountMethod` | `null` | `{"method":"stream-page-count"}` | Candidate marked null because runtime `html-pagination` regex can't parse comma-separated totals (e.g. `"2,381"` parses to `2`); DB picked `stream-page-count` which reads from DB `streamState` table (only works post-bootstrap). Candidate is more honest about probe limitation; DB's value is pragmatic for already-bootstrapped sites. |
| 4 | `catalogUrls` | `["/departments/outdoors---hunting-etc--|30.html"]` (1 URL) | 7 per-department URLs | Candidate found that the `|30` parent (Outdoors/Hunting/etc.) aggregator covers 100% by trailing-ID dedup (2,381 = full catalog), so single URL is sufficient per Rule C minimum-cover. DB uses 7 named depts (firearms, ammo, optics, shooting, hunting, knives, apparel) sum 2,369 — misses the 12-product gap. Both shapes work; candidate is fewer requests, DB is more redundant. |
| 5 | `paginationPattern.firstPageHasParam` | `false` | (absent) | Candidate explicitly recorded; DB profile omitted optional pagination field. |
| 6 | `paginationPattern.startPage` | `0` | (absent) | Same — explicit in candidate, omitted in DB. |
| 7 | `paginationPattern.zeroIndexed` | `true` | (absent) | Same — explicit in candidate, omitted in DB. |
| 8 | `sortVerified` | `false` | (absent) | Candidate explicitly verifies and records sort verdict; DB profile omits the field entirely. |
| 9 | `wafType` / `wafLastProbedAt` / `wafProbeMethod` / `wafProbeResult` / `wafProbeEvidence` | populated (2026-05-15) | absent | Candidate ran fresh 8-batch probe with full evidence; DB has no WAF audit trail. |
| 10 | `ageGate` | `{detected:false, type:null, bypassCookie:null}` | (absent) | Candidate explicitly checked for and recorded age-gate absence; DB omits. |
| 11 | `extractionTested` / `extractionSample` | `true` + 3-product sample | absent | Candidate ran Stage 4g spot-check; DB has no equivalent field. |
| 12 | `crawlers.maintain.verifyEndpoint` | `null` | (absent) | Candidate explicit; DB omits. |
| 13 | `crawlers.bootstrap.apiEndpoints` | `{}` | `null` | Trivial shape diff (empty object vs null). |
| 14 | `crawlers.maintain` extras | only `verifyMethod` + `verifyEndpoint` | also has `method:"db-verification"`, cooldowns, tierShares, tierWindows | DB has runtime tier-engine config that pre-bootstrap is not supposed to set — that's separate operator data. Candidate correctly omits. |
| 15 | `crawlers.bootstrap.method` / `htmlFallback` | absent (only `apiEndpoints`) | populated (`single-continuous` / `true`) | DB-only runtime bootstrap config; not a pre-bootstrap deliverable. |
| 16 | `crawlers.watermark.reason` | populated (long-form explanation of why full-catalog-sweep) | absent (only `notes` line) | Candidate explicitly required by `profile-validator.ts:111` when method is full-catalog-sweep. DB has freeform `notes` instead. |
| 17 | `searchUrl` | `null` | `"/search?q={keyword}"` | DB declares a search URL template; candidate did not verify a public search URL exists on this site. **Audit gap in candidate** — I did not test the search box. DB value not validated by this run. |
| 18 | `siteCategory` | absent | `"retailer"` | DB-only metadata; not in pre-bootstrap schema. |
| 19 | `budget` / `timeout` / `t1IntervalMin` / `hasRateLimit` / `dataFlow` / `notes` | absent | populated | DB-only runtime config & operator notes; not pre-bootstrap fields. |
| 20 | `topLevelCategories` | populated (8 entries with per-dept counts + sum-check) | absent | Candidate has the recommended doc block; DB does not. |
| 21 | `productUrlSchemes` | populated (canonical vs sitemapForm with joinOn) | absent | Candidate documents the URL-form duality discovered during dedup; DB does not flag this. |
| 22 | `auditNotes` | populated (runId, fieldConfidence, stageNotes) | absent | Candidate audit-trail; DB omits. |
| 23 | `profileVersion` | `1` | absent | Candidate explicit; DB does not version. |
| 24 | `lastVerified` | `2026-05-15` | `2026-04-06` | 39 days stale on DB. |
| 25 | DB-only field `name` | absent | `"Canada's Gun Store"` | Site name is on `MonitoredSite.name` DB column (already populated); not a `siteProfile` JSON field per skill. |

## Net assessment

**Substantive divergent fields (excluding DB-only runtime/scheduler config not in scope for pre-bootstrap): 5.**

1. `platform` (custom → activant-inet)
2. `expectedProductCount` (2361 → 2381, +20 catalog growth in 39 days, also DB sum likely under-counted)
3. `productCountMethod` (DB's `stream-page-count` vs candidate's null — different correctness profiles)
4. `catalogUrls` (7 per-dept vs 1 aggregator — both achieve coverage but via different shapes)
5. `searchUrl` (candidate didn't audit, DB has `/search?q={keyword}`)

No correctness conflict on the runtime-critical fields (adapter, perPage, paginationPattern, watermark method). The DB freeform `siteProfile.notes` field (2026-04-06) actually already describes the pagination quirks the candidate re-derived from scratch — the DB has good provenance, just lower structure.

## Skill / harness gaps surfaced

1. **`productCountMethod` lacks an "html-text-total" variant.** The `<p class="text-success">2,381 found, showing page 1 of 10</p>` is a clean total-count surface but the existing `html-pagination` regex extracts only the first capture group, which truncates at the comma (`parseInt('2,381') = 2`). Either (a) extend `html-pagination` to strip commas before `parseInt`, or (b) add a small `html-text-total` method that runs `Number(matched.join('').replace(/[,\s]/g,''))`. Without either, sites with comma-thousand totals can't expose a runtime count probe — this site, gunpost-style classifieds, and many Activant/Inet retailers hit this.
2. **No detector for Activant/Inet Web Storefront.** `backend/scripts/probe/access-identity/detectors/` has 18 platforms but not Activant/iNet. Signature is unambiguous: `/inet/storefront/`, `INET_MOBILE` cookie, dept URL `|30|<CODE>.html` shape, SSL CN `*.activant-inet.com`. Adding a detector lets Stage 3 surface a specific vendor tag instead of "custom"/"unknown".
3. **Stage 4 `productUrlSchemes` detection happens organically (I noticed the URL-form duality during dedup) but is not in the harness checklist.** The Activant/Inet site serves the same product with two URL forms: `/products/<slug>%7C<id>.html` (canonical) vs `/products/<slug>%7C<crumb1>%7C<crumb2>%7C<id>.html` (path-baked breadcrumb). Without trailing-ID dedup, the candidate would have over-counted by ~15 products. Stage 4d should explicitly say "dedup by the LAST segment of the product ID, not the full URL string, when a platform varies URL form across categories".
4. **`searchUrl` discovery is not part of any Stage's checklist.** Stage 3's "conditional outputs" mentions `searchUrl` only as "if the site has a keyword-search URL... output the template". There's no prescribed probe (e.g. look for `<form action="..." method="GET">` with a `<input name="q|search|keyword">`, fetch with a known keyword, copy resulting URL). The candidate left `searchUrl: null` because I didn't run that probe. Should be an explicit Stage 3 substep.
