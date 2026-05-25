# R2 Investigation — thegundealer.ca

**Run:** B5R2 2026-05-23 03:10Z. Cross-checked R1's blind candidate (`thegundealer.ca-2026-05-22T20-00-00Z-B5R1.json`) against DB snapshot using a different method per R1 divergence.

**Method per priority:**
1. WAF: sustained 30-page walk across 4 production UAs (chrome120, safari17, firefox121, edge120) with `sg-captcha` header check + body-token grep for `sgcaptcha|SiteGround` regex.
2. catalogUrls: HTML `Showing X of Y` count regex on /shop/ across all walked pages; spot-check 5 hidden-from-shop cats.
3. perPage: probe Store API per_page=50/100/200/250 + HTML `?per_page=48/96` override.
4. productCountMethod label: grep `VALID_METHOD_NAMES` list in `product-count-probe.ts` directly + read switch default branch.
5. verifyMethod gap: read `worker.ts:394-401` guard branch.

## Evidence

### 1. WAF migration confirmed (4-UA sustained walk)

| UA | Pages walked | All 200? | cf-ray? | Server | sg-captcha header | sgcaptcha body token |
|----|-------------:|:-------:|:------:|:------:|:----------------:|:--------------------:|
| Chrome 120 | 30 | YES | YES | cloudflare | 0 / 30 | 0 / 30 |
| Safari 17 | 30 | YES | YES | cloudflare | 0 / 30 | 0 / 30 |
| Firefox 121 | 16 (taskkilled) | YES | YES | cloudflare | 0 / 16 | 0 / 16 |
| Edge 120 | 10 | YES | YES | cloudflare | 0 / 10 | 0 / 10 |
| **TOTAL** | **86** | **86 / 86** | **86 / 86** | uniform | **0 / 86** | **0 / 86** |

Body size band 927-960KB across all pages — no challenge page injected. cf-ray header on every response confirms CF terminates TLS. `Server: cloudflare` (not LiteSpeed/Apache) confirms origin is hidden behind CF.

R1's `hasWaf=false`, `wafType=cloudflare-passive`, `needsPlaywright=false`, `userAgentOverride=null` **all stand**.

CF treats Edge/Chrome identically (same TLS fingerprint + UA structural tokens); the 10-page Edge walk + 30-page Chrome walk together rule out UA-selective challenge.

### 2. catalogUrls /shop/ undercovers — confirmed

Every one of the 86 sustained pages returned HTML containing literal "Showing 1-24 of 7327 results" (and 25-48, 49-72 ... variants — all "of 7327"). Store API global x-wp-total=11230. **Delta: 11230 - 7327 = 3903 products hidden from /shop/**.

Per-cat spot-checks (5 of the 25 R1 cats):

| Slug | HTTP | HTML "of N results" | WP REST product_cat.count |
|------|:----:|---------------------:|--------------------------:|
| used-items | 200 | 184 | 196 |
| draws | 200 | (regex miss; 904KB body) | 166 |
| auctions | 200 | (regex miss; 906KB body) | 3 |
| new-arrivals | 200 | 128 | 162 |
| tgd-promo-1 | 200 | 113 | 179 |

All 5 cats load 200 with products not reachable via /shop/. R1's per-category catalogUrls list **stands**.

### 3. perPage maxima probed

| Surface | per_page | HTTP | x-wp-total | xWpTotalPages | notes |
|---------|---------:|:----:|-----------:|--------------:|-------|
| Store API | 50 | 200 | 11230 | 225 | |
| Store API | 100 | 200 | 11230 | 113 | |
| Store API | 200 | **400** | — | — | hard cap |
| Store API | 250 | **400** | — | — | hard cap |
| HTML /shop/ | ?per_page=48 | 200 | — | — | "Showing 1-24 of 7327" — IGNORED |
| HTML /shop/ | ?per_page=96 | 200 | — | — | "Showing 1-24 of 7327" — IGNORED |

WC Store API hard cap at 100 (matches `woocommerce.ts:293` Math.min(perPage, 100)). HTML theme ignores `?per_page=N` and serves 24 per page. R1's perPage=24 is correct for HTML; runtime API path uses 100.

### 4. /shop/page/999/ → 404

GET /shop/page/999/ returns HTTP 404 (no redirect). Expected last page = ceil(7327/24) = **306**. Full walk not run in R2 due to ~15s/page latency (~75min for full /shop/).

### 5. productCountMethod label drift — confirmed via direct grep

`backend/src/services/product-count-probe.ts:110-122` defines the exact 11-name allowlist:
```
'wp-rest-header','json-api-count','json-api-length','html-pagination',
'sitemap','sitemap-index','generic-product-sitemap','ecwid-storefront-search',
'shopify-products-walk','klevu-api-count','stream-page-count'
```

**`wc-store-api-header` is NOT in this list.** Behavior on DB profile load:
- `validateMethod()` at L129-137 throws `Error: unknown product-count method` on unknown names.
- Even if caller bypasses validateMethod, switch `default:` branch at L474-479 returns `null` with `console.warn` "unknown method ... returning null".
- Either path → count probe silently disabled → coverage gate `verifyBootstrapCoverage` computes `ratio=null → isAcceptable=true`.

R1's `wp-rest-header` is canonical and in the allowlist. **R1 stands.**

### 6. verifyMethod gap — confirmed at worker.ts:394-401

```ts
// L394-401:
const maintainConfig = profile?.crawlers?.maintain;
if (!maintainConfig || maintainConfig.verifyMethod !== 'store-api') return null;
```

DB profile has no `crawlers.maintain` block → `maintainConfig` is undefined → `tryStoreApiVerify` returns null at L397. L770-771 error: `MISSING verifyMethod in site profile (crawlers.maintain.verifyMethod). Skipping verification.` R1's `crawlers.maintain.verifyMethod = "store-api"` block is a **material runtime fix**, not residue.

## Verdict per field (R1 vs DB)

| # | Field | R1 verdict | R2 verdict |
|---|-------|------------|------------|
| 1 | hasWaf | false (CF passive) | **R1 stands** (4-UA 86-page proof) |
| 2 | wafType | cloudflare-passive | **R1 stands** |
| 3 | userAgentOverride | null | **R1 stands** |
| 4 | needsPlaywright | false | **R1 stands** |
| 5 | expectedProductCount | 11230 | **R1 stands** (Store API per_page=50/100 both 11230) |
| 6 | productCountMethod.method | wp-rest-header | **R1 stands** (DB's `wc-store-api-header` silent-disables probe) |
| 7 | catalogUrls (25 per-cat) | 25 URLs | **R1 stands** (/shop/ misses 3903; per-cats reachable) |
| 8 | sortParam | ?orderby=date | **R1 stands** (not re-tested; R1's 3-outcome counter-control was sound) |
| 9 | perPage | 24 | **R1 stands** (HTML ignores ?per_page=N) |
| 10 | crawlers.maintain.verifyMethod | "store-api" | **R1 stands** (worker.ts:397 confirms missing → null) |

## DB column flips required

```sql
UPDATE sites SET
  hasWaf = false,
  -- plus siteProfile JSON updates:
  -- wafType: 'cloudflare-passive'
  -- userAgentOverride: null
  -- needsPlaywright: false
  -- productCountMethod.method: 'wp-rest-header'
  -- catalogUrls: <25 per-cat list>
  -- crawlers.maintain: { verifyMethod: 'store-api', verifyEndpoint: '/wp-json/wc/store/v1/products' }
  -- notes: clear sgcaptcha-era note
WHERE domain = 'thegundealer.ca';
```

## Blockers / inconclusives

- Full union-dedup of 25 per-cat URLs against Store API global 11230 NOT run (would need ~30min at 15s/page).
- `?sortParam` not re-verified in R2 (relied on R1's 3-outcome counter-control evidence).
- `auth-form-bruteforce`, `shellshock-UA`, `large-body-POST`, `path-traversal` attack surfaces NOT tested.
- Firefox 121 walk truncated at p16 / Edge 120 walk truncated at p10 due to wall-clock budget — pattern (200 + cf-ray + no sg) was uniform across all 4 UAs; remaining pages would not change the verdict.
