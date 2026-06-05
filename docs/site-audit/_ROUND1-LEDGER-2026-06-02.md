# Round 1 (Blind Skill Run) — Ledger — 2026-06-02

20-site bootstrap→maintain audit. Orchestrator ledger. Wave 1 = 10 sites complete; Wave 2 = 10 in flight.

## Operational state (discovered during R1)
- **ALL 20 sites were `isEnabled=false`** — bulk-parked ~2026-04-30 during the 2026-04-27 pivot (NOT banned). `consecutiveFailures` counts are stale, pre-date the 2026-06-01 crawler fixes.
- Phase-0 budgets bumped to 3600 (1800 aggressive-WAF) → effective gap ≥2s for all (safe; restore file `backend/scripts/_budget-restore-2026-06-02.json`).
- **Enabled (7, Wave-1 non-aggressive, R1-reachable):** alflahertys, alsimmonsgunshop, budgetshootersupply, canadafirstammo, dantesports, doubletapsports, durhamoutdoors (isEnabled=true, isPaused=false, consecutiveFailures=0, nextCrawlAt=null).
- **HELD pending Round-2 reachability (5 aggressive WAF):** basspro (Akamai 403 on product pages — confirmed blocker), dlaskarms (MalCare IP-ban ~20 req), doctordeals (sgcaptcha), gotenda (sucuri), hical (imperva-incapsula).
- **6 crawlPhase column/profile mismatch** (column=bootstrap, profile=maintain): alsimmonsgunshop, budgetshootersupply, canadafirstammo, dlaskarms, doubletapsports, marstar — half-finished prior transition; leave column=bootstrap, Round 4 resolves via gated transitionSiteToMaintain.

## Verified code findings (orchestrator read the actual lines)
- **buildPaginatedUrl (catalog-crawler.ts:122-125):** for `type:'path'`, strips base trailing slash then appends template raw. So template MUST start with `/`. DB templates `page/{N}/` (no slash) → `/shoppage/2/` (404). CONFIRMED the bug is real. Open question for R2: do these WC sites actually use HTML path-pagination, or the API (where it's inert)?
- **product-count-probe.ts:247-537 switch:** recognizes only 11 methods; `dual-api`, `wp-rest-api`, `wc-store-api-header` all hit `default: return null` (line 533-537) → silently disable the count probe. Latent (probe only runs when expectedProductCount is absent).

## Per-site (Wave 1) — key divergences (candidate vs DB)
- **basspro.ca** (Akamai): product pages 403 from our IP; robots+sitemap.gz now 200 (DB wafWorkaround "uncrawlable" 2026-04-04 is stale). catalogUrls `/c/` parent-tiles (cand) vs `/l/` leaf PLPs (DB, correct). count 16739 vs 16543 (case-sensitivity). searchUrl omitted.
- **alsimmonsgunshop**: count 176 (Store API) vs 1638 (WP REST corpus); productCountMethod `dual-api` (silent-null); hasWaf true+cloudflare-passive (invalid B10 combo, over-throttles); paginationPattern baked `/shop/` → double-path; catalogUrls /shop/ vs per-category.
- **dlaskarms** (MalCare): DB template `page/{N}/` (no slash, broken); B8 count/verify surface mismatch; MalCare confirmed aggressive (correctly not re-triggered); /shop/ vs 20-cat spine.
- **alflahertys** (BC Stencil + Klevu): DB makes Klevu API primary (klevuCategoryPaths + klevu-api-count); blind run over-weighted HTML catalogUrls (B15 parent-tile trap); watermark full-catalog-sweep correct (no honored sort); no SPA-API pagination shape in skill.
- **dantesports** (WC, Wordfence-on-CF-passive): DB template `page/{N}/` (broken); productCountMethod `wp-rest-api` bare string (silent-null); DB has `crawlers.catalog.api-full-catalog` (per_page=100) — skill emits no crawlers.catalog block; hasWaf true (Wordfence 410 after 7 req — may be legit).
- **doubletapsports** (WC, CF-passive): DB template `page/{N}/` (broken); hasWaf true+cloudflare-passive (invalid combo); catalogUrls drift both directions; sortParam ?orderby=date claimed honored w/ no UI widget.
- **doctordeals** (WC, sgcaptcha): verifyMethod detail-page (DB, restock-correct) vs store-api (cand) → cascades to count surface (965 vs 576); searchUrl skipped; cookie-cache workaround for sgcaptcha-403 not modeled by skill.
- **durhamoutdoors** (shift4shop-3dcart): needsPlaywright true (DB) vs false (live HTML works — DB note self-contradicts); SKILL.md B3 search example STALE/WRONG (claims byte-identical CF-403; live /search.asp?keyword= honors keyword); platform custom→shift4shop-3dcart; sitemap undercounts.
- **canadafirstammo** (WC): close match; perPage 100(API) vs 12(HTML) surface; productCountMethod `wc-store-api-header` (silent-null); gunsmithing kept (cand) vs dropped (DB).
- **budgetshootersupply** (WC): count 1506(Store) vs 2809(WP REST) — explicit B8-vs-watermark-surface contradiction; WP REST product_cat doesn't recurse → per-category catalogUrls wrong, use global /products/; paginationPattern api-page vs path; isEnabled=false + phase mismatch.

## Cross-cutting themes (Wave 1 tallies)
- **A. expectedProductCount is NOT a MonitoredSite column** (siteProfile JSON only) — ×10 (all). FIXED in Wave-2 prompt. Skill Stage-8/9 wording + any promotion tooling must not select it as a column.
- **B. paginationPattern path template missing leading slash** → buildPaginatedUrl mangles → broken pagination. DB `page/{N}/` ×4 (dlaskarms, dantesports, doubletap; alsimmons baked opposite). Fix layers: per-site template correction + runtime defensive normalization + a validator over EXISTING promoted profiles.
- **C. SPA-API primary surface under-modeled** (Klevu/Ecwid/Shopify): skill builds catalogUrls as if HTML primary; no api-offset pagination shape; klevuCategoryPaths treated "documentation-only" but DB uses it live. ×1 strong (alflahertys) + budgetshooter (api-page).
- **D. passive-CF/stale defensive flags**: hasWaf:true+cloudflare-passive invalid combo (over-throttle) ×3 (alsimmons, doubletap; alflahertys corrected); needsPlaywright:true on a plain-HTML site (durham). DB carries stale defensive flags.
- **E. searchUrl B4 probe marked mandatory but skipped** ×4+ — skill doesn't enforce it as a gating step.
- **F. count-method strings not in runtime switch → silent null** ×3 (dual-api, wp-rest-api, wc-store-api-header). Plus B8 count-surface contradiction (verify-surface vs watermark-surface) — skill has no tiebreak.
- **G. catalogUrls leaf-vs-parent / single-vs-spine ambiguity + keep-empty-category** ×5 — Stage 4 guidance ambiguous; B15 parent-tile trap; WP REST product_cat non-recursion warning missing.
- **H. no `crawlers.catalog` block in skill output** — DB uses api-full-catalog (per_page=100); skill only emits watermark+maintain; perPage probe is HTML-centric, misses API cap.

## Wave 2 (10 sites) — complete
All 10 live-reachable. **Enabled 8** (firearmsoutletcanada, frontierfirearms, fulcrum, g4c, intersurplus, irunguns, marstar, nordicmarksman). **Held 2** aggressive (gotenda active-Sucuri, hical imperva). Total enabled = 15, held = 5 (basspro, dlaskarms, doctordeals, gotenda, hical).
- **firearmsoutletcanada** (BC Stencil/CF-passive): hasWaf true+passive (invalid); productCountMethod `sitemap-index`{sitemapUrl,subSitemapPattern} = legacy shape runtime can't read (iterates m.urls→TypeError→null) — VERIFIED silent-null; perPage 52(blind) vs 250; dropped /pre-owned by name (has 2 items).
- **fulcrum** (Lightspeed): MATCH platform/WAF/sort. suffix-replace needs sort baked into match+template (`page{N}.html?sort=newest`, Mistake-26) — Stage 5 doesn't mandate combined-form test. Missing /cool-stuff+/camping (firearm-adjacent). perPage 100(cap) vs 12(render).
- **g4c** (WC/CF-passive, UA-reputation): reachable under Safari/iPhone; Chrome→403 after ~6 req (CF UA-escalation onto /wp-json). Live B11 over-call-severity trap → mid-audit REST-403 cascaded to 4 divergences. NEW gap: no cooldown+clean-UA retry before declaring endpoint unavailable. pagination `/page/{N}` HAS slash (correct).
- **marstar** (WC/CF-passive): all APIs 200 (5862). THEME I: profile-validator.ts:115-117 requires sortVerified||sortParam for api-date-since-watermark too → marstar valid:false(95) though date-watermark is sort-independent (validator/skill contradiction). FastCGI cache-NOOP (WordOps keys on path not query → query cache-bust insufficient). Stage-9 relative path resolved to backend/docs (should be repo-root).
- **nordicmarksman** (BC Stencil/CF-passive): catalogUrls 10-cat vs DB `/categories.php`; perPage 250 vs 2500 (under-probed); searchUrl skipped — SKILL.md B4 ALREADY names nordic as a prior miss, repeated.
- **intersurplus** (Shopify/CF-passive): products.json walk 3191. productCountMethod sitemap-index has STALE Shopify from/to cursors + `&amp;amp;` entity-encoding → 400 at runtime (broken); should be shopify-products-walk. hasWaf true+passive throttled perPage to 32 vs 250 honored (7.8x inflation — concrete theme-D cost).
- **gotenda** (WC/ACTIVE Sucuri): 307 on apex AND www separately; iPhone UA alone insufficient; solved via local JS-eval → cookie (matches waf-cookie-manager). HELD. DB `/shop/` = page-1 taxonomy collapse (B3 trap); real = 15 top-level cats. NEW gaps: Sucuri per-host re-challenge; WOOF plugin client-side sort (no server <select>); ?after= vs modified_after.
- **hical** (WC/imperva): challenges HTML+/wp/v2/product+/categories but `/wc/store/v1/products` clean (1656). HELD. cookie-cache workaround in DB. NEW gap: no Incapsula-blind degraded mode (clean /products payload carries per-product categories[] → spine derivable).
- **irunguns** (custom-php/Sucuri-PASSIVE): clean 200s, apex+www. count 145 vs 104 (aggregated-vs-split departments + in-stock filter). NEW gaps: aggregated-vs-split buckets, "Showing N"≠in-stock, AJAX-only-rendered departments (Knives 0 static cards). **SECURITY (out of scope, flag to security-engineer):** product.php leaks raw SQL SELECT + POSTs `sql` FormData to product_filter.php. NOT probed.
- **frontierfirearms** (BC Stencil but really Blueprint/CF-passive): catalogUrls 7 vs 13 (missed depts, blind). NEW gaps: emit platform-default searchUrl when probe deferred; Blueprint-vs-Stencil disambiguation (Stencil assets on Blueprint store).

## New cross-cutting themes (Wave 2)
- **I. profile-validator over-requires sort for api-date-since-watermark** (validator/skill contradiction) — marstar valid:false. Runtime fix candidate.
- **F-extended. count-method broken shapes**: sitemap-index legacy {sitemapUrl,subSitemapPattern} (foc) + Shopify sitemap-index stale from/to cursors + `&amp;amp;` (intersurplus) — both 400/null at runtime. Plus dual-api/wp-rest-api/wc-store-api-header silent-null (Wave 1).
- **D-cost quantified**: false hasWaf:true+passive throttles perPage (intersurplus 32 vs 250 = 7.8x).
- **WAF-handling gaps**: Sucuri per-host re-challenge (gotenda), CF UA-reputation cooldown+clean-UA-retry (g4c), Incapsula-blind degraded mode (hical), WOOF plugin sort (gotenda).
- **searchUrl (E)**: confirmed ×10 — should emit platform-default when live probe deferred.

## Reachability / enable decision (final R1)
- ENABLED 15: alflahertys, alsimmonsgunshop, budgetshootersupply, canadafirstammo, dantesports, doubletapsports, durhamoutdoors, firearmsoutletcanada, frontierfirearms, fulcrum, g4c, intersurplus, irunguns, marstar, nordicmarksman.
- HELD 5 (Round-2 sustained-walk reachability gate): basspro (Akamai 403 product pages — likely hard blocker), dlaskarms (MalCare IP-ban), doctordeals (sgcaptcha), gotenda (active Sucuri), hical (imperva). gotenda+hical+doctordeals have working cookie/UA bypass paths in DB → likely enable after R2 confirms sustained walk; basspro is the real blocker risk.

## Round-2 priorities
1. Pagination leading-slash: live-test whether `/shoppage/2/` 404s AND whether the runtime path-paginates HTML for each WC site (vs API). Top coverage blocker.
2. Per-site catalog-walk + ID-dedup to settle catalogUrls coverage (leaf vs parent, keep-empty, single vs spine).
3. verifyMethod/count-surface: trace woocommerce.ts + the B8-vs-watermark surface question per site; canonicalize silent-null method strings.
4. Confirm reachability for the 5 held aggressive-WAF sites (sustained walk, safe posture) → enable if safe.
5. Confirm passive-CF sites can drop hasWaf:true / needsPlaywright:true safely.
