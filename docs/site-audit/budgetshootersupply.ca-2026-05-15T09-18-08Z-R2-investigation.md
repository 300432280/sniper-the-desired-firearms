# R2 Live Investigation - budgetshootersupply.ca

Run: 2026-05-15T09-18-08Z (R2 - fresh agent, different methods than R1)
Inputs:
- R1 candidate: `docs/site-audit/budgetshootersupply.ca-2026-05-15T09-08-04Z-R1.json`
- R1 diff: `docs/site-audit/budgetshootersupply.ca-2026-05-15T09-08-04Z-R1-diff.md`
- DB siteProfile: `MonitoredSite(budgetshootersupply.ca).siteProfile` (lastVerified 2026-04-11)

## Method-vs-method strategy

R1 used the modular probe + skill harness. R2 uses raw curl HEAD requests against three independent product-count signals (WP REST anonymous, WC Store API with combined stock filter, WordPress sitemap union), direct line read of `woocommerce.ts:337`, and a comparison of static HTML at the `/products/` parent vs. a `/product-category/.../` leaf. Where R1 inferred WAF status from heavy-probe evidence, R2 ran a policy-compliant 10-burst at 800ms intervals against the actual crawler URL space and the operational Wordfence behavior on normal GETs.

## Required deliverables

### 1. API-only-mode coverage proof

The R1 candidate asserted that `catalogUrls=['/products/']` is wrong because the HTML crawl path needs 100% leaf coverage. The truth, confirmed by reading `backend/src/services/catalog-crawler.ts` lines 299-358 and `backend/src/services/scraper/adapters/woocommerce.ts` line 340:

- The WooCommerce adapter's primary discovery hits `${origin}/wp-json/wp/v2/product` with `per_page=100&page=N&orderby=date|modified`.
- `apiCrawlUsed=true` once it returns any products; the HTML branch at line 358 (`if (!apiCrawlUsed && adapter.extractCatalogProducts)`) is then never entered.
- Live HEAD against `/wp-json/wp/v2/product?per_page=1` returns `x-wp-total: 2809`.
- Same count cross-confirmed by `GET /wp-json/wc/store/v1/products?per_page=1&stock_status[]=instock&stock_status[]=outofstock` -> `x-wp-total: 2809`.
- Same count cross-confirmed by sitemap union: product-sitemap.xml = 1001, product-sitemap2.xml = 1000, product-sitemap3.xml = 808, total = 2809.

Three independent denominators agree on 2809. Coverage = 100% via WP REST. The HTML branch is unreachable while the API responds; R1's 167-leaf catalogUrls is correct-but-unused work for this site.

### 2. Wordfence rapid-burst behavior verdict

Verdict: **Wordfence is installed but does NOT operationally block the crawler**. Evidence:

- 10 sequential `GET /wp-json/wc/store/v1/products?per_page=1&page=N` at 800ms intervals returned `[200, 200, 200, 200, 200, 200, 200, 200, 200, 200]`. No 429, no 503, no `cf-mitigated`, no challenge.
- `GET /products/` with default Chrome UA -> 200, `Server: Apache`, zero waf vendor headers.
- `GET /wp-json/wp/v2/product?per_page=1` with crawler-style UA `firearm-alert/1.0` -> 200 (no UA blocking).
- `GET /?p=1' OR 1=1--` -> 403. Rule-selective response targeting attack payloads, NOT crawler URL space.
- DB profile's `wafProbeEvidence: "All UAs return 200. Rapid burst 10x no throttle."` matches my live re-test exactly.

R1 set `hasWaf=true` defensively because Wordfence CSS/JS markers are present in HTML and SQLi/XSS probes returned 403. That is the wrong inference: marker presence does not equal operational blocking. Recording `hasWaf=true` forces the runtime onto Playwright + WAF-cookie paths (watermark-crawler.ts:79 hasWaf branch; woocommerce.ts:343 30s timeout) for no operational benefit. Match DB: `hasWaf=false`.

### 3. `modified_after` hardcode re-verification at woocommerce.ts:337

Read of `backend/src/services/scraper/adapters/woocommerce.ts` lines 330-345 (verbatim):

```
let resp = await axios.get(`${origin}/wp-json/wp/v2/product`, {
  params,
  headers,
  timeout: options?.hasWaf ? 30000 : 15000,
  validateStatus: (s) => s === 200 || s === 307 || s === 401 || s === 403,
});
```

with `params` built at lines 331-338:

```
const params: Record<string, any> = {
  per_page: perPage, page,
  orderby: hasDateFilter ? 'modified' : 'date',
  order,
  _embed: 'wp:featuredmedia,wp:term',
};
if (options?.dateAfter) params.modified_after = options.dateAfter;
if (options?.dateBefore) params.modified_before = options.dateBefore;
```

Line 337 hardcodes `modified_after` (not `after`). Line 333 toggles `orderby` to `modified` when a date filter is present. Live confirmation:
- `modified_after=2026-04-01` -> x-wp-total 1068
- `after=2026-04-01` -> x-wp-total 78 (publish-date semantics, much narrower)
- monotonicity: `modified_after=2026-05-01 -> 444`, `2026-05-10 -> 196`, `2026-05-14 -> 22`. Strictly decreasing.

DB's `apiDateFilter.param: "modified_after"` is correct. R1 did not carry this field (Rule B residue per the skill); the runtime uses it regardless.

## Corrections summary

7 material divergences identified in R1 diff. All 7 corrections proposed in `*-R2-corrections.json`:

1. `expectedProductCount`: **2809** (both R1's 1577 and DB's 2756 are wrong; live count is 2809 from three independent signals)
2. `productCountMethod.endpoint`: `/wp-json/wp/v2/product` (match DB)
3. `hasWaf`: `false` (match DB)
4. `wafType`: `null` (match DB)
5. `catalogUrls`: `['/products/']` (match DB - API-only runtime mode)
6. `paginationPattern.type`: `api-page` (match DB)
7. `paginationPattern.template`: `page={N}` (match DB)

Plus 2 informational:
- `searchUrl`: `/?s={keyword}&post_type=product` (preserve DB; R1 omitted)
- `apiDateFilter.param`: `modified_after` (preserve DB; line 337 re-verified)

## Confidence overview

- High (7): `expectedProductCount`, `productCountMethod.endpoint`, `wafType`, `catalogUrls`, `paginationPattern.{type,template}`, `apiDateFilter.param`
- Medium-high (1): `hasWaf`
- Medium (2): `searchUrl`, `topLevelCategories`

## Direction

Out of 7 material divergences, 6 fall on the DB side and 1 (expectedProductCount value) requires correcting BOTH sides to the live 2809. R1 overcorrected toward HTML-mode semantics; DB was directionally right but stale on the count.
