# nordicmarksman.com — B4 Validation (POSITIVE + ADVERSARIAL)

Date: 2026-05-21
Site: nordicmarksman.com (BigCommerce Stencil, legacy `.php` URLs)
Post-fix snapshot: `_audit_tmp/batch4-validation-2026-05-19/nordicmarksman.com-POSTFIX.json`

Canonical host: `nordicmarksman.com` (www → apex 301). All probes below used the apex; `categories.php?limit=N` and `xmlsitemap.php` both respond directly on the apex with HTTP 200.

## Per-fix Verdicts

| # | Fix | Verdict | Evidence |
|---|---|---|---|
| 1 | `column_hasWaf` flipped true → false | **PASS** | POSTFIX column = `false`. Profile JSON still carries inner `hasWaf: true` + `wafType: "cloudflare-passive"` / probe evidence — that is operator audit-trail residue, harmless because the runtime crawler routes on the DB column (`hasCaptcha: false`, all-200 rapid burst proves it's passive only). No action needed for this validation round; consider squashing the inner field on next pass. |
| 2 | `catalogUrls = ['/categories.php']` | **PASS** | `?limit=2500&page=1` → 2500 cards; `page=2` → 2204 cards; `page=3` → HTTP 200 but 0 product cards (categories chrome only, productGrid empty). Crawler walks until empty page so the page-3 200 is benign. Union = **4704 / 4761 ≈ 98.80%**, comfortably above the 95% COVERAGE_THRESHOLD. |
| 3 | `perPage = 2500` + `paginationPattern.perPage = 2500` | **PASS** | Page 1 returned exactly 2500 product cards (server honors `limit=2500`). Two pages cover the whole catalog. |
| 4 | `expectedProductCount = 4761` | **PASS** | Sitemap page 1 `<loc>` count = **3023**, sitemap page 2 `<loc>` = **1738**, sum = **4761** — exact match to the stored value. |
| 5 | `productCountMethod` reshape to `sitemap-index` + `urls[]` | **PASS** | `product-count-probe.ts` switch confirmed: `case 'sitemap'` (lines 232-238) reads scalar `m.url`; `case 'sitemap-index'` (lines 240-252) iterates `m.urls`. The corrected `{method:'sitemap-index', urls:[...]}` shape now matches the consumer. Old broken shape `{method:'sitemap', sitemapUrls:[...]}` would have hit `case 'sitemap'` with `m.url === undefined`, fetched `${origin}undefined`, and silently returned null. Resolved. |
| 6 | `sortParam = '?sort=newest'`, `sortVerified = true` | **PASS** | `categories.php?limit=2500&sort=newest&page=1` first 5 `data-product-id`: **22065, 22064, 22063, 22062, 22061** (monotonic descending = newest-first). Default `categories.php?limit=20` first 5: **16967, 17023, 21924, 19527, 22065** (unordered). Reorders confirmed; suitable as watermark sort. |
| 7 | `searchUrl = '/search.php?search_query={keyword}'` | **PASS** | `GET /search.php?search_query=glock` → HTTP 200, 264907 bytes, 12 `card-title` results on page 1, `link rel="next" href="/search.php?page=2&section=product&search_query=glock"` confirms paginated results, and the Glock brand category appears in the filter nav. Search is live and keyword-driven. |

## Adversarial findings

- **Page 3 returns 200, not 404.** BigCommerce serves the categories chrome for any page number; the productGrid is just empty. Generic-retail catalog walk terminates on empty product extraction (worker stops when `products.length === 0`), so this is not a stop-condition bug — but it is a brittle assumption for any future stop-on-404 heuristic. No action required for this fix set.
- **Inner `siteProfile.hasWaf` still `true`** while DB column is `false`. Crawler routes on the column, so this is cosmetic. Flagged for follow-up cleanup; not blocking.
- **www → apex 301** on every endpoint. The site profile stores `domain: "nordicmarksman.com"` (apex) so runtime URLs are built correctly; no impact.

## Summary

**All 7 fixes PASS.** Coverage 98.8%, expectedProductCount exact, productCountMethod now structurally compatible with the probe switch, sort verified live, search verified live. Ship.
