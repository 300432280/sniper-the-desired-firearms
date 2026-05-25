# doctordeals.ca — Batch-4 Validation (single round)

Timestamp: 2026-05-19T23-00-00Z
Method: live HTTP via `backend/scripts/probe/shared/fetch.ts` (axios -> Playwright on sgcaptcha) + iPhone UA + warmup `/`. Code reads on `backend/src/services/worker.ts`.

## Verdicts

### Fix 1 — catalogUrls without `gun-shop/` prefix: PASS
All 6 new-spine URLs returned HTTP 200 via Playwright (sgcaptcha PoW solved):

| URL | status | cards | canonical |
|---|---|---|---|
| `/product-category/firearms/` | 200 | 12 | self |
| `/product-category/parts/` | 200 | 12 | self |
| `/product-category/accessories/` | 200 | 12 | self |
| `/product-category/mags-barrels/` | 200 | 12 | self |
| `/product-category/clothing-gun-related/` | 200 | 12 | self |
| `/product-category/defense/` | 200 | 1 | self |

`defense` card count = 1 matches DB siteProfile.notes ("defense (1)").

Adversarial — legacy prefix `/product-category/gun-shop/firearms/` returns 200 with 12 cards but `<link rel="canonical">` points to `/product-category/firearms/`. WP confirms `gun-shop` is a permalink-rewrite alias only; R3's verdict that 0/54 product_cat terms contain it is consistent with live canonical evidence. New non-prefixed form is the WP-canonical one.

### Fix 2 — verifyMethod 'detail-page' runtime-equivalent to 'json-ld': PASS
`backend/src/services/worker.ts:397` is a literal `!== 'store-api'` check (`if (!maintainConfig || maintainConfig.verifyMethod !== 'store-api') return null;`). Any non-`'store-api'` value (json-ld, detail-page, anything else) early-returns from the Store-API fast path. Caller at `worker.ts:765-781` else-branch then routes ALL non-store-api methods through `verifyProductsViaPlaywright`. Behaviorally identical. Per CLAUDE.md the canonical term is `detail-page`; switch is a naming correction, zero behavior change.

### Fix 3 — perPage = 12: PASS
Boundary math verified live:
- `/product-category/firearms/page/9/` -> 200 with 11 product cards
- `/product-category/firearms/page/10/` -> 200 with 0 cards + 404 marker in title
- 8 full pages × 12 + 11 = 107 = firearms.count. Matches.

### Fix 4 — searchUrl = `/?s={keyword}&post_type=product`: PASS
Live `/?s=ruger&post_type=product` -> 200, 12 product cards. Matches R3 evidence.

## Verdict: ALL 4 FIXES PASS. Ship.
