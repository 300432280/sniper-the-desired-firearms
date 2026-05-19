# R3 Adversarial Counter — budgetshootersupply.ca

**Audited:** 2026-05-15T12-52-54Z
**vs R2:** `budgetshootersupply.ca-2026-05-15T09-18-08Z-R2-corrections.json`
**Prior R3:** `budgetshootersupply.ca-2026-05-13T09-08-59Z-R3-counter.md` (re-tested for stability over 2 days)
**Stance:** fresh skeptic; attempted to break each R2 correction with orthogonal methods.

---

## REQUIRED probe (a): 4th independent signal for `expectedProductCount`

R2 cited 3 signals: WP REST `x-wp-total` (2809), WC Store API with combined stock filter (2809), sitemap union (1001+1000+808 = 2809).

I added two ORTHOGONAL 4th methods, both completed:

**4a. Paginate WP REST and count unique product ids** (`/wp-json/wp/v2/product?per_page=100&_fields=id`, all 29 pages, 800ms-spaced):
- Result: **2809 unique ids** (min 7247, max 97979).
- Independent of `x-wp-total` header — counts response bodies, not header value.
- File: `_audit_tmp/wp_rest_ids.json`.

**4b. Walk every category via WC Store API, dedupe by product id** (189 cats with count>0, both `stock_status[]=instock` and `stock_status[]=outofstock`, 800ms-spaced):
- Result: **2809 unique ids** (min 7247, max 97979).
- Independent of WP REST and of any header — pure aggregation of category membership.
- File: `_audit_tmp/walk_cats_ids.json`.

Live signals snapshot (2026-05-15T12:48Z):
- `GET /wp-json/wp/v2/product?per_page=1` → `X-WP-Total: 2809`
- `GET /wp-json/wc/store/v1/products?per_page=1&stock_status[]=instock&stock_status[]=outofstock` → `X-WP-Total: 2809`
- Sitemap union: 1001 + 1000 + 808 = **2809**
- 4a (WP REST id pagination): **2809 unique**
- 4b (Store API category-walk dedupe): **2809 unique**

**FIVE independent methods agree exactly.** Min/max ids match between 4a and 4b → same product set, not just same cardinality. **Counter-claim: failed.** `expectedProductCount = 2809` is unbreakable.

---

## REQUIRED probe (b): force WP REST 401 — does HTML branch fire? Does `catalogUrls=['/products/']` survive?

R2 claimed `catalogUrls` is operationally irrelevant because line 358 `if (!apiCrawlUsed && adapter.extractCatalogProducts)` is never reached. Verified by tracing the WP-REST-401 code path:

1. `fetchCatalogPage` → `woocommerce.ts:340` calls `/wp-json/wp/v2/product`.
2. `validateStatus` (line 344) accepts 401. If `resp.status === 401`, lines 348-350 set `wpRestFailed=true` and throw `'WP REST API returned 401 (auth-gated)'`.
3. Catch block (line 397): message is not timeout/ECONNREFUSED, so falls through. `wpRestFailed=true` already set at line 405.
4. Line 412: `if ((isStoreApiOnly || wpRestFailed) && seen.size === 0)` fires **Store API standalone path** with `?after=` (NOT `?modified_after=`).
5. OOS pass (lines 462-508) adds out-of-stock products. Live combined-stock denominator = 2809, so Store API yields same product set.
6. Line 518-520: returns `{ products, totalPages }` to caller.
7. Back in `catalog-crawler.ts:288`: non-null return. Line 302 sets `apiCrawlUsed = true`.
8. Line 358: `!apiCrawlUsed` is FALSE → **HTML branch skipped**.

**Only path to HTML when any API responds:** Mistake 34 fix (catalog-crawler.ts:339-349) — requires 3 consecutive cycles of `apiCrawlUsed && productsFound===0`. Not triggered for this site because Store API standalone always returns products.

**Tested adjacent endpoints to confirm WP semantics:**
- `/wp-json/wp/v2/users/me` → **401** (auth gate exists in WP layer).
- `/wp-json/wp/v2/product?status=draft` → 400 (parameter validation).
- `/wp-json/wp/v2/product` → 200 with 2809 results (current live state).

I could not naturally force the live `/wp/v2/product` to 401 without server-side config, but the code trace fully determines the outcome.

**Verdict: R2 correct.** `catalogUrls=['/products/']` is operationally irrelevant — HTML branch unreachable while either WP REST OR Store API standalone returns products.

**Minor SPOF nit (not a counter-claim):** R2 framed `['/products/']` as "intentionally a placeholder" and called R1's 167-leaf list "wasted index work." If BOTH APIs fail simultaneously, Mistake 34 fires and HTML uses `/products/` → ~5 products (Woodmart AJAX). R1's 167 leaves would be a safety net for that dual-API-down case. This is a defensive-design vs minimum-runtime call, not a correctness issue. R2's runtime correctness stands.

---

## REQUIRED probe (c): re-verify `modified_after` at woocommerce.ts:337

Re-read of `woocommerce.ts:325-345` verbatim (2026-05-15):

```
325  // 1. WP REST API first — returns ALL published products (including out-of-stock)
329  let wpRestFailed = false;
330  if (!isStoreApiOnly) try {
331    const params: Record<string, any> = {
332      per_page: perPage, page,
333      orderby: hasDateFilter ? 'modified' : 'date',
334      order,
335      _embed: 'wp:featuredmedia,wp:term',
336    };
337    if (options?.dateAfter) params.modified_after = options.dateAfter;
338    if (options?.dateBefore) params.modified_before = options.dateBefore;
339
340    let resp = await axios.get(`${origin}/wp-json/wp/v2/product`, {
```

Surrounding conditional branches:
- **Line 330** outer guard `if (!isStoreApiOnly)` — when site profile has `storeApiOnly=true`, WP REST block is skipped, and Store API standalone (line 412, uses `?after=`) is the date-filter param. Budgetshootersupply.ca does NOT have `storeApiOnly=true`.
- **Line 337 itself** is `if (options?.dateAfter)` — only sets `modified_after` when caller provides dateAfter.
- No alternate field name, env var, or per-site override for the param NAME (only whether to set it).

Live monotonicity (2026-05-15, 800ms-spaced):
- `modified_after=2026-05-01` → 444 (verified via R2)
- `modified_after=2026-05-10` → 196
- `modified_after=2026-05-14` → 22

**Verdict: R2 correct.** `modified_after` is the WP REST primary param. Flips to `after` only when `storeApiOnly=true`, not applicable here.

---

## REQUIRED probe (d): re-test recursion gap on 3 DIFFERENT cats, 2 days after prior R3

Prior R3 (2026-05-13) tested cats 162, 163, 164, 170, 218 (infinite/24x/29x gaps). I tested 3 NEW cats:

| Cat ID | Slug | WP REST `?product_cat=N` | WC Store `?category=N` (combined stock) | Ratio |
|---|---|---|---|---|
| 188 | rifle-bullets-projectiles | 1 | 499 | 499x |
| 372 | pal-ups | 312 | 312 | 1.0 (flat leaf cat) |
| 191 | smokeless-powder | 0 | 151 | infinite |

**Pattern stable across 2 days.** Hierarchical cats show massive WP-REST-under-Store gaps (499x, infinite); flat leaf cats (`pal-ups` — no children) match 1:1. The gap is STRUCTURAL (WP REST `product_cat` filter doesn't recurse into child terms; Store API does), not transient.

Counter-claim: failed. **Operationally irrelevant for budgetshootersupply.ca** — runtime crawler uses unfiltered `/wp-json/wp/v2/product` (no `product_cat` param), so it gets the full 2809 across all cats. The recursion gap is a "don't do this in a future refactor" landmine.

---

## Per-correction counter table

| Field | R2 value | Counter? | Notes |
|---|---|---|---|
| `expectedProductCount` | 2809 | couldn't disprove | FIVE independent methods all = 2809. Min/max ids match across methods. |
| `productCountMethod.endpoint` | `/wp-json/wp/v2/product` | couldn't disprove | Runtime woocommerce.ts:340 uses this; Store API default would hide 1232 OOS. |
| `hasWaf` | false | couldn't disprove | 10-burst all 200, Server: Apache, SQLi 403 rule-selective only. |
| `wafType` | null | couldn't disprove | Downstream of hasWaf=false. |
| `catalogUrls` | `['/products/']` | couldn't disprove | Trace confirms HTML branch unreachable. SPOF nit only. |
| `paginationPattern.type` | `api-page` | couldn't disprove | Runtime walks WP REST `?page=N`. HTML pagination never runs. |
| `paginationPattern.template` | `page={N}` | couldn't disprove | Same as above. |
| `apiDateFilter.param` | `modified_after` | couldn't disprove | Line 337 verbatim. Only flips to `after` when `storeApiOnly=true` (not this site). |
| `searchUrl` | `/?s={keyword}&post_type=product` | couldn't disprove | Preserves DB. |
| `topLevelCategories` | informational | couldn't disprove | Unused at runtime. |

---

## Stability vs prior R3 (2026-05-13 → 2026-05-15)

| Metric | 2026-05-13 prior R3 | 2026-05-15 this R3 | Drift |
|---|---|---|---|
| `X-WP-Total` on `/wp-json/wp/v2/product` | 2808 | 2809 | +1 (catalog churn) |
| Recursion gap pattern | 3 of 5 cats = 0 from WP REST | 1 of 3 cats = 0, 1 = 499x, 1 flat | Stable: hierarchy → gap |
| WP REST 401 path → HTML branch | unreachable (Store API fallback fires) | unreachable (same trace) | Stable |
| Rapid-burst 10x at 800ms | all 200 | all 200 | Stable |

R2's claims survived two adversarial rounds 2 days apart. No regressions, no contradicting evidence.

---

## Summary

- **Corrections attempted to disprove:** 10 (all R2 fields)
- **Countered:** 0
- **Survived:** 10 (one minor SPOF nit on catalogUrls; not a correctness issue)

**4th-method `expectedProductCount` verdict (REQUIRED):**
Two orthogonal 4th methods both yield **2809**:
- WP REST id pagination across all 29 pages = 2809 unique ids.
- Store API category-walk dedupe across all 189 categories = 2809 unique ids.
Combined with R2's three prior signals (WP REST header, Store API combined-stock header, sitemap union), FIVE independent methods agree exactly. Min/max ids match across methods (7247..97979), so it's not just same count but same product set. R2's 2809 is unbreakable.

**HTML-fallback-when-WP-REST-401 verdict (REQUIRED):**
Read `catalog-crawler.ts:358` verbatim — `if (!apiCrawlUsed && adapter.extractCatalogProducts)`. Traced the WP-REST-401 code path through `woocommerce.ts:340-407` (catch block) → `woocommerce.ts:412-520` (Store API standalone with `?after=` + OOS pass) → returns 2809 products → caller sets `apiCrawlUsed=true` → line 358 condition is FALSE → HTML branch skipped. The ONLY path to HTML on a WC site where any API responds is the Mistake 34 fix at catalog-crawler.ts:339-349, which requires 3 consecutive cycles of `apiCrawlUsed && productsFound===0`. Not triggered on this site. R2's `catalogUrls=['/products/']` correctness stands; minor SPOF risk noted but not a counter-claim.

R2 is operationally correct across all 10 corrections.
