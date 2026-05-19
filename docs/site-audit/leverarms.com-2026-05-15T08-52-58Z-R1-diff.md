# R1 Blind Skill Diff — leverarms.com (2026-05-15T08-52-58Z)

Candidate: `docs/site-audit/leverarms.com-2026-05-15T08-52-58Z-R1.json`
DB siteProfile read via Prisma `monitoredSite.findFirst({where:{domain:'leverarms.com'}})`.

Prior R1 from 2026-05-13 exists on disk (separate timestamp, separate run); this 2026-05-15 R1 is the current session's blind run.

## Top-line agreements (no divergence)
- `platform`: `woocommerce` (match)
- `adapterType`: `woocommerce` (match)
- `wafType`: `cloudflare-passive` (match)
- `wafProbeMethod`: `heavy-8-batch` (match)
- `hasCaptcha`: `false` (match)
- `needsPlaywright`: `false` (match)
- `sortParam`: `?orderby=date` (match)
- `sortVerified`: `true` (match)
- `crawlers.maintain.verifyMethod`: `store-api` (match)
- `crawlers.maintain.verifyEndpoint`: `/wp-json/wc/store/v1/products` (match)
- `crawlers.watermark.method`: `api-date-since-watermark` (match)
- `paginationPattern.type`: `path` (match)

## Divergent fields (11 distinct)

| # | Field | Candidate (R1) | DB siteProfile | Why divergent |
|---|---|---|---|---|
| 1 | `hasWaf` | `false` | `true` | Skill Stage 2 says cf-passive with all-200 = `false`; DB column carries pre-pivot defensive `true`. Crawl paths return 200 cleanly; origin nginx blocks payload patterns only. |
| 2 | `catalogUrls` count | 4 URLs | 6 URLs | Walk-and-dedup proved `all-surplus` (106) + `food` (11) are 100% redundant; DB keeps all 6 (belt-and-braces / pre-rigorous-dedup audit). |
| 3 | `expectedProductCount` | `357` | `965` | DB uses admin `/wp-json/wp/v2/product` (includes drafts/private/hidden); R1 uses WC Store API customer-visible. DB also stores `expectedInStockCount:357` as a separate field not in skill output target. |
| 4 | `productCountMethod.endpoint` | `/wp-json/wc/store/v1/products` | `/wp-json/wp/v2/product` | Direct consequence of #3 — different endpoints, different totals. Same `method:wp-rest-header`. |
| 5 | `perPage` | `100` | `16` | Skill ships max-verifiable WC Store API per_page=100; DB ships HTML category-page floor 16 (site PHP loop hardcoded). |
| 6 | `paginationPattern.template` | `/page/{N}/` | `page/{N}/` | Cosmetic leading slash. Skill outputs absolute, DB stores relative. |
| 7 | `paginationPattern.perPage` (inside pattern) | `16` | (absent) | Skill nests perPage inside paginationPattern; DB only uses top-level. |
| 8 | `crawlers.bootstrap.apiEndpoints` shape | Single flat `{wcStoreProducts, wpRestProducts, productCategories}` block | 2-step `{productDiscovery:/wp-json/wp/v2/product, priceEnrichment:/wp-json/wc/store/v1/products}` + `htmlFallback:true`, `method:"single-continuous"`, plus separate `dataFlow` block | DB encodes operational WC 2-step (discover via WP REST for IDs+title+thumb, enrich via WC Store API for price+stock). Skill output target shows generic apiEndpoints map; no WC 2-step guidance. |
| 9 | `searchUrl` | (omitted) | `/?s={keyword}&post_type=product` | DB stores user-search URL; skill says searchUrl optional but didn't probe. |
| 10 | Runtime tuning fields | (omitted) | `t1IntervalMin:17`, `budget:60`, `timeout:30000`, `siteCategory:"retailer"`, `crawlPhase:"maintain"`, `hasRateLimit:false`, `crawlers.maintain.{cooldowns,tierShares,tierWindows,verifyBehavior}` | Operational scheduling/tier metadata DB-side; skill output target deliberately scoped to discovery fields only. |
| 11 | `topLevelCategories` block | Full (categories + droppedAsRedundant + totalsSumCheck) | (absent) | Skill produces operator-review documentation; DB doesn't persist it past onboarding. |

## Most surprising divergences

1. **`hasWaf: false` (skill) vs `true` (DB).** Both agree `wafType:cloudflare-passive`. Skill's Stage 2 decision tree explicitly outputs `false` for cf-passive-with-all-200; DB practice keeps `true` whenever the origin returns 403 on payload/honeypot probes. Skill rule and DB practice disagree. The skill's own "when unsure set true defensively" note hedges the decision tree but doesn't make it the primary outcome.

2. **`expectedProductCount` 357 vs 965.** Schema gap: DB schema has both `expectedProductCount` (admin total) AND `expectedInStockCount` (customer-visible), but skill output target only has ONE count field. The skill must pick a side and inevitably diverges from one DB field.

3. **`catalogUrls` 4 vs 6.** Walk-and-dedup formally proved all-surplus + food are redundant subsets — yet skill Rule C anti-pattern warns "never drop a category for being empty today" because tomorrow's product may only land there. The skill's Stage 4d rigorous union test arguably contradicts its own "don't over-prune empty/small categories" anti-pattern when the redundancy is by-content (not by-emptiness). DB preserves the redundant categories for that reason.

## SKILL.md harness gaps (3)

1. **Single `expectedProductCount` field can't represent WooCommerce's two-count reality.** WC sites distinguish admin-total (`/wp-json/wp/v2/product` x-wp-total includes drafts/private) from customer-visible (`/wp-json/wc/store/v1/products` x-wp-total). DB carries both; skill carries one. Stage 8 should output an `expectedInStockCount` alongside `expectedProductCount` for WooCommerce platforms, or pick a canonical endpoint and document which DB field it populates.

2. **`hasWaf` decision rule too binary.** Stage 2's table says cf-passive + all-200 = `hasWaf:false`. But DB practice (and this site's prior 2026-04-12 audit log "wafType sucuri→cloudflare-passive") keeps `hasWaf:true` because the origin DOES return 403 on a subset of inputs. Stage 2 should add: "If origin nginx returns 403 on any payload/honeypot, set `hasWaf:true` even with cf-passive — the WAF cookie path is still defensively useful."

3. **`crawlers.bootstrap.apiEndpoints` under-specified for WooCommerce 2-step.** Skill output target shows a generic adapter-specific block. DB encodes the WC operational reality: `productDiscovery` (WP REST: IDs+title+url+thumb, no price) plus `priceEnrichment` (WC Store API: price+stock) plus `htmlFallback:true`. Stage 3's platform-to-config table should add for WooCommerce: explicit 2-step bootstrap shape, because WP REST alone lacks price and WC Store API alone is sometimes rate-limited.
