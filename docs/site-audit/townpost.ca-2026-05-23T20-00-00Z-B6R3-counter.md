# townpost.ca R3 ADVERSARIAL COUNTER

**Run:** townpost.ca-2026-05-23T20-00-00Z-B6R3
**Persona:** engineering-code-reviewer (break-mindset)
**Method:** Broaden R2's 5-page sample to 10; 3-timestamp wrap test; 6-keyword B3 junk-diff; runtime code grep.

## Verdict: R2 CONFIRMED on all 4 attacked fronts.

### 1. perPage=21 / pinnedAds=0 — CONFIRMED (sample broadened 5→10 pages)
10-page walk: every page = 21 unique IDs. **10-way intersection = 0 IDs** (no ID present in 8+ pages → no true pinned ads). "Top Ad" / `featured_expires_at` markers appear **only on p1** (1 occurrence each), counted within its 21. Highest cross-page frequency: ID `1033232` appears on 2 pages only (likely re-bumped, not pinned). DB's `pinnedAds:4` is dead wrong.

### 2. lastPage=424 — CONFIRMED across 3 distant timestamps (not a cache artifact)
- `?page=425`, `?page=500`, `?page=1000` all return 21 IDs with `max=1171326`, all sharing **21/21 IDs with fresh p1**.
- Repeat fetch of `?page=425` 5s later: **21/21 IDs unchanged** (and matches the first p425 fetch). HTML byte sizes differ trivially (319119 / 319133 / 319134) due to per-request token/timestamp values embedded in HTML, NOT due to differing product sets. Wrap-to-p1 is deterministic site behavior, not CDN caching.

### 3. searchUrl `/search?q={keyword}` — CONFIRMED (6-variant junk-diff)
| Keyword | Marketplace IDs | Bytes |
|---|---|---|
| glock, ammo, rifle | 21 each | 394k-428k |
| xyz789nonsense, zzzzzzz, asdfqwerzxcv | 0 each | ~135k |

Clean signal/no-signal split. DB-wins.

### 4. adapterType=generic runtime gap — R2's BLOCKER CONFIRMED, classification adjusted
Grep of `generic.ts:91-130` ALL_SELECTORS against `p1.html`:
- `'listing'` → 2 hits, `'classified'` → 2 hits, `'ad-card'` → 1 hit, `'auction'` → 1 hit. These are likely page-chrome (nav/footer/SEO copy), NOT product cards.
- `'item_card'` / `'newest-ads'` (R1's TownPost stale-class hints): **0 hits**.
- `a[href*="/marketplace/"]` (selector present only in `generic-retail.ts:964`): **62 anchors** on p1.

R2 is correct that `generic.ts` cannot extract townpost listings. Fix path: add the selector to `generic.ts`, OR change `adapterType` to `generic-retail`. R3 prefers **adding the selector to `generic.ts`** — `generic-retail` carries retail-specific assumptions (SIDEBAR_BLACKLIST for Magento, etc.) that don't apply to a Next.js classifieds SPA.

## Open R3 carry-forward
- `classifiedRules.soldDetection` still NOT verified (no known-sold listing URL fetched). R4 should drop the field or mark `confidence:low`.

## Conclusion
**Zero R2 reversals.** R2's investigation holds under broader sampling, multi-timestamp probing, and 6-keyword B3 diff. Profile JSON ready for B6 validation.

Evidence: `d:/Projects/FIREARM-ALERT/_audit_tmp/batch6-2026-05-23/townpost-r3/{p1..p10,late-425-t1,late-425-t2,late-500-t1,late-1000-t1,p1-fresh,search-*}.html` + `ids-*.txt`.
