# R3 Adversarial Counter — leverarms.com

- Run: R3-2026-05-15T12-48-38Z
- Reviewing: `docs/site-audit/leverarms.com-2026-05-15T09-19-46Z-R2-corrections.json`
- Cross-checking prior R3: `docs/site-audit/leverarms.com-2026-05-13T09-10-32Z-R3-counter.md`
- Method: live HTTP with 800ms+ delays, broader repo-wide grep (NOT just backend/src), runtime code read, node simulation of `buildPaginatedUrl`. No DB writes.

## Per-correction adjudication

### 1. `hasWaf = false` — COULDN'T DISPROVE
R2's burst evidence (10/10 200 on three crawler URL spaces with cf-cache HIT) is the right test. Prior R3 also couldn't disprove. The distinction "WAF blocks payloads we never send vs WAF blocks the crawler path" is the correct decision rule. **R2 wins; DB stale defensively.**

### 2. `expectedProductCount = 972` — COULDN'T DISPROVE (strongest)
Independent re-verification via **combined-stock-filter denominator** (different from R2's enumerate-each-status approach):

| Query | x-wp-total |
|---|---|
| `wp/v2/product?per_page=1` | **972** |
| `wc/store/v1/products?per_page=1` (default, excludes OOS) | 357 |
| `wc/store/v1/products?stock_status=instock` | 351 |
| `wc/store/v1/products?stock_status=onbackorder` | 6 |
| `wc/store/v1/products?stock_status=outofstock` | 615 |
| `wc/store/v1/products?stock_status%5B0%5D=instock&%5B1%5D=outofstock&%5B2%5D=onbackorder` (array form) | **972** |
| `wc/store/v1/products?stock_status=instock&stock_status=outofstock&stock_status=onbackorder` (repeated form) | 6 |

Combined-array-filter independently lands on 972 — exact match with WP REST total. Two independent paths converge.

**Operator caveat surfaced:** PHP only honors the bracketed-array form for repeated query keys (`stock_status[0]=...&[1]=...`). The naive repeated-key form silently collapses to the LAST value (6 = onbackorder). Add to SKILL.md if combined-filter probes become standard.

Live drift since prior R3 (2026-05-13): 356→357 instock, 971→972 admin. +1 product in ~2 days. R2's snapshot (972) is current.

### 3. `productCountMethod.endpoint = /wp-json/wp/v2/product` — COULDN'T DISPROVE
Follows from #2. WP REST captures the 615 OOS products that the watermark crawler will re-encounter on restock. Store API would mask them.

### 4. `catalogUrls = 6 categories (DB)` — COULDN'T DISPROVE
R2's Rule C reasoning is sound: today's union-coverage redundancy is not a forward-compatibility guarantee. all-surplus / food are semantic taxonomy buckets — a future SKS landing only in all-surplus would not appear in `guns`. Keep all 6. R2 correctly identified this as a SKILL.md harness bug (Stage 4d walk-and-dedup vs Rule C).

### 5. `perPage` dual-value — COULDN'T DISPROVE
R2 correctly identifies HTML pagination at 16/page hardcoded by theme PHP and WC Store API `per_page=100` honored. Two values are needed; profile schema target is the harness gap.

### 6. `paginationPattern.template = "/page/{N}/"` — COULDN'T DISPROVE (dispositive)
Read `backend/src/services/catalog-crawler.ts:118-125` literal. Re-ran node simulation with the actual function body across **all four** baseUrl × template permutations:

| baseUrl | template | output | live HTTP |
|---|---|---|---|
| `...guns/` | `/page/{N}/` | `...guns/page/2/` | **200** |
| `...guns/` | `page/{N}/` | `...gunspage/2/` | **404** |
| `...guns` (no slash) | `/page/{N}/` | `...guns/page/2/` | **200** |
| `...guns` (no slash) | `page/{N}/` | `...gunspage/2/` | **404** |
| `...all-product/` | `/page/{N}/` | `...all-product/page/2/` | **200** |
| `...all-product/` | `page/{N}/` | `...all-productpage/2/` | **404** |

Trailing-slash on baseUrl is **irrelevant** — `buildPaginatedUrl` strips it either way. The leading slash on `template` is what matters and IS required. DB's `page/{N}/` is a latent bug. R2 wins decisively (same verdict as prior R3 reached).

### 7. `crawlers.bootstrap.apiEndpoints` audit-residue claim — COULDN'T DISPROVE
**Broadened the grep beyond R2's `backend/src` + `backend/prisma` to the entire repo (frontend included):**

| Term | backend/src | backend/prisma | frontend/src | Verdict |
|---|---|---|---|---|
| `apiEndpoints` (plural) | 0 | 0 | 0 | unconsumed |
| `productDiscovery` | 0 | 0 | 0 | unconsumed |
| `priceEnrichment` | 0 | 0 | 0 | unconsumed |
| `htmlFallback` | 0 | 0 | 0 | unconsumed |
| `dataFlow` | 0 | 0 | display only (`profiles/page.tsx:21,50,477,498` — generic JSON block) | display-only |
| `single-continuous` | 0 | 0 | 0 | unconsumed |
| `prodDiscovery` (R2-requested variant) | 0 | 0 | 0 | unconsumed |
| `priceEnrich` (R2-requested variant) | 0 | 0 | 0 | unconsumed |
| `crawlers.bootstrap` / `.bootstrap.` (excluding `crawlPhase` literal) | 0 runtime reads | 0 | 0 | unconsumed |

What DOES exist runtime-side (verified live readers):
- `profile?.crawlers?.maintain?.verifyMethod` (`worker.ts:396,763`) — READ + logged when missing
- `profile?.crawlers?.watermark?.method` (`watermark-crawler.ts:680`) — READ with explicit default fallback
- `profile?.crawlers?.watermark?.method/.reason` (`profile-validator.ts:97,109,165`) — VALIDATED

The frontend hit (`profiles/page.tsx`) renders the entire `crawlers` blob as a generic JSON pretty-print — it does not branch on `apiEndpoints` keys.

**Malformed-injection test (static):** No validator exists for `crawlers.bootstrap.*`. `profile-validator.ts` only validates `crawlers.watermark.method` and `.reason`. Injecting `{"apiEndpoints": "this is a string"}` or `{"apiEndpoints": {"⚠⚠⚠": null}}` would produce ZERO runtime warnings — the field is never read and never validated. The only place it surfaces is the frontend admin page's generic JSON pretty-print, which would display the malformed value verbatim. Confirms R2's "pure audit-trail residue (Rule B)" verdict.

R2's grep was honest. Broadening to the full repo did not find a hidden consumer. **R2 wins.**

### 8. `searchUrl = /?s={keyword}&post_type=product` — COULDN'T DISPROVE
Live-probe still returns 200. Matches WC platform default. Trivial.

## Prior-R3 cross-check

Prior R3 (2026-05-13) reached the same verdicts on items 1, 5, 6, 7, 8. The 1-day numerical drift (356→357 / 971→972) is normal product-add churn. No prior-R3 finding contradicts current R2; prior R3 had `expectedProductCount=356` (Store-API total) whereas R2 picks `972` (WP REST admin). This is a methodology difference about which denominator the field should track, not a math error in either run.

R2's choice (972, WP REST admin) aligns better with the watermark crawler's use of WP REST date filters and its need to re-encounter restocking products. Prior R3's choice (356, Store API) aligns with operational customer-visible coverage. Both are defensible — the underlying SKILL.md harness gap (single field can't represent both) is the real issue R2 surfaced.

## REQUIRED verdicts

**apiEndpoints repo-wide grep (REQUIRED).** Re-ran grep across `backend/src`, `backend/prisma`, `backend/scripts`, `frontend/src`, plus variants R2 requested (`prodDiscovery`, `priceEnrich`, `crawlers.bootstrap`). ZERO runtime consumers found anywhere. The only repo-wide matches outside `.claude/skills/`, `docs/`, and `_audit_tmp/` are the frontend's generic JSON-block display (`dataFlow` as TypeScript type field, no key-specific branching). **R2's "pure audit-trail residue" verdict holds.**

**paginationPattern simulation with multiple baseUrl trailing-slash variants (REQUIRED).** Ran node simulation across baseUrl variants `...guns/`, `...guns`, `...all-product/` × templates `/page/{N}/`, `page/{N}/`. Trailing-slash on baseUrl is irrelevant (strip happens unconditionally). Leading slash on template IS required: leading-slash form returns 200 on all baseUrls; no-leading-slash form returns 404 on all. **DB's `page/{N}/` is a latent bug. R2 wins decisively.**

**972 arithmetic re-verification via combined-stock-filter (REQUIRED).** Two independent paths converge on 972:
- Path A (enumerate then sum, R2's): 351 instock + 6 onbackorder + 615 outofstock = 972
- Path B (combined-array filter, this R3's): `?stock_status[0]=instock&[1]=outofstock&[2]=onbackorder` → x-wp-total = 972 EXACT
- Reconciles with WP REST admin total: 972 EXACT

**Operator caveat surfaced:** array-bracket form `stock_status[0]=...` is the ONLY honored syntax for multi-status filtering. Repeated-key form `stock_status=A&stock_status=B&stock_status=C` collapses to the last value (PHP last-write-wins). If a future probe uses the repeated form and gets 6, that's the PHP gotcha, not an arithmetic error.

## Summary

- Corrections reviewed: 9
- Countered: 0
- Survived: 9 (high-confidence: 6, medium: 1, both-stale-but-corrected: 1, audit-residue: 1)
- Strongest survivors:
  1. `paginationPattern.template` — node simulation across 6 permutations + live HTTP 200/404 dispositive
  2. `expectedProductCount = 972` — two independent paths converge (combined-array filter + enumerate-and-sum), reconciles exactly with WP REST admin
  3. `apiEndpoints` audit-only verdict — repo-wide grep (broader than R2's already-broad grep) confirms zero runtime consumers, no validator exists, malformed injection would not warn

R2 holds. The R3 adversarial broadening did not reveal a hidden consumer, did not break the pagination claim, and did not break the 972 arithmetic. The only meaningful additional finding is operational: future combined-filter probes must use the `stock_status[N]=...` bracketed-array form, not the repeated-key form.
