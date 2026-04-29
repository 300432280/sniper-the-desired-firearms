---
name: api-to-html-fallback-gap
description: Critical gap — when WooCommerce/Shopify API permanently fails (401/closed), the HTML+Playwright fallback path is NEVER reached because apiCrawlUsed gets set to true on empty results
type: project
---

## The bug

When a WooCommerce site's API is permanently closed by the site owner (e.g. returns 401 on `/wp-json/wp/v2/product`), the catalog crawler silently stops discovering products. The HTML+Playwright fallback path (which uses catalogUrls) is **never reached**.

## How it was found

During the hical.ca (B13) audit, the user asked: "what if the HTML fallback actually happened one day, if the owner decides to close their API?" — which led to tracing the code path:

1. `WooCommerceAdapter.fetchCatalogPage()` calls `/wp-json/wp/v2/product`
2. API returns 401 → axios throws (401 not in `validateStatus: s === 200 || s === 307 || s === 403`)
3. Catch block at `woocommerce.ts:377-384` checks error message — 401 is not `timeout`/`ECONNREFUSED`/`WAF_COOKIE_FAILED` → falls through to "Other errors" → swallowed silently
4. `fetchCatalogPage()` returns `{ products: [], totalPages: undefined }` — NOT null, NOT a throw
5. `catalog-crawler.ts:286-291`: `catalogPage` is not null → does NOT break to HTML fallback
6. `catalog-crawler.ts:292`: `apiCrawlUsed = true` — the critical flag
7. `catalog-crawler.ts:295-308`: empty products → `cycleComplete = true` (non-WAF) or `consecutiveEmptyApi++` (WAF)
8. `catalog-crawler.ts:327`: `if (!apiCrawlUsed && ...)` → **false** → HTML fallback never fires
9. Site silently crawls 0 products every cycle, forever. No alert, no fallback.

## The root cause in the code design

The `apiCrawlUsed` flag at `catalog-crawler.ts:292` is set to `true` after the first non-null API response — but "non-null with 0 products" is semantically different from "API works and returned a real page." The flag conflates "the adapter supports API for this site" with "the API is currently returning valid data."

The HTML fallback was designed for the case where `fetchCatalogPage` returns `null` (design-time signal: "this adapter doesn't do API for this site"). It was NOT designed for the case where the API was working before but got permanently disabled at runtime.

## Affected sites

Any site using `WooCommerceAdapter` or `ShopifyAdapter` with `fetchCatalogPage()` — currently ~25 sites in the fleet. If ANY of them have their API closed/restricted in the future, the crawler silently stops without falling back to HTML.

## Proposed fix

Add a "consecutive empty API cycles" counter to the tier state. If a tier gets 0 products from the API for N consecutive cycles (e.g. N=3), force `apiCrawlUsed = false` on the next cycle so the HTML fallback fires.

Implementation sketch (~15 lines in `catalog-crawler.ts`):
```ts
// After the API crawl loop (line 323):
if (apiCrawlUsed && productsFound === 0 && pagesScanned > 0) {
  // API responded but returned nothing — increment empty-cycle counter
  tierState.consecutiveEmptyApiCycles = (tierState.consecutiveEmptyApiCycles || 0) + 1;
  if (tierState.consecutiveEmptyApiCycles >= 3) {
    console.log(`[CatalogCrawl] ${params.domain} T${tier}: API returned 0 products for ${tierState.consecutiveEmptyApiCycles} consecutive cycles, falling through to HTML`);
    apiCrawlUsed = false; // Force HTML fallback
    tierState.consecutiveEmptyApiCycles = 0; // Reset counter
  }
} else if (productsFound > 0) {
  tierState.consecutiveEmptyApiCycles = 0; // Reset on success
}
```

Also: add an SRE alert when `consecutiveEmptyApiCycles >= 2` so the operator knows the API is degrading before the fallback fires.

## Status
**FIXED** (2026-04-12 session 2, commit fda6e31). Consecutive-empty-API counter added to catalog-crawler.ts. After 3 consecutive cycles with 0 products from API, forces `apiCrawlUsed = false` so HTML fallback fires. Counter persists across scheduler ticks via TierCycleState. Code-reviewed and type-checked.

## Cross-references
- `backend/src/services/catalog-crawler.ts:266-327` — the API→HTML fallback logic
- `backend/src/services/scraper/adapters/woocommerce.ts:327-348` — the 401 swallowing
- Site B13 hical.ca — where this was discovered
- All WooCommerce + Shopify sites with `fetchCatalogPage()` are affected
