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
wafWorkaround: { method: '...', notes: '...', steps: [...] }  // informational only, not consumed by runtime code
wafLastProbedAt: '<ISO timestamp>',                             // when the heavy probe was run
wafProbeMethod: 'heavy-8-batch' | 'single-request' | 'other',    // which method produced the verdict
wafProbeResult: '<one-line summary of probe findings>',         // human-readable verdict
wafProbeEvidence: { ... },                                      // structured data from probe
```

**NOTE on `wafWorkaround`**: this field is **documentation only** — no backend code reads it. Runtime WAF handling is driven by `hasWaf` (for HTML-size threshold in the fallback path at `catalog-crawler.ts:404-421`) and the generic `waf-cookie-manager` + `applyBackoff` infrastructure. Setting `wafWorkaround: null` is safe for sites that don't need a site-specific workaround; the generic runtime fallback chain still fires regardless.

---

### ⚡ Heavy WAF verification procedure (MANDATORY — use for every audit)

**Why**: A single 200 response proves *"this request on this path with this UA at this moment was not challenged"* — NOT *"this site has no WAF."* Many WAFs are behavior-based (rate limit, bot fingerprint, OWASP rule set, path-selective) and don't fire on a single probe. The heavy probe fires 8 batches designed to trigger every common WAF trigger.

**Tool**: `backend/scripts/heavy-waf-probe.sh <https://target>` — a bash script that runs the full 8-batch probe. Keep this file permanently in the repo; do NOT delete it after an audit.

**Pre-flight step (as of 2026-04-08 after Site 24)**: the script automatically resolves the canonical host via redirect-following before running the 8 batches. Apex domains that 301 to `www` (or elsewhere) are common, and sometimes the apex runs on a DIFFERENT stack than the canonical (e.g. reliablegun.com apex is Microsoft-IIS/10.0 that 301s to `www.reliablegun.com` which is Cloudflare-fronted — probing only the apex would miss the WAF entirely). The pre-flight prints both the apex `server:` header and the canonical `server:` header, warns if they differ, and updates all subsequent probes to target the canonical. If the probe tool is missing this pre-flight, UPDATE IT before running an audit.

**The 8 batches**:
1. **Header fingerprint** — GET homepage + `/robots.txt` + `/sitemap.xml` with `curl -I`, grep for `server:`, `cf-ray`, `cf-cache-status`, `x-sucuri-id`, `x-amzn-*`, `x-waf-*`, `x-cache`, `via`, `set-cookie` (cf_clearance, __cf_bm, incap_ses_*, visid_incap_*)
2. **Multi-UA probe** — same path with Desktop Chrome, iPhone Safari, `python-requests/2.31.0` (obvious bot), `curl/8.1.2` — checks for UA filtering
3. **Rapid burst** — 10 sequential GETs with cache-busting query strings in ~2-5 seconds — triggers rate-limit rules
4. **Honeypot/admin path probe** — `/wp-admin/`, `/wp-login.php`, `/xmlrpc.php`, `/.env`, `/.git/config`, `/phpinfo.php` — many WAFs have active rules for these paths
5. **Barebones headers** — GET with no Accept-Language, no Accept-Encoding — some WAFs require full browser header sets
6. **SQLi-shaped query string** — `?id=1' OR '1'='1` and `?id=1 UNION SELECT 1,2,3` — triggers OWASP CRS SQLi rules
7. **XSS-shaped query string** — `?q=<script>alert(1)</script>` — triggers OWASP CRS XSS rules
8. **No User-Agent** — GET with `-A ""` — some WAFs require a UA header

**Interpretation**:
- **All 8 batches return 200 with consistent timing AND no `cf-ray`/`x-sucuri-id`/challenge markers** → `hasWaf: false` (verified, high confidence)
- **Any batch returns 403/503/challenge body** → `hasWaf: true`, `wafType` = vendor from headers
- **`cf-ray` header present on EVERY 200 response** → `hasWaf: true`, `wafType: 'cloudflare-passive'` — Cloudflare is proxying but not actively filtering. **Set hasWaf=true**, because CF can be activated at any time by the site owner, and the crawler's `hasWaf: true` fallback path (2KB HTML threshold + 45s Playwright timeout at `catalog-crawler.ts:416-421`) gives tighter recovery if it suddenly fires.
- **Honeypot paths 403 but category 200** → `hasWaf: true`, `wafType: 'path-selective'`
- **SQLi/XSS 403 but normal 200** → `hasWaf: true`, `wafType: 'owasp-crs'`
- **Rapid burst triggers 429/503** → `hasWaf: true`, `wafType: 'rate-limit'`
- **`python-requests/2.31.0` UA blocked but Chrome UA allowed** → `hasWaf: true`, `wafType: 'ua-filter'`, and set `userAgentOverride` if needed

**ANTI-PATTERN**: Setting `hasWaf: false` after a single 200 response without heavy-probing. This was how site 19 nordicmarksman (Stencil), site 20 northprosports (OpenCart), and site 21 outfitters (Odoo) were initially mis-flagged. All three actually HAD Cloudflare in front of them — the single-shot probe missed the `cf-ray` header. **You MUST run the heavy probe before declaring `hasWaf: false`.**

**Corollary — `hasWaf: true, wafType: 'cloudflare-passive'` is NOT blanket tagging**: setting `hasWaf: true` requires the heavy probe to first detect `server: cloudflare` + `cf-ray` headers. If those headers are absent, CF is not in front and `hasWaf: false` is correct. The rule is **verify, then set** — never blanket.

**Record every heavy probe** in the profile via:
- `wafLastProbedAt`: ISO timestamp of the probe run
- `wafProbeMethod`: `'heavy-8-batch'` (or other method if warranted)
- `wafProbeResult`: one-line verdict
- `wafProbeEvidence`: structured data (CF headers detected, rate-limit fired, etc.)

Future auditors can see WHEN the WAF state was last verified and re-probe if stale (recommend re-probe every 90 days or on SRE alert).

---

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

### Mistake 15 — Mistaking a client-side-paginated single-page catalog for a multi-page one
**Site**: irunguns.ca (custom PHP, site 14) — canonical example.
**What I did initially**: Looked for `?page=N` / sort params and pagination markup, found none, almost concluded "the site is broken".
**Reality**: The page uses **`jPages({ perPage: 12 })`** to client-side-paginate a `<ul id="content">` that already contains the ENTIRE result set, server-rendered. The "Showing 13 result" / "Showing 22 result" string at the bottom IS the full count. There is no URL pagination because there are no other pages — every product the category contains is in the initial HTML response. Total in-stock catalog was 84 products across 11 departments.
**How to recognise**:
1. The page HTML contains `jPages(`, `bootpag(`, or similar JS plugin call referencing `containerID`/`perPage`.
2. A "Showing N result" / "N matching items" marker exists with a small N (often <100).
3. Counting unique product anchors in the initial HTML matches that N.
4. Adding `?page=2` returns the same products as page 1 (silent ignore).
5. No `<select>` for sort, no `<a>` with text "next" pointing at a different URL.
**Fix**: Set `paginationPattern: null`, `perPage: <large enough to never trigger next-page logic>`, treat each catalog URL as single-fetch. The production adapter will extract everything in one call. If no date sort exists either (often the case for these sites), watermark method must be `full-catalog-sweep`.
**Critical rule**: If the site renders the full catalog server-side via plain GET, do NOT investigate the embedded AJAX/JS endpoints, SQL strings, or POST targets. Plain GET is enough. The embedded JS may exist for the sole purpose of client-side reshuffling — following it is a rabbit hole (see Mistake 16). On irunguns.ca specifically, a plain `GET /product.php?departments=Rifles` returns all 15 rifles in the initial HTML; nothing else is needed.

**Sub-lesson — verifying newest-first DOM ordering when no sort UI exists**: When a site has no `<select>` for sort but you suspect the natural DOM order may be newest-first, cross-reference the GET DOM first product slug against ANY independent newest-first signal (POST endpoint baseline with no ORDER BY, sitemap lastmod ordering, RSS feed, known-recent product the operator confirms is newest). On irunguns this was a single-GET test: GET DOM first slug on Rifles = `glenfield-model-a-moss-green-308-win-20-barrel-4-rounds`, matching the earlier POST `/product_filter.php` baseline first slug (which had no `ORDER BY` and therefore used the server default = `p.id DESC`). Same first slug on both paths → same ordering → newest-first proven. This unlocks `navigate-from-watermark` on sites that initially appear "no sort possible" and saves the T1 stream from degrading to `full-catalog-sweep`. Ref: irunguns.ca audit 2026-04-07 (redo).

### Mistake 16 — Following an embedded AJAX/SQL endpoint into a rabbit hole when plain GET already returns the full catalog
**Site**: irunguns.ca (custom PHP, site 14)
**What happened**: After a user pushback ("only 84 products for a major vendor?") I investigated the embedded `<script>` block on category pages, found it composes a raw SQL query string and POSTs it to `/product_filter.php`, and went down a multi-step path designing a custom adapter that would POST with modified SQL (`WHERE p.id > {cursor}`) for an id-based watermark. **All wasted work.** The correct answer was: for monitoring purposes (track new in-stock items + back-in-stock alerts on already-known products), the 84 products visible via plain GET are exactly what we need. The ~1,760 OOS-only products that only a modified POST-SQL can see are irrelevant — we cannot send back-in-stock alerts for products we never catalogued in the first place, and new in-stock arrivals DO appear in plain GET as soon as they're stocked.
**Why it matters**: Distinguishes "what the site IS capable of exposing" from "what this app NEEDS." Always ask the second question first.
**Lesson**: Before investigating any AJAX/SQL/private API on a site, ask three questions:
1. Does plain GET against the category URLs already return the products we need?
2. Are the extra products the AJAX endpoint exposes actually meaningful for this app's use case (new in-stock + back-in-stock alerts)?
3. Is the existing watermark method (`full-catalog-sweep`) already sufficient given the site's size (tens to low hundreds of in-stock products)?
If the answer to #1 is yes, STOP and use plain GET. Don't follow JS. Don't reverse-engineer the API. Don't build a custom adapter.
**Reference**: irunguns.ca, 2026-04-07 audit.

### Mistake 17 — Designing a cursor watermark around a column that isn't exposed in URL/API space
**Site**: irunguns.ca
**What happened**: I designed an `idCursor` watermark using `p.id` from the embedded SQL on irunguns.ca. The cursor was supposed to filter `WHERE p.id > N` so T1 could fetch only new products. **But iRunGuns product URLs are `/product_detail.php?p=<slug>` — `p` is a slug string, not a numeric id.** The `p.id` column referenced in the embedded SQL is server-side only, never visible to the client in the URL, the HTML cards, or any response payload. There was nothing to cursor on.
**Why it matters**: A cursor watermark requires the cursor value to be (a) exposed somewhere we can read after a crawl AND (b) usable as a filter on a future fetch. A server-internal column satisfies neither.
**Lesson**: Before proposing any cursor-based watermark, verify the cursor field is **exposed to the client** in either:
- the product detail URL,
- the listing card HTML (data attributes, hidden inputs, text content), or
- a documented API response payload.
Look at actual product detail page URLs. If the cursor field is only inferred from server-side query construction (e.g., embedded SQL strings), it does not exist from the client's perspective and cannot be used.
**Reference**: irunguns.ca `p.id` cursor design, 2026-04-07.

### Mistake 18 — Confusing "no sort UI exists" with "no sort possible"
**Site**: irunguns.ca (custom PHP, site 14) — canonical example.
**What happened**: An earlier audit pass concluded irunguns needed `full-catalog-sweep` because no sort `<select>` exists on the category pages. The conclusion was wrong: "no sort UI" and "no sort possible" are different questions. Many custom-PHP / legacy CMS sites lack a sort selector but render products in INSERT order — which on an auto-increment PK is effectively newest-first if the server reads `p.id DESC` by default (very common) or oldest-first if it reads in ascending PK order. The actual rendered order on irunguns was `p.id DESC` (newest first), proven by cross-referencing the GET DOM first slug against an independent baseline (see Mistake 15 sub-lesson). This unlocked `navigate-from-watermark` with zero new infrastructure.
**Why it matters**: `navigate-from-watermark` only requires page 1 to be newest-first — the watermark cursor is the URL slug (or any stable client-visible identifier) of the most recent product, which is always exposed by definition because it IS the URL the crawler will visit. Downgrading to `full-catalog-sweep` when navigate-from-watermark is viable costs a large multiple in tokens per T1 cycle and defeats the tier engine's whole purpose.
**Lesson**: Before declaring a site needs `full-catalog-sweep`, run ONE cross-reference test (Mistake 15 sub-lesson) against any independent newest-first signal. Only downgrade to `full-catalog-sweep` if you cannot prove newest-first ordering by any method. Document the proof method in the profile `notes`.
**Reference**: irunguns.ca audit redo, 2026-04-07.

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

### Mistake 19 — Declaring a SPA site "blocked" without testing the production Playwright fallback
**Site**: liangjian.ca (GoDaddy OLS)
**What happened**: Two consecutive audits declared liangjian.ca "BLOCKED — needs new adapter" after testing only plain axios against `/shop/ols/products`, seeing 0 products extracted, and giving up. Both audits even ran Playwright manually and saw it render 15 products, then still wrote `siteProfile.crawlers.watermark.blockedReason: 'godaddy-ols-spa-api-on-foreign-origin'` into the profile and recommended building a new `GoDaddyOlsAdapter` from scratch. Neither tested the production `fetchWithPlaywright()` fallback that's wired into both `catalog-crawler.ts:403-413` and `watermark-crawler.ts:143-159` and auto-fires when static HTML > 5KB returns 0 products.

**Reality**:
1. The GoDaddy OLS selector has been in `generic-retail.ts:431` the entire time:
   ```ts
   '[data-aid="PRODUCT_LIST_RENDERED"] [data-ux="GridCell"]', // GoDaddy OLS (liangjian.ca)
   ```
2. The production Playwright fallback is wired up and used by 20+ other sites in the fleet.
3. When tested via the production code path (`fetchWithPlaywright()` → `extractCatalogProducts`), the site extracts 15 products on the first try with zero new code.
4. The previous audit's own profile note showed `lastWatermarkUrl: ".../glock-2141-magazine-45-auto-10-rounds?orderby=date"` — proof that an earlier crawl had succeeded with this exact URL pattern. The auditor missed evidence sitting in the profile they were editing.

**Fix**: When static HTML returns 0 products from a site that a human can browse, BEFORE declaring the site blocked or proposing a new adapter, you MUST:
1. Run `fetchWithPlaywright()` (the EXISTING production helper, do not write your own Playwright code) against the same URL.
2. Run the production adapter's `extractCatalogProducts($, url)` against the rendered HTML.
3. If that returns ≥1 product, the site is NOT blocked — set `needsPlaywright: true` in the profile and you are done. The catalog-crawler/watermark-crawler auto-fallback will pick it up.
4. Check `generic-retail.ts` for an existing platform-specific selector (Klevu, GoDaddy OLS, BigCommerce Stencil, Shopify, Shoplightspeed, etc.) — many SPA frameworks already have entries.
5. Check the existing `siteProfile.lastWatermarkUrl` for evidence that a prior crawl succeeded — if a real product slug is there, the site has been crawled before and the access path is recoverable.
6. Only after ALL of the above fail, propose a new adapter or platform-specific code.

**Lesson**: "Plain HTTP returns 0 products" is the **start** of the investigation, not the conclusion. The cost of one Playwright probe call is ~7 seconds. The cost of declaring a site blocked when it isn't is weeks of silent under-coverage and a wasted adapter build. Always pay the 7 seconds.

**Also**: this is a special case of the global rule in `~/.claude/CLAUDE.md`: *"Never give up after first failure. Test at least 3 alternative approaches with evidence before declaring 'unfixable.' If a human can access something in their browser, there IS a way to get it programmatically."* If your conclusion is "build a new adapter" or "the site is blocked", you have given up too early.

**Sub-lesson — When investigating a SPA, you MUST drive Playwright as a real user, not as a static fetcher.** Static `goto()` + `waitForSelector` only loads the default state. To find sort params, pagination behavior, filter UI, etc., you must `page.click()` the actual controls and capture (a) the URL change, (b) the network XHRs fired, (c) the new visible state. On liangjian.ca, the sort dropdown was visible the entire time as `[data-aid="PRODUCT_SORT_DROPDOWN"]` containing a "Newest" option. THREE prior audits never clicked it and concluded "no sort exists." Truth: clicking "Newest" sets URL `?sortOption=descend_by_created_at` AND fires `GET ...mysimplestore.com/api/v2/products?...q[descend_by_created_at]=true`. Mistake 2 (read HTML before guessing params) extends to SPAs as: **drive the UI before guessing URL params**. If a `<select>` / dropdown / button looks like a sort/filter/paginate control, click it in a live Playwright session with `page.on('request', ...)` logging — then read the URL and the XHR. Do not rely on static HTML scans for SPA controls; the handlers are in JS, not markup.

### Mistake 20 — Assuming platform-default sort option values are universal (Magento 2.x `product_list_order`)
**Site**: londerosports.com (Magento 2.x)
**What happened**: The previous profile had `sortParam: '?product_list_order=created_at&product_list_dir=desc'` — the widely-documented Magento 2 "newest first" sort. On londerosports, this param is **silently ignored** — Magento falls back to the default `bestsellers` sort because `created_at` is not a configured option value on this install. The audit would have missed this if the auditor hadn't read the actual `<select id="sorter">` HTML.
**Reality**: Read the option values directly from the select element:
```html
<select id="sorter" data-role="sorter">
  <option value="bestsellers" selected>Best Sellers</option>
  <option value="new">New Products</option>        <!-- THIS is newest-first on this install -->
  <option value="most_viewed">Most Viewed</option>
  <option value="quantity_and_stock_status">In Stock</option>
  <option value="price">Price</option>
  <option value="marque">Brand</option>
  <option value="rating_summary">Rating</option>
  <option value="saving">Savings</option>
</select>
```
The newest-first value here is literally `new`, not `created_at`. Proven via ID-jump test: default rifles first = "maple-ridge-armoury-renegade-mk-ii"; with `?product_list_order=new` first = "weatherby-mark-v-live-wild-30-06-sprg" — different product, confirming the sort is working.
**Fix**: `sortParam: '?product_list_order=new&product_list_dir=desc'` in the profile.
**Why it matters**: Magento 2.x's `<select id="sorter">` option values come from the merchant's `catalog_config` and can be customized / renamed / localized per store. Common values seen in the wild:
- `created_at` / `creation_time` (stock Magento default label)
- `news_from_date` (Magento 1.x legacy, used on ellwoodepps — site 6)
- `new` (londerosports — site 18)
- `date_added` / `newest` (themed installs)
- `bestsellers` (often the store default, NOT newest)

**Lesson**: Mistake 2 ("never guess sort params") applies with extra force to Magento sites. Every Magento audit MUST:
1. Fetch a category page with production HTTP client / Playwright
2. Grep for `<select id="sorter"` (M2) or `<select id="sorter"` / `<select name="order"` (M1)
3. Print every `<option value="..." text="...">` from the select
4. Identify the label that sounds like "newest"/"new"/"latest"/"date"/"created" and use ITS value, not the default you remember from another site
5. Verify via ID-jump test (default first product vs sorted first product) — if identical, the param is being ignored
6. Verify sort survives pagination (page 2 IDs strictly different from page 1)

**Corollary**: When re-verifying Magento sites where the stored `sortParam` is `product_list_order=created_at` or `order=news_from_date`, treat those as UNVERIFIED and re-read the `<select>` HTML. They may be stored from a blind copy/paste and silently ignored by the target store.

### Mistake 21 — OpenCart's visible sort dropdown does not expose every server-accepted column
**Site**: northprosports.com (OpenCart stock 2.x/3.x)
**What happened**: The `<select id="input-sort">` dropdown only exposed these options:
```
p.sort_order-ASC (default)
pd.name-ASC / pd.name-DESC
p.price-ASC / p.price-DESC
p.model-ASC / p.model-DESC
```
**No `p.date_added` / "Newest" option in the dropdown.** A strict Mistake-2-only read would have concluded "no date sort exists" and the site would have been routed to `full-catalog-sweep` unnecessarily.
**Reality**: OpenCart's stock `product/category` controller accepts **any** `p.*` or `pd.*` column via the `sort` query parameter, server-side. The dropdown is a UI convenience, not an exhaustive whitelist. Directly hitting `?sort=p.date_added&order=DESC` on northprosports returned newest-first results — verified by ID-jump test:
- Default sort: first product_id = 22944 ("Display Model CZ-USA 600 ST3")
- `sort=p.date_added&order=DESC`: first product_id = **24005** (Stoeger P3000 Freedom Series)
- Higher product_id = newer (OpenCart autoincrements)
**Fix**: `sortParam: 'sort=p.date_added&order=DESC'` in the profile. Watermark method stays `navigate-from-watermark`.
**Why it matters**: This is a narrow extension of Mistake 2 for OpenCart specifically. The general rule ("read the HTML, don't guess") is still correct as the FIRST step — but for OpenCart sites, if the dropdown lacks a date option, you must ALSO probe `p.date_added` directly before declaring sort impossible. OpenCart's server-side column whitelist is broader than what the default theme surfaces in the UI.

**Lesson**: On OpenCart sites, the sort-param audit is a TWO-step process:
1. Read `<select id="input-sort">` HTML and try the values listed there (per Mistake 2)
2. Even if no date option is visible, ALSO probe these known stock OpenCart server-accepted sorts:
   - `?sort=p.date_added&order=DESC` (explicit date column)
   - `?sort=p.product_id&order=DESC` (equivalent — autoincremented PK)
   - `?sort=p.date_modified&order=DESC` (if p.date_added doesn't work)
3. Verify via ID-jump test; if the first product_id is strictly higher than the default first product_id, the sort is server-honoured
4. The UI dropdown being silent about the option is NOT evidence the column is unsupported

**Cross-reference**: this is a Mistake-2 extension in the same family as the Stencil default-newest gotcha (site 19 nordicmarksman.com) and the Magento merchant-customized option values (Mistake 20). All three are variants of "the dropdown doesn't tell the whole story." For BC Stencil: read the dropdown but use `alphaasc` as a reliable counter-control. For Magento: read the dropdown because `created_at` may not be a valid value. For OpenCart: read the dropdown AND probe `p.date_added` directly because the dropdown is incomplete.

**Corollary**: When re-verifying OpenCart sites whose stored `sortParam` is `null` (with a note like "no sort exists"), treat those as UNVERIFIED and re-probe `?sort=p.date_added&order=DESC` directly. Prior auditors may have stopped at the dropdown.

### Mistake 22 — Odoo eCommerce platform reference + stored platform tags need verification
**Site**: outfitters.goldnloan.com (Odoo eCommerce with Theme Pixel)
**What happened**: The prior session recorded `platform: 'lightspeed'` in the profile even though the notes field explicitly said "Odoo, bilingual" — nobody cross-validated. Audit discovered the site is actually Odoo, not LightSpeed. Production selectors happened to work anyway (generic `[class*="product-item"]` matched the Odoo `.tp-product-item` class), so the misidentification hadn't caused extraction failures — but the stored `sortParam: '?sort=newest'` was a LightSpeed guess that Odoo silently ignored, and `paginationPattern` was missing entirely, leaving the crawler stuck at ~42 products out of 1,787.

**Reality — Odoo eCommerce signature** (how to identify it in future audits):
- HTML markers: `<meta name="generator" content="Odoo">`, `oe_website_sale`, `oe_currency_value`, `oe_structure`, `o_wsale_products_grid_table_wrapper`
- Theme class prefix: typically `tp-*` (Theme Pixel) or raw `oe-*` classes
- Product card: `.tp-product-item.tp-product-item-grid-1` (Theme Pixel) — matched by existing `[class*="product-item"]` selector
- URL pattern: `/shop/category/<slug>-<id>` (category) and `/shop/<slug>-<id>` (product detail)

**Odoo sort param format** (important quirk):
- Uses **literal `+` for space** in the URL: `?order=create_date+desc`
- `create_date%20desc` also works
- Values from the stock Theme Pixel dropdown: `website_sequence+asc` (default/Featured), `create_date+desc` (Newest), `name+asc` (Name), `list_price+asc`, `list_price+desc`
- **Read the actual `<a href="?order=...">` in the sort dropdown** — on outfitters this is `#tp-shop-sort-sidebar` — before writing anything

**Odoo pagination**: `path` type, template `/page/{N}` — "Load more" anchor is `/shop/category/firearms-42/page/2`. Odoo clamps overshoots by repeating the last page (dedup-on-zero-added stop handles this).

**Odoo sitemap over-count quirk**: `/sitemap.xml` includes out-of-stock products, but the storefront hides them via `hide_out_of_stock=1`. Expect sitemap counts to be ~5-10% higher than a live catalog walk. **Catalog walk is ground truth** for `expectedProductCount`, not sitemap `<loc>` count.

**Fleet observation on platform misidentification**: 11/21 audited sites have had wrong WAF flags OR wrong platform tags at onboarding. Treat stored `platform` tags with the same suspicion as stored `wafType` — re-verify by reading HTML generator meta tag + theme markers before trusting any stored value.

**Lesson**: Before starting Phase 2 of any audit, grep the HTML for `<meta name="generator">` and all known platform markers (`BCData` → BC Blueprint, `stencil`+`cdn11.bigcommerce` → BC Stencil, `catalog/view/` → OpenCart, `static/version` + `requirejs-config` → Magento 2, `BCData` without version → Magento 1, `oe_website_sale` → Odoo, `mysimplestore` or `godaddy-ols` → GoDaddy OLS SPA, `Stencil.storefrontAPIToken` → BC Stencil with GraphQL API, `lightspeed` / `shoplightspeed` → LightSpeed). **If any marker contradicts the stored `platform` tag, the stored tag is WRONG — verify before proceeding.**

### Mistake 23 — Declaring `hasWaf: false` from a single 200 response
**Sites**: nordicmarksman.com (site 19), northprosports.com (site 20), outfitters.goldnloan.com (site 21) — all initially mis-flagged as `hasWaf: false` because the audit stopped at the first 200 response without inspecting response headers or running a multi-request probe.
**What happened**: On all three sites, a single `GET /` with a desktop Chrome UA returned HTTP 200 with product HTML. The audit concluded "no WAF" and cleared `hasWaf`, `wafType`, `needsPlaywright`, `wafWorkaround`. But all three sites actually have Cloudflare in front of them (`server: cloudflare` + `cf-ray: <hash>-YYZ` headers visible on every response). The heavy WAF probe (8-batch procedure, documented in Phase 1 above) immediately caught this on probe #1.
**Why it matters**:
1. A single 200 proves *"this request was not challenged"* — not *"this site has no WAF."*
2. Many WAFs are behavior-based (rate limit, OWASP CRS, path-selective, bot fingerprint) and don't fire on a single probe.
3. `hasWaf: false` routes the site through the **5KB HTML fallback threshold** at `catalog-crawler.ts:404`. If a WAF later activates and returns a small challenge page (~3KB), the fallback won't trigger Playwright — the site silently stalls for hours until `consecutiveFailures` + `applyBackoff` catch it.
4. `hasWaf: true` routes the site through the **2KB threshold** at `catalog-crawler.ts:416` with a 45s Playwright timeout — instant recovery when WAF fires.
5. Even Cloudflare "passive" (headers present, no active filtering) should be `hasWaf: true` because CF can be activated at any moment by the site owner.

**Fix**: Run `backend/scripts/heavy-waf-probe.sh <target>` (8-batch probe). Record:
- `hasWaf`: true if ANY WAF-vendor header (`cf-ray`, `x-sucuri-id`, `x-amzn-*`, `x-waf-*`) is present OR ANY probe returns 403/503/challenge — regardless of whether filtering is active today
- `wafType`: vendor name (`cloudflare-active`, `cloudflare-passive`, `sucuri`, etc.)
- `wafLastProbedAt`: ISO timestamp
- `wafProbeMethod`: `'heavy-8-batch'`
- `wafProbeResult`: one-line verdict
- `wafProbeEvidence`: structured data (header detected, rate-limit fired, honeypot blocked, etc.)

**Corollary — NOT blanket tagging**: Setting `hasWaf: true` for all sites is wrong. The rule is **verify via heavy probe, then set**. If the heavy probe finds NO WAF headers on any response AND no batch fires a challenge, `hasWaf: false` is correct. The point of the heavy probe is to distinguish *"genuinely no WAF"* from *"one lucky 200."*

**Lesson**: Single-shot WAF probes are insufficient. The heavy probe is mandatory for every audit. When re-verifying old sites where `hasWaf: false` was set before 2026-04-08, treat the flag as UNVERIFIED and re-run the heavy probe.

### Mistake 24 — Volusion sort param is silently ignored unless `searching=Y` is also present
**Site**: precisionoptics.net (Volusion legacy hosted eCommerce)
**What happened**: The audit read the `<select id="SortBy">` HTML and found the newest-first option has `value="3"`. Building `?sort=3&show=90&page=N` seemed sufficient — but all sort values returned IDENTICAL ordering (the default `Availability` / `sort=11`). The sort param was being silently ignored. A strict Mistake 21 lookalike — the dropdown was telling the truth, but the URL format was incomplete.
**Reality**: Volusion's category controller only honors the `sort` parameter when `searching=Y` is ALSO present in the query string. This is visible in the inline JS at `/a/j/productlist.js` where `Refine()` rebuilds URLs from `SearchParams` which always hardcodes `searching=Y&sort=11&...`. Without the `searching=Y` flag, the controller treats the request as a plain category browse and uses the default sort (Availability), silently discarding the `sort` parameter.
**Fix**: Build Volusion catalog URLs as:
```
{path}?searching=Y&sort={N}&show={N}&page={N}
```
Example: `/category_s/662.htm?searching=Y&sort=3&show=90&page=1` → returns products sorted newest-first.

Verified via ID-jump test on precisionoptics.net `/category_s/662.htm`:
- `?sort=3` (no searching=Y): first products = Beretta_686 → Benelli_Super_Black_Eagle → Benelli_Nova_3 (default Availability order, sort ignored)
- `?searching=Y&sort=3`: first products = Benelli_Nova_Pump → Benelli_M2_Tactical → Benelli_M4_Tactical (newest order)
- `?searching=Y&sort=4` (Oldest): first products = Beretta_686 → Benelli_Super_Black_Eagle → Benelli_Nova_3 (matches first test above — confirms default was Availability, NOT oldest)
- Different first products across sort values ONLY when `searching=Y` is present → quirk confirmed.

**Why it matters**: This is a legacy Volusion platform quirk (early-2000s-vintage hosted eCommerce). Common Volusion sort values: `1=Price Low→High`, `2=Price High→Low`, `3=Newest`, `4=Oldest`, `5=Most Popular`, `7=Title`, `9=Manufacturer`, `11=Availability (default)`. But the values are **inert without `searching=Y`** — exactly the kind of trap that Mistake 2 ("read the HTML") catches for the param name but not for the activation flag.

**Lesson**: On Volusion sites, the sort audit is a THREE-step process:
1. Read `<select id="SortBy">` HTML and find the `value=` attribute for "Newest" per Mistake 2
2. Build the full URL as `?searching=Y&sort={N}&show={N}&page={N}` — the `searching=Y` flag is mandatory
3. ID-jump verify with `searching=Y` present — if ordering still doesn't change, the flag or the sort value is wrong

**Also**: `show={N}` controls products per page (max typically 90 on Volusion). `page={N}` starts at 1. Pagination is `query` type, template `'page'`, Mistake 14 compliant.

**Platform signature**: `x-powered-by: Volusion` response header, `/v/vspfiles/` asset paths, `volusion.js`, `volses` cookie, `cdn4.volusion.store` CDN, URL patterns like `/category_s/NNN.htm` and `/ProductDetails.asp?ProductCode=XXX`. If you see any of these, you're on Volusion and the `searching=Y` rule applies.

**Fleet note**: Volusion is obscure (1 site in the 34-site fleet so far — precisionoptics.net). This lesson is narrow but saves ~30 min of "why isn't sort working" debugging when the next Volusion site appears. Cross-references: Mistake 2 (read HTML), Mistake 21 (OpenCart dropdown-incomplete pattern — similar but different root cause), Mistake 20 (Magento merchant-customizable — similar but different quirk).

### Mistake 25 — Searchspring overlay hijacks URL sort semantics; real sort lives in a hash fragment
**Site**: sail.ca (Magento 2 + Searchspring overlay `siteId=s8zq1c`)
**What happened**: sail.ca is a stock Magento 2 install, so the audit initially tried the standard Magento URL sort params:
- `?product_list_order=created_at&product_list_dir=desc`
- `?sort=created_at`
- `?sort.created_at=desc`
- `?product_list_order=new&product_list_dir=desc` (the merchant-customized value seen on site 18 londerosports)

**All four variants returned IDENTICAL ordering** — the same "Best Selling" default. Mistake 20 discipline (read the `<select id="sorter">` HTML) got confusing because the sort control was an Angular `<select>` with `ng-options` and values `0/1/2/3` rather than the stock Magento option values. The actual sort mechanism wasn't a URL query param at all.

**Reality**: the page loads a third-party JS overlay from Searchspring:
```html
<script src="//cdn.searchspring.net/search/v3/js/searchspring.catalog.js?s8zq1c"
        hierarchy="Hunting>Firearms"></script>
```
When the user clicks "Newest" in the dropdown, Searchspring's JS **replaces the URL hash fragment** with `#/sort:created_at:desc` and re-fetches products from its own JSON API at `https://<siteId>.a.searchspring.io/api/search/search.json`. The native Magento category controller never sees the sort param — it's handled entirely client-side by Searchspring.

**Proof via Playwright ID-jump**:
- `#/sort:created_at:desc` page 1: tikka-t1x-...1618256, winchester-xpert-...1608993 (7-digit IDs ≥ 1,500,000, 2026 dates)
- `#/sort:created_at:desc` page 22 (last): sako-gamehead-...1356073 (6-7 digit IDs ≤ 1,400,000, 2024 dates)
- ASC sort via direct Searchspring API: remington-...690195, winchester-...632287 (oldest 3-6 digit IDs)

Monotonic ID increase asc→default→desc confirms `created_at` is a true date sort, not a popularity alias.

**Fragment preservation is free**: Node's `URL` class preserves hash fragments through `searchParams.set()`, so `buildPaginatedUrl()` at `catalog-crawler.ts:118-166` works unchanged. Example:
```js
new URL('https://www.sail.ca/en/hunting/firearms#/sort:created_at:desc').searchParams.set('page', '3').toString()
// → 'https://www.sail.ca/en/hunting/firearms?page=3#/sort:created_at:desc'
```
This matches sail.ca's native pager output byte-for-byte.

**Fix for this and any future Searchspring-overlaid site**:
1. Bake the hash fragment into each `catalogUrl` in the profile: `/en/hunting/firearms#/sort:created_at:desc`
2. Set `sortParam: ""` (empty — the adapter's `getNewArrivalsUrls` would otherwise append a useless Magento URL suffix that's ignored)
3. Use normal query-based pagination (`paginationPattern: {type: 'query', template: 'page'}`); Node's URL class preserves the fragment automatically
4. Keep `needsPlaywright: true` — catalog is JS-injected (plain HTML has zero product cards)

**Detection signature** — grep any page HTML for:
```
cdn.searchspring.net/search/v3/js/searchspring.catalog.js?<siteId>
```
If present, trust NO URL sort params on the native platform. Sort is client-side JS, not server-side. Also worth noting: the sort dropdown may appear Angular-ish (`ng-options`, integer values 0/1/2/3) because Searchspring renders its own sort control on top of the platform UI.

**Cross-platform note**: Searchspring is used by Magento, BigCommerce Stencil, and Shopify stores. If you see it on BC or Shopify, the same rule applies — native platform sort params are overridden. Always render via Playwright, click "Newest" programmatically, then capture `page.url()` to discover the real fragment scheme.

**Cross-references**:
- Mistake 2 (read the HTML) — doesn't help directly because the sort control is Angular-templated, not a native `<select>`
- Mistake 18 (cross-reference DOM ordering) — the right fallback when no URL param works: render via Playwright, drive the UI, capture the resulting URL
- Mistake 19 sub-lesson (drive Playwright as a real user) — this is the procedure to use
- Mistake 20 (merchant-customized Magento sort values) — similar in appearance but different root cause; Searchspring isn't Magento-customization, it's a platform-layer bypass
- Alflahertys Klevu pattern (site 1) — similar architecture (JS overlay hijacks native catalog) but Klevu exposes a clean JSON API that we call directly; Searchspring also exposes a JSON API but we can reach the HTML via hash-fragment URLs without calling the API

**Lesson summary**: When a JS overlay (Searchspring, Klevu, Algolia Search, Constructor.io, etc.) replaces the native catalog renderer, the URL contract changes. Always check for third-party JS layer signatures in the HTML BEFORE assuming the native platform's URL sort/pagination works.

---

### Mistake 26 — LightSpeed eCom (hosted) silently ignores `?page=N`; pagination pattern must bake sortParam into the suffix template
**Site**: solelyoutdoors.com (LightSpeed eCom hosted, shop 613284, Nova theme)
**What happened**: the existing profile had `sortParam: '?sort=newest'` and **no** `paginationPattern`. `buildPaginatedUrl` therefore fell through to the default query-style branch, producing URLs like `/firearms/non-restricted/?sort=newest&page=2`. LightSpeed's category controller silently ignores the `page` query parameter — page 2 returned **byte-for-byte identical products** to page 1. Consequence: T1 watermark was only ever seeing the first 24 newest items per category, missing everything from page 2 onwards until full catalog refresh eventually picked them up.

**Compounding factor — the `sortParam` × `suffix-replace` interaction**: the obvious fix is `paginationPattern: {type: 'suffix-replace', match: '.html', template: 'page{N}.html'}` (matches site 9 fulcrum-outdoors and site 11 gagnonsports precedents). But `GenericRetailAdapter.getNewArrivalsUrls` at `generic-retail.ts:215-220` appends `profile.sortParam` (`?sort=newest`) to every catalogUrl **before** handing them to the watermark crawler. So the T1 input URL is `/firearms/non-restricted/?sort=newest`, which doesn't end in `.html`. With match `.html`, `buildPaginatedUrl` at `catalog-crawler.ts:127-136` falls into the append branch → `baseUrl + 'page2.html'` → `/firearms/non-restricted/?sort=newestpage2.html` — the sort value and filename are concatenated with no separator. Garbage URL, 404 or page 1 default.

**The working pattern**: anchor `match` on the sort query segment itself, and bake the sort into the template.
```json
{"type": "suffix-replace", "match": "?sort=newest", "template": "page{N}.html?sort=newest"}
```
- **T1 watermark path** (URL arrives with `?sort=newest` already appended): match finds `?sort=newest`, strips it, appends `page{N}.html?sort=newest` → `/firearms/non-restricted/page2.html?sort=newest` ✓
- **T2-4 catalog path** (URL arrives bare, `getCatalogUrls` does NOT inject sortParam): match `?sort=newest` not found → falls to append branch → `baseUrl + 'page2.html?sort=newest'` → `/firearms/non-restricted/page2.html?sort=newest` ✓ (trailing `/` of the bare URL joins cleanly with `page2.html`)

Both paths produce the same correct URL.

**LIVE verification on solelyoutdoors.com 2026-04-08**:
- `/firearms/non-restricted/` walked all 7 pages: **146 unique products**, zero overlap page-to-page (24+24+24+24+24+24+2=146)
- `/firearms/shotguns/` walked all 6 pages: **128 unique products** (24+24+24+24+24+8=128)
- Default (popular) first product: `norinco-type-81-sr-762x39-semi-auto`
- `?sort=newest` first product: `morisson-lever-action-22lr-walnut-18bbl` (ID-jump confirms real date sort)

**Detection signature** — LightSpeed eCom hosted (Nova theme):
- `cdn.shoplightspeed.com/shops/<shopId>/themes/` in HTML
- `class="fancy-select"` widgets
- `<select name="sort">` with options `default, popular, newest, lowest, highest, asc, desc`
- `<form id="sort_filters">` with no `action=` (submits to current URL as GET)
- Product URLs at site root: `/<product-slug>.html`
- Category URLs as directories with trailing `/`: `/firearms/non-restricted/`
- Pagination links in HTML as `page2.html`, `page3.html`, etc.

**Test procedure before writing a `paginationPattern` for any hosted LightSpeed eCom site**:
1. Fetch `{cat}/?sort=newest` → capture first product slug
2. Fetch `{cat}/?sort=newest&page=2` → compare first product slug
3. If identical → `?page=N` is silently ignored, MUST use `page{N}.html` suffix
4. Fetch `{cat}/page2.html?sort=newest` → verify different first product + zero overlap with page 1
5. Write `paginationPattern: {type: 'suffix-replace', match: '<exact sortParam incl. leading ?>', template: 'page{N}.html<exact sortParam incl. leading ?>'}`
6. Run `buildPaginatedUrl` locally against BOTH a bare catalogUrl and a sort-appended catalogUrl and confirm both produce the same correct URL

**Why this wasn't caught earlier on site 9 (fulcrum-outdoors) or site 11 (gagnonsports)**: those earlier LightSpeed audits used `match: '.html'` because their `sortParam` was empty or the fallback append produced a working URL by accident. The interaction only breaks when `sortParam` is non-empty AND ends before the pagination segment AND the adapter appends it before `buildPaginatedUrl` runs.

**Cross-references**:
- Mistake 2 (read the HTML sort `<select>` first) — got us `?sort=newest` correctly
- Mistake 14 (paginationPattern template format) — `{N}` is uppercase, param/suffix form matters
- Fulcrum-outdoors site 9 precedent — suffix-replace pagination on LightSpeed eCom (no sortParam)
- Gagnonsports site 11 precedent — suffix-replace fallback via append branch for bare category URLs
- `catalog-crawler.ts:118-166` (`buildPaginatedUrl`)
- `generic-retail.ts:209-239` (`getNewArrivalsUrls` — the sortParam injector)

**Lesson summary**: For ANY site with a non-empty `sortParam` AND a suffix-replace pagination scheme, always test `buildPaginatedUrl` against BOTH the bare catalogUrl AND the sort-appended catalogUrl. If the same pattern can't produce the correct paginated URL from both inputs, you need to bake the sortParam into the suffix template so the T1 watermark path works correctly. And never assume query-style `?page=N` works on hosted LightSpeed eCom — always verify with a live page-2 ID-jump test.

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
