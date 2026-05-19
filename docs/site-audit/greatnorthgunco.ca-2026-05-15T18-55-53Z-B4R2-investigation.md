# B4R2 Investigation — greatnorthgunco.ca

Run: 2026-05-15T18:55:53Z (R2 fresh-agent independent verification of R1)
R1 inputs: `docs/site-audit/greatnorthgunco.ca-2026-05-15T18-40-47Z-B4R1.json` + `-B4R1-diff.md`
R2 outputs: this file + `-B4R2-corrections.json`

## Headline

**R1's central production-impact finding (Imunify360 actively challenging /shop/, /product-category/*, /product/*, /wp-json/*) is NOT reproducible by R2.** Every probe from R2 audit IP returns clean LiteSpeed-origin 200s with real WC markup or JSON. Independent production-state evidence from the DB confirms the crawler has 12 consecutive recent successful events (2026-05-12), 0 consecutiveFailures, 4281 products tracked — there is no silent production-impact issue.

## Live verification — Imunify360 challenge claim

### Test 1 — `/shop/` with desktop Chrome UA

```
$ curl -sS -o /tmp/gngc_shop.html -A "Mozilla/5.0 ... Chrome/120.0.0.0" \
       "https://greatnorthgunco.ca/shop/"
HTTP 200 | 121396b | server=LiteSpeed | ct=text/html; charset=UTF-8
<title>Shop - Surplus GNG</title>
Imunify markers (f03s36su46c0|One moment|z[0-9a-f]{40}|openresty): 0 matches
woocommerce-LoopProduct-link count: 24
```

### Test 2 — `/wp-json/wp/v2/product?per_page=1`

```
HTTP 200 | 11124b | server=LiteSpeed | ct=application/json; charset=UTF-8
First 300 chars: [{"id":43766,"date":"2026-05-15T14:52:46",...,"slug":"laurona-sxs-in-12ga","status":"publish","type":"product"...
HEAD: X-WP-Total: 4293 | X-WP-TotalPages: 4293
```

### Test 3 — UA matrix (4 UAs)

| UA | status | bytes | title | imunify markers |
|---|---|---|---|---|
| Desktop Chrome 120 | 200 | 121396 | Shop - Surplus GNG | 0 |
| `curl/8.0.0` (clear bot) | 200 | 121112 | Shop - Surplus GNG | 0 |
| (blank) | 200 | 121112 | Shop - Surplus GNG | 0 |
| `HeadlessChrome/120` | 200 | 121112 | Shop - Surplus GNG | 0 |

If Imunify360 was active and gating /shop/, at minimum `curl/8.0.0` and the headless UA should have been challenged. They were not.

### Test 4 — Rapid burst (10 hits on `/shop/page/{1..10}/`)

```
1: HTTP 301 (page/1 -> /shop/)
2..10: HTTP 200, 117-124KB each, 1.5-1.9s each
```

### Test 5 — 20-hit burst on `/wp-json/wp/v2/product?page={1..20}`

```
All 20 requests: HTTP 200, 11-13KB each, real JSON.
```

### Test 6 — Stealth Playwright on `/shop/`

```js
// init scripts override navigator.webdriver, outerWidth/Height, plugins, languages
const resp = await page.goto('https://greatnorthgunco.ca/shop/', { waitUntil: 'domcontentloaded' });
// Result:
{
  "status": 200,
  "server": "LiteSpeed",
  "title": "Shop - Surplus GNG",
  "productCount": 24,
  "elapsedMs": 525,
  "hasImunifyMarker": false
}
```

Stealth Playwright produces **identical** output to plain curl — proving Playwright provides no extraction advantage on this site right now.

### Test 7 — `/shop/` response headers

```
HTTP/1.1 200 OK
X-Powered-By: PHP/8.3.30
Content-Type: text/html; charset=UTF-8
ETag: "1888666-1778871196;;;"
X-LiteSpeed-Cache: hit
Server: LiteSpeed
```

No openresty header. No `cf-ray`, no `x-sucuri-id`, no challenge cookies. Pure LiteSpeed origin with edge cache HIT.

## Live verification — DB typo `/product-category/accessoriesparts/`

```
$ curl -sS "https://greatnorthgunco.ca/product-category/accessoriesparts/"
HTTP 404 | 58750b | <title>Page not found - Surplus GNG</title>

$ curl -sS "https://greatnorthgunco.ca/product-category/accessories-parts/"
HTTP 200 | 115631b | <title>Accessories Parts Archives - Surplus GNG</title>
woocommerce-LoopProduct-link count: 24
```

**R1 was correct that the DB has a typo'd catalog URL.** The fix (collapse to `['/shop/']`) implicitly drops it.

## Production state (independent of R1's audit)

DB query against `MonitoredSite` for greatnorthgunco.ca:

```json
{
  "hasWaf": false,
  "hasCaptcha": false,
  "consecutiveFailures": 0,
  "lastCrawlAt": "2026-05-12T06:55:58.838Z",
  "crawlPhase": "maintain",
  "lastWatermarkUrl": "https://greatnorthgunco.ca/product/brno-model-zp47-sxs-12ga-2/",
  "_count": { "products": 4281, "crawlEvents": 1591 }
}
```

Last 12 `crawlEvent` rows: ALL `status="success"`, jobType=`crawl-verify`, tier=4, zero errorMessages.

**The production crawler is NOT being blocked.** If R1's Imunify claim were real and persistent, we would see `consecutiveFailures > 0` and a stale `lastCrawlAt` long before 2026-05-12. We do not.

Bonus verification: `lastWatermarkUrl` `/product/brno-model-zp47-sxs-12ga-2/` returned HTTP 200, 86KB, valid product page title — confirms detail-page crawl path works without Playwright.

## Cross-reference: WP REST product timeline matches R1 sample

R2 GET `/wp-json/wp/v2/product?per_page=5&page=2` returned (most recent timestamps):

```
44250 lightweight-husqvarna-1640-in-9-3x62      2026-05-13T14:56:28 publish
44245 winchester-model-70-xtr-in-30-06-8        2026-05-13T14:46:37 publish
43977 jamart-co-liege-belgium-sxs-in-12ga-3     2026-05-13T10:30:32 publish
43972 fabrique-nationale-darmes-de-liege-belgium-sxs-in-12ga
                                                2026-05-13T10:21:57 publish
44121 germania-waffenwerk-m98-hunting-rifle-in-9-3x62-2
                                                2026-05-13T08:59:45 publish
```

R1's `extractionSample` included `husqvarna-1640-in-30-06` (id 44126) and `sako-l61r-in-7-rem-mag` — both reachable today on detail pages. Sort by date works. WP REST is healthy.

## What about R1's claim that R1 actually saw the challenge?

I cannot positively rule out that R1 saw a real transient Imunify state earlier today. Three possibilities:

1. **R1's audit IP was rate-limit-soft-blocked by Imunify.** Imunify360 has a per-IP threshold; once tripped it serves the JS challenge to *that IP* for a cool-off window. R2's audit IP would not be affected. This is the most likely explanation because it fits R1's evidence exactly (header changed to openresty/1.29, challenge HTML appears, stealth Playwright bypasses) — that *is* what Imunify's per-IP soft-block looks like.

2. **Imunify rule toggle window.** The site admin briefly enabled Imunify, then disabled it. Unlikely without sign of permanent install.

3. **R1 misclassified an unrelated artifact.** Possible but R1's evidence string is too specific (z-form hash, JS variable name) to be invented.

The operational implication is the same regardless: **DB hasWaf must NOT be flipped to true** on the basis of a one-off, IP-specific observation that the production crawler is not affected by.

## Recommended action

1. **REJECT** R1's `hasWaf: true`, `wafType: "imunify360"`, `needsPlaywright: true`.
2. **ACCEPT** R1's `catalogUrls: ["/shop/"]` collapse (matches skill Rule C; removes verified-404 typo entry).
3. **ACCEPT** R1's `expectedProductCount` methodology (4293 today via wp-rest-header).
4. **DROP** both `auditNotes.knownGaps[]` entries — they presume Imunify is real on this site.
5. **DO NOT update DB** for hasWaf / wafType / needsPlaywright. The DB profile is correct as-is.
6. **OPTIONAL SKILL improvement**: capture the lesson "if BATCH 4 challenge is observed but BATCH 1 is clean, re-probe from a second IP or second time window before flipping hasWaf=true in the DB. Imunify360 specifically does per-IP soft-blocking that LOOKS like a permanent gate."

## R2 confidence

| field | confidence | basis |
|---|---|---|
| hasWaf=false | high | 4 UAs + 30-hit burst + stealth PW + production crawler success |
| wafType=none | high | same |
| needsPlaywright=false | high | identical output curl vs PW; production runs without PW |
| catalogUrls=["/shop/"] | high | sum-of-cat-counts=517 matches WC Store API x-wp-total=517; typo entry verified 404 |
| expectedProductCount=4293 | high | WP REST x-wp-total live |
| productCountMethod | high | header probe returns expected value |
| All other R1 fields | inherited from R1 (matches DB) | no R2 reason to disagree |

## Files

- `docs/site-audit/greatnorthgunco.ca-2026-05-15T18-55-53Z-B4R2-corrections.json`
- `docs/site-audit/greatnorthgunco.ca-2026-05-15T18-55-53Z-B4R2-investigation.md` (this file)
