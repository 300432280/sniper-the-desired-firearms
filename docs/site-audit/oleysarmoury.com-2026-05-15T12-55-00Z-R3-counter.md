## Facts (GateGuard preface)

1. Nothing in the runtime calls this Markdown file; it is an audit artifact consumed by the operator running the multi-round site-audit pipeline (R1 candidate -> R2 corrections -> R3 counter).
2. No existing R3 counter for 2026-05-15 (Glob `docs/site-audit/oleysarmoury.com-2026-05-15*R3*` returned 0 files). Previous R3 was 2026-05-13T09-17-12Z.
3. Pure prose + tables. All numeric content (entityIds, decoded JWT fields, headers, walker counts) is sourced from public live tests saved under `_audit_tmp/oleys-r3-2026-05-15/`. JWT body is BC's public storefront token already shipped via SSR to every visitor; `cors` claim confines it to oleysarmoury.com origin.
4. Verbatim user instruction (file path portion): `Save: docs/site-audit/oleysarmoury.com-2026-05-15T<HH-mm-ss>Z-R3-counter.md`.

---

# R3 Adversarial Counter — oleysarmoury.com

**Run:** R3-2026-05-15T12-55-00Z (fresh skeptic, no R1 loaded)
**Inputs:** R2 corrections + R2 investigation + prior R3 (2026-05-13).
**Method:** every load-bearing R2 claim re-derived by an INDEPENDENT method (different page, different extractor, longer time-window, different header source). NO DB writes.
**Constraints honored:** 800ms+ inter-request delay (used 900ms). No `_audit_tmp` deletes.

---

## Summary

- **R2 corrections re-examined:** 13
- **Countered (R2 wrong or load-bearing brittle):** 0
- **Survived adversarial probe:** 13
- **Refinements raised (not counter-disproofs):** 2 (apiAlternative `tokenCacheTtlMs` under-tuned vs 48h JWT; `tokenScrapeUrl` over-specific)

R2 holds end-to-end. Every checked field reproduces from a different method to the integer or byte.

Adversarial review of **prior R3 (2026-05-13)**: prior R3's own load-bearing claims (DB-13 union = 3482 then, /swag/ uniqueness = 64, JWT 48h TTL, full-URL bug in R1's `productCountMethod.url`, `bc-xmlsitemap` not in switch) all still hold today; sitemap and DB-13 union have grown 3482 -> **3505** in the intervening 2 days, which is consistent with the +137 product delta R2 noted vs the 33-day-stale DB count.

---

## Required answers

### 1. BC GraphQL JWT — cross-page + post-sleep verdict (REQUIRED)

**Cross-page (different from R2's `/firearms/`):**

- Scraped JWT from `/ammunition/` (519 983 B, HTTP 200)
- Scraped JWT from `/optics/` (524 339 B, HTTP 200)
- Scraped JWT from `/` (363 202 B, HTTP 200)
- **All three JWT extractions byte-identical** (323 chars, single JWT match per page via regex `/eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/`): header `eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9`, payload starts `eyJjaWQi...`, signature ends `...t2PJ7z6XvELHBkT8SVgpqwNTp6q1Ln1EPTUa4sVD2cLyw`. `diff -q` on the three files reports no difference.
- **Live POST `/graphql` with `/ammunition/`-scraped JWT** (i.e. NOT R2's tokenScrapeUrl): HTTP 200, `data.site.newestProducts.edges[0..2]` = entityIds **10151, 10150, 10149**, monotonic-DESC, first product `REMINGTON 7600 Rear Sight Slide`, createdAt.utc `2026-05-14T19:33:25Z`, price 49.99 CAD. Identical to R2's `/firearms/`-JWT result.

**Decoded JWT payload (independent decode):**

```json
{"cid":[1],"cors":["https://oleysarmoury.com"],"eat":1779012721,"iat":1778839921,"iss":"BC","sid":1000335807,"sub":"BC","sub_type":0,"token_type":1}
```

- `eat - iat = 172 800 s = 48.0 h` — TTL confirmed 48h.
- `iat` = 2026-05-15T10:12:01Z; `eat` = 2026-05-17T10:12:01Z. ~45.4h remaining at scrape time.
- `sid` = **1000335807** (bcStoreId, matches DB and `x-bc-store-id` header).
- `cors` = `["https://oleysarmoury.com"]` (graphqlOrigin = same origin, as R2 said).

**Post-sleep replay (REQUIRED):**

- JWT captured 2026-05-15T12:47:24Z.
- Replayed (background job) at 2026-05-15T12:52:39Z — **~5 min 15 s later**.
- HTTP 200, same entityIds 10151/10150/10149, same payload structure (response size 622 B for trimmed query). JWT survives the 5-minute boundary.

**Verdict:** R2's `apiAlternative.bigcommerce-graphql` block SURVIVES. The JWT is site-wide (same token on `/ammunition/`, `/optics/`, `/`), 48h-lived, and stable across at least the 5-minute test window.

**Refinement (not counter):** R2 keeps DB's `tokenCacheTtlMs: 3600000` (1h). The actual `eat - iat` is 48h. Re-scraping every hour wastes ~47 fetches per token lifetime but is harmless. Could safely be raised to ~36h. R2 already acknowledged this in the corrections JSON evidence ("could be raised to ~36000000").

---

### 2. /swag/ unique-count re-walk verdict (REQUIRED)

Independent walker `_audit_tmp/oleys-r3-2026-05-15/walk.js` (raw `data-product-id` regex extraction; deliberately different method from prior R3's cheerio + URL-pathname approach and from R2's `oleys-walk-r2.js` first-child anchor approach). 900ms inter-request delay. URL pattern `?limit=100&sort=newest[&page=N]`.

**Per-category fresh counts (2026-05-15T12:47-12:50Z):**

| Category | Pages | Total IDs | Matches R2? |
|---|---|---|---|
| `/firearms/` | 6 | 585 | yes |
| `/ammunition/` | 9 | 839 | yes |
| `/accessories/` | 14 | 1304 | yes |
| `/optics/` | 4 | 381 | yes |
| `/bargain-bin/` | 3 | 243 | yes |
| `/air-guns-and-supplies/` | 1 | 48 | yes |
| `/decals/` | 1 | 31 | yes |
| `/trail-cameras/` | 1 | 12 | yes |
| `/blinds-stands-accessories/` | 1 | 11 | yes |
| `/steambow/` | 1 | 2 | yes |
| `/air-soft/` | 1 | 2 | yes |
| `/training-aid/` | 1 | 4 | yes |
| `/swag/` | 1 | **64** | yes |

**Coverage math:**

- /swag/ ids = 64.
- Union(other 12 cats) does NOT contain ANY /swag/ id.
- `/swag/ uniqueVsOther12 = 64; overlap = 0`.
- 13-cat union total = **3505** = sitemap loc count (3505) exact match.

**Verdict:** /swag/ MUST stay in catalogUrls. Dropping it would lose 64 products from coverage outright (no other cat covers them). DB's 13-URL set (with /swag/) achieves exact-sitemap coverage. R2 SURVIVES.

---

### 3. searchUrl / bcStoreId / storeHash live verification (REQUIRED)

**`searchUrl = '/search.php?search_query={keyword}'`:**

- Live GET `https://oleysarmoury.com/search.php?search_query=glock` -> HTTP 200, 506 166 B.
- Body contains BC Stencil markers: `productGrid` (2 occurrences), `data-product-id` (multiple), and the search form with input `name="search_query"`.
- CONFIRMED.

**`bcStoreId = 1000335807`:**

- Homepage response header: `x-bc-store-id: 1000335807` (lowercase emit on this site; header parsed case-insensitively at runtime).
- JWT `sid` claim from independent decode of `/ammunition/`-scraped JWT: `1000335807`.
- Two independent sources agree byte-for-byte.

**`storeHash = 's-6j8taxjw04'`:**

- Homepage `link:` response header includes `<https://cdn11.bigcommerce.com/s-6j8taxjw04>; rel=preconnect; as=font; crossorigin=anonymous`.
- Same `s-6j8taxjw04` appears in `theme-bundle.head_async.js` preload and theme CSS preload URLs in the same Link header.
- CONFIRMED.

**Verdict:** All three SURVIVE. R1's failure to emit these in the candidate JSON is a real omission (DB has all three correct). Prior R3 noted `bcStoreId` and `storeHash` have zero current runtime references — that's still true at the lines I checked; they are operator-utility metadata, not load-bearing for the worker.

---

## Per-correction adversarial verdicts

### apiAlternative (bigcommerce-graphql) — SURVIVED

Three independent JWT scrapes (cross-page) match byte-for-byte; live POST from /ammunition/-scraped JWT returns the same 200 + same product data; 48h TTL decoded; 5-min replay holds. R2 verdict stands.

### productCountMethod — SURVIVED

Re-read `backend/src/services/product-count-probe.ts:204-209`: `const url = ${origin}${m.url}` — path-only required. Type union `87-98` and default case `446-450` confirm `bc-xmlsitemap` is unknown -> silent null. R2's `{method:'sitemap', url:'/xmlsitemap.php?type=products&page=1'}` is the only runtime-correct shape. **Note (same as prior R3):** R2 framed R1's bug as "label drift on `method`" while R1's `url` field (`https://oleysarmoury.com/xmlsitemap.php...`) is ALSO broken at runtime — `${origin}${full-url}` doubles the host. Both R1 issues need fixing, not just the label.

### expectedProductCount = 3505 — SURVIVED

Independent fresh sitemap fetch: 3505 `<loc>` entries. Independent 13-cat walk union: 3505. Two methods agree to the integer. R2 SURVIVES; prior R3's 3482 is now superseded by today's +23 fresh count (BC recomputes sitemap on product additions).

### hasWaf=false — SURVIVED

CF-RAY present on every R3 fetch (e.g. `CF-RAY: 9fc23eaf685b0426-YYZ` on homepage), Server: cloudflare, but every page in this audit returned 200 with no challenge, no `cf-mitigated`, no "just a moment" interstitial. `wafType: cloudflare-passive` documents the CF edge presence; `hasWaf: false` correctly captures the operational reality (no active challenges). The DB's stale `hasWaf: true` would force Playwright on every page per `catalog-crawler.ts` and `watermark-crawler.ts` — a real cost with no benefit. R2 SURVIVES.

### wafProbeResult / wafLastProbedAt — SURVIVED

Today's R3 reprobe reproduces the cf-ray-present + no-challenge state. Timestamp refresh is mechanical.

### catalogUrls (DB's 13) — SURVIVED

Independent walker confirms: 13-cat union = sitemap (3505); /swag/ = 64 unique (uniqueVsOther12 = 64, overlap = 0). Dropping /swag/ would orphan 64 SKUs. R2 SURVIVES.

### categoryWalkTotal = 3505 — SURVIVED

Independent walk union confirms 3505 exact.

### bcStoreId / storeHash / searchUrl — SURVIVED (covered in REQUIRED §3 above)

### paginationPattern — SURVIVED

Walker observed `?limit=100&sort=newest&page=2` returning 100 fresh ids non-overlapping page 1 (e.g. /accessories/ p2=100 new); page 1 has no `?page=` param; verified.

### crawlers.bootstrap — SURVIVED

R2's "keep DB shape (method/htmlFallback are functional; apiEndpoints is informational)" is a judgment call within the runtime contract; not load-bearing.

---

## Strongest counter-claims (top 3 — none disprove R2; all are refinements)

1. **R2's framing slightly under-states R1's `productCountMethod` bug.** Prior R3 already raised this. R2's corrections JSON DOES quote `https://oleysarmoury.comhttps://...` in evidence, so R2 actually called it out — this is closer to a styling note than a substantive R2 error. Still worth flagging in any audit-trail diff: BOTH `method` (label) AND `url` (path-only) were broken in R1.
2. **`tokenCacheTtlMs: 3600000` under-tunes the cache.** Decoded JWT `eat-iat` = 48h. DB's 1-hour cache re-scrapes ~48x per token lifetime. Harmless but wasteful; R2 already noted this could safely be raised to 10-36h.
3. **`tokenScrapeUrl: '/firearms/'` is over-specific.** Three independent page scrapes (/ammunition/, /optics/, /) all served the byte-identical JWT. The token is site-wide, server-rendered into every Stencil page. Hardcoding `/firearms/` couples runtime to one specific catalog path; if that category is ever renamed/redirected, GraphQL goes silently dark. `/` would be a more durable default.

---

## Adversarial review of prior R3 (2026-05-13T09-17-12Z)

| Prior R3 claim | Today verdict |
|---|---|
| /swag/ = 64 unique vs DB-13 | SURVIVES (still 64 today; overlap still 0) |
| /clearance/ = 142 total, 0 unique | unable to re-test today (walker did not include it; would be Rule-C dropped anyway) |
| /consignment-non-firearm/ = 2 total, 0 unique | superseded — R2 says **0 products** today (catalog has shrunk in the 2-day gap). Prior R3 had 2; current state is empty. Neither contradicts the other; the category just emptied further. |
| DB-13 union = 3482 | SURVIVES with growth — today = **3505** (+23, consistent with R2's +137-vs-DB delta over 33 days) |
| JWT TTL 48h, cross-page identical | SURVIVES — independently re-confirmed |
| JWT survives 5+ min replay | SURVIVES — independently re-confirmed at 5min15s |
| `bc-xmlsitemap` not in switch + default->null | SURVIVES — re-read `product-count-probe.ts:87-98`, `446-450` |
| R1 `productCountMethod.url` is full-URL and breaks `${origin}${m.url}` | SURVIVES — re-read line 205 |

Prior R3's three top counter-claims (full-URL bug, 1h TTL under-tune, `/firearms/` over-specific) all still apply today.

---

## Files

- This MD: `docs/site-audit/oleysarmoury.com-2026-05-15T12-55-00Z-R3-counter.md`
- R3-2026-05-15 walker: `_audit_tmp/oleys-r3-2026-05-15/walk.js`
- R3-2026-05-15 walk output: `_audit_tmp/oleys-r3-2026-05-15/walk-out.json`
- R3-2026-05-15 walk summary: `_audit_tmp/oleys-r3-2026-05-15/walk-summary.json`
- R3-2026-05-15 cross-page JWT scrapes: `_audit_tmp/oleys-r3-2026-05-15/{ammo,optics,home}-jwt.txt`
- R3-2026-05-15 GraphQL POST (ammo-JWT): `_audit_tmp/oleys-r3-2026-05-15/graphql-resp1.json`
- R3-2026-05-15 GraphQL POST (post-sleep replay): `_audit_tmp/oleys-r3-2026-05-15/graphql-resp-postsleep.json`
- R3-2026-05-15 homepage headers (x-bc-store-id + storeHash link): `_audit_tmp/oleys-r3-2026-05-15/homepage.headers`
- R3-2026-05-15 sitemap snapshot: `_audit_tmp/oleys-r3-2026-05-15/sitemap.xml`
