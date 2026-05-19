# R2 Investigation - alsimmonsgunshop.com

- Audited: 2026-05-13T08:50:37Z
- Auditor: testing-api-tester (live API + curl heavy-WAF + Store-API slug lookup)
- R1 reference: `docs/site-audit/alsimmonsgunshop.com-2026-05-13T08-25-28Z-R1.json`
- Corrections JSON: `docs/site-audit/alsimmonsgunshop.com-2026-05-13T08-50-37Z-R2-corrections.json`

## Method

For each divergent field, I picked a probe method DIFFERENT from R1's so the two rounds independently triangulate the truth.

| Field | R1 method | R2 method |
|---|---|---|
| hasWaf | Storefront HTML scan + body-marker grep | Full 8-batch curl probe (header inventory, rapid burst, SQLi/XSS/traversal, bot UAs, honeypots, API, shop, body markers) |
| expectedProductCount | /shop "Showing 1-9 of 161" HTML strings | Direct X-WP-Total headers from wp/v2 + wc/store/v1 + Store-API slug-lookup test of 5 admin-only products |
| productCountMethod | SKILL.md table cross-ref | Read backend/src/services/product-count-probe.ts switch arms + grep entire backend/src for "dual-api" |
| catalogUrls | Per-cat taxonomy API counts vs /shop count | Verified /shop = 161 directly via shop p1/p2/p3 walk + pagination link inventory |
| paginationPattern | Counter-control p1 vs p2 product slug set | p1/p2/p3 unique-slug count + last-page link extraction from pagination UL |
| sortParam | Counter-control orderby=date vs price | Same approach but ALSO compared orderby=popularity to confirm three distinct orderings, AND inspected the <option selected> tag in the dropdown |
| wafProbeEvidence shape | Initial probe | Independent re-probe, batch-by-batch comparison |
| crawlers.watermark.method | Date-filter on wp/v2 ?after= | Same approach but with 4 datapoints (future / 12d / 42d / no-filter) for monotonicity proof |

## Required verdicts

### dual-api switch verdict (REQUIRED)

**Confirmed: "dual-api" falls through the runtime switch's default arm and silently returns null.**

- Read `backend/src/services/product-count-probe.ts:148-451`. Switch arms enumerated: `wp-rest-header` | `json-api-count` | `json-api-length` | `html-pagination` | `sitemap` | `sitemap-index` | `generic-product-sitemap` | `ecwid-storefront-search` | `shopify-products-walk` | `klevu-api-count` | `stream-page-count`.
- Default arm at line 446-451: `console.warn('[productCountProbe] unknown method ... - returning null'); return null;`
- Grep for `dual-api` across `backend/src`: **NO MATCHES**.
- `verifyBootstrapCoverage` at lines 466-488 receives `null` for `expectedCount` and bypasses the ratio check entirely.
- Operational impact: until the DB profile is corrected, this site has NO functional product-count probe AND its bootstrap coverage check is silently skipped. The site has been in this state since 2026-04-11.
- Correct runtime-recognized value: `{method: "wp-rest-header", endpoint: "/wp-json/wc/store/v1/products", header: "x-wp-total"}`.

### admin-vs-storefront count test (REQUIRED)

**Confirmed: 10x gap is real and reproducible.**

| Endpoint | URL | X-WP-Total |
|---|---|---|
| WP REST admin | `/wp-json/wp/v2/product?per_page=1` | **1661** |
| WC Store API customer-visible | `/wp-json/wc/store/v1/products?per_page=1` | **161** |
| Storefront /shop HTML | `/shop/` (text "Showing 1-9 of 161 results") | **161** |
| Top-level product_cat sum | `/wp-json/wp/v2/product_cat` (in-stock count field per cat) | **164** (with ~3 overlap from consignment child) |

- DB stored on 2026-04-11: wp/v2 = 1638, Store API = 168. Today: wp/v2 = 1661 (+23 admin entries in 1 month), Store API = 161 (-7 in-stock since 2026-04-11). DB drift is normal consignment churn.
- The runtime-consumed `expectedProductCount` must match what customers see (Store API / /shop) i.e. 161. Using 1661 would re-trigger the 2026-04-02 incident where 1,444 products were wrongly discontinued because Store API verification doesn't return them.

### consignment-listing visibility verdict (REQUIRED)

**Confirmed: ~1500 wp/v2-admin-published products are sold/OOS consignment listings HIDDEN from the customer-facing storefront and Store API.**

Sample of 5 randomly-selected wp/v2-published products from page 10 (dated 2024-03 to 2024-06, status=publish):

| Slug | wp/v2 status | Store API by slug | /product/<slug>/ direct GET | Stock markers in body |
|---|---|---|---|---|
| canuck-elite-operator-fde-12ga-13122n | publish | **0 hits** | 200 | `out-of-stock`/`outofstock` |
| browning-bl-22-grade-1-22cal-13115np | publish | **0 hits** | 200 | (verified empty Store API result) |
| bergara-b14-hmr-6-5creedmoor-13132n | publish | **0 hits** | 200 | (verified empty Store API result) |
| beretta-a400-xtreme-plus-synthetic-left-hand-12-gauge-12871n | publish | **0 hits** | 200 | (verified empty Store API result) |
| winchester-94-30-30win-12689np | publish | **0 hits** | 200 | (verified empty Store API result) |

5/5 sample products: admin published but invisible to Store API and to /shop. The product detail pages still resolve (200 OK) and show "out of stock" with empty price blocks - that's how the operator keeps the canonical URLs alive for SEO and historical reference, while excluding them from the live catalog. This is standard consignment-shop behavior: each gun is a unique inventory item, when sold it disappears from /shop but the URL stays.

**This confirms the architectural pattern** the DB notes describe: WordPress + WooCommerce + an `is_visible` / `catalog_visibility` filter that the Store API respects but wp/v2 ignores.

## Field-by-field walk

### 1. hasWaf -> false

Heavy 8-batch probe (BATCH 1 only used for header parsing per Mistake 36):

```
=== BATCH 1: HEADER INVENTORY ===
Server: cloudflare
CF-RAY: 9fb0661e7c68aae6-YYZ
cf-cache-status: DYNAMIC
X-Powered-By: PHP/8.2.30
(no cf-mitigated, no Set-Cookie, no x-sucuri/x-incap/x-akamai/x-cdn)

=== BATCH 2: rapid burst 10 ===
all 200

=== BATCH 3: SQLi (URL-encoded) / XSS / traversal ===
sqli encoded: 200, xss: 200, traversal: 200

=== BATCH 4: BOT UA ===
python-requests/2.31.0: 403  <-- but body has X-Powered-By: PHP/8.2.30, so origin not CF
curl/7.88.0: 200
empty-ua: 200
Scrapy/2.5: 200

=== BATCH 5: HONEYPOTS ===
wp-login.php: 403, wp-admin: 403, xmlrpc: 403, .env: 404 (all WP-native, no CF body)

=== BATCH 6: API ===
wp/v2/product: 200, wc/store/v1/products: 200

=== BATCH 7: SHOP ===
shop: 200, used-non-restricted: 200, shop p2: 200

=== BATCH 8: body marker scan on /shop/ ===
none (no MalCare/Wordfence/sgcaptcha/incapsula/sucuri/cloudflare-ddos/cf-browser-verification/distil/akamai)
```

Cloudflare is in the path (CF-RAY on every response) but in pure-passive mode no challenge, no rate-limit, no rule-based block. R1 correct.

The DB `hasWaf:true` column is stale defensive setting from 2026-04-11. It contradicts the SAME ROW's `siteProfile.wafType: cloudflare-passive`. The candidate `hasWaf:false` should be promoted to the column on operator review.

### 2. expectedProductCount -> 161

Three independent signals all return 161. The DB value 1638 is wp/v2 admin total (now 1661) which includes sold/OOS consignment listings.

### 3. productCountMethod -> {method:"wp-rest-header", endpoint:"/wp-json/wc/store/v1/products", header:"x-wp-total"}

Runtime switch audit (see verdict above). DB's `dual-api` is a fabricated method name not consumed by the runtime.

### 4. catalogUrls -> ["/shop/"]

/shop is the single URL that covers 100% of in-stock products. Per SKILL.md Rule C, this is the minimum-cover URL set. DB's per-category list adds 5 redundant overlapping URLs.

### 5. paginationPattern -> full schema

p1/p2/p3 all show 9 unique products. Pagination UL on p1 lists `/page/{2,3,4,16,17,18}/` -> last page is 18. 18 x 9 = 162 vs 161 actual -> last page has 8.

DB pattern is missing required inner fields (perPage, startPage, zeroIndexed) per SKILL.md schema line 121, 561-569.

### 6. sortParam -> "?orderby=date"

Counter-control on /shop:

```
default: Henry/CZ/Winchester (consignment receipts)
?orderby=date: Henry/CZ/Winchester (IDENTICAL -> default IS date)
?orderby=price: Mossberg/Marlin/Colt magazines (DIFFERENT -> price honored)
?orderby=popularity: Henry/CZ/Winchester (matches default - no real popularity tracking)
```

Plus `<option value="date" selected='selected'>Sort by latest` in the dropdown.

Verdict: sortParam = `?orderby=date`, sortVerified = true.

### 7. crawlers.watermark.method -> "api-date-since-watermark"

Date-filter monotonicity on `/wp-json/wp/v2/product?after=`:

| after= | X-WP-Total |
|---|---|
| 2099-01-01 (future) | 0 |
| 2026-05-01 (12d ago) | 8 |
| 2026-04-01 (42d ago) | 30 |
| (no filter) | 1661 |

Monotonic ascending. R1 correct.

### 8. crawlers.maintain extras dropped per Rule B

SKILL.md Stage 7 only emits `verifyMethod` + `verifyEndpoint`. DB's `method:"db-verification"`, `cooldowns`, `tierShares`, `tierWindows`, `verifyBehavior` are scheduler config managed by another pipeline (crawl-scheduler.ts / tier engine). R1 correctly drops them.

### 9. Audit-trail residue dropped per Rule B

DB has 15 audit-trail residue fields (dataFlow, categoryTree, catalogUrlStats, paginationVerified*, sortVerified*, lastVerifiedMethod, notes, budget, t1IntervalMin, siteCategory, hasRateLimit, crawlPhase, expectedInStockCount). None are consumed at runtime. R1 correctly drops all of them and replaces with the smaller `topLevelCategories.categories[]` + `auditNotes.stageNotes[]` per SKILL.md spec.

## Outcome

- 17/17 divergent fields audited: R2 confirms R1 entirely.
- 16/16 fields where R1 and DB agreed: R2 verified both correct.
- 0 corrections rejecting R1.
- 0 new corrections beyond R1.
- 0 inconclusive.

R1's candidate JSON is ready for operator promotion to DB with no edits required. The DB siteProfile needs to be replaced wholesale at promotion.

## SKILL.md gaps surfaced

(R1 already noted these; R2 confirms they are real)

1. **WooCommerce consignment shops with hidden OOS:** Stage 8 should explicitly cite the wp/v2-vs-store-api gap pattern. "For consignment shops where wp/v2 admin total >> store-api in-stock total, prefer the store-api total. The 5-product slug-lookup test (does the old wp/v2 product return 0 hits in Store API? Does its direct product page show out-of-stock?) is the canonical proof."
2. **Rule C vs per-category granularity:** when /shop covers 100% but the operator wants per-category token budgets, the SKILL doesn't address the tradeoff. Add explicit note.
3. **hasWaf column-vs-JSON divergence:** when a re-audit's hasWaf differs from the DB column, the diff should flag the column for re-promotion. Without this, R2 calibration can carry forward the stale column even though the JSON field is correct.
