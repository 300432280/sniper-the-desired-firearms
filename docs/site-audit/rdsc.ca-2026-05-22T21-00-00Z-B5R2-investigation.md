# B5R2 Investigation — rdsc.ca — 2026-05-22T21:00:00Z

Adversarial Round 2 over R1 candidate `rdsc.ca-2026-05-22T20-00-00Z-B5R1.json` vs DB snapshot lastVerified 2026-04-08.

## Method
Live curl with realistic UA, 800ms+ delay between requests. NO DB writes. Independent re-verification (not re-reading R1's evidence). Different angle per divergence:
- Static GET + HEAD instead of R1's batch probe for hasWaf
- Direct boundary test (`p=195` / `p=196` math) for perPage cap
- Three-outcome sort honor test (default vs sort=new vs counter-control price_asc)
- Multi-path resolution test for productUrlSchemes
- Source-code grep of VALID_METHOD_NAMES for productCountMethod silent-disable claim

## Per-divergence results

### 1. hasWaf — R1 CORRECT
`HEAD /new-products.html` returns 200 immediately with `server: cloudflare`, `cf-cache-status: DYNAMIC`, `CF-RAY: a000d5f9d88f1117-YYZ`. No challenge HTML, no managed-challenge JS, no rate-limit headers. All 9 category GETs return 200 without intervention. Cloudflare is in passive proxy mode here — `cloudflare-passive` metadata is correct but `hasWaf=true` is wrong per skill B10 (no behavioral block). DB has stale `hasWaf=true` from earlier mis-classification; R1's flip to `false` is right.

### 2. perPage 24 vs 48 — R1 CORRECT
Three independent evidences:
- `?product_list_limit=48` page 1 renders exactly 48 `<li class="item product">`
- `?product_list_limit=48&p=195` renders 31 (last page partial)
- `?product_list_limit=48&p=196` renders 0
- Math: 194 × 48 + 31 = 9343 = total. Perfect closure.

DB's `perPage=24` is Magento page-1 default, not the verified maximum. R1's 48 halves request count.

### 3. productCountMethod silent-disable — R1 CORRECT
Read `backend/src/services/product-count-probe.ts:110-122` directly:
```
export const VALID_METHOD_NAMES = [
  'wp-rest-header', 'json-api-count', 'json-api-length',
  'html-pagination', 'sitemap', 'sitemap-index',
  'generic-product-sitemap', 'ecwid-storefront-search',
  'shopify-products-walk', 'klevu-api-count', 'stream-page-count',
] as const;
```
`magento2-toolbar-count` is NOT in the 11 canonical. At runtime:
- L186 `validateMethod(m)` THROWS (`unknown product-count method: "magento2-toolbar-count"`)
- L481-485 outer try/catch swallows the throw, logs error, returns `null`
- `verifyBootstrapCoverage()` at L494-516 receives `expectedCount=null` -> `ratio=null` -> `isAcceptable=true` (L513: `isAcceptable = expectedCount === null || ratio === null || ratio >= COVERAGE_THRESHOLD`).

Net effect: coverage gate disabled for any cycle. Bootstrap can complete with arbitrary DB count and never trip the 95% threshold. R1's fix (canonical `html-pagination` + toolbar selector) restores the gate without needing a new method name.

Verified the selector R1 proposed: `<span class="toolbar-number">9343</span>` is the 3rd `.toolbar-number` span inside `id="toolbar-amount"` (there's exactly one such ID; structure is `<span class="toolbar-number">1</span> <span>of</span> <span class="toolbar-number">9343</span>` — `.last()` picks the right one). With `perPage:1` and default regex `(\d+)` the probe returns 9343.

### 4. catalogUrls coverage — R1 PARTIALLY CORRECT
Live walk of all 9 categories matches R1 exactly:

| slug | toolbar count |
|---|---|
| firearms-ammunition | 1757 |
| optics-mounts | 1188 |
| handgun-parts | 1143 |
| semi-auto-rifle-parts | 1851 |
| precision-rifle-parts | 1116 |
| lever-action-parts | 245 |
| shotgun-parts | 212 |
| gear-kit | 1216 |
| clean-maintain | 272 |
| **SUM** | **9000** |

`/new-products.html` toolbar = 9343. The 343-product delta is products tagged only in special/manufacturer taxonomies, not in any top-level category. Per `feedback_catalog_urls_full_coverage.md` catalogUrls must reach 100%. R1's 9-cat spine reaches 96.3%, missing 343 products.

Two operator-acceptable resolutions:
- **A (additive)**: R1's 9 + `/new-products.html` as 10th URL, dedup at runtime via product slug
- **B (single)**: keep DB's `/new-products.html` only (simpler, deterministic, 100% by construction)

Both valid. R1's 9-cat-only choice violates the 100% rule.

### 5. expectedProductCount — R1 CORRECT
Live toolbar = 9343. DB stored 9089 (lastVerified 2026-04-08, +254 drift over ~6 weeks). Math closure via pagination cap cross-validates.

### 6. sortParam — R1 EXPLICIT, DB COMPACT, BOTH WORK
Three-outcome verified:
- Default first 3 slugs: `ruger-10-22-carbine`, `derya-arms-tm22-pro`, `cz-arms-cz-600-mdt`
- `?product_list_order=new&product_list_dir=desc` first 3: identical
- `?product_list_order=price&product_list_dir=asc` counter-control: `cadex-defence-cordura`, `magpul-qd-swivel-socket`, `smith-wesson-m-p40-magazine` (differs)

Magento toolbar config `orderDefault:new, directionDefault:desc` means omitting `product_list_dir` is functionally equivalent. R1's explicit form is more defensive against future merchant config changes; DB's compact form works.

### 7. productUrlSchemes — R1 WRONG (fabricated `-<id>` suffix)
Sample product `ruger-10-22-carbine-16-1-carbon-wrapped-barrel-moe-x-22-stock-22lr.html` resolves 200 OK at THREE paths via Magento `url_rewrite` table:
- `/ruger-10-22-carbine-...-22lr.html` (root)
- `/firearms-ammunition/ruger-10-22-carbine-...-22lr.html` (category)
- `/new-products/ruger-10-22-carbine-...-22lr.html` (aggregator)

R1 claims canonical = `/<slug>-<id>.html`. **The slug ends `.html` with NO numeric ID suffix.** This is a fabrication — likely R1 over-generalized from other Magento sites that store SKU ID in the URL. Correct schema:
```
canonical:      /<slug>.html
sitemapForm:    /<slug>.html
categoryForm:   /<category-path>/<slug>.html
aggregatorForm: /new-products/<slug>.html
joinOn:         url-slug-only (last segment)
```
Matters because any dedup logic that strips `-<id>.html` would lose slug suffix data (e.g. `-22lr` calibre suffix) and over-merge distinct products.

### 8. captchaType — R1 informational only, CORRECT
`Magento_ReCaptchaFrontendUi` JS present, but gates only the customer-login popup. Catalog GETs return 200 without any captcha solve. R1's `hasCaptcha=false` + `captchaType:"recaptcha-v2"` informational is right.

### 9. wafProbeEvidence shape — cosmetic
DB shape (header-names array) is cleaner. R1 shape (3 distinct CF-RAY values) is noisier but acceptable. Same underlying evidence.

### 10. Sitemap drift
R1 said sitemap leaves = 9234. Live sitemap-1-1.xml + sitemap-1-2.xml = 11,082 loc tags, 10,938 ending `.html`. Not material — sitemap is operator triage info only, not the productCount source. Sitemap > toolbar is expected (URL rewrites duplicate the same SKU under multiple paths).

## Verdict summary

| Category | Count | Fields |
|---|---|---|
| R1 fully correct | 11 | hasWaf, platform, perPage, paginationPattern.perPage, expectedProductCount, productCountMethod, sortParam (both work), captchaType, topLevelCategories, paginationPattern.firstPageHasParam/startPage/zeroIndexed |
| R1 partially correct | 2 | catalogUrls (96.3% not 100% coverage), wafProbeEvidence cfHeadersDetected shape |
| R1 wrong | 1 | productUrlSchemes (the `-<id>.html` suffix is fabricated) |

## Blockers
None.

## What R3 should attack
- Re-attack R1's `productUrlSchemes` claim against actual sampled HTML — if R3 can find any product URL containing a numeric ID segment, the schema is salvageable; otherwise R1's claim is dead.
- Re-walk the 343-product delta with an independent method (sitemap intersection, brand-taxonomy walk) to confirm whether operator should pick option A (additive) vs B (single aggregator).
- Re-read product-count-probe.ts:481-485 to confirm the silent-disable path is exactly as described (throw -> catch -> null -> coverage isAcceptable=true).
