# R3 Counter — alsimmonsgunshop.com

- Audited: 2026-05-13T09:07:20Z
- Auditor: engineering-code-reviewer (fresh skeptic)
- R2 reference: `docs/site-audit/alsimmonsgunshop.com-2026-05-13T08-50-37Z-R2-corrections.json`
- Mission: try to disprove R2's 17/17 confirm-R1 result.

## Required verdicts

### 1. `dual-api` deep-grep verdict — R2 SURVIVES

```
grep "dual-api"     backend/src/  -> NO MATCHES
grep "dual.api|dualApi|dual_api" backend/ -> NO MATCHES
```

Switch arms at `backend/src/services/product-count-probe.ts:148-451` enumerated and read: `wp-rest-header | json-api-count | json-api-length | html-pagination | sitemap | sitemap-index | generic-product-sitemap | ecwid-storefront-search | shopify-products-walk | klevu-api-count | stream-page-count`. Default arm (line 446-451) `console.warn(...) return null;`. `dual-api` falls through. `crawl-scheduler.ts:254-257` and `worker.ts:248-256` both consume `siteProfile.productCountMethod` directly — no other branch resurrects `dual-api`. Confirmed: silently disabled.

### 2. 10-product admin-only consignment-status walk — R2 PARTIALLY DISPROVED (structural conclusion survives, narrative overstated)

Sampled 10 random wp/v2 slugs from pages 50, 100, 150 (different from R2's page-10 picks):

| Slug | Store API list?slug | Store API page1/page2 (per_page=100) | Direct page schema.org availability |
|---|---|---|---|
| marlin-model-60ss-22lr-14010nc | 0 hits | absent | OutOfStock |
| hatsan-55cr-air-rifle-177cal-13733nc | 0 hits | absent | OutOfStock |
| **remington-3200-competition-12ga-14006n** | **1 hit, is_in_stock:true, price $2200** | **on page1** | (in stock) |
| **smithwesson-sd40-sd40ve-40sw-magazine-199280000** | **1 hit, is_in_stock:true** | **on page1** | (in stock) |
| **smithwesson-41-422-622-2206-22lr-magazine-194410000-copy** | **1 hit, is_in_stock:true** | **on page1** | (in stock) |
| **tikka-t1x-17hmr-magazine-s545203782** | **1 hit, is_in_stock:true** | **on page1** | (in stock) |
| winchester-1892-44-40winchester-13463n | 0 hits | absent | OutOfStock |
| savage-170-30-30winchester-13460nc | 0 hits | absent | OutOfStock |
| cooey-60-22cal-13458nc | 0 hits | absent | OutOfStock |
| ruger-10-22-22lr-13455n | 0 hits | absent | OutOfStock |

**4 of 10 ("admin-only" because drawn from wp/v2 pages 50/100/150 deeper than the storefront's first page) are actually IN the Store API list of 161, in-stock and purchasable.** wp/v2 is sorted by date desc, so deeper pages still contain *recently dated but not necessarily sold* products. R2's claim — "5/5 randomly-selected old wp/v2-published products = 0 Store API hits = ALL consignment-hidden" — was true for the specific old-product picks at page 10 but does NOT generalize across the wp/v2 paging.

The structural conclusion (`expectedProductCount=161`, Store API filtered by `is_in_stock`/`catalog_visibility`) still holds: 6 of 10 sampled deeper-page slugs ARE admin-only-hidden-from-Store-API and ARE schema.org OutOfStock. The 1661 - 161 = 1500 gap is real. **R2's correction value survives; R2's evidence narrative was loose.**

Cross-validated via independent storefront walk: all 18 pages of `/shop/` returned exactly **161 unique product slugs** — perfect match to Store API X-WP-Total=161 and R1/R2's claim.

### 3. WAF rapid-burst timing test verdict — R2 SURVIVES

30-request rapid burst against `https://alsimmonsgunshop.com/shop/?nocache=N` with browser UA:

- All 30 responses: HTTP 200, no 429, no 503.
- Cold start req1=4.11s; req2-30 all between 0.77s and 1.14s (median ~0.93s).
- No timing degradation (last 10: 0.84/0.83/0.93/0.97/0.98/0.96/1.10/0.89/0.87 s — flat).
- No CF challenge body or `cf-mitigated` header injected.

`hasWaf:false` (R2) confirmed correct under burst pressure.

## Deep-walk on one R1-correct field: independent `catalogUrls=["/shop/"]` 100% coverage verification

Walked all 18 pages of `/shop/` and dedup'd product slugs. Result: **161 unique slugs**, matching Store API total exactly. No category-restricted hidden products escape `/shop/`. The DB's per-category list of 6 URLs is redundant overlap. R1/R2 correct.

## Outcome

| Round | Corrections attempted | Countered | Survived |
|---|---|---|---|
| R3 | 4 (highest-risk) | 0 fully countered | 4 (with one partial narrative caveat) |

**Strongest observations:**

1. **Partial counter on R2's "5/5 admin-only = consignment-hidden" narrative.** A broader 10-slug walk across wp/v2 pages 50/100/150 found 4/10 ARE in Store API. R2's narrative overgeneralized from a same-page sample. **But the operational correction value (`expectedProductCount=161`) survives** — the storefront walk independently returns exactly 161 unique slugs.
2. **No counter on `dual-api`** — confirmed silently disabled by grep + switch read.
3. **No counter on `hasWaf:false`** — 30-burst rapid-fire test passed cleanly.
4. **No counter on `catalogUrls=["/shop/"]`** — independent 18-page walk returned exactly 161 unique slugs (= Store API total), proving /shop is the minimum 100% cover.

## Suggested SKILL.md refinement (carried from R2 gap #1)

When confirming Store-API-only `expectedProductCount` for consignment shops, prefer the **storefront-pagination unique-slug walk** as the canonical evidence (deterministic, exact) over the **N-random-slug sample** (heuristic, sensitive to which page of wp/v2 you draw from). The storefront walk is what the runtime watermark/maintain crawler actually traverses anyway.
