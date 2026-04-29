---
name: project-next-tasks
description: Tasks for next session — 34-site audit continuation + future optimizations
type: project
---

## PRIMARY GOAL
Continue the 34-site profile audit, one site at a time, following `.claude/catalog-url-discovery-playbook.md`.

**Progress: 30/34 done.** See `34-site-audit-progress.md` for the tracker.

## 🚨 MANDATORY AT START OF NEXT SESSION (carry-over): retro-check sites 9 + 11 for Mistake 26 silent pagination bug
*(This task has been carried over across multiple sessions — still not done. Blocks next session until completed.)*

Sites 9 (fulcrum-outdoors.shoplightspeed.com, LightSpeed hosted eCom) and 11 (gagnonsports.com, LightSpeed Classic) were audited on 2026-04-07 BEFORE Mistake 26 was discovered. Both use LightSpeed and `suffix-replace` pagination patterns. Site 26 solelyoutdoors.com proved that LightSpeed eCom hosted **silently ignores `?page=N`** and that when `sortParam` is non-null AND the adapter pre-appends it via `getNewArrivalsUrls`, the `paginationPattern.match` must anchor on the sort query segment — otherwise T1 watermark crawls produce garbage URLs and silently return page 1.

**Risk**: if sites 9 and/or 11 have a non-null `sortParam` AND a `paginationPattern.match` that doesn't include the sort query segment (e.g. `match: '.html'`), T1 watermark has been silently only seeing page 1 of each catalog since onboarding.

**Retro-check procedure** (run first thing next session):
```bash
# 1. Dump current profiles for sites 9 and 11
cd backend
cat > scripts/check-ls-pagination.js <<'EOF'
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  for (const domain of ['fulcrum-outdoors', 'gagnonsports']) {
    const site = await p.monitoredSite.findFirst({ where: { domain: { contains: domain } } });
    if (!site) continue;
    const sp = site.siteProfile || {};
    console.log(`\n=== ${site.domain} ===`);
    console.log('sortParam:', sp.sortParam);
    console.log('paginationPattern:', JSON.stringify(sp.paginationPattern));
    console.log('catalogUrls[0]:', sp.catalogUrls?.[0]);
  }
  await p.$disconnect();
})();
EOF
node scripts/check-ls-pagination.js
rm scripts/check-ls-pagination.js

# 2. For each site, live-test the pagination pattern:
#    a) Fetch /category/?{sortParam}&page=2 → capture first product
#    b) Fetch /category/page2.html?{sortParam} → capture first product
#    c) If (a) === page 1 first product AND (b) !== page 1, this site is affected

# 3. If affected, apply the dual-path pattern:
#    paginationPattern: {type:'suffix-replace', match:'<exact sortParam>', template:'page{N}.html<exact sortParam>'}
```

**If either site is affected**, apply the Mistake 26 dual-path fix immediately:
- Update the profile with the corrected `paginationPattern`
- Verify by walking 2-3 pages end-to-end (check zero overlap via Set dedupe)
- Update the entry in `34-site-audit-history.md` with the retro-correction note
- Update the progress tracker row for that site

## NEXT IMMEDIATE TASK (after retro-check above)
**Site 31 — thegundealer.net** (full 7-phase audit)
- Suspected platform: **Shopify** (FIRST Shopify site in the 34-audit)
- **DB active: 0** — user has CONFIRMED the site is ALIVE (do NOT ask about disabling)
- Previous session notes said "domain may be defunct" — stale, user verified it's live
- Apply **Mistake 28** mandatory 5-step rule for DB=0 sites: heavy WAF probe → grep platform markers → re-verify notes claims → check sitemap/robots → walk homepage with production adapter (treat as fresh onboarding, not re-verification)
- Apply **Mistake 25** — grep HTML for third-party JS overlays before trusting native sort
- Apply **Mistake 29** — use production `extractCatalogProducts` URL Set dedupe, walk pagination end-to-end, 3-outcome sort verification with counter-control
- Use production `ShopifyAdapter` at `backend/src/services/scraper/adapters/shopify.ts` — don't write custom selectors
- Shopify-specific: try `/products.json?limit=250&page=N` first (public, no auth), `/sitemap_products_1.xml`, sort `?sort_by=created-descending`

## REMAINING 4 SITES (ordered per tracker)
31 thegundealer.net · 32 triggersandbows.com · 33 truenortharms.com · 34 wolverinesupplies.com

## PER-SITE PROCESS (locked rules)
1. Invoke `using-superpowers` skill before each response
2. Read profile → understand → state plan
3. Execute 6 phases on LIVE site (WAF → platform → count → catalogUrls → pagination → sort)
4. Verify everything on live site — no assumptions, no guessing
5. Use `crawler-specialist` persona for subagents; include persona + playbook inline
6. Phase-by-phase concise report in established format with catalogUrls listed
7. Write one-shot profile update script → run → verify → delete
8. Ask user before moving to next site

## USER RULES (locked this session)
1. Don't worry about gotenda /shop/ overlap
2. Check Magento sail.ca later when we reach it (URL filter fix benefit)
3. Maintain-phase sites — keep column as-is, don't force to bootstrap
4. If a site appears dead (DB=0, defunct), ASK before disabling
5. Verify everything on live sites in our system
6. Follow playbook AND verify myself (template bugs, etc.)
7. One at a time, no lazy assumptions, no guessing
8. Always invoke superpowers on every turn
9. When investigating a SPA, drive Playwright as a real user (click controls, capture XHRs) — Mistake 19 sub-lesson
10. Magento sort option values are merchant-customizable — always READ `<select id="sorter">` (Mistake 20)
11. Record every lesson learned in playbook + persona immediately

---

## FUTURE OPTIMIZATIONS — NOT BLOCKING, LOG AND DEFER

### 🐛 CODE FIX: generic-retail.ts extracts phantom products from Magento 2 sidebars on empty pages
**Discovered**: Site 23 / rdsc.ca audit (2026-04-08)
**Priority**: Medium — bounded today by `totalPages` from toolbar, but a real bug waiting to bite.
**Affected file**: `backend/src/services/scraper/adapters/generic-retail.ts` — `extractCatalogProducts($, baseUrl)` method

**What happens**: When the crawler walks past the real last page of a Magento 2 category (e.g. requesting `?p=100` on a 71-page category), the server still returns a valid 200 HTML page — but the main product grid (`.products.list.items`) is EMPTY. Magento 2 continues to render sidebar blocks on these pages:
- `.block-related` (Related Products)
- `.block-viewed-products` (Recently Viewed)
- `.block-upsell` (You May Also Like)
- `.related-items`
- `.block.crosssell`

The production adapter's generic product-card selectors (`[data-product-id]`, `.product-item`, `li.product`, etc.) MATCH items inside these sidebar blocks → adapter returns ~10-20 "products" per empty page × ~100 overflow pages = **~1,128 phantom products** on a single bad walk.

**Why it's bounded today (not critical)**:
- Production crawler uses `siteProfile.expectedProductCount` + toolbar-derived `totalPages` to bound walks to the real last page
- The coverage gate stops at the real last page for healthy crawls
- Only affects malformed/overflow walks (e.g. if `totalPages` detection fails)
- No downstream data corruption — phantom products have valid URLs, they just re-discover products the adapter already has

**Why it's worth fixing**:
- Safety net against future `totalPages` detection bugs
- Reduces log noise from "discovered N products" on empty pages
- Prevents false coverage inflation in bootstrap metrics
- Same phantom-extraction pattern may affect OTHER platforms too (BC Stencil's "Recently Viewed", Shopify's "You May Also Like", etc. — worth auditing)

**Proposed fix** (estimate: ~20-30 lines in `generic-retail.ts`):
1. In `extractCatalogProducts`, FIRST scope the cheerio traversal to the main product grid container:
   - Magento 2: `.products.list.items` or `.products-grid`
   - BC Stencil: `.productGrid` or `[data-product-list]`
   - Magento 1: `.products-list` or `.products-grid`
   - Shopify: `.grid--uniform` or `.collection-grid`
   - WooCommerce: `.products` or `ul.products`
2. If the main grid container is found: only match selectors WITHIN that subtree
3. If no main grid container found: fall back to current behavior (whole-page match) for platforms where we don't know the container
4. Add a debug log when extraction returns 0 products from the main grid but >0 from the whole-page fallback — this will flag misdetected containers early

**Alternative (simpler)**: Add a blacklist of sidebar container selectors to EXCLUDE during extraction:
```ts
const SIDEBAR_BLACKLIST = [
  '.block-related', '.block-viewed-products', '.block-upsell', '.block.crosssell',
  '.related-items', '.recently-viewed', '.crosssell', '.upsell',
  '[class*="related-products"]', '[class*="recently-viewed"]',
  '[class*="you-may-also-like"]',
];
// Exclude any element whose closest ancestor matches the blacklist
```
Simpler but brittle — new Magento/BC themes may use different class names. The main-grid-scoping approach is more robust.

**Verification plan**:
1. Write a test fixture: capture `/firearms-ammunition.html?p=100` HTML from rdsc.ca (page past the real last page)
2. Unit test: feed fixture to `extractCatalogProducts` → assert returns 0 (or ≤1-2) products
3. Unit test: feed fixture from `/new-products.html?p=1` → assert returns 24 real products
4. Live smoke test: walk rdsc.ca `/firearms-ammunition.html` to p1, p35, p70, p71, p72 → verify p72 returns 0 (not ~15 phantom products)
5. Regression test against sites 7, 19 (BC Stencil) and site 22 (Volusion) to confirm the change doesn't break their extraction

**Reference discovery**: Site 23 rdsc.ca audit 2026-04-08. During Phase 6 pagination verification, walked past `/firearms-ammunition.html?p=72` (real last page was p72 with 14 products, p73 is empty) and discovered the adapter returned ~15 "products" from sidebar sections. Not an rdsc-specific bug — this is a generic platform quirk that any Magento 2 / BC Stencil / Shopify site with "Recently Viewed" blocks could trigger on overflow walks.

**When to do it**: Can be scheduled independently of the 34-site audit. Not urgent — bootstrap coverage gate bounds it — but should be fixed before the audit wraps up so bootstrap metrics don't get polluted.

### 🚀 BigCommerce Stencil — scrape `Stencil.storefrontAPIToken` for GraphQL JSON path
**Discovered**: Site 19 / nordicmarksman.com audit (2026-04-08)

**Context**: BigCommerce Stencil sites expose a GraphQL Storefront API at `/graphql` which is enabled by default but requires a merchant-configured token (`X-Auth-Token` header). The token is embedded in every page's theme JS as `Stencil.storefrontAPIToken` (or similar variable, depending on theme version). We don't need merchant cooperation — the token is public, just scraped from any page HTML.

**Why it matters**:
- Plain HTTP + GenericRetailAdapter works (~7s per page via Playwright / ~1s via plain HTTP for Stencil sites with no WAF)
- GraphQL API would be **~10× faster per call** AND would return structured data: `id`, `name`, `sku`, `price`, `images`, `date_created`, `date_modified`, pagination via cursor
- Matches the liangjian.ca mysimplestore API pattern (Site 16 Phase 2) — 10× speedup measured live
- Would unlock `api-date-since-watermark` instead of `navigate-from-watermark` for BC Stencil fleet

**Applicable sites** (BC Stencil — re-verify each is actually Stencil, not Blueprint):
- Site 1: alflahertys.com → uses Klevu instead (N/A)
- Site 7: firearmsoutletcanada.com (Stencil — verified during that audit)
- Site 8: frontierfirearms.ca → Blueprint (N/A)
- Site 19: nordicmarksman.com (verified 2026-04-08)
- Any future Stencil site

**Implementation sketch** (for future session):
1. Add new profile field `apiAlternative.type: 'bigcommerce-graphql'` (same convention as `mysimplestore` on liangjian)
2. Profile fields: `tokenScrapeUrl` (a product listing URL whose HTML contains the token), `tokenRegex` (e.g. `/storefrontAPIToken['"]?\s*[:=]\s*['"]([a-zA-Z0-9._-]+)['"]/`), `graphqlUrl` (usually `/graphql`), `productsQuery` (GraphQL query string for products sorted by date)
3. Add new branch in `generic-retail.ts.fetchCatalogPage` (after the mysimplestore branch, before the Klevu branch): `if (profile?.apiAlternative?.type === 'bigcommerce-graphql')` → scrape token (cache 1h in-process), POST GraphQL query, map response → CatalogPage, return null on failure → dispatcher falls back to existing HTML/Playwright path
4. Verify live on nordicmarksman.com first, then opt-in other Stencil sites in the fleet

**Blast radius**: ~80 lines in generic-retail.ts (same shape as mysimplestore branch, confirmed working on site 16). No schema migration. Profile-driven config, per site.

**Risk**: Low. Token scraping is public-page DOM reading, no auth required. GraphQL endpoint is intended for public storefront use. Fallback to HTML is already wired.

**When to do it**: After the 34-site audit completes. There's no urgency — the HTML path works. This is pure optimization.

**Reference**: Site 19 nordicmarksman.com JSON API probe results (in `34-site-audit-history.md` Site 19 entry — endpoints tested, all documented).

---

## RESOLVED LAST SESSION
- greatnorthgunco.ca `/shop/` overlap → KEEP (21 unique products)
- gunpost.ca not in 34-list → excluded as classifieds (uses classifieds-gunpost adapter)
- liangjian.ca mysimplestore API — Phase 2 shipped (Site 16, commit a763fe4)

## LATEST PLAYBOOK MISTAKES (reference)
- Mistake 15: jPages client-side pagination on custom PHP (irunguns, site 14)
- Mistake 16: Don't follow AJAX rabbit holes when plain GET returns the full catalog (irunguns, site 14)
- Mistake 17: Cursor-based watermarks require the cursor field to be exposed to the client (irunguns `p.id`, site 14)
- Mistake 18: "No sort UI" ≠ "no sort possible" — cross-reference DOM ordering against independent newest-first signal (irunguns, site 14)
- Mistake 19: Test production Playwright fallback BEFORE declaring a SPA site "blocked" (liangjian, site 16)
  - Sub-lesson: Drive Playwright as a real user (click controls, capture XHRs), not as a static fetcher
- Mistake 20: Magento sort option values are merchant-customizable — never assume `created_at` (londerosports, site 18)
- Mistake 21: OpenCart's visible sort dropdown doesn't expose every server-accepted column — probe `p.date_added` directly (northprosports, site 20)
- Mistake 22: Odoo eCommerce platform reference + stored platform tags need verification — 11/22 sites had wrong WAF or platform at onboarding (outfitters, site 21)
- Mistake 23: Declaring `hasWaf: false` from a single 200 response is insufficient. MANDATORY heavy 8-batch WAF probe before clearing the flag. Tool: `backend/scripts/heavy-waf-probe.sh <target>` (outfitters site 21; retro-cleared sites 19/20 via re-probe on 2026-04-08)
- **Mistake 24**: Volusion sort param silently ignored unless `searching=Y` activation flag also in URL. Correct format: `{path}?searching=Y&sort={N}&show={N}&page={N}`. Root cause in `/a/j/productlist.js` `Refine()` which hardcodes searching=Y. (precisionoptics, site 22)
- **Mistake 25**: Searchspring overlay hijacks URL sort semantics — sort lives in a URL hash fragment `#/sort:created_at:desc`, not a query param. Detection: grep HTML for `cdn.searchspring.net/search/v3/js/searchspring.catalog.js?<siteId>`. Fix: bake fragment into catalogUrls, set `sortParam: ""`, use normal query pagination (Node's URL class preserves fragments through `searchParams.set()`). Cross-platform risk (used on Magento, BC Stencil, Shopify). (sail.ca, site 25)
- **Mistake 26**: LightSpeed eCom (hosted) silently ignores `?page=N` — only `pageN.html` URL suffix works. AND when `sortParam` is non-null and adapter pre-appends it via `getNewArrivalsUrls`, the `paginationPattern.match` must anchor on the sort query segment (NOT `.html`) to produce dual-path-compatible URLs. Working pattern: `{type:'suffix-replace', match:'?sort=newest', template:'page{N}.html?sort=newest'}`. **Retro-risk**: sites 9 fulcrum-outdoors + 11 gagnonsports may be silently under-crawling. (solelyoutdoors.com, site 26)
- **Mistake 27**: Wix Stores sub-category URLs silently leak pagination to global `/shop` order — React client-side filter, pagination hrefs point to global. Fix: use only top-level `/shop` with `?page={n}` 1-indexed `perPage:20 firstPageHasParam:false`. Detection: `<?xml generatedBy="WIX">` in sitemap + `server: Pepyaka` + `wixBiSession`/`thunderbolt` in HTML. (surplusherbys.com, site 29)
- **Mistake 28**: DB=0 sites need ALL stale profile signals re-verified against live HTML FIRST — mandatory 5-step rule: (1) heavy WAF probe, (2) grep platform markers, (3) re-verify every free-text notes claim, (4) check sitemap+robots, (5) walk homepage with production adapter. Stale signals compound via anchor bias. Distinct from Mistakes 3/22/13 (single-signal variants). (surplusherbys.com, site 29)
- **Mistake 29**: BC Stencil raw page-1 regex counts are ALWAYS inflated (visible card + hidden quick-view modal shadow-card both share `data-product-id`) — dedupe via `sort -u` or production `extractCatalogProducts` URL Set. Page-1 counts are NOT category totals (must walk pagination end-to-end). 3-outcome sort verification decision tree (`honored` / `honored (default=newest)` / `noop-small`) with mandatory `?sort=alphaasc` counter-control — testing only newest-vs-default produces false negatives when store's theme default IS already featured/newest. BC Stencil theme defaults vary per merchant (sites 19=newest/27=featured/28=alphaasc/30=featured — 4 sites, 3 different defaults). (theammosource.com, site 30)

## PROFILE FIELD CONVENTIONS (locked in session 2026-04-08)
- `wafLastProbedAt`: ISO timestamp of the last heavy WAF probe run
- `wafProbeMethod`: `'heavy-8-batch'` (or another method if warranted)
- `wafProbeResult`: one-line human-readable verdict (e.g. `'cloudflare-passive-no-rules-firing'`)
- `wafProbeEvidence`: structured data from the probe (cfHeadersDetected, rapidBurstStatus, honeypotPathsBlocked, sqliRuleFired, xssRuleFired, botUaBlocked, etc.)
- `wafWorkaround`: documentation-only field (no backend code reads it). Runtime WAF handling is driven by `hasWaf` flag (threshold at `catalog-crawler.ts:404-421`) + generic `waf-cookie-manager` + `applyBackoff`. Setting to `null` is safe.
- **NEVER set `hasWaf: false` without running the heavy probe first.** Playbook Mistake 23.
- **NEVER blanket-tag `hasWaf: true` for all Cloudflare-passive sites.** Verify first with the heavy probe; only set if WAF vendor headers are actually detected.
