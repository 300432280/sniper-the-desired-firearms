# R2 Live Investigation — internationalshootingsupplies.com

**Run**: R2-live-investigation-2026-05-15
**Baseline R1**: `docs/site-audit/internationalshootingsupplies.com-2026-05-15T09-05-23-928Z-R1.json`
**Baseline DB**: `MonitoredSite{domain='internationalshootingsupplies.com'}` (lastVerified 2026-04-12)
**Method**: every divergent field re-tested with a method DIFFERENT from R1; runtime code paths traced by line number; live curl + DB read-only + Node-driven taxonomy walk.

## Mandatory verdicts

### 1. watermark-crawler endpoint verdict
**WP REST (`/wp-json/wp/v2/product`)** — confirmed by code-trace, not by guessing.

`backend/src/services/scraper/adapters/woocommerce.ts:340` is the actual WC `fetchCatalogPage` call. Pseudocode flow:
- L329-396: WP REST path. Calls `axios.get('${origin}/wp-json/wp/v2/product', { params: { per_page, page, orderby, order, ... } })`. Accepts 200/307/401/403 statuses. On 401, sets `wpRestFailed=true`.
- L409-414: Store API standalone path. Only runs if `(isStoreApiOnly || wpRestFailed) && seen.size === 0`.

So WP REST is the FIRST endpoint queried. ISS WP REST returns 200 with `X-WP-Total: 5237` (verified live with prod-rotated Edge UA), so the Store API standalone path is never reached. The denominator the watermark crawler walks against is **5237**, not 2314 (R1) and not 5111 (DB, stale).

Live head+tail walk confirms: page 1 per_page=100 returned 100 items (first id=147189, last id=146700); page 53 (last) returned 37 items (first id=3363, last id=2259). 52x100 + 37 = 5237 = X-WP-Total. Independent partition check: Store API in-stock (2314) + Store API outofstock (2923) = 5237 — partitions add up perfectly.

### 2. store-api silent-no-op verdict
**SAFE / INTENDED behavior. KEEP `verifyMethod=store-api`.**

Code trace of `worker.ts:510-549`:
- L510-513: iterate the chunk of products the cycle wants to verify.
- L513-535: if Store API returned the product (`apiMap.get(product.sourceId)` non-empty), update lastSeenAt + stock + price.
- L537-546: explicit comment: "Not found in Store API — may be deleted, but the API has per_page... Store API 'not found' does NOT mean product is deleted... Do NOT increment verifyErrors or deactivate — just skip."
- L549: **unconditional** `handledProductIds.push(product.id)` — i.e., regardless of whether the API returned the product, it's marked "handled" so the verify cycle won't escalate this to Playwright either.

This is the 2026-04-03 mass-deactivation incident fix (CLAUDE.md project rule: "Never deactivate products based on lastSeenAt alone"). Without this guard, Store API's default in-stock-only filter (verified live: 2,314 in-stock products vs 2,923 OOS) would silently delete every OOS product on every verify pass.

Tradeoff: OOS->truly-deleted transitions are invisible to `store-api` verify. Only Playwright detail-page verify can confirm deletion. The CLAUDE.md rule "Stale detection only via cross-tier cycle completion" is the safety net.

### 3. adapterType vs crawlers.catalog.method runtime-path verdict
**`adapterType` is the ONLY runtime routing key. `crawlers.catalog.method` is dead audit-trail residue.**

Grep results (`backend/src/`):
- `crawlers.catalog` — 0 matches
- `crawlers?.catalog` — 0 matches
- `html-category-walk` / `category-walk` — 0 matches

`adapter-registry.ts:116` is the dispatch: `const adapter = adapters[siteInfo.adapterType] || adapters.generic;`. ISS DB has `adapterType: "woocommerce"` (NOT `"generic-retail"` as the DB's `crawlers.catalog.notes` claims it was supposed to be). So the override never actually fired — the WooCommerce adapter is still in charge.

Additional evidence: the DB note also claims "WP REST blocked", but my live probe with the prod-rotated Edge UA returns 200. The original 2026-04-03 firefight rationale (WP REST blocked -> force HTML walk) is moot today.

**Action**: remove `siteProfile.crawlers.catalog` field from DB. Has zero runtime effect, only confuses operators.

## Methodology — what was tested differently from R1

| Field | R1 method | R2 method |
|---|---|---|
| `expectedProductCount` | x-wp-total from Store API single GET (2314) | WP REST head+tail walk (52x100+37=5237) + Store API in/OOS partition cross-check (2314+2923=5237) + code-trace woocommerce.ts:340 |
| `catalogUrls` | leaf-from-nav with parent-count chain (77, missed bows/crossbows + uncategorized) | full taxonomy walk of `/wp-json/wp/v2/product_cat` (3 pages, 207 entries) -> filter productive non-manuf -> identify leaves -> 79 leaves summing to 2288 |
| `crawlers.maintain.verifyMethod` | profile field copy | code-trace worker.ts:510-549 to verify silent-no-op safety |
| `crawlers.catalog.method` | omitted by SKILL Rule B | grep backend/src for runtime reader -> 0 matches |
| `hasWaf` BPS UA-selectivity | heavy-8-batch with prod UA only | bare `curl/X.Y` UA vs `Mozilla/5.0` UA on `/`, `/shop/`, `/wp-json/wp/v2/product` — found `/wp-json/*` path is UA-gated to Mozilla, returns 403 to bare curl |
| `paginationPattern.template` | bonafide regex match | DB convention check vs R1's leading-slash form |

## Cross-reference against runtime code

| Claim | Runtime line(s) | Verdict |
|---|---|---|
| "Watermark walks WP REST" | woocommerce.ts:340-396 | TRUE — WP REST first, Store API only on 401 |
| "Store API verify silent-no-ops missing products" | worker.ts:537-546 (skip), 549 (handle) | TRUE — intended post-incident behavior |
| "crawlers.catalog.method forces HTML walk" | grep result: 0 readers | FALSE — dead field |
| "adapterType is the routing key" | adapter-registry.ts:116 | TRUE — single dispatch point |
| "BPS blocks bare curl" | curl test results | TRUE on `/wp-json/*`, FALSE on `/` and `/shop/` |
| "Production crawlers send Mozilla UA" | http-client.ts:9-21 (USER_AGENTS), 17-21 (pickUserAgent), 34-48 (resolveUserAgent) | TRUE — never sends bare curl, always rotates 4 Mozilla UAs by domain hash |

## What R1 got right (sanity)

- Platform `woocommerce`, adapterType `woocommerce`, hasCaptcha=false — agree with DB and live probe.
- sortParam `?orderby=date`, sortVerified true — agree (cosmetic leading-`?` difference).
- perPage 12, paginationPattern.type `path` — agree.
- crawlers.watermark.method `api-date-since-watermark` — agree, and matches the WC fetchCatalogPage capability we just traced.
- BPS plugin correctly identified as app-layer, not CDN WAF.

## What R1 got wrong

1. **`expectedProductCount` 2314** — picked customer-visible Store API count instead of WP REST admin count. The watermark crawler walks the WP REST endpoint (woocommerce.ts:340), so the denominator MUST match that endpoint or every watermark cycle will see 2,923 "new" OOS products. **Corrected: 5237.**
2. **`catalogUrls` 77** — Stage 4 leaf-selection chained on parent count>0, which dropped `/product-category/bows/crossbows/` (parent `bows` count=0, leaf count=1) and `/product-category/uncategorized/` (defensive drop with no rationale). Live walk of both URLs confirmed each has 1 real product. **Corrected: 79.**
3. **Did not test bare-curl UA selectivity** — R1 ran the heavy-8-batch probe with a Mozilla UA only and missed that BPS plugin 403s bare curl on `/wp-json/*`. Production crawlers comply, so the impact is zero, but the constraint should be documented as `auditNotes.requiresBrowserUa: true`.

## What DB got wrong

1. **`expectedProductCount` 5111** — stale (33 days old). Live total is 5237 (+126 = 2.5% drift, organic inventory growth).
2. **`crawlers.catalog.method: 'html-category-walk'` with notes "adapterType changed to generic-retail"** — half-applied override; `adapterType` is still `woocommerce`. No code reads `crawlers.catalog.method` anyway. Recommend deletion.
3. **Note claims "WP REST blocked"** — false today. Live probe with prod-rotated UA returns 200 with X-WP-Total=5237. Stale.
4. **`storeApiTotal: 2192`** — also stale; live in-stock count is 2314 (drift +122 = 5.6% over 33 days).

## Confidence scoring

| correction | confidence | basis |
|---|---|---|
| C1 expectedProductCount=5237 | high | full head+tail walk + partition cross-check + code trace |
| C2 productCountMethod.endpoint=wp/v2/product | high | code trace woocommerce.ts:340 |
| C3 catalogUrls=79 entries | high | full taxonomy walk, both missing leaves live-confirmed |
| C4 verifyMethod=store-api KEEP | high | code trace worker.ts:537-549 |
| C5 remove crawlers.catalog | high | grep 0 readers in backend/src |
| C6 requiresBrowserUa=true | high | direct bare-curl vs Mozilla-UA comparison |
| C7 paginationPattern.template | medium | cosmetic only |
| C8 hasWaf=false | high | rapid-burst + header inspection + BPS evidence isolated to UA filter |

## Files

- Corrections JSON: `docs/site-audit/internationalshootingsupplies.com-2026-05-15T09-19-15Z-R2-corrections.json`
- This investigation: `docs/site-audit/internationalshootingsupplies.com-2026-05-15T09-19-15Z-R2-investigation.md`
