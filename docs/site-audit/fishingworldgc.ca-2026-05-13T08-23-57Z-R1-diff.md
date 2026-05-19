# R1 Candidate vs DB Diff — fishingworldgc.ca

**Candidate:** `docs/site-audit/fishingworldgc.ca-2026-05-13T08-23-57Z-R1.json` (probe time 2026-05-13T08:19Z)
**DB siteProfile:** snapshot from MonitoredSite row (last live audit 2026-04-11; ~32 days stale)

Legend: WHY = one-line reason for divergence (skill-policy / data-drift / DB-residue / DB-bug).

## Divergent fields

| Field | Candidate | DB | WHY |
|---|---|---|---|
| `hasWaf` (DB column) | `false` | `true` | skill-policy — Mistake 23 cloudflare-passive: skill says set `hasWaf:false` operationally because CF does not actively block; setting true downshifts perPage to 20 for no gain |
| `hasWaf` (JSON field) | `false` | `true` | same skill-policy mismatch |
| `expectedProductCount` | `2011` | `1953` | data-drift — site grew +58 products over 32 days |
| `productCountMethod.method` | `shopify-products-walk` | `products-json-walk` | DB-bug — DB label not in `product-count-probe.ts:272` switch; falls through to `default: return null`, silently disabling count probe |
| `catalogUrls` | `["/collections/all"]` (1 URL) | 23 URLs (`/collections/all` + 22 sub-collections) | skill-policy — Rule C min-URL-set: `/collections/all` walk = 2011 = global walk = sitemap count; 22 sub-collections add zero unique IDs to the union, so they are redundant by Rule C definition (sub-2K-product site is under Shopify dept-feed soft-cap) |
| `paginationPattern.perPage` | `250` (API) | `24` (HTML) | skill-policy — Shopify runtime uses /products.json (limit=250) for catalog walk; DB recorded HTML theme default. Both are factually true for their respective transports, but the runtime field should reflect the runtime mechanic |
| `perPage` (top-level) | `250` | `250` (matches) | — |
| `crawlers.maintain.verifyMethod` | `detail-page` | `json-ld` | skill-policy — current SKILL.md Stage 3 mapping for Shopify is `detail-page` (Admin API requires auth). DB has legacy `json-ld` not in the current map |
| `crawlers.maintain.verifyEndpoint` | `null` | (missing) | skill-policy — required by harness shape; DB omitted |
| `wafLastProbedAt` | `2026-05-13T08:19:18Z` | `2026-04-11` | data-drift — fresh probe |
| `lastVerified` | `2026-05-13` | `2026-04-11` | data-drift |
| `topLevelCategories` | structured object (20 top slugs) | absent; `catalogUrlStats` map of 22 collections | skill-policy — current harness uses `topLevelCategories.{source,categories[],totalsSumCheck}`; DB has older `catalogUrlStats` residue |
| `auditNotes` | structured `runId/fieldConfidence/stageNotes` | absent | skill-policy — added by current harness |
| `extractionTested` / `extractionSample` | `true` + 3 samples | absent | skill-policy — Stage 4g extraction proof added by current harness |
| **DB-only residue (not in candidate, by design):** | | | |
| `budget`, `timeout`, `t1IntervalMin` | (omitted) | `90`, `15000`, `17` | DB-residue — runtime-tuning fields outside the formal siteProfile shape |
| `crawlers.maintain.cooldowns / tierShares / tierWindows / method` | (omitted) | object with t2/t3/t4 config | DB-residue — operator audit-trail / runtime scheduling config, not part of harness shape |
| `crawlers.bootstrap.method` / `htmlFallback` | (omitted) | `single-continuous`, `false` | DB-residue — runtime scheduling config |
| `siteCategory`, `crawlPhase`, `hasRateLimit` | (omitted) | `retailer`, `bootstrap`, `false` | DB-residue — DB-column-only fields, not in harness shape |
| `dataFlow`, `notes`, `name` | (omitted) | populated | DB-residue — audit-trail freeform |
| `apiSortNote`, `apiSortOrder`, `sortVerifiedMethod`, `sortVerifiedAt`, `sortVerifiedOn` | (omitted) | populated freeform | DB-residue — operator-validation notes (Rule B audit-trail) |
| `catalogUrlStats` map | (omitted; replaced by `topLevelCategories.categories[]`) | populated | DB-residue — replaced by current harness shape |

## Counts

- **Runtime-relevant divergences (skill vs DB):** 8 — `hasWaf` column + JSON, `expectedProductCount`, `productCountMethod.method`, `catalogUrls` size, `paginationPattern.perPage`, `crawlers.maintain.verifyMethod`, `crawlers.maintain.verifyEndpoint`.
- **Schema/residue divergences (harness shape vs DB extras):** ~16 DB-only fields the harness intentionally omits.
- **Matches (load-bearing):** `platform`, `adapterType`, `hasCaptcha`, `sortParam`, `sortVerified`, `searchUrl`, `crawlers.watermark.method`, `crawlers.bootstrap.apiEndpoints`, `perPage`, `paginationPattern.type/template`.

## Top 3 most surprising divergences

1. **`hasWaf`** — DB column says `true`; skill says `false`. Most consequential runtime difference because `hasWaf:true` triggers perPage-20 downshift in `catalog-crawler.ts:290`. If skill output were promoted as-is, the site would still be perfectly crawled but ~12.5× faster (250/page vs 20/page on HTML fallback path). The skill's own Mistake 23 rule explicitly says "cf-ray + all 200 → hasWaf:false" and yet every Shopify-on-Cloudflare DB profile in the codebase has `hasWaf:true`. The DB convention contradicts the current skill rule.
2. **`productCountMethod.method` = `products-json-walk`** — this DB value is not in `product-count-probe.ts:272`'s switch. It falls through `default: return null`, silently disabling the count probe in production. A latent DB-bug, not a skill-output difference. The skill's label-drift table catches it (`shopify-products-walk` is canonical).
3. **`catalogUrls` size: 23 → 1** — Rule C min-URL-set collapses to one URL because `/collections/all` walks the entire catalog and matches sitemap count exactly. All 22 sub-collection URLs were redundant by the union test. A real check, not a wishful collapse.

## SKILL.md harness gaps

1. **`hasWaf` for cloudflare-passive Shopify perpetually diverges from DB convention.** Skill rule is unambiguous (false for passive), but the DB tradition is `true`. The skill should either (a) include explicit guidance for promotion-time back-fill ("when DB has `hasWaf:true` for a cloudflare-passive Shopify site, flip to false on next audit") or (b) acknowledge in Stage 2 that cf-passive sites already in the DB will diverge and that's expected.
2. **`paginationPattern.perPage` transport-ambiguity for adapters with primary API mode.** For Shopify the API perPage is 250 (`/products.json` limit) and HTML perPage is 24 (theme default). Both are factually correct for their respective transports. The harness has a single `perPage` slot in `paginationPattern` plus a top-level `perPage`. Stage 5 should specify: when the adapter's `fetchCatalogPage` uses an API endpoint, record the API perPage; document the HTML-fallback perPage in `auditNotes` if relevant.
3. **DB-residue field list not enumerated.** Calibration diffs against DB always carry ~16 "DB-only" entries (`budget`, `timeout`, `t1IntervalMin`, `crawlers.maintain.cooldowns/tierShares/tierWindows/method`, `crawlers.bootstrap.method/htmlFallback`, `siteCategory`, `crawlPhase`, `hasRateLimit`, `dataFlow`, `notes`, `name`, `apiSortNote`, `sortVerifiedMethod`, `catalogUrlStats`). The skill should either list these explicitly as "preserve on promotion, harness does not produce" OR explicitly migrate them out of `siteProfile` to a separate column (e.g. `runtimeTuning` JSONB). Currently every calibration produces noisy diffs because of this drift.
