# R2 Live Investigation — leverarms.com (2026-05-15T09-19-46Z)

FRESH agent re-investigation. Different methodology than R1 for every divergent field. Trusted neither candidate nor DB by default — re-derived from live evidence.

## Methodology
- WP REST + WC Store API counts via direct curl, header inspection (`x-wp-total`)
- 6-category Store API walk for catalogUrls union proof (different from R1's category-page-extraction approach)
- Pagination URL builder simulation (read `catalog-crawler.ts:118-125` literal source, ran builder function in node)
- WAF: rapid-burst 10x on three distinct crawler URL spaces (R1 only did 10x on root)
- 615 delta classification: stock_status filter probing on Store API + status enumeration on WP REST
- Grep for `apiEndpoints` / `productDiscovery` / `priceEnrichment` / `single-continuous` / `htmlFallback` / `dataFlow` across `backend/src` + `backend/prisma` (broader than prior batch which used narrower terms)

## Top 3 corrections by impact

### 1. expectedProductCount: BOTH stale; live = 972 (was R1=357, DB=965)
- WP REST `?per_page=1` -> x-wp-total **972** (live, this minute)
- WC Store API `?per_page=1` -> x-wp-total **357**
- Math: instock(351) + onbackorder(6) + outofstock(615) = 972 — exact reconciliation
- **615 delta = OUT-OF-STOCK products**, not drafts/private/hidden (all 972 are `status=publish`, no draft visible publicly)
- DB stale by 7 (was 965, now 972 — gained 7 products since 2026-04-12)
- DB schema correctly has BOTH `expectedProductCount` (admin total) AND `expectedInStockCount` (Store API). R1's output target has only one; this is a real harness gap.

### 2. hasWaf: R1 correct (false); DB stale defensive true
- 10x rapid burst on `/shop/` -> 10/10 HTTP 200 (cf-cache HIT)
- 10x rapid burst on `/wp-json/wc/store/v1/products?per_page=10` -> 10/10 HTTP 200
- 10x rapid burst on `/wp-json/wp/v2/product?per_page=10` -> 10/10 HTTP 200
- 5x sequential `/shop/page/N/` -> 200 (after p1 301->`/shop/`)
- The 403s seen in WAF heavy-probe are on SQLi/XSS/honeypot URLs the crawler never visits. Crawler URL space is unobstructed at any sustained rate.

### 3. paginationPattern.template: R1 correct `/page/{N}/`; DB latent bug `page/{N}/`
- Read `catalog-crawler.ts:121-125` literal: `stripped = baseUrl.endsWith('/') ? slice(0,-1) : baseUrl; return stripped + template`
- Simulated builder: with template=`page/{N}/` and baseUrl=`...guns/` -> output `...gunspage/2/` (BROKEN, no separator)
- Live probe of broken URL -> HTTP **404**. Live probe of correct URL `...guns/page/2/` -> HTTP **200**
- DB's missing-leading-slash form would silently 404 if/when HTML fallback fires. Currently latent because crawler uses WP REST.

## Required investigation outputs

### apiEndpoints fictional-vs-runtime grep verdict (REQUIRED)

**Verdict: PURE AUDIT-TRAIL RESIDUE (Rule B). Neither R1 nor DB shape is consumed by runtime code.**

Broader grep this round, over `backend/src` AND `backend/prisma`, for terms:
- `apiEndpoints` (plural) -> **0 matches**
- `productDiscovery` -> **0 matches**
- `priceEnrichment` -> **0 matches**
- `htmlFallback` -> **0 matches**
- `dataFlow` -> **0 matches**
- `single-continuous` -> **0 matches**

Only related match: `profile?.apiEndpoint` (singular, top-level) in `scraper.ts:667-673` and `auction-icollector.ts:50,205`. That's iCollector-specific, NOT `crawlers.bootstrap.apiEndpoints`.

The word `bootstrap` appears 60+ times in `backend/src` but ALL refer to `crawlPhase === 'bootstrap'` as a state-machine literal — never `siteProfile.crawlers.bootstrap.*`. The actual WooCommerce API endpoints are hard-coded in `scraper/adapters/woocommerce.ts` from compile-time strings, not pulled from the profile.

Both R1's flat `{wcStoreProducts, wpRestProducts, productCategories}` shape and DB's 2-step `{productDiscovery, priceEnrichment} + htmlFallback + dataFlow + method:single-continuous` shape are operator documentation. They diverge but the divergence has no behavioral impact. SKILL.md should either drop the field or mark it explicitly audit-only.

### 615-product admin-only delta classification (REQUIRED)

**Verdict: 100% of the 615 delta = OUT-OF-STOCK products. NOT drafts, NOT private, NOT hidden, NOT category-segregated.**

Proof chain:
1. Walked WP REST `/wp-json/wp/v2/product` fully (10 pages x 100): all 972 returned with `status: "publish"` — no drafts, no private accessible to anonymous (those return 400 on explicit `status=draft` query, confirming no public draft exposure).
2. Walked WC Store API `/wp-json/wc/store/v1/products` fully (4 pages x 100): 357 unique IDs.
3. Probed WC Store API with explicit `stock_status` filters:
   - `stock_status=instock` -> x-wp-total: **351**
   - `stock_status=onbackorder` -> x-wp-total: **6**
   - `stock_status=outofstock` -> x-wp-total: **615**
   - 351 + 6 = 357 (default Store API total, confirming default excludes OOS)
   - 351 + 6 + 615 = 972 (= WP REST total, exact reconciliation)
4. Sampled 8 missing IDs (53130, 53127, 52921, 52775, 52774, 52772, 52771, 52732). All `status=publish`, `catalog_visibility=undefined` (i.e. default visible), all live product pages return 301 redirect to canonical slug URL -> page renders normally.
5. `catalog_visibility=hidden` filter on WP REST is ineffective (returns 972 same as no filter) — WP REST does not honor it; reinforces conclusion that delta is purely stock-status-driven.

### paginationPattern leading-slash code simulation verdict (REQUIRED)

**Verdict: Leading slash REQUIRED. R1's `/page/{N}/` is correct. DB's `page/{N}/` is a latent bug.**

Source code: `backend/src/services/catalog-crawler.ts:121-125`:
```ts
if (pattern?.type === 'path') {
  const template = pattern.template || '/page/{N}';
  const stripped = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${stripped}${template.replace('{N}', String(pageNum))}`;
}
```

The builder strips a trailing slash from baseUrl BEFORE concatenating with template. Template must therefore begin with `/`.

Simulation (executed in node with the literal function body):

| baseUrl | template | output | live probe |
|---|---|---|---|
| `...guns/` | `/page/{N}/` | `...guns/page/2/` | 200 OK |
| `...guns/` | `page/{N}/` | `...gunspage/2/` | 404 |
| `...guns` | `/page/{N}/` | `...guns/page/2/` | (same) |
| `...guns` | `page/{N}/` | `...gunspage/2/` | (same) |

The bug is latent because leverarms currently runs the WP-REST-driven crawl path (`api-date-since-watermark` watermark, `wp-rest-header` count). HTML pagination fallback would activate only on API failure — at which point DB's `page/{N}/` would 404 every page-2+ request and silently produce 0-product cycles. The earlier audit (2026-04-12) appears to have stored the relative form by manual entry, not by running the builder.

## Other findings (lower impact, evidence-backed)

- **catalogUrls 4 vs 6**: Walked all 6 categories via Store API, union = 357 = global. R1's 4-URL union also = 357. Today the 4-URL set is mathematically sufficient. But Rule C ('never drop for being empty/small today') applies because all-surplus is a semantic bucket — a future used-firearm assigned only the all-surplus taxonomy would be missed. **Keep all 6.** This is a SKILL.md harness bug: Stage 4d's walk-and-dedup union test contradicts Rule C when redundancy is by-content-overlap (not by-emptiness).

- **perPage 100 (R1) vs 16 (DB)**: Both correct in their own context. WC Store API honors `per_page=100`; HTML category pages are hardcoded at 16/page by theme PHP loop (`?per_page=` ignored). Profile should carry both. R1's nesting (top-level=100, paginationPattern.perPage=16) is the inverse of what the runtime wants; DB carries only top-level=16.

- **searchUrl**: DB has `/?s={keyword}&post_type=product`, R1 omitted. Live-probed `/?s=ammo&post_type=product` -> 200 with WooCommerce search-result page. DB correct.

## SKILL.md harness gaps surfaced

1. **Stage 2 hasWaf rule conflates payload-WAF with crawler-path-WAF.** Need explicit decision: if origin 403s on payloads but 200s on the actual crawler URL space at sustained rate, output `hasWaf:false`. Add `crawler-burst-test` step that hits `/shop/`, `/wp-json/*`, category-pagination URLs at 10/sec for 3s.

2. **Stage 4d walk-and-dedup contradicts Rule C.** Two valid principles collide: "no overlapping URLs" vs "don't drop categories for being empty today." Resolve by allowing union-redundant categories to stay in `catalogUrls` UNLESS they are subset-equal (every product in cat-X is also in cat-Y with same ID set) — overlap-without-uniques is allowed.

3. **expectedProductCount can't represent WooCommerce dual-count.** Add explicit `expectedInStockCount` (Store API) alongside `expectedProductCount` (WP REST = admin total), with docstring on which crawler reads which.

4. **`crawlers.bootstrap.apiEndpoints` is unconsumed.** Grep proves no runtime reads it. Drop from output target, OR mark audit-only with explicit comment so future audits don't waste cycles diffing it.
