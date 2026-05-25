# B5R3 Adversarial Counter — jobrookoutdoors.com

Run: 2026-05-23T00:00:00Z. 800ms delay (except explicit burst). Live probes only.

## 1. perPage=100 — UPHELD (broadened 5×)

`?sort=newest&limit=100` against 5 distinct leaves (all 200 OK, cf-ray present, cf-cache-status=DYNAMIC):
- `/hunt/firearms/shotguns/` → 29 ids
- `/hunt/optics/riflescopes/` → 40 ids
- `/hunt/firearm-accessories/mags/` → 31 ids
- `/archery/bows/` → 100 ids, `rel="next"` present (caps at limit, more exist)
- `/hunt/gun-parts/triggers/` → 1 id

`limit=100` honored on every leaf. The `archery/bows` case proves the cap is the literal limit value, not a coincidence of total=actual. R2 verdict stands.

## 2. catalogUrls — UPHELD (5 spot-checks all live)

5 DB leaves not previously tested all returned 200 + valid `<title>` matching the slug, no 404 markup:
- `/hunt/firearms/pal-courses/` (0 products — service/course category, expected)
- `/hunt/optics/red-dot/` (4)
- `/hunt/firearm-accessories/muzzleloading-gear-1682249/` (2)
- `/hunt/range-accessories/eyes-ears/` (5)
- `/archery/broadhead-specialty-pts/` (12)

No renamed/dead slugs. R2 verdict stands.

## 3. hasWaf=true — UPHELD (50-burst × 5 UAs)

50 GETs at 50ms across {Chrome-Win, Safari-Mac, FF-Linux, iOS-Mobile, curl/8.4} = 50/50 status 200, max latency 306ms, zero challenges. No UA-selective behavior. WAF passive even under aggressive multi-UA load. `hasWaf=true` is defensive-correct (enables cookie-cache path); not functionally tripped at this volume.

## 4. verifyMethod — R2 REVISED (DB literally wrong, but functionally moot)

`backend/src/services/worker.ts:397` — `verifyMethod !== 'store-api' → return null` (Store-API gate).
`backend/src/services/worker.ts:769-775` — ANY non-null `verifyMethod` (including stale `json-ld`) falls into the SAME Playwright detail-page path.

Detail probe of `/30-30-win-20-1854-bbl-sst-syn.html`: 0 `<script type="application/ld+json">` blocks, 1 `itemprop="availability"` microdata occurrence — confirms R2.

Conclusion:
- R2 correct that DB `json-ld` is empirically false (no JSON-LD on detail pages).
- Runtime doesn't branch on the literal string; only `store-api` vs not-`store-api` matters at L397/L769. `detail-page` and `json-ld` are functionally identical at L775.
- Operator should rename to `detail-page` for accuracy; no crawler bug from current value.

## Verdict
R2 upheld on all 4 priority items. R3 finds no disproof.
