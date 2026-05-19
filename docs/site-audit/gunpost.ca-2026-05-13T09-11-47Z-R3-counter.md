# R3 Adversarial Counter — gunpost.ca

**Run ID:** R3-counter-2026-05-13T09-11-47Z
**R2 corrections file:** `docs/site-audit/gunpost.ca-2026-05-13T08-48-19Z-R2-corrections.json`
**Method:** Fresh skeptic. Re-probed live + traced every runtime code path R2 cited. Did NOT read R1 candidate or diff MD.
**Inter-request delay:** >=800ms per fetch.

R2 made 8 corrections. I attempted to disprove each. Result: **2 broken (one severe, one latent runtime bug), 5 couldn't disprove, 1 inconclusive.**

---

## CORRECTION 1: `platform` -> `drupal-commerce` (R2 high)

**Tried to break by:** live HEAD re-fetch + searching for any non-Drupal/non-Commerce header.

**Live evidence 2026-05-13T09:04:50Z:** `HEAD https://www.gunpost.ca/ads?sort_by=date_pub&sort_order=DESC` returned:
```
X-Generator: Drupal 10 (https://www.drupal.org)
X-Commerce-Core: 2
```
Both markers present, identical to R2.

Grep `siteProfile\.platform` in `backend/src/`: 0 hits. Field is purely operator-readable, no runtime branch dispatches on its value.

**Verdict:** Couldn't disprove. R2 right.

---

## CORRECTION 2: `expectedProductCount` -> `30077` (R2 high)

**Tried to break by:** full pagination terminus re-walk + filler-page hunt at scale.

**Live evidence 2026-05-13T09:05:xxZ..09:08:xxZ:**

| Page | Unique node IDs | Pager state |
|---|---|---|
| 0 | 18 | last -> `page=1670` |
| 100 | 18 | (mid) |
| 500 | 18 | (mid) |
| 1000 | 18 | (mid) |
| 1500 | 18 | (mid) |
| 1668 | 18 | (mid) |
| 1669 | 18 | (mid) |
| **1670** | **13 (NOT 17)** | pager has --first/--previous/--ellipsis but NO --next, NO --last |
| 1671 | 3 (different IDs each fetch) | no pager |
| 1672 | 3 | no pager |
| 1690 | 3 | no pager |
| 5000 | 3 | no pager |
| 100000 | 3 | no pager |

Out-of-range filler IDs are not on page 0 nor page 1670: confirmed sticky/featured filler.

**Counter-claim (stale):** **Actual count today is 30,073** (`1670 * 18 + 13 = 30,073`), not the 30,077 R2 reported 23 minutes earlier. The catalog shrunk by 4 between probes — normal classifieds churn (ads expire). R2's `30,077` was momentarily true but is already drifting. DB's `30,423` is still wrong by ~350.

**Runtime impact:** Negligible. The `html-pagination` formula computes `1670 * 18 = 30,060`. Coverage today: `30060/30073 = 99.96%`, well above the 95% gate. Any single number stored here ages out within hours.

**Verdict:** Methodology correct, exact integer stale. The correct stance is "store the floor (30,060) and trust the coverage gate," not pursue a moving target. R2's 30,077 is not provably wrong, but it isn't reproducible either.

---

## CORRECTION 3: `productCountMethod` -> `html-pagination` shape (R2 high)

**Tried to break by:** re-read `backend/src/services/product-count-probe.ts` switch cases.

```
case 'wp-rest-header': (line 149)
case 'json-api-count': (156)
case 'json-api-length': (163)
case 'html-pagination': (182)
case 'sitemap': (204)
case 'sitemap-index': (212)
case 'generic-product-sitemap': (226)
case 'ecwid-storefront-search': (250)
case 'shopify-products-walk': (272)
case 'klevu-api-count': (302)
case 'stream-page-count': (333)
default: -> console.warn + return null (446-451)
```

`pagination-walk` is NOT in the union. DB's stored method silently returns null. R2's `html-pagination` shape is one of the 11 valid arms.

**Verdict:** Couldn't disprove. R2 right. Latent DB drift confirmed.

---

## CORRECTION 4: `searchUrl` -> `/ads?key={keyword}` (R2 high)

**Tried to break by:** live search test + adapter source re-read.

**Live evidence 2026-05-13T09:09:xxZ:** `GET /ads?key=glock` -> HTTP 200, 148636 bytes, 15 node IDs, title `Classified Ads | GUNPOST`. Matches R2 exactly.

Adapter `classifieds-gunpost.ts:82-84` hardcodes the same pattern.

**Verdict:** Couldn't disprove. R2 right.

---

## CORRECTION 5: `classifiedRules.soldDetection` -> `["class=sold","class=ad-sold","class=field-sold","field-sold Yes","SOLD"]` (R2 high)

**Tried to break by:** trace the actual runtime regex behavior on real gunpost markup. R2 cited the adapter but the runtime ALSO uses `product-verifier.ts` and `stale-detector.ts`, which build regexes differently.

**Runtime build at `product-verifier.ts:290-301`:**
- `class=X` -> regex `class="[^"]*\bX\b[^"]*"` (matches className irrespective of position)
- non-`class=` pattern -> escape + `\s+` joiner -> matches text anywhere in HTML

**Live markup (detail page, NOT sold):**
```
<div class="field-sold No"><div class="sold No">SOLD</div></div>
```
The `SOLD` text and the `sold` class are ALWAYS present on every listing. Only the `No`/`Yes` qualifier toggles whether the item is actually sold. The `SOLD` badge is CSS-hidden when qualifier is `No`.

**Reproducer (Node, exact runtime regex code copy-pasted from product-verifier.ts:290-301):**

| Pattern | NOT-SOLD page (`field-sold No`) | SOLD page (`field-sold Yes`) |
|---|---|---|
| `class=sold` | **FALSE POSITIVE** sold:true | sold:true |
| `class=ad-sold` | sold:false (markup never emits) | sold:false |
| `class=field-sold` | **FALSE POSITIVE** sold:true | sold:true |
| `field-sold Yes` | sold:false (correct) | sold:true (correct) |
| `SOLD` | **FALSE POSITIVE** sold:true (badge text in HTML even when hidden) | sold:true |

**COUNTER-CLAIM (severe):** R2's "5-entry union" actively breaks runtime sold detection. Three of five patterns fire false positives on every gunpost listing:
- `class=sold` matches `class="sold No"` because `\bsold\b` matches the className "sold" regardless of the trailing `" No"`.
- `class=field-sold` matches `class="field-sold No"` for the same reason.
- `SOLD` matches the always-present hidden badge text.

Effect: with R2's list in the DB, `isSold()` returns true for every alive gunpost ad. The DB's 4-entry list has the same bug. The candidate's 3-entry list (`class=field-sold`, `field-sold Yes`, `SOLD`) ALSO breaks.

**The only correct value for gunpost.ca soldDetection is `["field-sold Yes"]`** — the single positional pattern that distinguishes Yes from No. Everything else either always fires or never fires.

R2's audit-trail was correct (adapter has `.sold`/`.ad-sold` selectors) but R2 didn't notice the adapter is NOT the only consumer; `product-verifier.ts:286` and `stale-detector.ts:154` both consume the same DB array with a different regex shape, and on this site that regex shape fires false positives.

**Verdict:** **R2 broken on this field.** Strongest R3 finding.

(Note: this is also a pre-existing bug for the DB list, not a new R2-introduced regression. R2's recommendation makes it slightly worse by adding `class=field-sold` (a third broken pattern). Orchestrator should escalate the underlying runtime regex bug separately.)

---

## CORRECTION 6: `classifiedRules.wantedDetection` -> DB 6-pattern array (R2 medium)

**Tried to break by:** grep for `wantedDetection` in `backend/src/`.

**Counter-finding:** R2 claimed "runtime does NOT read from siteProfile for wanted detection (adapter is self-contained)" — **wrong**.

`backend/src/services/product-verifier.ts:259-261`:
```ts
const wantedPattern = entry?.siteProfile?.classifiedRules?.wantedDetection;
const wantedRegex = wantedPattern ? new RegExp(wantedPattern, 'i') : /\b(wanted|wtb|wtt|iso)\s*$/;
if (wantedRegex.test(titleLower)) { ... }
```

Runtime reads `wantedDetection` and builds `new RegExp(<value>, 'i')`. The DB stores an **array**. `new RegExp([...], 'i')` coerces the array to a string via `Array.prototype.toString` -> comma-joined: `^wanted,wtb$,wtt$,iso$,wanted$,wanted:`. That joined string is a syntactically valid but semantically useless regex — never matches normal classifieds titles. Verified:

```
> new RegExp(['^wanted','wtb$','wtt$','iso$','wanted$','wanted:'], 'i').test('wanted glock')
false
> new RegExp(['^wanted','wtb$','wtt$','iso$','wanted$','wanted:'], 'i').test('my wtb')
false
```

**Effect:** With the DB/R2 array form stored, runtime wanted-classification at `product-verifier` silently always returns "not wanted." The default ternary fallback is bypassed because the array is truthy.

**Counter-claim:** R2's "keep DB array, harmless" verdict is wrong about runtime impact. The correct fix is either:
- Store a **single combined regex string** (e.g., `^(wanted|wtb|wtt|iso)\\b|\\b(wanted|wtb|wtt|iso)\\s*$|\\bwanted\\s*:`), OR
- Omit the field and let the default fire.

The adapter (`classifieds-gunpost.ts:34-52`) has its own hardcoded wanted detection that DOES work. Runtime impact is limited to product-verifier's classification path, not the catalog adapter. Still: R2 said "harmless"; it isn't.

**Verdict:** R2 medium-confidence verdict broken on runtime semantics. Pre-existing DB bug, but R2 endorsed it.

---

## CORRECTION 7: `userAgentOverride` -> `null` / OMIT (R2 high)

**Tried to break by:** test bare `/ads` and sorted `/ads` with both Chrome and iPhone UAs.

**Live evidence 2026-05-13T09:10:xxZ:**

| URL | Chrome 131 | iPhone Safari 17.2 |
|---|---|---|
| `/ads` (bare) | HTTP 403, 5545 bytes (CF challenge) | HTTP 403, 5610 bytes (CF challenge) |
| `/ads?sort_by=date_pub&sort_order=DESC` | HTTP 200, 561176 bytes | HTTP 200, 561176 bytes |

Adapter `getNewArrivalsUrls()` hardcodes the sorted form (line 184-186) — runtime never hits bare `/ads`. iPhone UA does NOT bypass bare `/ads` (still 403).

**Verdict:** Couldn't disprove. R2 right. iPhone UA override is dead weight.

---

## CORRECTION 8: WAF residue fields (`wafLastProbedAt` etc.) (R2 high mixed)

**Tried to break by:** none — pure shape/staleness comparison, R2's verdict already accepts candidate-fresh + DB-prose-workaround mix.

**Verdict:** Inconclusive; not enough material conflict to test.

---

## Tally

| # | Field | R2 said | R3 verdict |
|---|---|---|---|
| 1 | platform | drupal-commerce | couldn't disprove |
| 2 | expectedProductCount | 30077 | stale by 4 (drift); methodology correct |
| 3 | productCountMethod | html-pagination shape | couldn't disprove |
| 4 | searchUrl | /ads?key={kw} | couldn't disprove |
| 5 | soldDetection (5-entry) | high confidence | **BROKEN — false positives on every alive ad** |
| 6 | wantedDetection (DB array) | "harmless" | **BROKEN — array coerces to non-matching regex** |
| 7 | userAgentOverride | null | couldn't disprove |
| 8 | WAF residue fields | mixed | inconclusive |

**Tried to disprove:** 8 corrections.
**Successfully countered:** 2 (soldDetection severity-high; wantedDetection severity-medium-latent-bug).
**Couldn't disprove:** 5.
**Inconclusive:** 1.

## Strongest counter-claims (one-liners)

1. **soldDetection** — correct value is `["field-sold Yes"]` only — every other pattern fires false positives on the always-present `class="sold No"` / `SOLD` badge markup. Evidence: Node reproducer of `product-verifier.ts:290-301` regex against live detail-page HTML (`<div class="field-sold No"><div class="sold No">SOLD</div></div>`).
2. **wantedDetection** — array form silently breaks `product-verifier.ts:260` (`new RegExp(array,'i')` -> comma-joined never-matching regex). Either store a combined regex string or omit. R2's "harmless" verdict is wrong.
3. **expectedProductCount** — exact integer 30,077 was already stale 23 min later (catalog now 30,073). Methodology is fine; the stored integer drifts hourly. Coverage gate (95%) protects this.

## R2 claims that survived hardest scrutiny

- `userAgentOverride` -> OMIT: tested bare/sorted on Chrome + iPhone. iPhone UA helps NOTHING on this site. R2 solid.
- `productCountMethod` -> `html-pagination`: 11-arm switch confirmed by line-by-line re-read; `pagination-walk` falls to default null. R2 solid.
- `platform` -> `drupal-commerce`: live HEAD reproduced both markers. R2 solid.

## Latent runtime bugs surfaced (not R2's fault, but R2 endorsed them)

1. `product-verifier.ts:260` does `new RegExp(arrayValue, 'i')` — assumes string, gets array on classifieds sites.
2. `product-verifier.ts:290-301` regex `class="[^"]*\bX\b[^"]*"` cannot distinguish `class="sold No"` from `class="sold Yes"` because the className is identical; needs a separate `field-sold Yes`-style positional pattern.

Recommend orchestrator file these as runtime bugs separate from this audit row.
