# R3 Counter — alsimmonsgunshop.com (second pass)

- Audited: 2026-05-15T12:54:18Z
- Auditor: engineering-code-reviewer (fresh skeptic, second R3 pass on R2)
- R2 reference: `docs/site-audit/alsimmonsgunshop.com-2026-05-15T09-18-26Z-R2-corrections.json`
- Prior R3 reference (2026-05-13): `docs/site-audit/alsimmonsgunshop.com-2026-05-13T09-07-20Z-R3-counter.md`
- Mission: attack R2's 3 highest-risk fields + audit prior R3's narrative caveats. NO DB writes. 800ms delay.

## Outcome table

| Round target | Counter attempted | Verdict |
|---|---|---|
| R2: instock 160 + outofstock 1502 + onbackorder 0 = 1662 | paginated walk by stock_status | **SURVIVES** (160+1502+0 walked-unique = 1662) |
| R2: `dual-api` is dead config | re-grep entire backend tree, read switch | **SURVIVES** (0 matches, default arm returns null) |
| R2: hasWaf=false | 60-burst rapid-fire at 800ms | **SURVIVES** (60/60 = 200, no challenge, no degradation) |
| Prior R3: "4 of 10 admin-only IDs are in Store API" narrative | re-sample pages 3/7/13 with stock_status filter | **OVERTURNED stronger**: 10 of 10 are in Store API |

## 1. 1662 arithmetic — REQUIRED re-verification — SURVIVES

Independent paginated walk against `https://alsimmonsgunshop.com/wp-json/wc/store/v1/products?per_page=100&stock_status={X}&page=N`, 800ms inter-request:

```
instock      : pages 1-2, returned 100+60, TOTAL walked=160  unique=160  (X-WP-Total said 160)
outofstock   : pages 1-16, returned 100x15+2, TOTAL walked=1502  unique=1502  (X-WP-Total said 1502)
onbackorder  : page 1 returned 0, X-WP-Total=0
SUM_HEADERS=1662  SUM_WALKED_UNIQUE=1662  Overlap(in,out)=0
Default Store API (no filter) X-WP-Total = 160
Admin wp/v2/product X-WP-Total = 1662
```

Arithmetic holds exactly. Walked-unique matches headers byte-for-byte; zero overlap between the in-stock and outofstock id sets; sum equals admin wp/v2 total.

Important refinement of R2's narrative: R2 framed the 1502 OOS as "Store API + /shop/ filter them out". The walk shows they ARE in the Store API namespace; they only disappear from the default Store API view (which honours `hide_out_of_stock_items`). Explicit `stock_status=outofstock` retrieves them. The operational `expectedProductCount=160` is still correct because the catalog crawler uses the default Store API and `/shop/`, not the explicit filter.

Evidence: `_audit_tmp/alsimmons_R3_2026-05-15/walk-by-stock.js`

## 2. `dual-api` deep-grep — SURVIVES

```
grep -i "dual.api|dualApi|dual_api"  backend/             -> 0 matches
grep -i "dual"                       backend/src/         -> 6 unrelated hits (multi-word, individual, etc.)
```

product-count-probe.ts switch arms re-enumerated by line number:

```
149  case 'wp-rest-header'
156  case 'json-api-count'
163  case 'json-api-length'
182  case 'html-pagination'
204  case 'sitemap'
212  case 'sitemap-index'
226  case 'generic-product-sitemap'
250  case 'ecwid-storefront-search'
272  case 'shopify-products-walk'
302  case 'klevu-api-count'
333  case 'stream-page-count'
446  default: console.warn(`unknown method '${unknownMethod}'`); return null;
```

`dual-api` lands at the default arm. R2 SURVIVES.

## 3. 10-product admin-only re-sample — REQUIRED — OVERTURNS PRIOR R3 NARRATIVE STRONGER

Sampled 10 wp/v2 admin-REST slugs from pages 3, 7, 13 (different from prior R3's 50/100/150 and from R2's page-10). For each: queried Store API with explicit `stock_status=instock` and `stock_status=outofstock` slug lookup, plus fetched the storefront page and scanned for schema.org availability.

| slug | wp/v2 page | Store API in-stock hit | Store API OOS hit | Page schema.org |
|---|---|---|---|---|
| lee-enfield-no-4-mk-i-303brit-14249nc | 7 | no | yes | OutOfStock |
| fn-herstal-sa-22-22lr-14181nc | 13 | yes | no | InStock |
| henry-mares-leg-357mag-14263n | 7 | no | yes | OutOfStock |
| boito-a-680-12ga-14261nc | 7 | no | yes | OutOfStock |
| remington-870-20ga-14319nc | 3 | no | yes | OutOfStock |
| browning-bar-mk-iii-243win-14262n | 7 | yes | no | InStock |
| remington-870-fieldmaster-20ga-14171n | 13 | no | yes | OutOfStock |
| simonov-sks-7-62x39mm-14183nc | 13 | no | yes | OutOfStock |
| fn-herstal-sa-22-grade-2-22lr-14179nc | 13 | yes | no | InStock |
| remington-812-410ga-14322n | 3 | yes | no | InStock |

Tally: 10/10 retrievable via Store API. 4 are in-stock and visible in the default Store API; 6 are OOS and visible only when `stock_status=outofstock` is passed explicitly. 0 are "truly admin-only".

This OVERTURNS the prior R3 narrative ("structural conclusion survives, narrative overstated") even more sharply — and also OVERTURNS R2's own framing of the 1502 as a "consignment-hidden" set unreachable from the customer Store API. The 1502 are reachable; they're just filtered from the default Store API view by `hide_out_of_stock_items`. Every product page returned HTTP 200 with valid schema.org and the word "consign" in the body — but inspection shows "consign" appears in every page's static theme footer/sidebar, so consignment markers were never per-product evidence to begin with.

Operational impact on R2's numbers: NONE. R1/R2's `expectedProductCount=160` mirrors the customer-visible default Store API + /shop/ walk. The runtime crawler does not pass `stock_status=outofstock`, so it would always see 160. R2's correction value survives even though the narrative around it ("admin-only", "consignment-hidden") is wrong.

Evidence: `_audit_tmp/alsimmons_R3_2026-05-15/admin-only-resample.js`

## 4. WAF 60-burst — SURVIVES

60 sequential GETs to `https://alsimmonsgunshop.com/shop/?nocache=N`, 800ms delay, browser UA.

```
statuses = {"200": 60}
median_dt = 891ms
first10_avg = 965ms
last10_avg = 875ms   (faster at the end — no degradation)
anyChallenge = false (no cf-mitigated, no cf-chl, no challenge-platform marker in body)
any429or503 = false
```

No throttling at 2x the prior R3 burst length. `hasWaf:false` SURVIVES.

Evidence: `_audit_tmp/alsimmons_R3_2026-05-15/waf-60-burst.js`

## Strongest counter-claims (3)

1. Prior R3's "4/10 in Store API" narrative was conservative. Re-sample at fresh page ranges with explicit stock_status filter shows 10/10 retrievable. Prior R3 only checked `slug=X` without stock filter, so the 6 OOS hits returned 0 there even though they exist. This is a methodology gap in prior R3 — but the operational `expectedProductCount=160` it confirmed is still correct.
2. R2's "consignment-hidden" framing is wrong about the mechanism. The 1502 OOS aren't hidden by consignment status — every page body has the same "consign" footer, including in-stock items. They're hidden by WooCommerce's `hide_out_of_stock_items` site option, which filters the default Store API view. They remain retrievable when the filter is overridden. The numeric correction is still right.
3. `hide_out_of_stock_items` discovery is worth recording. A future SKILL.md note: for WC sites with large admin/storefront product-count gaps, test `?stock_status=outofstock` on Store API before concluding any product is "truly admin-only". On this site 0% of the wp/v2 universe is genuinely admin-only.

## Couldn't disprove

- R1/R2 `expectedProductCount=160`
- R1/R2 `productCountMethod.method='wp-rest-header'`
- R1/R2 `hasWaf=false` / `wafType=cloudflare-passive`
- Prior R3's structural conclusion that `/shop/` 18-page walk = 160 unique slugs = Store API default total

## Files written

- `_audit_tmp/alsimmons_R3_2026-05-15/walk-by-stock.js`
- `_audit_tmp/alsimmons_R3_2026-05-15/admin-only-resample.js`
- `_audit_tmp/alsimmons_R3_2026-05-15/waf-60-burst.js`
- `docs/site-audit/alsimmonsgunshop.com-2026-05-15T12-54-18Z-R3-counter.md` (this file)
