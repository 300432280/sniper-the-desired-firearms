# Pre-Bootstrap R1 Candidate vs DB siteProfile — gunpost.ca

Comparison of `docs/site-audit/gunpost.ca-2026-05-13T08-27-41Z-R1.json` vs DB `MonitoredSite.siteProfile` (queried 2026-05-13).

Format: each row is `field — candidate — DB — one-line hypothesis`.

---

## Fields that MATCH (no divergence)

| Field | Value |
|---|---|
| `adapterType` (column) | `classifieds-gunpost` |
| `hasWaf` (column) | `true` |
| `hasCaptcha` (column) | `false` |
| `wafType` | `cloudflare-active` |
| `wafProbeMethod` | `heavy-8-batch` |
| `needsPlaywright` | `false` |
| `sortParam` | `?sort_by=date_pub&sort_order=DESC` |
| `perPage` | `18` |
| `paginationPattern.type` | `query` |
| `paginationPattern.template` | `page` |
| `paginationPattern.zeroIndexed` | `true` |
| `paginationPattern.firstPageHasParam` | `false` |
| `crawlers.watermark.method` | `navigate-from-watermark` |
| `crawlers.maintain.verifyMethod` | `detail-page` |
| `catalogUrls` | `["/ads?sort_by=date_pub&sort_order=DESC"]` |
| `classifiedRules.soldDetection` includes | `field-sold Yes`, `SOLD` |

---

## Fields where candidate != DB (divergences)

### 1. `platform`
- **Candidate:** `"drupal-commerce"`
- **DB:** `"drupal"`
- **Hypothesis:** Both are correct but at different specificity. The Generator meta says `Drupal 10 (https://www.drupal.org); Commerce 2` AND `X-Commerce-Core: 2` header — so `drupal-commerce` is the more specific tag, matching the SKILL.md platform-detection table verbatim. DB's `"drupal"` is a coarser legacy tag from an earlier audit (DB `lastVerified: 2026-04-11`); the skill table refresh date is more recent and prefers the multi-marker match.

### 2. `expectedProductCount`
- **Candidate:** `30078` (walk pages 0–1670 x 18 = 30,060; page 1670 has 18 → 30,078)
- **DB:** `30423` (DB notes 1691 total pages: 1690 x 18 + 3 = 30,423)
- **Hypothesis:** DB count is from an earlier walk that observed pagination ending at page 1690 with 3 items on the last page. My walk today saw pager `--last` at `page=1670` with 18 items, plus pages 1671+ returning 3 sticky/featured items. Possible causes: (a) DB count includes the 3-item "sticky overflow" pages (1671, 1672, 1673… x 3 each up to some terminus the DB walked); (b) listing count genuinely shrank from 30,423 to ~30,078 over ~32 days (classifieds churn 1-2%/month); (c) my walk under-walked the overflow tail. Both values within ±1.5%. DB's `pagination-walk` method is more precise; my `html-pagination` runtime probe is a configurable estimator.

### 3. `productCountMethod`
- **Candidate:** `{method:"html-pagination", url:"/ads?sort_by=date_pub&sort_order=DESC", selector:".pager__item--last a", regex:"page=(\\d+)", perPage:18}`
- **DB:** `{method:"pagination-walk", formula:"(1690 * 18) + 3 = 30,423", totalPages:1691, lastPageItems:3}`
- **Hypothesis:** `pagination-walk` is NOT in the runtime `product-count-probe.ts` switch (verified — only 11 canonical methods; this name is undefined there). DB's value is a `_partial`/notes-shaped record describing how a human did the walk, NOT a runtime-probeable spec — at runtime this falls through to `default: return null`. My `html-pagination` IS in the runtime switch. **DB is stale/audit-trail residue; candidate is runtime-correct.**

### 4. `crawlers.maintain.method` / `crawlers.maintain.cooldowns` / `crawlers.maintain.tierShares` / `crawlers.maintain.tierWindows`
- **Candidate:** does not produce these — SKILL.md Rule B excludes operator audit-trail residue / scheduling fields.
- **DB:** `{method:"db-verification", cooldowns:{t2:3,t3:5,t4:9}, tierShares:{...}, tierWindows:{...}, verifyMethod:"detail-page"}`
- **Hypothesis:** DB carries operator-tuned scheduling config layered on top of the pre-bootstrap runtime fields. These are NOT pre-bootstrap outputs per skill design — operator adds them after promotion. Candidate is correct to omit; DB is correct to have them (they were set during a post-onboarding tuning pass).

### 5. `crawlers.bootstrap.apiEndpoints` / `crawlers.bootstrap.method` / `crawlers.bootstrap.htmlFallback`
- **Candidate:** `{apiEndpoints: {}}`
- **DB:** `{method:"single-continuous", apiEndpoints:null, htmlFallback:true}`
- **Hypothesis:** Cosmetic divergence. Candidate's `{}` and DB's `null` mean the same (no API endpoints); DB carries extra operator-set keys (`method`, `htmlFallback`). Per Rule B, these are operator residue not part of the skill's deliverable.

### 6. `searchUrl`
- **Candidate:** omitted
- **DB:** `"/ads?key={keyword}"`
- **Hypothesis:** I missed this — the homepage form `<form action="/ads" method="get">` has `<input name="key">` which I observed in Stage 5's form inspection but did not extract into `searchUrl`. **Candidate has a real gap here.** Skill Stage 3 says "If the site has a keyword-search URL... output `searchUrl`" — I should have done this.

### 7. `name` / `notes` / `budget` / `timeout` / `t1IntervalMin` / `siteCategory` / `crawlPhase` / `hasRateLimit` / `apiConfig.customSelectors` / `dataFlow`
- **Candidate:** omitted
- **DB:** present (operator-set metadata)
- **Hypothesis:** Operator config, not pre-bootstrap output per Rule B. Candidate is correct to omit; DB is correct to have them.

### 8. `wafProbeEvidence` shape
- **Candidate:** structured object `{cfHeaders:[], sucuriHeaders:[], rapidBurstStatus:[], sqliRuleFired:true, xssRuleFired:true, ...}`
- **DB:** free-text string `"server:cloudflare + cf-ray on all responses. ... XSS → 403. Bare /ads → interactive challenge."`
- **Hypothesis:** Both convey the same evidence; candidate uses the structured shape SKILL.md Stage 2 specifies; DB has an older free-text shape from before structured output was standardized.

### 9. `wafLastProbedAt`
- **Candidate:** `"2026-05-13T08:18:12Z"` (ISO timestamp)
- **DB:** `"2026-04-11"` (date-only)
- **Hypothesis:** Same field, fresh probe; DB is 32 days stale. Per Stage 2 SKILL.md: "Don't trust stored `wafType` from prior audits — re-classify every time" — candidate is the fresh probe.

### 10. `wafWorkaround`
- **Candidate:** omitted (Stage 3 says only populate when site emits malformed headers Node-native can't parse — gunpost.ca does not)
- **DB:** `{steps:[...], method:"http-direct", rateLimitNotes:"...", perRequestPlaywright:false}`
- **Hypothesis:** DB uses `wafWorkaround` as a freeform "how to handle this site's WAF" notes block. SKILL.md narrows the field to specifically the curl-spawn fallback case (Celerant). DB's usage is overloaded/operator-residue. Candidate is correct per current schema; DB is older shape.

### 11. `userAgentOverride`
- **Candidate:** `"Mozilla/5.0 (iPhone...) Mobile/15E148 Safari/604.1"`
- **DB:** field absent
- **Hypothesis:** SKILL.md Stage 2 says set iPhone Safari UA when `wafType: 'cloudflare-active'` to help bypass challenges. DB omits — possibly because Cloudflare here doesn't gate the actual catalog URLs (only bare /ads), so the override isn't strictly needed. Candidate is defensively correct per skill; DB judges it unnecessary because the runtime path never hits the bare URL.

### 12. `classifiedRules.soldDetection` differences
- **Candidate:** `["class=field-sold", "field-sold Yes", "SOLD"]`
- **DB:** `["class=sold", "class=ad-sold", "field-sold Yes", "SOLD"]`
- **Hypothesis:** DB has wider coverage with `class=sold` and `class=ad-sold` — defensive patterns for sold-listing detection across Drupal theme variants. My candidate only saw `field-sold` on the one live sample; DB has accumulated more patterns from production. **DB superset is more robust.**

### 13. `classifiedRules.wantedDetection`
- **Candidate:** omitted (not specified in SKILL.md Stage 3 platform-extras for classifieds)
- **DB:** `["^wanted", "wtb$", "wtt$", "iso$", "wanted$", "wanted:"]`
- **Hypothesis:** The adapter (`classifieds-gunpost.ts:isWantedAd()`) already hardcodes these patterns in code. DB stores them redundantly in siteProfile. Either is OK at runtime since the adapter doesn't need them from siteProfile, but DB persistence is informational. Skill is silent on this — candidate omission is per-spec.

### 14. `topLevelCategories` block
- **Candidate:** detailed 15-category breakdown with per-category page counts
- **DB:** field not present
- **Hypothesis:** SKILL.md Stage 4f recommends `topLevelCategories` as operator-reference documentation, even when `catalogUrls` collapses to one URL. DB doesn't carry it — earlier audit didn't produce this informational block. Candidate is correct per current skill.

### 15. `extractionTested` / `extractionSample`
- **Candidate:** `extractionTested: true` + 3-product sample (one is wanted-ad with null price)
- **DB:** field not present
- **Hypothesis:** Stage 4g requires these but DB-version predates that requirement. Candidate is per-spec.

### 16. `wafProbeResult`
- **Candidate:** Full sentence: `"Cloudflare active (rule-selective): bare /ads returns interactive challenge..."`
- **DB:** `"cloudflare-active (rule-selective)"` (terse)
- **Hypothesis:** Both true; candidate is more descriptive per SKILL.md "one-line summary"; DB is more terse. Either valid.

---

## Summary

- **Total fields compared:** ~30
- **Fields where candidate != DB (substantive):** 16 (counting field-presence asymmetry)
- **Substantive disagreements where one is wrong:**
  - `productCountMethod` — **DB has a runtime-undefined method name** (`pagination-walk` not in switch); candidate is runtime-correct
  - `searchUrl` — **candidate missed**, DB has it
  - `classifiedRules.soldDetection` — **DB has wider/better coverage**
  - `expectedProductCount` — small drift (1.1%), DB more precise from full walk
- **Stylistic/scope divergences (Rule B operator residue not in skill output):** 10 (scheduling, notes, apiConfig.customSelectors, etc.)
- **Fresh-probe wins:** `wafLastProbedAt`, `wafProbeEvidence` (structured), `platform` (drupal-commerce vs drupal)

## Top 3 most surprising divergences

1. **`productCountMethod.method`** — DB has `"pagination-walk"` which is **not** a recognized arm in the runtime `product-count-probe.ts` switch (the 11 canonical methods are `wp-rest-header`, `json-api-count`, `json-api-length`, `html-pagination`, `sitemap`, `sitemap-index`, `generic-product-sitemap`, `shopify-products-walk`, `ecwid-storefront-search`, `klevu-api-count`, `stream-page-count`). DB value falls through to `default: return null` at runtime — silent disable. This is a real DB bug.
2. **`searchUrl`** — I missed extracting it from the homepage `<form action="/ads">` with `<input name="key">`. The Stage 3 instruction to derive searchUrl is buried in a conditional ("If the site has a keyword-search URL") and easy to skip when focused on catalog URLs.
3. **`platform` granularity** — `drupal-commerce` vs `drupal`. Both valid; SKILL.md's most-specific-multi-marker rule prefers the former. DB carries an older coarse tag.

## SKILL.md harness gaps noticed

1. **`searchUrl` extraction is buried in Stage 3 platform-extras conditional list.** Easy to miss when focused on catalog discovery. Should be promoted to a top-level checklist item or required-when-detected, since every Drupal/WP/WooCommerce site has a search form and operators want this field populated.
2. **`classifiedRules.soldDetection` discovery instruction is vague** — Stage 3 says "visit 1-2 sold listings". On gunpost.ca I couldn't find a sold-only filter URL during my time-bounded probe and fell back to the in-code adapter's expectation (`field-sold Yes`). The skill should explicitly enumerate platform-known patterns to seed the list (e.g. "for Drupal: include `class=sold`, `class=ad-sold`, `class=field-sold`, `field-sold Yes`, `SOLD`") so the candidate matches what production accumulates over time.
3. **No explicit handling for `productCountMethod` runtime-invalid values.** Stage 8 lists 11 canonical methods, but DB legacy profiles carry non-runtime names like `pagination-walk`. The skill (or the validator) should flag-on-load any productCountMethod.method not in the 11-arm union. Currently a stale or experimental method name silently disables counting.
