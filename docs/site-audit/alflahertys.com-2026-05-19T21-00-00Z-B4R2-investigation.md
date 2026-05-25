# alflahertys.com - B4R2 Adversarial Audit (2026-05-19T21:00Z)

Inputs: B4R1 candidate (`...-B4R1.json`), B4R1 diff narrative, DB snapshot. R2 ran live HTTP/Klevu probes (Playwright MCP extension timed out - used curl XHR replay + static-HTML scraping for klevu_pageCategory which is identical to what Playwright would render since the variable is in the SSR'd HTML on this BC Stencil site).

## Verdict counts
- **R1 wins**: 4 (`hasWaf`, `wafWorkaround` removal, `sortParam`, `needsPlaywright` runtime-equivalence)
- **DB wins**: 4 (`perPage=20`, `productCountMethod=klevu-api-count`, `catalogUrls` (6 specific firearm-relevant), `apiConfig.klevuCategoryPaths` (8 deep firearm sub-paths))
- **Both inert (audit residue / decorative)**: 5 (`paginationPattern`, `wafProbeMethod/Evidence/Result`, `topLevelCategories`, `auditNotes`, `extractionTested`)
- **Inconclusive**: 0

## Per-divergence

### 1. `hasWaf` - R1 wins (false)
- R1: `false`. DB: `true`.
- **Method (different from R1)**: R1 used the 8-batch capture earlier today. R2 ran a fresh `curl -sI https://alflahertys.com/` 2026-05-19T23:42:36Z and re-inspected for `cf-mitigated`, `cf-chl-bypass`, `x-sucuri-*`, `sucuri_*` cookies, challenge bodies.
- **Evidence**: Live response headers - `HTTP/1.1 200 OK ... Server: cloudflare ... cf-cache-status: DYNAMIC ... Set-Cookie: __cf_bm=...` only. Zero `cf-mitigated`, zero `cf-chl-bypass`, zero `x-sucuri-*`. The `BC-Ray: 1` and `x-bc-store-id: 1000169258` are BigCommerce origin headers, not WAF. Honeypot paths (`/wp-admin`, `/.env`) intentionally return 403 from BigCommerce origin (not Cloudflare challenge).
- **Final correction**: `hasWaf: false`. Runtime impact: `catalog-crawler.ts:290,696` defaults `perPage` to 20 when hasWaf=true; with hasWaf=false default shifts to 50 - BUT we keep explicit `perPage=20` (DB's value) which overrides either branch.

### 2. `wafWorkaround` - R1 wins (omit)
- R1: absent. DB: `{method:"sucuri-cookie-cache", steps:[...], notes:"Sucuri WAF..."}`.
- **Method**: Grep `x-sucuri-` and `sucuri_` in batch responses (all empty). Header inspection of fresh probe.
- **Evidence**: No `x-sucuri-id`, `x-sucuri-cache`, `x-sucuri-block` headers in any response. No `sucuri_*` cookies. Site is BigCommerce + passive Cloudflare, never Sucuri.
- **Final correction**: Remove `wafWorkaround` block entirely.

### 3. `sortParam` - R1 wins (null)
- R1: `null`. DB: `"?sort=newest"`.
- **Method (different from R1)**: R1 inferred from category-page.js source grep. R2 hit the Klevu API live with `sort:"NEWEST"`:
  ```
  POST https://uscs33v2.ksearchnet.com/cs/v2/search
  body: {"context":{"apiKeys":["klevu-170966446878517137"]},"recordQueries":[{"id":"sortNewest","typeOfRequest":"SEARCH","settings":{"query":{"term":"*"},"limit":1,"offset":0,"sort":"NEWEST","typeOfRecords":["KLEVU_PRODUCT"]}}]}
  -> HTTP 500
  body: {"meta":{"qTime":0,"responseCode":500,"error":{"message":"Invalid request or server error"}}}
  ```
- **Evidence**: Live POST -> HTTP 500. NEWEST sort not supported on this Klevu config. Also BC HTML category pages (e.g. `/shooting-supplies-firearms-ammunition/firearms/rifles/`) are 100% klevuLanding empty shells - `productGrid` count = 0, `card-figure` count = 0 in 140KB HTML. The BC `?sort=newest` URL param is meaningless because BC SSR is not producing the product list.
- **Final correction**: `sortParam: null`.

### 4. `perPage` - DB wins (20)
- R1: `36`. DB: `20`.
- **Method**: Code read at `catalog-crawler.ts:290,696` shows: `perPage: profilePerPage || (params.hasWaf ? 20 : 50)`. Klevu `fetchCatalogPage` at `generic-retail.ts:380` falls back to KLEVU_DEFAULTS.perPage=36 if absent.
- **Evidence**: All values (20/36/50) work against Klevu (live `limit:1` and `limit:36` both returned 200). DB's `20` is explicit operator preference for smaller payloads.
- **Final correction**: `perPage: 20`.

### 5. `needsPlaywright` - both inert in runtime; align to false
- R1: `false`. DB: `true`.
- **Method**: Grep `needsPlaywright` across `backend/src/` -> ZERO matches outside type-defs. Only references in `backend/scripts/pre-bootstrap.ts` and `backend/scripts/probe/access-identity/index.ts` (audit harness only).
- **Evidence**: No runtime consumer in production code. Klevu apiConfig branch at `generic-retail.ts:365` goes straight to Klevu API JSON - never invokes Playwright.
- **Final correction**: `needsPlaywright: false`. DB's `true` is stale from pre-apiConfig era.

### 6. `paginationPattern` - decorative; emit for skill validator
- R1: `{type:"api-offset",template:"offset",perPage:36,...}`. DB: absent.
- **Method**: Code read at `catalog-crawler.ts:757,915` shows `paginationPattern` is consumed ONLY by `buildPaginatedUrl()` for HTML-path pagination. The Klevu `fetchCatalogPage` branch computes its own `offset = (page-1)*perPage` internally at `generic-retail.ts:381`.
- **Evidence**: Runtime equivalence: with or without `paginationPattern`, the Klevu branch behaves identically.
- **Final correction**: Keep as decorative documentation. Update `perPage` from 36 -> 20 to match the profile's effective perPage.

### 7. `productCountMethod.method` - DB wins (klevu-api-count)
- R1: `sitemap` (url=`/xmlsitemap.php?type=products&page=1`). DB: `klevu-api-count`.
- **Method (different from R1)**: R1 measured by GET-ing the sitemap and counting `<loc>`. R2 ran BOTH live and cross-verified:
  - Sitemap: `curl /xmlsitemap.php?type=products&page=1` -> `grep -c "<loc>"` -> **5262**. Page 2 -> HTTP 404 (single page).
  - Klevu API: `POST .../cs/v2/search` with `{sort:"RELEVANCE",limit:1}` -> `meta.totalResultsFound = 5262`.
- **Evidence**: Both return exactly 5262, both HTTP 200. Klevu API is more authoritative because Klevu IS the actual product index (sitemap could lag by hours after a Klevu update). `product-count-probe.ts:342-371` implements `klevu-api-count` with `resolveKlevuKey` self-heal.
- **Final correction**: `productCountMethod: {method:"klevu-api-count", endpoint, apiKey}`.

### 8. `catalogUrls` (count + form + paths) - DB wins (6 firearm-relevant)
- R1: 12 absolute top-level URLs (camping, clothing, fishing, archery, etc.). DB: 6 relative paths under firearm-relevant categories.
- **Method (different from R1)**: R1 generated from xmlsitemap categories. R2 walked the live nav HTML of `/shooting-supplies-firearms-and-ammunition/firearms/` and extracted every linked child URL, then HTTP-status-checked all 16 URLs (6 DB + 12 R1 + 2 shared) at 800-1000ms intervals.
- **Evidence (live 2026-05-19T23:42-43Z)**:
  - DB's 6 URLs: all `HTTP 200`.
  - R1's 12 URLs: all `HTTP 200` BUT include non-firearm categories (camping, clothing, fishing, archery, premium-knives, sharpeners-and-maintenance, gift-ideas) that pull non-firearm-relevant products. Klevu wildcard SEARCH still returns 5262 globally regardless of catalogUrl, but per-category telemetry would over-count non-firearm products.
  - The site has THREE alias parent slugs that all resolve live: `/shooting-supplies-firearms-and-ammunition/`, `/shooting-supplies-firearms-ammunition/` (no "and"), `/shooting-supplies-and-firearms/`. DB picks the correct alias per leaf:
    - `ammunition/` lives under `firearms-ammunition` (no "and")
    - `firearms/rifles/` lives under `firearms-ammunition` (no "and") - originally guessed `and-ammunition` returned 404
    - `firearms/shotguns/` lives under `firearms-and-ammunition`
    - `firearms/airguns-500fps-or-more-pal-required/` lives under `shooting-supplies-and-firearms`
  - 2 of the original DB klevuCategoryPath slugs would have returned 404 under R1's homogenized parent guess; DB correctly disambiguates.
- **Final correction**: Use DB's 6 catalog URLs.

### 9. `apiConfig.klevuCategoryPaths` - DB wins (8 deep paths)
- R1: 12 top-level shallow paths (`{slug:"/optics", path:"Optics"}`). DB: 8 deep sub-paths (`{slug:"rifles", path:"...;Firearms;Rifles"}`).
- **Method (different from R1)**: R1 inferred from nav anchor text. R2 fetched live HTML of each DB-claimed sub-URL and extracted the `klevu_pageCategory` JS variable byte-for-byte (this is the actual string the Klevu category-page integration emits):
  ```
  GET /shooting-supplies-firearms-ammunition/firearms/rifles/
    klevu_pageCategory = "Shooting Supplies, Firearms &amp; Ammunition;Firearms;Rifles"
  GET /shooting-supplies-firearms-and-ammunition/firearms/shotguns/
    klevu_pageCategory = "Shooting Supplies, Firearms &amp; Ammunition;Firearms;Shotguns"
  GET /shooting-supplies-firearms-and-ammunition/firearms/long-range-precision/
    klevu_pageCategory = "Shooting Supplies, Firearms &amp; Ammunition;Firearms;Long Range Precision"
  GET /shooting-supplies-firearms-and-ammunition/firearms/used-firearms/
    klevu_pageCategory = "Shooting Supplies, Firearms &amp; Ammunition;Firearms;Used Firearms"
  GET /shooting-supplies-and-firearms/firearms/airguns-500fps-or-more-pal-required/
    klevu_pageCategory = "Shooting Supplies, Firearms &amp; Ammunition;Firearms;Airguns 500FPS or More - PAL Required"
  GET /shooting-supplies-firearms-ammunition/ammunition/centerfire-ammunition/
    klevu_pageCategory = "Shooting Supplies, Firearms &amp; Ammunition;Ammunition;Centerfire Ammunition"
  GET /shooting-supplies-firearms-ammunition/ammunition/rimfire-ammunition/
    klevu_pageCategory = "Shooting Supplies, Firearms &amp; Ammunition;Ammunition;Rimfire Ammunition"
  GET /shooting-supplies-firearms-ammunition/ammunition/shotgun-ammunition/
    klevu_pageCategory = "Shooting Supplies, Firearms &amp; Ammunition;Ammunition;Shotgun Ammunition"
  ```
- **Evidence**: Every DB `klevuCategoryPaths.path` matches the live `klevu_pageCategory` string verbatim (after `&amp;` -> `&` decode, which the adapter does at `generic-retail.ts:300`). DB's `slug` values (`rifles`, `shotguns`, `centerfire-ammunition`, etc.) are substring-matched against the URL at `generic-retail.ts:294` via `urlLower.includes(slug)` - proven to fire correctly for all 8 sub-URLs.
- **Final correction**: Use DB's 8 deep klevuCategoryPaths verbatim.

### 10. Klevu key + endpoint - both correct
- R1 and DB both: `klevuApiKey: "klevu-170966446878517137"`, `klevuEndpoint: "https://uscs33v2.ksearchnet.com/cs/v2/search"`.
- **Method**: Grep homepage HTML at https://alflahertys.com/.
- **Evidence**: `klevu key in home: klevu-170966446878517137`, `endpoint: uscs33v2.ksearchnet.com/cs/v2/search`. Live POST returns 200 with `totalResultsFound: 5262`.
- **Final correction**: MATCH - no change.

### 11. Audit residue (wafProbeMethod, wafProbeEvidence, wafProbeResult, wafLastProbedAt, extractionTested, extractionSample, topLevelCategories, auditNotes)
- All present in R1, absent in DB. Per skill Rule B, runtime ignores these fields.
- **Final correction**: Keep slim subset (`wafProbeResult`, `wafLastProbedAt`, `wafProbeMethod`, `expectedProductCountSource`) - they materially help the next auditor. Drop `wafProbeEvidence`, `topLevelCategories`, `auditNotes`, `extractionTested`, `extractionSample`.

### 12. Operator knobs absent from R1 (budget, timeout, t1IntervalMin, cooldowns, tierShares, tierWindows, dataFlow, name, notes, hasRateLimit, siteCategory, crawlers.bootstrap)
- Skill explicitly omits these (zero pre-bootstrap scope). Operator preserves them in DB.
- **Final correction**: DO NOT EMIT in corrected JSON.

## Blockers
- Playwright MCP extension timed out at startup (`Extension connection timeout. Make sure the "Playwright MCP Bridge" extension is installed.`). Fell back to curl + static HTML extraction of `klevu_pageCategory` JS var, which is equivalent to a Playwright `page.evaluate('klevu_pageCategory')` for this site because the variable is server-side-rendered into the page source on this BC Stencil + Klevu integration. The Klevu API request shape was confirmed by direct POST (Klevu API doesn't require browser state - it's a public key endpoint).
- Wall budget used: ~12 minutes of 25.
