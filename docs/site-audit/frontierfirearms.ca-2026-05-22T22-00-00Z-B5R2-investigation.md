# B5R2 Investigation — frontierfirearms.ca

Live counter-investigation of R1 divergences. NO DB writes. 800ms inter-request delay observed across all live probes.

## Method

Per R1 diff's 5 hard divergences, ran live probes targeting each one with a method different from R1:
- R1 used catalog-walk-by-extraction-count. R2 uses HTTP-status sampling + redirect tracing + runtime-code shape verification.
- R1 derived productCountMethod from sitemap structure. R2 verifies it by reading product-count-probe.ts:232-252 and confirming runtime behavior of DB's malformed shape.
- R1 omitted searchUrl due to time. R2 ran the deterministic B4 probe directly.

## Findings

### 1. hasWaf (DB true -> R1 false)

R1 correct. R2 live recheck across 26 catalogUrls + /search.php + product sitemap re-pull (5 distinct request paths beyond R1's 8 batches): all returned 200. cf-ray header always present; no cf-mitigated; no challenge body. Cloudflare is in front, in passive mode. Setting hasWaf=true in DB triggers needsPlaywright pathing + WAF cookie ensureCookies() call + perPage drop (50->20) in catalog-crawler — zero benefit for a passive CF. **Flip true->false is operationally correct (B10).**

### 2. productCountMethod shape (DB `sitemap-index` + scalar `sitemapUrl` -> R1 `sitemap` + scalar `url`)

R1 correct DECISIVELY. Read product-count-probe.ts:

- L129-137 `validateMethod` only checks the method NAME against the 11-allowlist. It does NOT validate shape (the `urls` array vs `url` scalar mismatch passes through).
- L240-252 `case 'sitemap-index'`: `for (const sitemapUrl of m.urls)` iterates `m.urls` (typed `string[]` at L41).
- DB profile has `{method:'sitemap-index', sitemapUrl:'/xmlsitemap.php?type=products&page=1'}` — there is NO `m.urls` field, so this becomes `for (const x of undefined)` -> throws `TypeError: undefined is not iterable`.
- Outer try/catch at L481 swallows the error, logs `[ProductCountProbe] ...: probe failed — undefined is not iterable...`, returns `null`.
- Net effect: DB profile silently returns null product count -> coverage gate cannot run -> maintain-ready never asserted.

R1's shape `{method:'sitemap', url:'https://.../xmlsitemap.php?type=products&page=1'}` matches L232-238 exactly. Live re-pull: 1281 `<loc>` entries; page=2 = 404 (single-page sitemap confirmed). `sitemap` (scalar) is the only correct method here. `sitemap-index` is for sites whose products are split across multiple sitemap files (e.g. shopify with `/sitemap_products_1.xml`, `_2.xml`, ...). This is not such a site.

### 3. catalogUrls (DB 13 -> R1 40)

R1 correct. Critical R2 finding: DB's `/surplus-bags-hats-clothing/` returns **301 to `/surplus/clothing/`** at audit time. DB notes claim this URL covers 288 products (the largest single entry); the redirect target is a different category. DB's "65% coverage via 13 URLs" claim is computed against a URL that no longer exists. DB's pruning rationale ("/sport-optics/ identical /scopes-optics/ Jaccard 1.0") may or may not still hold but the bags-hats parent is provably dead.

Candidate's 40-URL list includes deeper child leaves (e.g. `/surplus-bags-hats-clothing/new-jackets/` returns 200 with 33 cards live). Live probe of 26 sampled URLs (13 DB + 13 candidate-only) confirms only the bags-hats-clothing parent is dead; all others return 200. Candidate's wider list is healthier.

Both lists still under-cover (R1's own Stage-9 note: walked union ~709 unique vs 1281 sitemap — ~45% gap). The right fix is operator runtime-augmentation with sitemap-product-walk fallback, NOT another round of catalogUrls expansion.

### 4. searchUrl (DB present -> R1 omitted)

DB correct. R2 ran the deterministic B4 probe: `GET https://frontierfirearms.ca/search.php?search_query=glock` returned HTTP 200, 300KB HTML, title `Frontier Outfitters`, with 50+ search-result markup hits (`search_query`, `search-form`, `product-card`, `result`). The BC Stencil canonical search template is present and live. R1 dropped it under time pressure — that's a candidate regression, not a DB error. **RESTORE FROM DB**: `searchUrl: "/search.php?search_query={keyword}"`.

### 5. perPage (DB 40 -> R1 50)

Marginal. Both values are first-page-honored by the server. Live confirms `?limit=50` returns exactly 50 product cards. 50 is closer to BC Stencil canonical mid-select default. Acceptable either way; lean R1.

## Verdict summary

R1 wins 4 of 5 hard divergences (hasWaf, productCountMethod, catalogUrls, perPage). DB wins 1 (searchUrl). Final profile = R1 candidate + restore DB's `searchUrl` value.

## Blockers / risks

None for catalog-crawl readiness. The ~45% coverage gap (catalogUrls walk vs sitemap total) remains for either list — a separate piece of runtime work, not a profile-field issue.
