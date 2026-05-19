# R2 Investigation - oleysarmoury.com

**Audited:** 2026-05-15T09:25:00Z
**R1 candidate:** `docs/site-audit/oleysarmoury.com-2026-05-15T08-57-56Z-R1.json`
**R1 diff:** `docs/site-audit/oleysarmoury.com-2026-05-15T08-57-56Z-R1-diff.md`
**Corrections:** `docs/site-audit/oleysarmoury.com-2026-05-15T09-25-00Z-R2-corrections.json`

R2 trusts neither R1 nor DB. Every divergent field re-tested with a method different from R1's, then cross-checked against runtime code (line-numbered).

---

## 1. BC GraphQL JWT live test — REQUIRED, used Playwright

**R1 claim:** "token is JS-injected today; static fetch won't catch it" - emitted nothing under `apiAlternative`.

**R2 verdict:** R1 is **WRONG**. The JWT is in the SSR'd HTML, not injected at runtime.

### Evidence (three independent confirmations)

1. **Static axios fetch on `/firearms/`** (R1's own method, applied correctly):
   - Regex `/eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/` (the EXACT regex used at runtime `backend/src/services/scraper/adapters/generic-retail.ts:895`) matches in the response body.
   - Extracted JWT (header.payload.signature, trimmed): `eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJjaWQ...t2PJ7z.iKfruDbsy7emqrz0qW5ZIzNyfTvwgKD5B0TifAkzJ53BnWN18QOsWY3NssnPUgWHqCuIPC3QHqoDoy8MSQWGs`

2. **Playwright headless on `https://oleysarmoury.com/firearms/`** (script at `_audit_tmp/oleys-pw-jwt.js`):
   - JWT-matches-count = 1 in rendered HTML.
   - First-JWT matches the static-fetch JWT byte-for-byte.
   - `page.on('request', ...)` intercepted 3 XHRs, all third-party (Google Fonts, jQuery UI, WebFont). **Zero graphql/storefront XHRs** - the token is server-rendered, not runtime-fetched.

3. **Live GraphQL POST `https://oleysarmoury.com/graphql`** with scraped JWT:
   ```
   POST /graphql
   Authorization: Bearer <JWT>
   Origin: https://oleysarmoury.com
   Content-Type: application/json
   { "query": "query{site{newestProducts(first:3){edges{node{entityId name path createdAt{utc} prices{price{value currencyCode}}}}}}}" }
   ```
   - Response: **HTTP 200**.
   - `data.site.newestProducts.edges` first 3 entityIds: **10151, 10150, 10149** (monotonic-DESC).
   - First product: `REMINGTON 7600 Rear Sight Slide, New Reproduction` at `/remington-7600-rear-sight-slide-new-reproduction/`, `createdAt.utc=2026-05-14T19:33:25Z`, price=49.99 CAD.

### JWT details (decoded)
```json
{
  "cid": [1],
  "cors": ["https://oleysarmoury.com"],
  "iat": 1778753520,  // 2026-05-14T10:12:00Z
  "eat": 1778926320,  // 2026-05-16T10:12:00Z (TTL = 48h)
  "sid": 1000335807,  // bcStoreId
  "sub": "BC",
  "token_type": 1
}
```

### Restored apiAlternative block (matches DB)
```json
{
  "type": "bigcommerce-graphql",
  "graphqlUrl": "/graphql",
  "currencyCode": "CAD",
  "tokenScrapeUrl": "/firearms/",
  "tokenCacheTtlMs": 3600000
}
```

`tokenCacheTtlMs=3600000` (1h) is conservative; the JWT itself is valid 48h, so the cache could safely be raised to ~10h.

---

## 2. productCountMethod.url — path-vs-full URL verdict — REQUIRED

**Runtime code, `backend/src/services/product-count-probe.ts:204-209`:**
```ts
case 'sitemap': {
  const url = `${origin}${m.url}`;
  const r = await axios.get(url, ...);
  const xml = typeof r.data === 'string' ? r.data : '';
  const count = (xml.match(/<loc>/g) || []).length;
  return count > 0 ? count : null;
}
```

Line 205 does simple string concatenation: `${origin}${m.url}`. Therefore:

- If `m.url = "https://oleysarmoury.com/xmlsitemap.php?type=products&page=1"` (R1's full URL), runtime produces `https://oleysarmoury.comhttps://oleysarmoury.com/xmlsitemap.php?type=products&page=1` → axios DNS fail → returns null.
- If `m.url = "/xmlsitemap.php?type=products&page=1"` (DB's path), runtime produces `https://oleysarmoury.com/xmlsitemap.php?type=products&page=1` → 200 OK → 3505 <loc> count.

**Path-only is REQUIRED.** R1's full-URL emission would silently break the runtime count probe.

**Separate DB bug** (different from R1's): DB's method label `bc-xmlsitemap` is NOT in the runtime switch (`product-count-probe.ts:87-103` type union; line 204 is the canonical `sitemap`). An unknown method falls through default → returns null → silent disablement.

**Canonical correct shape (R2 verdict):**
```json
{
  "method": "sitemap",
  "url": "/xmlsitemap.php?type=products&page=1"
}
```

Optional informational fields DB keeps: `sitemapTotal`, `categoryWalkTotal` (must refresh to 3505).

---

## 3. /swag/ /clearance/ /consignment-non-firearm/ Rule-C re-walk verdict — REQUIRED

Fresh walk of all 15 categories (limit=100, sort=newest, paginate until <100 IDs returned), HTML saved to `_audit_tmp/oleys-walk-r2/<slug>-p<N>.html`, deduped by `data-product-id`.

### Per-category fresh counts (2026-05-15T09:20Z)

| Category | Pages | Total IDs | uniqueHere (not in other 14) | Verdict |
|---|---|---|---|---|
| `/swag/` | 1 | **64** | **64** | **KEEP** - 64 ids not in any other category |
| `/clearance/` | 2 | 142 | 0 | **DROP** - fully redundant |
| `/consignment-non-firearm/` | 1 | **0** | 0 | KEEP-or-DROP both defensible |
| `/firearms/` | 6 | 585 | 523 | KEEP |
| `/ammunition/` | 9 | 839 | 826 | KEEP |
| `/accessories/` | 14 | 1304 | 1245 | KEEP |
| `/optics/` | 4 | 381 | 375 | KEEP |
| `/bargain-bin/` | 3 | 243 | 218 | KEEP |
| `/air-guns-and-supplies/` | 1 | 48 | 41 | KEEP |
| `/decals/` | 1 | 31 | 31 | KEEP |
| `/trail-cameras/` | 1 | 12 | 9 | KEEP |
| `/blinds-stands-accessories/` | 1 | 11 | 6 | KEEP |
| `/steambow/` | 1 | 2 | 1 | KEEP |
| `/air-soft/` | 1 | 2 | 2 | KEEP |
| `/training-aid/` | 1 | 4 | 4 | KEEP |

### Coverage math
- sitemap-fresh: **3505**
- union(all 15) = **3505** (sitemap exact)
- union(13 retained, with /swag/, excl /clearance/ and /consignment-non-firearm/) = **3505** (sitemap exact)
- union(13, excl /swag/+/clearance/+/consignment-non-firearm/) = 3441 (so /swag/ provides 64 needed-uniques)

### Rule-C verdicts (one each)

- **/swag/ → KEEP** - 64 unique products not in any other category. Prior R2 batch's finding (cited in mission) reproduces: /swag/ contributes 64 unique products. Both DB and R1 correctly keep it.
- **/clearance/ → DROP** - 142 products but uniqueHere=0. Fully redundant. Both DB and R1 correctly drop.
- **/consignment-non-firearm/ → KEEP-or-DROP both defensible.** Today: 0 products. Per Rule C ("empty 200 != dead, may have products tomorrow") R1's KEEP is defensible. Per "Tier-4 streamState shows 0 products for 2+ weeks" DB's DROP is also defensible. Neither materially affects coverage today (sitemap exact = 3505 regardless).

---

## 4. WAF reprobe verdict

Heavy 8-batch reprobe at 2026-05-15T09:21:02Z (saved to `_audit_tmp/oleys-waf-r2/heavy.txt`).

| Batch | Probe | Result |
|---|---|---|
| 1 | Apex headers | 200, CF-RAY: 9fc111f7caba7769-YYZ, Server: cloudflare, __cf_bm cookie, X-Bc-Store-Id: 1000335807 |
| 2 | SQLi probe | curl URL malformation (probe-side limitation) |
| 3 | XSS probe | 200 |
| 4 | Honeypot `/wp-admin/` | 403 (BC native block, not CF mitigated) |
| 5 | Bot UA python-requests | 200 |
| 6 | Empty UA | 200 |
| 7 | Rapid 5x burst | all 200 |
| 8 | GraphQL POST sanity | (no body) |

**Verdict:** `hasWaf: false`, `wafType: cloudflare-passive`. CF-RAY presence does NOT make this an active WAF — `hasWaf` is operational (challenge-presence), `wafType` is documentation. R1's "no cf-ray header" claim was wrong (probably cached probe variant); R1's `hasWaf:false` conclusion was right for the right reason.

### Runtime impact of `hasWaf` (line-numbered)
- `catalog-crawler.ts:290`: drops perPage 50 → 20 if profilePerPage not set (moot here, profile sets 100).
- `catalog-crawler.ts:390`, `:447`, `:841`: FORCES Playwright instead of axios for every HTML page on a WAF site.
- `watermark-crawler.ts:79`, `:144`: same Playwright forcing on every watermark page fetch.

**Setting `hasWaf:true` on this passive-CF BC Stencil site makes the crawler ~10x slower with no benefit.** R1's flip true→false is correct.

---

## 5. Sort confirmation

3-outcome cache-busted (timestamp query param, no cache):
- default `/firearms/?limit=10`: first-3 ids = 10149, 10148, 10147
- `?sort=newest`: first-3 ids = 10149, 10148, 10147 (== default)
- `?sort=alphaasc` (counter-control): first-3 ids = 1375, 7453, 8308 (different)

`?sort=newest` honored, sortVerified=true. Both R1 and DB agree.

---

## 6. Summary

13 corrections, 11 agreements. Top 3 substantive changes vs R1:

1. **Restore `apiAlternative.bigcommerce-graphql`** - R1 missed by mis-judging the JWT as JS-injected. Live-proven via three methods (axios, Playwright, GraphQL POST).
2. **Flip `hasWaf` true→false in DB** - DB is internally inconsistent (`true` + `cloudflare-passive`). Saves ~10x crawl cost.
3. **`productCountMethod` canonical shape** - both R1 (full-URL breaks `${origin}${url}`) and DB (`bc-xmlsitemap` label not in runtime switch) break the runtime in different ways. Correct shape: `{method:"sitemap", url:"/xmlsitemap.php?type=products&page=1"}`.

Sub-issues:
- R1 must also add: `searchUrl`, `bcStoreId`, `storeHash`.
- DB must update: `expectedProductCount` 3368→3505, `productCountMethod.sitemapTotal/categoryWalkTotal` to 3505.
- Either keep or drop `/consignment-non-firearm/`; both defensible; no coverage impact today.
