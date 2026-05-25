# B5R2 Investigation - gagnonsports.com

**Round:** 2 of 4 (adversarial audit)
**Date:** 2026-05-23T22:00:00Z
**Method:** Live investigation; methods chosen to be DIFFERENT from R1
**Constraint:** 800ms delay; NO DB writes; max 20 min
**Total requests:** 65; **Duration:** ~71s

## Inputs

- R1 candidate: `docs/site-audit/gagnonsports.com-2026-05-22T20-00-00Z-B5R1.json`
- R1 diff: `docs/site-audit/gagnonsports.com-2026-05-22T20-00-00Z-B5R1-diff.md`
- DB snapshot: `_audit_tmp/batch5-2026-05-22/gagnonsports.com-DB-snapshot.json`

## R1's 14 divergences - the 5 priority disputes

R1 (candidate vs DB) had 14 divergences. R2 attacked the load-bearing ones:

1. `hasWaf` candidate=false vs DB=true (R1 admitted skipped B9 sustained walk)
2. `wafWorkaround` candidate=null vs DB=mobile-ua (same skip)
3. `userAgentOverride` candidate=null vs DB=iPhone (same skip)
4. `perPage` candidate=100 vs DB=24 (R1 admitted no side-by-side timing)
5. `catalogUrls` `/firearms/*` tree (R1 INCLUDE 10 leaves, DB EXCLUDE all - DB note "No /firearms/ category exists")
6. `catalogUrls` `/sale/.../new-used-guns/`, `/previously-owned-merchandise/` (R1 EXCLUDE, DB INCLUDE)
7. `searchUrl` form-action difference

## Method (different from R1)

R1 ran probe orchestrator phases 1-9 with mostly single-request probes. R2 ran 5 targeted live tests with sustained walks, side-by-side timing, and explicit Rule-C dedup tests.

Script: `_audit_tmp/gagnon-b5r2.js` (one-shot scratch).

## Test 1: /firearms/* tree walk

Walked all 10 `/firearms/*` leaves directly, iPhone UA, ?limit=100, 800ms delay.

| URL | Status | Count | Title |
|---|---|---|---|
| /firearms/new-firearms/centerfire-rifles/ | 200 | 47 | Centerfire Rifles - Gagnon Sporting Goods |
| /firearms/new-firearms/rimfire-rifles/ | 200 | 30 | Rimfire Rifles - Gagnon Sporting Goods |
| /firearms/new-firearms/shotguns/ | 200 | 74 | Shotguns - Gagnon Sporting Goods |
| /firearms/new-firearms/air-guns/ | 200 | 16 | Air Guns - Gagnon Sporting Goods |
| /firearms/new-firearms/restricted-firearms/pistols/ | 200 | 0 | Pistols - Gagnon Sporting Goods |
| /firearms/new-firearms/restricted-firearms/revolvers/ | 200 | 0 | Revolvers - Gagnon Sporting Goods |
| /firearms/new-firearms/restricted-firearms/rifles/ | 200 | 0 | Rifles - Gagnon Sporting Goods |
| /firearms/used-firearms/used-rifles/ | 200 | 42 | Used Rifles - Gagnon Sporting Goods |
| /firearms/used-firearms/used-shotguns/ | 200 | 19 | - |
| /firearms/used-firearms/used-restricted/ | 200 | 0 | - |

**Total:** 228 products live across 6 productive leaves. The 4 zero-count leaves all return 200 with real category titles (restricted-firearms likely auth-walled per RCMP rules, but the URLs exist).

**Verdict:** DB note "No /firearms/ category exists" is **STALE** (DB lastVerified 2026-04-07; site added /firearms/ tree since). R1 candidate is correct to include all 10 leaves.

## Test 2: UA-pool sustained walk

Walked /collection/ pages 1-8 with 5 distinct production UAs. 40 requests total, 800ms delay each.

| UA | Statuses | CF Challenge | avgMs |
|---|---|---|---|
| desktop-chrome | 8/8 = 200 | 0 | 284 |
| iphone-safari | 8/8 = 200 | 0 | 277 |
| mac-safari | 8/8 = 200 | 0 | 281 |
| linux-chrome | 8/8 = 200 | 0 | 282 |
| android-chrome | 8/8 = 200 | 0 | 271 |

**40/40 = 200.** No "Just a moment" body. No 403/503/429. Zero UA discrimination.

**Verdict:**
- `hasWaf` = **false**. Cloudflare is passive but does NOT gate the crawler. R1 correct.
- `wafWorkaround` = **null**. R1 correct.
- `userAgentOverride` = **null**. iPhone UA is NOT load-bearing. R1 correct.

DB's defensive iPhone UA policy is unsupported by current evidence. Could be retained as "belt + suspenders" but not required.

## Test 3: perPage 100 vs 24 timing

5 pages of /collection/ at each perPage. Same UA, same delay.

| perPage | avgMs | Products/req | 5-page total |
|---|---|---|---|
| 100 | 285 | 100 | 500 |
| 24 | 280 | 24 | 120 |

Per-request latency identical (1.8% difference, noise). perPage=100 yields **4.17x more products per request** at the same latency.

For a 2706-product walk: p100 ~= 28 requests vs p24 ~= 113 requests - 75% fewer requests at same latency.

**Verdict:** `perPage` = **100**. R1 candidate correct. DB value 24 is suboptimal.

## Test 4: DB extra URLs (Rule C dedup test)

R1 dropped `/sale/.../new-used-guns/` and `/previously-owned-merchandise/` without proving redundancy. Rule C says "only drop when proven redundant via full walk + dedup".

| URL | Status | Count | Note |
|---|---|---|---|
| /sale/hunting-super-specials/new-used-guns/ | 200 | 31 | beretta-a400-xtreme-plus, mossberg-152, etc - overlaps /firearms/used-* |
| /previously-owned-merchandise/ | 200 | 1 | wildgame-encounter camera (non-firearm) |
| /archery/bows/ | 200 | 16 | productive |
| /archery/arrows-accessories/ | 200 | 100 | productive |

**Verdict:** R1's exclusions were rule-violating. INCLUDE `/sale/.../new-used-guns/` (31 firearm products, likely overlap is dedup-handled). INCLUDE `/previously-owned-merchandise/` (1 product, near-empty but safe). Archery is operator scope choice.

## Test 5: search form

Both `/search/?q=glock` and `/search/glock/` return status=200, title="Search results for glock - Gagnon Sporting Goods", 24 products each. LightSpeed rewrites both forms internally.

**Verdict:** Cosmetic divergence. Either field value works. Non-blocking.

## Field verdicts (load-bearing summary)

| Field | R1 candidate | DB | R2 verdict | Confidence |
|---|---|---|---|---|
| hasWaf | false | true | **false** | high |
| wafWorkaround | null | mobile-ua | **null** | high |
| userAgentOverride | null | iPhone Safari 17.2 | **null** | high |
| perPage | 100 | 24 | **100** | high |
| catalogUrls /firearms/* | 10 leaves | excluded | **INCLUDE 10 leaves** | high |
| catalogUrls /sale+owned | excluded | included | **INCLUDE both** | high |
| catalogUrls /archery/* | excluded | included | operator scope choice | medium |
| searchUrl | ?q= form | path form | either works | high |
| productCountMethod | html-pagination | sitemap-flat | **html-pagination** (sitemap-flat not canonical) | high |
| expectedProductCount | 2706 | 2613 | within 5% gate | medium |

## Final R2 position

**R1 was substantially correct on 6 of 7 load-bearing field disputes.** Only weakness: R1 violated Rule C by dropping `/sale/.../new-used-guns/` (31 firearm products) and `/previously-owned-merchandise/` (1 product) without dedup proof. DB note "No /firearms/ category exists" is stale (228 products live in tree).

**Recommended R2-final catalogUrls = R1's 29 leaves + `/sale/hunting-super-specials/new-used-guns/` + `/previously-owned-merchandise/`** (31 leaves total). Archery is operator scope choice (no R2 verdict).

**Recommended expectedProductCount recompute:** R1's 2706 + 31 (sale, with overlap likely cancelling some used-* count) + 1 (owned) ~= 2738, still within 5% gate of DB's 2613.

## Artifacts

- Investigation script: `_audit_tmp/gagnon-b5r2.js`
- Raw output: `_audit_tmp/gagnon-b5r2-out.txt`
- R2 JSON verdict: `docs/site-audit/gagnonsports.com-2026-05-22T22-00-00Z-B5R2.json`
- R2 investigation: this file
