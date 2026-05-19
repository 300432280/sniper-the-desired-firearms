# Live Investigation — doctordeals.ca (Batch 4 / Round 2)

- Run: `B4R2-2026-05-15T18-58-33Z`
- Based on: `docs/site-audit/doctordeals.ca-2026-05-15T18-42-44Z-B4R1.json`
- Probe scripts: `_audit_tmp/doctordeals-b4r2-probe.js`, `_audit_tmp/doctordeals-b4r2-probe2.js`
- Method: Playwright iPhone 13 + iOS 17.2 Safari UA; sgcaptcha cleared by apex GET cookie cache (~30 min validity).

## Mission

Resolve three site-specific high-risk fields where R1 candidate disagrees with DB siteProfile:

1. catalogUrls URL form — DB uses `/product-category/gun-shop/<slug>/` alias; candidate uses `/product-category/<slug>/` canonical.
2. `mags-barrels` top-level category presence — DB notes claim magazines are children of accessories; candidate places `mags-barrels` at parent=0.
3. `perPage=20` honored or dead config — DB declares 20; candidate observed 12 with no exposed override.

---

## Finding 1 — alias-vs-canonical URL form

VERDICT: **canonical form wins. Both forms serve the same content, but canonical is authoritative.**

Evidence:

| Slug | DB alias status | DB alias canonical link | Candidate canonical status | Candidate canonical link |
|---|---|---|---|---|
| firearms | 200 | `https://doctordeals.ca/product-category/firearms/` | 200 | `https://doctordeals.ca/product-category/firearms/` |
| parts | 200 | `https://doctordeals.ca/product-category/parts/` | 200 | `https://doctordeals.ca/product-category/parts/` |
| accessories | 200 | `https://doctordeals.ca/product-category/accessories/` | 200 | `https://doctordeals.ca/product-category/accessories/` |

Both forms return 200 + identical 12-product card sets. The alias does NOT 301-redirect to canonical; WordPress serves both URLs from the same handler. BUT every `<link rel="canonical">` on the alias page points back at the canonical (no `gun-shop` segment), and the WP `wp/v2/product_cat` API's `link` field for each term is the canonical form. The `gun-shop` segment in DB URLs is a permalink rewrite alias only — it has no underlying taxonomy term.

Direct query for `gun-shop` term:

```
GET /wp-json/wp/v2/product_cat?slug=gun-shop   -> empty result (no match)
GET /product-category/gun-shop/                -> HTTP 202 (sgcaptcha challenge) + 0 product cards + null canonical
```

Recommendation: switch the DB catalogUrls to canonical form. No functional regression (alias still works), but canonical aligns with SEO + taxonomy API + the runtime fetcher's preferred form.

---

## Finding 2 — `mags-barrels` top-level category

VERDICT: **`mags-barrels` IS a top-level taxonomy term with 109 products. DB notes are wrong.**

Live taxonomy enumeration (`/wp-json/wp/v2/product_cat?parent=0&per_page=100&hide_empty=false`):

| id | slug | name | count | parent |
|---|---|---|---|---|
| 199 | accessories | Accessories | 263 | 0 |
| 3680 | clothing-gun-related | Almost Free Clothing | 44 | 0 |
| 215 | defense | Defense | 1 | 0 |
| 60 | firearms | Firearms | 109 | 0 |
| **6294** | **mags-barrels** | **Mags & Barrels** | **109** | **0** |
| 239 | parts | Parts | 389 | 0 |
| 1784 | uncategorized | Uncategorized | 0 | 0 |

Direct slug lookup (`/wp-json/wp/v2/product_cat?slug=mags-barrels`):

```
[{ id:6294, count:109, parent:0, link:"https://doctordeals.ca/product-category/mags-barrels/" }]
```

Live category page:

```
GET /product-category/mags-barrels/    -> HTTP 200
canonical: https://doctordeals.ca/product-category/mags-barrels/
.product-small.box cards: 12
.woocommerce-result-count: "Showing 1-12 of 109 results"
```

The DB notes' claim that magazines are children of `accessories` is contradicted by accessories.id=199 having count=263 (a SEPARATE count from mags-barrels's 109). The two are sibling top-level terms. The current DB 5-URL catalogUrls set leaves all 109 mags-barrels products uncovered by HTML stream fallback — a Mistake 12 violation (drop-category-because-small) made worse by the fact that 109 is not small (11.2% of inventory).

Recommendation: add `/product-category/mags-barrels/` to catalogUrls. Update DB notes to remove the wrong magazines-under-accessories claim.

---

## Finding 3 — `perPage` override probe

VERDICT: **perPage is server-locked to 12. No URL param overrides it. DB value 20 is dead config.**

8 override variants tested on `/shop/`:

| Variant | URL | HTTP | `.product-small.box` count |
|---|---|---|---|
| plain | `/shop/` | 200 | 12 |
| WC native | `/shop/?per_page=20` | 200 | 12 |
| WC native | `/shop/?per_page=50` | 200 | 12 |
| WP query | `/shop/?posts_per_page=20` | 200 | 12 |
| Flatsome | `/shop/?count=20` | 200 | 12 |
| Flatsome | `/shop/?show=20` | 200 | 12 |
| Flatsome | `/shop/?show=24` | 200 | 12 |
| Flatsome | `/shop/?show=all` | 200 | 12 |

Markup inspection of `.woocommerce-ordering` form:

```html
<select name="orderby" class="orderby" aria-label="Shop order">
  <option value="popularity">Sort by popularity</option>
  <option value="date" selected="selected">Sort by latest</option>
  <option value="price">Sort by price: low to high</option>
  <option value="price-desc">Sort by price: high to low</option>
</select>
<input type="hidden" name="paged" value="1">
```

No `<select name="show">`, no `.show-select`, no perPage `<select>` of any kind. The Flatsome theme's "Shop catalog products per page" setting (Appearance > Customize > Shop > Product Catalog) is server-locked to 12. This is consistent with the category-page pagination text ("Showing 1-12 of 109 results").

Recommendation: update DB perPage from 20 to 12. Path pagination at `/shop/page/N/` with stride=12 is the only correct walker config.

---

## Other corrections carried from B4R1 diff

These were already established in B4R1 diff; no new investigation needed:

- `expectedProductCount`: 965 -> 971 (stale by 39 days, +6 products).
- `paginationPattern`: add discriminated-union object (`{type:'path', template:'/shop/page/{N}/', perPage:12, ...}`).
- `crawlers.maintain.verifyMethod`: `json-ld` -> `store-api` (platform=woocommerce + Store API works).
- `crawlers.maintain.verifyEndpoint`: add `/wp-json/wc/store/v1/products` (companion to above).

---

## Confidence summary

7 corrections, all HIGH confidence. The three high-risk site-specific fields (catalogUrl form, mags-barrels presence, perPage) were each verified by independent multi-evidence checks against the live site (sgcaptcha bypassed, WP REST + WC Store API + DOM both queried). No "inconclusive" verdicts.

Operator can promote the candidate B4R1 JSON with confidence on these three fields. The candidate's remaining content (platform, WAF, sortParam, watermark method, expected count via WP REST + sitemap dual signal) was already verified by counter-control probes in R1 and is consistent with this round's findings.
