---
name: future-tasks
description: Deferred tasks and future optimizations from Batch B audit
type: project
---

## Task 1: WooCommerce Store-API-only fetchCatalogPage path — FIXED
**Discovered**: B21 tacord.com audit (2026-04-12)
**Status**: FIXED (2026-04-12 session 2, commit fda6e31). Standalone Store API branch added to woocommerce.ts. Activates when WP REST returns 401 or `storeApiOnly: true` in profile.

**Problem**: `WooCommerceAdapter.fetchCatalogPage()` tries WP REST v2 first. When it returns 401, the error is caught and falls through to Store API enrichment — but enrichment requires `wpIdToUrl.size > 0` (needs WP REST products first). There is NO standalone Store API catalog page fetch path. Result: `fetchCatalogPage` returns `{products: [], totalPages: N}` → `apiCrawlUsed=true` in catalog-crawler → HTML fallback never fires (Mistake 34 pattern). `api-date-since-watermark` is also non-functional.

**The Store API CAN do everything**: returns products with prices, stock, thumbnails, categories. Supports `?after=<date>` filter (monotonic verified on tacord: 6 products after 2026-01-01 vs 203 total). Supports `?orderby=date&order=desc`.

**Proposed fix**: Add a Store-API-only branch in `fetchCatalogPage()` that activates when WP REST returns 401 but Store API is accessible. ~40 lines in `woocommerce.ts`. Would re-enable `api-date-since-watermark` on tacord.com and any future gated-REST site.

**Currently affected**: tacord.com (B21). Workaround: `navigate-from-watermark` via HTML.

## Task 2: TownPost.ca (B22) adapter extraction fix — FIXED
**Discovered**: B22 townpost.ca audit (2026-04-12)
**Status**: FIXED (2026-04-12 session 2, commit fda6e31). Added `a[href*="/marketplace/"]` selector + trailing numeric ID extraction. Live-tested: 8 products extracted.

**Problem**: `GenericRetailAdapter.extractCatalogProducts` has ZERO selectors matching townpost.ca's HTML. The site uses Tailwind CSS utility classes (`rounded-lg`, `bg-card`) with no semantic product/listing classes. Ad links are plain `<a href="/marketplace/{town}/sporting-goods/{slug}/{numericId}">` with no wrapper element matching any existing selector.

**Required fix**: Add a selector to `generic-retail.ts` SELECTORS array that matches townpost's ad link pattern. Options:
1. Add `'a[href*="/marketplace/"]'` as a generic marketplace link selector
2. OR add `'.bg-card'` as a Tailwind card selector (may be too broad)
3. OR add site-specific selector via `siteProfile.customSelectors` field (if the adapter supports it)

**Also needed**: Title extraction from townpost — the `<a>` tags have no inner text (titles are in separate elements within the same card container). The `extractTitle` method needs to look for adjacent text or `og:title` on detail pages.

**Ad detail pages DO have**: `og:title`, `og:image`, `JSON-LD`, price (`$325.00`). These can be used for enrichment after link extraction.

**Sort concern**: Default order is NOT strictly newest-by-creation-ID. Page 1 has IDs 654750-1166922 (mixed range), page 2 has IDs up to 1166913. Sort appears to be by activity/bump date, not creation date — similar to gunpost.ca. For `navigate-from-watermark`, this means the watermark tracks "last seen active ad URL" not "newest created ad" — which is actually correct for classifieds (bumped/renewed ads should be re-checked).

## Task 3: API→HTML fallback gap fix (from hical.ca B13 discovery)
**Already recorded in**: `project_api_fallback_gap.md`
**Status**: Deferred — fix before production launch

## Task 5: LightSpeed custom/developer theme `.product-element` selector — FIXED
**Discovered**: gobles.ca onboarding (2026-04-12)
**Status**: FIXED (2026-04-12 session 2, commit fda6e31). Added `.product-element` to both SELECTORS arrays in generic-retail.ts. Verified on gobles.ca live HTML.

**Problem**: LightSpeed eCom has 3 known theme families with different product card classes:
- Classic: `.productborder` (already in `generic-retail.ts` SELECTORS)
- Nova: `.product-grid[class*="col-"]` (already in SELECTORS)
- Custom/Developer: `.product-element` (NOT in SELECTORS — gobles.ca uses this)

gobles.ca extraction works today because other generic selectors (`[data-product-id]`, `.card`, etc.) happen to match. But if a future LightSpeed site uses `.product-element` as the ONLY identifiable card class (without `data-product-id` or `.card`), extraction will fail silently.

**Fix**: Add `.product-element` to the SELECTORS array in `generic-retail.ts:60-88`. One line, zero risk.

**Affected sites**: gobles.ca (works today but fragile), any future LightSpeed site with custom/developer theme.

## Task 4: BigCommerce Stencil GraphQL token scrape (from Batch A)
**Already recorded in**: `project_next_tasks.md`
**Status**: Implemented for prophetriver.com. Other BC sites don't expose the token.

## Task 6: Pre-bootstrap probe gaps (from deep QA 2026-04-12 session 2)
**Discovered**: Deep QA cross-platform testing
**Priority**: Medium — probe works for basic sites, but misses platform-specific patterns

5 gaps found:
1. **WAF-blocked sites cascade-fail phases 3-6** — probe uses only static axios, no Playwright. Fix: add optional Playwright fallback in `safeFetch` when WAF detected.
2. **OpenCart category URL pattern not recognized** — sort/pagination URL regex doesn't match `?route=product/category&path=NNNN`. Fix: add OpenCart pattern to regex.
3. **LightSpeed `page2.html` suffix not tried** — fallback pagination candidates only try `?page=2` and `/page/2/`, not suffix-replace. Fix: add `page2.html` suffix fallback.
4. **Volusion `searching=Y` not added to sort test URLs** — Mistake 24 requires this flag. Fix: platform-specific sort URL builder for Volusion.
5. **Ecwid sort not tested via API** — Mistake 31 says sort is `sortBy: 'addedTimeDesc'` via POST body. Probe detects Ecwid but doesn't test sort. Fix: add Ecwid API sort probe.

## Task 7: MalCare cooldown doesn't cover WooCommerce adapter (from deep QA)
**Discovered**: Deep QA MalCare integration testing
**Priority**: Low — dlaskarms.com is the only MalCare site, and normal crawl rate (90s gaps) shouldn't trigger it

**Problem**: MalCare cooldown is in `http-client.ts:enforceDomainRateLimit()`. But `WooCommerceAdapter.fetchCatalogPage()` makes direct `axios.get()` calls to `/wp-json/` endpoints, bypassing `http-client.ts` entirely. If MalCare bans the IP, the cooldown blocks HTML path requests but WooCommerce API requests continue hitting the site.

**Fix options**:
1. Add cooldown check to WooCommerce adapter's axios calls
2. Route WooCommerce adapter through `fetchPageWithMeta` 
3. Accept the gap — normal crawl rate (40 req/hr) shouldn't trigger MalCare

## Task 8: WooCommerce Store-API-only misses OOS products (from deep QA)
**Discovered**: Deep QA cross-site WooCommerce testing (canadafirstammo.ca)
**Priority**: Low — by-design limitation, acceptable for the use case

**Problem**: Store API returns only in-stock products by default (`x-wp-total: 132` vs WP REST's `x-wp-total: 962` on canadafirstammo). The standalone Store-API-only path does NOT do the two-pass enrichment (default + `stock_status=outofstock`) that the dual-API path does.

**Fix**: Add `stock_status=outofstock` second pass to the standalone path. ~10 lines.

**Workaround**: Only use `storeApiOnly` when WP REST is truly 401-gated. If WP REST works, the dual-API path handles OOS correctly.
