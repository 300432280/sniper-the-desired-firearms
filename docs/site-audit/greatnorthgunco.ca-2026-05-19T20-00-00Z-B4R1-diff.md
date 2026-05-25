# B4R1 Diff — greatnorthgunco.ca

Candidate: `docs/site-audit/greatnorthgunco.ca-2026-05-19T20-00-00Z-B4R1.json`
DB snapshot: `_audit_tmp/batch4-2026-05-19/greatnorthgunco.ca-DB-snapshot.json` (`lastVerified: 2026-04-07`, ~42 days stale)

## Divergence summary

| Field | Candidate (R1) | DB | Why |
|---|---|---|---|
| `platform` | `woocommerce` | `woocommerce` | match |
| `adapterType` | `woocommerce` | `woocommerce` (column) / `adapter: woocommerce` (profile) | match |
| `hasWaf` | `false` | `false` | match |
| `wafType` | `null` | `"none"` | DB uses string "none"; skill canonical is `null`. Cosmetic; production crawler routes on `hasWaf` only. R1 hypothesis: DB has legacy string before skill normalized to `null`. |
| `hasCaptcha` | `false` | `false` | match |
| `ageGate.detected` | `false` | (absent) | DB never recorded ageGate object; site has none, absence is harmless. |
| `needsPlaywright` | `false` | `false` | match |
| `userAgentOverride` | `null` | (absent) | DB never recorded; null = default UA at runtime, same outcome. |
| `expectedProductCount` | **4299** | **4201** | DB stale 42 days; site has grown by 98 products since 2026-04-07. Both numbers came from WP REST `x-wp-total` on `/wp-json/wp/v2/product` at their respective times. Hypothesis: catalog drift over 6 weeks. |
| `productCountMethod` | `{method:"wp-rest-header", endpoint:"/wp-json/wp/v2/product", header:"x-wp-total"}` | identical | match |
| `catalogUrls` | 15 absolute URLs (all WC categories) | **14 path URLs** (`/shop/` + 12 cats + typo `/accessoriesparts/`) | Three real divergences: (a) DB includes `/shop/` AGGREGATOR which Rule C excludes when per-category covers same union; (b) DB has typo `/accessoriesparts/` (no hyphen) which does NOT match WP taxonomy (id=2195 slug is `accessories-parts`); (c) DB MISSING three small categories from R1: `uncategorized` (16 visible/473 WP REST), `several-available-surplus` (3/15), `several-available` (1/13). DB URLs are path-only; R1 uses absolute. |
| `paginationPattern.type` | `path` | `path` | match |
| `paginationPattern.template` | `/page/{N}/` | `/page/{N}` (no trailing slash) | Format drift. Skill mandates leading `/` (both comply). Trailing slash is theme-dependent — WP permalink pretty-mode redirects between them. R1 included it to match Yoast canonical form. |
| `paginationPattern.perPage` | 24 | 24 | match |
| `perPage` | 24 | 24 | match |
| `sortParam` | `?orderby=date` | `?orderby=date` | match |
| `sortVerified` | `true` | (absent from DB profile) | DB never recorded the verified flag; sort was claimed working in notes but no field. Hypothesis: legacy profile pre-dates `sortVerified` field. |
| `crawlers.watermark.method` | `api-date-since-watermark` | `api-date-since-watermark` | match |
| `crawlers.watermark.reason` | populated | (absent) | R1 always emits reason; DB legacy omits it. |
| `crawlers.maintain.verifyMethod` | `store-api` | **`detail-page`** | **Operationally significant.** DB notes: "2026-04-03: 3691 products wrongly deactivated by Store API verify (not-found false positives). Reactivated. Switched to detail-page verification." R1 defaulted to `store-api` per skill WC table mapping. R1 surfaced the tradeoff in `auditNotes.verifyMethodPolicy` but missed the operator's site-specific override. Hypothesis: skill's "anything WC -> store-api" default is too aggressive; for this site the 3778-product gap (4299 WP REST vs 521 Store API) is exactly the catalog_visibility=hidden archive causing false-deactivation cascades. |
| `crawlers.maintain.verifyEndpoint` | `/wp-json/wc/store/v1/products` | (absent on detail-page) | Consistent with DB's detail-page choice (endpoint not needed). |
| `crawlers.bootstrap.apiEndpoints` | NOT emitted (per skill) | `{priceEnrichment, productDiscovery}` | Skill explicitly says do NOT emit `crawlers.bootstrap` block (zero runtime consumers); DB is legacy. R1 followed the skill. |
| `searchUrl` | not emitted | `/?s={keyword}&post_type=product` | R1 missed this. The site does have a WP-style search URL; should have probed. |
| `name` | not emitted | `"Great North Gun Co."` | Not a runtime field per skill; lives on MonitoredSite row, not siteProfile. |
| `budget`, `timeout`, `t1IntervalMin`, `hasRateLimit`, `dataFlow`, `tierShares`, `tierWindows`, `cooldowns` | not emitted | populated | Operator/runtime config, not skill output targets. Skill correctly excludes. |
| `topLevelCategories` | populated (15 entries with allOption + wpRestCount + totalsSumCheck) | not present | R1 emits richer documentation than DB. |
| `extractionTested`, `extractionSample` | populated | not present | R1 adds spot-check evidence. |
| `wafProbeEvidence`, `wafProbeMethod`, `wafLastProbedAt`, `wafProbeResult` | populated | not present | R1 records WAF probe trail; DB stripped after operator review. |

## Top 3 surprising divergences (with WHY)

1. **`verifyMethod: store-api` (R1) vs `detail-page` (DB)** — R1 followed the skill table verbatim ("WC -> store-api"). DB's note shows the site had a 3691-product false-deactivation incident in 2026-04-03 caused by Store API "not-found" responses for catalog_visibility=hidden products. The skill's `auditNotes.verifyMethodPolicy` mechanism (which I did populate) is the correct mitigation but insufficient — the skill needs a site-class signal that "WC site with large catalog_visibility=hidden archive => detail-page mandatory". I observed the 3778-product gap (4299 WP REST vs 521 Store API) explicitly in `catalogVsWatermarkDivergence` but failed to connect that gap to verifyMethod risk. WHY: skill default biases toward the fast path; the per-site override path exists only as policy text in auditNotes, not as a field value.

2. **R1 catalogUrls = 15 absolute URLs vs DB = 14 path URLs including `/shop/` and a typo** — The DB has `/shop/` (aggregator, redundant with the union of per-category) AND a typo `/product-category/accessoriesparts/` (no hyphen) that does NOT match WP's actual slug `accessories-parts`. DB is also missing `uncategorized`, `several-available-surplus`, `several-available` — three small but real categories. WHY: DB was hand-curated in 2026-04-07; the typo is a manual-entry error; the missing categories are likely "operator deemed too small" violations of skill Mistake 12 (don't drop categories for being too small). R1 derived from live taxonomy API and is more complete and correct.

3. **`expectedProductCount: 4299 (R1) vs 4201 (DB)`** — both methods identical (WP REST core x-wp-total). The 98-product gap is pure staleness over 42 days. WHY: not a methodology divergence — expected outcome of `lastVerified: 2026-04-07`. Reinforces skill rule "always re-derive count, never trust stored value."

## Divergence count

- Substantive (operator/runtime impact): **3** (verifyMethod, catalogUrls coverage+typo+aggregator, searchUrl missing from R1)
- Cosmetic/format drift: **5** (wafType `null` vs `"none"`, template trailing slash, sortVerified field absence on DB, expectedProductCount staleness, multiple R1-only fields absent on DB)
- Match exact: **12 fields**

## Blockers

None — candidate is validator-shape-clean per skill. Operator review for R2 should consider:
- (a) **verifyMethod policy override** — DB's `detail-page` decision is correct for this site (3778-product hidden-archive). Skill needs site-class signal to downgrade store-api default automatically.
- (b) **searchUrl gap** — R1 should have probed `/?s=foo&post_type=product` and emitted; minor miss.
- (c) **DB catalogUrls cleanup** — typo + aggregator + missing-small-cats are real DB defects that R1 corrects.
