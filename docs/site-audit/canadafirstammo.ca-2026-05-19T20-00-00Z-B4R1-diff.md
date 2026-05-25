# B4R1 Diff — canadafirstammo.ca

Candidate: `docs/site-audit/canadafirstammo.ca-2026-05-19T20-00-00Z-B4R1.json`
DB snapshot: `_audit_tmp/batch4-2026-05-19/canadafirstammo.ca-DB-snapshot.json` (lastVerified 2026-04-11)

## Field-by-field comparison

| # | Field | Candidate (R1) | DB | Match? | WHY hypothesis |
|---|---|---|---|---|---|
| 1 | `platform` | `woocommerce` | `woocommerce` | YES | - |
| 2 | `adapterType` (candidate) vs `adapter` (DB) | `woocommerce` | `woocommerce` | YES | DB stores adapter under both `adapter` and column `adapterType`. Same value. |
| 3 | `hasWaf` JSON | `false` | `true` | NO | Operational-vs-literal tension. Per Stage 2 rule: cf-ray + all-200 = cloudflare-passive -> `hasWaf: false`. DB chose conservative `true`. DB `notes` field even says "Cloudflare passive (not Sucuri). API works without cookies." |
| 4 | column `hasWaf` (DB column) | n/a in candidate | `true` | NO | Same root cause as #3. Column drives `crawl-scheduler.ts` budget/UA selection. Skill spec says false; DB more conservative. |
| 5 | `wafType` | `cloudflare-passive` | `cloudflare-passive` | YES | - |
| 6 | `hasCaptcha` | `false` | `false` | YES | - |
| 7 | `captchaType` | `null` | absent | partial | DB omits the field; runtime still works. Skill emits explicitly. |
| 8 | `ageGate` | `{detected:false,...}` | absent | partial | Skill emits field explicitly. |
| 9 | `needsPlaywright` | `false` | `false` | YES | - |
| 10 | `expectedProductCount` | `962` | `962` | YES | - |
| 11 | `productCountMethod` | `{method:"wp-rest-header", endpoint:"/wp-json/wp/v2/product", header:"x-wp-total"}` | same + extra `storeApiNote`/`storeApiTotal` | YES (core) | DB adds operator notes. Same canonical method. |
| 12 | `catalogUrls` count | 11 | 10 | NO | Candidate includes `gunsmithing` (count=0 today). DB excludes it. Per Stage 4 rule "empty != dead"; DB applied "skip empty" heuristic. |
| 13 | `catalogUrls` order | firearms first, shop-all 10th, gunsmithing 11th | shop-all first, clearance second | minor | Cosmetic - order doesn't affect crawler. |
| 14 | `catalogUrls` absolute vs path | absolute (`https://...`) | path-only (`/product-category/...`) | NO | Both work for runtime. DB chose path-only (smaller payload); candidate chose absolute (no resolution ambiguity). |
| 15 | `extractionTested` | `true` | absent | partial | DB omits the audit-trail field. Skill emits per Output target spec. |
| 16 | `sortParam` | `?orderby=date` | `?orderby=date` | YES | - |
| 17 | `sortVerified` | `true` (boolean) | object `{method, results, verifiedAt}` | NO (shape) | DB stores audit-trail residue (Rule B) under sortVerified-as-object. Candidate uses boolean per validator shape. |
| 18 | `perPage` | `12` | `12` | YES | - |
| 19 | `paginationPattern.type` | `path` | `path` | YES | - |
| 20 | `paginationPattern.template` | `/page/{N}/` | `/page/{N}/` | YES | - |
| 21 | `paginationPattern.perPage` | `12` | absent | partial | DB omits nested; relies on top-level. |
| 22 | `paginationPattern.startPage` | `1` | absent | partial | DB omits; runtime defaults to 1. |
| 23 | `paginationPattern.zeroIndexed` | `false` | absent | partial | DB omits; runtime defaults to false. |
| 24 | `paginationPattern.firstPageHasParam` | `false` | `false` | YES | - |
| 25 | `paginationPattern.verified` | absent | `"2026-04-11"` | partial | DB audit-trail timestamp; candidate omits per Rule B. |
| 26 | `paginationVerified` (top-level) | absent | object | partial | Audit-trail residue per Rule B. Skill correctly omits. |
| 27 | `crawlers.watermark.method` | `api-date-since-watermark` | `api-date-since-watermark` | YES | - |
| 28 | `crawlers.maintain.verifyMethod` | `store-api` | `store-api` | YES | - |
| 29 | `crawlers.maintain.verifyEndpoint` | `/wp-json/wc/store/v1/products` | `/wp-json/wc/store/v1/products` | YES | - |
| 30 | `crawlers.maintain.method` | absent | `"db-verification"` | partial | DB stores operator-tier-cooldown config not part of skill output. |
| 31 | `crawlers.bootstrap` | not emitted | full block | partial | Per skill's note: `crawlers.bootstrap.apiEndpoints` removed - zero runtime consumers. Skill omits intentionally. |
| 32 | `searchUrl` | absent | `/?s={keyword}&post_type=product` | NO | Skill defines `searchUrl` as OPTIONAL. I did NOT discover/emit it. DB has canonical WP search URL. Skill should have emitted it. |
| 33 | `topLevelCategories` | full block w/ 11 entries | absent | partial | DB omits; skill emits per Output target recommendation. |
| 34 | `wafWorkaround` | absent | `{notes, method:"none", storeApiAvailable:true}` | partial | Skill spec says populate ONLY for malformed headers - N/A here. |
| 35 | `dataFlow` | absent | 2-step block | partial | DB operator documentation, not in skill output. |
| 36 | `t1IntervalMin` | absent | `17` | partial | Operator-tuned crawl interval; not in skill scope. |
| 37 | `budget` | absent | `60` | partial | Operator token-budget; not in skill scope. |
| 38 | `timeout` | absent | `30000` | partial | Runtime knob set by operator. |
| 39 | `crawlPhase` | absent | `maintain` | partial | DB state field - site graduated past bootstrap. Skill doesn't manage. |
| 40 | `siteCategory` / `siteType` | absent | `retailer` | partial | Domain taxonomy; column-level. |
| 41 | `name` | absent | `Canada First Ammo` | partial | Display name; skill doesn't capture. |
| 42 | `lastVerified` | `2026-05-19` | `2026-04-11` | NO | DB is 38 days stale. Skill refreshes. |

## Summary

- **Divergence count (substantive - values disagree where both fields exist):** **6** (#3/#4 hasWaf, #12 catalogUrls count, #14 catalogUrls form, #17 sortVerified shape, #32 missing searchUrl, #42 lastVerified)
- **Divergence count (shape-only / residue / partial):** ~20 (DB carries operator residue + tier cooldowns + display fields + audit timestamps that skill omits per Rule B)
- **Blockers:** none - the candidate is a viable replacement for the runtime fields.

## Top 3 surprising divergences with WHY

1. **`hasWaf` (candidate=false, DB=true)** - operational-vs-literal tension. Stage 2 explicitly says cloudflare-passive should be `false` (setting true forces perPage=20 and routes through the WAF cookie manager for no benefit). DB chose `true` defensively despite its own notes saying "Cloudflare passive (not Sucuri). API works without cookies." Likely a pre-Stage-2-rewrite policy ("any CDN = WAF on") the skill spec later overrode.

2. **`catalogUrls` excludes `gunsmithing`** - skill Stage 4 says "empty (200 + 0 products) != dead (404); keep it" (Mistake 12). DB applied "skip empty top-level" - defensible because daily walking a 0-product URL is cost without benefit, but loses the "products tomorrow" property. Spec says keep; DB chose pragmatism.

3. **`sortVerified` shape (candidate=boolean, DB=object with results)** - shape regression in the DB profile. Validator-canonical shape is boolean. DB stores a rich evidence object under the same key - that's audit-trail residue per Rule B that should live in `auditNotes`. A consumer reading `siteProfile.sortVerified` for runtime branching gets a truthy object regardless of actual verification status.

## Output

- Candidate path: `D:\Projects\FIREARM-ALERT\docs\site-audit\canadafirstammo.ca-2026-05-19T20-00-00Z-B4R1.json`
- Diff path: `D:\Projects\FIREARM-ALERT\docs\site-audit\canadafirstammo.ca-2026-05-19T20-00-00Z-B4R1-diff.md`
- Substantive divergence count: **6**
- Shape-only / partial: ~20
- Blockers: none
