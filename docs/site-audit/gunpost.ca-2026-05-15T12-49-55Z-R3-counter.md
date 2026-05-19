# R3 Adversarial Counter — gunpost.ca

**Run ID:** R3-counter-2026-05-15T12-49-55Z
**R2 corrections file:** `docs/site-audit/gunpost.ca-2026-05-15T09-16-43Z-R2-corrections.json`
**Prior R3 reviewed:** `docs/site-audit/gunpost.ca-2026-05-13T09-11-47Z-R3-counter.md`
**Method:** Fresh skeptic. Live HTTP, runtime code re-reads, and Node reproducers of the exact regex code at `product-verifier.ts:259-260,286-301`. R1 candidate and R1 diff intentionally NOT re-read.
**Inter-request delay:** >=800ms.

R2 made 12 corrections (12 high-confidence). Prior R3 made 3 strong counter-claims + raised 2 latent bugs. I attempted to disprove each.

**Result tally:**
- R2 corrections: 12 attempted / **2 broken** (`classifiedRules.soldDetection`, `classifiedRules.wantedDetection`) / 10 couldn't disprove.
- Prior R3 claims re-tested: 3 / **2 reproduced and re-confirmed** (soldDetection false-positives, wantedDetection array→regex coercion) / 1 partially superseded (expectedProductCount methodology).

---

## R2 corrections — attempt-to-disprove

### R2 #1 `productCountMethod.method = "html-pagination"` — COULDN'T DISPROVE
Re-read `backend/src/services/product-count-probe.ts`; 11 case arms (lines 149,156,163,182,204,212,226,250,272,302,333). `pagination-walk` falls through `default: return null`. Grep confirms no other call sites. **R2 right; DB silently broken today.**

### R2 #2 `expectedProductCount = 25,186` — COULDN'T DISPROVE (3rd-method confirmed)
Three independent methods today (2026-05-15T12:30–12:48Z):
1. **Pagination walk** (this run): p0=15+3, p1677=6 regular + 3 promoted, p1678 = `view-empty` div + 3 promoted only. Formula `(1677 * 15) + 6 = 25,161`. ~25 listings short of 25,186, consistent with 35 min of expiry churn since R2's 09:13Z probe.
2. **Province facet sum** (R2's method, re-counted): same 25,186 today (province bands unchanged).
3. **NEW: `new_in_box` binary facet sum** — `data-drupal-facet-item-count` attribute values: Used=24,654 + New=532 = **25,186 exactly**. Source: `gp-p0.html` lines 2390, 2417 (`data-drupal-facet-item-count="24654"` and `="532"`).

Method-1 and Method-3 disagree by 25 (~0.1%) due to live churn; that's smaller than the 95% coverage gate. **25,186 holds.**

R1's 30,225 explained: 1679 pages × **18** (counting sticky promoted teasers as listings) ≈ 5,040 phantom listings. Cross-check matches: 30,225 − 25,186 = 5,039.

### R2 #3 `productCountMethod` full shape (perPage=15, formula `(1679*15)+1`) — COULDN'T DISPROVE
The terminus has shifted (today the last-with-listings page is p1677, not p1679 — natural classifieds shrinkage over 35 minutes). The R2 INTEGER `(1679*15)+1` is stale but the **methodology** (regular-teaser-only, formula `(lastPage * perPage) + lastPageItems`) is correct and matches the new_in_box facet sum within 1%. R2's exact integer drifts hourly; the coverage gate is the design defense.

### R2 #4 `perPage = 15` (with operator note keeping crawler-mechanical perPage=18) — COULDN'T DISPROVE
p0 = 15 `node--view-mode-teaser` + 3 `node--view-mode-promoted-teaser`. Promoted node IDs rotate (p0 has 1224433/1228844/892775; p1677 has 1184541/1215564/1223494). So 15 is the listing-stream perPage, 18 is the visible-card count. R2's split is correct.

### R2 #5 `classifiedRules.soldDetection = ["class=sold","class=field-sold","field-sold Yes","SOLD"]` — **BROKEN**
Re-confirmed prior R3's severe finding using the EXACT runtime code at `product-verifier.ts:286-301`.

Live not-sold detail page (random fresh listing from p0) emits:
```
class="field-sold No"
class="sold No"
```
plus the literal `SOLD` text in the badge (CSS-hidden when `No`).

Node reproducer using exact runtime regex code copied from product-verifier.ts:286-301:
| pattern | result on NOT-sold page |
|---|---|
| `class=sold` | **true (false positive)** |
| `class=field-sold` | **true (false positive)** |
| `field-sold Yes` | false (correct) |
| `SOLD` | **true (false positive — text badge always present)** |

With R2's stored list, runtime `isSold()` returns true on the first iteration (`class=sold` fires) for every alive ad. Effect: **every gunpost listing is misclassified as sold**.

R2 cited the generic CSS fallback at `product-verifier.ts:308` (`$('.sold, .ad-sold, .field-sold').length > 0`) as supporting evidence — that fallback ALSO false-positives on `class="sold No"` because cheerio matches className-presence regardless of trailing qualifier. So R2's "dead-but-not-harmful" claim about the fallback is wrong: the fallback is **silently broken too**.

The only correct list for gunpost.ca is `["field-sold Yes"]` (the single positional pattern).

### R2 #6 `classifiedRules.wantedDetection = ["^wanted","wtb$","wtt$","iso$","wanted$","wanted:"]` — **BROKEN**
Re-read `product-verifier.ts:259-260`:
```ts
const wantedPattern = entry?.siteProfile?.classifiedRules?.wantedDetection;
const wantedRegex = wantedPattern ? new RegExp(wantedPattern, 'i') : /\b(wanted|wtb|wtt|iso)\s*$/;
```
Type at runtime: untyped — `wantedPattern` is `any`. The DB stores `string[]`. `new RegExp(array, 'i')` invokes `Array.prototype.toString()` → comma-join → produces `/^wanted,wtb$,wtt$,iso$,wanted$,wanted:/i`. Node reproducer:
```
> new RegExp(['^wanted','wtb$','wtt$','iso$','wanted$','wanted:'], 'i').test('wanted: vintage firearms')
false
> new RegExp([...], 'i').test('vintage rifle wanted')
false
```
Five real wanted titles, all reject. The truthy-array bypasses the default fallback regex. **R2's "PRESERVE" recommendation silently disables wanted detection at runtime.**

R2 wrote: "Runtime consumer at product-verifier.ts:259-260 reads `wantedDetection` ... falls back to `/\\b(wanted|wtb|wtt|iso)\\s*$/` only if absent." R2 read the line but didn't run the regex.

Correct fix: store as a single pipe-joined string. Verified working:
```
> new RegExp('^wanted|wtb$|wtt$|iso$|wanted$|wanted:', 'i').test('wanted: vintage firearms') // true
> new RegExp(...).test('shoei mp44 wanted') // true
> new RegExp(...).test('something wtb') // true
```

### R2 #7 `apiConfig.customSelectors = null` — COULDN'T DISPROVE
`Grep customSelectors backend/src` returns **0 matches**. Adapter selectors are hard-coded at `classifieds-gunpost.ts:96-100`. Pure operator residue. **R2 right.**

### R2 #8 `userAgentOverride = null` — COULDN'T DISPROVE
Live tests (this run, 12:35Z):
| URL | UA | HTTP |
|---|---|---|
| `/ads` | default curl | 403 |
| `/ads` | iPhone Safari 17 | 403 |
| `/ads?sort_by=date_pub&sort_order=DESC` | default curl | 200 |

UA is not the gate; the sort_by query param is. Crawler always uses sorted URL. **R2 right.**

### R2 #9 `platform = "drupal-classifieds"` — COULDN'T DISPROVE
`Grep siteProfile.platform backend/src` returns 0 runtime branches. Field is informational only. Skill canonical naming favored. **R2 right; no runtime impact.**

### R2 #10–12 `catalogUrls`, `sortParam`, `needsPlaywright`, `wafType` — COULDN'T DISPROVE
All trivially verified by live HEAD/GET. **Both-agree, R2 right.**

---

## Prior-R3 claim re-tests

### Prior-R3 claim A: soldDetection false-positives on live not-sold pages — **REPRODUCED**
Method: re-fetched a random p0 listing (Riton scope, not-sold), ran the exact runtime regex from `product-verifier.ts:286-301`. Three of R2's four non-`Yes` patterns fire. Same severity as prior R3. R2 endorsed a broken set.

### Prior-R3 claim B: wantedDetection array→regex coercion — **REPRODUCED**
Method: ran `new RegExp(array, 'i')` exactly as `product-verifier.ts:260` does. Comma-joined regex matches nothing. Same severity as prior R3. R2 endorsed it again 36 hours later without re-running the regex.

### Prior-R3 claim C: `expectedProductCount` exact integer drifts within ~30 min — PARTIALLY SUPERSEDED
This R3 also drifted (25,161 by pagination-walk today vs R2's 25,186). The new_in_box facet sum (25,186 today) is a more stable third anchor than R2's province sum. Prior R3 was correct that the integer drifts; this R3 adds that the facet-attribute sum is more stable than walking the pager.

---

## Strongest counter-claims (top 3)

1. **soldDetection (R2 #5) is RUNTIME-BROKEN.** With R2's stored 4-entry list, `isSold()` returns true on every alive gunpost listing because `class="sold No"` matches the `class=sold` pattern (the `\bsold\b` word boundary doesn't see the `" No"` suffix). The only correct value is `["field-sold Yes"]`. Evidence: live not-sold detail page (Riton scope from p0) reproduces the false positive.

2. **wantedDetection (R2 #6) is RUNTIME-BROKEN — same bug as prior R3 surfaced.** R2's "PRESERVE DB array" silently disables wanted-classification because `product-verifier.ts:260` does `new RegExp(array, 'i')` which coerces the array via `toString()` to a comma-joined never-matching pattern. R2 read the consumer code but skipped the type check. Either store as a pipe-joined string OR omit and let the default fallback fire.

3. **R2's "generic CSS fallback at product-verifier.ts:308 also matches" is wrong.** The fallback `$('.sold, .ad-sold, .field-sold').length > 0` ALSO false-positives on gunpost because every alive ad emits `class="sold No"` and `class="field-sold No"` — cheerio matches class-presence ignoring qualifier suffix. This is a latent runtime bug; R2 cited it as supporting evidence without testing it.

---

## expectedProductCount = 25,186 — third-method verification (REQUIRED)

| method | value | source |
|---|---|---|
| (1) pagination walk | 25,161 today | live p1677=6 reg, p1678=empty → `(1677*15)+6` |
| (2) province facet sum | 25,186 today | sum of 11 province `data-drupal-facet-item-count` attrs |
| (3) **new_in_box facet sum (NEW)** | **25,186 today** | Used (24,654) + New (532) from `data-drupal-facet-item-count` attrs |

Three methods cluster within 25 of 25,186 (0.1%). **Confirmed.** R2's 25,186 holds; R1's 30,225 and DB's 30,423 are wrong by ~5,000 (sticky-teaser double-count).

## wantedDetection regex array-coercion bug — STATUS (REQUIRED)

`backend/src/services/product-verifier.ts:259-260` re-read this run:
```ts
const wantedPattern = entry?.siteProfile?.classifiedRules?.wantedDetection;
const wantedRegex = wantedPattern ? new RegExp(wantedPattern, 'i') : /\b(wanted|wtb|wtt|iso)\s*$/;
```
- `wantedPattern` is untyped (consumer expects string, DB stores `string[]`).
- `new RegExp(array, 'i')` calls `array.toString()` → `'^wanted,wtb$,wtt$,iso$,wanted$,wanted:'` → syntactically valid regex that matches nothing real.
- Truthy array bypasses the default fallback ternary branch.

**Status: BUG CONFIRMED, still present at HEAD. R2's preservation recommendation makes wanted-classification silently fail.**

Correct remediation options (in order of preference):
1. Fix the schema: store wantedDetection as a single regex string (pipe-joined), update `pre-bootstrap` to emit that shape, and adjust soldDetection consumer too.
2. Coerce at consumer: `Array.isArray(wantedPattern) ? wantedPattern.join('|') : wantedPattern`.
3. Drop the field for this site (use the default regex) — but that still has a coverage gap ("want to buy" titles).

---

## R2 claims that survived hardest scrutiny

- expectedProductCount = 25,186 (3 independent methods within 0.1%)
- productCountMethod = `html-pagination` (only one of 11 canonical switch arms; `pagination-walk` is silent-broken)
- userAgentOverride = null (UA-orthogonal; URL param is the gate)
- customSelectors = null (zero runtime consumers — confirmed by grep)

## Latent runtime bugs flagged for orchestrator (not R2's fault, but R2 endorsed them)

1. `product-verifier.ts:260` — `new RegExp(arrayValue, 'i')` assumes string; DB stores array on classifieds sites.
2. `product-verifier.ts:286-301` — regex `class="[^"]*\bX\b[^"]*"` cannot distinguish `class="sold No"` from `class="sold Yes"`; the className is identical and `\bsold\b` doesn't bind the qualifier.
3. `product-verifier.ts:308` — CSS fallback `$('.sold, .ad-sold, .field-sold').length` has the same gunpost.ca false-positive issue (matches class-presence ignoring suffix qualifier).

All three should be filed as runtime bugs separate from the audit row. **The audit-row remediation alone (storing the "right" siteProfile values) cannot fix gunpost.ca classification while these three runtime bugs stand.**
