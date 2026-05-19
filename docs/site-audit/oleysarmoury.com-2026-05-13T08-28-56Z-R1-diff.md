# R1 Diff — oleysarmoury.com candidate vs DB siteProfile

**Candidate:** `docs/site-audit/oleysarmoury.com-2026-05-13T08-28-56Z-R1.json` (blind R1 run, 2026-05-13)
**DB siteProfile:** `MonitoredSite.siteProfile` where `domain='oleysarmoury.com'` (lastVerified=2026-04-12)

Top-line: candidate validator score 100/100. DB has fields the skill does not produce (runtime tier knobs, cooldowns, GraphQL alternative). Diff focuses on fields the skill IS responsible for.

| Field | Candidate (R1) | DB siteProfile | Divergent? | One-line WHY |
|---|---|---|---|---|
| `platform` | `"bigcommerce-stencil"` | `"bigcommerce-stencil"` | no | |
| `adapterType` | `"generic-retail"` | `"generic-retail"` | no | |
| `hasWaf` (DB column) | `false` | **`true`** | **YES** | DB column `hasWaf=true` contradicts the DB's own `siteProfile.wafType="cloudflare-passive"` — DB is internally inconsistent; skill operational rule (cloudflare-passive => false) is correct. Stale defensive promotion. |
| `hasCaptcha` (DB column) | `false` | `false` | no | |
| `wafType` | `"cloudflare-passive"` | `"cloudflare-passive"` | no | |
| `needsPlaywright` | `false` | `false` | no | |
| `ageGate.detected` | `false` | (not in DB) | minor | DB has no `ageGate` field; candidate adds the structured block per Stage 3. |
| `expectedProductCount` | **3,482** | **3,368** | **YES** | DB probed 2026-04-12 (~30d ago); site grew ~3.4%/114 products. Both came from products sitemap; candidate is fresh truth. |
| `productCountMethod.method` | `"sitemap"` | `"bc-xmlsitemap"` | **YES (label drift)** | `"bc-xmlsitemap"` is not in runtime `product-count-probe.ts` switch — falls through to `default: return null`, silently disabling probe. Per skill label-drift table: `bc-xmlsitemap -> {method:"sitemap", url:"..."}`. DB has bug. |
| `productCountMethod.url`/`endpoint` | `url: ".../xmlsitemap.php?type=products&page=1"` | `endpoint: "/xmlsitemap.php?type=products&page=1"` | minor (field-name drift) | Skill uses `url`; DB uses `endpoint`. Runtime reads `cfg.url` for `sitemap` — DB's `endpoint` ignored. |
| `catalogUrls` (count) | **18** | **13** | **YES** | Candidate keeps 5 categories DB drops (`/clearance/`, `/consignment/`, 4 empty listing pages). DB notes: "Excluded overlapping categories: clearance, consignment, parts-guns-as-is, firestick." |
| `catalogUrls` — `/clearance/` | included | **excluded** | **YES** | Walk-test: `/clearance/` contributes **21 unique products** not reachable from other top-level URLs => Rule C says DO NOT drop. DB violates Rule C. |
| `catalogUrls` — `/swag/` | **excluded** | included | **YES** | Candidate excludes per Rule C scope ("pure apparel — exclude"). DB includes 64 swag products. Each interpretation defensible; strict Rule C favors candidate. |
| `catalogUrls` — `/consignment/` | included | excluded | **YES** | DB drops as "overlapping" but candidate's walk found 2 unique products. Rule C: never drop for being too small. |
| `catalogUrls` — empty (0-product) listing categories | 4 kept | none kept | **YES** | Rule C: "A category that returns 200 with 0 products today is empty, not dead — keep it." DB drops them. Judgement; candidate strict-Rule-C-compliant. |
| `perPage` | 100 | 100 | no | |
| `paginationPattern.type` | `"query"` | `"query"` | no | |
| `paginationPattern.template` | `"page"` | `"page"` | no | |
| `paginationPattern.firstPageHasParam` | `false` | `false` | no | |
| `paginationPattern.perPage` | 100 | (not stored on paginationPattern) | minor | DB stores `perPage` top-level only; candidate stores in both per skill template. |
| `paginationPattern.startPage` / `zeroIndexed` | `1` / `false` | (not stored) | minor | Candidate completes the discriminated-union shape; DB partial. |
| `sortParam` | `"?sort=newest"` | `"?sort=newest"` | no | |
| `sortVerified` | `true` | `true` | no | |
| `crawlers.watermark.method` | `"navigate-from-watermark"` | `"navigate-from-watermark"` | no | |
| `crawlers.bootstrap.apiEndpoints` | `{}` | `null` (with `htmlFallback: true`) | minor | DB custom-shapes with `htmlFallback`; candidate stays canonical-empty. |
| `crawlers.bootstrap` — `apiAlternative.bigcommerce-graphql` block | **absent** | present (`bigcommerce-graphql` JWT scrape, 1h cache, scrape URL `/firearms/`) | **YES** | Skill never directs AI to probe for a BC GraphQL JWT in catalog-page HTML. DB has a working GraphQL primary path the skill missed. **SKILL HARNESS GAP.** |
| `crawlers.maintain.verifyMethod` | `"detail-page"` | `"detail-page"` | no | |
| `crawlers.maintain.verifyEndpoint` | `null` | (not stored explicitly) | no | |
| `wafProbeMethod` | `"heavy-8-batch"` | `"heavy-8-batch"` | no | |
| `wafLastProbedAt` | `"2026-05-13T08:19:34Z"` | `"2026-04-12"` | minor | Candidate uses full ISO timestamp; DB uses date. Both parse. |
| `lastVerified` | `"2026-05-13"` | `"2026-04-12"` | no (R1 is fresh) | |
| `searchUrl` | **omitted** | `"/search.php?search_query={keyword}"` | **YES** | Skill Stage 3 mentions `searchUrl` only conditionally; no explicit probe. BC pattern is deterministic but candidate didn't emit. **MINOR SKILL HARNESS GAP.** |
| `bcStoreId` / `storeHash` | **omitted** | `1000335807` / `"s-6j8taxjw04"` | **YES** | Candidate's skill shape lacks BC-specific store identifiers (analogous to `ecwidStoreId` for Ecwid). Both come for free from headers/CDN URLs. **SKILL HARNESS GAP.** |
| `categoryStats` (per-cat page/product counts) | in `topLevelCategories.categories[].allOption` | richer `categoryStats` map | minor | Different shape, same intent. |
| `t1IntervalMin`, `budget`, `timeout`, tier knobs | **omitted** (correctly) | present | no | Runtime knobs added at promotion; not skill output. |

## Divergent field count

**12 divergent items** (8 substantive, 4 minor label/shape).

## 2-3 most surprising divergences

1. **DB has a working `apiAlternative.bigcommerce-graphql` JWT-scrape from `/firearms/`** — candidate has no equivalent. Skill never tells AI to probe BC catalog-page HTML for a scrapable GraphQL JWT (only homepage). DB notes: "GraphQL Storefront API available — JWT token scraped from HTML (same pattern as prophetriver.com)." Real working primary path the skill missed.
2. **DB column `hasWaf: true` contradicts its own JSON `wafType: "cloudflare-passive"`.** DB enabled WAF handling for a cloudflare-passive site, which the skill's operational rule explicitly says NOT to do (slows perPage to 20 in `catalog-crawler.ts` for no reason). Skill correctness > DB content.
3. **DB excludes `/clearance/`, `/consignment/`; candidate keeps them. DB keeps `/swag/`; candidate drops.** Walk-test proves `/clearance/` adds 21 unique, `/consignment/` adds 2 — both REQUIRED for 100% coverage per Rule C. DB violates Rule C ("don't drop without walk-proof"). `/swag/` inverse: DB keeps apparel; Rule C excludes pure apparel. Each side made one Rule-C error.

## 1-3 SKILL.md harness gaps

1. **No BC-specific platform-extras output.** Stage 3 covers `ecwidStoreId` for Ecwid and `wafWorkaround`/`productUrlSchemes` for Celerant, but BC sites should output `bcStoreId` + `storeHash` — both come free from `x-bc-store-id` header + `cdn11.bigcommerce.com/<storeHash>` CDN references and are used by the runtime adapter. Add a BC-conditional output block in Stage 3 (parallel to the Ecwid one).
2. **No mention of `bigcommerce-graphql` JWT-scrape alternative API.** DB notes a working pattern (`apiAlternative.type: "bigcommerce-graphql"`, tokenScrapeUrl = a catalog page, 1h cache); see `generic-retail.ts:343-923`. Skill should add a Stage 3 BC conditional: if `platform = bigcommerce-stencil`, fetch one catalogUrl and grep for `BCData.graphql_token` / `graphql_storefront`; if found, emit `apiAlternative: {type:"bigcommerce-graphql", graphqlUrl:"/graphql", tokenScrapeUrl:"<catalog>", tokenCacheTtlMs:3600000}`. Makes bootstrap primary GraphQL with HTML fallback instead of pure HTML.
3. **No explicit `searchUrl` discovery step.** Stage 3's `searchUrl` paragraph is easily missed (a buried conditional). There's no instruction to try the site's search box. For BC stores the pattern is deterministic (`/search.php?search_query={keyword}`); the skill should platform-specialize this the same way it specializes `verifyMethod` per platform — e.g. table-row "bigcommerce-stencil -> `/search.php?search_query={keyword}`".
