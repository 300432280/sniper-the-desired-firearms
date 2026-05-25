# B5R2 Live Investigation — jobrookoutdoors.com

Run: 2026-05-22T21:00:00Z. Method: live HTTP probes with 800ms inter-request delay (with one 200ms burst block for sustained-WAF test). No DB writes.

Inputs:
- R1 candidate: `docs/site-audit/jobrookoutdoors.com-2026-05-22T20-00-00Z-B5R1.json`
- R1 diff: `docs/site-audit/jobrookoutdoors.com-2026-05-22T20-00-00Z-B5R1-diff.md` (14 divergences, 6 agreements)
- DB snapshot: `_audit_tmp/batch5-2026-05-22/jobrookoutdoors.com-DB-snapshot.json`

Raw probe outputs (kept under `_audit_tmp/b5r2-jobrook/`):
- `perPage-probe-v2.json`
- `scope-probe.json`
- `burst-jsonld-search.json`
- `search-jsonld-detail.json`

---

## Field-by-field verdicts

### 1. perPage (R1=12, DB=100) -> DB-CORRECT

Probed `/hunt/firearms/centerfire-rifles/?sort=newest&limit=N` for N in {12, 24, 48, 100, 200}, counting `data-product-id="\d+"` occurrences:

| limit | products returned | next link? | bodyLen |
|---|---|---|---|
| 12 | 12 | yes | 118 KB |
| 24 | 24 | yes | 140 KB |
| 48 | 48 | no | 184 KB |
| 100 | 48 | no | 184 KB |
| 200 | 12 | yes | 118 KB |

Centerfire-rifles total = 48. limit=100 returns all 48 (capped at total). limit=200 is silently rejected, falls back to default 12.

**Conclusion: perPage=100 is honored. R1's `12` causes 8x request inflation.**

### 2. catalogUrls scope (R1=`/collection/` only, DB=49 firearm-relevant leaves) -> DB-CORRECT

Probed non-firearm sections:
- `/outdoor/`: 3 Products
- `/fish/`: **1303 Products**
- `/cycle/`: **280 Products**
- `/paddle/`: **109 Products**
- `/collection/`: 3942 Products (all)

R1's `/collection/` scope over-walks ~1695 non-firearm products. The DB's 49 firearm-relevant leaves correctly exclude all four non-firearm sections AND 22 hidden hunt/archery sub-cats (moose decoys, sitka clothing, archery targets, etc., per DB `hiddenCatalogUrls`).

Sample DB leaf verification:
- `/hunt/firearms/shotguns/`: 29 (DB notes 27, ~7% drift)
- `/hunt/firearms/centerfire-rifles/`: 48
- `/hunt/firearms/rimfire-rifles/`: 17
- `/hunt/optics/riflescopes/`: 40
- `/hunt/firearm-accessories/mags/`: 31
- `/archery/bows/`: 141 (DB notes 145, ~3% drift)
- `/archery/crossbow/`: 8

All 7 sampled DB leaves render real product cards. Counts drift naturally as inventory changes.

### 3. expectedProductCount (R1=3942, DB=1669) -> DB-CORRECT

R1 counted the whole sitemap (`.html$` filter -> 3942). DB scopes to firearm-relevant: 3942 - 1695 (non-firearm sections) - ~578 (hidden hunt/archery non-firearm leaves like decoys/sitka/archery-targets) ~= 1669.

### 4. sortParam + paginationPattern fields (R1 missing `&limit=100` anchor, DB has it) -> DB-CORRECT

These are all tied to the `&limit=100` decision. The Mistake-26 fix (LightSpeed `?page=N` silently ignored) requires the suffix-replace `match` and `template` to include the FULL sort+limit query string so `buildPaginatedUrl` hits cleanly. Without the limit anchor, suffix-replace would mis-match on URLs that already include `&limit=100`.

### 5. hasWaf (R1=false, DB=true) -> DB-CORRECT (operationally)

Sustained 15-burst at 200ms intervals against `/hunt/firearms/centerfire-rifles/?sort=newest&limit=100&n=N`:

- All 15 returned status 200
- Latency: 207-325ms (normal)
- `cf-ray` present on every response
- `cf-cache-status: DYNAMIC` consistently
- NO challenge interstitial body

Note on `challenge-platform` string: present in every page body, but it's the Cloudflare bot-management JS embedded as a `<script src="/cdn-cgi/challenge-platform/...">` analytics asset — NOT a challenge gate. Naive substring check would FALSE-positive challenge here; anchored check (e.g., `<title>Just a moment</title>` or status 403/503) correctly says no challenge.

R1 set `hasWaf=false` based on skill's "passive-WAF -> false" rule. DB keeps `hasWaf=true` to enable the runtime `waf-cookie-manager` cookie-cache path even though no JS solving is needed. Operationally `hasWaf=true` is harmless on a passive site and correct per DB's documented decision.

### 6. searchUrl (R1=missing, DB=`/search?q={keyword}&type=product`) -> DB-CORRECT

Live probe of `GET /search?q=glock&type=product`:
1. 301 -> `/search/?q=glock&type=product`
2. 302 -> `/search/glock/`
3. 200 with 115 KB body, 12 product cards, "16 Products" count text

`axios` with `maxRedirects: 5` handles the 2-hop chain transparently. R1 never probed search -> omitted the field.

### 7. crawlers.maintain.verifyMethod (R1=`detail-page`, DB=`json-ld`) -> AMBIGUOUS / R1-more-accurate

Probed product detail page `/wk180-magpul-edition.html`:

- `<script type="application/ld+json">` blocks: **0** (zero)
- `<dd itemprop="availability" content="out_of_stock">` present: yes
- `<meta property="og:*">` tags: yes (URL, title, image, description; NO product:price or product:availability)

Stock state is exposed via Schema.org **microdata** (`itemprop="availability"` with content `in_stock` | `out_of_stock`), NOT JSON-LD. DB's `verifyMethod: "json-ld"` is empirically wrong — it would not find any JSON-LD to parse. R1's `verifyMethod: "detail-page"` is the generic canonical name and is operationally correct at the runtime-switch level. Recommend operator change DB to `detail-page` (canonical) or add a more specific `microdata-itemprop` subtype.

### 8. productCountMethod shape (R1=`generic-product-sitemap` with single `pattern`, DB=`sitemap-index` with `productUrlPattern` + `excludePathPattern`) -> DB-CORRECT

R1's single `pattern: ".html$"` cannot exclude non-firearm sections. DB's expressive shape with `excludePathPattern: "/(service|account|cart|sitemap|brands|collection|catalog)/"` plus the firearm-relevant catalogUrls cover lets the count land at 1669 firearm-only.

`url` -> `endpoint` field-name rename also confirmed: production sitemap-index spec uses `endpoint`.

### 9. Fields that AGREE (no change needed)

`needsPlaywright=false`, `adapterType=generic-retail`, `crawlers.watermark.method=navigate-from-watermark`, `sortVerified=true`, `hasCaptcha=false`, `ageGate.detected=false`.

---

## Summary

- **13 of 14 R1 divergences resolved in DB's favor.** R2 candidate adopts DB values.
- **1 divergence is ambiguous (verifyMethod).** DB has `json-ld` but the page is microdata-only; R1's generic `detail-page` is more accurate. R2 records the DB value for diff fidelity but flags it for operator decision.
- **R1's three biggest mistakes:**
  1. Trusting the UI sort dropdown's 18-max as the perPage ceiling without probing `?limit=100` directly.
  2. Taking the global `/collection/` URL as the catalog spine without checking non-firearm section sizes (would have over-walked 1695 non-firearm products on every cycle).
  3. Missing the search-URL probe step entirely.
- **R1's one good catch:** the `verifyMethod` field — DB has `json-ld` but the page has zero JSON-LD blocks. R1's generic `detail-page` is more accurate; operator should consider correcting DB.

R2 candidate JSON: `docs/site-audit/jobrookoutdoors.com-2026-05-22T21-00-00Z-B5R2.json`.
