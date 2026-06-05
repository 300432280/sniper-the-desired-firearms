# basspro.ca B6R2 Investigation — Live Verification

Round: **R2 LIVE** (persona: testing-api-tester). Counter-test of R1's blind candidate at `docs/site-audit/basspro.ca-2026-05-23T18-00-00Z-B6R1.json` against the DB snapshot at `_audit_tmp/batch6-2026-05-23/basspro.ca-DB-snapshot.json` and against the live site. No DB writes. ~22 min budget used.

## Method

Single-GET probes with 800ms inter-request delays. Used the R1-recommended UA (Safari 17 macOS) with full browser Accept-Language + Accept-Encoding (br/gzip via curl `--compressed`). Avoided Playwright per mission instruction (Akamai TLS fingerprinting documented in R1 as blocking it anyway). Probes saved under `_audit_tmp/batch6-2026-05-23/basspro-*.html`.

Test sequence:

1. `GET /home` (homepage HTML, decoded with `--compressed`)
2. `GET /robots.txt`
3. `GET /webapp/wcs/stores/servlet/sitemap_10151.xml.gz` + gunzip + grep counts
4. `HEAD /home` (header inspection for Akamai/WAF markers)
5. `GET /webapp/wcs/stores/servlet/SearchDisplay?...&searchTerm=glock` (R1 endpoint, real query)
6. `GET /webapp/wcs/stores/servlet/SearchDisplay?...&searchTerm=xyz789nonsense` (B3 junk-keyword diff test)
7. `GET /l/firearms` (SSR product count check on R1's first dept proxy)
8. `GET /l/firearms?page=2&firstResult=12` (Akamai pagination block check)
9. `GET /search?q=glock` (DB-claimed searchUrl path)
10. Burst 8x `GET /l/* + /c/*` (cross-check DB vs R1 catalogUrls existence — quota-tested)

## Key live results

### Platform — R1 wins

Homepage line 189 of decoded HTML contains, by literal grep, the tokens:

- `wcParamJs` (twice in window.wcParamJs config object)
- `10151` (storeId)
- `10052` (catalogId)
- `prodlivengca` (×3, the internal WC backend host `prodlivengca.basspro.net`)

These are unambiguous IBM/HCL Commerce fingerprints. The DB value `generic-retail` was the adapter-fallback label, not a fingerprinted platform. R1's `ibm-websphere-commerce` is correct.

### wafType — R1 wins (Akamai, not "akamai-or-imperva")

`curl -sI` on `/home`:

```
X-Akam-SW-Version: 0.5.0
Set-Cookie: akavpau_c_=1779679932~id=811192c292afdd130bd3c4c540a8b93d; Domain=www.basspro.ca; Path=/; HttpOnly; Secure; SameSite=None
```

`/l/firearms?page=2&firstResult=12` returned HTTP 200 with a 2060-byte Akamai behavioral challenge body containing literal `Powered and protected by Akamai`, akamai-logo1.svg embed, and the `akam-sw.js` v1.3.6 service-worker installer. No Imperva markers (`incap_ses`/`visid_incap` cookies, `X-Iinfo` header). DB's `-or-imperva` hedge is unsupported.

Note: my probe got `Server: nginx` (not `Server: AkamaiGHost` as R1 cited). This is consistent — Akamai Bot Manager can be deployed at the origin via an nginx integration; the `X-Akam-SW-Version`, `akavpau_c_`, and `bm_*` cookies are the definitive markers regardless of `Server:` header.

### expectedProductCount — R1 wins (16526 vs R1's 16543 — 17 drift)

Sitemap `/webapp/wcs/stores/servlet/sitemap_10151.xml.gz` returned HTTP 200, 289311 bytes gzip, decompresses to 2.22MB XML. Grep `<loc>https?://[^<]*?/p/[a-z0-9-]+` returned 16526 matches. R1's 16543 is within 17 items — consistent with normal catalog turnover over the ~2 days since R1's run.

DB's `null` reflects the original investigator (2026-04-04) reported "sitemap.xml returns 403" without reading the WebSphere-specific path explicitly listed at robots.txt line 8.

### productCountMethod — R1 wins

`product-count-probe.ts:110` `VALID_METHOD_NAMES` array includes both `'generic-product-sitemap'` (line 117) and `'stream-page-count'` (line 121). Both are runtime-valid. Per-method case branches at lines 313 and 420. R1's `generic-product-sitemap` is the live-verifiable method given the sitemap fetched cleanly; DB's `stream-page-count` requires walking `/l/` paginated pages which Akamai blocks at page 2.

### searchUrl — R1 wins, B3 junk-keyword diff test PASSED

| Endpoint | Status | Size | totalSearchCount |
|---|---|---|---|
| `/search?q=glock` (DB) | 404 | 49556B SPA shell | n/a |
| `.../SearchDisplay?...&searchTerm=glock` (R1) | 200 | 90915B | **12** (line 17992) |
| `.../SearchDisplay?...&searchTerm=xyz789nonsense` (R1) | 200 | 49401B | **0** (line 3067) |

Size delta + matching count delta (12 vs 0) confirms the endpoint is a real, differentiating search. **B3 junk-keyword diff test PASSED.**

I tested `langId=-1` (not R1's `langId=-10`) and both returned valid totalCount — the param is forgiving, so R1's value preserved.

robots.txt line 15 `Disallow: /shop/SearchDisplay` does NOT cover R1's path `/webapp/wcs/stores/servlet/SearchDisplay` — different surface, not disallowed.

### needsPlaywright — aligned (both correct)

`GET /l/firearms` returned 56675B SSR HTML with zero matches for `/p/[a-z0-9-]+` regex. The category page renders products client-side, so a static fetcher would extract no products. Both R1 and DB correctly say true.

### catalogUrls — R1 wins on shape, but both lists have gaps

All 13 DB `/l/*` slugs exist in sitemap. All 3 R1 `/c/*` slugs exist in sitemap. Sitemap also contains 5 firearm-relevant `/l/*` slugs missing from BOTH lists (DB has 13/18, R1's dept-spine doesn't enumerate leaves):

| Missing from DB | Sitemap line |
|---|---|
| `/l/firearms` | 14826 |
| `/l/red-dot` | 12855 |
| `/l/optics-accessories` | 12864 |
| `/l/primers-powder` | 18573 |
| `/l/magazines` | 19890 |

R1's 3 `/c/*` dept-spine is structurally correct per SKILL.md `topLevelCategories` rule, but does not enumerate the operational leaves. R4 should merge: keep R1's 3 `/c/*` as `catalogUrls` AND store all 18 firearm-relevant `/l/*` leaves in `topLevelCategories.categories` as the walk targets when Akamai bypass exists.

Live walk-to-prove minimum-cover impossible (Akamai 403'd 8/8 in the test burst).

### perPage, paginationPattern, sortParam — untested-by-bot-manager

All three depend on the ability to fetch page 2 of any `/l/*` URL. Live test: `/l/firearms?page=2&firstResult=12` returned the Akamai behavioral challenge interstitial (`sec-if-cpt-container` + `akam-sw.js v1.3.6`). 3-outcome counter-control test for sort is impossible from current IP. R1's values are inferences from robots.txt line 33 `Allow: /l/*?page=*&firstResult=*`; DB's `perPage:20` has no live source. Neither verified.

### crawlers.watermark.method — inconclusive (schema-shape only)

DB pre-dates the watermark/maintain split. R1's `full-catalog-sweep` is operationally correct given (a) no exposed product-list API, (b) Akamai blocks pagination, (c) sitemap can be walked once via .gz fetch. Reason text accurate.

## Verdict counts

- R1 wins: **9** (platform, wafType, expectedProductCount, productCountMethod, searchUrl, needsPlaywright, productUrlSchemes, catalogUrls-shape, userAgentOverride)
- DB wins: 0
- Both wrong: 0
- Inconclusive (schema-shape): 2 (wafWorkaround, crawlers.watermark.method)
- Untested-by-bot-manager: 3 (perPage, paginationPattern, sortParam/sortVerified)

## R3 attack surfaces

1. **Verify the SearchDisplay endpoint is not a `Disallow` violation in disguise.** robots.txt line 15 says `Disallow: /shop/SearchDisplay`. R1's URL is `/webapp/wcs/stores/servlet/SearchDisplay`. R3 should grep robots.txt for any rule that COULD match the WebSphere path and confirm the diff (I did this; no match found). Also confirm the FirearmAlert crawler honors robots.txt — if so, even a working URL might be blocked at the policy layer.

2. **Cross-validate B3 diff test with a Canadian-firearm-restricted term.** I tested `glock` (Restricted in Canada). Try `xyz789nonsense` AND `pez-dispenser-fake` AND a non-firearm-but-real term like `tent` to confirm the endpoint isn't returning 0 for any non-product term and 12 for any product term — it should differentiate by SKU presence specifically.

3. **Look for `?lang=fr` or `&storeId=10152` variants** in robots.txt / sitemap to see if there's a French-Canadian mirror that might be probeable from a different Akamai per-host quota.

4. **wafWorkaround divergence**: R1 emitted `null` (omitted), DB has `{method: 'none-known', notes: ..., investigatedAt: 2026-04-04}`. R3 should clarify whether R1's `null` is intentional or schema noise; if intentional, the 2026-04-04 investigator's notes (`paid proxy/anti-detect service, affiliate product feed, manual data entry`) should still be preserved in R4 audit notes.

5. **Test if generic-retail extractor on a Playwright-rendered `/l/firearms` page actually extracts products.** R1 claims SSR has 0 products (verified) but doesn't show a Playwright fetch returning the same 0 — generic-retail may or may not have a selector that matches the React-rendered DOM. Persona engineering-code-reviewer (R3) should grep `generic-retail.ts` for Next.js / React-app selectors and assess whether the existing fallback path would extract products from a Playwright-rendered basspro.ca /l/ page if Akamai bypass existed.

## Blockers

1. **Akamai blocks paginated fetches** — perPage/paginationPattern/sortParam remain untestable from cloud IPs.
2. **Akamai per-session quota** — 8-URL burst 403'd all 8 after single GETs succeeded, preventing catalogUrl walk-and-dedupe coverage proof.
3. **langId variance** — R1 used `-10`, I tested `-1`; both worked, so the parameter is forgiving but the canonical value isn't verified.

## Files produced

- `d:\Projects\FIREARM-ALERT\docs\site-audit\basspro.ca-2026-05-23T19-00-00Z-B6R2.json` (machine-readable verdicts)
- `d:\Projects\FIREARM-ALERT\docs\site-audit\basspro.ca-2026-05-23T19-00-00Z-B6R2-investigation.md` (this file)
- Probe scratch: `d:\Projects\FIREARM-ALERT\_audit_tmp\batch6-2026-05-23\basspro-*.html`, `basspro-sitemap.xml(.gz)`, `basspro-robots.txt`
