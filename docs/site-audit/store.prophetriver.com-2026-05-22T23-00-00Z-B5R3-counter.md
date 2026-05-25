# B5R3 Counter — store.prophetriver.com (2026-05-23T23:00Z)

Adversarial pass on R2. Independent live re-fetch, 800ms delay, no DB reads.

## V1: productCountMethod canonical `sitemap-index` + `urls: string[]` — UPHELD

- `product-count-probe.ts:110-122` allowlist excludes `'sitemap-xml'`; L186 `validateMethod()` throws on it.
- L240-252 switch iterates `for (const sitemapUrl of m.urls)` then calls `sitemapUrl.startsWith('http')` (L244). DB's nested `{pages:[{url,urls:number}]}` would TypeError (objects have no `.startsWith`).
- Shape `{method:'sitemap-index', urls:string[]}` is the only one that runs.

## V2: searchUrl `/search.php?search_query=` — UPHELD

Live, 3 keywords + scale:
- `?search_query=rifle` → 200; `=ammo` → 200; `=glock` → 200.
- `=a` → 200, page reports "4325 results" (broad search OK).
- DB form `/search?q=rifle` → 404. Confirmed broken.

## V3: expectedProductCount=13974 — PARTIALLY DISPROVED (refresh)

Re-walk 2026-05-23T23:00Z:
| URL | HTTP | `<loc>` |
|---|---|---|
| `xmlsitemap.php?type=products&page=1` | 200 | 10000 |
| `xmlsitemap.php?type=products&page=2` | 200 | **3971** |
| `xmlsitemap.php?type=products&page=3` | 404 | — |

Total = **13,971** (R2: 13,974, -3 in ~2h). Page-3 404 confirmed. The exact integer is volatile; method + order-of-magnitude correct. Set 13,971 on promotion or accept ±10 churn.

## V4: hasWaf=false — UPHELD

50-page sustained walk `/ammunition/?page=1..10` looped 5x:
- Chrome UA: 50/50 HTTP 200.
- `FirearmAlertBot/1.0`: 50/50 HTTP 200.
- No 403/429/503, no challenge.

`cloudflare-passive` is informational; flip column.

## Verdict
R2 promotion-ready. Single nit: refresh `expectedProductCount` to 13971 (live now). No blockers.
