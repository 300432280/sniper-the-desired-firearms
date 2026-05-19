# R2 Live Investigation — oleysarmoury.com

**Run:** R2-2026-05-13T08-52-43Z (fresh agent, no shared state with R1)
**Inputs:**
- R1 candidate: `docs/site-audit/oleysarmoury.com-2026-05-13T08-28-56Z-R1.json`
- R1 diff: `docs/site-audit/oleysarmoury.com-2026-05-13T08-28-56Z-R1-diff.md`
- DB siteProfile snapshot taken 2026-05-13T08:45Z (read-only)

**Method:** trust neither side. For every divergent field in the R1 diff MD, pick a probe method DIFFERENT from R1's hypothesis, live-test the truth, cross-check against runtime code.

---

## Top-line verdict

**R1 score:** 100/100 was wrong. R1 wins 4 fields, loses 4 fields, ties on 4 unchanged fields.

**DB score:** DB wins 4 fields R1 lost, loses 3 fields R1 won (including the column-vs-JSON inconsistency).

Both sides made Rule-C errors in opposite directions on the catalogUrls; the live walk resolves both.

---

## Investigation 1: BC GraphQL JWT live test (REQUIRED)

**Hypothesis being tested:** DB claims a working `apiAlternative.bigcommerce-graphql` JWT-scrape path (token from HTML on `/firearms/`, POST to `/graphql`). R1 has no equivalent.

**Probe method (different from R1):** fetch /firearms/ raw HTML, regex-extract a JWT, decode payload, POST it to /graphql with a `newestProducts(first:3)` query.

**Steps + raw evidence:**

```bash
curl -sS https://oleysarmoury.com/firearms/ | grep -oE 'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+'
```

Output:
```
eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJjaWQiOlsxXSwiY29ycyI6WyJodHRwczovL29sZXlzYXJtb3VyeS5jb20iXSwiZWF0IjoxNzc4NzUzNDgzLCJpYXQiOjE3Nzg1ODA2ODMsImlzcyI6IkJDIiwic2lkIjoxMDAwMzM1ODA3LCJzdWIiOiJCQyIsInN1Yl90eXBlIjowLCJ0b2tlbl90eXBlIjoxfQ.x8EZ7QuvcGK1Lbm9gzSqPN6sQsMc3gp9lney2nLc8JzXt1DRz_CkJ6JxeTGOOdYIQXGDp6uXYsnxSiV94hosdA
```

Decoded payload (base64url of middle segment):
```json
{"cid":[1],"cors":["https://oleysarmoury.com"],"eat":1778753483,"iat":1778580683,"iss":"BC","sid":1000335807,"sub":"BC","sub_type":0,"token_type":1}
```

POST to /graphql with `newestProducts(first:3)`:

```bash
curl -X POST https://oleysarmoury.com/graphql \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Origin: https://oleysarmoury.com" \
  -d '{"query":"query { site { newestProducts(first:3) { edges { node { entityId name path createdAt { utc } prices(currencyCode:CAD) { price { value } } } } pageInfo { hasNextPage endCursor } } } }"}'
```

Response (HTTP 200):
```json
{"data":{"site":{"newestProducts":{"edges":[
  {"node":{"entityId":10121,"name":"Remington Ultimate Defense 12 Gauge 3\" 15 Pellets 00BK - 5rds","path":"/remington-ultimate-defense-12-gauge-3-15-pellets-00bk-5rds/","createdAt":{"utc":"2026-05-12T19:54:56Z"},"prices":{"price":{"value":19.99}}}},
  {"node":{"entityId":10120,"name":"Hornady Critical Defense 22 wmr 45g FTX - 50rds","path":"/hornady-critical-defense-22-wmr-45g-ftx-50rds/","createdAt":{"utc":"2026-05-12T18:48:53Z"},"prices":{"price":{"value":34.99}}}},
  {"node":{"entityId":10119,"name":"Caldwell - Elbow Bench Bag - Filled - 774317","path":"/caldwell-elbow-bench-bag-filled-774317/","createdAt":{"utc":"2026-05-12T17:56:05Z"},"prices":{"price":{"value":44.99}}}}
],"pageInfo":{"hasNextPage":true,"endCursor":"eyJpZCI6MTAxMTl9"}}}}}
```

**Result: DB's `apiAlternative.bigcommerce-graphql` is REAL and WORKING.** The JWT's `cors` claim contains `https://oleysarmoury.com` (so graphqlOrigin == apex), `sid: 1000335807` matches the `bcStoreId`, and `iss: BC` confirms it's a BigCommerce Storefront API token. Newest products carry `createdAt.utc` which feeds T1 watermark.

Runtime hook confirmed at `backend/src/services/scraper/adapters/generic-retail.ts:343-346`:
```ts
if (profile?.apiAlternative?.type === 'bigcommerce-graphql') {
  return await this._fetchBigCommerceGraphQLPage(profile.apiAlternative, origin, page, options);
}
```

`_fetchBigCommerceGraphQLPage` at :720-846, `_resolveBcGraphqlToken` at :862-929.

**Verdict:** R1 has a HARNESS GAP. Skill must direct AI to scrape BC JWT from catalog HTML and emit `apiAlternative` block.

---

## Investigation 2: Rule-C catalogUrls walk (REQUIRED)

**Hypothesis being tested:**
- R1 claim: `/clearance/` contributes 21 unique, `/consignment/` contributes 2 unique. R1 dropped `/swag/` citing "pure apparel — exclude."
- DB claim: `/clearance/` + `/consignment/` are "overlapping" (excluded). DB keeps `/swag/`.

**Probe method (different from R1):** walk all 21 candidate paths (DB set + R1 set + 3 disputed + 2 dropped-by-both) at `?sort=newest&limit=100`, dedupe product URLs per-cat, then compute per-cat **unique contribution** = products NOT in the union of any other walked cat.

**Walk script:** `_audit_tmp/oleys-walk-r2.js` (one-off audit, not imported by runtime). Used cheerio with selector `li.product` then first child `a[href]` (BC Stencil custom theme on oleys has 200 `li.product` per page at limit=100 because each card has image-link + title-link to same URL; dedupe yields 100 unique).

**Walk output (verbatim from `_audit_tmp/oleys-walk-r2.log`):**

```
Walking /firearms/                    -> 571 products in 9.7s
Walking /ammunition/                  -> 836 products in 14.1s
Walking /optics/                      -> 381 products in 5.9s
Walking /accessories/                 -> 1302 products in 23.4s
Walking /bargain-bin/                 -> 241 products in 4.2s
Walking /clearance/                   -> 142 products in 2.3s
Walking /air-guns-and-supplies/       -> 46 products in 0.5s
Walking /decals/                      -> 31 products in 0.6s
Walking /trail-cameras/               -> 12 products in 0.5s
Walking /blinds-stands-accessories/   -> 11 products in 0.4s
Walking /training-aid/                -> 4 products in 0.5s
Walking /air-soft/                    -> 2 products in 0.4s
Walking /steambow/                    -> 2 products in 0.4s
Walking /consignment/                 -> 2 products in 0.4s
Walking /consignment-non-firearm/     -> 0 products in 0.3s
Walking /cleaning-and-maintenance/    -> 0 products in 0.3s
Walking /secure-firearms-storage/     -> 0 products in 0.3s
Walking /unwanted-firearms/           -> 0 products in 0.3s
Walking /swag/                        -> 64 products in 0.6s
Walking /parts-guns-as-is/            -> 3 products in 0.5s
Walking /firestick/                   -> 2 products in 0.4s
```

**Unique contribution table:**

| Category | Total in cat | Unique (not in any other cat) | Verdict |
|---|---|---|---|
| `/firearms/` | 571 | 505 | keep |
| `/ammunition/` | 836 | 821 | keep |
| `/optics/` | 381 | 375 | keep |
| `/accessories/` | 1302 | 1243 | keep |
| `/bargain-bin/` | 241 | 216 | keep |
| `/clearance/` | 142 | **0** | DROP (DB correct, R1 wrong) |
| `/air-guns-and-supplies/` | 46 | 39 | keep |
| `/decals/` | 31 | 31 | keep |
| `/trail-cameras/` | 12 | 9 | keep |
| `/blinds-stands-accessories/` | 11 | 6 | keep |
| `/training-aid/` | 4 | 4 | keep |
| `/air-soft/` | 2 | 2 | keep |
| `/steambow/` | 2 | 1 | keep |
| `/consignment/` | 2 | **0** | DROP (DB correct, R1 wrong) |
| `/swag/` | 64 | **64** | KEEP (DB correct, R1 wrong to drop) |
| `/parts-guns-as-is/` | 3 | 0 | drop (both correct) |
| `/firestick/` | 2 | 0 | drop (both correct) |
| `/consignment-non-firearm/` | 0 | 0 | drop (empty) |
| `/cleaning-and-maintenance/` | 0 | 0 | drop (empty) |
| `/secure-firearms-storage/` | 0 | 0 | drop (empty) |
| `/unwanted-firearms/` | 0 | 0 | drop (empty) |

**Set comparison:**
- Total products across all 21 walked cats (dedup union): **3482**
- R1's 18-URL set union: 3418 (**missing 64 products** — all from /swag/, sample: oleys-armoury-hoodie-x-large-blaze-orange, t-shirt-camo-3x-large, etc.)
- DB's 13-URL set union: 3482 (**100% coverage**)

**Verdict:** DB's 13-URL set is correct. R1's claim that `/clearance/ contributes 21 unique` is contradicted by walk (actual: 0 unique). R1's drop of `/swag/` for "pure apparel" violates Rule C ("never drop based on category name; only based on walk-proven zero contribution").

R2 recommends DB's exact 13 URLs.

---

## Investigation 3: Sitemap vs walked-union recount (REQUIRED)

**Hypothesis being tested:** R1 claims products sitemap = walked union = 3482; DB claims 3368 (30d stale).

**Probe method (different from R1):** fresh fetch of `/xmlsitemap.php?type=products&page=1`, count `<loc>` entries; fetch page=2 to confirm no pagination; compare to walk total.

**Steps:**
```bash
curl -sS "https://oleysarmoury.com/xmlsitemap.php?type=products&page=1" -o /tmp/oleys-sitemap-fresh.xml
# size = 395,341 bytes, HTTP 200
grep -c "<loc>" /tmp/oleys-sitemap-fresh.xml
# 3482

curl -sS "https://oleysarmoury.com/xmlsitemap.php?type=products&page=2"
# HTTP 404, 0 bytes
```

**Result: sitemap page=1 contains all 3482 URLs; page=2 is 404 (no pagination needed).** Walked union = 3482 = sitemap loc count = EXACT match. DB's 3368 is 30-day stale (lastVerified=2026-04-12); net new = 114 products = 3.4% growth, consistent with BC GraphQL `newestProducts` showing `createdAt=2026-05-12` on top items.

**Verdict:** R1's 3482 is fresh truth. DB's 3368 is stale.

---

## Investigation 4: WAF heavy 8-batch reprobe + body scan

**Hypothesis being tested:** DB column `hasWaf:true` vs DB JSON `wafType: 'cloudflare-passive'` — internally inconsistent. Skill rule: cloudflare-passive => hasWaf=false at runtime.

**Probe method:** ran the production `backend/scripts/heavy-waf-probe.sh` script (8-batch real probe).

**Steps:**
```bash
cd backend && bash scripts/heavy-waf-probe.sh https://oleysarmoury.com/
# > _audit_tmp/oleys-waf-r2.out
```

**Result summary (full log in `_audit_tmp/oleys-waf-r2.out`):**

| Batch | Description | Result |
|---|---|---|
| 1 | header fingerprint | 200 + cf-ray on every batch. NO x-sucuri-*, NO x-iinfo, NO incap_ses, NO Reblaze cookies, NO challenge body. Just `cf-cache-status: DYNAMIC` + cf-ray + standard BC SF cookies + __cf_bm cookie. |
| 2 | 4 different UAs | All 4 (desktop/mobile/bot/curl) returned 200 with identical bytes (368441 or 368591). |
| 3 | 10 rapid bursts in ~2s | All 200, no rate limit, no spike. |
| 4 | honeypot paths | wp-admin/wp-login/.env/.git = 403 with body 552 bytes (BC origin default, NOT a CDN challenge body). xmlrpc/phpinfo = 404 with BC's 207KB homepage. |
| 5 | suspicious fingerprint (no Accept-Language) | 200, 368591 bytes |
| 6 | SQLi-shaped query strings | 200 on both (`?id=1' OR '1'='1`, `?id=1 UNION SELECT 1,2,3`) |
| 7 | XSS query string | 200 on `?q=<script>alert(1)</script>` |
| 8 | User-Agent absent | 200, 368591 bytes |

**Interpretation guide says:** `cf-ray header present but all 200 → wafType: 'cloudflare-passive'`. Skill operational mapping (per project rule + persona "liangjian" lesson) maps `cloudflare-passive` to runtime `hasWaf=false` because passive CF does not actively block.

**Verdict:** wafType is `cloudflare-passive` (R1 + DB JSON agree). Runtime `hasWaf` should be FALSE (R1 correct; DB column wrong; DB column inconsistent with its own JSON).

Note: per persona warning, Cloudflare reputation is per-IP. Audit IP is residential Canadian (May 2026). Production crawler IP MAY see different behavior; column should be flipped to false provisionally and reverted to true ONLY if production observes 403s.

---

## Investigation 5: searchUrl pattern test

**Probe method:** GET `/search.php?search_query=glock`.

**Result:** HTTP 200, 503,992 bytes, 12 product cards extracted (Glock magazines for 9mm/40cal/357sig/45auto, SGM Tactical Glock magazine). Runtime uses `profile?.searchUrl` at `backend/src/services/scraper/adapters/base.ts:21-22`.

**Verdict:** DB's `/search.php?search_query={keyword}` works. R1 omitted it; should be added.

---

## Investigation 6: bcStoreId / storeHash runtime use

**Probe method:** grep runtime tree for `bcStoreId` and `storeHash`.

**Result:** zero references in `backend/src/services/**`. Both values are operator-audit metadata only — they help humans correlate BC stores but don't drive runtime behavior. `bcStoreId: 1000335807` is verifiable from `x-bc-store-id` response header (present on every response) AND JWT `sid` claim (matches).

**Verdict:** Include `bcStoreId: 1000335807`. `storeHash` is auditable but not load-bearing.

---

## Combined corrections summary

| Field | R1 | DB | R2 verdict |
|---|---|---|---|
| catalogUrls | 18 URLs (incl. clearance, consignment; excl. swag) | 13 URLs (incl. swag; excl. clearance, consignment) | **DB's 13 URLs** — walk-proven 100% coverage |
| apiAlternative.bigcommerce-graphql | absent | full block | **DB's block** — JWT live-tested, returns products |
| productCountMethod.method | `sitemap` | `bc-xmlsitemap` (label-drift; falls to default in runtime) | **R1's `sitemap`** |
| expectedProductCount | 3482 | 3368 | **R1's 3482** — fresh sitemap match |
| DB column hasWaf | false | true (inconsistent w/ DB's own JSON) | **R1's false** |
| searchUrl | omitted | `/search.php?search_query={keyword}` | **DB's value** — tested working |
| bcStoreId | omitted | 1000335807 | **DB's value** — verified |
| wafType | cloudflare-passive | cloudflare-passive | unchanged |
| sortParam | `?sort=newest` | `?sort=newest` | unchanged |
| sortVerified | true | true | unchanged |
| perPage | 100 | 100 | unchanged |
| platform | bigcommerce-stencil | bigcommerce-stencil | unchanged |

---

## Skill harness gaps surfaced

1. **No BC GraphQL JWT probe** — skill should direct AI to grep catalog-page HTML for `eyJ[A-Za-z0-9_-]{20,}\.[...]\.[...]` and emit `apiAlternative` if found.
2. **No platform-specific searchUrl table** — BC Stencil's `/search.php?search_query={keyword}` is deterministic; same for shopify/woocommerce/magento.
3. **No bcStoreId/storeHash output for BC sites** — both come free from `x-bc-store-id` header + CDN URL pattern.
4. **Rule C wording allows category-name-based scope drops** — R1 used "pure apparel — exclude" to drop /swag/ despite Rule C forbidding this. Rule should require walk-proven zero contribution as the only valid drop reason.

---

## Confidence breakdown

- **High (6):** catalogUrls walk, apiAlternative, productCountMethod label, expectedProductCount, hasWaf column, searchUrl
- **Medium (1):** bcStoreId/storeHash (zero runtime impact)
- **Inconclusive (0):** all fields resolved by live probes

---

## Files

- This MD: `docs/site-audit/oleysarmoury.com-2026-05-13T08-52-43Z-R2-investigation.md`
- Corrections JSON: `docs/site-audit/oleysarmoury.com-2026-05-13T08-52-43Z-R2-corrections.json`
- Walk script: `_audit_tmp/oleys-walk-r2.js`
- Walk log: `_audit_tmp/oleys-walk-r2.log`
- Walk output JSON: `_audit_tmp/oleys-walk-r2-out.json`
- WAF probe log: `_audit_tmp/oleys-waf-r2.out`
- Fresh sitemap: `_audit_tmp/oleys-sitemap-fresh.xml` (3482 loc)
- Saved /firearms/ page: `_audit_tmp/oleys-fir100-p1.html`
- Saved /swag/ page: `_audit_tmp/oleys-swag.html`
- Saved search result: `_audit_tmp/oleys-search.html`
