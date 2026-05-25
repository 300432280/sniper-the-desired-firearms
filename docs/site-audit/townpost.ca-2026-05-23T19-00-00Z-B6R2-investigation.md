# townpost.ca R2 LIVE-PROBE Investigation

**Run:** townpost.ca-2026-05-23T19-00-00Z-B6R2
**Persona:** testing-api-tester (Karpathy section 1-4)
**Method:** static-HTML curl with 800ms delay, 5-variant sort matrix, 5-page pinned-ad test, binary lastPage walk, /search?q probe.
**Inputs:** R1 diff (3 BLOCKER + 4 MAJOR + 3 MINOR divergences), DB snapshot, runtime adapter source.

## Verdict counts

- **R1-CORRECT vs DB-WRONG:** 4 fields (perPage=21, pinnedAds=0, expectedProductCount=8889, lastPage=424)
- **DB-CORRECT vs R1-WRONG:** 3 fields (adapterType=generic, sortNote, searchUrl)
- **Both broken / R2 corrected:** 1 field (productCountMethod - R2 supplies real selector)
- **Open / not re-verified:** 1 field (soldDetection - speculative, R3 should test)

## Top 3 fact-changing findings (evidence)

### 1. DB's "pinnedAds: 4 / perPage: 17" is FALSIFIED - perPage really IS 21, no pinned ads

5-page walk extraction (curl + grep dedup):

```
ids-p1.txt = 21 unique IDs (range 955768..1171326)
ids-p2.txt = 21 unique IDs (range 576437..1171314)
ids-p3.txt = 21 unique IDs
ids-p4.txt = 21 unique IDs (range 219709..1170192)
ids-p5.txt = 21 unique IDs (range 1056771..1171292)

5-way intersection (IDs in ALL 5 pages) = 0
Pairwise: p1 cap p2=1, p1 cap p3=0, p1 cap p4=0, p1 cap p5=0, p2 cap p3=0, ...
Total unique across 5 pages = 104 (5x21=105, only 1 within-page accidental dup)
```

Only ONE "Top Ad" badge across all 5 pages (p1, counts within its 21). DB's `pinnedAds: 4` appears to be from an older site version - current TownPost has no pinned-ad system in HTML output. **R1's perPage=21 is correct; DB's 17+4 is wrong.**

### 2. lastPage = 424 (NOT 440 as DB claims); R1's 8889 product count is correct

Binary walk of pages 420..450:

```
p420: 21 IDs (size 294222)
p424: 6 IDs  (size 169865, min=131050 max=187458) <- TRUE LAST PAGE
p425: 21 IDs (size 328743, max=1171326) <- WRAP to p1 content
p430..450: identical to p425 byte-for-byte
```

Total = 423*21 + 6 = **8889**. DB value 7484 (= 440*17) is wrong on BOTH inputs.

### 3. Sort params ignored; max-per-page IDs NOT strictly monotonic - DB sortNote is right

5 sort-param variants tested:
- `?sort=newest`, `?sort=date`, `?orderBy=date`, `?order=newest`, `?sort=oldest` - ALL return identical first/last IDs as bare `/category/guns`. Sort UI is purely client-side Radix combobox.

Max-ID-per-page:
```
p1=1171326, p2=1171314, p3=1171304, p4=1170192, p5=1171292
```
Note p5 (1171292) > p4 (1170192) - NOT strict descent. Within-page, p4 has ID 219709 alongside 1170192 (951k spread). Default sort IS bump-date, not creation-date. **R1's "monotonic ID descent across 421 pages" claim is FALSIFIED.** The `navigate-from-watermark` method stays, but reason text must drop the ID-descent claim and rely on URL/activity tracking.

## Other R2-confirmed findings

- **adapterType=generic** (DB correct). `classifieds-gunpost` selectors (`node--type-classified`, `gunpost-teaser`, `node__pubdate`) match 0 elements on townpost p1. R1 picked it by name pattern.
- **searchUrl=/search?q={keyword}** (DB correct). `/search?q=glock` returns 21 marketplace results titled "Glock in Canada"; `/search?q=zzzqzqzqzq` returns 0.
- **Runtime extraction concern**: `generic.ts:91-130` (`extractCatalogProducts`) lacks the `a[href*="/marketplace/"]` selector. Only `generic-retail.ts:964` has it. Townpost using `generic` adapter (per DB) extracts 0 products with current HTML. Either (a) add the marketplace selector to `generic.ts`, OR (b) change adapterType to `generic-retail`. **This is a runtime fix, not a profile-field change.**

## Blockers

1. **runtime-not-profile**: `generic` adapter's `extractCatalogProducts` cannot extract townpost listings - needs `a[href*="/marketplace/"]` selector added to `generic.ts:95-103` (already present in `generic-retail.ts`). The DB siteProfile note `adapterConcern` documents this; R2 confirms it's still true.
2. **DB profile drift**: `perPage:17`, `pinnedAds:4`, `totalPages:440`, `productCountMethod.method:"page-count-times-perpage"` are all wrong against current site. Profile needs updating to perPage:21, pinnedAds:0, totalPages:424, method:"html-pagination".

## Outputs

- JSON: `d:/Projects/FIREARM-ALERT/docs/site-audit/townpost.ca-2026-05-23T19-00-00Z-B6R2.json`
- This file: `d:/Projects/FIREARM-ALERT/docs/site-audit/townpost.ca-2026-05-23T19-00-00Z-B6R2-investigation.md`
- Evidence files: `d:/Projects/FIREARM-ALERT/_audit_tmp/batch6-2026-05-23/townpost-r2/{p1..p5,late-p420..p450,sort-*,search-*}.html` and `ids-p*.txt`

## R3 open items

1. Verify `classifiedRules.soldDetection` against a real Sold-tagged listing detail page (R1 added speculatively).
2. Decide which fix path for the extraction runtime gap: add selector to `generic.ts` vs. flip adapterType to `generic-retail` (and audit downstream consequences).
3. Re-examine DB's `pinnedAds:4` provenance - was an older townpost theme actually pinning 4 ads? Or was this entry always wrong? Either way, current site has 0 pinned.
