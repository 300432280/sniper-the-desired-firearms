# hical.ca — B4 R1 Candidate vs DB Snapshot Diff

**Candidate:** `docs/site-audit/hical.ca-2026-05-19T20-00-00Z-B4R1.json`
**DB snapshot:** `_audit_tmp/batch4-2026-05-19/hical.ca-DB-snapshot.json` (DB lastVerified 2026-04-12; promoted profile is ~37 days old)
**Validator:** 16/16 PASSED, 0 FAILED.
**Blockers (this round):** none — validator clean, candidate is promotable shape.

---

## Side-by-side matrix

| # | Field | Candidate (R1) | DB | Same? | WHY (one-line hypothesis) |
|---|---|---|---|---|---|
| 1 | `platform` | `woocommerce` | `woocommerce` | yes | — |
| 2 | `adapterType` | `woocommerce` | `woocommerce` | yes | — |
| 3 | `hasWaf` | `true` | `true` | yes | — |
| 4 | `wafType` | `incapsula` | `imperva-incapsula` | DIFF (label) | DB uses vendor-pair tag; skill table canonical is `incapsula`. Operator label drift — neither runtime-consumed. |
| 5 | `wafLastProbedAt` | `2026-05-19T08:53:19Z` | `2026-04-12` | DIFF (time) | Re-probed in this run. DB is 37 days old. |
| 6 | `wafProbeMethod` | `heavy-8-batch` | `heavy-8-batch` | yes | — |
| 7 | `wafProbeResult` | one-line | `active-incapsula` | DIFF (free-text) | Cosmetic; structured evidence carries the data. |
| 8 | `wafProbeEvidence` | object | string | DIFF (shape) | DB has free-form string; skill rule says structured object. Older profile predates the convention. |
| 9 | `wafWorkaround` | omitted | `{method:"cookie-cache", wafVendor, cookieNames[4], challengeType, storeApiAvailable, wcRestV3Available, wpRestV2Available}` | DIFF (missed) | I omitted because skill only requires `wafWorkaround` for HTTP-header-parse failures (Celerant pattern). DB documents the Imperva cookie-cache strategy — operator metadata, not runtime. Add back. |
| 10 | `hasCaptcha` | `false` | `false` | yes | — |
| 11 | `captchaType` | `null` | (absent) | DIFF (presence) | DB omits when null; equivalent. |
| 12 | `ageGate` | `{detected:false,...}` | (absent) | DIFF (presence) | DB omits; equivalent. |
| 13 | `userAgentOverride` | `null` | `Mozilla/5.0 (iPhone; ...iPhone OS 17_0...)` | DIFF (value) | DB notes "iPhone UA required". I set null because desktop Chrome Playwright passed in my session. DB more conservative — Imperva fingerprinting may flag desktop at scale. R1 likely wrong. |
| 14 | `needsPlaywright` | `true` | `true` | yes | — |
| 15 | `expectedProductCount` | `1676` | `1677` | DIFF (-1) | DB 1677 vs my probe 1676. Inventory drift over 37 days OR DB used sitemap-union (1001+676=1677) while I used Store API X-WP-Total (1676). Within rounding. |
| 16 | `productCountMethod` | `{method:"wp-rest-header", endpoint:"/wp-json/wc/store/v1/products", header:"x-wp-total"}` | `"wp-rest-v2-x-wp-total"` (string) | DIFF (shape + endpoint) | DB stores bare string. Per skill Stage 8 anti-pattern: bare string falls through to `default: return null` in product-count-probe.ts — count probe DISABLED for hical.ca today. My object form is correct. DB also targets `/wp/v2/product`; I target `/wc/store/v1/products`. Both yield 1676. |
| 17 | `catalogUrls` length | 23 | 22 | DIFF (+1) | I added `all-products` (count=29, parent=0); DB excluded as "umbrella" per `overlapNotes`. DB walked + dedup-proved redundancy; I did not. R1 wrong without proof — should drop or walk-verify. |
| 18 | `catalogUrls` content | uses `firearms-canada` slug | DB uses `firearms` slug | DIFF (slug) | Live `wp/v2/product_cat` returns slug `firearms-canada` (id=143). DB `/firearms/` is a 404. Likely merchant renamed post-2026-04-12. Candidate correct; DB stale. |
| 19 | `extractionTested` | `true` | (absent) | DIFF (presence) | DB predates the field. |
| 20 | `sortParam` | `?orderby=date` | `?orderby=date` | yes | — |
| 21 | `sortVerified` | `true` | (absent boolean) | DIFF (presence) | DB has `sortVerification` block; same semantics. |
| 22 | `perPage` | `16` | `16` | yes | — |
| 23 | `paginationPattern.type` | `path` | `path` | yes | — |
| 24 | `paginationPattern.template` | `/page/{N}` | `/page/{N}/` | DIFF (trailing /) | DB has trailing slash; I don't. Cosmetic — runtime builder strips baseUrl trailing slash before concat. |
| 25 | `paginationPattern.firstPageHasParam/startPage/zeroIndexed/perPage` | populated | absent | DIFF (presence) | DB partial shape; skill requires full. |
| 26 | `crawlers.watermark.method` | `navigate-from-watermark` | `api-date-since-watermark` | DIFF (METHOD) | DB asserts filter works on `/wp/v2/product?modified_after=...`. I tested filter on Store API (`/wc/store/v1/products`) and saw it ignored. **I tested the wrong REST surface.** DB has monotonicity proof. Likely R1 wrong — re-probe `/wp/v2/product`. |
| 27 | `crawlers.watermark.api` | omitted | `wp-rest-v2` | DIFF (missed) | Operator-doc field naming WHICH REST surface watermark walks. |
| 28 | `crawlers.watermark.orderBy` | omitted | `modified` | DIFF (missed) | Operator doc. |
| 29 | `crawlers.watermark.dateFilterField` | omitted | `modified_after` | DIFF (missed) | Operator doc. |
| 30 | `crawlers.watermark.notes` | reason text | rich notes | DIFF (style) | DB notes carry window counts (7d=22, 21d=49). |
| 31 | `crawlers.maintain.verifyMethod` | `store-api` | (absent — no maintain block) | DIFF (presence) | DB predates explicit maintain config. Runtime defaults to detail-page when missing. R1 adds correctly. |
| 32 | `crawlers.catalog` block | omitted | `{api:"wp-rest-v2", method:"api-date-range", notes:"T2=7d, T3=8-21d, T4=22+d via modified_after/modified_before"}` | DIFF (missed) | DB documents catalog-phase tier strategy. Not in skill spec but DB-pattern says useful. |
| 33 | `topLevelCategories` | rich block w/ 23 entries | (replaced by `catalogUrlStats` 22 entries) | DIFF (style) | DB uses `catalogUrlStats` recording walk results (count + pages + perPage). R1 uses skill-spec `topLevelCategories`. |
| 34 | `overlapNotes` | omitted | 4 keys explaining each inclusion/exclusion | DIFF (missed) | Operator audit-trail — granular justification for each catalog URL decision. Equivalent to my `totalsSumCheck` prose but per-cat. |
| 35 | `parentInclusivity` | omitted | 3 keys marked "INCLUSIVE" | DIFF (missed) | Operator audit-trail documenting parents render child products (avoids Astra break-on-zero). I verified during 4c but didn't record structurally. |
| 36 | `paginationVerification` | omitted | 3 categories with maxPage/p1/p2/pLast/total | DIFF (missed) | Operator audit-trail. My `auditNotes.paginationEvidence` covers it conceptually. |
| 37 | `dateFilterMonotonicity` | omitted | `{verified:true, evidence:"page1 last id=58057 > page2 first id=58055"}` | DIFF (missed) | DB proves api-date-since-watermark monotonicity I missed. Critical evidence. |
| 38 | `productCountDate` | omitted | `2026-04-12` | DIFF (missed) | DB records when count was taken. |
| 39 | `lastVerified` | `2026-05-19` | `2026-04-12` | DIFF (time) | Fresh probe. |
| 40 | `auditNotes.*` | rich block | (replaced by inline metadata) | DIFF (style) | R1 stuffs operator metadata in auditNotes; DB scatters inline. Both valid. |

---

## Divergence count

**40 fields/keys compared. Divergent: ~22 (12 cosmetic/presence + 10 substantive).**

Substantive divergences (need R2 attention):
1. `userAgentOverride` — R1 null vs DB iPhone-Safari (align with DB; more conservative).
2. `crawlers.watermark.method` — R1 `navigate-from-watermark` vs DB `api-date-since-watermark` via WP REST core (not Store API). R1 tested wrong surface.
3. `productCountMethod` shape — R1 object (correct per Stage 8); DB bare string (currently broken at runtime).
4. `catalogUrls` slug — DB `/firearms/` is 404; R1 `/firearms-canada/` is live. DB stale.
5. `catalogUrls` length — R1 +1 (`all-products`); DB `overlapNotes` prove redundant.
6. `wafWorkaround` — R1 omitted; DB documents cookie-cache. Add back.
7. `crawlers.catalog` tier block — R1 omitted; DB documents T2/T3/T4 date ranges.
8. `wafProbeEvidence` shape — R1 object; DB string. Cosmetic.
9. `wafType` label — `incapsula` vs `imperva-incapsula`. Cosmetic.
10. `paginationPattern.template` — `/page/{N}` vs `/page/{N}/` trailing slash. Cosmetic.

---

## Top 3 surprising divergences (with WHY)

1. **`crawlers.watermark.method`: R1 `navigate-from-watermark` vs DB `api-date-since-watermark`.** WHY: my Stage 7 probe tested `wc/store/v1/products?modified_after=...` and saw the filter ignored (both 2099 and 1999 dates returned global count 1676). DB documents the filter WORKS but on a different surface — `wp/v2/product?modified_after=...` (admin WP REST core, not customer Store API). The skill table for Method A only mentions Store API; DB used WP REST core. **R1 missed the working surface by not probing both REST surfaces.** DB monotonicity proof (`page1 last id=58057 > page2 first id=58055`) shows the filter DOES yield sorted results on `/wp/v2/product`.

2. **`catalogUrls` contains a DEAD slug in DB: `/product-category/firearms/`.** WHY: live `wp-json/wp/v2/product_cat` returns the slug as `firearms-canada` (id=143, count=226). DB has `/firearms/`. Either merchant renamed the slug post-2026-04-12 (regulatory rebrand "firearms" -> "firearms-canada" common in Canadian sites) or DB was created from a stale rendition. Either way DB has a 404 URL in production today — undiscovered failure mode (catalog-crawler.ts break-on-zero would mark it exhausted at page 1 and skip).

3. **`productCountMethod` is a BARE STRING in DB.** WHY: DB has `"wp-rest-v2-x-wp-total"` (string), but runtime `product-count-probe.ts:148-451` switch only matches structured objects with `.method` key. Per the skill's mandatory validator gate ("Any other string lands on default: return null — count probe disabled silently"), the production count probe for hical.ca currently returns null and the operator has no automated count-drift signal. R1's structured object is the fix. **This is a real, fixable production bug latent in the DB.**

---

## Notes for R2

- Re-probe `/wp-json/wp/v2/product?modified_after=2099-01-01&per_page=1` (NOT Store API) to confirm filter on admin WP REST. If yes, switch watermark method to `api-date-since-watermark`.
- Drop `/product-category/all-products/` from `catalogUrls` and document redundancy per DB pattern. Or walk it to confirm (Rule C: drop only when proved redundant).
- Add `userAgentOverride: "Mozilla/5.0 (iPhone; ...)"` per DB precedent (defensive against Imperva fingerprinting at scale).
- Add `wafWorkaround.method: "cookie-cache"` block following DB pattern (operator metadata; consumed by triage UI).
- Add `crawlers.catalog` tier-strategy block from DB pattern if runtime consumes it (grep first).
