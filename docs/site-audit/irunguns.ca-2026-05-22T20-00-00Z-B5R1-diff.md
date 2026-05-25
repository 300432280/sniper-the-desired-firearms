# B5R1 Blind Audit Diff — irunguns.ca

**Round:** R1 (BLIND, no DB read until after candidate)
**Date:** 2026-05-22
**Candidate:** `d:\Projects\FIREARM-ALERT\docs\site-audit\irunguns.ca-2026-05-22T20-00-00Z-B5R1.json`
**Answer key:** `d:\Projects\FIREARM-ALERT\_audit_tmp\batch5-2026-05-22\irunguns.ca-DB-snapshot.json` (DB siteProfile, last verified 2026-04-07)

## Divergence table

| # | Field | Candidate (R1) | DB | WHY (1-line) |
|---|---|---|---|---|
| 1 | `platform` | `custom-php-irunguns` | `custom-php` | Cosmetic — added "-irunguns" qualifier; DB convention is the platform family tag only; harness should match DB convention |
| 2 | `wafType` | `sucuri` | `sucuri-passive` | Candidate did not classify passive-vs-active despite all normal GETs returning 200 (only SQLi/XSS/honeypot triggered 403) — those are rule-selective, not an active challenge wall, so DB's `sucuri-passive` is more precise |
| 3 | `hasWaf` (column flip per B10) | `true` | `true` | Both flagged true, but if wafType is truly passive (no challenge on the crawl path), the operational rule B10 says `hasWaf: false` should flip — candidate failed to apply B10 |
| 4 | `expectedProductCount` | `104` | `84` | Inventory changed between 2026-04-07 (DB) and 2026-05-22 (live) — DB-stale, candidate correct; live "Showing 104 result" confirms 104 today |
| 5 | `productCountMethod.method` | `html-pagination` | `sum-showing-result-markers` | DB method name is NOT in the 11 canonical runtime methods (`product-count-probe.ts:148-451`) — would silently fall through to `default: return null` and disable the count probe; candidate's `html-pagination` is canonical, but the selector+perPage:1 shape may not match the runtime's expected last-page-anchor shape — both are problematic in different ways |
| 6 | `catalogUrls` | `["https://irunguns.ca/product.php"]` (1 URL, bare) | 11 per-dept URLs incl. 3 zero-product depts | Candidate chose the single 100%-coverage aggregator; DB uses the per-dept spine; per Rule C the smallest URL set wins so 1 URL beats 11 if coverage equals, but DB's per-dept layout preserves category attribution and recovers products today flagged 0 (Handguns/Knives/Custom_Engraving) when they have inventory again |
| 7 | `catalogUrls` path style | absolute `https://irunguns.ca/...` | relative `/product.php?...` | Candidate emits absolute URLs; DB convention is path-relative — runtime builds the URL via `${origin}${path}` so the candidate's absolute-form is also acceptable but inconsistent with the established convention |
| 8 | `perPage` | `104` | `100` | Candidate set perPage to the live full-catalog size; DB hard-codes 100 as a ceiling — both irrelevant because paginationPattern.type=null (server returns the whole catalog in one response regardless) |
| 9 | `userAgentOverride` | iPhone Safari UA string | (absent / undefined) | Candidate over-applied the WAF UA-override defensively; DB confirms plain axios default UA returns 200 — wafType=sucuri-passive needs no override |
| 10 | `searchUrl` | (absent) | `/product.php?product_name={keyword}` | Candidate missed searchUrl despite homepage having a `<input name="product_name">` advanced-search form — B4 deterministic searchUrl probe was not executed |
| 11 | `sortParam` | `""` (empty string, path-baked) | `null` | DB encodes "no sort URL form exists at all" as null; candidate encoded "natural DOM order acts as path-baked sort" as `""` — both convey roughly the same operational truth (no sort to apply at URL level) but DB convention is null when there's no URL form at all |
| 12 | `sortVerified` | `true` | (absent in DB) | Candidate accepted persona Mistake 18's 2026-04-07 cross-reference verification as still valid (which it likely is); DB doesn't carry this field as a runtime flag |
| 13 | `paginationPattern` | object with `type:null` and other fields filled | `null` (entire field null) | Same operational meaning; candidate emits the full object shell; DB short-circuits to top-level null |
| 14 | `wafWorkaround` | `null` | `{method:"none-required", notes:"..."}` | Candidate cleared the workaround block to null per Rule B10 ("explicitly null to signal clear"); DB documents the not-needed status in object form — operationally equivalent |
| 15 | `crawlers.maintain.verifyMethod` | `detail-page` | `detail-page` | Match |
| 16 | `crawlers.maintain.verifyEndpoint` | `null` | (absent) | Candidate emits explicit null; DB omits the field — operationally equivalent |
| 17 | `crawlers.maintain.method` | (absent) | `db-verification` | DB has additional `method: db-verification` alongside `verifyMethod: detail-page` — candidate did not emit this DB-internal designator |
| 18 | `crawlers.bootstrap` | (absent — skill spec says zero runtime consumers) | `{method:"single-continuous", htmlFallback:true, apiEndpoints:null}` | Candidate omitted per current skill guidance ("Output target — crawlers.bootstrap.apiEndpoints REMOVED"); DB retains the operator-doc block |
| 19 | `crawlers.watermark.method` | `navigate-from-watermark` | `navigate-from-watermark` | Match |
| 20 | `crawlers.watermark.reason` | populated long-form reason | (absent) | Candidate emits the reason field; DB omits — skill spec says reason is REQUIRED only for `full-catalog-sweep` |
| 21 | DB-only fields candidate did not produce | n/a | `name`, `notes` (long-form), `budget`, `timeout`, `t1IntervalMin`, `siteCategory`, `dataFlow`, `hasRateLimit`, `tierShares`, `cooldowns`, `tierWindows` | These are DB MonitoredSite columns + operator audit-trail residue NOT in the skill's runtime-field output (per Rule B) |

## Divergence count

**21 divergences** total (counting field-by-field across runtime-relevant + skill-emitted fields). Of these:
- **3 substantive operational** (hasWaf+wafType flip per B10, catalogUrls strategy, productCountMethod canonical name)
- **2 missed by candidate** (searchUrl, userAgentOverride over-application)
- **1 inventory drift** (expectedProductCount: live 104 vs DB-stale 84)
- **~15 cosmetic / shape / convention** (object vs null, absolute vs path, fields-DB-only-per-Rule-B)

## Blockers

None — site fully accessible from this audit IP. Sucuri passive (header-only); no captcha; no age-gate; plain axios works.

## Top 3 WHYs (substantive divergences)

1. **catalogUrls = 1 bare aggregator vs 11 per-dept URLs.** Skill Rule C says "smallest URL set" wins when coverage equals. Live walks confirm `/product.php` (bare) covers 104/104 while the 11 narrow-dept union covers 99/104 (5 dept-less products: ATF permit, colt parts, sirt training mag, crossbow). The bare URL is strictly larger coverage AND smaller count → wins by Rule C. DB's per-dept layout misses the 5 dept-less products. R1 verdict: candidate is correct per skill Rule C; DB needs update.
2. **`wafType: sucuri` vs `sucuri-passive`.** Rule B10 says set `hasWaf: true` ONLY when WAF actively blocks the crawl path. Probe evidence: all 8 batches' normal GETs return 200; only SQLi/XSS/honeypot requests hit 403 (rule-selective). Per Stage 2 table: "rule-selective" + no challenge on `/` should classify as informational (`hasWaf: false, wafType: 'sucuri-passive'`) — candidate failed to apply the rule. DB's `sucuri-passive` is more accurate. R1 verdict: candidate over-applied hasWaf=true; DB is right.
3. **`productCountMethod.method`: candidate's `html-pagination` vs DB's `sum-showing-result-markers`.** Neither is fully correct. The 11 canonical methods are listed in `product-count-probe.ts:148-451` — `sum-showing-result-markers` is NOT among them and silently disables the count probe. `html-pagination` IS canonical but expects `selector` to point to a last-page anchor and `perPage` to be the actual perPage multiplier; the candidate's `selector=".showing_result", perPage=1` is a hack to make `pages × perPage = 104`. The right fix is likely a new canonical method (e.g. `html-showing-result-text`) that reads inline "Showing N result" text from a single GET. Both candidate and DB ship broken-but-different shapes here. R1 verdict: both wrong; harness gap.
