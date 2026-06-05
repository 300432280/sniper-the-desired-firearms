# Wave 1 — Round 2 Live-Investigation Ledger — 2026-06-03

13-parked-site onboarding audit, near-ready wave (6 sites). R2 = fresh testing-api-tester agents,
gentle probes only (no heavy 8-batch — it banned our IP via Imunify360 on pavillon in R1).
All values live-verified + runtime-code-traced. READ-ONLY (no DB writes this phase).

## CROSS-CUTTING LESSON (the count-surface rule — drives accurate coverage)
expectedProductCount MUST equal the total of the surface the RUNTIME actually crawls, which depends on adapter dispatch:
- **WooCommerce** → runtime walks WP REST `/wp-json/wp/v2/product` global (full corpus incl OOS). count = WP REST x-wp-total. catalogUrls are runtime-INERT (API-first; only used on 401 HTML fallback).
- **BigCommerce + GraphQL apiAlternative** → runtime uses GraphQL newestProducts/products feed (= customer-visible = products sitemap). count = sitemap/GraphQL total.
- **BigCommerce WITHOUT GraphQL apiAlternative** → generic-retail.fetchCatalogPage returns null → runtime FALLS THROUGH to HTML category walk (catalogUrls). count = browsable category-union (NOT sitemap; sitemap over-counts by OOS hidden from listings). catalogUrls are LOAD-BEARING.
Picking the count method by platform alone (e.g. "BC -> sitemap") is WRONG when the runtime can't reach that surface (wolverine: sitemap 8235 vs reachable 5689 -> would report 70% forever).

## PER-SITE R2 CORRECTIONS

### pavillonchassepeche.ca (woocommerce) — NEAR-READY
- expectedProductCount: 1318 -> **1253** (WP REST FR-global x-wp-total; runtime walks WP REST `/wp/v2/product`). expectedInStockCount 1291->1226 (Store API surface).
- hasWaf: **false** (DB already false; R1's imunify360/true was a heavy-probe burst artifact — normal-paced GET returns 200 LiteSpeed).
- catalogUrls: KEEP broad 6-cat (or switch to 7 FR `/categorie-produit/...` incl `tirage`). R1's 3-firearm-only would DROP 592 products (peche/vetements/plein-air/salines) — coverage violation. Inert (API-first) but must stay complete.
- productCountMethod: wp-rest-header @ /wp/v2/product / x-wp-total (canonical; refresh internal totals).
- Indexed ~1317 vs 1253 -> ~ready (count just needs lowering).

### rangeviewsports.ca (woocommerce) — NEAR-READY
- expectedProductCount: 5407 -> **5454** (WP REST core = Store API default, both x-wp-total=5454; runtime walks WP REST primary woocommerce.ts:336-414).
- catalogUrls: 10-cat -> **["/shop/"]** (API ignores catalogUrls; /shop/ proven 100% single-URL HTML cover, page1∩page2=0, 341 pages; 10-cat sums 5430 w/ overlap risk). pagination template `/shop/page/{N}/`.
- perPage: 500 -> **100** (woocommerce.ts:299 hard-caps API at 100; DB 500 silently clamped). htmlPerPage 16.
- hasWaf: true -> **false** (+ clear stale `requiresSucuri=true` column). cloudflare-passive.
- searchUrl `/?s={keyword}&post_type=product` confirmed honored (junk-diff). watermark api-date-since-watermark confirmed. Indexed ~5362 -> ~98% ready.

### shooterschoice.com (woocommerce) — BACKFILL-NEEDED (62%)
- expectedProductCount: 11370 -> **11409** (WP REST full corpus = 4414 instock + 6891 OOS + 104 backorder; runtime walks WP REST, proven by 5037 OOS already in index — impossible via 4518 visible cap). 7113 indexed = mid-backfill, not ceiling.
- hasWaf/wafType: true/wordfence-on-cloudflare-passive -> **false/cloudflare-passive** (no Wordfence markers; R1 "challenge" was false-positive on CF `challenge-platform` script).
- catalogUrls: runtime-INERT (API-first); keep /shop/ or DB 30-cat — no coverage diff. Don't optimize.
- B8: keep verifyMethod=store-api + count surface WP REST (legit split: WP REST = full discovery, Store API = price/stock). Accept B8 warning as documented false-positive. NOTE: store-api verify + 60% OOS = large restock surface; worker.ts:549/711 fast-path risk -> operator may prefer detail-page verify (policy call).

### wolverinesupplies.com (bigcommerce-stencil, NO GraphQL) — BACKFILL-NEEDED (~73%)
- expectedProductCount: 8193(sitemap) -> **~5689** (browsable 14-category union, the surface the runtime HTML-walks; fetchCatalogPage returns null -> HTML fallback, generic-retail.ts:314-332). productCountMethod -> pagination-walk of catalogUrls, NOT sitemap. (Sitemap 8235 includes ~2150 OOS the HTML walk can't reach; DB ProductIndex 6036 active proves runtime reaches ~5.6-6.1K not 8235.)
- catalogUrls: KEEP the 14 per-category (union 5689). REJECT /shop-all/ substitute — it MISSES 109 products incl the newest (IDs 9134/9131 dated 2026-06-03 absent from shop-all). R1's single-URL claim wrong.
- perPage: 250 wire-safe but NO-OP for type:query (buildPaginatedUrl ignores perPage for query type; catalog-crawler.ts:153-166). To get 250/page, bake `&limit=250` into catalogUrls; else behaviorally 100. Operator choice.
- hasWaf: false / cloudflare-passive confirmed.
- Note: per-product postDate IS available on BC listing cards (R1 "no date" note too strong); navigate-from-watermark still correct.

### oleysarmoury.com (bigcommerce-stencil, HAS GraphQL) — BACKFILL-NEEDED (~60%)
- expectedProductCount: 3368 -> **3509** (products sitemap = full GraphQL `products` walk, both = 3509; runtime indexes via GraphQL newestProducts, generic-retail.ts:334/766). customer-visible = full (no hidden gap).
- productCountMethod: `bc-xmlsitemap` -> **generic-product-sitemap** @ /xmlsitemap.php?type=products&page=1 (no pattern). CONFIRMED silent-null: bc-xmlsitemap not in VALID_METHOD_NAMES -> validateMethod throws -> caught -> null (product-count-probe.ts:110-122,140-170,549-554).
- hasWaf: true -> **false** / cloudflare-passive.
- sortParam/sortVerified: KEEP `?sort=newest`/true (DB correct). R1's "NOOP" WRONG — alphaasc reorders; default==newest. Moot anyway (runtime uses GraphQL real createdAt).
- catalogUrls: DB 13 has firearms-category GAPS (omits magazines/reloading/parts/holsters/safes/knifes/black-powder/clearance/consignment) + Rule-C violations (/decals//swag/). Fix: add firearms cats, drop swag. BUT inert (GraphQL global covers all 3509) — low priority.
- TTL drift: top-level apiAlternative.tokenCacheTtlMs=1h (runtime reads this) vs nested 48h (real). Harmless (cheap re-scrape); flatten optional.

### truenortharms.com (bigcommerce-stencil) — INDEX BLOAT (not backfill)
- expectedProductCount: 1264 -> **1125** (sitemap stable; pages 2-4 = 404).
- INDEX BLOAT: 4658 active vs 1125 published. 30-sample of indexed-not-in-sitemap = 29 hard-404 / 1 slug-rename / 0 OOS-live -> ~3675 dead rows (crawler frozen since ~Apr 30). REMEDIATION: set count->1125, RESTART crawling -> stale-detector.ts verifyDetailPage deactivates via CONFIRMED per-product 404 (lines 102-144, 343-367). NO bulk-deactivate (4956-incident rule); needs computeSafeWindow non-null (all tiers swept). No code change.
- productCountMethod: KEEP DB `sitemap-index` (valid, produces 1125; passes guards product-count-probe.ts:183-193,308-320). R1's scalar-sitemap change unnecessary.
- catalogUrls: 149 leaves broadly resolve (15/16 spot-check 200); drop `/vip-club/` (404). Full dedup vs 1125 = INCONCLUSIVE (R3 to complete). Verify reachable count via HTML walk matches 1125 (this BC site — confirm whether runtime uses GraphQL or HTML; if HTML, browsable union should ~1125).

## OPEN FOR R3 (adversarial counter)
- wolverine 5689 browsable basis vs any larger reachable set; the 109 shop-all-missing correlation.
- truenortharms: does the runtime crawl GraphQL or HTML? reachable-count = 1125? full catalogUrls dedup.
- shooterschoice restock policy (store-api vs detail-page) — operator call, not mechanical.
- all hasWaf=false verdicts are audit-IP only — production-IP reconfirm before promotion.
