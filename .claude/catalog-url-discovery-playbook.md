# Catalog URL Discovery Playbook

A field-tested process for finding the correct `catalogUrls`, `productCountMethod`,
`paginationPattern`, and `crawlers.watermark.method` for a monitored site.

**Audience**: future Claude sessions and human reviewers auditing the 60+ sites in
this project.

**Source of truth**: `siteProfile` in the DB. Every site-specific quirk MUST live
in the profile so the crawler is generic. Never hardcode `if (domain === '...'`.

---

## The Goal — for each site

For each site, the profile must answer five questions:

1. **What is the live product count?** → `productCountMethod` + `expectedProductCount`
2. **Which catalog URLs cover all firearm-relevant products with minimum overlap?** → `catalogUrls`
3. **How does pagination work?** → `paginationPattern` (one of: `query`, `path`, `offset-query`, `suffix-replace`)
4. **Can we sort by date (newest first)?** → `sortParam` (if yes) and `crawlers.watermark.method`
5. **Are there access quirks?** → `userAgentOverride`, `hasWaf`, `wafType`, `wafWorkaround`

If you can't answer 1-4 with **VERIFIED** evidence, you have not finished the site.

---

## The Process (in strict order)

### Phase 0: Read the existing profile

```bash
cd backend && node -e "..." # or write a one-shot show-site.js
```

Always start by reading what's already in the profile. Do NOT discard
catalogUrls or counts that previous sessions verified — verify them first,
correct them only if proven wrong.

### Phase 1: Identify the WAF / access mechanism

Test in this order — STOP at the first one that returns real product HTML:

1. `axios` with rotated default UA → if 200 + product cards visible, no WAF
2. `axios` with **mobile** UA (iPhone Safari) → many sites block desktop UA only
3. `axios` with referer `Referer: https://www.google.com/` and full sec-ch-ua headers
4. `fetchPageWithMeta()` (project HTTP client with undici fallback for malformed headers)
5. `fetchWithPlaywright()` (heavyweight — only if HTTP fails)
6. Playwright with **real Chrome** channel (`channel: 'chrome'`) instead of Chromium
7. Playwright with mobile UA + viewport

If the site can be reached **with HTTP only**, prefer that — Playwright is slow
and resource-heavy. If a specific UA is required, set `siteProfile.userAgentOverride`.

**Detect the WAF**:
- `cf-ray` header or `Just a moment...` body → Cloudflare
- `x-sucuri-id` header or `sucuri_cloudproxy_js` body → Sucuri
- 403 with custom HTML on desktop UA only → site-specific UA filter (not a real WAF)
- Custom nginx 403 page → host-level firewall

**Profile fields to set**:
```js
hasWaf: true|false,
wafType: 'cloudflare-active' | 'cloudflare-passive' | 'sucuri' | 'nginx-ua-block' | 'unknown',
userAgentOverride: <only if specific UA required>,
wafWorkaround: { method: '...', notes: '...', steps: [...] }
```

### Phase 2: Discover product count via API (preferred)

Try in this order — first one with a verifiable count wins:

| Probe | Endpoint | Verifies what |
|-------|----------|---------------|
| WP REST | `/wp-json/wp/v2/product?per_page=1` | `x-wp-total` header (exact, WooCommerce) |
| WC Store API | `/wp-json/wc/store/v1/products?per_page=1` | `x-wp-total` header (Store API public, no auth) |
| Shopify | `/products/count.json` | `count` field in JSON response |
| Shopify list | `/products.json?limit=1` | API works, count via pagination |
| BigCommerce | `/xmlsitemap.php` then product sub-sitemaps | Total `<loc>` in product sitemaps |
| Klevu | `POST {endpoint}` with API key | `meta.totalResultsFound` |
| Generic sitemap | `/sitemap.xml`, `/product-sitemap.xml`, `/sitemap_products.xml` | Filter `<loc>` to product pattern only |

**CRITICAL — sitemap counting traps**:
- `<lastmod>` is often the **sitemap regen date**, not the product date. Verify by checking if 5 random entries all have the same date — if so, useless for date watermark.
- Many sitemap URLs are **STALE 404** — old product slugs the sitemap never cleaned. Test 3-5 random entries with HEAD requests before trusting the count.
- Categories, blog posts, brand pages also appear in `<loc>`. Filter to product pattern only (e.g. `_p_\d+\.html`).
- A 442-entry sitemap can have only 147 actual products. Don't blindly count `<loc>`.

If no API works, fall back to `stream-page-count` (slow — only as last resort).

**Profile field**:
```js
productCountMethod: { method: 'wp-rest-header' | 'json-api-count' | 'sitemap-index' | 'klevu-api-count' | 'stream-page-count', ... }
expectedProductCount: <verified number>
```

### Phase 3: Discover catalogUrls — minimum overlap

The goal is the smallest set of URLs that together cover **every firearm-relevant
product** with **minimum overlap**.

**Step 3a — read the existing nav**:
1. Fetch the homepage with the verified UA
2. Inspect `nav`, `header`, `.menu`, `[class*="nav"]`, mega-menu containers
3. List all `<a href>` that look like category URLs
4. Group by URL pattern to find the convention (e.g. `/product-category/`, `/departments/`, `/c_NN.html`)

**Step 3b — read the WP/CMS taxonomy if available** (most reliable):
- WooCommerce: `/wp-json/wp/v2/product_cat?per_page=100&hide_empty=false`
- Shopify: `/collections.json?limit=250`
- BigCommerce: `/api/v2/catalog/categories` or category sitemap
- This gives EXACT category names + counts + parent IDs

**Step 3c — pick categories with minimum overlap**:
- Walk the category tree from the root
- Pick the **highest-level firearm-relevant categories** that don't overlap
- Verify "firearm-relevant" means: firearms, ammunition, optics, accessories, parts, magazines, reloading, knives, hunting (NOT clothing-only / camping-only / fishing-only unless that's all the site sells)
- Per project priority: firearms gets weight 3x, ammunition 2x — make sure those are covered first

**CRITICAL — beware of misleading category names**:
- **"Sights" can mean optics** — on doctordeals.ca, the "Sights" category contains scopes, red dots, AND iron sights all together. Don't dismiss categories based on name alone.
- **Verify with a known product** — if a user says "this product exists", search the WP REST products endpoint by keyword and read the `product_cat` IDs to find which category it lives in.
- **A site with "no ammo category"** might still sell ammo under "Reloading" or "Components" or simply have it labeled differently.

**Step 3d — verify each candidate catalogUrl**:
1. Fetch the URL with verified UA
2. Run the production adapter's `extractCatalogProducts($, url)` (DO NOT write your own selectors)
3. Confirm it returns products with title + URL + price
4. Get the page count via `getNextPageUrl` or pagination markers
5. Sum the per-page count × pages to estimate the category total
6. Compare to the WP taxonomy `count` field if available

**Step 3e — minimum overlap check**:
After selecting candidate catalogUrls, walk each one fully and dedupe products
across all categories (use a Set keyed by canonical URL or sourceId). If the
total unique count ≈ the API count from Phase 2, your catalogUrls are correct.
If unique total << API count, you're missing categories. If sum of per-category
counts >> unique, you have heavy overlap — consolidate to a higher parent.

**Trap — parent listing inclusion**:
On WooCommerce, `/product-category/parent/` USUALLY includes products from
`/product-category/parent/child/` automatically. But not always. Verify by
walking both and comparing slug sets. Don't add child URLs unless the parent
walk misses products.

**Profile field**:
```js
catalogUrls: ['/path1', '/path2', ...]  // verified, minimum overlap
```

### Phase 4: Discover the sort parameter

**DO NOT GUESS PARAMETER NAMES.** Common names like `sort`, `orderby`, `sortBy` cover only ~30% of sites. The other 70% use platform-specific names (`sortby`, `product_list_sort`, `vsort`, `s`, `order_by`, etc.).

**Step 4a — find the actual sort dropdown**:
1. Fetch a category page with verified UA
2. Grep the HTML for these elements:
   - `<select` with `id`/`name`/`class` containing `sort` or `order`
   - `<form method="get"` with sort-related inputs
   - `<a>` elements with text "Newest", "Latest", "Recent", "Date" — examine their `href`
   - `data-sort` attribute on any element
   - `onchange` handlers like `doSortBy()`, `submitSort()`, `applySort()`
3. Print every `<option value="..." text="...">` from sort selects

**Step 4b — verify by ID jump**:
1. Fetch baseline (no sort) — note first product ID
2. Fetch with the candidate sort param — note first product ID
3. If IDs are different AND sorted-first ID is the highest, the sort works
4. If sorted-first ID < default first ID, you have it backwards (sort=oldest)

**Step 4c — verify sort survives pagination**:
1. Fetch page 1 with sort — note ID range
2. Fetch page 2 with sort — note ID range
3. Page 2 IDs must be **strictly lower** than page 1 IDs (newest-first preserved)
4. If page 2 IDs overlap or jump back to defaults, the site only sorts page 1 — treat as `full-catalog-sweep`

**Profile field**:
```js
sortParam: '?sortby=4'  // or null if no working sort
crawlers.watermark.method: 'navigate-from-watermark'  // if sort works
                        |  'api-date-since-watermark'  // if API has ?after= filter
                        |  'full-catalog-sweep'         // if no sort works (last resort)
```

### Phase 5: Discover pagination pattern

The crawler supports 4 patterns. Determine which one this site uses by testing
each on a known multi-page category:

| Pattern | Test URL examples | Sites using it |
|---------|-------------------|----------------|
| `query` (default) | `?page=2`, `?p=2` | Most WooCommerce, Shopify |
| `path` | `/page/2`, `/p/2` | bullseyenorth.com (Celerant) |
| `offset-query` | `?top=255` (skip first 255) | canadasgunstore.ca (Activant) |
| `suffix-replace` | `Cat.html` → `Cat-2.html` | durhamoutdoors.ca (CS-Cart legacy) |

**Test method**:
1. Fetch `/category/` (page 1) — note first 3 product IDs
2. Try each pattern variant — fetch and note first 3 product IDs
3. The variant where page 2's products are **completely different** from page 1 wins
4. Variants where page 2 == page 1 are silently ignored (server returns default)

**Trap — wrap-around**:
Some sites loop back to page 1 when you exceed the real last page (e.g.
durhamoutdoors page 20 = page 1 content for a 19-page category). Your walk
loop must detect "first product on this page == first product on page 1" as
a stop condition.

**Profile field**:
```js
paginationPattern: { type: 'query' | 'path' | 'offset-query' | 'suffix-replace', template?, perPage?, match? }
perPage: <verified products per page>
```

### Phase 6: Final verification

After updating the profile, verify by:
1. Count the unique product URLs by walking ALL catalogUrls
2. Compare to `expectedProductCount` from Phase 2
3. They should match within ~5% (small drift is OK due to OOS / variants)
4. If the gap is large, one of the following is wrong:
   - catalogUrls miss a category
   - Pagination is broken (wrap-around not detected)
   - Per-page count was wrong
   - Sitemap had stale entries inflating expectedProductCount

Update `lastVerified` to today's date. Remove any stale `crawlPhase` from the
profile JSON (the DB column is the source of truth — duplicate JSON misleads).

---

## Common Mistakes (made on real sites in this project)

### Mistake 1 — Counting sitemap `<loc>` blindly
**Site**: durhamoutdoors.ca
**What I did**: Saw 442 entries in sitemap, set `expectedProductCount: 442`
**Reality**: Only 147 were actual products; 277 were 404-dead legacy URLs
**Fix**: Filter `<loc>` to product URL pattern only, then HEAD-test 5 random entries

### Mistake 2 — Guessing sort parameter names
**Site**: durhamoutdoors.ca
**What I did**: Tested `?sort=newest`, `?orderby=date`, `?sortBy=newest` — all failed
**Reality**: The real param was `sortby=4` (option value="4" in `<select id="sortby">`)
**Fix**: Read the actual `<select>` HTML; never guess

### Mistake 3 — Assuming `wafType` from notes
**Site**: doctordeals.ca
**What I did**: Profile said `wafType: 'sucuri'`, I trusted it
**Reality**: It was actually nginx-level UA blocking, not Sucuri at all
**Fix**: Re-detect WAF on every audit; don't trust stale profile metadata

### Mistake 4 — Dismissing categories by name
**Site**: doctordeals.ca
**What I did**: Searched WP taxonomy for "optic" → 0 results → claimed "no optics"
**Reality**: Optics live under "Sights" category (id 205) which contains scopes, red dots, AND iron sights
**Fix**: Search by **product** keyword first (find a Bushnell / Vortex product), then check what category it's in

### Mistake 5 — Missing product categories
**Site**: doctordeals.ca
**What I did**: Set 4 narrow firearms-only catalogUrls (rifles/shotguns/non-restricted/used-and-war)
**Reality**: Missed Parts (416 products), Accessories (293), and several other major categories
**Fix**: Always start from the WP taxonomy / category tree, NOT from guessing what categories exist

### Mistake 6 — Skipping verification on intermittent servers
**Site**: durhamoutdoors.ca
**What I did**: Server returned errors during my walk script; I moved on without retrying
**Reality**: Site was fine — my script needed retry-on-error logic
**Fix**: Always retry each fetch at least once before declaring failure

### Mistake 7 — Believing "site is dead" on hard 403
**Site**: doctordeals.ca
**What I did**: Saw 403 from desktop UA via Playwright; recommended disabling the site
**Reality**: Mobile UA (iPhone Safari) bypassed the WAF instantly
**Fix**: Test at least 4-5 UA/header combinations before declaring a site unreachable

### Mistake 8 — Guessing page-1 = newest for navigate-from-watermark
**Site**: canadasgunstore.ca
**What I did**: Defaulted to navigate-from-watermark
**Reality**: Site sorts by SKU ascending (oldest first); page 1 had OLDEST products → T1 hits "consecutive known" instantly and never finds new products
**Fix**: Verify page-1-is-newest by comparing IDs across pages; if page 1 has lowest IDs, the site needs `full-catalog-sweep` OR a working sort param

### Mistake 9 — Forgetting that catalogUrls are for HTML fallback
**Site**: doctordeals.ca
**What I did**: Worried about the gap between WP REST count (965) and category sum (615)
**Reality**: T1 and bootstrap discover via WP REST API which sees ALL 965; catalogUrls only matter for HTML stream fallback
**Fix**: Understand the data flow — `catalogUrls` are NOT the only product source for sites with API support

### Mistake 10 — Hardcoding stale data
**Site**: alflahertys.com (Klevu key)
**What I did**: Stored Klevu API key in profile, forgot it could rotate
**Reality**: Klevu keys CAN change when merchant regenerates them
**Fix**: Build self-healing — re-extract from page HTML on auth failure (see `klevu-key-resolver.ts`)

### Mistake 12 — Dropping a category based on name without inspecting its products
**Site**: fulcrum-outdoors.shoplightspeed.com
**What I did**: Dropped `/camping/` (286 products), `/fishing/` (360 products), `/apparel/` (49 products), `/e-bikes/` (20), `/smokers/` (25), `/clearance/` (0) from catalogUrls because their NAMES looked non-firearm.
**Reality**: After actually walking the dropped categories and filtering product titles for firearm keywords:
- `/camping/` had **2 unique firearm products** NOT in any kept category: **"Streamlight TRL-1 HL Gun Light"** (weapon-mounted tactical light) and **"Bakcou Gun/Bow Rack"** (gun storage rack). The other 284 are camping gear.
- `/apparel/`: 0/49 — confirmed pure clothing (boots, jackets, gloves).
- `/e-bikes/`: 1 (the Bakcou gun/bow rack, same as camping — covered).
- `/smokers/`: 0/25 — BBQ pellet grills (verified).
- `/fishing/`: 360 products; keyword-match for "sling/rod/barrel" got 38 initial hits but ALL were fishing false positives (fishing sling packs, fly rod holders, brass snap swivels for fishing tackle). 0 real firearm products.
- `/clearance/`: empty overlay.
**Fix**: Re-added `/camping/` to catalogUrls (2026-04-07). Walking 286 products once per T1 cycle costs ~24 page fetches, but it's the only reliable way to capture the 2 unique firearm lights/racks. The user's project principle is "don't miss anything firearm-related" — that trumps token efficiency.
**Lesson — Three-part process for dropping a "non-firearm" category**:
1. Walk the full category (with pagination) and dump ALL product titles
2. Run a STRICT firearm-keyword filter on titles — watch for false positives (e.g. "fishing sling pack" matches "sling", "brass snap swivels" matches "brass", "barrel caddy" matches "barrel")
3. For each firearm-keyword hit, check if it ALSO exists in a KEPT category — if yes, drop is safe; if NO, the category must be KEPT
4. Document in profile notes: list the specific unique firearm products in the otherwise-non-firearm category, so future agents know WHY the category is kept

**False-positive keywords to manually exclude**:
- `rod` in fishing context (rod holder, fishing rod, fly rod, spin rod)
- `brass` in fishing context (brass swivel)
- `barrel` in fishing context (barrel caddy, barrel swivel)
- `sling` in fishing/hiking context (sling pack, camera sling)
- `safety` in camping context (bear spray safety)
- Bear spray / pepper spray in outdoor categories

### Mistake 14 — Incorrectly constructing `paginationPattern` templates
**Sites**: frontierfirearms.ca (site 8), gagnonsports.com (site 11) — two sub-agents in a row got this wrong in different ways.
**What went wrong**:
- frontierfirearms: agent wrote `paginationPattern.template: "?page={n}"` for `query` type. The codebase's `buildPaginatedUrl` uses `template` as the PARAM NAME only (calls `url.searchParams.set(template, String(pageNum))`). Passing `"?page={n}"` makes it literally set a param named `"?page={n}"` → broken URLs like `?%3Fpage%3D%7Bn%7D=2`.
- gagnonsports: agent wrote `paginationPattern.template: "page{n}.html"` (lowercase `{n}`) for `suffix-replace` type. The code uses `template.replace('{N}', ...)` with **uppercase `{N}`** — lowercase is never replaced, producing literal URLs like `/category/page{n}.html` → 404.
- gagnonsports also had `match: "/$"` which the agent thought was a regex. It's a literal 2-char string. `baseUrl.endsWith("/$")` is never true.

**Correct templates** (read `catalog-crawler.ts:118-166` to confirm):

```ts
// Type 'query' — default ?page=N
{ type: 'query', template: 'page' }           // param name only, NO braces, NO question mark
{ type: 'query', template: 'p' }              // for sites using ?p=N

// Type 'path' — default /page/N
{ type: 'path', template: '/page/{N}' }       // uppercase {N}, leading slash
{ type: 'path', template: '/p/{N}' }          // any path pattern

// Type 'offset-query' — ?offset=(N-1)*perPage
{ type: 'offset-query', template: 'top', perPage: 255 }   // param name
{ type: 'offset-query', template: 'start', perPage: 50 }

// Type 'suffix-replace' — replace a literal match with a templated string
{ type: 'suffix-replace', match: '.html', template: '-{N}.html' }   // /cat.html → /cat-2.html
{ type: 'suffix-replace', match: '.html', template: 'page{N}.html' } // /cat/ → /cat/page2.html (via fallback!)
```

**The suffix-replace fallback quirk**: When `baseUrl` does NOT end with `match`, the code falls through to `return baseUrl + template.replace('{N}', String(pageNum))`. So for a site where the category URL ends with `/` but products are paginated via `/page2.html` APPENDED (not replacing anything), set `match: '.html'` deliberately — the baseUrl `/category/` doesn't end with `.html`, so it hits the fallback and appends `page2.html`, giving `/category/page2.html`. This is a clean way to get "append a template" behavior without needing a new pattern type.

**Verification checklist for any `paginationPattern`**:
1. Write a test script that imports `buildPaginatedUrl` and prints the output for pages 1-5
2. Visually check each URL matches what the site actually uses
3. Actually `axios.get` the generated page 2 URL and confirm it returns DIFFERENT products from page 1
4. Don't trust the spec without running this verification

### Mistake 13 — Trusting a stored `expectedProductCount` that was never verified
**Site**: fulcrum-outdoors.shoplightspeed.com
**What I did**: Initially accepted the stored `expectedProductCount: 3629` without question.
**Reality**: The live sitemap had 4,456 URLs; filtering to product pattern yielded **3,631** products — coincidentally close to 3,629, but the stored value was a complete guess from a previous session that had no verification method. DB=50 (1.4% coverage) should have been an obvious red flag that the original count was never validated.
**Fix**: Always re-verify `expectedProductCount` via Phase 2 (sitemap/API) before trusting it. Flag any site where `dbCount / expectedCount < 10%` as "crawler has been silently broken" and dig into root causes.

### Mistake 11 — Trusting a previous agent's root-cause diagnosis
**Site**: ellwoodepps.com (Magento 1.x)
**What I did**: A verification agent diagnosed "custom firearm-table layout confuses extractTitle()" and said 19,725 of 23,545 products were invisible because the adapter couldn't parse two category layouts. The next agent was about to add specialized selectors for the firearms and accessories pages.
**Reality**: The selectors were ALREADY CORRECT (`.products-list .item` matched every card, `extractTitle()` picked up the `[class*="name"]` probe correctly). The bug was 7 lines away in `extractCatalogProducts`: Magento 1.x product URLs end with `/catalog/product/view/id/NN/s/slug/category/NN/` — the trailing `/category/NN/` breadcrumb segment made `isNavUrl()` reject them. Products were being matched and extracted, then silently dropped at the URL filter step.
**Fix** (added 2026-04-06 in `generic-retail.ts:444-451`):
```ts
const isMagento1ProductView = /\/catalog\/product\/view\/id\/\d+\//i.test(url);
if (!isMagento1ProductView && this.isNavUrl(url)) return;
```
One regex whitelist. No new selectors needed. Extraction went from 17 to 23,545 products in one change.
**Lesson**: When a site reports low extraction counts, DO NOT trust any "the selector doesn't work" claim without tracing the full pipeline yourself. The bug is often in a filter downstream of the selector, not in the selector itself. Specifically, log what gets dropped at each step:
1. How many `element` matches did the selector produce?
2. How many survived `extractTitle()`?
3. How many survived `extractLink()`?
4. How many survived `isNavUrl(url)` check?
5. How many survived `isCategoryUrl(url)` check?
6. How many final products returned?
If the selector match count is high but the final count is low, the bug is in a filter. Find the step where the drop happens and fix THAT — not the selector.

---

## Adapter-side bugs discovered during site audits

These are issues in `backend/src/services/scraper/adapters/generic-retail.ts` that were caught during site verification work. Listed so future agents can find them quickly when auditing similar sites.

### Magento 1.x `/catalog/product/view/id/NN/.../category/NN/` URL filter (fixed 2026-04-06)
- **Symptom**: Product extraction counts 0 or 1 of N on Magento 1.x category pages where products link via the breadcrumb-preserving URL form
- **Root cause**: `isNavUrl()` in `base.ts` rejects any URL containing `/category/` as a category page
- **Fix**: Whitelist `/catalog/product/view/id/\d+/` before calling `isNavUrl()` in `extractCatalogProducts` (lines 444-451)
- **Affected sites**: ellwoodepps.com confirmed; any other Magento 1.x site in the fleet may have been silently under-extracting. Re-verify all sites with `platform: 'magento'` or `platform: 'magento-1.x'` to check.

---

## Quick Audit Checklist

For each site, before declaring "complete":

- [ ] WAF detected and documented (`hasWaf`, `wafType`, `userAgentOverride` if needed)
- [ ] Product count via API verified (`productCountMethod` + `expectedProductCount`)
- [ ] Live product count tested with the configured `productCountMethod` — returns the same number
- [ ] All catalogUrls return HTTP 200 with the verified UA
- [ ] Each catalogUrl extracts >0 products via the production adapter (NOT custom selectors)
- [ ] Pagination pattern verified by fetching page 2 and confirming different products
- [ ] Sort parameter found by READING the page HTML (not by guessing)
- [ ] Sort + pagination tested together — page 2 sorted IDs are strictly lower than page 1 sorted IDs
- [ ] `crawlers.watermark.method` matches the verified capability:
  - WC site with REST API → `api-date-since-watermark`
  - Site with working sort → `navigate-from-watermark`
  - Site with NO sort → `full-catalog-sweep`
- [ ] Walked all catalogUrls + deduped — unique total ≈ `expectedProductCount`
- [ ] Profile notes document EVERY non-obvious finding for future sessions
- [ ] `lastVerified` bumped to today's date
- [ ] Stale `crawlPhase` removed from profile JSON
- [ ] Test scripts deleted from `backend/scripts/`

If any box is unchecked, the site is not done — say so.

---

## Anti-patterns to Avoid

1. **"It probably uses ?page="** — verify, don't probably
2. **"The category name is X so it must contain Y"** — categories are merchants' UX, not API contracts
3. **"This site doesn't sell ammo"** — without checking the actual product taxonomy AND product searches
4. **"The sitemap has 1000 entries so the site has 1000 products"** — sitemaps lie
5. **"Playwright failed so the site is unreachable"** — try mobile UA, real Chrome, alternate headers
6. **"I'll batch-fix 6 sites with one script"** — every site has unique quirks; site-by-site is faster than debugging a broken batch script
7. **"Page 1 is always the newest"** — verify by ID/date comparison
8. **"The user already verified this in a previous session, I'll trust it"** — verify yourself; previous sessions had the same blind spots
9. **"The notes field said X"** — re-detect; notes get stale
10. **"3 sites have the same platform so they all need the same config"** — they don't; each WooCommerce / BigCommerce / Shopify site has unique customizations
