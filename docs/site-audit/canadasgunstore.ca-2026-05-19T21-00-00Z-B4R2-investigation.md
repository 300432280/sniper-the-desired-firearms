# B4R2 Investigation — canadasgunstore.ca (2026-05-19)

R1 -> R2 adversarial review. Each R1 divergence retested with a method DIFFERENT from R1's hypothesis. No DB writes.

## Verdict counts

- **R1 wins**: 5 (platform, catalogUrls count, catalogUrls encoding, bootstrap omission, additive fields stage-by-stage)
- **DB wins**: 4 (searchUrl presence, name, hasRateLimit, siteCategory)
- **Both wrong**: 2 (expectedProductCount, productCountMethod regex+perPage)
- **Inconclusive**: 0
- **R2 corrections beyond R1+DB**: 2 (searchUrl value corrected, productCountMethod corrected to capture comma-formatted total)

## Method-by-method evidence

### 1. catalogUrls — umbrella vs 7-subclass

**R1 hypothesis (umbrella)**: Rule C literal min-URL-set with implicit assumption of 100% coverage.
**Different-method test (R2)**: walk every URL fully and dedupe.

Walked all 8 URLs at 800ms inter-request delay (`_audit_tmp/batch4-2026-05-19/cgs-r2/walk.mjs`, summary at `walk-summary.json`):

| URL | Found text | Unique slugs walked |
|---|---|---|
| `/departments/outdoors---hunting-etc--\|30.html` (umbrella) | 2,384 | **2,384** |
| `/departments/firearms-\|30\|FA.html` | 676 | 676 |
| `/departments/ammunition-\|30\|AMM.html` | 447 | 447 |
| `/departments/shooting-\|30\|SHO.html` | 723 | 723 |
| `/departments/optics-\|30\|OPT.html` | (n/a) | 252 |
| `/departments/hunting-\|30\|HNT.html` | (n/a) | 114 |
| `/departments/knives-and-tools-\|30\|KT.html` | (n/a) | 100 |
| `/departments/apparel-\|30\|CLO.html` | (n/a) | 60 |
| 7-subclass UNION | — | **2,372** |

- `umbrella - subclassUnion` = **12 SKUs** (archery / crossbow bolts / CZ-457 magazine / freight-charge / etc.)
- `subclassUnion - umbrella` = 0
- Subclass numeric sum 676+447+723+252+114+100+60 = 2,372 (perfectly disjoint by subclass code)
- 2,372 subclass + 12 umbrella-only = **2,384** umbrella unique = "found" text

**Verdict: R1 wins** (umbrella covers 100%; 7-subclass UNDER-covers by 0.5%). DB's 7-subclass set has been silently missing 12 SKUs.

### 2. URL encoding — `%7C` vs literal `|`

**R1 hypothesis**: `%7C` from raw href is fine.
**DB hypothesis**: must be literal, "%7C breaks the URL builder".

**Different-method test (R2)**: round-trip both forms through `new URL()` + curl both forms + check status, body size, slug list:

```
literal pipe url.toString(): https://www.canadasgunstore.ca/departments/firearms-|30|FA.html
%7C url.toString():          https://www.canadasgunstore.ca/departments/firearms-%7C30%7CFA.html
round-trip literal: (unchanged)
round-trip %7C: (unchanged)
```

curl results:
- `STATUS=200, SIZE=298846` (literal pipe)
- `STATUS=200, SIZE=298848` (`%7C`) — 2-byte diff is `|` vs `%7C` in canonical link tag
- First 5 product slugs identical between encodings

**Verdict**: both encodings work; DB's "must be literal" warning is unfounded for the current runtime. R2 standardizes on literal `|` to match the DB convention and avoid a future operator confusion.

### 3. searchUrl

**R1**: omitted.
**DB**: `/search?q={keyword}` (was untested).

**Different-method test (R2)**: live GET both candidates plus the homepage search form's `action` attribute:

| URL | Status | Result |
|---|---|---|
| `/search?q=glock` | **404** | "Page not found" template, 0 `/products/` slugs |
| `/inet/storefront/store.php?mode=search&keyword=glock` | 200 | 0 `/products/` slugs (likely route exists but not search) |
| `/inet/storefront/store.php?mode=searchstore&search[searchfor]=glock` | **200** | "24 found, showing page 1 of 2", 24 unique `/products/glock-*` URLs in DOM |

Confirming source: homepage HTML `<form action="/inet/storefront/store.php" method="GET">` + `<input type="hidden" name="mode" value="searchstore">` + `<input name="search[searchfor]">`.

**Verdict**: DB wins on PRESENCE (R1 missed it), DB wins on FIELD-EMISSION, but **DB value is wrong** — the live storefront uses `mode=searchstore` + `search[searchfor]=` (note the bracketed array form). R2 corrects to:

```
"searchUrl": "/inet/storefront/store.php?mode=searchstore&search[searchfor]={keyword}"
```

### 4. expectedProductCount drift

**R1**: 2,385. **DB**: 2,361. Re-derived two independent ways:

| Method | Value |
|---|---|
| (a) HTML "found" text on umbrella URL | 2,384 |
| (b) Walked unique `/products/*.html` slugs on umbrella | 2,384 |
| (c) Subclass numeric sum 676+447+723+252+114+100+60 | 2,372 |
| (d) Subclass union dedup | 2,372 |
| (a) - (d) | 12 umbrella-only orphans |

(a) and (b) cross-check exactly at **2,384**. (c) and (d) agree at 2,372 because the 7-subclass set is incomplete (missing the 12 orphans).

**Verdict: both wrong** (R1 2385 was off by 1, possibly counted a removed/added SKU between R1 and R2 runs; DB 2361 was a 6-week-stale snapshot). R2 = 2,384.

### 5. productCountMethod

**R1**: `html-pagination` with `regex: "of\\s+(\\d+)"` + `perPage: 255`.
**DB**: `stream-page-count` (runtime-internal).

**Different-method test (R2)**: simulate the runtime regex execution against the literal page text:

```
text = '2,384 found, showing page 1 of 10'
/(\d+)/ matches: '2'      <- comma truncation; html-pagination default regex bug
/of\s+(\d+)/ matches: '10'   <- R1 picks page count
/([\d,]+)\s+found/ matches: '2,384' -> parseInt('2,384')=2  <- comma not stripped by consumer
```

R1's config x `perPage: 255` = 10 x 255 = **2,550** -> 6.96% over true 2,384, fails 5% drift gate.
The "correct" regex `([\\d,]+)\\s+found` + `perPage: 1` captures `2,384` but the consumer at `product-count-probe.ts:239` does `parseInt(matched[1])` which truncates to `2`. **Both probe configs are broken** until the consumer is patched to strip commas before parseInt.

**Verdict: both wrong**. R2 emits the corrected regex config so an operator can audit, and flags the runtime patch to R3/R4: at `backend/src/services/product-count-probe.ts:239`, change `const pageNum = parseInt(matched?.[1] || '0', 10);` to strip commas first (`parseInt((matched?.[1] || '0').replace(/,/g, ''), 10)`). DB's `stream-page-count` works correctly because it counts walked products and avoids the regex layer entirely — it remains a valid alternative.

### 6. platform / additive fields

R1 wins on `platform=activant-inet` (correctly identifies Epicor iNet via `/inet/`, `sagro_base_url`, `img2.activant-inet.com`). DB's `custom` predates the platform detector. All `wafProbe*`/`ageGate`/`extractionTested`/`extractionSample`/`sortVerified`/`topLevelCategories` additions are skill-mandated additive blocks and are kept in R2.

### 7. Operator-runtime fields (left alone in R2)

`crawlers.maintain.cooldowns / tierShares / tierWindows`, `t1IntervalMin`, `budget`, `timeout`, `name`, `dataFlow.steps`, `notes` long-form are operator-tuned runtime metadata. The skill output is platform/adapter focused; R2 emits `name`, `siteCategory`, `hasRateLimit` (cheap to derive) but leaves cooldowns/tier shares to the operator merge step.

## Top 3 surprising R1 wins/losses

1. **R1 was right on catalogUrls=umbrella — DB has been silently under-covering 12 SKUs for 6+ weeks.** The 7-subclass set looks intuitive but the iNet platform allows products without a subclass code (freight items, archery items mapped to no firearms-related category). Only the dept-30 umbrella catches them. Walking proof in `walk-summary.json`.

2. **DB's `searchUrl: /search?q={keyword}` value is wrong — it returns 404.** R1 missed it entirely; DB had a value that has never worked. R2 found the live storefront's actual search endpoint by reading the homepage form: `/inet/storefront/store.php?mode=searchstore&search[searchfor]={keyword}` -> 200 with valid product results.

3. **Both R1 and runtime-side `html-pagination` are silently broken for comma-formatted totals.** R1's regex captures total pages, not products. The "obvious fix" regex `([\\d,]+)\\s+found` captures the right text but the consumer's `parseInt` truncates at the comma, yielding `2` instead of `2384`. Either patch the consumer (preferred) or stay with DB's `stream-page-count`.

## Blockers

None.

## Recommendations to R3/R4

- **R3**: re-run the umbrella-vs-subclass walk in 1-3 weeks to confirm the 12 orphan SKUs are persistent (not a transient categorization gap). If persistent, file a fleet-wide note in `crawler-specialist.md`: "iNet umbrella URL is REQUIRED — subclass union under-covers by ~0.5%".
- **R3**: patch `product-count-probe.ts:239` to `parseInt((matched?.[1] || '0').replace(/,/g, ''), 10)` so `html-pagination` works on any site with comma-formatted totals (gains generality, no site-specific code).
- **R3/R4**: confirm operator wants `searchUrl` corrected in DB to the storefront-form endpoint (DB current value 404s).
- **R4**: synthesis — R1 candidate is correct on platform/catalogUrls but wrong on expectedProductCount (2385->2384) and productCountMethod regex (use `([\\d,]+)\\s+found` + perPage:1 OR keep DB's stream-page-count). DB is correct on name/siteCategory/hasRateLimit and on `searchUrl` PRESENCE but wrong on `searchUrl` VALUE.
