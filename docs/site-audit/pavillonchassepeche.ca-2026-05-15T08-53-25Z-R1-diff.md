# R1 Diff — pavillonchassepeche.ca

Candidate: `docs/site-audit/pavillonchassepeche.ca-2026-05-15T08-53-25Z-R1.json`
DB siteProfile read: 2026-05-15

## Divergence table (candidate vs DB; ONE-LINE WHY per row)

| Field | Candidate R1 | DB siteProfile | Why divergent |
|---|---|---|---|
| `MonitoredSite.url` | (not set — implicit apex) | `https://pavillonchassepeche.ca/en/` | DB uses English-localized root via WPML `/en/` prefix; I crawled the French default which is the actual canonical apex; operator chose to crawl the EN tree as the runtime tree. |
| `catalogUrls` | `["/categorie-produit/chasse/","/categorie-produit/liquidation/","/categorie-produit/salines/"]` (3 entries, French slugs) | `["/en/product-category/hunting-en-6/","/en/product-category/liquidation-en/","/en/product-category/fishing/","/en/product-category/clothing/","/en/product-category/outdoors-en-4/","/en/product-category/saltworks/"]` (6 entries, English slugs) | I excluded `fishing/clothing/outdoors` as "not firearm-relevant"; DB keeps them per the project's full-coverage rule. Also I used the FR `/categorie-produit/` path; DB uses EN `/en/product-category/` mirror. Both are valid (WPML serves both URL trees) but the operator picked EN. |
| `expectedProductCount` | 1243 | 1318 | I read WC Store API `x-wp-total` (customer-visible, excludes drafts/hidden) and chose that as canonical. DB chose WP REST `wp/v2/product` total = 1318 (higher because it includes products not customer-visible via Store API). |
| `productCountMethod.endpoint` | `/wp-json/wc/store/v1/products` | `/wp-json/wp/v2/product` (with `wpRestTotal`, `enScopeTotal`, `storeApiTotal`, `rootScopeTotal` extras) | Operator chose admin REST as canonical; I chose customer-visible Store API. DB stores multiple totals as audit-trail residue alongside the method. |
| `productCountMethod` extras | none | `wpRestTotal: 1318, enScopeTotal: 1318, storeApiTotal: 1291, rootScopeTotal: 1311` | Operator stored multiple endpoint counts as evidence; not in skill's discriminated-union shape but harmless. |
| `expectedInStockCount` | (not produced) | 1291 | Operator added a non-skill field tracking in-stock subset. |
| `perPage` | 36 | 100 | I read Elementor archive widget perPage from HTML (36, locked). DB uses WC Store API's max 100 because the runtime crawler hits the API, not HTML. |
| `paginationPattern.perPage` | 36 | (not stored — top-level perPage is 100) | I duplicated the HTML widget perPage into the pattern; operator omitted it. |
| `paginationPattern.firstPageHasParam/startPage/zeroIndexed` | `false/1/false` | (omitted) | Operator stored minimal pattern; I expanded to all schema fields. |
| `crawlers.bootstrap.apiEndpoints` | `{products: "/wp-json/wc/store/v1/products", categories: "/wp-json/wp/v2/product_cat"}` | `{priceEnrichment: "/wp-json/wc/store/v1/products", productDiscovery: "/wp-json/wp/v2/product"}` | Operator uses a 2-step pipeline (WP REST for discovery -> Store API for price enrichment) encoded via different keys. I used generic `products`/`categories` keys per skill template. |
| `crawlers.bootstrap.htmlFallback` | (not set) | `true` | Operator-added runtime hint not in skill template. |
| `crawlers.bootstrap.method` | (not set) | `"single-continuous"` | Operator-added scheduler hint not in skill template. |
| `crawlers.maintain.verifyMethod` | `"store-api"` | `"json-ld"` | I picked Store API per skill mapping table for `woocommerce` platform. DB uses `"json-ld"` (detail-page JSON-LD scraping) — meaning Store API verify probably failed at scale or operator chose detail-page. |
| `crawlers.maintain.verifyEndpoint` | `/wp-json/wc/store/v1/products` | (omitted) | Follows from verifyMethod difference. |
| `crawlers.maintain.method` | (not set) | `"db-verification"` | Operator-added scheduler hint. |
| `crawlers.maintain.cooldowns/tierShares/tierWindows` | (not set) | populated | Operator-added scheduler runtime config not in skill template. |
| `dataFlow.steps` | (not set) | 2-step pipeline encoded | Operator-added documentation block not in skill template. |
| `multilingual` | (not set) | `"wpml"` | Operator-added field not in skill template (skill should record this). |
| `siteCategory` | (not set) | `"retailer"` | Operator-added field not in skill template. |
| `crawlPhase` | (not set) | `"bootstrap"` | Operator-added runtime state field. |
| `budget` | (not set) | 60 | Operator-set per-site token budget. |
| `timeout` | (not set) | 15000 | Operator-set HTTP timeout override. |
| `t1IntervalMin` | (not set) | 17 | Operator-set crawl interval. |
| `hasRateLimit` | (not set) | `false` | Operator-added flag. |
| `searchUrl` | (not set) | `"/?s={keyword}&post_type=product"` | Skill says optional + WordPress default; I omitted because no live testing of search URL was done. |
| `wafLastProbedAt` | `2026-05-15T08:46:48Z` | `2026-04-12` | Fresh probe vs stale stored value. Skill rule: always re-derive — my fresh value is correct. |
| `lastVerified` | `2026-05-15` | `2026-04-12` | Same. |
| `name` | (not set) | `"Pavillon Chasse Peche"` | Operator metadata. |
| `sortVerifiedAt` | (not set) | `2026-04-12` | Operator timestamp. |
| `notes` | (not set) | Long operator-authored history string | Operator audit-trail residue (skill Rule B says don't produce). |
| `extractionSample` | 3 products with title/price/stock | (not set) | Skill Stage 4g produced this; operator doesn't store it. |
| `auditNotes` | runId, probeIp, fieldConfidence, deviations | (not set) | Skill produces this; operator doesn't store it. |

## Divergent field count

**~28 divergent fields/shapes** (skill-mandated audit-trail blocks the DB doesn't store + operator-added runtime config the skill doesn't produce).

Substantive (non-residue) divergences: ~8 — catalogUrls (3), expectedProductCount, productCountMethod endpoint, perPage, maintain.verifyMethod, bootstrap.apiEndpoints keys, URL tree (FR vs EN).

## Most surprising divergences

1. **`crawlers.maintain.verifyMethod = "json-ld"` (DB) vs `"store-api"` (skill says WC -> store-api)** — The skill's Stage 3 mapping table hardcodes `woocommerce -> store-api -> /wp-json/wc/store/v1/products`, but the operator picked `json-ld` (detail-page scraping). This means either (a) Store API verify fails at scale on this site so the operator downgraded, or (b) the skill's mapping table is overconfident.

2. **DB stores the `/en/` URL tree as canonical with 6 catalogUrls** — including `fishing/clothing/outdoors` which I excluded as "not firearm-relevant." The project's actual rule (per CLAUDE.md "Full Product Coverage") is: NEVER drop categories. The skill's Rule C ("Scope — firearm-relevant") contradicts the project's full-coverage rule on retail sites with mixed inventory.

3. **WPML multilingual entirely missed** — The skill has no stage for detecting WPML / multilingual sites. The operator chose the EN tree as the canonical crawl path. The skill should detect WPML/Polylang/Weglot in Stage 3 and either (a) emit `multilingual: "wpml"` + pick one tree, or (b) record both trees and dedup product URLs by post ID via REST. Currently the skill silently picks whichever tree the canonical homepage serves.

## SKILL.md harness gaps

1. **No multilingual / WPML handling.** Bilingual WP sites expose products under two URL trees. Walking both double-counts. The skill should detect WPML via `<meta name="generator" content="WPML...">` in Stage 3 and either emit a `multilingual: "wpml"` field plus pick one tree, or record both and dedup product URLs by post ID. Currently the skill silently picks whichever tree the canonical homepage redirects to (here: the FR default), while production picked EN.

2. **`crawlers.maintain.verifyMethod` is hardcoded in Stage 3 mapping, not verified.** For WooCommerce the skill says "use store-api always", but the DB on this site uses `json-ld`. The skill should add a maintain-method probe: GET 1 product detail page, check for `<script type="application/ld+json">` Product schema. If both Store API and JSON-LD work, prefer Store API; if only JSON-LD works, fall back. Don't hardcode.

3. **Firearm-relevance filter contradicts the project's "Full Product Coverage" rule.** The skill's Rule C lets the AI drop categories by scope-filter (fishing, apparel, plein-air). CLAUDE.md and `feedback_full_coverage.md` say NEVER drop categories. The skill should remove the firearm-relevance filter on retail sites and document all top-level categories in `catalogUrls`, leaving scope filtering to runtime keyword matching.
