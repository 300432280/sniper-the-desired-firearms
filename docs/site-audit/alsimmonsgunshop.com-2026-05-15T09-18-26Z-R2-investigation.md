# Pre-Bootstrap R2 Live Investigation — alsimmonsgunshop.com

**Run:** R2 live investigation, 2026-05-15T09-18-26Z
**R1 candidate:** `docs/site-audit/alsimmonsgunshop.com-2026-05-15T08-54-56Z-R1.json`
**R1 diff:** `docs/site-audit/alsimmonsgunshop.com-2026-05-15T08-54-56Z-R1-diff.md`
**Corrections:** `docs/site-audit/alsimmonsgunshop.com-2026-05-15T09-18-26Z-R2-corrections.json`

## Mandate

R2 is a fresh investigation, using a DIFFERENT method per divergent high-risk field from R1. Trust neither candidate nor DB. Three site-specific high-risk fields were flagged for fresh verification:

1. `productCountMethod.method = 'dual-api'` — is this in the runtime switch?
2. `expectedProductCount`: 160 (R1) vs 1638 (DB) — which matches what the crawler walks?
3. `hasWaf=true + wafType=cloudflare-passive` — internal contradiction. Real WAF or not?

## Method 1 — `dual-api` deep grep + switch read

Different from R1 (R1 did a quick check; R2 reads the full switch + greps both `backend/src` and entire `backend/`).

Read `backend/src/services/product-count-probe.ts:140-451` end-to-end. Switch handles exactly 11 methods:
`wp-rest-header`, `json-api-count`, `json-api-length`, `html-pagination`, `sitemap`, `sitemap-index`, `generic-product-sitemap`, `ecwid-storefront-search`, `shopify-products-walk`, `klevu-api-count`, `stream-page-count`.

Anything else falls through to `default:` (lines 446-451):
```ts
const unknownMethod = (m as any)?.method;
console.warn(`[productCountProbe] unknown method '${unknownMethod}' — returning null`);
return null;
```

Grep results across the entire backend tree:
- `Grep dual-api in backend/src/` -> 0 matches
- `Grep dual-api in backend/` -> 0 files

**Verdict:** `dual-api` is dead config in the DB. It silently disables the product count probe (warns + returns null). R1's `wp-rest-header` is the canonical runtime value and is correct.

## Method 2 — admin-vs-storefront delta classification (FRESH method, NOT R1's)

R1 simply noted "1662 admin includes drafts/private". R2 actually classified the delta with independent probes.

**Probe A: Store API stock-filter arithmetic**
```
/wp-json/wc/store/v1/products?per_page=1&stock_status=instock      -> X-WP-Total: 160
/wp-json/wc/store/v1/products?per_page=1&stock_status=outofstock   -> X-WP-Total: 1502
/wp-json/wc/store/v1/products?per_page=1&stock_status=onbackorder  -> X-WP-Total:   0
                                                            sum: 1662
/wp-json/wp/v2/product?per_page=1                          -> X-WP-Total: 1662
```
Exact match. The 1662 admin total = `instock + outofstock + onbackorder`. There are no drafts/private in the admin-REST default response — it returns all `status=publish` posts of `post_type=product` regardless of stock status. (Confirmed by sampling 15 products; all are `status=publish`.)

**Probe B: visit 7 admin-only product slugs**
Fetched wp/v2/product pages 1, 50, 100; cross-referenced IDs against the 160 storefront IDs. Picked the 7 admin-only IDs and visited their permalinks with chrome UA:

| Slug | HTTP | Schema availability | "consign" markers | "out of stock" markers |
|---|---|---|---|---|
| henry-h2-u-s-survival-rifle-22lr-unfired | 200 | OutOfStock | 3 | 2 |
| winchester-sxp-field-12ga-14014n | 200 | OutOfStock | 3 | 2 |
| marlin-model-60ss-22lr-14010nc | 200 | OutOfStock | 9 | 2 |
| marlin-model-795-22lr-14009nc | 200 | OutOfStock | 10 | 2 |
| hatsan-55cr-air-rifle-177cal-13733nc | 200 | OutOfStock | 9 | 2 |
| chiappa-double-badger-22lr-20ga-14008nc | 200 | OutOfStock | 9 | 2 |
| smithwesson-sd9-sd9ve-9mm-magazine-199280000-copy | 200 | OutOfStock | 0 | 2 |

7/7 are `<meta itemprop="availability" content="https://schema.org/OutOfStock">`. None are drafts. None are private. They are **status=publish WooCommerce products with `_stock_status=outofstock`** — sold-out historical records (mostly tagged with "consign"/consignment) kept for record-keeping. The site has WC's `hide_out_of_stock_items` option enabled, so Store API + the public `/shop/` archive both filter them out.

**Verdict:**
- The 160 figure = customer-visible catalog (what `/shop/` walks and what Store API returns by default) -> correct `expectedProductCount` because that is what the crawler indexes.
- The 1662 figure = customer-visible 160 + 1502 historical sold OOS records. The DB's 1638 is a stale snapshot of the same admin total from 2026-04-11 (drift = +24 in 34 days).
- Using 1638 in DB causes a permanent ~10x under-coverage signal because the crawler will always see ~160 and the system will think 1500 products are "missing".

R1's 160 is correct.

## Method 3 — fresh heavy 8-batch WAF probe + body scans (different evidence shape from R1)

R1 used the heavy probe but stored evidence as a single string. R2 ran a fresh probe with structured per-batch capture and scanned bodies for WAF plugin markers.

| Batch | UA / type | URL | Status | Bytes | Notes |
|---|---|---|---|---|---|
| 1 | chrome | /shop/ | 200 | 211009 | cf-ray, server=cloudflare, no body markers |
| 2 | empty | /shop/ | 200 | 211009 | passes |
| 3 | python-requests/2.31.0 | /shop/ | **403** | 146 | bot UA blocked (CF bot fight default) |
| 4 | curl/8.0.1 | /shop/ | 200 | full | raw curl passes; only python-style UA blocked |
| 5 | chrome | `/?s=test' OR '1'='1&post_type=product` | 200 | 154682 | SQLi payload NOT blocked |
| 6 | chrome | `/?s=<script>alert(1)</script>` | 200 | 154237 | XSS payload NOT blocked |
| 7 | chrome | /shop/page/1..10/ rapid burst | 9x 200, 1x 301 | — | no rate limiting visible |
| 8 | chrome | wp-admin/wp-login.php/xmlrpc.php | 302/403/403 | — | WP-standard login lockdown, not Cloudflare WAF |

Body marker scan on /shop/ body (211 KB):
```
grep -iE "(sucuri|wordfence|malcare|incapsula|sgcaptcha|akamai|cf-chl|recaptcha|hcaptcha)" body
-> no matches
```

**Re-verdict:** Cloudflare in front (cf-ray on every response, server=cloudflare) but no active challenge, no plugin WAF body markers, real-browser UA + SQLi + XSS + 10x rapid burst all return 200. Only `python-requests` UA + WP login paths get 403. This is the textbook **cloudflare-passive** pattern.

Per SKILL.md Stage 2: when CF is in front but inert, `hasWaf` is operationally `false` (so the crawler stays on the fast WC Store API path); `wafType` records the platform classification. The DB row has `hasWaf=true + wafType=cloudflare-passive` — these contradict each other within the same row and would force every crawl onto the slow Playwright cookie-managed path for zero gain.

R1's `hasWaf=false + wafType=cloudflare-passive` is correct.

## Cross-cutting note: stockStatus in extractionSample

R1 reports `stockStatus="in_stock"` for all 3 spot-check samples; storefront API confirms all 160 returned products have `is_in_stock=true`. The `expectedInStockCount=168` in DB is stale (from 2026-04-11). Not a divergent field in the R1 diff but worth noting for context: the 160 customer-visible inventory is fully in-stock today.

## Final tally

- R1 corrections needed: **0**
- All 3 high-risk divergent fields: R1 correct, DB wrong.
- Recommended DB fixes (operator review):
  1. `expectedProductCount`: 1638 -> 160
  2. `productCountMethod.method`: 'dual-api' -> 'wp-rest-header'
  3. `hasWaf`: true -> false (resolves intra-row contradiction with `wafType=cloudflare-passive`)
