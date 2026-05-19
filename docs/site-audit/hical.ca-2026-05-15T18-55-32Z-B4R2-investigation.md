# hical.ca B4R2 Investigation

Run: `hical.ca-2026-05-15T18-55-32Z-B4R2`
Reviewing: `docs/site-audit/hical.ca-2026-05-15T18-34-35Z-B4R1.json`
DB reference: `backend/_audit_tmp/hical-db-profile.json` (lastVerified 2026-04-12)

## Scope

Three site-specific high-risk fields from the mission brief:

1. DB slug `/product-category/firearms/` vs live WP REST `firearms-canada` (id 143, 226 products)
2. `paginationPattern.template` absolute (`/shop/page/{N}/`, R1) vs suffix (`/page/{N}/`, DB) under `buildPaginatedUrl()` concatenation with per-category catalogUrls
3. R1 diff claim that runtime ALSO consumes `wafWorkaround.method: "cookie-cache"` for Incapsula/Sucuri/CF-active sites

## Method

- Plain `curl` baseline against the four candidate URLs (returned 844-byte Incapsula challenge as expected)
- `chromium.launch()` via project's playwright dep, iPhone UA, warmup `GET /`, then 800ms-spaced GETs of the four URLs
- Inside the warmed Playwright context, `fetch('/wp-json/wp/v2/product_cat?slug=...')` for both slugs
- Replayed `buildPaginatedUrl(baseUrl, 2, pattern)` from `catalog-crawler.ts:118-125` in pure Node to verify the concatenation rule
- `Grep wafWorkaround` (and synonyms) across `backend/src/**` to enumerate runtime consumers

## Findings

### 1. Slug staleness (CONFIRMED)

- Playwright (cookies present): `firearms` slug returns 200 with title **"Page not found - High Caliber Services Corp"** and 0 product anchors. WordPress 200-with-404-template pattern. `firearms-canada` returns 200 with title **"FIREARMS Archives - High Caliber Services Corp"** and 47 product anchors.
- WP REST `/wp/v2/product_cat?slug=firearms` returns `[]`. Same with `slug=firearms-canada` returns `[{id:143, count:226, name:"FIREARMS", slug:"firearms-canada"}]`.
- Conclusion: merchant renamed the firearms category after the 2026-04-12 DB capture. R1 captured current state correctly. If the firearms slug from DB were re-applied during R2, every crawl of that catalog URL would index 0 products.

### 2. paginationPattern.template absolute-vs-suffix (CONFIRMED - R1 has a working bug)

Code at `backend/src/services/catalog-crawler.ts:121-125`:

```ts
if (pattern?.type === 'path') {
  const template = pattern.template || '/page/{N}';
  const stripped = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${stripped}${template.replace('{N}', String(pageNum))}`;
}
```

Simulation with `baseUrl='https://hical.ca/product-category/firearms-canada/'`, pageNum=2:

- DB template `/page/{N}/` -> `https://hical.ca/product-category/firearms-canada/page/2/`
- R1 template `/shop/page/{N}/` -> `https://hical.ca/product-category/firearms-canada/shop/page/2/`

Playwright live verification:

- DB-template URL: HTTP 200, title "FIREARMS Archives - Page 2 of 15", 47 product anchors. **Works.**
- R1-template URL: HTTP **404**, title "Page not found", 0 product anchors. **Broken.**

Severity: blocker. With R1's template every page>=2 of every per-category catalogUrl 404s; the catalog crawler would only ever ingest the first 16 products per category (perPage=16).

### 3. wafWorkaround runtime consumption (R1 DIFF CLAIM IS FALSE)

R1 diff item #2 (lines 64-67) asserts: *"the production crawler's runtime path (http-client.ts, waf-cookie-manager) ALSO consumes `wafWorkaround.method: 'cookie-cache'` for Incapsula / Sucuri / cf-active sites."*

Verification:

- `Grep wafWorkaround` in `backend/src/**` -> **0 matches**.
- `Grep "cookie-cache"` in `backend/src/**` -> 0 matches.
- `Grep "cookieCache"` in `backend/src/**` -> 0 matches.
- `Grep "getCachedCookies|setCachedCookies|cookieJar|warmupCookies"` -> 0 matches.
- Only matches for `wafWorkaround` are in `backend/_audit_tmp/*.json` (profile dumps) and `backend/scripts/_apply-siteprofile-corrections-batch-b-2026-05-12.js` (operator correction one-off).
- Runtime WAF-driven behavior is gated on the boolean `hasWaf` only: `catalog-crawler.ts:258,290,293,306,390,435,447`, `product-count-probe.ts:135`, `product-verifier.ts:137`, `priority-engine.ts:92`. The playwright-fetcher path is invoked from those callsites.

Verdict: `wafWorkaround` is operator audit-trail residue stored in the DB siteProfile JSON column. It is NOT consumed at runtime. R1's omission is correct. The SKILL.md harness gap #2 in R1's diff is based on a wrong premise.

## Corrections summary

| # | Field | Action | Severity |
|---|---|---|---|
| 1 | `paginationPattern.template` | `/shop/page/{N}/` -> `/page/{N}/` | blocker |
| 2 | `wafWorkaround` | keep R1 omission (DB field is metadata only) | documentation-only |
| 3 | `catalogUrls` firearms slug | keep R1 `firearms-canada` | blocker if reverted to DB |
| 4 | `crawlers.watermark.dateFilterField` | `after` -> `modified_after` | regression-risk |

Detail in `hical.ca-2026-05-15T18-55-32Z-B4R2-corrections.json`.

## Notes / limitations

- Did not live A/B test userAgentOverride (iPhone vs desktop Chrome). Both walked past Incapsula in the warmed Playwright session. DB iPhone UA is documented playbook for Incapsula/Sucuri.
- Did not walk-verify `/product-category/all-products/` deduplication. DB walk-verified it as a redundant umbrella; R1 kept it on conservative "don't drop by name" grounds. Defer to operator.
- WAF re-verify from production crawler IP is out of scope.
