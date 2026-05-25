# B5R3 Counter — rdsc.ca — 2026-05-22T23:00:00Z

Adversarial attack on R2 corrections. Independent live evidence with 800ms+ delays.

## Priority attacks

### A. productCountMethod — R2 UPHELD
Read `backend/src/services/product-count-probe.ts:110-122` directly:
```
export const VALID_METHOD_NAMES = ['wp-rest-header','json-api-count','json-api-length',
  'html-pagination','sitemap','sitemap-index','generic-product-sitemap',
  'ecwid-storefront-search','shopify-products-walk','klevu-api-count','stream-page-count'] as const;
```
`magento2-toolbar-count` absent. L129-136 `validateMethod` throws on unknown; L186 calls it inside the outer try (L182-) → throw caught at L481-485 → returns null → `verifyBootstrapCoverage` sees expectedCount=null → `isAcceptable=true` (coverage gate disabled). R2's `html-pagination` replacement with selector `#toolbar-amount span.toolbar-number:last-child` + `perPage:1` + default `(\d+)` regex parses live HTML `<span class="toolbar-number">9343</span>` correctly via L222-229 (`.last()` then `parseHtmlPaginationCount`). R2 CORRECT.

### B. perPage 48 — R2 UPHELD (broadened 5x)
Five distinct categories with `?product_list_limit=48`, each returned exactly 48 `class="item product"` matches: firearms-ammunition, optics-mounts, handgun-parts, gear-kit, clean-maintain (272 total but page 1 still rendered 48). Pagination cap re-verified live: p=195→31 items, p=196→0 items, 194×48+31=9343 = toolbar. R2 CORRECT.

### C. hasWaf=false — R2 UPHELD (sustained walk)
10 checkpoint GETs at p=1,10,25,50,75,100,125,150,175,195 with single UA, no cookies, 800ms+ delay: 10/10 HTTP 200. HEAD response: `server:cloudflare`, `cf-cache-status:DYNAMIC`, no challenge, no rate-limit headers. Cloudflare passive. R2 CORRECT.

### D. catalogUrls 9 cats summing to 9000 — R2 UPHELD
Re-walked toolbar on 5 sampled categories live: 1757, 1188, 1143, 1216, 272 — match R2 exactly. Delta 9343-9000=343 products in brand/special taxonomies. R2's call (additive 10th URL OR keep DB aggregator) stands.

### E. productUrlSchemes — R2 UPHELD
Grepped all `-[0-9]+\.html` patterns in page-1 hrefs. Only matches: `-419.html`, `-51.html` — brand-listing pages (Area-419 at `/optics-mounts/area-419.html`), NOT products. Actual product URLs (with `data-product-id="2175480"`) carry NO numeric ID suffix. R1's `-<id>.html` schema is fabricated. R2 CORRECT.

## Verdict

| R2 claim | R3 result |
|---|---|
| productCountMethod silently disables coverage | UPHELD (source grep + control-flow trace) |
| perPage=48 honored | UPHELD (5 cats + boundary math) |
| hasWaf=false | UPHELD (10-checkpoint walk) |
| catalogUrls 9-cat 96.3% / aggregator 100% | UPHELD (live counts match) |
| productUrlSchemes has NO `-<id>` suffix | UPHELD (brand digits only) |

R2's investigation withstands the adversarial round. Operator may proceed with R2-corrected JSON.

## Files
- d:\Projects\FIREARM-ALERT\backend\src\services\product-count-probe.ts (110-122, 129-136, 182-186, 222-229, 481-516)
- d:\Projects\FIREARM-ALERT\docs\site-audit\rdsc.ca-2026-05-22T21-00-00Z-B5R2.json
- d:\Projects\FIREARM-ALERT\docs\site-audit\rdsc.ca-2026-05-22T21-00-00Z-B5R2-investigation.md
