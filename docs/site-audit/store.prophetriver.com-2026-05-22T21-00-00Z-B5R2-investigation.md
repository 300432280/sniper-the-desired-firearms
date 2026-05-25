# B5R2 Investigation - store.prophetriver.com (2026-05-22T21:00Z)

Round 2 adversarial audit. Method: LIVE HTTP probing (different from R1's claim-cross-check). 800ms inter-request delay. No DB writes.

## Priorities run

1. `productCountMethod.method` shape gate (B6) - runtime allowlist evidence
2. `expectedProductCount` 13766->13974 drift - re-walk sitemap pages
3. `hasWaf` B10 trap - rapid-burst confirmation
4. `perPage` cap - query `?limit=` at 50/100/250

Plus opportunistic: sort default cross-check, search URL live test, `/handguns/` confirmation.

---

## Verdict 1: `productCountMethod.method` - CANDIDATE-CORRECT (high)

Runtime evidence (`backend/src/services/product-count-probe.ts:110-137`):

```
VALID_METHOD_NAMES = [
  'wp-rest-header','json-api-count','json-api-length','html-pagination',
  'sitemap','sitemap-index','generic-product-sitemap',
  'ecwid-storefront-search','shopify-products-walk','klevu-api-count','stream-page-count'
]
```

DB's `"sitemap-xml"` is NOT in the list. `validateMethod(m)` is called at line 186 before the switch. It throws:

```
[productCountProbe] unknown product-count method: "sitemap-xml" (valid: ...)
```

Caller catches -> returns `null` -> coverage gate disabled. This is a silent-failure trap: nothing emits a warning unless the operator manually inspects logs.

Canonical `sitemap-index` interface (`product-count-probe.ts:39-42`):

```ts
interface SitemapIndexMethod {
  method: 'sitemap-index';
  urls: string[];     // flat array of sitemap URLs
}
```

Switch case (L240-252) iterates `m.urls` as strings. DB's nested `{pages: [{url, urls: number}]}` shape would coerce to `'[object Object]'` and 404.

## Verdict 2: `expectedProductCount` 13974 - CANDIDATE-CORRECT (high)

Live sitemap-walk at 2026-05-22T21:00Z:

| URL | HTTP | `<loc>` count | cf-ray |
|---|---|---|---|
| `/xmlsitemap.php?type=products&page=1` | 200 | 10,000 | present |
| `/xmlsitemap.php?type=products&page=2` | 200 | 3,974 | present |
| `/xmlsitemap.php?type=products&page=3` | 404 | 0 | present |

Total = 13,974 exact, matches candidate. DB's 13766 (dated 2026-04-08) is +208 below live -> ~4.7 products/day net growth over 44 days. No coverage-gap signal; refresh only.

## Verdict 3: `hasWaf=false` - CANDIDATE-CORRECT (high)

10-request rapid burst on homepage `/` at 800ms spacing:

```
statuses = [200,200,200,200,200,200,200,200,200,200]
all200 = true
cfRayAlwaysPresent = true
challenges = 0
```

Combined with R1's heavy-8-batch (XSS=400 server-level, SQLi=200 no-rule-fired, honeypots=403 platform-not-WAF, all UAs 200): no active blocking. `wafType: cloudflare-passive` is informational. B10 rule fires: `column_hasWaf` must flip with the reclassification. Current DB has `hasWaf=true` AND `wafType='cloudflare-passive'` - internally inconsistent.

Downstream cost of leaving the column on: `product-count-probe.ts:172-180` triggers `ensureCookies` Playwright path; `perPage` is forced to the throttle floor (20). Both unnecessary.

## Verdict 4: `perPage=100` cap - CANDIDATE-CORRECT (high)

Live `/ammunition/?limit=N`:

| `limit=` | HTTP | card count |
|---|---|---|
| 50 | 200 | 50 |
| 100 | 200 | 100 |
| 250 | 200 | 100 (silent cap) |

Hard cap is 100 (BC Stencil platform default). Candidate's `perPage:100` is correct; `paginationPattern.perPage:100` correctly mirrors it.

## Verdict 5: sort default - CANDIDATE-CORRECT (high)

Live `/ammunition/` 3-outcome test:

| URL | first 5 product IDs |
|---|---|
| `/ammunition/` (default) | `67365, 67354, 67353, 67348, 67197` |
| `/ammunition/?sort=newest` | `67365, 67354, 67353, 67348, 67197` (identical) |
| `/ammunition/?sort=alphaasc` | `34800, 35736, 36996, 34806, 33632` (different) |

Default == newest, alphaasc is different => sort param honored AND default is newest. IDs monotonically descending integers (67365 > 67354 > 67353 > 67348 > 67197) - usable as sourceId. `crawlers.watermark.method:"navigate-from-watermark"` is correct.

## Verdict 6: searchUrl - DB WRONG (high), CANDIDATE OMITS

Live: `GET /search?q=rifle` -> HTTP 404. `GET /search.php?search_query=rifle` -> HTTP 200.

DB's `siteProfile.searchUrl: "/search?q={keyword}"` would 404 in production. Candidate's choice to omit was safe; the correct fix on promotion is `/search.php?search_query={keyword}` (BC Stencil canonical).

robots.txt `Disallow: /search?` is present but applies to search-engine indexers, not the retail crawler.

## Verdict 7: `/handguns/` exclusion - CANDIDATE-CORRECT (high)

Live: HTTP 200, 0 product cards. Confirms landing-only.

---

## Inconclusive

- `catalogUrls` case (`/Rifles/` vs `/rifles/`): both 200; did not re-walk homepage HTML this round. Cosmetic, runtime case-insensitive on BC.

## Promotion checklist

- Promote candidate as-is.
- DB column flip: `column_hasWaf: true -> false`.
- Also fix on promotion:
  - `siteProfile.searchUrl` -> `/search.php?search_query={keyword}`
  - `siteProfile.productCountMethod` -> full shape replace (drop nested `pages[]`, set `urls: string[]`)

No blockers. Promotion-ready.
