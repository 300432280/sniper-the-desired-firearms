# dantesports.com R3 adversarial counter

Run: `dantesports.com-2026-05-13T09-11-28Z-R3`. Reviewer: engineering-code-reviewer (FRESH skeptic). Mission: TRY TO DISPROVE R2 corrections. NO DB writes. 800ms inter-request delay.

R2 corrections file: `docs/site-audit/dantesports.com-2026-05-13T08-59-44Z-R2-corrections.json`
R2 investigation file: `docs/site-audit/dantesports.com-2026-05-13T08-59-44Z-R2-investigation.md`

---

## Per-correction counter attempts

### 1. catalogUrls = 16 top-level (R2 rejected R1's 3 extra subcat URLs)

**R2 claim**: 0 orphans against 16-cat set; R1's 32 orphans was Store API `categories[]` blind spot.

**Disprove method (independent)**: walked WP REST `/wp-json/wp/v2/product?_fields=id,slug,product_cat,link` bare-origin, pages 1..22 (per_page=100). Fetched product_cat taxonomy `/fr/wp-json/wp/v2/product_cat?per_page=100`. Resolved each product's product_cat[] to top-level ancestors via parent walk. Compared to the 16-cat ID set {526,544,540,1715,556,3070,604,598,12277,592,8640,3088,2305,13606,552,13604}.

Result:
```
Total unique products: 2117
Covered by top-16: 2117
Orphans (no cat): 0
Orphans (cat not in top-16 ancestors): 0
```

**HTML inclusion test (independent, ran on full 25-page walk)**: 6/6 sampled subcat products from `entretien-d-arme-a-feu-2` (cat 580) and `lance-pigeon` (cat 628) appear in the parent `/fr/categorie-produit/accessoires/` walk. Slug counter: 293 unique, matching Store API `?category=540 x-wp-total=293` exactly.

Sampled slugs verified present in /accessoires/ walk:
- outers-kit-nettoyage-universel-32-pieces (cat 580) IN
- browning-kit-de-nettoyage-pour-carabines (cat 580) IN
- real-avid-guide-de-baguette-de-nettoyage-smart-fit-bore-max (cat 580) IN
- lawry-clay-pigeon-dargile-orange-taro (cat 628) IN
- champion-wobble-base-pour-wheelybird-workhorse-freedombird (cat 628) IN
- lanceur-de-pigeons-workhorse-electronic-trap-de-champion (cat 628) IN

Top-16 cat counts (from product_cat taxonomy): 1099+353+293+265+238+190+48+30+27+23+20+17+14+4+2+2 = 2625 cat-assignments across 2117 products (avg 1.24 cats/product), all in or under the 16-cat set.

**Verdict**: COULDN'T DISPROVE. R2 correct.

---

### 2. apiEndpoint = bare `/wp-json/wc/store/v1/products` (drop `/fr/` prefix)

**R2 claim**: woocommerce.ts:340, 422, 530 hardcode bare-origin endpoints; language prefix in siteProfile is decoration-only.

**Disprove method**: read woocommerce.ts lines 260-280, 288-310, 340, 422, 530, 565. Traced `origin` parameter back to all 4 caller sites.

Evidence:
- woocommerce.ts:288 `fetchCatalogPage(origin: string, ...)` — `origin` is parameter
- woocommerce.ts:298 `new URL(origin).hostname` — proves `origin` is treated as a full URL with `.origin` shape (protocol+host, no path)
- woocommerce.ts:340 `axios.get(`${origin}/wp-json/wp/v2/product`...)`
- woocommerce.ts:422 `axios.get(`${origin}/wp-json/wc/store/v1/products`...)`
- woocommerce.ts:530 `axios.get(`${origin}/wp-json/wc/store/v1/products`...)`
- woocommerce.ts:565 same bare-origin path
- Caller (catalog-crawler.ts:262): `const origin = new URL(url).origin;` — `URL.origin` returns ONLY protocol+host, never any pathname
- Caller (watermark-crawler.ts: see params.origin set the same way)
- Caller (stream-detector.ts:140): `new URL(siteUrl).origin`

There is no code path where a language prefix could be appended to `origin` before reaching the adapter. JavaScript's `URL.origin` API guarantees no pathname.

Live HTTP confirmation:
- `https://dantesports.com/wp-json/wc/store/v1/products?per_page=1` → `x-wp-total: 2117` (= FR catalog)
- `https://dantesports.com/fr/wp-json/wc/store/v1/products?per_page=1` → `x-wp-total: 2117`
- `https://dantesports.com/en/wp-json/wc/store/v1/products?per_page=1` → `x-wp-total: 2116`

**Verdict**: COULDN'T DISPROVE. R2 correct — language prefix in apiEndpoint cannot reach runtime. DB's `/en/wp-json/wp/v2/product` decoration would mislead any future auditor into thinking the EN catalog is targeted, when in fact the FR catalog is fetched.

---

### 3. wafType `cloudflare-active` (R2 confidence: medium, "inconclusive — SKILL gap")

**R2 claim**: SKILL.md self-contradicts; `cloudflare-active` is the conservative pick.

**Disprove method**: grep entire `backend/src/` for `wafType`, `cloudflare-active`, `cloudflare-passive`. Read crawl-scheduler.ts hasWaf references.

Evidence — `wafType` reads in production code:
```
backend/src/services/profile-validator.ts:122-125  (validator only — requires wafType be set when hasWaf=true; ANY non-falsy string satisfies)
```

Zero other reads. `crawl-scheduler.ts` reads only `site.hasWaf` (boolean), never `wafType`. The adapter (`woocommerce.ts`) reads only `options?.hasWaf`. The HTTP client reads `hasWaf` for cookie acquisition.

The string difference between `cloudflare-active` and `cloudflare-passive` has **zero runtime effect**. Both values satisfy the validator. The R2 "operator should decide" framing implies a real downstream consequence, but there is none. The choice is documentation-only.

**Verdict**: SURVIVES with a SHARPENED COUNTER — R2 is correct that the value is recordable as `cloudflare-active`, but R2's framing ("conservative pick", "edge-UA filter real cost") overstates the impact. The string is consumed by nothing at runtime. Recording either value is operationally equivalent.

---

### 4. perPage = 48

**R2 claim**: HTML pagination-link probe shows honored set {12, 24, 48}; per_page=100 silently falls back to 12.

**Disprove method**: tested the **Store API** endpoint directly with `per_page=12,24,48,100` (since the runtime adapter calls Store API, not HTML).

Results (returned-array length):
```
per_page=12  -> count=12
per_page=24  -> count=24
per_page=48  -> count=48
per_page=100 -> count=100
```

Store API honors `per_page=100` fine. R2's HTML probe captured a frontend-theme cap, not the API cap. The adapter at woocommerce.ts:293 hard-caps `Math.min(perPage, 100)`, so perPage=100 in siteProfile would yield ~22 pages instead of ~45.

**Verdict**: NOT a disproof (48 works), but a tighter optimal value is 100. R2's perPage=48 is conservative; perPage=100 halves token usage at the catalog stage. This is a SKILL-level gap: probing the HTML last-page link reports the theme's per-page cap, not the adapter's actual transport cap.

---

### 5. apexRedirect (UA-conditional)

Not re-tested independently — descriptive metadata, no runtime branch. **Verdict**: COULDN'T DISPROVE.

### 6. needsPlaywright = false

Not re-tested independently. HTML walk pages were 187-193 KB with product-link patterns directly matchable, consistent with R2. **Verdict**: COULDN'T DISPROVE.

### 7. expectedProductCount = 2117

Independently confirmed:
- bare-origin `/wp-json/wp/v2/product?per_page=1` x-wp-total = **2117**
- `/fr/wp-json/wp/v2/product?per_page=1` x-wp-total = **2117**
- `/en/wp-json/wp/v2/product?per_page=1` x-wp-total = **2116**
- Full WP REST walk dedupe (pages 1..22) = **2117 unique IDs**

**Verdict**: COULDN'T DISPROVE.

---

## Summary

- **Corrections attempted to disprove**: 7
- **Successfully countered**: 0 (perPage=48 is suboptimal-but-correct, not a disproof)
- **Survived**: 7

### 16-catalogUrl orphan walk verdict (MANDATED)

**0 orphans confirmed independently.** WP REST `product_cat` walk + parent-ancestor resolution = 2117/2117 covered by the 16-cat set. R2's claim verified. R1's 32-orphan finding was the WC Store API `categories[]` Uncategorized blind spot.

### Language-prefix runtime path verdict (MANDATED — woocommerce.ts:340, 422, 530)

**Language prefix CANNOT reach runtime.** All three call sites use `${origin}/wp-json/...`. `origin` parameter is set by every caller via `new URL(url).origin`, which by spec returns only protocol+host. There is no code path that could inject `/fr/` or `/en/`. R2 correct.

### wafType impact on scheduler verdict (MANDATED — crawl-scheduler.ts)

**`wafType` is NEVER read by crawl-scheduler.ts.** Scheduler reads `site.hasWaf` (boolean column) only. Across all of `backend/src/`, `wafType` is read by exactly one file: `profile-validator.ts:122-125`, which only checks the field is non-null when `hasWaf=true`. `cloudflare-active` vs `cloudflare-passive` have **identical runtime behavior**. R2's "conservative pick" framing slightly overstates the stakes — operationally the choice is cosmetic.

---

## Strongest counter-claim

Only one real finding: **perPage could be 100, not 48**. R2 honored R1's HTML-probed cap, but the runtime path is the WC Store API which honors `per_page=100`. siteProfile.perPage=100 halves catalog-crawl tokens vs perPage=48. Not a disproof of R2 (both work) — a missed optimization.

## SKILL gap to add

When probing perPage cap, probe the ACTUAL runtime transport (WC Store API for woocommerce adapter), not the HTML category archive. The HTML theme cap is independent of the API cap.

---

## Artifacts

- `_audit_tmp/r3-dante/cats-p1.json` — WP REST product_cat taxonomy (82 cats, 16 top-level)
- `_audit_tmp/r3-dante/parent-map.json` — cat parent resolution map
- `_audit_tmp/r3-dante/wprest-p{1..22}.json` — 2117 products with product_cat[]
- `_audit_tmp/r3-dante/accessoires/p{1..25}.html` — full /accessoires/ HTML walk (293 slugs)
