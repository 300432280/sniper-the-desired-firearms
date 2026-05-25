# B4R3 Counter — g4cgunstore.com

Adversarial round 3 of R2's corrections. No DB writes. >=800ms inter-request spacing.

## Verdict tally (8 R2 fields)
- **COUNTER**: 1 (wafType / needsPlaywright / userAgentOverride cluster — see #1)
- **Couldn't disprove**: 6
- **Equivalent / cosmetic**: 1 (sortParam, paginationPattern.template — already conceded by R2)

## 1. wafType = `cloudflare-passive`, needsPlaywright = false, userAgentOverride = null — COUNTER

R2 evidence type: point-in-time multi-UA matrix, with footnote `rapidBurstTested:false`.

**Counter-test method**: hit `/shop/`, `/wp-json/wp/v2/product`, `/wp-json/wp/v2/product_cat`, `/product-category/firearms/`, `/feed/` sequentially with Chrome 120 UA (the deterministic pick — verified via `node -e` md5: `g4cgunstore.com` -> idx 0 -> Chrome 120). >=1s spacing throughout.

**Result** (`curl -sI`, Chrome 120 UA, 2026-05-19 ~00:14 UTC):

| URL | t=0s | t≈60s after pattern |
|---|---|---|
| `/shop/` | 200 | **403** |
| `/wp-json/wp/v2/product?per_page=1` | 200 | **403** |
| `/wp-json/wp/v2/product_cat?slug=firearms` | (R2 says 200) | **403** |
| `/product-category/firearms/` | 200 | **403** |
| `/feed/` | n/a | **403** |

Same moment, different UAs on `/wp-json/wp/v2/product?per_page=1`:

| UA | Status |
|---|---|
| Chrome 120 (UA1) | 403 |
| Safari 17 (UA2) | **200** |
| Firefox 121 (UA3) | **200** |
| Edge 120 (UA4) | 403 |

**Conclusion**: Cloudflare here is **not flatly passive for all real-browser UAs**. It runs a per-(IP, UA, recent-endpoint-pattern) escalation that throws 403 on Chromium-tagged UAs after a moderate number of WP-REST + `/shop/` requests; the escalation persists for tens of seconds and selectively blocks Chrome/Edge while leaving Safari/Firefox open.

**Runtime impact**:
- `pickUserAgent("g4cgunstore.com")` -> Chrome 120 (verified, `http-client.ts:9-21`, md5 idx 0).
- `resolveUserAgent` (`http-client.ts:34`) only deviates from `pickUserAgent` when `siteProfile.userAgentOverride` is set. R2 explicitly clears it.
- Catalog sweep walks 244 `/shop/page/N/` pages plus repeated `/wp-json/wp/v2/product?after=…` — exactly the pattern that escalated CF in my test.

**Recommended counter-correction**: set `userAgentOverride` to the Safari 17 string from `http-client.ts:11` (`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15`) — verified 200 on every endpoint while Chrome was locked out. `wafType:"cloudflare-passive"` survives only with that override. `needsPlaywright:false` survives only with that override.

R2's `wafProbeEvidence.rapidBurstTested:false` openly admits this gap; this counter fills it.

## 2. adapterType = `generic-retail` — couldn't disprove

Method (different from R2): grep `dataFlow` across `backend/src/`, `frontend/src/`, `backend/prisma/`.
- `backend/src`: 0 matches.
- `backend/prisma`: 0 matches.
- `frontend/src`: 5 matches, all in `frontend/src/app/dashboard/admin/profiles/page.tsx` — only as a JSON display passthrough (`'dataFlow'` listed alongside `'crawlers','apiConfig','notes'` in a `Record<string,any>` rendered as raw JSON in the admin UI). No routing semantics.

Read `adapter-registry-mismatch.ts:19-30`: warns only when `siteProfile.crawlers.catalog.method != adapterType`. **No code validates `platform` against `adapterType`** — WC-platform + generic-retail-adapter is silently accepted. R2 stands.

## 3. catalogUrls = 6 per-category siblings — couldn't disprove

Method: re-query product_cat for all 6 with `_fields=id,slug,parent,count` (via Safari UA, since Chrome was rate-limited at test time):
```
firearms          id=158   parent=0 count=2097
ammunition        id=171   parent=0 count=1928
accessories       id=40    parent=0 count=1232
sights-optics     id=165   parent=0 count=595
high-value-optics id=16854 parent=0 count=286
iron-sights       id=449   parent=0 count=35
```
All parent=0 (siblings) confirmed. Sum = **6173**; live x-wp-total = **5851**; excess 322 = dual-tagging (R2's documented overlap; cross-checked).

Runtime consumption verified: `generic-retail.ts:196-203` reads `profile.catalogUrls`; `woocommerce.ts:260-270` reads the same field via `_getSiteCacheEntry`. R2 stands.

## 4. expectedProductCount = 5851 — couldn't disprove

Live `/wp-json/wp/v2/product?per_page=1` header `x-wp-total: 5851` (Chrome 120 UA at t=0, before rate-limit kicked in). Stable across the same minute, matches R2 exactly.

Note: Store API would return <=5851 (in-stock only — per the codebase pitfall); irrelevant here because `crawlers.maintain.verifyMethod = wp-rest`, not store-api.

## 5. crawlers.maintain.verifyMethod = `wp-rest` — couldn't disprove (with caveat from #1)

WP REST returns 200 + x-wp-total when not rate-limited. But the same Cloudflare escalation in #1 will intermittently 403 the verify path too; the `userAgentOverride` fix from #1 protects this surface as well.

## 6. sortParam, paginationPattern.template

Equivalent — R2 already conceded the candidate's form is functionally identical to DB's. Not adversarial targets.

## Top 3 counters with evidence

1. **`wafType` passivity is UA-and-timing dependent, not flat.** Chrome 120 UA flipped from 200 -> 403 across every crawl-critical path (`/shop/`, `/wp-json/wp/v2/product`, `/product-category/firearms/`, `/feed/`) within ~60s of moderate probing on the audit IP. Safari and Firefox UAs stayed 200 in the same window; Edge 120 also got 403. With `pickUserAgent("g4cgunstore.com")` deterministically returning Chrome 120 and `userAgentOverride:null`, the runtime crawler will hit the same 403 wall in steady state.

2. **R2's `rapidBurstTested:false` admission is the load-bearing gap.** R2's UA matrix was a single moment; my test shows CF escalation kicks in after a sustained Chromium-UA pattern. A 244-page `/shop/page/N/` sweep matches that pattern exactly.

3. **`adapterType` vs `platform` mismatch is silently accepted.** `adapter-registry-mismatch.ts:19` warns only on `crawlers.catalog.method != adapterType`, not on `platform != adapterType`. R2's operator override is safe from runtime warnings — but no safety net if future operators flip one without the other. Worth flagging for R4 architecture review, though not a counter to R2's choice.

## Untested claims (left to R4)
- Whether the Safari-UA override stays 200 over a sustained 244-page sweep (only spot-checked under <30 requests total).
- Whether `?action=feed` or other WP-feed surfaces add fresh attack vectors — `/feed/` and `/?action=feed` tested only AFTER Chrome was already escalated, both 403; not tested in a fresh state.
- Whether the CF escalation is exactly Bot Fight Mode vs Managed Challenge vs a custom WAF rule — did not parse `cf-mitigated` / `cf-chl-*` headers in detail.
- Whether `_fields` would break a hypothetical `_embed` use — N/A, R2 doesn't combine them; pitfall not engaged here.
