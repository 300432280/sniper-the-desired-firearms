# B4R2 Investigation — g4cgunstore.com

Round 2 adversarial audit. Each R1 divergence re-tested live with a method different from R1's WHY hypothesis. No DB writes.

## Inputs
- R1 candidate: `docs/site-audit/g4cgunstore.com-2026-05-19T20-00-00Z-B4R1.json`
- R1 diff: `docs/site-audit/g4cgunstore.com-2026-05-19T20-00-00Z-B4R1-diff.md`
- DB snapshot: `_audit_tmp/batch4-2026-05-19/g4cgunstore.com-DB-snapshot.json` (DB lastVerified 2026-04-07)

## Verdict counts (8 divergent fields)
- R1 wins: **0**
- DB wins: **5** distinct judgement calls (adapterType, wafType, catalogUrls, crawlers.maintain.verifyMethod, plus needsPlaywright+userAgentOverride which are derivative of wafType)
- Both wrong: **1** (expectedProductCount; new live = 5851)
- Equivalent, DB form preferred: **2** (sortParam, paginationPattern.template)

## Field-by-field investigation

### 1. adapterType — DB wins (generic-retail)
**R1 WHY**: DB classifies by adapter capability (operator override). **R2 method (different)**: read routing code directly.

- `adapter-registry.ts:118` — sole adapter routing key is `siteInfo.adapterType`. The `adapters` lookup table is keyed by string value.
- `grep -r 'dataFlow\.steps' backend/src/` -> **zero matches**. The `dataFlow.steps[]` block in the DB profile is pure documentation/audit-trail metadata; no runtime consumer.
- Both `woocommerce.ts:265` and `generic-retail.ts:198` read `siteProfile.catalogUrls`, so the same per-category list works under either adapter. The DB's `generic-retail` choice is an intentional operator override that defines the extraction selector pipeline.

**Verdict**: DB wins. Candidate followed the skill-table verbatim mapping (`platform: woocommerce` -> `adapterType: woocommerce`) and missed the operator's intent.

### 2. wafType — DB wins (cloudflare-passive)
**R1 WHY**: probe IP triggers active CF; DB's 2026-04-07 audit from different IP saw all 200s. **R2 method (different)**: multi-UA matrix from same audit IP — if active CF were IP-flagged, ALL UAs should be blocked.

Sequential test results (800ms spacing):

| URL | UA | Status |
|---|---|---|
| `/` | curl/default | 403 |
| `/` | Chrome 124 desktop | 200 |
| `/shop/` | Chrome 124 desktop | 200 |
| `/shop/` | iPhone Safari 17.4.1 | 200 |
| `/shop/` | (no UA header) | 200 |
| `/shop/` | curl/default | 403 |
| `/shop/` | Googlebot | 403 |
| `/shop/page/244/` | Chrome 124 | 200 |
| `/wp-json/wp/v2/product?per_page=1` | Chrome 124 | 200 (x-wp-total: 5851) |
| `/wp-json/wc/store/v1/products?per_page=1` | Chrome 124 | 403 |

5 sequential WP REST calls with 1s delay all returned 200.

**Conclusion**: Cloudflare is **passive** for real-browser UAs. The 403s are Bot Fight Mode for tokens `curl/*` and `Googlebot` — orthogonal to WAF severity. R1 saw burst 403 from parallel curl-default-UA, which would 403 a single request too. R1's iPhone-Safari-only diagnosis was misled.

Production crawler USER_AGENTS pool (`http-client.ts:9-14`):
- Chrome 120, Safari 17.2, Firefox 121, Edge 120

All four are real-browser UAs -> all pass. No `userAgentOverride` needed.

### 3. needsPlaywright — DB wins (false)
Derivative of #2. Plain axios with any production-default UA returns 200 on /shop/, /shop/page/N/, /wp-json/wp/v2/product, and /product-category/{slug}/. Playwright unnecessary for routine crawl.

### 4. userAgentOverride — DB wins (null/absent)
Derivative of #2. R1's iPhone Safari override was based on the (incorrect) active-CF verdict. Not needed.

### 5. expectedProductCount — both wrong; B4R2 = 5851
Live `x-wp-total` from `/wp-json/wp/v2/product?per_page=1` with Chrome UA: **5851**.
- DB's 5741 stale by 42 days (2026-04-07).
- R1's 5846 stale by hours (run earlier today).
- Site grew by ~110 since DB snapshot, ~5 since R1.

### 6. catalogUrls — DB wins (6 per-category URLs)
**R1 WHY**: candidate took Rule C "smallest URL set" literally -> single `/shop/` covers 100%. **R2 method (different)**: walk both, count pages, verify runtime consumption.

- Both shapes are consumed at runtime by `generic-retail.ts:198` (the same `_getSiteSpecificUrls` path).
- Per-category pagination cost (per_page=24):
  - firearms: 2097/24 = 88 pages
  - ammunition: 1928/24 = 81 pages
  - accessories: 1232/24 = 52 pages
  - sights-optics: 595/24 = 25 pages
  - high-value-optics: 286/24 = 12 pages
  - iron-sights: 35/24 = 2 pages
  - **Total**: ~260 pages
- Single /shop/: 5851/24 = 244 pages. `/shop/page/244/` = 200; `/shop/page/245/` = 404.

So **per-category costs 16 extra pages** but enables independent token allocation at `catalog-crawler.ts:378`. The outer `while (urlIdx < catalogUrls.length && tokensUsed < tokensAllocated)` loop walks URLs sequentially with persistence (`currentUrlIndex`, `currentPageUrl`); per-category gives the scheduler granular checkpoints so a rate-limited category doesn't block others.

**Critical correction to R1's hierarchy claim**: `/wp-json/wp/v2/product_cat?slug=sights-optics,high-value-optics,iron-sights&_fields=id,slug,parent,count` returned all three with `parent: 0`. They are SIBLINGS, not parent-child. R1 said "sights-optics is parent of high-value-optics+iron-sights" — wrong. Verified product overlap (cross-tagging):
- holosun-he507c-x3-gr-2-moa product_cat = [16854, 391, 165] (high-value-optics + sights-optics)
- troy-m4-style-front-folding-battle-sight product_cat = [40, 396, 449, 16962, 16880] (accessories + iron-sights)

Sum of 6 = 6173; global = 5851; excess of 322 is the dual-tagging overlap.

### 7. crawlers.maintain.verifyMethod — DB wins (wp-rest)
**R1 WHY**: skill table — Store API 403 -> detail-page fallback. **R2 method (different)**: check whether WP REST core (separate from Store API) is open.

Already proven open in test #2: `/wp-json/wp/v2/product` returns 200 with x-wp-total header. DB's split is more efficient:
- WP REST `/wp-json/wp/v2/product?slug={slug}` -> title/slug/thumbnail (no price/stock)
- HTML `/product/{slug}/` -> price/stock enrichment

This avoids per-product Playwright fetches that detail-page would imply (HTML scrape works fine with axios because the site is CF-passive).

### 8. sortParam — equivalent; DB form preferred
`/shop/?orderby=date` returns post IDs 286176, 286178, 286181, 285841 (newest-first descending). WC default for `orderby=date` IS desc, so the candidate's omission is functionally equivalent. DB's explicit `&order=desc` is safer against future WC version changes — kept in B4R2.

### Tangential: paginationPattern.template
Candidate has `/page/{N}/`, DB has `/page/{N}` (no trailing slash). Runtime tolerant per `catalog-crawler.ts:121-125`. Both work. B4R2 keeps DB form for consistency.

## Blockers
None.

## Top 3 evidence highlights
1. **WAF re-test (different method)** — multi-UA matrix from same audit IP: Chrome/iPhone/no-UA all 200 on /shop/; only curl/default + Googlebot get 403. R1's "active CF" was a bot-UA + parallel-burst artifact, not WAF severity.
2. **dataFlow.steps[] is dead metadata** — `grep -r 'dataFlow\.steps' backend/src/` returned zero hits. The block is documentation; routing is solely by `adapterType` at `adapter-registry.ts:118`. DB's `generic-retail` is an intentional operator override the candidate missed.
3. **sights-optics hierarchy correction** — `/wp-json/wp/v2/product_cat?slug=sights-optics,high-value-optics,iron-sights` returned `parent: 0` for all three. R1's claim that they are nested was wrong; they are siblings with dual-tagged products.
