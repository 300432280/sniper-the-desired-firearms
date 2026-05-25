# townpost.ca - R1 Blind vs DB Snapshot Diff

**Round:** R1 (BLIND skill run, no DB access during discovery)
**Date:** 2026-05-25
**Candidate JSON:** `docs/site-audit/townpost.ca-2026-05-23T18-00-00Z-B6R1.json`
**DB snapshot:** `_audit_tmp/batch6-2026-05-23/townpost.ca-DB-snapshot.json`

## Divergence count: 10

## Severity legend
- **BLOCKER**: candidate would break runtime if promoted
- **MAJOR**: candidate has wrong value but field shape OK
- **MINOR**: extra field or stylistic difference

## Diff table

| # | Field | R1 candidate | DB siteProfile | Severity | 1-line WHY |
|---|---|---|---|---|---|
| 1 | `adapterType` | `classifieds-gunpost` | `generic` | **BLOCKER** | I picked an adapter that doesn't exist in the registry for this site shape; DB note explicitly says GenericRetailAdapter has zero matching selectors for townpost HTML and a /marketplace/ link selector must be added - the right answer is `generic` (matches DB column) until a new adapter is built. I anchored on "classifieds = classifieds-gunpost" without checking the registry. |
| 2 | `crawlers.watermark.reason` (claims monotonic ID descent) | "newest-first verified by ID descent across 421 pages" | DB sortNote says **"Ad IDs are NOT monotonically descending across pages (page 1 has ID 654750 mixed with 1166922)"**, default is activity-based (bump/renew date) | **BLOCKER** | I only sampled the MAX ID per page (which descended) and called it monotonic. My own page-1 data showed IDs from 576437 to 1171326 within ONE page - proof of NON-monotonic order I misread. Default sort is bump-date, not creation-date; pages have IDs scattered widely within a page. The `navigate-from-watermark` method may still be correct, but the JUSTIFICATION is wrong - the watermark must be tracked by URL/timestamp/activity, not by ID. |
| 3 | `perPage` | `21` | `17` (DB has `pinnedAds: 4` for the diff) | **BLOCKER** | I counted the rendered 21 hrefs per page. DB knows that 4 of those 21 are pinned "Top Ads" (repeated on EVERY page - same 4 ads from page 1 to page N), so the real per-page unique is 17. My pagination math triple-counted the 4 pinned ads across all 423 pages = ~1,692 phantom listings. |
| 4 | `expectedProductCount` | `8889` (423*21+6) | `7484` (440*17) | **MAJOR** | ~19% drift, outside the 5% gate. Driven by the perPage=21 vs 17 error above plus my lastPage=424 (binary-search hit a wrap-detection artifact; DB lastPage=440). With perPage=17 my walk would yield 423*17+6=7197, much closer to DB 7484 (~3.8% drift). |
| 5 | `productCountMethod.method` | `html-pagination` (with non-canonical `selector` string) | `page-count-times-perpage` (NOT in skill's 11 canonical names) | **MAJOR (both broken)** | DB uses `page-count-times-perpage` which `product-count-probe.ts` switch does NOT recognize -> default: return null silently. My `html-pagination` IS canonical, but my `selector` value is a debug string ("pagination-walk:lastPage=424,..."), not a CSS selector - runtime would also fail to extract. Both candidate and DB are broken; neither runs the probe. |
| 6 | `lastPage` (in auditNotes) | `424` | `440` (in productCountMethod.totalPages) | **MAJOR** | I treated the wrap-to-newest at page 425 as the true end; DB has 440. Difference is ~3.7%; likely caused by my binary-search hitting a cache or pinned-ad rotation artifact, or by listings churn between probe runs. Re-walk needed in R2. |
| 7 | `searchUrl` | omitted | `/search?q={keyword}` | **MAJOR** | I noted /search exists but deferred to R2; DB has the verified template. Should have probed it directly - skill Stage 3 B4 (Deterministic searchUrl probe) was skipped. |
| 8 | `classifiedRules.soldDetection` | `["Sold ~", "<title>Sold ", ...]` (added speculatively) | not present in DB | **MINOR** | I added title-prefix detection because the sold sample listing has "Sold ~" in user-edited title. DB doesn't have this field; sold-detection on TownPost may rely on something else entirely (or none at all). Speculative. |
| 9 | `crawlers.maintain.method` | omitted | `db-verification` | **MINOR** | DB has extra `method` field; skill only requires `verifyMethod` (which I have as `detail-page`). `db-verification` indicates runtime uses cooldown tier-windows for re-verification. |
| 10 | `crawlers.bootstrap` block | not emitted (per skill Output target note) | `{method:"single-continuous", apiEndpoints:null, htmlFallback:true}` | **MINOR** | Skill explicitly says NOT to emit `crawlers.bootstrap` block (operator documentation only, zero runtime consumers). DB keeps it from an older profile generation. |

## Outputs and blockers

**Paths:**
- Candidate JSON: `d:\Projects\FIREARM-ALERT\docs\site-audit\townpost.ca-2026-05-23T18-00-00Z-B6R1.json`
- This diff: `d:\Projects\FIREARM-ALERT\docs\site-audit\townpost.ca-2026-05-23T18-00-00Z-B6R1-diff.md`

**Divergence count:** 10 (3 BLOCKERs, 4 MAJORs, 3 MINORs)

**Blockers (must be fixed in R2/R3 before promotion):**
1. `adapterType` must be `generic` (no classifieds-gunpost adapter wired for townpost)
2. The monotonic-ID-descent claim is FALSE; default sort is activity-based (bump date), not creation date - watermark justification must be rewritten
3. `perPage` must be `17`, not `21`, with `pinnedAds: 4` documented; this fixes `expectedProductCount` drift

## Top 3 WHYs (root cause of the R1 mistakes)

1. **I confused max-ID-per-page descent with within-page monotonicity.** My data showed page-1 IDs from 576437 to 1171326 (massive within-page spread), yet I claimed monotonic ID descent because the MAX descended. The DB sortNote explicitly warns about this trap ("Ad IDs are NOT monotonically descending across pages (page 1 has ID 654750 mixed with 1166922)") - the same trap I fell into. Classifieds bump-sort produces high-ID + low-ID mixed on EVERY page; the max-per-page hint is necessary but not sufficient evidence of newest-first ordering.

2. **I never accounted for pinned "Top Ads" repeating on every page.** I extracted 21 distinct hrefs per page and called perPage=21. The DB knows 4 of those are pinned and repeat across all pages. My pagination walk's overlap test (p1 cap p2 = 0) would have FAILED had I extracted only the 4 pinned ad IDs - but the 17 real listings rotated so the overall set diff was non-zero, which masked the pinned-repeat. Future skill should test pinned-overlap explicitly (compare ID sets across p1, p10, p100, look for IDs present in ALL).

3. **I picked the wrong `adapterType` by name pattern, not by registry check.** I saw "classifieds" + "firearms" and chose `classifieds-gunpost` without verifying that the gunpost adapter handles townpost's URL/HTML shape. The DB note "GenericRetailAdapter has zero matching selectors for townpost HTML - needs /marketplace/ link selector added" explicitly says this site cannot be crawled today; promoting `classifieds-gunpost` would route to an adapter that also doesn't know about the Tailwind-utility-class-only Next.js markup. Future skill should query the adapter registry (`backend/src/services/scraper/adapters/`) to confirm the chosen adapter's `match` returns true for the candidate's HTML before committing.
