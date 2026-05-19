# gunpost.ca — R1 candidate vs DB siteProfile diff

**Run:** R1-blind-2026-05-15T08-52-03Z
**Candidate file:** `docs/site-audit/gunpost.ca-2026-05-15T08-52-03Z-R1.json`
**DB siteProfile lastVerified:** 2026-04-11 (34 days stale at audit time)

---

## TL;DR

R1 candidate AGREES with DB on every runtime-impacting field except surface label-drift and one new field (`paginationPattern.perPage` + `paginationPattern.startPage`). The DB's `productCountMethod: "pagination-walk"` is a **non-canonical method name** that falls through to `default: return null` in `backend/src/services/product-count-probe.ts:149-333` — the DB profile silently disables the count probe at runtime. R1 emits canonical `html-pagination`.

13 divergent fields total. None invalidate the DB profile's operational behavior except the `productCountMethod` label drift (which IS a real runtime gap).

---

## Field-by-field diff

| Field | Candidate (R1) | DB siteProfile | Divergent? | One-line why |
|---|---|---|---|---|
| `profileVersion` | `1` | _(absent)_ | yes | DB schema predates the `profileVersion` field; not material to runtime. |
| `platform` | `"drupal-classifieds"` | `"drupal"` | yes | Skill table canonical is `drupal-classifieds` (separator + qualifier); DB has older bare `"drupal"` tag — pure label drift, no runtime consequence today. |
| `adapterType` | `"classifieds-gunpost"` | `"classifieds-gunpost"` | no | Agree. |
| `hasWaf` | `true` | `true` | no | Agree. |
| `wafType` | `"cloudflare-active"` | `"cloudflare-active"` | no | Agree. |
| `wafLastProbedAt` | `"2026-05-15"` | `"2026-04-11"` | yes (expected) | DB last-probed 34 days earlier; R1 is fresh. |
| `wafProbeMethod` | `"heavy-8-batch"` | `"heavy-8-batch"` | no | Agree. |
| `wafProbeResult` | detailed string | one-line string | yes (form only) | DB stores brief string; R1 produces detailed string per skill spec. |
| `wafProbeEvidence` | object | string | yes (form only) | DB stored as flat string; R1 produces structured object per skill output target. |
| `wafWorkaround` | _(absent)_ | `{method:"http-direct", steps:[...], rateLimitNotes:..., perRequestPlaywright:false}` | yes | Candidate omits because skill says `wafWorkaround` is for malformed-header sites (Celerant) — gunpost has no malformed headers. DB carries operator-added documentation block; not in skill's runtime field list. R1 follows skill spec. |
| `hasCaptcha` | `false` | `false` | no | Agree. |
| `captchaType` | `null` | _(absent)_ | yes (form only) | Skill requires explicit null; DB omits when null. |
| `ageGate` | `{detected:false,type:null,bypassCookie:null}` | _(absent)_ | yes (form only) | Skill requires explicit object; DB omits. No age-gate exists on the site. |
| `userAgentOverride` | `null` | _(absent)_ | yes (form only) | Same — skill requires explicit null. |
| `needsPlaywright` | `false` | `false` | no | Agree (Mistake 37: sorted URLs pass CF cleanly via plain HTTP). |
| `expectedProductCount` | `30225` | `30423` | yes | DB stored 2026-04-11 walk: `1690 * 18 + 3 = 30,423`. Today: `1679 * 18 + 3 = 30,225`. Site shrank by 198 listings (0.65%) in 34 days. Both correct as-of their probe dates. |
| `productCountMethod.method` | `"html-pagination"` | `"pagination-walk"` | yes (CRITICAL) | DB uses non-canonical method name that is NOT in `product-count-probe.ts` switch (cases at lines 149/156/163/182/204/212/226/250/272/302/333). Falls through `default: return null` — count probe silently disabled. R1 uses canonical `html-pagination` (case at line 182). |
| `productCountMethod` other keys | `selector, perPage, formula, lastPageZeroIndexed, lastPageItems` | `formula, totalPages, lastPageItems` | yes | R1 adds `selector` per skill html-pagination shape `{method, selector, perPage}`. |
| `catalogUrls` | `["/ads?sort_by=date_pub&sort_order=DESC"]` | `["/ads?sort_by=date_pub&sort_order=DESC"]` | no | Agree (Mistake 37 single-URL global catalog). |
| `extractionTested` | `true` | _(absent)_ | yes | Skill requires; DB omits. |
| `extractionSample` | 3 products | _(absent)_ | yes | Skill requires per Stage 4g; DB omits. |
| `sortParam` | `"?sort_by=date_pub&sort_order=DESC"` | `"?sort_by=date_pub&sort_order=DESC"` | no | Agree. |
| `sortVerified` | `true` | _(absent)_ | yes | Skill requires; DB has it implicitly via the catalogUrl bake-in but not as a discrete flag. |
| `perPage` | `18` | `18` | no | Agree. |
| `paginationPattern.type` | `"query"` | `"query"` | no | Agree. |
| `paginationPattern.template` | `"page"` | `"page"` | no | Agree. |
| `paginationPattern.perPage` | `18` | _(absent at pagination level)_ | yes (form only) | DB stores perPage only at top level; R1 mirrors per skill shape. |
| `paginationPattern.firstPageHasParam` | `false` | `false` | no | Agree. |
| `paginationPattern.startPage` | `0` | _(absent)_ | yes | R1 sets explicit `startPage:0` per skill shape; DB stores via `zeroIndexed:true` only. |
| `paginationPattern.zeroIndexed` | `true` | `true` | no | Agree. |
| `crawlers.watermark.method` | `"navigate-from-watermark"` | `"navigate-from-watermark"` | no | Agree. |
| `crawlers.bootstrap.apiEndpoints` | `null` | `null` | no | Agree (DB has additional `method` and `htmlFallback` keys — operator-curated). |
| `crawlers.maintain.verifyMethod` | `"detail-page"` | `"detail-page"` | no | Agree. |
| `crawlers.maintain.verifyEndpoint` | `null` | _(absent)_ | yes (form only) | Skill requires explicit null; DB omits. |
| `crawlers.maintain.method` | _(absent)_ | `"db-verification"` | yes | DB has runtime-tier-config `method`+`cooldowns`+`tierShares`+`tierWindows` keys; these are runtime-tuning operator residue, NOT pre-bootstrap targets. R1 follows skill spec (Rule B). |
| `classifiedRules.soldDetection` | `["class=sold","class=field-sold","field-sold Yes","SOLD"]` | `["class=sold","class=ad-sold","field-sold Yes","SOLD"]` | yes | R1 has `class=field-sold` (matches the `.field-sold` CSS class in live HTML); DB has older `class=ad-sold`. Both share `field-sold Yes` literal so detection still works on DB. R1 catches one extra HTML pattern. |
| `classifiedRules.wantedDetection` | _(absent)_ | `["^wanted","wtb$","wtt$","iso$","wanted$","wanted:"]` | yes | DB has site-specific wanted-ad regex set; skill does NOT document `wantedDetection` as a target field for classifieds. Operator-added; should be preserved. R1 misses it because skill's classifieds output section only covers `soldDetection`. |
| `searchUrl` | `"/ads?key={keyword}"` | `"/ads?key={keyword}"` | no | Agree. |
| `topLevelCategories` | 15 categories with counts | _(absent)_ | yes | Skill recommends; DB omits. Operator-useful documentation block. |
| `lastVerified` | `"2026-05-15"` | `"2026-04-11"` | yes (expected) | R1 is fresh. |
| `auditNotes` | object | _(absent)_ | yes | Skill recommends; DB omits. |
| `notes` | _(absent)_ | long string | yes | DB freeform operator notes — Rule B residue (NOT a target field for pre-bootstrap). |
| `budget` | _(absent)_ | `350` | yes | Runtime tier-budget setting; outside skill's scope. |
| `timeout` | _(absent)_ | `30000` | yes | Runtime config; outside skill's scope. |
| `domain` | _(absent in candidate body)_ | `"gunpost.ca"` | yes (form) | Skill output target does not include `domain` at top level (it's the filename suffix); DB stores in profile body. |
| `name` | _(absent)_ | `"GunPost"` | yes | DB display name; outside skill's scope. |
| `siteCategory` | _(absent)_ | `"classified"` | yes | DB taxonomy hint; outside skill's scope. |
| `crawlPhase` | _(absent)_ | `"bootstrap"` | yes | Runtime phase state; outside skill's scope. |
| `t1IntervalMin` | _(absent)_ | `9` | yes | Runtime tier-interval; outside skill's scope. |
| `hasRateLimit` | _(absent)_ | `false` | yes | Runtime flag; outside skill's scope. |
| `dataFlow` | _(absent)_ | object | yes | Operator-documented data-flow doc; Rule B residue. |
| `apiConfig.customSelectors` | _(absent)_ | `{postDate, sourceId, pagination, soldIndicator, productListing, wantedIndicator}` | yes | DB carries runtime-consumed selectors NOT in skill's documented target shape. Skill gap — see harness gaps below. |

---

## Divergent-field summary

**Total divergent (excluding pure absence-because-DB-omits-vs-skill-requires-explicit-null):** 13 fields with real value/shape difference (counting structural differences and label-drift as one each). Pure form-only (null vs absent) differences add ~8 more.

### Critical (runtime-impacting)

1. **`productCountMethod.method`: `pagination-walk` (DB) -> `html-pagination` (R1).** DB's value is not in the switch in `product-count-probe.ts` (canonical switch at lines 149-333 enumerates 11 methods; `pagination-walk` is absent). Runtime behavior: `default: return null` — the count probe is silently disabled for gunpost.ca. R1 produces the canonical name and the probe will work. **This is a real DB bug.**

### Important (semantic, but not breaking)

2. **`platform`: `"drupal"` (DB) -> `"drupal-classifieds"` (R1).** Skill platform table canonicalizes to `drupal-classifieds`. DB has older bare tag. No runtime consequence today because `adapterType` (which IS used in routing) agrees.

3. **`classifiedRules.soldDetection`: `class=ad-sold` (DB) -> `class=field-sold` (R1).** R1 matches the actual `.field-sold` CSS class observed in live HTML; DB has older `class=ad-sold` plus shared `field-sold Yes` literal. DB still detects sold via `field-sold Yes` so this is a redundancy improvement, not a fix-needed gap.

4. **`expectedProductCount`: 30,423 (DB, 2026-04-11) -> 30,225 (R1, 2026-05-15).** Site shrank 198 listings (0.65%) in 34 days. Both correct as-of their probe.

### Form-only / operator-residue / runtime-config

The remaining ~30 divergences are either:
- Skill explicit-null vs DB omission (`captchaType:null`, `ageGate:{...}`, `userAgentOverride:null`, etc. — Rule B per skill)
- Operator audit-trail residue (`notes`, `dataFlow`, `wafWorkaround.steps`, `crawlers.maintain.cooldowns/tierShares/tierWindows` — NOT skill targets per Rule B)
- Runtime tuning fields outside skill scope (`budget`, `timeout`, `t1IntervalMin`, `crawlPhase`, `hasRateLimit`, `siteCategory`, `name`)
- DB-stored operator wanted-detection regex set absent from skill's documented target shape (`wantedDetection`)
- `apiConfig.customSelectors` block — runtime-consumed by the classifieds adapter but not in skill's siteProfile output target

---

## Top 3 most surprising divergences

1. **DB `productCountMethod: "pagination-walk"` is a runtime no-op.** Why surprising: DB was authored 2026-04-11 specifically post-Mistake 37 to document the bare-form-sort + pagination-walk fix. The probe-method label appears to describe HOW the count was DERIVED (the walk), not the runtime switch case the probe SHOULD use. The operator missed that the runtime switch enumerates a closed set. R2 should propose a DB UPDATE to rename `pagination-walk` -> `html-pagination` (single SQL UPDATE to siteProfile.productCountMethod.method). Skill is correct; DB is wrong.

2. **DB has `classifiedRules.wantedDetection` but skill doesn't document it.** Why surprising: this is operator-curated regex critical for classifieds — wanted ads (WTB, WTT, ISO) must be classified differently from for-sale ads. Skill's classifieds-* extras section only documents `soldDetection`. Real gunpost adapter at `backend/src/services/scraper/adapters/classifieds-gunpost.ts` likely consumes this field. R2 should harvest the regex AND update the skill (Stage 3 classifieds-specific output section) to document `wantedDetection` shape.

3. **DB has `apiConfig.customSelectors` block (6 selectors) that the skill does not list as a target field.** Why surprising: these are runtime-consumed CSS selectors (`postDate`, `sourceId`, `pagination`, `soldIndicator`, `productListing`, `wantedIndicator`) that the classifieds-gunpost adapter must use to extract products. Without them the adapter would have to hard-code selectors. Skill Stage 4g produces an extraction sample but doesn't formalize the selectors as a profile output. Skill design gap.

---

## SKILL.md harness gaps observed

1. **No prescriptive output for classifieds-* `wantedDetection` regex set.** Skill Stage 3 classifieds-specific section documents `soldDetection` only. Real gunpost adapter uses both. Skill should add a `wantedDetection: [regex...]` field with same pattern-syntax docs as `soldDetection`.

2. **No prescriptive output for adapter-consumed CSS selectors.** Drupal/classifieds adapters need `apiConfig.customSelectors` block in the profile. Skill's output target list omits it. Stage 4g extracts samples but doesn't promote the matched selectors into a runtime field.

3. **Stage 8 reconciliation does not call out facet-sum vs walk-total drift on classifieds.** Persona Mistake 37 documents this; SKILL.md Stage 4 totalsSumCheck does mention sitemap lag (~25%) but facet-sum drift can be smaller (here ~17%) and skill could prescribe the source-of-truth ordering for classifieds explicitly: live-pagination-walk > facet-sum > sitemap.
