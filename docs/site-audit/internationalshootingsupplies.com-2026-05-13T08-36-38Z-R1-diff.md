# R1 candidate vs DB siteProfile — internationalshootingsupplies.com

R1 candidate: `docs/site-audit/internationalshootingsupplies.com-2026-05-13T08-36-38Z-R1.json`
DB siteProfile snapshot: read 2026-05-13 via `prisma.monitoredSite.findFirst({domain:'internationalshootingsupplies.com'})` — last DB write `lastVerified: 2026-04-12`.

## Field-by-field divergence

| # | Field | R1 candidate | DB siteProfile | One-line WHY |
|---|---|---|---|---|
| 1 | `expectedProductCount` | `2299` | `5111` | R1 cites WC Store API X-WP-Total (customer-visible); DB cites WP/v2 admin REST X-WP-Total (incl drafts/private). DB also stores `expectedInStockCount: 2192`. Two views of the same catalog. |
| 2 | `productCountMethod.endpoint` | `/wp-json/wc/store/v1/products` | `/wp-json/wp/v2/product` | Same root cause as #1 — admin REST vs Store API. Both return `x-wp-total`. |
| 3 | `productCountMethod` shape | bare `{method, endpoint, header}` | adds `wpRestTotal`, `storeApiTotal`, `dateFilterEvidence`, `dateFilterVerified` | DB adds audit-trail residue that SKILL.md Rule B says should NOT be in pre-bootstrap output. |
| 4 | `catalogUrls` count | **12 top-level cats** | **79 leaf cats** | Different strategy. DB chose leaf-only because 2026-04-12 audit concluded "parent pages show subcategory tiles only" — page-1 sample. R1 verified `/product-category/firearms/page/2/` returns "Showing 13-24 of 468 results" with 12 product cards — parent pagination DOES work past page 1. |
| 5 | `catalogUrls` path | absolute URLs | path-only `/product-category/...` | DB stores paths only; R1 stores absolute. Production adapter joins with origin either way. |
| 6 | `sortParam` | `"?orderby=date"` | `"orderby=date"` (no `?`) | Cosmetic. Production URL-builder normalises. |
| 7 | `paginationPattern.template` | `"/page/{N}/"` | `"page/{N}/"` | Cosmetic. URL builder normalises. |
| 8 | `crawlers.catalog` block | not in R1 | DB has `{notes, method: "html-category-walk"}` | DB documents the operator's choice to force HTML-only because WC adapter `fetchCatalogPage` returned 0. R1 confirms WP REST works fine on 2026-05-13 — DB note is stale. |
| 9 | `adapterType` consistency | `"woocommerce"` | column `"woocommerce"` but notes "adapterType changed to generic-retail" | DB is internally inconsistent. R1 stuck with `woocommerce`. |
| 10 | `categoryStructure` block | not in R1 (Rule B) | full block in DB | Operator discovery rationale; R1 puts equivalent info in `topLevelCategories.totalsSumCheck`. |
| 11 | `reauditVerified` block | not in R1 (Rule B) | full block in DB | Pure operator audit-trail residue per SKILL.md Rule B. |
| 12 | `apiStatus` block | not in R1 (Rule B) | full block in DB | Operator audit residue. |
| 13 | `crawlers.watermark.method` | `"api-date-since-watermark"` | `"api-date-since-watermark"` | **Match.** |
| 14 | `crawlers.watermark.reason` | populated | not in DB | DB doesn't carry the reason field for non-`full-catalog-sweep` cases. |
| 15 | `crawlers.bootstrap.apiEndpoints` | populated | not in DB | DB doesn't store bootstrap endpoints separately. |
| 16 | `crawlers.maintain.verifyMethod` | `"store-api"` | not in DB; DB notes "Switched to detail-page verification" after 2,898 wrongful deactivations on 2026-04-03 | **Real divergence.** R1 chose store-api per SKILL.md Stage 3 platform default — would re-trigger the deactivation incident. |
| 17 | `hasWaf` | `false` | `false` | **Match.** |
| 18 | `wafType` | `null` | `null` | **Match.** |
| 19 | `hasCaptcha` | `false` | `false` | **Match.** |
| 20 | `captchaType` | `"recaptcha-v3"` (informational) | not in DB | DB doesn't record CAPTCHA type when `hasCaptcha=false`. |
| 21 | `ageGate` block | populated | not in DB | DB doesn't store `ageGate`. |
| 22 | `perPage` | `12` | `12` | **Match.** |
| 23 | `sortVerified` | `true` | `true` | **Match.** |
| 24 | `platform` | `"woocommerce"` | `"woocommerce"` | **Match.** |
| 25 | `needsPlaywright` | `false` | not in DB | DB silent. R1 explicit. |
| 26 | `extractionSample` | 3 products | not in DB | R1 follows SKILL.md Stage 4g; DB doesn't carry sample. |
| 27 | `wafLastProbedAt` format | `"2026-05-13T08:18:48Z"` ISO datetime | `"2026-04-12"` date-only, 31 days old | Fresh probe vs stale; format differs. |
| 28 | `lastVerified` | `"2026-05-13"` | `"2026-04-12"` | Fresh vs stale. |

**Divergent count:** 28 fields/blocks examined.
- **9 real divergences:** #1, #2, #4, #8, #9, #14, #16, #25, #26.
- **11 cosmetic / format-only:** #3, #5, #6, #7, #10, #11, #12, #15, #20, #21, #27.
- **8 matches:** #13, #17, #18, #19, #22, #23, #24, plus implicit-match `lastVerified` (#28 differs only by recency).

---

## 2-3 most surprising divergences

1. **`expectedProductCount` 2,299 vs 5,111 (2.2x off).** Two valid product counts coexist. WC Store API returns 2,299 (customer-visible). WP/v2 admin REST returns 5,230 today / 5,111 on 2026-04-12 (incl drafts/private). DB chose admin-total; R1 chose customer-total. SKILL.md Stage 8 lists `wp-rest-header` as the canonical method but doesn't specify which endpoint (customer vs admin). Neither is "wrong" — they answer different questions (Tier-1 watermark wants customer-visible; Tier-2 catalog refresh wants admin to catch draft-to-publish flips).

2. **catalogUrls strategy: 12 top-level vs 79 leaf cats.** Both achieve ≥97% HTML coverage from the same `wp/v2/product_cat` data. The DB's 2026-04-12 audit concluded parents "show subcategory tiles only, not child products" — but R1 re-verified `/product-category/firearms/page/2/` today and got 12 product cards with "Showing 13-24 of 468 results". DB's claim is true on page 1, false on page 2+. Trade-off: DB strategy wastes 0 tokens on tile pages but tracks 79 URLs; R1 strategy tracks 12 URLs but burns 1 token per category on page-1 tile fetch.

3. **`crawlers.maintain.verifyMethod` — `store-api` vs DB's documented `detail-page`.** DB notes record a 2026-04-03 incident where Store API verification caused 2,898 wrongful deactivations (false-positive not-founds). The operator then switched to detail-page verification. R1 followed SKILL.md Stage 3's `woocommerce → store-api` default — which would re-trigger the incident. This is the single highest-impact divergence — a blind promote would re-deactivate ~2,900 products.

---

## 1-3 SKILL.md harness gaps

1. **No decision rule for "two count endpoints disagree" on WooCommerce.** Stage 8 says `wp-rest-header` but doesn't say `/wp-json/wp/v2/product` vs `/wp-json/wc/store/v1/products`. On most WC sites these match; on this site they diverge 2.2x. SKILL.md should require both counts to be probed, and either (a) pick a canonical one (and document why), or (b) emit both fields (`expectedProductCount` + `expectedInStockCount` like the DB does) so the downstream tier engine can choose per-phase.

2. **Stage 3 maintain.verifyMethod is hardcoded `woocommerce → store-api` with no escape valve for known-bad-site behavior.** This site experienced 2,898 wrongful deactivations from Store API verification on 2026-04-03 and was switched to detail-page. Re-running pre-bootstrap blindly reverts that operator decision. Fix: (a) on calibration runs, read existing DB `verifyMethod` and preserve it if set, OR (b) add a Stage 3.5 probe that calls Store API verify on N known-existing IDs and flags any false-positive 404s before settling on `store-api`.

3. **Stage 4 has no rule for "parent category shows tiles on page 1 but products on page 2+".** Anti-pattern note says "Don't conclude no catalog URL just because the bare nav link returns a tile page. Try the suffix retry first." But for WC/Astra here, no suffix unlocks page 1 — products only start at page 2. DB audit gave up at page 1 and used 79 leaves; R1 verified page 2+ and used 12 top-level. SKILL.md should describe this branch explicitly so two correct audits produce the same `catalogUrls` strategy instead of diverging by AI-of-the-day choice.
