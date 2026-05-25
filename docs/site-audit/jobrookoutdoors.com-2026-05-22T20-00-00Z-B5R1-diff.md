# B5R1 Blind Audit — Divergence Diff for jobrookoutdoors.com

Candidate: `docs/site-audit/jobrookoutdoors.com-2026-05-22T20-00-00Z-B5R1.json`
DB snapshot: `_audit_tmp/batch5-2026-05-22/jobrookoutdoors.com-DB-snapshot.json`

## Divergences (R1 candidate vs DB answer key)

| # | Field | Candidate (R1) | DB (answer key) | WHY (1-line) |
|---|---|---|---|---|
| 1 | `platform` | `lightspeed-ecom` | `shoplightspeed` | Tag drift — DB uses bare brand name; skill table uses canonical `lightspeed-ecom`. Same vendor, lexical-only mismatch. |
| 2 | `hasWaf` | `false` | `true` | DB keeps `hasWaf:true` so the runtime cookie-cache path runs even though `wafType:cloudflare-passive` + `wafWorkaround.method:plain-http`. Skill says set false when passive (B10 column-flip needed at promotion). |
| 3 | `catalogUrls` | 1 URL: `/collection/` | 49 firearm-relevant leaf URLs | Skill Rule C says firearm-relevant scope only; DB enumerates leaves under /hunt/ and /archery/ to exclude non-firearm /outdoor /fish /paddle /cycle. R1 collapsed to global /collection/ which over-walks ~1300 non-firearm products. R1 noted mid-level parents like /archery/bows/ DO render products recursively but did not enumerate. |
| 4 | `expectedProductCount` | 3942 | 1669 | R1 counted whole sitemap (`.html$`); DB scopes to firearm-relevant (~1669 after /hunt + /archery walk dedup at limit=100). |
| 5 | `perPage` | 12 | 100 | R1 took UI dropdown default (12) + UI cap (18); DB probed beyond UI and locked `?limit=100` (8x fewer requests, Mistake 26 fix). |
| 6 | `sortParam` | `?sort=newest` | `?sort=newest&limit=100` | DB bakes `&limit=100` anchor into sortParam so suffix-replace pagination match hits at higher perPage. |
| 7 | `paginationPattern.template` | `page{N}.html?sort=newest` | `page{N}.html?sort=newest&limit=100` | Same match/template pair must include the limit anchor (Mistake 26). |
| 8 | `paginationPattern.match` | `?sort=newest` | `?sort=newest&limit=100` | Suffix-replace `match` must contain the full sort+limit query so it hits in buildPaginatedUrl. |
| 9 | `paginationPattern.perPage` | 12 | 100 | Tied to #5. |
| 10 | `productCountMethod.method` | `generic-product-sitemap` | `sitemap-index` (with custom `productUrlPattern`/`excludePathPattern` keys) | DB's shape includes keys not in the runtime switch's canonical sitemap-index spec; R1 used canonical `generic-product-sitemap` shape {method,url,pattern} but R1's filter is global-only (`.html$`) — does not exclude /outdoor /fish /paddle /cycle paths. |
| 11 | `productCountMethod.url` field name | `url` | `endpoint` | Schema-key drift between docs and DB; runtime probe expects `url`. |
| 12 | `crawlers.maintain.verifyMethod` | `detail-page` | `json-ld` | Both are detail-page strategies; `json-ld` is the more specific subtype that walks JSON-LD blocks for stock. R1 chose generic detail-page. |
| 13 | `searchUrl` | (not set) | `/search?q={keyword}&type=product` | R1 did not probe homepage `<form>` for search action — missed B4 deterministic searchUrl probe step. |
| 14 | `wafWorkaround` | (not set) | `{method:"plain-http", steps:[...]}` | DB documents the "passive WAF, no workaround needed" decision; skill says omit when no malformed headers, but DB keeps as audit-trail. |
| 15 | `needsPlaywright` | `false` | `false` | AGREES. |
| 16 | `adapterType` | `generic-retail` | `generic-retail` | AGREES. |
| 17 | `crawlers.watermark.method` | `navigate-from-watermark` | `navigate-from-watermark` | AGREES. |
| 18 | `sortVerified` | `true` | `true` | AGREES. |
| 19 | `hasCaptcha` | `false` | `false` | AGREES. |
| 20 | `ageGate.detected` | `false` | (not present — implicit false) | AGREES. |

## Blockers

- **catalogUrls scope (#3, #4)** is the highest-value gap. R1 took global /collection/; DB enumerates 49 firearm-relevant leaves. R1 flagged the scope choice in `auditNotes.scopeOverride` but shipped the wider one.
- **perPage + limit anchor (#5, #6, #7, #8, #9)** — R1 stopped at UI dropdown max=18 reading; missed the Stage 5 "probe maximum verifiable perPage" step. ~8x request inflation.

## Top 3 WHYs

1. **catalogUrls scope** — R1 collapsed to `/collection/` because Lightspeed parents (/hunt/, /archery/, /hunt/firearms/) are tile-only AND R1 didn't enumerate the productive mid-level parents + leaves. DB enumerated 49 firearm-relevant leaves to keep scope correct.
2. **perPage 12 vs 100** — R1 didn't probe `?limit=100` directly; the UI dropdown caps at 18, and R1 trusted the UI as the ceiling. DB Mistake 26 fix found `?limit=100` is honored by the server, 8x fewer requests.
3. **`hasWaf` column** — R1 set `false` per skill's "operational, not literal" rule (cloudflare-passive). DB keeps `true`. Discrepancy is whether the runtime cookie-cache path runs at all (B10 column-flip at promotion).

## Divergence count

**14 divergent / 6 agreeing out of 20 compared.**
