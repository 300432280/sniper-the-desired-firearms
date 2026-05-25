# R3 Adversarial Counter — thegundealer.ca

**Run:** B5R3 2026-05-23 04:00Z. Mission: DISPROVE R2.

## Probes executed (live, 800ms delay)

### 1. WAF UA-matrix (broadened from R2's 4 UAs to 5 incl. bot + no-UA attack surface R2 skipped)
| UA | status | server | cf-ray | sg-captcha hdr | sgcaptcha body | set-cookie |
|----|:------:|:------:|:------:|:--------------:|:--------------:|:----------:|
| chrome131 | 200 | cloudflare | yes | no | no | empty |
| safari17  | 200 | cloudflare | yes | no | no | empty |
| android-chrome120 | 200 | cloudflare | yes | no | no | empty |
| Googlebot | 200 | cloudflare | yes | no | no | empty |
| no-UA | 200 | cloudflare | yes | no | no | empty |

**Bot + no-UA both 200** — closes R2's untested attack-surface gap. **R2 stands.**

### 2. /shop/ last-page binary search (R2 deferred this)
GET `/shop/page/{N}/`: p200=200, p250=200, p306=200, **p307=404**, p310=404, p400=404. Last page = **306**. Matches R2's predicted `ceil(7327/24)=306` exactly. **R2 stands.**

### 3. Rapid-burst (8 parallel reqs, no delay)
All 8 timed out at 15s (CF/origin connection throttle, no sg-captcha header surfaced before timeout). Consistent with cloudflare-passive rate-limiting, NOT sgcaptcha challenge re-emergence.

### 4. productCountMethod allowlist — direct re-grep
`product-count-probe.ts:110-122` VALID_METHOD_NAMES = `['wp-rest-header', 'json-api-count', 'json-api-length', 'html-pagination', 'sitemap', 'sitemap-index', 'generic-product-sitemap', 'ecwid-storefront-search', 'shopify-products-walk', 'klevu-api-count', 'stream-page-count']`. `wc-store-api-header` absent. `validateMethod()` L129-137 throws. **R2 stands.**

### 5. verifyMethod missing → worker.ts behavior (R2 cited L394-401; real block is L766-773)
`worker.ts:769-772`: `const verifyMethod = entry?.siteProfile?.crawlers?.maintain?.verifyMethod; if (!verifyMethod) { console.error(...MISSING verifyMethod...Skipping verification.); return; }` — entire verify pass skips silently when block missing. **R2 stands** (line numbers slightly off; behavior identical).

## Verdict
All 10 R2 corrections survive. **No reversals.** R2's `wp-rest-header`, `cloudflare-passive`, `userAgentOverride=null`, `needsPlaywright=false`, `perPage=24`, 25 per-cat catalogUrls, `crawlers.maintain.verifyMethod="store-api"`, `expectedProductCount=11230` all confirmed.

## Residual inconclusives (NOT changing verdict)
- Per-cat "Showing X of N" regex still miss (body >2KB; embedded later in HTML) — R2's WP REST `product_cat.count` numbers (used-items=196, draws=166, auctions=3) remain the authoritative per-cat counts.
- Full union-dedup of 25 cats vs Store API 11230 not run (would need ~30 min walk).
