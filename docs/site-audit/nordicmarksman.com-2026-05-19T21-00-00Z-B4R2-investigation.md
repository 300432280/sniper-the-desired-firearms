# nordicmarksman.com — B4R2 Investigation

Run: 2026-05-19T21:00:00Z
Input R1: `docs/site-audit/nordicmarksman.com-2026-05-19T20-00-00Z-B4R1.json`
DB snapshot: `_audit_tmp/batch4-2026-05-19/nordicmarksman.com-DB-snapshot.json`

## Verdict counts

- **R1 wins: 4** (`hasWaf`, `perPage`, `productCountMethod.shape`, `paginationPattern.extra-fields`)
- **DB wins: 2** (`catalogUrls`, `searchUrl`)
- **Both wrong: 1** (`expectedProductCount` — DB=4605, R1=4719, live=4736)
- **Schema/operator-only (not value divergence): rest** (admin/scheduler fields out of skill scope)

## Per-field verdicts

### 1. `hasWaf`: DB=true, R1=false → **R1 wins**
- **Method:** Re-ran condensed 5-vector WAF probe (different sequence from R1's 8-batch).
- **Evidence:** bot UA `Googlebot/2.1` → 200; empty UA → 200; `/wp-admin` → 403 (BC origin "no such file", `Server: cloudflare` confirms passive edge); SQLi probe `?id=1' OR 1=1--` → 200, 223KB body unchanged; 10 rapid sequential GETs all 200.
- **Runtime impact verified:** `catalog-crawler.ts:290` `perPage: profilePerPage || (params.hasWaf ? 20 : 50)` — `hasWaf=true` halves the throttle floor; `watermark-crawler.ts:79` `if (hasWaf) { ... fetchWithPlaywright ... }` — every watermark crawl routes through headless browser. Both unnecessary for passive Cloudflare.

### 2. `perPage`: DB=20, R1=2500 → **R1 wins**
- **Method:** R1 verified on "multiple categories" without naming them; R2 explicitly tested 5 different categories.
- **Evidence:** `limit=2500` honored on /ammunition/ (555 products returned), /cleaning/ (474), /firearms-and-stocks/ (441), /optics-lights/ (498), /spare-parts/ (793). All HTTP 200, full result in single response. `limit=5000` returned HTTP 500 after 15s → 2500 is the verified ceiling.

### 3. `catalogUrls`: DB=`["/categories.php"]`, R1=12 per-category paths → **DB wins**
- **Method:** R1 hypothesis: `/categories.php` on BC Stencil is a category-INDEX page (zero products). R2 walked it.
- **Evidence — R1 hypothesis is wrong:**
  - GET `/categories.php` → 200, 270KB, **20** `<li class="product">` cards + pagination `?page=1..6`.
  - GET `/categories.php?limit=2500` → 200, 8.7MB, **2500** product cards, **2500 unique `data-product-id`**.
  - GET `/categories.php?limit=2500&page=2` → 200, 7.5MB, **2179 unique product IDs**.
  - Union: **4679 unique product IDs, zero overlap** between pages.
  - Sitemap total: 4736 → coverage **98.8%**.
- **Compare to R1's 12-URL split:** R1 walked-union = 4485 unique (94.6%). DB's single URL is BETTER coverage with 1/12 the request count.
- **Adapter compatibility:** `generic-retail.ts:57` first selector is `li.product` — extractor will pick up every card cleanly.
- **Why R1 missed this:** R1 didn't walk `/categories.php` even once before declaring it "renders a category-index page, NOT a product listing." That was a guess, not a probe.

### 4. `expectedProductCount`: DB=4605, R1=4719 → **both stale, live=4736**
- **Method:** Live sitemap GET.
- **Evidence:** `/xmlsitemap.php?type=products&page=1` → 3023 `<loc>`; page=2 → 1713 `<loc>`; page=3 → 404. Sum=4736.
- DB is 41 days stale (-131); R1 is hours stale (-17). Adopt 4736.

### 5. `productCountMethod.shape`: DB=`{method:'sitemap', sitemapUrls:[...]}` vs R1=`{method:'sitemap-index', urls:[...]}` → **R1 wins (DB is BROKEN at runtime)**
- **Method:** Read `backend/src/services/product-count-probe.ts`.
- **Evidence:** `case 'sitemap'` at line 244-249 reads scalar `m.url`. `case 'sitemap-index'` at line 252-263 reads array `m.urls`. DB's `method: 'sitemap'` + `sitemapUrls` (plural) matches neither branch — `m.url` is undefined → axios.get(undefined) → fails, returns null. DB profile cannot probe a count via this path.

### 6. `sortParam`: both `?sort=newest` → **R1 wins (verification valid)**
- **Method:** 3-outcome counter-control.
- **Evidence:** Default first product on /ammunition/ has `product_id=22012`; `?sort=newest` first product has `product_id=22012` (IDENTICAL); `?sort=alphaasc` first is `a-zoom-17hmr-...` (DIFFERENT). Default is honored-newest.

### 7. `searchUrl`: DB=`/search.php?search_query={keyword}`, R1=(not present) → **DB wins (R1 omitted)**
- **Method:** Homepage form probe.
- **Evidence:** GET `/` → `<form class="form" action="/search.php">` with `<input name="search_query">`. BC-native search confirmed. R1 acknowledged this as a "skill gap surfaced."

### 8. paginationPattern.{perPage, firstPageHasParam, startPage, zeroIndexed}: R1 added → **R1 wins (spec-required)**
- DB legacy; not value divergence.

### 9. Operator/scheduler/admin fields (name, budget, timeout, dataFlow, crawlPhase, t1IntervalMin, cooldowns, tierShares, tierWindows, bootstrap, etc.) → **out of pre-bootstrap scope**
- Per SKILL.md "Output target," these fields are scheduler/operator-owned. No verdict needed.

## Blockers / risks

- **`/categories.php?limit=2500` is 8.7MB per request.** Acceptable for full-sweep but operator should be aware. Total catalog walk = 2 requests, ~16MB.
- **3.2% coverage gap (4736 sitemap vs 4679 walked union)**: Likely stale 404 entries in sitemap (legacy Blueprint .html URLs per R1 auditNotes). Acceptable.
- **`hasWaf=false` switch on DB requires operator approval:** changing column triggers watermark crawler to drop Playwright fallback. R1's behavior is correct but needs operator sign-off due to past WAF false-negatives. Recommend: change but tag for monitoring on first crawl.

## Skill gaps surfaced

1. **R1 didn't walk DB's existing `catalogUrls` even once before discarding it.** When a DB profile lists an unusual URL pattern (e.g. legacy `.php` files), the audit MUST GET it before assuming it's broken. Live evidence beats hypothesis.
2. **R1 didn't probe homepage for search form.** Stage 3 should have a deterministic check.
3. **DB's `productCountMethod.method='sitemap'` with array `sitemapUrls` is a broken legacy shape.** Other DB records likely have the same shape — worth a migration script.

## Bottom line

R1 was right on 4 fields, wrong on 2 (`catalogUrls`, `searchUrl`), drifted on 1 (`expectedProductCount`). The biggest R1 error: replacing the working single-URL `/categories.php` aggregator with a 12-URL per-category split that has LOWER coverage and 12x the request count. DB's `catalogUrls` was correct all along.
