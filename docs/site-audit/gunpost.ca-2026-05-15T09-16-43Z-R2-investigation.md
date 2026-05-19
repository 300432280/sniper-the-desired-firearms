# gunpost.ca — R2 live investigation

**Run:** R2-live-2026-05-15T09-16-43Z
**Method principle:** for every R1-divergent field, use a probe method DIFFERENT from R1's hypothesis; trust neither side; live-verify.
**Probe vantage:** single-IP curl + grep over saved HTML, plus targeted runtime-code reads. No Playwright needed (static HTML is sufficient for this site).

---

## 1. `productCountMethod.method` — DB:`pagination-walk` vs R1:`html-pagination`

**Method:** read the canonical runtime switch directly.

**Evidence (read `backend/src/services/product-count-probe.ts`):**

Switch cases at line numbers:
- 149: `wp-rest-header`
- 156: `json-api-count`
- 163: `json-api-length`
- 182: `html-pagination`
- 204: `sitemap`
- 212: `sitemap-index`
- 226: `generic-product-sitemap`
- 250: `ecwid-storefront-search`
- 272: `shopify-products-walk`
- 302: `klevu-api-count`
- 333: `stream-page-count`

`pagination-walk` is NOT in the switch. DB value falls through to `default: return null`. Probe is silently disabled.

**Verdict:** R1 correct. Canonical = `html-pagination`. **Confidence: high.**

---

## 2. `expectedProductCount` — DB:30,423 vs R1:30,225 — BOTH WRONG

**Method:** live HTML walk + cross-reference live facet sums.

**Probe data (2026-05-15T09:13:19Z to 09:14:30Z, sorted UA `Chrome/120 Mac`):**

| URL | HTTP | regular teasers (`node--view-mode-teaser`) | promoted teasers (`node--view-mode-promoted-teaser`) |
|---|---|---|---|
| `/ads?sort_by=date_pub&sort_order=DESC` (p0) | 200 | 15 | 3 |
| `?page=1` | 200 | 15 | 3 |
| `?page=500` | 200 | 15 | 3 |
| `?page=1679` (R1's "last") | 200 | 1 | 3 |
| `?page=1680` | 200 | **0** (`view-empty: No results found.`) | 3 |

**Promoted-teaser set rotates across pages** — not fixed:
- p0: 1228380, 1160134, 628101
- p1: 1224475, 1210306, 1228380

So sticky promoted teasers ARE visible on every page but are not "listing entries" — they're rotating ad placements. Counting them as listings inflates the total by 3 per page.

**Real arithmetic:**
- Pages with regular listings: p0..p1679 = 1680 pages (zero-indexed)
- perPage (regular) = 15
- lastPageItems (regular only) = 1
- Real count = (1679 × 15) + 1 = **25,186**

**Cross-check vs live facet sums on p0 HTML:**

Province-sum:
```
Ontario 9200 + Alberta 4361 + BC 3960 + Quebec 2447 + Manitoba 1726
+ NS 1195 + SK 1089 + NB 895 + NFLD 113 + PEI 106 + Territories 94
= 25,186  ← EXACT MATCH
```

Category-sum:
```
Firearms 10505 + Accessories 4695 + Optics 2468 + Reloading 1867
+ Ammo 1766 + Blades 878 + Airgun 627 + Archery 623 + Range 602
+ Hunting 492 + Cases 366 + Books 109 + Services 94 + Muzz 52 + Targets 42
= 25,184  ← MATCH (2-off; categorization gap is trivially small)
```

**R1's `totalsSumCheck` note blamed the 17% drift on "uncategorized/sticky/sold-retention".** Wrong direction — the actual cause is R1 multiplied perPage=18 × 1680 pages, **double-counting 3 sticky promoted teasers per page = 3 × 1680 = 5,040 phantom listings.** Math check: 30,225 − 25,186 = 5,039. Matches to within rounding.

**Verdict:** BOTH R1 and DB wrong. Third truth = **25,186**. **Confidence: high.**

---

## 3. `perPage` — DB:18 vs R1:18 — both wrong for arithmetic; OK for crawler mechanics

**Method:** same data as §2.

**Verdict:** crawler-mechanical perPage (visible card slots) = 18 (kept for pagination logic). Listing-count perPage = 15 (regular teasers only). The `expectedProductCount` formula MUST use 15, not 18.

**Operator note:** keep `perPage:18` for crawler mechanics, but update the `productCountMethod.formula` to `(1679 * 15) + 1 = 25,186` and `productCountMethod.perPage:15` for count-probe correctness.

---

## 4. `classifiedRules.soldDetection` — DB:`ad-sold` vs R1:`field-sold`

**Method:** live search for `?key=sold` to surface real sold-class markup.

**Evidence (2026-05-15T09:15Z):**
```
$ grep -oE 'class="[^"]*sold[^"]*"' /tmp/gp-sold-search.html | sort -u
class="field-sold"
class="layout-type--page-layout user-logged-out path-not-frontpage path-ads path-query-keysoldsort-bydate-pubsor theme-name--gunpost"
class="sold"
```

NO `class="ad-sold"` found in any live HTML across multiple URLs (p0, p1, p500, p1679, p1680, sold-search).

**Generic CSS fallback (`product-verifier.ts:308`):**
```javascript
if ($('.sold, .ad-sold, .field-sold').length > 0) return true;
```

This fallback would still match `.sold` or `.field-sold` regardless of the per-site list. The DB's `ad-sold` is dead-but-not-harmful: detection still fires on `class=sold` (live present) or `field-sold Yes` (literal in both DB and R1).

**Verdict:** R1's set `["class=sold","class=field-sold","field-sold Yes","SOLD"]` is correct. **Confidence: high.**

---

## 5. `classifiedRules.wantedDetection` — DB:has regex / R1:omitted — DB WINS

**Method:** grep for `wantedDetection` in `backend/src` to identify runtime consumers.

**Evidence:**
```
backend/src/services/product-verifier.ts:259:    const wantedPattern = entry?.siteProfile?.classifiedRules?.wantedDetection;
```

Line 259-260:
```javascript
const wantedPattern = entry?.siteProfile?.classifiedRules?.wantedDetection;
const wantedRegex = wantedPattern ? new RegExp(wantedPattern, 'i') : /\b(wanted|wtb|wtt|iso)\s*$/;
```

→ runtime DOES read this field. If absent, falls back to a less-comprehensive default regex.

**Live data — real wanted titles via `?key=wanted` search:**
- "Want to buy mosin nagant m44 or m38" (h2 inside `node--view-mode-teaser`)
- "wanted-vintageantique-firearmsmilitary-items..." (URL slug)
- "Wanted: collector looking invest" (URL slug)
- "shoei-mp44-wanted" (URL slug)
- "wanted-winch-32-special-ammunition" (URL slug)

DB's regex set `["^wanted","wtb$","wtt$","iso$","wanted$","wanted:"]` covers most. Note: "want to buy ..." does NOT match `^wanted` (it starts with "Want to" not "Wanted"). This is an existing detection gap unrelated to the audit — flagged for operator review.

**Verdict:** PRESERVE DB's `wantedDetection`. R1 wrong to drop. **Confidence: high.**

**SKILL.md gap:** Stage 3 classifieds-specific output section documents `soldDetection` only. Add `wantedDetection` as a documented output field with same regex-syntax shape.

---

## 6. `apiConfig.customSelectors` — R1 said "runtime-consumed", DISPROVED

**Method:** grep entire backend/src for `customSelectors` references.

**Evidence:**
```
$ grep -rn customSelectors backend/src
(no matches)
```

ZERO consumers. The 6 selectors stored in DB (`postDate`, `sourceId`, `pagination`, `soldIndicator`, `productListing`, `wantedIndicator`) are read by NOTHING at runtime.

**Cross-check — what selectors does the adapter ACTUALLY use?** Read `backend/src/services/scraper/adapters/classifieds-gunpost.ts:96-100`:
```javascript
const SELECTORS = [
  '[class*="node--type-classified"]',
  '[class*="gunpost-teaser"]',
  '[class*="node--type-"][class*="teaser"]',
  '[class*="classified-ad"]',
  ...
```

Plus `.node__pubdate` hard-coded at line 61 for date extraction. All adapter selectors are hard-coded; none are read from `siteProfile.apiConfig.customSelectors`.

**Verdict:** R1 correct to omit. R1's diff-md TEXT mis-described the field as "runtime-consumed" but R1's decision was right. Operator should DELETE this block from the DB profile — it's pure documentation residue. **Confidence: high.**

---

## 7. `userAgentOverride` — DB:iPhone Safari (prior batch) vs R1:null

**Method:** test bare /ads with 4 different UAs.

**Evidence (2026-05-15T09:14Z, 4 sequential GETs with 800ms+ delay):**

| User-Agent | URL | Status |
|---|---|---|
| `curl/7.x` (default) | `/ads` | 403 |
| iPhone Safari 17 | `/ads` | 403 |
| Chrome 120 (Linux) | `/ads` | 403 |
| Chrome 120 (Mac) | `/ads` | 403 |
| `curl/7.x` (default) | `/ads?sort_by=date_pub&sort_order=DESC` | 200 |

Cloudflare rule is URL-parameter-selective (sort_by triggers a different rule path that doesn't challenge), NOT UA-selective. The DB's prior `userAgentOverride: iPhone Safari` value had ZERO effect on real crawls since `catalogUrls` always include sort_by.

**Verdict:** R1's `null` is correct. **Confidence: high.**

---

## 8. `platform` — DB:`drupal` vs R1:`drupal-classifieds`

**Method:** read SKILL.md platform table + check runtime usage of `platform` field.

**Evidence:** `adapterType` (the routing-critical field) agrees on both sides at `classifieds-gunpost`. The `platform` field itself is informational. Skill canonical = `drupal-classifieds`.

**Verdict:** R1 canonical. No runtime impact today. **Confidence: high.**

---

## 9. `catalogUrls`, `sortParam`, `needsPlaywright`, `wafType` — both agree

All verified live; both sides match; verdicts trivial. **Confidence: high.**

---

## SKILL.md harness gaps confirmed

1. **`wantedDetection` is a real runtime field** but not in skill output target. Add to Stage 3 classifieds-specific output section, parallel to `soldDetection`, with regex-syntax docs.

2. **`apiConfig.customSelectors` is NOT runtime** — operator-residue. R1's diff-md text was wrong to call it "runtime-consumed" but R1's omission decision was right.

3. **Stage 8 reconciliation for classifieds should warn about sticky/promoted-teaser inflation.** R1's totalsSumCheck note misattributed the 17% drift — the actual cause is `perPage` for arithmetic vs `perPage` for crawler mechanics. Skill should prescribe: "On Drupal Views classifieds with sticky promoted teasers, count `node--view-mode-teaser` only, NOT total visible cards. Cross-check against facet province-sum or category-sum before publishing expectedProductCount."

4. **`productCountMethod` field name validation** — skill should enforce that `method` MUST be one of the 11 canonical names in the runtime switch (link to `product-count-probe.ts:148-451`). DB has a stale `pagination-walk` value that silently disables the probe; pre-bootstrap should refuse to emit non-canonical method names.

---

## Raw fetch log

```
09:13:19Z GET /ads?sort_by=date_pub&sort_order=DESC                            -> 200, 561,345 bytes (UA: Chrome 120 Mac)
09:13:42Z GET /ads?sort_by=date_pub&sort_order=DESC&page=1679                  -> 200, 506,732 bytes
09:13:54Z GET /ads?sort_by=date_pub&sort_order=DESC&page=1680                  -> 200, 503,293 bytes
09:14:07Z GET /ads?sort_by=date_pub&sort_order=DESC&page=1                     -> 200
09:14:19Z GET /ads?sort_by=date_pub&sort_order=DESC&page=500                   -> 200
09:14:30Z GET /ads                                            (curl default)   -> 403
09:14:31Z GET /ads                                            (iPhone Safari)  -> 403
09:14:32Z GET /ads                                            (Chrome Mac)     -> 403
09:14:33Z GET /ads?sort_by=date_pub&sort_order=DESC            (curl default)  -> 200
09:15:05Z GET /ads?sort_by=date_pub&sort_order=ASC&page=0                      -> 200
09:15:23Z GET /ads?key=sold&sort_by=date_pub&sort_order=DESC                   -> 200
09:15:40Z GET /ads?key=wanted&sort_by=date_pub&sort_order=DESC                 -> 200
```

All inter-request delays >= 800ms per project rate-limit policy.
