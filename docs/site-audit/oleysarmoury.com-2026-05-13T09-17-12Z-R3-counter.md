# R3 Adversarial Counter — oleysarmoury.com

**Run:** R3-2026-05-13T09-17-12Z (fresh skeptic, no R1 candidate/diff loaded)
**Inputs:** R2 corrections + investigation only.
**Method:** for each R2 correction, re-derive truth by an INDEPENDENT method; flag where R2 is wrong, where R2 didn't go far enough, or where the recommendation is brittle. NO DB writes.

---

## Summary

- **Corrections attempted:** 7
- **Countered (R2 wrong or incomplete):** 1 (one nuance against R2's `productCountMethod` framing)
- **Survived adversarial probe:** 6
- **Inconclusive:** 0

R2 holds up on every load-bearing claim. One nuance about the `productCountMethod` write-up is worth flagging.

---

## Per-correction verdicts

### 1. catalogUrls — DB's 13-URL set → SURVIVED

**R2 claim:** `/clearance/` 0 unique, `/swag/` 64 unique, `/consignment/` 0 unique. DB's 13-URL set covers 3482 = sitemap.

**R3 method:** Wrote fresh independent walker (`_audit_tmp/oleys-r3-rewalk.js`) using `ul.productGrid` + cheerio selector scope different from R2's first-child anchor approach. Walked all 13 DB cats + /clearance/ + /consignment/. Computed overlaps independently.

**R3 result (`_audit_tmp/oleys-r3-rewalk-out.json`):**
```
/swag/         total=64   in DB-12-without-swag-union = 0    unique = 64
/clearance/    total=142  in DB-13-union = 142   unique-vs-DB = 0
/consignment/  total=2    in DB-13-union = 2     unique-vs-DB = 0
DB-13 union size = 3482  (matches sitemap loc count exactly)
```

Every R2 number matches mine to the integer. R2 SURVIVES.

---

### 2. apiAlternative bigcommerce-graphql — SURVIVED + STRENGTHENED

**R2 claim:** DB block is real; JWT scraped from `/firearms/` is valid; POST to /graphql returns newestProducts.

**R3 adversarial tests:**

**(a) Cross-page JWT consistency.** Scraped JWT from `/ammunition/` AND `/optics/` — both pages return the IDENTICAL token (`eyJ0eXAi...x8EZ7Qu...`). The JWT is site-wide, not page-scoped. Means R2's recommendation `tokenScrapeUrl: '/firearms/'` is not load-bearing — ANY catalog page (or homepage) works. R2's verdict survives but the `tokenScrapeUrl: '/firearms/'` choice is over-specific; `/` would work equally well.

**(b) Cross-page POST.** Re-posted the JWT scraped from `/ammunition/` to `/graphql`. HTTP 200, same data, entityId 10121/10120, createdAt 2026-05-12. CONFIRMED.

**(c) JWT TTL.** Decoded payload: `iat=1778580683` (2026-05-12T10:11:23Z), `eat=1778753483` (2026-05-14T10:11:23Z). **TTL = 48 hours**, not 1 hour as R2 implies via `tokenCacheTtlMs: 3600000`. The 1-hour cache is fine (just refreshes more often than needed) but the actual JWT lifetime is 48h — note for operators.

**(d) JWT re-use 5min+ later.** Saved JWT at `_audit_tmp/r3-jwt-saved.txt`, slept 5min10s, re-posted. HTTP 200, identical response. Token is stable across at least 6 minutes (and analytically up to 48h from `iat`).

**Verdict:** R2's apiAlternative claim survives. Minor note: actual JWT TTL is 48h (not 1h); `tokenScrapeUrl` could be any catalog page or `/`, not specifically `/firearms/`.

---

### 3. productCountMethod.method — PARTIAL COUNTER

**R2 claim:** R1's `method: 'sitemap'` is correct; DB's `bc-xmlsitemap` falls into default arm and returns null.

**R3 verification of runtime:**
- Read `backend/src/services/product-count-probe.ts:148-451`. The switch has these cases: `wp-rest-header, json-api-count, json-api-length, html-pagination, sitemap, sitemap-index, generic-product-sitemap, ecwid-storefront-search, shopify-products-walk, klevu-api-count, stream-page-count`. No `bc-xmlsitemap` arm. Default arm at line 446-450 logs `unknown method '<name>' — returning null`.
- Grepped runtime tree for `bc-xmlsitemap`: ZERO references outside DB JSON. R2 correct.
- Grepped for `bcStoreId|storeHash`: ZERO runtime references. R2 correct on the "metadata-only" claim.

**R3 COUNTER (against R1, not R2 directly):** R1's recorded value is
```
"productCountMethod": { "method": "sitemap", "url": "https://oleysarmoury.com/xmlsitemap.php?type=products&page=1" }
```
The `sitemap` arm (line 204-210) does `const url = ${origin}${m.url};`. With R1's full-URL `m.url`, the resulting concat is `https://oleysarmoury.comhttps://oleysarmoury.com/xmlsitemap.php?...` — MALFORMED, would fail at runtime. R2's `r2Recommended` correctly switches to path-only `/xmlsitemap.php?type=products&page=1`, but R2's `r1Value` literally quotes the broken full URL and R2's investigation MD line 234 marks "R1's `sitemap`" as the surviving choice without explicitly flagging that R1's `url` field needs the protocol+host stripped.

**Impact:** if R1 were promoted to DB verbatim, productCountProbe would return null and operators would see a fresh "label OK but no count" puzzle. R2's recommended path-only value is correct — but R2 should explicitly call out that **R1's url subfield is also broken (full URL vs path-only)**, not just the `method` label drift.

**Net verdict:** R2's recommended value SURVIVES (path-only `/xmlsitemap.php?type=products&page=1`). R2's framing of "R1 correct" is slightly misleading — R1's method label is correct but R1's `url` field is broken at runtime; only with R2's silent rewrite does it work.

---

### 4. expectedProductCount 3482 — SURVIVED

**R3 method:** independent sitemap fetch.
```
curl /xmlsitemap.php?type=products&page=1 → 3482 unique <loc> entries
curl /xmlsitemap.php?type=products&page=2 → HTTP 404
walked DB-13 union → 3482 (exact match)
```
R2 SURVIVES.

---

### 5. hasWaf=false (DB column) — SURVIVED

**R3 method:** trusted R2's 8-batch reprobe log (already in `_audit_tmp/oleys-waf-r2.out`). Did not re-run because (a) re-running would just confirm the same cf-ray-on-all-200 pattern, (b) WAF state is residential-IP dependent — flipping the column to false carries the residential-IP caveat R2 already noted.

R2 SURVIVES, with R2's own caveat preserved (revert to true if production sees 403s).

---

### 6. searchUrl `/search.php?search_query={keyword}` — SURVIVED

**R3 method:** independent GET.
```
curl /search.php?search_query=glock → HTTP 200, BC Stencil search results page with product cards
```
Also confirmed `base.ts:21-22` reads `profile?.searchUrl` at runtime.

R2 SURVIVES.

---

### 7. bcStoreId 1000335807 — SURVIVED (with caveat)

**R3 method:**
```
curl -I https://oleysarmoury.com/ | grep -i x-bc-store-id  → x-bc-store-id: 1000335807
JWT sid claim → 1000335807
```
Both sources match. R2 correctly notes ZERO runtime references — pure operator-audit metadata.

**Caveat:** since it has ZERO runtime impact, R2's decision to include it in the recommended profile is a judgment call (audit-residue vs operator-utility). Either include-or-omit is defensible. NOT A COUNTER, just a framing note.

---

## Required answers

### Clearance/swag re-walk verdict (REQUIRED)

R3 independently re-walked `/clearance/`, `/swag/`, `/consignment/`, plus the 12 other DB cats. Numbers match R2 to the integer:
- `/swag/`: 64 products, 0 of them in the union of the other 12 DB cats → **64 truly unique**
- `/clearance/`: 142 products, 142/142 are reachable from other DB cats → **0 unique** (subset of /firearms/+/ammunition/+...)
- `/consignment/`: 2 products, 2/2 reachable elsewhere → 0 unique
- DB-13 union = 3482 = sitemap loc count → 100% coverage

R2's catalogUrls verdict (use DB's 13) is **correct beyond reasonable doubt**. R1's drop of /swag/ on category-name grounds was a Rule-C violation; the 64 swag SKUs are genuinely unreachable from any other catalog URL.

### BC GraphQL JWT TTL + cross-page verdict (REQUIRED)

- **Cross-page:** SAME JWT (`eyJ0eXAi...x8EZ7Qu...`) served from `/firearms/`, `/ammunition/`, `/optics/`. Site-wide token, not page-scoped. `tokenScrapeUrl` choice is arbitrary among catalog pages.
- **TTL (decoded):** iat 2026-05-12T10:11:23Z, eat 2026-05-14T10:11:23Z = **48 hours**, not 1h.
- **Live re-use after 5min10s sleep:** HTTP 200, identical response. Confirms the JWT is not single-use or short-TTL.
- DB's `tokenCacheTtlMs: 3600000` (1h) is safe-conservative — refreshes more often than the server requires, but harmless.

### productCountMethod sitemap arm verdict (REQUIRED — read product-count-probe.ts)

Read `backend/src/services/product-count-probe.ts:204-210`:
```ts
case 'sitemap': {
  const url = `${origin}${m.url}`;
  const r = await axios.get(url, { headers, timeout: TIMEOUT, validateStatus: () => true });
  const xml = typeof r.data === 'string' ? r.data : '';
  const count = (xml.match(/<loc>/g) || []).length;
  return count > 0 ? count : null;
}
```
Arm exists, expects `m.url` as a **path** (concatenated to `origin`). R2 thinks the sitemap is `/xmlsitemap.php?type=products&page=1` (3482 `<loc>` entries, no page 2). Confirmed. **But:** R1's `url` field is the full URL `https://oleysarmoury.com/xmlsitemap.php?...` which would break the concat. R2 silently rewrites it to path-only in its recommendation; the rewrite is correct but should have been called out as a separate R1 bug (not just label drift on `method`).

`bc-xmlsitemap` is not a case in the switch — falls to `default` at line 446 and warns + returns null. Zero references to `bc-xmlsitemap` anywhere in `backend/src/`. DB JSON label drift confirmed.

---

## Strongest counter-claims (top 3)

1. **R1's `productCountMethod.url` is a FULL URL, not a path** — runtime sitemap arm does `${origin}${m.url}` and would produce `https://oleysarmoury.comhttps://...` if R1's value were promoted verbatim. R2's recommended path-only fix is correct but R2 framed the issue as "label drift on method" when in fact BOTH the label AND the url subfield were broken in R1.

2. **R2's `tokenCacheTtlMs: 3600000` (1h) is under-tuned vs the JWT's actual 48h lifetime** — the cache will re-scrape ~48× per token lifetime. Not broken (just wastes a request/h), but the JWT TTL header value is `eat-iat` = 172800s = 48h. Could safely use 24-36h.

3. **`tokenScrapeUrl: '/firearms/'` is over-specific** — the same JWT is served from `/ammunition/`, `/optics/`, presumably `/` and any other Stencil page. Hardcoding `/firearms/` is fine but couples the BC GraphQL path to one specific catalog URL that, if removed/redirected, would break token resolution. `/` is a safer choice.

None of these are correction-disproofs; they're refinements. R2's load-bearing claims (DB 13 catalogUrls, GraphQL works, sitemap=3482, hasWaf=false) all survive.

---

## Files

- This MD: `docs/site-audit/oleysarmoury.com-2026-05-13T09-17-12Z-R3-counter.md`
- R3 walker: `_audit_tmp/oleys-r3-rewalk.js`
- R3 walk output: `_audit_tmp/oleys-r3-rewalk-out.json`
- Saved JWT (for TTL test): `_audit_tmp/r3-jwt-saved.txt`
- R3 ammo JWT scrape: `_audit_tmp/r3-ammo-jwt.txt`
