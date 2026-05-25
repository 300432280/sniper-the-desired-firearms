# gotenda.com — Batch-4 Validation Report

**Timestamp:** 2026-05-19T23-00-00Z (run 2026-05-21)
**Reviewer:** engineering-code-reviewer (single validation round, positive + adversarial)
**Source data:** live HTTP via Playwright-issued Sucuri cookies (16 cookies; `sucuri_cloudproxy_uuid_1a3be7b76` present)
**Probe script:** `backend/scripts/_tmp-gotenda-b4-validate.ts` (scratch; delete at session cleanup)
**Post-fix DB snapshot:** `_audit_tmp/batch4-validation-2026-05-19/gotenda.com-POSTFIX.json`

---

## TL;DR

| Fix | Verdict | Evidence |
|---|---|---|
| 1. `catalogUrls = ['/shop/']` | **PASS** | /shop/ p1 = 200, 24 cards, paginator says lastPage=694; full walk covers all 16,645 products |
| 2. `expectedProductCount = 16615` | **NEEDS-OPERATOR** | Live x-wp-total = **16,645** (DB has 16,615 — 30-product / 0.18% drift) |
| 3. `productCountMethod = wp-rest-header /wp-json/wp/v2/product x-wp-total` | **PASS** | Endpoint returns x-wp-total=16645 with 200 status |
| 4. `perPage = 24` (theme cap) | **PASS** | `?per_page=100` and `?per_page=50` both still return exactly 24 `li.product`. Theme silently caps. |

---

## FIX-1 — `catalogUrls = ['/shop/']`

### Positive
- `https://www.gotenda.com/shop/` returns **200**, 24 `li.product` cards, 105 `a[href*="/product/"]` anchors
- `.woocommerce-result-count` text: `Showing 1–24 of 16645 resultsSorted by latest`
- Default sort is already date-desc — matches DB `sortParam=?orderby=date&order=desc` claim
- 3 sampled product detail URLs all return 200 with prices:
  - `/product/tenda-key-style-cable-lock-black/` → 200, `$6.99`
  - `/product/tenda-key-style-cable-lock-red/` → 200, `$6.99`
  - `/product/norinco-jw-25-mini-mauser-22lr-bolt-action-rifle-clearance-2/` → 200, `$169.99` (sale)

### Adversarial
- **R3 evidence claim DISPROVED**: `/shop/page/694/` does **NOT** 404 — it returns **200 with 13 `li.product`** (final partial page; 24×693 + 13 = 16,645 = live total).
- True last page is **694**, not 693. R3 was wrong by one page.
- This does NOT block the fix (`/shop/` walks until cards=0 / 404 / paginator exhausted), but the previously-cited "693 evidence" should be retired.
- Paginator on both p1 and p693 shows `highest .page-numbers = 694` (consistent, not an off-by-one display bug).

### Verdict: **PASS**
The catalog spine works; collapsing 8 dead per-category slugs to `/shop/` is correct. Note for next batch: update notes to "last page = 694, partial 13 products" (not 693).

---

## FIX-2 — `expectedProductCount = 16615`

### Positive
- DB value (16,615) is within ~0.18% of live truth (16,645). Same order of magnitude. Old 2026-04-07 value was 16,268, so the new value is fresher.

### Adversarial
- **Live x-wp-total is 16,645**, both via WP REST `/wp-json/wp/v2/product` and Store API `/wp-json/wc/store/v1/products` (cross-confirmed — same number from two independent sources).
- **30-product gap** between DB (16,615) and live (16,645). Direction = under-count, so it errs safe (crawler won't claim "I'm done" when it isn't).
- Gap likely = product churn between when operator captured the number and now. Not a structural bug.
- `.woocommerce-result-count` on /shop/ also reports 16,645 — three independent surfaces all agree.

### Verdict: **NEEDS-OPERATOR** (advisory, non-blocking)
Number is stale by ~30 products. Either accept the drift (numbers will always lag on a 16k-SKU site) or refresh to 16,645. Not a code defect — this is a snapshot freshness question.

---

## FIX-3 — `productCountMethod = wp-rest-header /wp-json/wp/v2/product x-wp-total`

### Positive
- `GET /wp-json/wp/v2/product?per_page=1` returns **status=200, x-wp-total=16645, x-wp-totalpages=16645**.
- Header present, parseable, numeric, matches a second source.

### Adversarial — known codebase pitfall
- The persona pitfall "_fields parameter breaks _embed in WP REST API" is **not relevant here** — the count method does not pass `_fields` or `_embed`. Verified by reading the configured endpoint string in DB: `/wp-json/wp/v2/product` (no query string). Safe.
- `x-wp-totalpages=16645` is correct for `per_page=1` (every product = 1 page). If anyone changes `per_page` later, they must re-read the header (don't cache `totalpages`).

### Verdict: **PASS**

---

## FIX-4 — `perPage = 24` + `paginationPattern.perPage = 24`

### Positive
- `/shop/page/693/` returns exactly 24 products (full page)
- `/shop/page/694/` returns exactly 13 products (final partial page) — confirms 24 is the page size, not just a coincidence
- 24 × 693 + 13 = 16,645 = live total. Arithmetic closes cleanly.

### Adversarial — theme cap test
- `/shop/?per_page=100` → **200, 24 `li.product`** (theme silently capped, did not honor query string)
- `/shop/?per_page=50` → **200, 24 `li.product`** (same: silently capped)
- Confirms the theme ignores `?per_page=` overrides. `perPage=24` is correct and cannot be increased. Any crawler that tries `?per_page=100` will waste a request and get the same data.

### Verdict: **PASS**

---

## Cross-cutting checks

### Sucuri WAF interaction (persona pitfall)
- Single Playwright bootstrap on `/shop/` produced 16 cookies including `sucuri_cloudproxy_uuid_1a3be7b76`.
- Reused-cookie axios calls for HTML, WP REST, and Store API all returned 200. Matches `wafWorkaround.method=cookie-cache` in DB.
- No re-solve needed during the run. Matches `cookieTtlMinutes: 30` claim.

### Code-path consistency (persona pitfalls reviewed)
- "API streams use DATE ranges, HTML streams use PAGE ranges" — DB has both: `watermark.method=api-date-since-watermark` (DATE) for /wp/v2/product, and `paginationPattern.type=path /page/{N}` (PAGE) for /shop/. Cleanly separated, not mixed.
- "WC Store API only returns in-stock items" — Store API count (16,645) matched WP REST (16,645). Surprising; in prior incidents Store API returned lower numbers. Possible explanation: gotenda may not hide OOS in storefront. Worth a deeper look in a future batch but does NOT invalidate this fix.
- No ProductIndex upserts touched by these four DB-only changes. Three-upsert-locations rule N/A.
- No `_fields`+`_embed` combo. Pitfall N/A.

---

## Issues found

1. **R3 evidence inaccurate** — claimed `/shop/page/694/` is 404; actually 200 with 13 products. True last page = 694 (partial). Update audit notes.
2. **expectedProductCount drift** — DB says 16,615; live says 16,645 (30-product gap). Advisory refresh; not a defect.
3. **None blocking.**

## Blockers
None. All four fixes are safe to keep in production.

---

## Suggested follow-ups (NOT blockers)
- Refresh `expectedProductCount` to 16,645 (or accept perpetual drift on a churning site).
- Re-word audit notes: "Last page = 694 (partial 13 products)" replacing the "page 693 final, 694 = 404" claim.
- Cleanup: `backend/scripts/_tmp-gotenda-b4-validate.ts` is scratch — delete at session cleanup per project policy.
