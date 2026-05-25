# B6R3 counter — www.gobles.ca

Run: 2026-05-25T04:10Z. Persona: `engineering-code-reviewer`. Adversarial pass on R2's 7 verdicts. 36 live GETs (800ms delay).

## TL;DR

R2 is right on 6 of 7 verdicts. **R2's catalogUrls=90 claim is wrong: 6 of the 20 added sub-action leaves are EMPTY (0 product cards). Refined spine = 84, not 90.** All other R2 verdicts hold under adversarial test.

## 1. catalogUrls — R2 over-counted by 6

Walked all 20 R2-added sub-action leaves under production extractor (`.product-element` count). 6 returned **0 products** (≤120KB body, identical "empty" markers, no further sub-nesting):

| Leaf | HTTP | bytes | product-element |
|---|---|---|---|
| `/firearms/centerfire-rifles/falling-block/?limit=100` | 200 | 97728 | **0** |
| `/firearms/centerfire-rifles/pump-action/?limit=100` | 200 | 97676 | **0** |
| `/firearms/combination/centerfire-shotgun/?limit=100` | 200 | 97706 | **0** |
| `/firearms/rimfire-rifles/pump-action/?limit=100` | 200 | 97599 | **0** |
| `/firearms/rimfire-rifles/revolver/?limit=100` | 200 | 97605 | **0** |
| `/firearms/shotguns/lever-action/?limit=100` | 200 | 97493 | **0** |

The other 14 yielded 1-100 cards. **Corrected spine: 74 - 4 zero-yield + 14 non-empty leaves = 84.**

## 2. DB spine — R2 verified across 4 UAs

`/firearms/?limit=100` and `/knives/?limit=100` returned **pe=0 pb=0 dp=0** under Chrome 131, Firefox 128, Safari 17.4, and a custom bot UA. 8/8 responses HTTP 200 with CF-RAY (`a0118109..a0118141`). R2's "DB spine silently misses ~596 products" finding HOLDS.

## 3. productCountMethod / sitemap

`https://www.gobles.ca/sitemap.xml` HTTP 200, 554,274 bytes. `<loc>` total = 6383; matching `\.html$` = **3770** (matches R2 exactly). Zero `page[N].html` paginator entries; 20/20 sampled product anchors from 8 walked categories present in sitemap. R2's `generic-product-sitemap` shape matches `product-count-probe.ts:313-335` switch and `validateMethod()` accepts the name (L117).

## 4. hasWaf / perPage / sortParam / searchUrl

All R2 verdicts unchanged. CF-RAY monotonic across 36 R3 requests; no challenges, no 403/429.

## Verdict

- R2 verdicts supported: 6/7 (hasWaf, productCountMethod, expectedProductCount, perPage, sortParam, searchUrl)
- R2 verdicts refined: 1 (catalogUrls **84**, not 90 — drop 6 empty leaves)
- R2 verdicts rejected: 0

## Files
- `_audit_tmp/batch6-2026-05-23-r3/sitemap.xml` (3770 .html locs)
- `_audit_tmp/batch6-2026-05-23-r3/leaves/leaf-{1..20}.html`
- `_audit_tmp/batch6-2026-05-23-r3/dbspine/{firearms,knives}-{default,firefox,safari,bot}.html`
- `_audit_tmp/batch6-2026-05-23-r3/zero/zero-{1..4}.html`
