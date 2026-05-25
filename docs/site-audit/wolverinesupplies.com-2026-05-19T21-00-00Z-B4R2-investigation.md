# B4R2 Investigation — wolverinesupplies.com

**Mode**: Live adversarial verification. Both R1 candidate and DB are hypotheses; nothing trusted.
**Runtime files re-read**: `product-count-probe.ts` (lines 1-180, 180-498), `catalog-crawler.ts` (lines 280-410), `worker.ts` (lines 240-289, 765-786), `generic-retail.ts` (lines 931-970).

## Verdict counts
- **R1 wins**: 4 hard disagreements where R1 was right
- **DB wins**: 0
- **Both wrong / R2 correction**: 1 (`expectedProductCount` count — R1 had 8169, live sitemap returned 8186)
- **Inconclusive**: 0

## Per-divergence verdicts

### 1. `hasWaf` — VERDICT: R1 wins (candidate=false, DB=true)
- **R1 hypothesis**: cloudflare-passive doesn't justify hasWaf:true
- **R2 method**: Different from R1 — ran SQLi, XSS, no-UA, python-requests-UA, and honeypot probes directly with curl (not the 8-batch heavy probe R1 used). All probes 200.
- **Evidence**:
  - `curl --get --data-urlencode "search=' OR 1=1--" /firearms/` -> HTTP 200
  - `curl --get --data-urlencode "q=<script>alert(1)</script>" /firearms/` -> HTTP 200
  - `curl` (no UA) `/` -> HTTP 200
  - `curl -A "python-requests/2.0" /` -> HTTP 200
  - `curl /.env` -> HTTP 403 (BC origin denies; not a WAF rule)
- **Runtime cost confirmed**: `catalog-crawler.ts:390` routes every page through Playwright when `hasWaf:true`. With perPage=100 explicitly set, the perPage-drop-to-20 path at line 290 is bypassed — but the Playwright detour stays. DB is paying Playwright overhead unnecessarily.
- **Correction**: `hasWaf:false`, retain `wafType:"cloudflare-passive"` as informational.

### 2. `productCountMethod` — VERDICT: R1 wins (candidate=object, DB=bare-string)
- **R1 hypothesis**: DB's `"category-walk-dedupe"` falls through to default branch
- **R2 method**: Read runtime code directly. `validateMethod` at `product-count-probe.ts:129-137` THROWS for any name not in `VALID_METHOD_NAMES` (line 110-122). The 11 canonical names don't include `category-walk-dedupe`. Thrown error caught by outer try at line 493 -> returns null.
- **R1's "silently falls to default"** is partially wrong — actually validates and throws, but the OUTCOME is the same (null returned, coverage gate skipped).
- **Code line**: `product-count-probe.ts:132` — `throw new Error(... 'unknown product-count method: ...')`
- **Correction**: Use canonical object shape `{ method: "sitemap", url: "/xmlsitemap.php?type=products&page=1" }`.

### 3. `expectedProductCount` — VERDICT: Both stale / R2 correction (R1=8169, DB=5739, R2 live=8186)
- **R1 hypothesis**: sitemap is OOS-inclusive (8169); walk is in-stock-only (5569)
- **R2 method**: Fresh sitemap fetch + fresh /shop-all/ walk at limit=2500.
- **Evidence**:
  - `GET /xmlsitemap.php?type=products&page=1` -> 200, 968KB, `grep -c '<loc>'` = **8186**
  - `GET /xmlsitemap.php?type=products&page=2` -> 404 (single-file sitemap)
  - `GET /shop-all/?sort=newest&limit=2500` (pages 1, 2, 3) -> 2500 + 2500 + 569 = **5569 unique IDs** (zero overlap between any pair)
- **Fleet convention** (queried DB): nordicmarksman, frontierfirearms, alflahertys, prophetriver all use `sitemap`-family methods with OOS-inclusive counts. wolverine should follow.
- **Coverage gate impact**: with sitemap=8186 and live in-stock dbCount ~5569, `verifyBootstrapCoverage` will report ratio ~0.68 -> trips 95% threshold -> 3 retry passes then warning (worker.ts:267-279). Operator must accept this is BC Stencil's structural reality.
- **Correction**: `expectedProductCount: 8186` (fresher than R1's 8169 — sitemap grew +17 products during R1->R2 elapsed time).

### 4. `crawlers.maintain.verifyMethod` — VERDICT: R1 wins (candidate adds, DB omits)
- **R1 hypothesis**: DB lacks maintain -> runtime logs error and skips verification
- **R2 method**: Re-read worker.ts directly.
- **Evidence**: `worker.ts:769-772`: `const verifyMethod = entry?.siteProfile?.crawlers?.maintain?.verifyMethod; if (!verifyMethod) { console.error('[VerifyWorker] ${domain}: MISSING verifyMethod...'); return; }`
- **Correction**: `crawlers.maintain.verifyMethod: "detail-page"`, `verifyEndpoint: null`.

### 5. `paginationPattern` schema — VERDICT: R1 wins (candidate=canonical, DB=key-drift)
- **R2 method**: Live pagination walk verifies the VALUE (`page`, startPage=1, perPage=100, firstPageHasParam=false). DB's key names (`param`, `firstPage`) are equivalent in value but not in schema. Runtime spec uses `template`/`startPage` (per existing fleet profiles).
- **Evidence**: `/firearms/?sort=newest&page=2` HTTP 200, 100 unique IDs, zero overlap with p1. Page 7 returns 26 (last partial page).
- **Correction**: keep candidate's canonical keys.

### 6-19. Schema-drift omissions — VERDICT: R1 wins (skill correctly omits operator-doc residue)
- `notes`, `parentChildNote`, `canonicalNote`, `sitemapNote`, `sortVerifiedAt`, `sortVerifiedMethod`, `sitemapProductCount`, `parentChildInclusion`, `bcStoreId`, `catalogUrlStats` — all are audit-trail residue per skill Rule B. R1 correctly omits.
- `bcStoreId` moved into `auditNotes` (informational).
- `catalogUrlStats` replaced by `topLevelCategories.categories[]` (same data, schema-current shape).

### 20. `catalogUrls` order — MATCH (cosmetic)
- 14 URLs, set equality between candidate and DB.

### 21. Matches (no divergence)
- `platform`, `adapterType`, `wafType`, `hasCaptcha`, `sortParam`, `sortVerified`, `perPage`, `needsPlaywright`, `crawlers.watermark.method`, `paginationPattern.type/firstPageHasParam`.

## Top 3 verdicts (one-line evidence each)
1. `hasWaf:false` — SQLi `' OR 1=1--` + `<script>` XSS + python-requests UA all return 200 on /firearms/.
2. `productCountMethod:{method:"sitemap",url:"/xmlsitemap.php?type=products&page=1"}` — DB's `"category-walk-dedupe"` throws at `product-count-probe.ts:132`; sitemap returns 8186 <loc> entries in 968KB single file.
3. `expectedProductCount:8186` — fresh sitemap count (R1's 8169 stale by hours; site grew +17).

## Blockers
None. All probes succeeded within budget (~6 minutes wall, well under 25min cap).

## Runtime code citations
- `backend/src/services/product-count-probe.ts:110-122` — VALID_METHOD_NAMES (the 11 canonical methods)
- `backend/src/services/product-count-probe.ts:129-137` — validateMethod throws for non-canonical names
- `backend/src/services/product-count-probe.ts:493-497` — outer try/catch swallows throw, returns null
- `backend/src/services/product-count-probe.ts:521-527` — coverage gate ratio computation
- `backend/src/services/worker.ts:254-284` — coverage gate invocation; null-expected bypasses check
- `backend/src/services/worker.ts:769-772` — verifyMethod-required guard; missing -> return early
- `backend/src/services/catalog-crawler.ts:290` — perPage default switch (`hasWaf:true -> 20`; profile override wins)
- `backend/src/services/catalog-crawler.ts:390-408` — Playwright forced when `hasWaf:true` (real cost)
- `backend/src/services/scraper/adapters/generic-retail.ts:942` — `[data-product-id]` is selector #1 for catalog extraction
