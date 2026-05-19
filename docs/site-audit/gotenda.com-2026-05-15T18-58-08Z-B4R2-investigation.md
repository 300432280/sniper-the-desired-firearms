# B4R2 Investigation - gotenda.com

**Round:** Batch 4 / Round 2 (independent counter-investigation of R1)
**R1 artifacts:**
- `docs/site-audit/gotenda.com-2026-05-15T18-38-29Z-B4R1.json`
- `docs/site-audit/gotenda.com-2026-05-15T18-38-29Z-B4R1-diff.md`

**Method:** different from R1 (live Playwright with Sucuri cookie + strict WooCommerce DOM selector `ul.products > li.product` + 3-method `expectedProductCount` triangulation + `/wp-json/wp/v2/product_cat` taxonomy sum). Trust neither side; cross-check runtime code.

**Probe script:** `backend/_audit_tmp/gotenda-r2-pw.ts` (and follow-up `gotenda-p2.ts`)
**Probe transcript:** captured in stdout above; reproducible via `cd backend && npx tsx _audit_tmp/gotenda-r2-pw.ts`

---

## 1. DB catalogUrls 404 verification (REQUIRED)

Headless Playwright session, valid `sucuri_cloudproxy_uuid_f2f1c7d20` cookie, iPhone-Safari UA. Each URL visited with `waitUntil:'domcontentloaded'` and inspected for HTTP status + `<h1>` + `ul.products > li.product` count.

| DB catalogUrl | HTTP | `<h1>` | 404 body? | strict li.product count | Verdict |
|---|---|---|---|---|---|
| `/product-category/firearms/` | **404** | "Oops! That page can't be found!" | yes | 0 | DEAD |
| `/product-category/ammunition/` | **404** | "Oops! That page can't be found!" | yes | 0 | DEAD |
| `/product-category/accessories/` | 200 | "ACCESSORIES" | no | 11 | live |
| `/product-category/reloading/` | 200 | "RELOADING" | no | 7 | live |
| `/product-category/optic/` | **200** | "-Optic" (lowercase legacy) | no | 24 | LIVE BUT WRONG (legacy slug; taxonomy-API `gun-optics-canada` id=15 count=2258 is the real one) |
| `/product-category/knives/` | **404** | "Oops! That page can't be found!" | yes | 0 | DEAD |
| `/product-category/hunting-outdoor/` | 200 | "HUNTING & OUTDOOR" | no | 7 | live |
| `/shop/` | 200 | "Shop" | no | 24 | live aggregator |

**4 of 8 DB URLs are dead or wrong-slug.** Production has been crawling these since `lastVerified: 2026-04-07` (~5 weeks). Likely covered by the `MAX_CONSECUTIVE_EMPTY_PAGES` tolerance and the WP REST product discovery in bootstrap. The DB-only catalogUrls contribute zero coverage today.

Candidate R1 catalogUrls all returned 200 and matched the taxonomy-API canonical slugs.

---

## 2. perPage live re-probe (REQUIRED)

Strict selector `ul.products > li.product` on `/shop/` with each query variant:

| URL | HTTP | strict li.product count |
|---|---|---|
| `/shop/` | 200 | 24 |
| `/shop/?per_page=100` | 200 | 24 |
| `/shop/?per_page=48` | 200 | 24 |
| `/shop/?per_page=24` | 200 | 24 |

Theme silently caps HTML at **24/page** regardless of query value. DB `perPage: 100` is fiction for HTML walking. (The WC Store API DOES honor `per_page=100`, but that is `enrichmentChunkSize`, not the HTML perPage that `paginationPattern.template /page/{N}/` walks.)

R1's `perPage: 24` is correct. Note avoids the `fishingworldgc` method-artifact lesson by using the strict WooCommerce DOM selector, not slug regex on response body.

---

## 3. expectedProductCount independent 3rd-method verification (REQUIRED)

Three independent methods today (2026-05-15):

| Method | Endpoint | Result |
|---|---|---|
| (a) wp-rest-header | `GET /wp-json/wc/store/v1/products?per_page=1` | `x-wp-total: 16588` |
| (b) wp-rest-header (alt) | `GET /wp-json/wp/v2/product?per_page=1` | `x-wp-total: 16588` |
| (c) sitemap union | 17x `/product-sitemap*.xml` `<url>` tag count | **16,589** (1-off, within rounding) |
| (d) in-stock subset | `GET /wc/store/v1/products?stock_status=instock` | `x-wp-total: 10914` (5,674 oos) |
| (e) taxonomy sum | `/wp/v2/product_cat` 15 cats | top-level cats sum = 18,212 (with overlap) |

Triangulated `expectedProductCount = 16588`. DB's 16,440 (verified 2026-04-07) is 5wk stale; site grew ~148 products in 5 weeks (consistent with retail churn).

Sitemap pagination distribution: 16 files x 1000 + 1 file x 588 + 1 first-page-extra = 16,589. The 1-off vs API count is within sitemap regeneration lag.

`productCountMethod`: both `wp-rest-header` (R1, 1 request) and `sitemap-index` (DB, 17 requests) produce the same answer. R1 wins on efficiency + SKILL Stage 8 priority #1 (customer-visible total). DB's choice is defensible but wasteful.

---

## 4. Cross-checks done

- **Sort param**: `/shop/?orderby=date` and `/shop/?orderby=date&order=desc` returned identical first-3 IDs `[750165, 750084, 750081]`; `?orderby=price` returned different `[206086, 206126, 206088]`. Both R1 and DB sort forms work; recommend DB's explicit `&order=desc` for runtime safety.
- **Page 2 walk** (verifies tile-only-on-page-1 theme behavior): `/firearms-canada/page/2/` -> 24 products, `/ammunition.../page/2/` -> 24, `/gun-optics-canada/page/2/` -> 24. Confirmed.
- **Runtime code check**: `needsPlaywright` is NOT consumed in `src/services/*` (grep returned no runtime branches). Field is metadata; ambiguity is a SKILL.md issue, not a correctness issue.
- **hasCaptcha**: reCAPTCHA v3 is from Contact Form 7. No catalog/product URL was gated. R1's operational=false reading matches SKILL Stage 2 spec.

---

## 5. Critical finding

**Production has been crawling 4 dead/wrong-slug DB URLs for 5+ weeks.** That production hasn't crashed is because:
1. The WP REST product discovery in `crawlers.bootstrap.apiEndpoints.productDiscovery` enumerates all products by ID independent of catalogUrls.
2. The catalog-crawler's `MAX_CONSECUTIVE_EMPTY_PAGES` tolerance swallows 404s silently.

This is a silent under-coverage bug for the watermark crawler specifically, which uses catalogUrls for HTML walking. Today 4 of 8 starting points yield zero products. Fixing R1's catalogUrls list reclaims watermark coverage for ~9.7k of the 16.6k product inventory.

---

## 6. Final corrections summary

| Field | DB | R1 | R2 verdict | Confidence |
|---|---|---|---|---|
| catalogUrls | 4 dead + 3 right + /shop/ | 7 correct cats | **R1** | HIGH |
| perPage | 100 | 24 | **R1** | HIGH |
| expectedProductCount | 16440 | 16588 | **R1** | HIGH (3 methods agree) |
| productCountMethod | sitemap-index | wp-rest-header | **R1** | MEDIUM-HIGH |
| hasCaptcha | true | false | **R1** | HIGH |
| needsPlaywright | true | false | **R1** (semantic) | MEDIUM (schema ambiguous) |
| sortParam | `?orderby=date&order=desc` | `?orderby=date` | **DB** (defensive equiv) | HIGH |
| /shop/ safety net | yes | no | **R1** for spine; bootstrap API covers gaps | MEDIUM |

R1 wins 5 substantive divergences; DB wins 1 (sortParam defensive form). All findings backed by live evidence captured in this probe.
