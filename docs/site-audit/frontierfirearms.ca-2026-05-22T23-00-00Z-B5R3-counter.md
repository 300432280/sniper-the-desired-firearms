# B5R3 Counter — frontierfirearms.ca

Adversarial attempt to disprove R2. Live re-verification, 800ms+ delay observed.

## R2 verdicts re-attacked

### productCountMethod (R2: candidate `{method:'sitemap', url:absolute}`)
**R2 trace ACCURATE** — `product-count-probe.ts:232-238` reads `m.url` (scalar) for `sitemap`; L240-243 iterates `m.urls[]` for `sitemap-index`; L129 `validateMethod` checks name only. DB's `{sitemap-index, sitemapUrl}` shape → `for (const x of undefined)` → null. CONFIRMED.

**NEW BUG R2 MISSED**: R1's value uses ABSOLUTE URL `"https://frontierfirearms.ca/xmlsitemap.php?type=products&page=1"`. L233 builds `${origin}${m.url}` → `https://frontierfirearms.cahttps://frontierfirearms.ca/...` → fetch fails → null. **Must be path-only `"/xmlsitemap.php?type=products&page=1"`.** Live re-pull of correct path: 1281 `<loc>`. R2 accepted the bad shape.

### catalogUrls (R2: candidate-40 healthy)
Walked 13 candidate URLs live: ALL 200, no redirects. R2's 301 claim on `/surplus-bags-hats-clothing/` parent is moot — R1's 40-list already excludes the bare parent and includes child `/surplus-bags-hats-clothing/new-jackets/` (200). R2 agree-R1 holds.

### searchUrl (R2: DB wins)
3 keywords (glock, ar-15, ammo) → all 200 via `/search.php?search_query=`. Confirmed. Restore from DB.

### hasWaf=false (R2: candidate wins)
Sustained `?page=1..12`: pages 1-2=200, 3-12=404 (origin pagination cap, not WAF). cf-ray present, no challenge/cf-mitigated. CONFIRMED passive.

## Net change vs R2
R2 verdict structure stands; one concrete fix: `productCountMethod.url` must be a path (`/xmlsitemap.php?type=products&page=1`), not absolute.

Files: `d:\Projects\FIREARM-ALERT\backend\src\services\product-count-probe.ts` L232-238.
