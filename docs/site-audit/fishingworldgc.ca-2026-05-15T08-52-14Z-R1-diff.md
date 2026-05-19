# R1 Blind Skill Run — Diff vs DB siteProfile

**Site:** fishingworldgc.ca
**Candidate:** `docs/site-audit/fishingworldgc.ca-2026-05-15T08-52-14Z-R1.json`
**DB lastVerified:** 2026-04-11
**Candidate lastVerified:** 2026-05-15

## Convergent fields (no divergence)

| Field | Both agree |
|---|---|
| `platform` | `shopify` |
| `adapterType` | `shopify` |
| `wafType` | `cloudflare-passive` |
| `wafProbeMethod` | `heavy-8-batch` |
| `hasCaptcha` | `false` |
| `needsPlaywright` | `false` |
| `sortParam` | `?sort_by=created-descending` |
| `sortVerified` | `true` |
| `crawlers.watermark.method` | `navigate-from-watermark` |
| `paginationPattern.type` | `query` |
| `paginationPattern.template` | `page` |
| `paginationPattern.firstPageHasParam` | `false` |

## Divergent fields

| # | Field | Candidate (R1) | DB | Why divergent (one line) |
|---|---|---|---|---|
| 1 | `hasWaf` | `false` | `true` | R1 follows skill rule "hasWaf is operational" - cf-ray + all real-UA 200s = passive, not actively blocking. DB stores literal-presence semantics. |
| 2 | `expectedProductCount` | `1992` | `1953` | Site grew by 39 products between 2026-04-11 (DB) and 2026-05-15 (R1). Both walked /products.json; R1 sitemap cross-check confirms 1992 current. |
| 3 | `productCountMethod.method` | `shopify-products-walk` | `products-json-walk` | Skill canonical name vs DB label-drift (Stage 8 label-drift table maps `products-json-walk` -> `shopify-products-walk`). |
| 4 | `catalogUrls` count | 1 (`/collections/all`) | 23 (per-category + aggregator) | R1 enforces Rule C minimum-cover: walk proved /collections/all = 1992 unique, matches sitemap exactly, so per-category URLs are 100% redundant (subset overlap). DB encodes operator-curated per-category list with /collections/all included. |
| 5 | `paginationPattern.perPage` | `34` | `24` | HTML page-product count is theme-controlled - measured 34 unique product slugs on /collections/all?page=1 today (R1), DB stored 24 (likely measured on a different collection or older theme version). |
| 6 | `perPage` (top-level) | `34` | `250` (siteProfile.perPage) | R1 reports HTML perPage (34) for catalog HTML walk; DB reports API perPage (250) for /products.json walk - both correct for different runtime paths. Skill schema conflates these. |
| 7 | `productCountMethod.endpoint` | `/products.json` | absent in DB shape | R1 emits the canonical discriminated-union shape required by product-count-probe.ts switch; DB uses freeform shape with `note`/`totalPages`. |
| 8 | `wafProbeEvidence` shape | structured object | freeform string | R1 follows skill Stage 2 evidence shape; DB stores prose summary. |
| 9 | `wafLastProbedAt` | `2026-05-15T08:46:00Z` (ISO datetime) | `2026-04-11` (date only) | R1 emits full ISO datetime; DB stores date-only. |
| 10 | `searchUrl` | absent | `/search?q={keyword}&type=product` | R1 did not discover the search URL - skill Stage 3 conditional output, not produced this run. |
| 11 | `crawlers.maintain.verifyMethod` | `detail-page` | `json-ld` | Skill Stage 3 table maps `shopify` -> `detail-page`; DB uses different label. Both indicate per-product page fetch but the canonical enum value mismatches. |
| 12 | `crawlers.maintain.verifyEndpoint` | `null` | absent | R1 emits explicit null per skill shape; DB omits. |
| 13 | `crawlers.bootstrap.apiEndpoints` keys | `{productsJson, collectionsJson}` | `{priceEnrichment, productDiscovery}` | Schema drift - R1 uses descriptive keys; DB uses functional keys. |
| 14 | `topLevelCategories` | populated (10 categories, source, totalsSumCheck) | absent - DB has `catalogUrlStats` instead | R1 emits skill's documented field name; DB uses different field name for the same intent. |
| 15 | `extractionTested` / `extractionSample` | populated | absent | R1 includes Stage 4g spot-check; DB has no such audit-trail field. |
| 16 | `auditNotes` | populated (stageNotes, fieldConfidence, runId, probeIp) | absent | R1-only field per skill Stage 9. |
| 17 | DB-only fields not in R1 | - | `name`, `notes`, `budget`, `timeout`, `apiSortNote`, `apiSortOrder`, `hasRateLimit`, `siteCategory`, `t1IntervalMin`, `sortVerifiedAt`, `sortVerifiedOn`, `sortVerifiedMethod`, `dataFlow`, `crawlPhase` | DB persists operator-curated runtime knobs and audit-trail residue not in skill schema. |

**Divergent field count: 17** (11 of which are schema/label-drift; 6 are real value disagreements on `hasWaf`, `expectedProductCount`, `catalogUrls`, `paginationPattern.perPage`, `perPage`, `crawlers.maintain.verifyMethod`).
