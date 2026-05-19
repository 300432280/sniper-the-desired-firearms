# R1 Diff — candidate (blind skill run) vs DB siteProfile

**Candidate**: `docs/site-audit/internationalshootingsupplies.com-2026-05-15T09-05-23-928Z-R1.json`
**DB siteProfile**: `MonitoredSite{domain='internationalshootingsupplies.com'}` (lastVerified 2026-04-12)
**Date of diff**: 2026-05-15

## Summary

| Status | Count | Notes |
|---|---|---|
| Identical | 11 | core access + identity fields agree |
| Divergent | 7 | mostly count semantics + one DB-side override |
| Candidate-only | 2 | `topLevelCategories.categories[]`, `auditNotes` (operator scratch) |
| DB-only | 4+ | `crawlers.catalog`, `apiStatus`, `reauditVerified`, `categoryStructure`, `expectedInStockCount` (DB has richer audit-trail residue per SKILL Rule B; candidate intentionally omits) |

## Identical (sanity check)

| field | value |
|---|---|
| `platform` | `"woocommerce"` |
| `adapterType` | `"woocommerce"` |
| `hasWaf` | `false` |
| `wafType` | `null` |
| `hasCaptcha` | `false` |
| `wafProbeMethod` | `"heavy-8-batch"` |
| `sortParam` | `"orderby=date"` (DB) vs `"?orderby=date"` (candidate) — leading `?` only |
| `sortVerified` | `true` |
| `perPage` | `12` |
| `paginationPattern.type` | `"path"` |
| `crawlers.watermark.method` | `"api-date-since-watermark"` |

## Divergent fields (one-line WHY each)

| # | field | candidate (R1) | DB | WHY divergent |
|---|---|---|---|---|
| D1 | `expectedProductCount` | `2314` | `5111` | Candidate used WC Store API customer-visible total (priority 1 per SKILL); DB used WP REST admin total (full inventory incl. drafts/non-public). Both methods are valid `wp-rest-header`, different endpoint. DB's choice (5111) is the count the watermark crawler actually walks against. |
| D2 | `productCountMethod.endpoint` | `/wp-json/wc/store/v1/products` | `/wp-json/wp/v2/product` | Same root cause as D1 — DB targets the WP admin REST endpoint that the watermark filter uses. |
| D3 | `catalogUrls` count | 77 | 79 | DB includes `/product-category/bows/crossbows/` (count=1) AND `/product-category/uncategorized/` (count=1). Candidate dropped `uncategorized` defensively (residue) and missed `bows/crossbows` because my leaf-filter excluded all `bows` children based on top-level `bows` having `count=0` — but the leaf itself has 1 product. Bug in Stage 4 leaf-selection logic. |
| D4 | `paginationPattern.template` | `"/page/{N}/"` | `"page/{N}/"` | Format quibble — DB stores without leading slash, candidate stores with. Same semantics, cosmetic. |
| D5 | `crawlers.catalog.method` | (absent — candidate omits by design) | `"html-category-walk"` | DB has a custom hint forcing the html-walk path (and a note `adapterType changed to generic-retail to force HTML crawl path`). But `adapterType` in DB is still `woocommerce` — contradictory. Looks like a half-applied operator override from a 2026-04-03 incident. Candidate intentionally does NOT carry this. |
| D6 | `wafProbeResult` wording | "No CDN WAF; BulletProof Security plugin blocks SQLi/XSS payloads at app layer; ..." | "no-waf (nginx origin, no proxy WAF)" | Same verdict; candidate text mentions BPS, DB's short version omits it (full BPS detail lives in DB's `notes` field). |
| D7 | `productCountMethod.method` extras | candidate uses canonical `wp-rest-header` shape exactly | DB bolts on `wpRestTotal`, `storeApiTotal`, `dateFilterEvidence`, `dateFilterVerified` (audit-trail residue) | Per SKILL Rule B, those are residue (operator audit-trail), not runtime fields. Candidate correctly omits. |

## Candidate-only fields

| field | reason |
|---|---|
| `topLevelCategories.categories[]` with per-cat counts | Operator-curated documentation per SKILL Stage 4f; DB has bare-slug equivalent in `categoryStructure.topLevelFunctional` without counts. |
| `auditNotes.runId` / `fieldConfidence` / `probeIp` / `extractionSample` | Stage 9 metadata; DB has no such block (DB stores `reauditVerified` audit-trail as the operator-promotion equivalent). |
| `wafProbeEvidence` structured (cfHeaders/sucuriHeaders/etc.) | SKILL Stage 2 prescribed shape; DB has `wafProbeEvidence` as a free-form string. |

## DB-only fields (Rule B residue, candidate intentionally omits)

| field | what it is | should candidate include? |
|---|---|---|
| `crawlers.catalog.method: "html-category-walk"` + override note | Operator override forcing HTML walk over API | No — runtime path is determined by `adapterType`. Residue from a 2026-04-03 firefight. |
| `apiStatus.*` (wcRestV3 / wpRestV2 / wcStoreV1 / dateFilter) | Free-form API smoke-test record | No — point-in-time probe results, not runtime fields. |
| `reauditVerified.*` block | Operator audit-trail dump with 5-category sort verification list | No — Rule B audit residue. |
| `categoryStructure.*` block | Operator-curated taxonomy documentation | Partially covered by candidate's `topLevelCategories`. |
| `expectedInStockCount: 2192` | DB-side denormalised in-stock count snapshot | No — runtime probes this; would also drift. |
| `wpRestTotal`, `storeApiTotal`, `dateFilterEvidence`, `sortVerifiedDate`, `productCountDate`, `wafLastProbedAt` (string date not ISO) | Audit-trail dates and parallel counts | No — Rule B. |
| `notes` mentioning BPS UA-rotation requirement | Important: BPS blocks bare curl UA — production http-client must rotate UAs | Candidate should capture in `auditNotes` if Stage 2 detects BPS UA selectivity. My probe used `Mozilla/5.0` which passed; bare `curl/X.Y` would have been 403. I did NOT test bare curl UA in Stage 2. |

## Most surprising divergences (top 3)

1. **`expectedProductCount` 2,314 vs 5,111**: candidate went with WC Store API (priority 1, customer-visible), DB has WP admin REST (full inventory). Both are valid `wp-rest-header` outputs — SKILL doesn't tell me which to prefer when a WC site has BOTH endpoints answering. The watermark crawler walks the WP admin REST endpoint, so DB's choice aligns with watermark semantics. Skill needs a tie-break for WC.
2. **Missed `/product-category/bows/crossbows/`** (count=1): my Stage 4 leaf-selection accidentally chained on a non-zero top-level count, dropping all 3 bows descendants because the `bows` top-level cat returned `count=0`. SKILL Rule C forbids dropping by parent name/count — I introduced exactly that. Candidate is missing one real product URL.
3. **DB carries a stale `crawlers.catalog.method: "html-category-walk"` override that contradicts the listed `adapterType: "woocommerce"`**: the DB profile is internally inconsistent (the catalog override exists but `adapterType` wasn't switched to `generic-retail`). Candidate doesn't replicate this. Healthy that a blind run produces a cleaner profile than the operator-edited one.

## SKILL.md harness gaps (3)

1. **No tie-break for WC count when WP REST admin and WC Store API both honor `x-wp-total`.** Priority order says #1 = `wp-rest-header`, but on WC sites both `/wp/v2/product` and `/wc/store/v1/products` are wp-rest-header endpoints with different scopes (2,314 customer-visible vs 5,111 full inventory). Operationally, the watermark crawler queries the WP REST admin endpoint, so the count should match that endpoint to avoid false "X products missing" alerts. Add to Stage 8: "For WooCommerce, if BOTH endpoints return values and they disagree by >2x, prefer the WP admin REST total (`/wp-json/wp/v2/product`) because it matches the watermark crawler's query scope. Optionally document customer-visible count as `auditNotes.expectedInStockCount`."
2. **Leaf-selection must be unconditional on parent count.** SKILL Rule C says "never drop a category by parent name or size", but my Stage 4 accidentally chained on `top-level actualCount>0` which excluded `/bows/crossbows/`. Add to Stage 4 anti-patterns: "A leaf's eligibility depends ONLY on its OWN `actualCount>0`, never on its parent's count. A leaf under an otherwise-empty top-level cat is still a real catalog URL — `bows/crossbows` (1 product) is the canonical case."
3. **No BPS / Wordfence / MalCare UA-selectivity probe in Stage 2.** BulletProof Security blocks bare `curl/X.Y` UA but lets browser UAs through. The heavy probe always uses `-A` with a fake UA, so it never observes this. A real catalog crawler using the production http-client (which rotates UAs) is fine — but a `node-fetch` default would 403. Add to Stage 2: "If BPS / Wordfence / MalCare plugin markers are detected in any 403 body, run ONE extra probe with bare `curl` (no `-A` override) on `/`. If it returns 403 where Chrome-UA returned 200, set `auditNotes.requiresBrowserUa: true` so runtime crawlers using raw HTTP defaults know to override the UA."
