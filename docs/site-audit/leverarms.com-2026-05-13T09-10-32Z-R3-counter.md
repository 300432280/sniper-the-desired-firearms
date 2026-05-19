# R3 Adversarial Counter — leverarms.com

- Run: R3-2026-05-13T09-10-32Z
- Reviewing: `docs/site-audit/leverarms.com-2026-05-13T08-49-54Z-R2-corrections.json`
- Method: live HTTP, broader grep across `backend/src`, runtime code read, 800ms inter-request delay. No DB writes.

## Per-correction adjudication

### 1. `hasWaf = false` — COULDN'T DISPROVE
Re-probed independently: Server: cloudflare, CF-Ray on every response, CF-Cache-Status: HIT, `python-requests/2.28` UA → 200, `/xmlrpc.php` → 403 (origin-side), `/wp-config.php` → 403 with `__cf_bm` cookie set in the same response (CF still passive, just nginx-level deny). No `x-sucuri-*` headers anywhere. R2 correct: Cloudflare passive only, origin-side rule-selective 403 on attack paths is not "WAF blocking the crawler".

### 2. `wafType = cloudflare-passive` — COULDN'T DISPROVE
R1 and R2 agree, re-confirmed.

### 3. `expectedProductCount = 356` — COULDN'T DISPROVE (strong)
Live counts I re-verified:
- `/wp-json/wc/store/v1/products` → `x-wp-total: 356`
- `/wp-json/wc/store/v1/products?stock_status=outofstock` → `x-wp-total: 615`
- `/wp-json/wp/v2/product` → `x-wp-total: 971`
- 356 + 615 = 971 — exact match.

Sampled 16 product `post-XXXX` IDs from `/shop/` HTML page 1; ALL 16 carry `instock` in their `class_list` and ALL 16 resolve via `wc/store/v1/products?include=...`. No "HTML-only" products found in this sample. The 615-product Store API delta is provably out-of-stock products. Using 971 as the denominator for bootstrap coverage would force the crawler to chase 615 catalog-invisible products forever. 356 is the operationally correct denominator.

### 4. `productCountMethod.endpoint = /wp-json/wc/store/v1/products` — COULDN'T DISPROVE
Tied to #3; same evidence supports it.

### 5. `paginationPattern.template = "/page/{N}/"` (leading slash REQUIRED) — COULDN'T DISPROVE (strongest)
Read `backend/src/services/catalog-crawler.ts:118-125`:
```js
if (pattern?.type === 'path') {
  const template = pattern.template || '/page/{N}';
  const stripped = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${stripped}${template.replace('{N}', String(pageNum))}`;
}
```
The trailing `/` IS stripped, then the template is concatenated literally. I dry-ran both shapes with `baseUrl="https://leverarms.com/product-category/guns/"`:
- DB template `page/{N}/` → `https://leverarms.com/product-category/gunspage/2/` → live HTTP **404**.
- R1 template `/page/{N}/` → `https://leverarms.com/product-category/guns/page/2/` → live HTTP **200**.

The DB row is wrong. R2 wins decisively.

### 6. `crawlers.bootstrap.apiEndpoints` shape "fictional / not consumed" — COULDN'T DISPROVE (with caveat)
Broader greps under `backend/src`:
- `apiEndpoints` (plural): 0 matches.
- `productDiscovery`: 0 matches.
- `priceEnrichment`: 0 matches.
- `bootstrap`: matches exist but only in `crawl-scheduler`, `worker`, `health-monitor`, etc., for tier-bootstrap concepts unrelated to a `siteProfile.crawlers.bootstrap.*` key.
- `siteProfile?.crawlers?.bootstrap`: 0 matches.
- For comparison: `siteProfile?.crawlers?.maintain?.verifyMethod` (worker.ts:763) and `siteProfile?.crawlers?.watermark?.method` (watermark-crawler.ts:680) DO exist and ARE read.
- `apiEndpoint` (singular) IS read — but only by iCollector adapter (`scraper.ts:667-673`, `auction-icollector.ts:50,205`). Not WooCommerce.
- `prisma/schema.prisma:193`: `siteProfile Json?` — freeform blob, no schema-level constraint.
- `woocommerce.ts:49,64`: Store API + wp/v2 endpoints are hardcoded; nothing reads them from siteProfile.

Verdict: R2's "fictional cascade" claim is correct. NEITHER the R1 `{products, categories}` shape NOR the DB `{productDiscovery, priceEnrichment}` shape is consumed by runtime. Either is purely documentation. Caveat: this is operator-readable metadata, not load-bearing — calling it "fictional" is fair for the claimed "2-step bootstrap cascade" semantic, but the field itself is harmless either way.

### 7. `crawlers.maintain.*` extras omitted — COULDN'T DISPROVE
Per SKILL.md / `feedback_site_profile_schema.md`, operator-set runtime scheduling. Not a pre-bootstrap target.

### 8. `searchUrl = /?s={keyword}&post_type=product` should be emitted — COULDN'T DISPROVE
Verified live: search URL returns 200. WC adapter `getSearchUrl()` (woocommerce.ts:24-26) hardcodes the exact same pattern. For WC sites this is platform-deterministic; emitting it is harmless and operator-readable.

### 9. `expectedInStockCount` absent — COULDN'T DISPROVE
Not in schema. Stale DB value 357 ≈ current 356 (drift of 1). Safe to omit.

### 10. `crawlers.watermark` `apiEndpoint` + `dateParam` extras — COULDN'T DISPROVE
Confirmed `?after=...` Store API filter works. Extras are non-canonical but harmless. (Note: `watermark-crawler.ts:680` only reads `.method`, so these extras are operator-doc only — same caveat as #6.)

### 11. `topLevelCategories` block kept — COULDN'T DISPROVE
6 categories present at `parent=0`; union covers 356 = global total. Verified via Store API.

### 12. URL canonical `https://leverarms.com` (apex) — COULDN'T DISPROVE
Apex 200; www 301→apex; `<link rel=canonical>` points at apex.

### 13. `needsPlaywright = false` — COULDN'T DISPROVE
Static HTML contains all post-IDs with full class_list; no JS hydration needed.

### 14. Cosmetic title strings — COULDN'T DISPROVE
Trivial.

## REQUIRED verdicts

**`apiEndpoints` "fictional" verdict.** R2 IS correct — not lazy with grep. With broadened patterns (`bootstrap`, `apiEndpoint` singular, `crawlers.\*`, plus `prisma/schema.prisma`) the answer is unchanged: zero runtime consumers of `siteProfile.crawlers.bootstrap.apiEndpoints`. Compare to verified live readers `siteProfile.crawlers.maintain.verifyMethod` and `siteProfile.crawlers.watermark.method` which DO appear in code. The field is operator-doc only; calling the "2-step cascade" claim fictional is accurate.

**`paginationPattern.template` simulation verdict.** R2 IS correct. Dry-ran the exact `buildPaginatedUrl` logic at `catalog-crawler.ts:121-125` with both templates against `https://leverarms.com/product-category/guns/`. DB shape produced a malformed URL that returns 404 live; R1 shape produced the canonical URL that returns 200 live. The leading slash is required by the runtime.

**`/shop` HTML vs Store API delta verdict.** Sampled 16 product IDs from `/shop/` page 1. ALL 16 are marked `instock` in their HTML class_list; ALL 16 are returned by Store API `?include=...`. Zero HTML-only products in this sample. Combined with the math (`instock 356 + outofstock 615 = total 971`), the failure mode that hit ISS (products shown on category HTML but missing from Store API) is NOT present on leverarms.com. R2's recommendation of Store API as the coverage denominator is safe here.

## Summary
- Corrections attempted: 14
- Countered: 0
- Survived: 14 (12 high-confidence, 2 medium)
- Strongest survivors: paginationPattern (live HTTP + code dry-run dispositive); expectedProductCount=356 (math + class_list sample); apiEndpoints field-shape (broad grep confirms zero runtime consumers).

R2 holds. The only nuance I'd add: even the "fictional" field is harmless residue — R1's flatter shape is fine, but the DB's shape doesn't actively break anything either. R2's call to canonicalize on R1's naming is preference, not correctness.
