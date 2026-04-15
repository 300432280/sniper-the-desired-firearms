---
name: pre-bootstrap
description: Automated site onboarding — runs probes, applies judgment, builds siteProfile, validates, and writes to DB
---

# Pre-Bootstrap Site Onboarding

## Usage

```
/pre-bootstrap <url>
```

Takes a site URL, runs the mechanical probe script, applies judgment from 35 playbook mistake patterns, builds a complete `siteProfile`, validates it, and writes to the database.

## Design Principles (non-negotiable)

1. **Generic** — no firearm/gun/ammo keywords in this skill's logic. Domain-specific category selection is the operator's responsibility, not this skill's.
2. **Profile is single source of truth** — every site-specific quirk lives in the profile JSON. Never hardcode `if (domain === '...')`.
3. **Schema versioned** — every profile gets `profileVersion: 1` (current version from `profile-validator.ts`).
4. **Per-field confidence** — every judgment field records confidence as `verified` / `inferred` / `default`.
5. **Validation gate before bootstrap** — profile must pass `validateSiteProfile()` before DB write. No exceptions.
6. **`hasWaf` is a DB COLUMN, not just a profile field** — always update BOTH `site.hasWaf` (the column) and `siteProfile.hasWaf` (the JSON field). The column is what `crawl-scheduler.ts:209,282,576` passes to crawlers.

## Step-by-Step Process

### Step 1: Run the probe script

```bash
cd backend && npx tsx scripts/pre-bootstrap-probe.ts <url> 2>/dev/null
```

Parse the JSON output from stdout. The probe runs 7 mechanical phases:
- Phase 1: Access (WAF, redirects, robots.txt)
- Phase 2: Platform detection (markers, APIs, rendering mode)
- Phase 3: Adapter selection (API accessibility, extraction test)
- Phase 4: Category discovery (nav links, API taxonomy, sitemap)
- Phase 5: Sort parameter discovery (HTML select reading, ID-jump test)
- Phase 6: Pagination discovery (pattern detection, overlap test)
- Phase 7: Product count (API count, sitemap count, walk estimate)

If any phase failed or returned low-confidence results, note it for manual investigation in subsequent steps.

**File**: `backend/scripts/pre-bootstrap-probe.ts`

### Step 2: Platform-specific judgment

For **known platforms** (WooCommerce, Shopify, BigCommerce Stencil), the probe produces a near-complete profile. Validate the probe results and move to Step 3.

For **unknown or ambiguous platforms**, apply these judgment rules:

#### Ecwid-on-WordPress (Mistake 31)
- **Detection**: `<script src="https://app.ecwid.com/script.js?<storeId>">` + `ec-store` classes + `wp-content/plugins/ecwid-shopping-cart/` assets
- **Action**: Drive Playwright to capture real XHR field names. NEVER guess from Ecwid v3 REST docs.
- **Key facts**: Sort field is `sortBy` (not `sortOrder`), values are camelCase (`addedTimeDesc`, `priceAsc`, etc.). Pagination is `offset`/`limit` body fields. No date fields on products.
- **Watermark**: `navigate-from-watermark` via `sortBy:'addedTimeDesc'` walk. `api-date-since-watermark` is NOT viable.
- **Script reference**: `backend/scripts/tb-real-ui4.ts` (canonical Ecwid UI-drive harness)

#### SPA sites (Mistake 19 + sub-lesson)
- **Detection**: Static HTML returns 0 products but site renders in browser.
- **Action**: MUST test production `fetchWithPlaywright()` before declaring "blocked". Check `generic-retail.ts` for existing platform selectors (Klevu, GoDaddy OLS, BC Stencil, Shoplightspeed, etc.). Check existing `lastWatermarkUrl` for evidence of prior successful crawl.
- **For sort/filter discovery**: Drive Playwright as a real user with `page.on('request', ...)` logging. Click sort dropdown, capture URL change + XHR body. Static HTML scans are the WRONG approach for SPAs.

#### Searchspring overlay (Mistake 25)
- **Detection**: `<script src="//cdn.searchspring.net/search/v3/js/searchspring.catalog.js?<siteId>">`
- **Action**: Trust NO native platform URL sort params. Render via Playwright, click "Newest" programmatically, capture `page.url()` to discover hash-fragment scheme (e.g. `#/sort:created_at:desc`).
- **Fix**: Bake hash fragment into each catalogUrl, set `sortParam: ""` empty, use query pagination.

#### Custom PHP / legacy sites (Mistakes 15, 18)
- **Action**: Cross-reference DOM order against known signals (POST endpoint baseline, sitemap lastmod, RSS, known-recent product). "No sort UI" does NOT mean "no sort possible." Run ONE cross-reference test before concluding `navigate-from-watermark` is impossible.

#### Celerant / ColdFusion storefronts (Mistake 36)
- **Detection signals** (ALL from Phase 1 probe output):
  - `platformMarkers` contains `celerant-coldfusion`, `coldfusion`
  - `wafProbeEvidence.setCookieMarkers.cfid` and `.cftoken` = `true` (CFID + CFTOKEN session cookies on every response)
  - `wafProbeEvidence.serverHeader` = `"Null"` (literal string — ColdFusion's default when the admin blanks the Server header)
  - `access.malformedHeaders.value` = `true` (ColdFusion sends trailing-space headers like `X-Frame-Options : SAMEORIGIN` → axios fails with `HPE_INVALID_HEADER_TOKEN`)
  - Homepage HTML contains `celerantwebservices.com/jquery/*` asset URLs (confirms Celerant vendor specifically; plain ColdFusion without Celerant will not have this)
- **Key profile fields to set**:
  - `platform: 'celerant-coldfusion'` (NOT generic `coldfusion` — the vendor-specific tag lets fleet-wide queries target Celerant-specific quirks)
  - `adapterType: 'generic-retail'` (Celerant has no open API)
  - `hasWaf: false` if probe shows all 200s with CFID/CFTOKEN and no cf-ray/x-sucuri/visid_incap
  - **`wafWorkaround`**: MUST be set to `{ method: 'undici-fallback', notes: 'Celerant/ColdFusion sends malformed HTTP/1.1 headers (trailing whitespace before colons like "X-Frame-Options : SAMEORIGIN"). Node's llhttp parser throws HPE_INVALID_HEADER_TOKEN. Project http-client.ts catches "Parse Error" from axios and falls back to native fetch via nativeFetchFallback() at lines 277-302. Playwright NOT required.' }`. This field is INFORMATIONAL — the production code path at `http-client.ts:344-347` handles it automatically, but the workaround must be recorded so future auditors understand why every fetch log line contains "Parse Error".
  - `needsPlaywright: false` (the native-fetch fallback is sufficient; do NOT set true)
- **Sort scheme**: `sort.sortScheme.value === 'path'` — Celerant encodes sort in the URL PATH as `/orderby/<value>/`, NOT as a query parameter. Profile must have `sortParam: ""` (empty, because sort is already baked into the catalogUrl) and each `catalogUrl` must include `/orderby/<value>/perpage/<N>` segments.
- **Sort option disambiguation**: Celerant sites typically expose BOTH `new-arrivals` (= newest added to storefront) AND `newest-rcvd` (= newest received by warehouse) as newest-style options. Both match the newest regex. The probe ranks candidates via ID-jump score — the canonical merchant-sort in the fleet (3 Celerant sites verified) is `new-arrivals`. If the probe's `sort.newestCandidates[0].value` differs from `new-arrivals`, re-run the ID-jump manually: compare `/orderby/new-arrivals/perpage/36` first-product vs `/orderby/newest-rcvd/perpage/36` first-product and see which one matches the merchant's expectation of "newest" (usually the one with the HIGHEST numeric ID in the product slug — Celerant item IDs are monotonically incrementing integers).
- **Pagination**: `paginationPattern: { type: 'path', template: '/page/{N}' }` — and the `/page/{N}` segment attaches AFTER the `/orderby/<value>/perpage/<N>` segment (e.g. `/all-products/browse/orderby/new-arrivals/perpage/36/page/2`).
- **Product count**: Celerant renders the `<select id="perpage">` with a dynamic final option `value="<N>" label="All"` where N is the total storefront-visible count. Extract via regex `/value="([0-9]+)"[^>]*>\s*All\s*<\/option>/`. This is MORE reliable than walking pagination or the sitemap:
  - Sitemap over-counts by ~20-25% because it includes out-of-stock special-order items hidden from browse listings.
  - Walking pagination gives a dedupe-noisy count (3,114-3,117 unique vs the "All" option's 3,117-3,153 — values fluctuate per request due to cache jitter).
- **CatalogUrl strategy**: a single top-level URL `/all-products/browse/orderby/<canonical-newest>/perpage/36` usually covers 100% of storefront-visible products. Verify by: (a) reading the `<select id="perpage">` "All" option for ground truth, (b) walking pages until extraction returns 0 products, (c) confirming the deduped count matches "All" within ±3 (cache jitter tolerance).
- **Watermark**: `navigate-from-watermark` via path-based sort `/orderby/<canonical-newest>/`. `api-date-since-watermark` NOT viable (no API). Source ID extraction: product URLs are `/shop/<slug>-<numericId>`; the numeric ID at the end is the stable Celerant item ID. The regex `/-(\d{4,})(?:[?#]|$)/` at `generic-retail.ts:1028` matches this.
- **Product URL forms**: Celerant exposes each product via TWO URL forms — canonical `/shop/<slug>-<id>` (from listings) AND `/<brand>/<slug>-<id>` (from sitemap). Both return the same detail page. The sourceId extractor handles both.
- **Reference audit**: `bullseyenorth.com` profile (2026-04-14 manual audit, 3,117 active products, 87 pages walked via `/all-products/browse/orderby/new-arrivals/perpage/36`, zero overlap on page 2).

### Step 3: CatalogUrl selection

Use the probe's category tree + nav links output as starting material.

#### Rules
1. **100% coverage** — NEVER drop small categories. Even categories with 1 product must be included if the parent URL doesn't show child products. 92% coverage is NOT acceptable. (From `feedback_full_coverage.md`)
2. **Minimum overlap** — pick the highest-level URLs that cover all products without duplication. "Minimum overlap" means don't duplicate, NOT "skip small ones."
3. **Test parent-child inclusion** — on WooCommerce, `/product-category/parent/` usually includes child products. On BC Stencil, parent pages may show subcategory tiles instead of child products. Walk both parent and child, compare product slug sets.
4. **Verify extraction** — for each candidate catalogUrl:
   - Fetch with verified UA
   - Run the production adapter's `extractCatalogProducts($, url)` (NEVER write custom selectors)
   - Confirm products with title + URL + price are returned
   - Get page count via pagination markers
5. **Platform-specific traps**:
   - Wix Stores: use ONLY `/shop` URL — sub-category pagination leaks to global order (Mistake 27)
   - Ecwid: parent categories in COLLAPSED view show subcategory tiles, not products (Mistake 31)

### Step 4: Sort verification (judgment calls)

Use the probe's ID-jump results. Apply the **3-outcome decision tree** (Mistake 29):

| Outcome | Test | Action |
|---|---|---|
| `honored` | `?sort=newest` first != default first, AND differs from `?sort=alphaasc` first | `sortParam` set, `navigate-from-watermark` |
| `honored (default=newest)` | `?sort=newest` first == default first, BUT `?sort=alphaasc` first differs | Sort IS honored, default just equals newest. `sortParam` set. Document in notes. |
| `noop-small` | All three identical AND category <= 20 products | Normal behavior, not a bug. Sort irrelevant for single-page categories. |

#### Platform-specific sort traps

| Platform | Trap | Rule | Mistake |
|---|---|---|---|
| OpenCart | Visible dropdown is incomplete | ALSO probe `?sort=p.date_added&order=DESC` directly even if not in `<select>` | 21 |
| Magento | Values are merchant-customizable | Read `<select id="sorter">`, use actual `value=` attribute. NEVER assume `created_at` | 20 |
| Volusion | Sort silently ignored without `searching=Y` | URL must be `{path}?searching=Y&sort={N}&show={N}&page={N}` | 24 |
| Searchspring | Hash-fragment sort | Real sort is `#/sort:field:direction`, not query param | 25 |
| Shopify | Sort uses `published_at`, not `created_at` | Test ALL timestamp fields for strict monotonicity | 32 |
| BC Stencil | False negative on default=newest | Use `?sort=alphaasc` as counter-control. 3-outcome test, not 2 | 29 |
| Celerant/ColdFusion | Sort is in URL PATH (`/orderby/<value>/`), not query param. Multiple newest-style options (`new-arrivals` vs `newest-rcvd`) produce different orderings. | `sortScheme: 'path'`. Use probe's `newestCandidates[0]` (highest ID-jump score) OR verify manually — canonical fleet sort is `new-arrivals`. | 36 |
| SPA (any) | Sort controls are JS, not markup | Drive Playwright UI with `page.on('request', ...)`, don't scan static HTML | 19 |
| Custom PHP | No sort UI != no sort possible | Cross-reference DOM order against independent signals | 15, 18 |

### Step 5: Pagination verification (judgment calls)

Use the probe's zero-overlap results. Verify the correct `paginationPattern` type:

| Pattern | Template format | Example |
|---|---|---|
| `query` | Param name only, NO braces, NO `?` | `template: 'page'` for `?page=N` |
| `path` | Full path with uppercase `{N}` | `template: '/page/{N}'` |
| `offset-query` | Param name + perPage | `template: 'top', perPage: 255` |
| `suffix-replace` | Literal match + template with `{N}` | `match: '.html', template: '-{N}.html'` |

**Template format rules (Mistake 14)**:
- `{N}` is UPPERCASE — lowercase `{n}` is never replaced
- For `query` type: template is the param NAME only (`'page'`), not `'?page={N}'`
- For `suffix-replace`: `match` is a literal string, not a regex

#### Platform-specific pagination traps

| Platform | Trap | Fix | Mistake |
|---|---|---|---|
| LightSpeed eCom | `?page=N` silently ignored | Use `suffix-replace` with `page{N}.html`. If `sortParam` exists, bake it into both `match` and `template` | 26 |
| Wix Stores | Sub-category pagination leaks to global `/shop` | Use ONLY `/shop` with `?page=N` | 27 |
| Volusion | Needs `searching=Y` for pagination to work with sort | Include `searching=Y` in URL | 24 |

**Verification**: pagination MUST work WITH sort param applied. Fetch page 1 + page 2 with sort, confirm zero product overlap.

### Step 6: Watermark method selection

| Condition | Method | Notes |
|---|---|---|
| WooCommerce with WP REST or Store API `after` filter | `api-date-since-watermark` | Verify date filter is monotonic (Mistake 34: verify fallback trigger fires) |
| Shopify with `published_at` monotonic | `api-date-since-watermark` | Use `published_at`, NOT `created_at` (Mistake 32) |
| Sort proven newest-first + survives pagination | `navigate-from-watermark` | Requires `sortParam` set |
| No sort, no API date filter | `full-catalog-sweep` | MUST document reason in `crawlers.watermark.reason` |
| Ecwid with `sortBy:'addedTimeDesc'` | `navigate-from-watermark` | Via storefront API offset walk |

**Always verify the fallback trigger fires** (Mistake 34): trace the exact code path. `apiCrawlUsed` flag at `catalog-crawler.ts:292` prevents HTML fallback when API returns empty `{ products: [], totalPages: N }` instead of `null`. "Architecture says fallback exists" is not proof it fires for the specific failure mode.

### Step 7: Assemble profile

Build the complete siteProfile JSON. Required fields (from `backend/src/services/profile-validator.ts`):

```
platform               — non-empty string
hasWaf                  — boolean (explicit true/false)
expectedProductCount    — positive number
catalogUrls             — non-empty array
paginationPattern       — object with valid type (query/path/offset-query/suffix-replace/null)
perPage                 — positive number (or null for API-only)
adapterType             — one of: woocommerce, shopify, generic-retail, classifieds-gunpost,
                          forum-xenforo, forum-vbulletin, auction-hibid, auction-icollector,
                          auction-generic, generic
crawlers.watermark.method — one of: navigate-from-watermark, api-date-since-watermark,
                            full-catalog-sweep
sortVerified/sortParam  — sortVerified=true or sortParam set (unless full-catalog-sweep with reason)
```

Recommended fields:
```
wafType                 — when hasWaf=true
wafLastProbedAt         — ISO timestamp
productCountMethod      — how expectedProductCount was obtained
lastVerified            — ISO date string
profileVersion          — 1 (current schema version)
sortParam               — when watermark method is navigate-from-watermark
extractionTested        — true for at least one catalogUrl
```

Additional fields based on platform:
```
wafProbeMethod          — 'heavy-8-batch'
wafProbeResult          — one-line verdict
wafProbeEvidence        — structured data from probe
userAgentOverride       — iPhone Safari string if WAF requires it
needsPlaywright         — true if static HTML returns 0 products
ecwidStoreId            — for Ecwid sites
ecwidStorefrontApiBase  — for Ecwid sites
apiAlternative          — for sites with non-standard API
```

Per-field confidence scoring:
- `verified` — proven via live test (ID-jump, walk, API response)
- `inferred` — derived from platform detection or probe output without direct test
- `default` — set to a safe default, not yet verified

### Step 8: Validate

Run validation:

```typescript
import { validateSiteProfile } from '../src/services/profile-validator';
const result = validateSiteProfile(profile);
```

**File**: `backend/src/services/profile-validator.ts`

The validator checks 16 fields across required and recommended tiers:
- **Required** (9): platform, hasWaf, expectedProductCount, catalogUrls, paginationPattern, perPage, adapterType, crawlers.watermark.method, sortVerification
- **Recommended** (7): wafType, wafLastProbedAt, productCountMethod, lastVerified, profileVersion, sortParam, extractionTested

If any **required** check fails, the profile is invalid. List the specific gaps and ask the user for guidance before proceeding.

If only **recommended** checks fail (warnings), proceed but report the warnings.

### Step 9: Write to DB

Write a one-shot `.js` script (Windows requires `.js` files for Prisma operations — never inline `node -e`).

The script must:
1. Find or create the `MonitoredSite` record by URL
2. Set `siteProfile` to the validated JSON
3. Set `hasWaf` DB column (not just profile field)
4. Set `adapterType` on the DB record
5. Set `crawlPhase: 'bootstrap'`
6. Report the write result to stdout

Example template:
```javascript
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const profile = { /* ... validated profile ... */ };

  const site = await prisma.monitoredSite.upsert({
    where: { url: '<canonical-url>' },
    update: {
      siteProfile: profile,
      hasWaf: profile.hasWaf,
      adapterType: '<adapter>',
      crawlPhase: 'bootstrap',
    },
    create: {
      name: '<site-name>',
      url: '<canonical-url>',
      siteType: '<type>',
      siteProfile: profile,
      hasWaf: profile.hasWaf,
      adapterType: '<adapter>',
      crawlPhase: 'bootstrap',
      enabled: true,
    },
  });
  console.log('Written site:', site.id, site.name);
}

main().catch(console.error).finally(() => prisma.$disconnect());
```

After running, verify by querying the DB to confirm the profile was written correctly.

---

## Decision Rules from All 35 Playbook Mistakes

These rules are encoded in priority order. When multiple rules apply, follow the more specific one.

### Access & WAF (Mistakes 3, 7, 23, 28, 30, 35)

| # | Rule | Trigger |
|---|------|---------|
| M23 | Heavy 8-batch WAF probe is MANDATORY before setting `hasWaf` | Every site, no exceptions |
| M35 | ANY stored `wafType` from pre-audit era is UNVERIFIED | Stored `wafType: 'sucuri'` is MORE likely wrong than right |
| M3 | Never trust stale WAF/captcha flags — re-verify against live response headers | Any existing site being re-audited |
| M7 | Test at least 4-5 UA/header combos before declaring "unreachable" | HTTP 403 on first attempt |
| M30 | SiteGround sgcaptcha: iPhone UA is load-bearing + waf-cookie-manager must wait for URL to leave challenge path | HTTP 202 + `sg-captcha: challenge` header |
| M28 | DB=0 sites: ALL stale signals re-verified (5-step mandatory order) before any other work | `dbCount === 0` or `dbCount / expectedCount < 10%` |

### Platform Detection (Mistakes 3, 22, 28, 31)

| # | Rule | Trigger |
|---|------|---------|
| M22 | Grep live HTML for `<meta name="generator">` + ALL known platform markers before trusting stored `platform` | Every site |
| M31 | Ecwid detection: `app.ecwid.com/script.js?<storeId>` + `ec-store` classes | WordPress site with Ecwid widget |
| M28 | Treat DB=0 sites as fresh onboarding, not re-verification | DB=0 |

**Known platform markers to grep for**:
- `BCData` -> BC Blueprint
- `stencil` + `cdn11.bigcommerce` -> BC Stencil
- `catalog/view/` -> OpenCart
- `static/version` + `requirejs-config` -> Magento 2
- `oe_website_sale` -> Odoo
- `mysimplestore` or `godaddy-ols` -> GoDaddy OLS SPA
- `Stencil.storefrontAPIToken` -> BC Stencil with GraphQL
- `lightspeed` / `shoplightspeed` -> LightSpeed
- `generatedBy="WIX"` in sitemap / `server: Pepyaka` -> Wix
- `x-powered-by: Volusion` header / `/v/vspfiles/` -> Volusion
- `app.ecwid.com/script.js` -> Ecwid on WordPress

### Sort Parameter Discovery (Mistakes 2, 15, 18, 20, 21, 24, 25, 29, 31, 32)

| # | Rule | Trigger |
|---|------|---------|
| M2 | NEVER guess sort param names — read `<select>` / `<form>` HTML first | Every HTML-rendered site |
| M20 | Magento sort values are merchant-customizable — read `<select id="sorter">` | Platform = Magento |
| M21 | OpenCart dropdown is incomplete — probe `p.date_added` directly even if not in `<select>` | Platform = OpenCart |
| M24 | Volusion requires `searching=Y` in URL for sort to be honored | Platform = Volusion |
| M25 | Searchspring overlay -> sort is in hash fragment, not query param | `cdn.searchspring.net` detected in HTML |
| M29 | BC Stencil sort needs 3-outcome test with `alphaasc` counter-control | Platform = BC Stencil |
| M31 | Ecwid sort field is `sortBy` (camelCase), NOT `sortOrder` (uppercase) — drive UI to discover | Platform = Ecwid |
| M32 | Shopify sorts by `published_at`, not `created_at` | Platform = Shopify |
| M15 | Client-side paginated single-page: jPages/bootpag — set `paginationPattern: null` | Small catalog, JS pagination plugin detected |
| M18 | "No sort UI" != "no sort possible" — cross-reference DOM order | No `<select>` for sort found |

### Pagination (Mistakes 14, 15, 26, 27)

| # | Rule | Trigger |
|---|------|---------|
| M14 | Template format: `{N}` uppercase, `query` type uses param name only | Every paginationPattern |
| M26 | LightSpeed eCom: `?page=N` silently ignored — use suffix-replace, bake sortParam into template | Platform = LightSpeed eCom hosted |
| M27 | Wix Stores: sub-category pagination leaks — use only `/shop` | Platform = Wix Stores |
| M15 | jPages/bootpag: full catalog in initial HTML, set `paginationPattern: null` | JS client-side pagination detected |

### Product Count (Mistakes 1, 13, 29)

| # | Rule | Trigger |
|---|------|---------|
| M1 | Filter sitemap `<loc>` to product URL pattern only, HEAD-test 5 random entries | Counting from sitemap |
| M13 | Never trust stored `expectedProductCount` — re-verify via API/sitemap | Any existing site |
| M29 | BC Stencil page-1 regex counts are ALWAYS inflated (double-render) — use `sort -u` or production dedup | Platform = BC Stencil |

### CatalogUrl Selection (Mistakes 4, 5, 9, 12)

| # | Rule | Trigger |
|---|------|---------|
| M5 | Start from taxonomy/category tree, NOT from guessing category names | Every site |
| M4 | Never dismiss categories by name alone — verify with product keyword search | Category name looks irrelevant |
| M12 | Three-part process for dropping a "non-relevant" category: walk, filter, check uniqueness | Considering dropping a category |
| M9 | catalogUrls are for HTML fallback on API sites — API discovers all products independently | WooCommerce/Shopify API sites |

### Extraction Pipeline (Mistakes 11, 19)

| # | Rule | Trigger |
|---|------|---------|
| M11 | When extraction fails, trace full pipeline: selector -> title -> link -> isNavUrl -> isCategoryUrl | Low product count from adapter |
| M19 | Test production `fetchWithPlaywright()` before declaring SPA "blocked" | Static HTML returns 0 products |

### Watermark Method (Mistakes 8, 16, 17, 34)

| # | Rule | Trigger |
|---|------|---------|
| M8 | Verify page-1-is-newest by comparing IDs across pages | Setting `navigate-from-watermark` |
| M34 | Verify fallback trigger fires for the specific failure mode — trace `apiCrawlUsed` flag | Any API-based watermark method |
| M16 | Don't follow AJAX/SQL rabbit holes when plain GET returns the needed products | Small custom-PHP sites |
| M17 | Cursor field must be exposed to the client (in URL, HTML, or API response) | Proposing cursor-based watermark |

### Agent/Subagent Trust (Mistakes 11, 33)

| # | Rule | Trigger |
|---|------|---------|
| M33 | Subagent API findings MUST be independently verified with a single curl | Any subagent report about API accessibility |
| M11 | Never trust a previous agent's root-cause diagnosis — verify against live HTML | Any inherited diagnosis |

### Miscellaneous (Mistakes 6, 10)

| # | Rule | Trigger |
|---|------|---------|
| M6 | Retry each fetch at least once before declaring failure | HTTP error during walk |
| M10 | Don't hardcode keys that can rotate — build self-healing extraction from HTML | API keys (Klevu, etc.) |

---

## Quick Validation Checklist

Before declaring a site profile complete, all of these must be true:

- [ ] Heavy 8-batch WAF probe ran (`wafLastProbedAt` set, `wafProbeMethod: 'heavy-8-batch'`)
- [ ] Platform verified against live HTML markers (not just stored tag)
- [ ] `expectedProductCount` verified via API or sitemap (not stored guess)
- [ ] All `catalogUrls` return HTTP 200 with verified UA
- [ ] Each catalogUrl extracts >0 products via production adapter
- [ ] Pagination pattern verified by fetching page 2 (different products from page 1)
- [ ] Sort parameter found by reading page HTML (not guessing)
- [ ] Sort + pagination tested together (page 2 sorted IDs different from page 1)
- [ ] Watermark method matches verified capability
- [ ] Walked catalogUrls deduped total approximately equals `expectedProductCount`
- [ ] `hasWaf` set on BOTH DB column and profile JSON
- [ ] `profileVersion: 1` set
- [ ] `lastVerified` set to today
- [ ] `validateSiteProfile()` returns `valid: true`

---

## File References

| File | Purpose |
|------|---------|
| `backend/scripts/pre-bootstrap-probe.ts` | Mechanical 7-phase probe script |
| `backend/src/services/profile-validator.ts` | Validation gate (16 checks) |
| `backend/src/services/crawl-scheduler.ts` | Reads `site.hasWaf` DB column (lines 209, 282, 576) |
| `backend/src/services/catalog-crawler.ts` | `buildPaginatedUrl` (lines 118-166), HTML fallback (lines 327, 403-421) |
| `backend/src/services/watermark-crawler.ts` | Playwright fallback (lines 143-159) |
| `backend/src/services/scraper/adapters/generic-retail.ts` | `extractCatalogProducts`, `getNewArrivalsUrls` (lines 209-239) |
| `backend/src/services/scraper/waf-cookie-manager.ts` | Domain-agnostic WAF bypass (line 113+) |
| `backend/scripts/heavy-waf-probe.sh` | 8-batch WAF probe script |
| `.claude/catalog-url-discovery-playbook.md` | Full playbook with 35 mistakes |
| `.claude/agents/crawler-specialist.md` | Crawler specialist persona with critical lessons |
