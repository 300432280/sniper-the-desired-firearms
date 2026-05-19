# B4R2 Investigation — wolverinesupplies.com

- **Run**: `B4R2-2026-05-15T18-53-24Z`
- **R1 candidate**: `docs/site-audit/wolverinesupplies.com-2026-05-15T18-43-52Z-B4R1.json`
- **R1 diff**: `docs/site-audit/wolverinesupplies.com-2026-05-15T18-43-52Z-B4R1-diff.md`
- **Verdict**: **R1 candidate is correct on all 4 high-risk dimensions. Zero mechanical corrections required. Promote as-is.**

---

## 1. `productCountMethod: "category-walk-dedupe"` (bare string) — runtime switch verdict

**DB value**: `"category-walk-dedupe"` (bare string)
**R1 candidate**: `{ method: "sitemap", url: "https://wolverinesupplies.com/xmlsitemap.php?type=products&page=1" }` (object)
**Verdict**: **R1 is correct. DB bare string is silently broken at runtime.**

**Read**: `backend/src/services/product-count-probe.ts:148-451`

The switch at line 148 is `switch (m.method)`. `m` is the `productCountMethod` field. When `m` is a bare string, `m.method === undefined`, so every `case` mismatches and the code falls through to `default` at line 446-451:

```ts
default: {
  const unknownMethod = (m as any)?.method;
  console.warn(`[productCountProbe] unknown method '${unknownMethod}' - returning null`);
  return null;
}
```

Enumerated cases that DO exist: `wp-rest-header`, `json-api-count`, `json-api-length`, `html-pagination`, `sitemap`, `sitemap-index`, `generic-product-sitemap`, `ecwid-storefront-search`, `shopify-products-walk`, `klevu-api-count`, `stream-page-count`. There is no `category-walk-dedupe` case.

Operational consequence: this site's count probe returns `null` on every invocation - coverage gate has no ground truth. R1's `{method: "sitemap", url: ...}` returns 8173 via the existing `case 'sitemap'` at line 204-210 (counts `<loc>` entries - verified live: page 1 returns the list, page 2 returns 404).

---

## 2. WAF heavy-probe re-verdict

**DB value**: `hasWaf: true, wafType: null`
**R1 candidate**: `hasWaf: false, wafType: "cloudflare-passive"`
**Verdict**: **R1 is correct. Cloudflare is in front, but fully passive.**

### Batches 1-8 results (executed this session)

| Batch | Probe | Status | Body size | Verdict |
|---|---|---|---|---|
| 1 | HEAD `/` | 200 | (headers only) | CF-RAY: 9fc4563a1e7924ee-YYZ, cf-cache-status: DYNAMIC, no cf-mitigated, no challenge cookie |
| 2 | HEAD `/firearms/` | 200 | (headers only) | Same; x-bc-store-id: 1003335859 present |
| 3 | GET `/firearms/?sku=' OR 1=1--` (SQLi) | 200 | 636193 bytes | Full category page rendered. No WAF interstitial. |
| 4 | GET `/?q=<script>alert(1)</script>` (XSS) | 200 | 218243 bytes | Full homepage rendered. |
| 5 | GET `/wp-admin` | 403 | 150 bytes | BC origin default (BC is not WordPress, router 403s unknown paths). NOT a WAF. |
| 6 | GET `/.env` | 403 | 36355 bytes | BC origin default. |
| 7 | GET `/firearms/` with UA=`curl/7.0 bot` | 200 | 622614 bytes | Bot UA not blocked. |
| 8 | GET `/firearms/` with UA=`` | 200 | 635526 bytes | Empty UA not blocked. |

### Body-marker scan (`/firearms/` body)

Searched body for `sucuri`, `wordfence`, `sgcaptcha`, `incapsula`, `malcare`, `sitelock`, `sg-`, `mal_care`, `cloudfront`, `akamai`, `f5`, `imperva`. Zero matches for any WAF/plugin marker. Only legitimate `cdn11.bigcommerce.com/s-bhxpar2unf` strings.

### 30-burst rate-limit probe

30 sequential requests on crawler URL space `/firearms/?page=N&limit=250` cycling pages 1-7 - all returned `200`. No 429, no challenge, no rate-limit.

### Operational impact of current DB value

DB `hasWaf: true` currently routes this site through `waf-cookie-manager` and may drop perPage to 20 - a roughly 5x throughput hit with zero security benefit since the WAF does not actually challenge.

---

## 3. `crawlers.maintain.verifyMethod` - missing field verdict

**DB value**: absent
**R1 candidate**: `"detail-page"`
**Verdict**: **R1 is correct. Without the field, the maintain phase is silently disabled.**

**Read 1**: `backend/src/services/worker.ts:381-400` (`tryStoreApiVerify`)

Line 397: `if (!maintainConfig || maintainConfig.verifyMethod !== 'store-api') return null;` - so `tryStoreApiVerify` only fires when `verifyMethod === 'store-api'`. Any other value (or missing) -> returns `null`, control flows past the store-API fast-path.

**Read 2**: `backend/src/services/worker.ts:759-769` (Playwright fallback)

```ts
} else {
  const { _getSiteCacheEntry: getEntry } = await import('./scraper/adapter-registry');
  const entry = getEntry(domain.replace(/^www\./, ''));
  const verifyMethod = entry?.siteProfile?.crawlers?.maintain?.verifyMethod;
  if (!verifyMethod) {
    console.error(`[VerifyWorker] ${domain}: MISSING verifyMethod in site profile (crawlers.maintain.verifyMethod). Skipping verification.`);
    return;
  }
  // verifyMethod === 'detail-page' - visit each product URL via Playwright
  const pwResult = await verifyProductsViaPlaywright(products, ...);
```

Branches:
- **Missing**: line 764-767 logs error and `return` - maintain phase entirely skipped.
- **Truthy non-`store-api` (incl. `"detail-page"`)**: line 769 fires Playwright detail-page walk. Correct for BC Stencil.

So R1's `"detail-page"` is the operationally correct value. DB's absent field means the worker logs `MISSING verifyMethod` on every maintain tick and verifies nothing.

---

## 4. `bcStoreId: "1003335859"` - live verification

**DB value**: `"1003335859"`
**R1 candidate**: absent (dropped per skill schema)
**Verdict**: DB value verified live. R1's drop is schema-consistent - but the value is operationally real.

### Live evidence

```
$ curl -sI https://wolverinesupplies.com/
HTTP/1.1 200 OK
...
x-bc-store-id: 1003335859
x-bc-is-ha: 1
BC-Ray: 1
CF-RAY: 9fc4563a1e7924ee-YYZ
```

```
$ curl -sI https://wolverinesupplies.com/firearms/
HTTP/1.1 200 OK
...
x-bc-store-id: 1003335859
x-bc-is-ha: 1
BC-Ray: 1
CF-RAY: 9fc456427ed361e9-YYZ
```

Body also contains `cdn11.bigcommerce.com/s-bhxpar2unf` - the BC store hash matching ID 1003335859.

R1 correctly omitted `bcStoreId` because SKILL.md Stage 3 conditional-output table only enumerates `ecwidStoreId` (and `classifiedRules`). This is a real skill gap (R1 diff gap #1). No mechanical correction to the JSON - it is a SKILL.md change request.

---

## 5. perPage=250 sanity check

R1 baked `?limit=250` into `catalogUrls`. Verified live:
- GET `/firearms/` -> 100 `<article class='card` matches (= BC theme default `categorypage_products_per_page: 100`, confirmed in stencilBootstrap blob in HTML)
- GET `/firearms/?limit=250` -> 250 `<article class='card` matches (= requested perPage)

`?limit=N` is honored by BC Stencil. R1's choice of 250 is safe.

---

## 6. Files emitted

- Corrections JSON: `docs/site-audit/wolverinesupplies.com-2026-05-15T18-53-24Z-B4R2-corrections.json` (empty `corrections[]`)
- This investigation: `docs/site-audit/wolverinesupplies.com-2026-05-15T18-53-24Z-B4R2-investigation.md`
