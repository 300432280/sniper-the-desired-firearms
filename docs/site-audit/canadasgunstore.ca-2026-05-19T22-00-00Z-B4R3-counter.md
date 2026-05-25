# B4R3 Adversarial Counter — canadasgunstore.ca (2026-05-19T22:00:00Z)

Reviewer: engineering-code-reviewer. Goal: disprove R2 corrections. No DB reads of R1/snapshot.

## Tallies

- **COUNTER** (R2 disproved or partial): **1** (minor: R2 said "24 unique" search products; live DOM shows 15 unique `/products/` slugs out of "24 found" server-side — wording only, endpoint still correct).
- **COULDN'T DISPROVE** (R2 stands): **5**
- **Untested**: paginationPattern `?top=` zero-overlap, perPage=255 server cap.

## Top counters / non-disproofs

### 1. Umbrella vs 7-subclass — 12 orphan SKUs — COULDN'T DISPROVE
Re-walk via THIRD path (searchUrl, not nav-link): GET `/inet/storefront/store.php?mode=searchstore&search%5Bsearchfor%5D=archery` returned `/products/archery--bllt-pnt-125gr-11-32-%7C1463.html` and `/products/bear-archery-desire-xl-mini-crossbow-bolts...%7CAVXA12P.html` — both in R2 walk-summary.json `onlyInUmbrellaExamples`. Direct GET of 3 orphans (`archery--bllt-pnt-125gr-11-32`, `cz-457-22lr-10-round-magazine-polymer`, `freight---proshop`) all returned **HTTP 200**. Cross-check: `cz-457` accessories appear in `shooting` subclass (timney trigger) but cz-457 MAGAZINE does NOT — exclusivity confirmed. R2's umbrella-only set is real, persistent, and necessary for 100% coverage.

### 2. searchUrl square-bracket URL encoding — COULDN'T DISPROVE
Node `new URL('https://.../store.php?mode=searchstore&search[searchfor]=glock').toString()` returned the string **unchanged** — square brackets preserved literally (WHATWG URL spec keeps `[` `]` in query). `searchParams.get('search[searchfor]')` returned `'glock'` correctly. Live curl tested BOTH `%5B`/`%5D` and literal `[`/`]`: both returned HTTP 200, identical `"24 found"`, identical 15 unique product slugs (sizes 51124/51120 — 4-byte diff = encoding only). Backend will not break — the literal stored value passes axios verbatim and the server accepts both forms.

### 3. `product-count-probe.ts:239` parseInt-truncation — COULDN'T DISPROVE; bug REPRODUCED
Read line 239 verbatim: `const pageNum = parseInt(matched?.[1] || '0', 10);`. Ran local test:
```
text='2,384 found, showing page 1 of 10', rx=/([\d,]+)\s+found/
match[1] = "2,384"
parseInt("2,384", 10) = 2          <-- truncates at comma
parseInt("2,384".replace(/,/g,''), 10) = 2384
```
Bug confirmed. R2's recommended one-line patch (`replace(/,/g, '')`) is correct, generic (helps any site with comma totals), and surgical. No regressions: regex still default `(\d+)`-safe; the replace is a no-op when no comma present.

### 4. expectedProductCount=2384 stability — COULDN'T DISPROVE
Live re-query (2026-05-19T~22:30Z): GET `/departments/outdoors---hunting-etc--|30.html` -> 200, body 298846 bytes, regex `[0-9][0-9,]* found` -> `2,384 found`. Matches R2's walked dedupe (umbrella unique = 2384 in walk-summary.json). No drift between R2 and R3 timestamps.

### 5. "24 unique products" — minor wording COUNTER (does NOT invalidate searchUrl)
R2 investigation said `24 unique /products/glock-* URLs in DOM`. Live re-test of the searchstore endpoint shows server says `24 found` but DOM has only **15 unique** `/products/*.html` slugs (likely duplicate anchor per card markup or pagination over 2 pages). Endpoint value remains correct — only the "24 unique in DOM" wording is wrong.

## Untested (deferred)
- `paginationPattern.zeroIndexed: true` + `?top=255` step — R2 paginationWalkProof asserts walked top=0..2295 step 255 = 10 pages = 2384 unique. Did not re-walk all 10 pages within budget.
- `perPage: 255` server cap — assumed from R2 walk.

## Verdict
R2's 4 priority corrections (umbrella catalogUrls, searchUrl value+encoding, parseInt comma bug, expectedProductCount=2384) all survive adversarial retest. Single minor wording slip on search DOM-unique count.
