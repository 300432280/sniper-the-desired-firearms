# B4R3 Counter-Claim Report - canadafirstammo.ca

Round 3 of 4. Adversarial disproof of R2's verdicts. Read ONLY R2 investigation + R2 corrected profile + live site + runtime code. Did NOT read R1 candidate, R1 diff, or DB snapshot per protocol.

---

## 1. R2: `hasWaf=false` (R1 wins via rapid-burst behavioral attack — 5/5 SQLi = 301)

**Adversarial test used:**
- 10x sustained SQLi burst with `sqlmap/1.0` UA: `for i in 1..10; do curl -A "sqlmap/1.0" "...?id=1' UNION SELECT * FROM users--"`
- Bot UA single request: `curl -A "sqlmap/1.0" /` → headers full dump
- Compare with Mozilla UA (R2's UA): same URL

**Result:**
- sqlmap UA × 10 bursts → **10/10 HTTP 403** (Cloudflare WAF block; bot rule fires)
- Mozilla UA → HTTP 200 (R2's result reproduces)
- Empty UA → 200; `python-requests/2.28` UA → 200
- 403 response carries `Server: cloudflare`, `cf-ray`, `Referrer-Policy: same-origin`, body length 16 ("Forbidden") — classic CF Managed Challenge WAF response, not a generic redirect

**Verdict:** couldn't disprove for production behavior. Cloudflare DOES have an active WAF rule, but it only fires on bot/attack UAs. FirearmAlert's `http-client.ts:9-14` rotates real desktop UAs (Chrome 120, Safari 17, Firefox 121, Edge 120) — none match the sqlmap signature. R2's `hasWaf=false` is correct for crawler-visible behavior.

**Note for next round:** R2's claim "no rate limit, no WAF challenge" is overstated — CF has active rules but they're UA-based, not behavioral. Reword as "no rules fire against rotated browser UAs".

---

## 2. R2: `expectedProductCount = 962` from `/wp-json/wp/v2/product` X-WP-Total

**Adversarial test used:** Compare WP REST product count against multiple ground-truth surfaces:
- `/wp-json/wp/v2/product?per_page=1` → `x-wp-total: 962`
- `/wp-json/wc/store/v1/products?per_page=1` → `x-wp-total: 132`
- `/product-category/shop-all/` HTML scrape → "Showing 12 of 111"
- `/product-category/firearms/` → "16 results"
- `/product-category/ammunition/` → "Showing 12 of 33"
- `/product-category/clearance/` → "Showing 12 of 68"
- `/product-category/accessories/` taxonomy count → 48

**Result:** WP REST returns 962 because it counts ALL `status=publish` products including `catalog_visibility=hidden` / draft-converted / archived items. Customer-facing reality (Store API + HTML category views) is **~132 products**. Sum of public category counts (firearms 16 + ammunition 33 + accessories 48 + reloading 3 + clearance 68 + apparel 2 + training 2 + gunsmithing 0 = 172, minus cross-listings) lines up with ~132.

**Verdict:** COUNTER. `expectedProductCount=962` is wrong by ~7x.

**Runtime impact (verified by reading `product-count-probe.ts:521-525`):** `verifyBootstrapCoverage` computes `ratio = dbCount / expectedCount`. With realistic crawler harvest of ~132, ratio = 132/962 = 13.7%, far below `COVERAGE_THRESHOLD` — **bootstrap will never report acceptable coverage**. Crawler stuck in "still bootstrapping" indefinitely.

**Proposed corrected value:** `expectedProductCount: 132`, change `productCountMethod` to `{ method: "wp-rest-header", endpoint: "/wp-json/wc/store/v1/products", header: "x-wp-total" }` (Store API, not WP REST).

---

## 3. R2: `topLevelCategories.allOption` numbers (firearms 203, ammunition 440, accessories 248, shop-all 925, etc.)

**Adversarial test used:**
- `/wp-json/wp/v2/product_cat?slug=firearms,ammunition,accessories,reloading,clearance,apparel,training,gunsmithing` direct taxonomy count
- HTML scrape "Showing N of M" header on each category page
- Store API total per category id (e.g. `?category=4725` = firearms)

**Result:**

| Slug | R2 `allOption` | taxonomy count | HTML "of N" | Store API |
|---|---|---|---|---|
| firearms | **203** | 16 | 16 | 15 |
| ammunition | **440** | 33 | 33 | — |
| accessories | **248** | 48 | — | — |
| reloading | **9** | 3 | — | — |
| clearance | **138** | 68 | — | — |
| apparel | 2 | 2 | — | — |
| training | **3** | 2 | — | — |
| shop-all | **925** | — | **111** | — |
| gunsmithing | 0 | 0 | — | 0 |

**Verdict:** COUNTER. 6 of 11 `allOption` values are wrong by 3-13x. Only `apparel` (2), `gunsmithing` (0), and possibly `plates-apparel` (14) match reality.

**Source-of-error hypothesis:** R2 likely pulled these from WP REST `product_cat.count` of an OLDER snapshot, or from a `count_full` (recursive descendants) field that included drafts. Not verified — but every number above 50 is wrong against live data.

**Proposed corrected values:** Replace each `allOption` with the live HTML "of N" count or `/wp-json/wc/store/v1/products?category={id}&per_page=1` X-WP-Total. Use Store API totals consistently for the runtime-meaningful count.

---

## 4. R2: `catalogUrls` includes `/product-category/gunsmithing/` per Mistake 12

**Adversarial test used:**
- `HEAD /product-category/gunsmithing/` → 200 (R2's claim confirmed)
- **NEW**: `HEAD /product-category/gunsmithing/page/2/` → 404
- `GET /product-category/gunsmithing/` HTML body → 360KB, "No products" text present
- Store API `?category=4822` → 0 products

**Result:** Page 1 returns 200 (per Mistake 12, "empty != dead"). Page 2 returns 404. Catalog crawler's `consecutiveEmptyHtml` counter (catalog-crawler.ts:458-462) handles this gracefully — it sees 0 products, increments counter, tries next page URL via `getNextPageUrl`. For paginated WC categories on page 1 = 200 + 0 products → counter increments → loops to page 2 = 404 → breaks. No infinite loop. Single token wasted per cycle. Benign.

**Verdict:** couldn't disprove. R2's Mistake-12 verdict holds — but the cost is one wasted token/cycle and a misleading log line. Acceptable per playbook.

---

## 5. R2: `catalogUrls` form (absolute URLs vs path-only "both work")

**Adversarial test used:** Read `backend/src/services/scraper/adapters/woocommerce.ts:265-268`:
```ts
if (entry?.siteProfile?.catalogUrls?.length) {
  for (const u of entry.siteProfile.catalogUrls) {
    urls.push(u.startsWith('http') ? u : `${origin}${u}`);
  }
}
```

**Result:** Confirmed — adapter normalizes both forms. R2's "cosmetic" verdict is correct.

**Verdict:** couldn't disprove.

---

## 6. R2: `sortVerified: true` (boolean) — DB shape `{method, results, verifiedAt}` is "audit residue"

**Adversarial test used:** Read `profile-validator.ts:115` directly:
```ts
if (p.sortVerified === true || p.sortParam) return null;
```

**Result:** Strict `=== true` check confirmed. DB object is truthy but fails strict-equality; validator falls through to `|| p.sortParam` which passes (sortParam set). Grep for `sortVerified` in `backend/src/` and `frontend/src/` returned only the validator (2 lines). No runtime consumer reads it for branching.

**Verdict:** couldn't disprove.

---

## 7. R2: `searchUrl = "/?s={keyword}&post_type=product"` (DB wins)

**Adversarial test used:**
- `curl -L "?s=glock&post_type=product"` → R2 claim: redirects to product page
- `curl -o /dev/null "?s=glock"` (no -L) → HTTP 302 → `Location: /product/sgm-tactical-glock-mag/`
- `curl "?s=ammo"` → HTTP 200, body 367KB (real search results page)
- `curl "?s=zzz_nonexistent"` → HTTP 200 (search no-results page)

**Result:** "glock" yields 302→product because WooCommerce's `s` search with single exact match auto-redirects (standard WC behavior, `WOOCOMMERCE_REDIRECT_TO_PRODUCT_ON_SINGLE_SEARCH_RESULT` or theme default). For multi-result queries, returns 200 with full SERP HTML. R2's evidence ("redirects then resolves to product") was technically true but only for the 1-match edge case — misleading because in production the more common case is multi-result → 200.

**Verdict:** couldn't disprove the field value itself. The searchUrl works. But R2's "302→product" evidence is misleading — should add evidence for multi-result behavior (the common case).

---

## 8. R2's runtime-cost claim: `hasWaf=true` ⇒ "perPage 20 instead of 50 (-60% pagination)"

**Adversarial test used:** Read `catalog-crawler.ts:267,290`:
```ts
const profilePerPage: number | undefined = profileEntry?.siteProfile?.perPage ?? undefined;
// ...
perPage: profilePerPage || (params.hasWaf ? 20 : 50),
```

**Result:** Profile sets `perPage: 12`. Short-circuit `||` evaluates `12 || …` → **12** regardless of `hasWaf`. The "60% throttle" R2 cites would only fire if `profile.perPage` were absent.

**Verdict:** COUNTER (partial). R2's directional conclusion ("hasWaf=true adds overhead") is still correct via line 447 (Playwright fallback retry on `html.length > 2000`) and line 459 (consecutive-empty WAF branch). But the headline "-60% pagination efficiency" is wrong for this site — perPage stays at 12 either way. Correct R2's `runtimeHasWafEffects[0]` to "perPage downgrade does NOT fire (profile.perPage=12 short-circuits); cost is restricted to Playwright fallback path + consecutive-empty WAF branch".

---

## 9. R2: `lastVerified = 2026-05-19`

**Adversarial test used:** N/A — date-stamp field.

**Verdict:** couldn't disprove.

---

# Summary

**Counters found: 4** (R2 claims partially or fully disproved)
- #2 expectedProductCount=962 (actually ~132; bootstrap coverage gate will permanently fail)
- #3 topLevelCategories.allOption numbers (6 of 11 inflated 3-13x)
- #8 runtimeHasWafEffects "perPage 20 instead of 50" (won't fire — profile.perPage=12)
- #1, #7 — R2's evidence reasoning is misleading even when the field value is correct

**Couldn't disprove: 5** (#1 hasWaf=false against rotated UAs, #4 gunsmithing per Mistake 12, #5 catalogUrls form, #6 sortVerified shape, #7 searchUrl field value, #9 lastVerified)

**Top 3 successful counters:**
1. **expectedProductCount=962 is wrong by ~7x.** Live evidence: Store API `x-wp-total=132`; shop-all HTML "Showing 12 of 111". WP REST returns 962 because it counts catalog-hidden + draft products. Coverage gate at `product-count-probe.ts:525` will compute ratio = 132/962 = 13.7% → bootstrap-stuck-forever.
2. **topLevelCategories.allOption values are fabricated/stale.** Firearms claimed 203, actually 16. Ammunition claimed 440, actually 33. shop-all claimed 925, actually 111. Verified against `/wp-json/wp/v2/product_cat`, Store API, and HTML "Showing N of M" headers.
3. **R2's "perPage 20 instead of 50 (-60%)" runtime cost is fictional for this site.** `catalog-crawler.ts:290` is `profilePerPage || (params.hasWaf ? 20 : 50)` — and `profile.perPage=12` short-circuits the `||`. The actual hasWaf=true cost on canadafirstammo is the Playwright fallback retry (line 447), not pagination throttling.

**Couldn't test:** none. All R2 claims testable within budget.
