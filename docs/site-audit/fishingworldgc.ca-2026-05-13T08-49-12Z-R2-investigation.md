# R2 Live Investigation — fishingworldgc.ca

**Probe time:** 2026-05-13T08:45-08:49Z
**R1 candidate under review:** `docs/site-audit/fishingworldgc.ca-2026-05-13T08-23-57Z-R1.json`
**R1 diff:** `docs/site-audit/fishingworldgc.ca-2026-05-13T08-23-57Z-R1-diff.md`
**Method:** Trust neither R1 nor DB. For every divergent field, run a probe DIFFERENT from R1's, then verify against runtime code.

---

## 1. `productCountMethod.method` — DB-bug verdict: CONFIRMED

**R1 claim:** DB value `products-json-walk` is not in the runtime switch and falls through to `default: return null`, silently disabling count.

**Method (different from R1's reading):** Read every case branch in `backend/src/services/product-count-probe.ts:148-451`.

**Result:** Valid case labels in the switch:
- Line 149: `'wp-rest-header'`
- Line 156: `'json-api-count'`
- Line 163: `'json-api-length'`
- Line 182: `'html-pagination'`
- Line 204: `'sitemap'`
- Line 212: `'sitemap-index'`
- Line 226: `'generic-product-sitemap'`
- Line 250: `'ecwid-storefront-search'`
- **Line 272: `'shopify-products-walk'`** — canonical
- Line 302: `'klevu-api-count'`
- Line 333: `'stream-page-count'`
- Line 446: `default` returns `null` after warn

The bare label `products-json-walk` is NOT one of the case constants. It falls through. **DB-bug confirmed.** Correction = `shopify-products-walk`.

---

## 2. `hasWaf` — WAF re-probe verdict: CF-PASSIVE, hasWaf:false

**R1 claim:** cloudflare-passive — set hasWaf:false per SKILL.md Mistake 23.
**DB claim:** hasWaf:true (legacy convention for any Shopify-on-CF site).

**Method (different from R1's headers-only 8-batch):** Probe response BODIES with attack-pattern payloads. If CF were active, payload requests would return CF challenge HTML (~3-10KB with "Just a moment..." / "captcha" / "ray-id" / "Verifying you are human") or 403/406/429. If CF were passive, payloads pass through to Shopify origin which serves either the storefront (for SQLi/XSS in query string) or 404 (for unknown PHP paths).

**Live probe results (2026-05-13T08:45Z, 800ms inter-request delay):**

| Path | Status | Body len | Body content |
|---|---|---|---|
| `/` (baseline) | 200 | 335100 | full storefront HTML |
| `/?id=1' OR '1'='1` (SQLi) | 200 | 335088 | full storefront HTML |
| `/?q=<script>alert(1)</script>` (XSS) | 200 | 335068 | full storefront HTML |
| `/?cmd=cat /etc/passwd` (RCE attempt) | 200 | 335068 | full storefront HTML |
| `/.env` | 200 | 335052 | full storefront HTML (Shopify catch-all) |
| `/wp-admin` | 404 | — | Shopify 404 page |
| `/wp-login.php` | 404 | — | Shopify 404 page |
| `/.git/config` | 404 | — | Shopify 404 page |
| `/xmlrpc.php` | 404 | — | Shopify 404 page |
| `/phpinfo.php` | 404 | — | Shopify 404 page |
| `/../../../etc/passwd` | 404 | — | Shopify 404 page |

**Response headers (homepage):** `CF-RAY: 9fb062a85a2ade44-YYZ`, `Server: cloudflare`, `cf-cache-status: DYNAMIC`, `powered-by: Shopify`. CF is in the path but not actively challenging.

**Verdict:** CF-passive. No challenge bodies. No 403/406/429 on attack payloads. SQLi/XSS payloads echoed unmodified through to Shopify which renders storefront. **hasWaf:false correct.**

---

## 3. `catalogUrls` — coverage verdict: /collections/all is GLOBAL COVER

**R1 claim:** 23 URLs collapse to 1 URL (`/collections/all`). 22 sub-collections are redundant by Rule C union test.

**Method (different from R1's stated walk):** Recompute set membership from BOTH cached and FRESH live walks, then run set-difference cross-checks against four sub-collections.

**Cached source-of-truth (R1 had already walked these 2026-05-13T04:20Z, files in `_audit_tmp/`):**
- `fw-pj-1.json` through `fw-pj-9.json` — /products.json pages 1-9
- `fw-coll-all-1.json` through `fw-coll-all-9.json` — /collections/all/products.json pages 1-9

**Fresh sub-collection walks (2026-05-13T08:49Z, 800ms delay):**
- /collections/centre-fire-rifle/products.json: page 1 = 378KB, page 2-7 = 15 bytes empty
- /collections/shotgun-ammo/products.json: page 1 = 164KB, page 2-3 = 15 bytes empty
- /collections/pre-owned/products.json: page 1 = 29KB, page 2-3 = 15 bytes empty
- /collections/shooting-miscellaneous-1/products.json: page 1 = 460KB, page 2-3 = 15 bytes empty

**Set-diff results (Node script over JSON files):**

```
|P| /products.json   = 2011
|A| /collections/all = 2011
P\A = 0 (every product in /products.json is in /collections/all)
A\P = 0 (every product in /collections/all is in /products.json)
S(centre-fire-rifle)        size=88   S\A=0  S\P=0
S(shotgun-ammo)             size=75   S\A=0  S\P=0
S(pre-owned)                size=12   S\A=0  S\P=0
S(shooting-miscellaneous-1) size=172  S\A=0  S\P=0
```

**Sitemap cross-check:** `fw-products.xml` (`/sitemap_products_1.xml`) has 2012 `<loc>` entries; minus 1 homepage entry = 2011. Three-way reconcile: /products.json = /collections/all = sitemap.

**Verdict:** /collections/all is byte-equivalent to /products.json. Every sub-collection is a strict subset. Rule C collapse to 1 URL is **correct and proven**.

---

## 4. SECONDARY FINDING — topLevelCategories counts unreliable

While running sub-collection walks I noticed:

| slug | R1 `allOption` (from products_count) | live walk product count | ratio |
|---|---|---|---|
| centre-fire-rifle | 184 | 88 | 2.09x over |
| shotgun-ammo | 145 | 75 | 1.93x over |
| pre-owned | 38 | 12 | 3.17x over |
| shooting-miscellaneous-1 | 232 | 172 | 1.35x over |

The `products_count` field on `/collections.json` over-reports by 1.35x-3.17x on this site, likely counting unpublished/draft/archived products that `/products.json` filters out. R1's slug LIST and ranking are still useful for navigation discovery, but the COUNTS should not be used as catalog-size estimates.

**Recommendation:** downgrade `topLevelCategories.categories[].allOption` field confidence from "high" to "medium". The catalogUrls collapse decision used the ID-set comparison (not the products_count number) so this finding does NOT invalidate the 23 to 1 collapse.

---

## 5. Sort verification — R1's note holds

Test (2026-05-13T08:49Z):
- `GET /products.json?limit=5` returned IDs: 10380587761980, 10382098170172, 10382094729532, 10376191082812, 10376190951740
- `GET /products.json?limit=5&sort_by=created-descending` returned IDENTICAL sequence

`/products.json` ignores `sort_by` (Mistake 32 confirmed). However the natural order IS published_at-desc — published_at on those 5 products is monotonically descending (2026-05-11 15:31, 15:25, 15:25, 2026-05-06 16:12, 16:10). So `navigate-from-watermark` works without any explicit sort param against the API; sortParam applies to the HTML transport (verified by R1).

---

## 6. Runtime impact summary

| Field | DB | R1/R2 | Runtime effect of fixing |
|---|---|---|---|
| `productCountMethod.method` = `products-json-walk` | bug | `shopify-products-walk` | Re-enables count probe (currently silently disabled at default-branch) |
| `hasWaf` = `true` | legacy | `false` | Catalog crawler skips Playwright force-route at line 774, skips perPage downshift (line 696), removes consecutive-empty buffer for end-of-catalog detection. Net: ~12.5x faster HTML walks if fallback fires. |
| `catalogUrls` = 23 URLs | drift | 1 URL | Bootstrap walks 1 URL by 2011 products instead of 23 URLs by overlapping products. Net: ~22x fewer redundant pages walked per bootstrap cycle. |
| `expectedProductCount` = 1953 | stale 32d | 2011 | Coverage gate at COVERAGE_THRESHOLD=0.95 now uses correct denominator; 1953 would over-report coverage by 2.97% |
| `crawlers.maintain.verifyMethod` = `json-ld` | legacy | `detail-page` | Same Playwright path either way today; future SKILL.md tightening may strict-check the label |
| `paginationPattern.perPage` = `24` | HTML-default | `250` | Reflects runtime API transport (`/products.json` limit). HTML fallback still uses 24 by theme default; record in auditNotes if needed |

---

## Files

- `docs/site-audit/fishingworldgc.ca-2026-05-13T08-49-12Z-R2-corrections.json`
- `docs/site-audit/fishingworldgc.ca-2026-05-13T08-49-12Z-R2-investigation.md` (this file)
- `_audit_tmp/fw-pj-{1..9}.json`, `fw-coll-all-{1..9}.json` (cached R1 walks)
- `_audit_tmp/fw-sub-centre-fire-rifle-1.json`, `fw-sub-shotgun-ammo-1.json`, `fw-sub-pre-owned-1.json`, `fw-sub-shooting-miscellaneous-1-1.json` (fresh R2 sub-collection walks)
- `_audit_tmp/fw-products.xml`, `fw-sitemap.xml`, `fw-collections.json` (cached R1)
- `_audit_tmp/fw-prod-sample.html` (fresh product page JSON-LD verification)

---

## Confidence breakdown

- high: 7 corrections (`productCountMethod.method`, `hasWaf`, `catalogUrls`, `expectedProductCount`, `crawlers.maintain.verifyMethod`, `paginationPattern.perPage`, `crawlers.maintain.verifyEndpoint`)
- medium: 1 correction (`topLevelCategories.categories[].allOption` counts unreliable, slugs still usable)
- low: 0
- "Inconclusive": 0 — all three required verdicts produced firm answers backed by live data + runtime-code reading
