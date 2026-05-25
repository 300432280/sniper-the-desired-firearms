# B4R2 Investigation - canadafirstammo.ca

Round 2 of 4. Live re-test of every R1 divergence using a method DIFFERENT from R1's WHY hypothesis. No DB writes.

## Inputs reviewed
- R1 candidate + diff (`B4R1.json`, `B4R1-diff.md`)
- DB snapshot (`_audit_tmp/batch4-2026-05-19/canadafirstammo.ca-DB-snapshot.json`, lastVerified 2026-04-11)
- Runtime: `crawl-scheduler.ts` (L209, L282, L576), `catalog-crawler.ts` (L290, L296, L306, L447, L459, L696), `http-client.ts` (L106-127), `profile-validator.ts` (L100-120)

## Verdict table (substantive divergences)

| # | Field | R1 stance | DB stance | R2 verdict | Evidence |
|---|---|---|---|---|---|
| 3 | `hasWaf` JSON | `false` | `true` | **R1 wins** | Heavy 8-batch re-probe today: rapid SQLi burst 5/5 = 301; no-UA / empty UA -> 200; honeypot `/wp-admin/` -> 302 (WP login, no WAF); cf-ray present; no x-sucuri-*. Setting `true` forces perPage 50->20 at `catalog-crawler.ts:290,696` and route-shifts HTML fallback to Playwright cookie path (L459) - pure overhead on a passive CF deployment. |
| 4 | column `hasWaf` | n/a | `true` | **R1 wins** | Same root cause as #3. Operator-forgot-to-flip after Stage 2 spec was added (DB notes literally says "Cloudflare passive (not Sucuri). API works without cookies."). |
| 12 | `catalogUrls` count | 11 (inc. gunsmithing) | 10 (no gunsmithing) | **R1 wins** | Live walk: `HEAD /product-category/gunsmithing/` = 200; `/wp-json/wp/v2/product_cat?slug=gunsmithing` returns `{id:4822, count:0}`; Store API `?category=4822&per_page=10&stock_status[]=instock&stock_status[]=outofstock` returns `X-WP-Total:0` but HTTP 200. Mistake 12 explicit: empty (200 + 0 products) != dead (404). Keep. |
| 14 | `catalogUrls` form | absolute URLs | path-only | **R1 wins (cosmetic)** | Both work at runtime. R1's absolute form is self-contained (no base-URL resolution ambiguity). |
| 17 | `sortVerified` shape | boolean `true` | `{method, results, verifiedAt}` object | **R1 wins** | `profile-validator.ts:115` strict-equals `p.sortVerified === true`. DB's object fails that strict check; validator still passes via `|| p.sortParam` (sortParam is set), so DB shape is benign but is audit-trail residue per Rule B. Grep confirms NO other consumer in `backend/src` or `frontend/src` reads `sortVerified` for runtime branching. |
| 32 | `searchUrl` | absent | `/?s={keyword}&post_type=product` | **DB wins** | Live test: `curl -L "/?s=glock&post_type=product"` -> 302 -> resolves to product page (HTTP 200). R1's omission is per its own note "I did NOT discover/emit it." Output target spec recommends it. R2 adds it back. (Note: runtime keyword search uses `MonitoredSite.searchUrlPattern` column, not `siteProfile.searchUrl` - but emit for spec compliance.) |
| 42 | `lastVerified` | `2026-05-19` | `2026-04-11` | **R1 wins** | DB is 38 days stale. R2 refreshes to today. |

Verdict counts: **R1 wins: 6**, **DB wins: 1**, **both wrong: 0**, **inconclusive: 0**.

Shape-only / partial divergences (#7, #8, #15, #21-26, #30-31, #33-41): handled by Rule B in R1 - audit-trail residue and operator config the skill correctly omits. Not relitigated.

## Top 3 with evidence

### 1. `hasWaf` = false (R1 wins via DIFFERENT method)
R1 used heavy-probe headers analysis. R2 used **rapid-burst behavioral attack**:
- `for i in 1..5; do curl ... "/?path=/sqli&id=1' OR 1=1--"; done` -> all 5 = HTTP 301 (no rate limit, no WAF challenge).
- Empty-UA: `curl -A "" /` -> 200.
- Honeypot: `curl /wp-admin/` -> 302 to wp-login.php (WordPress core redirect, no WAF interjection).
- Server header: `cloudflare`; cf-ray on every response; **no** `x-sucuri-*`, no `cf-mitigated`, no JS challenge.

Verified runtime cost of `hasWaf=true` (trace, don't guess):
- `catalog-crawler.ts:290` and `:696`: `perPage: profilePerPage || (params.hasWaf ? 20 : 50)` - **60% throttle** that only fires when no explicit profile.perPage exists; profile sets perPage=12 so this specific knob is dampened, but it does propagate `hasWaf:true` to the adapter param.
- `catalog-crawler.ts:447` & `watermark-crawler.ts`: WAF branch lowers HTML-empty threshold from 5000->2000 bytes - more Playwright fallback fires.
- `catalog-crawler.ts:459`: WAF branch routes through `fetchWithPlaywright` + cookie cache.
- `crawl-scheduler.ts:209, 282, 576`: `hasWaf` propagated to every queued job (watermark, catalog, verify) - downstream adapter decisions inherit it.
None of these help on a passive-CF site. Operator-forgot-to-flip after Stage 2 rule landed.

### 2. `catalogUrls` includes gunsmithing (R1 wins via Mistake 12)
- `HEAD https://canadafirstammo.ca/product-category/gunsmithing/` -> `HTTP/1.1 200 OK`, `Server: cloudflare`, `cf-cache-status: DYNAMIC`.
- `GET /wp-json/wp/v2/product_cat?slug=gunsmithing` -> `[{"id":4822,"count":0,"name":"Gunsmithing",...}]` - category is REGISTERED, just empty today.
- `GET /wp-json/wc/store/v1/products?category=4822&per_page=10&stock_status[]=instock&stock_status[]=outofstock` -> 200, `X-WP-Total:0`, body `[]`.

Per playbook Mistake 12: "empty != dead. 200 + 0 products != 404. Keep - products may appear tomorrow." DB's exclusion is a stale-data hazard. R1 stance correct.

### 3. `sortVerified` boolean (R1 wins via validator shape)
- `profile-validator.ts:115`: `if (p.sortVerified === true || p.sortParam) return null;` - strict-equality check.
- DB object `{method, results, verifiedAt}` is truthy in JS but **fails `=== true`** - the validator falls through to the OR clause, which still passes because `sortParam` is set.
- `Grep "sortVerified" frontend/src` -> no matches.
- `Grep "sortVerified" backend/src` -> only `profile-validator.ts` (2 lines).
- DB shape is harmless residue. Canonical shape is boolean (matches what the validator strict-checks).

## Cross-reference (R1 newest correctness)
- R1 extractionSample first item: `used-tag-fde-plate-carrier-l-xl`.
- R2 live `GET /wp-json/wp/v2/product?per_page=3&orderby=date&order=desc` -> first id=**30620**, slug=**used-tag-fde-plate-carrier-l-xl**, date=2025-12-22.
- Same product -> confirms R1's newest, sort, and extractionSample are accurate today.

## Blockers
None. R2 candidate is a viable replacement for runtime fields. R1's discovery was solid; R2 adds back `searchUrl` (DB wins), refreshes WAF probe evidence with behavioral attack data, and documents the explicit runtime cost of `hasWaf=true` so the operator sees the saving.

## Output
- Corrected siteProfile: `docs/site-audit/canadafirstammo.ca-2026-05-19T21-00-00Z-B4R2.json`
- Investigation: this file.
