# R3 Consolidation + Adversarial Triage — Round-4 Work Order — 2026-06-02

Persona: engineering-code-reviewer (R3, break-mindset). All code claims below were re-opened
and verified against the actual lines in `backend/src/`. Read-only; no DB writes; no live probing.

## Verified code-state corrections to the R1 Ledger (read the lines)
1. **Theme-F mechanism changed since the Ledger.** The Ledger says unknown count-method strings
   "hit `default: return null` (533-537)". FALSE in current code. `validateMethod` (product-count-probe.ts:138-171)
   is called at line 245 BEFORE the switch and THROWS for any name not in `VALID_METHOD_NAMES`
   (the 11 canonical names, lines 110-122). The throw is caught at 540-543 → returns null. The
   `default:` arm (533-537) is now effectively dead for known-drift names. End state is identical
   (silent null) but the path is throw-then-catch, not default-arm. Every R2 file that re-traced this
   (alsimmons, canadafirstammo, dantesports) got it right; the Ledger wording is stale. A BARE STRING
   (`'wp-rest-api'`, dantesports) also throws because `m?.method` on a string is `undefined`.
2. **Theme-I scope is narrower than "blocks the crawler".** `validateSiteProfile` (profile-validator.ts:388)
   is called ONLY by `scripts/audit-review-pipeline.ts:117` (Stage-1 promotion gate) and referenced in
   the SKILL doc + tests. It is NOT called by `transitionSiteToMaintain` (maintain-readiness.ts:366) nor
   `checkMaintainReadiness`. Those gate on verifyMethod presence (389), verifyEndpoint (402), deep-verify
   probe (423), and `reasons.length===0` — none reference sort. So the sortVerification over-require
   (lines 106-118) blocks the AUDIT-PROMOTION pipeline, NOT the runtime maintain transition. marstar's R2
   states this exactly; alflahertys' `reason`-vs-`notes` variant has the same scope. Confirmed.
3. **buildPaginatedUrl branches (catalog-crawler.ts:119-167) verified.** `type:'path'` strips trailing
   slash then appends template raw (122-125) → template MUST start with `/`. `suffix-replace` (128-137)
   does `baseUrl.endsWith(match)`; on no-match it appends template raw (132-133, the silent page-1 loop).
   `api-page`/`query`/unknown → default branch (153-157) `url.searchParams.set('page',N)`. All as R2 describes.
4. **API-first dispatch verified (catalog-crawler.ts:280-362).** `perPage: profilePerPage || (hasWaf?20:50)`
   at line 290; WC adapter caps `Math.min(perPage??100,100)` (woocommerce.ts:299); HTML branch
   (catalogUrls consumer) only fires when `!apiCrawlUsed` (362). So for every WC/Shopify/Klevu site the
   paginationPattern/catalogUrls coverage fields are runtime-INERT for the API path and only matter on
   HTML fallback. The intersurplus theme-D 7.8x claim is REFUTED at the code level: shopify.ts:199
   hardcodes perPage=250 and ignores hasWaf — the 32 was never a throttle.
5. **worker.ts:715-725 restock-preservation verified.** When the Store API does not return a product,
   the code deliberately does NOT push to `handledProductIds`, so the caller's `handled===products.length`
   short-circuit (~711) does not fire and the Playwright detail-page fallback runs. This is the
   batch-3 fix already on main. detail-page remains the safer verifyMethod per the CLAUDE.md custom rule,
   but store-api is not categorically broken on current main.

---

## A) PER-SITE APPLY-TABLE (Round 4 siteProfile field changes)

Confidence = R2's; EvidenceStrength = my assessment; Verdict = R3.
"No row" = R2 concluded DB already correct / value is self-healing and non-load-bearing.
Count-freshness note: for API-count sites (wp-rest-header / Store API / klevu-api-count / shopify-walk),
expectedProductCount self-heals each cycle (the crawler re-measures via the count probe when needed and
coverage is computed live), so applying a drifted count is COSMETIC unless the profile would otherwise
fail a gate. Marked "count-cosmetic" where so.

### Wave-1 enabled sites

| Site | Field | Current DB | Proposed | r2Conf | Evidence | applyRisk | Verdict |
|---|---|---|---|---|---|---|---|
| alflahertys | crawlers.watermark.reason | (missing; has `notes`) | add `reason` string | high | strong (validator line 112 requires `reason` for full-catalog-sweep; trace-confirmed) | count-gate (promotion only) | **APPLY** — without it the promoted profile fails Stage-1 promotion. Audit-pipeline only; not runtime-blocking. |
| alflahertys | expectedProductCount | 5262 | 5244 | high | medium (live klevu) | none | **APPLY (count-cosmetic)** — klevu-api-count self-measures; harmless either way. |
| alflahertys | needsPlaywright | true | false | med-high | medium (0 runtime consumers) | none | **APPLY** — inert, false is cleaner. Low value. |
| alflahertys | all other walk fields | (DB) | no change | high | strong | none | No row — DB is answer key (Klevu global wildcard = 100%). R1 discarded. |
| alsimmonsgunshop | expectedProductCount | 1638 | 1698 | high | strong (1698=177 instock+1521 oos; WP REST corpus) | none | **APPLY (count-cosmetic)** — surface choice (WP REST corpus) matches DB; only snapshot moved. |
| alsimmonsgunshop | productCountMethod | `dual-api` | `{wp-rest-header, /wp/v2/product, x-wp-total}` | high | strong (dual-api throws→null; wp-rest-header on /wp/v2/product = corpus) | count-gate | **APPLY** — dual-api is silent-null; fix to a recognized method pointed at the corpus surface. |
| alsimmonsgunshop | paginationPattern.template | `/page/{N}/` | keep `/page/{N}/` | high | strong | none | No row — DB already has leading slash; R1's `/shop/page/{N}/` (double-path) is the regression, not DB. |
| alsimmonsgunshop | hasWaf | true | false | high | strong (multi-UA 200 + 12-burst clean; only python-requests 403) | waf | **APPLY** — hasWaf:true+cloudflare-passive over-throttles AND risks corpus loss via cookie-fail→HTML(177-cap). Keep wafType=cloudflare-passive. |
| alsimmonsgunshop | catalogUrls | 5-cat + /shop/ | same (adopt) | high | strong (all HTML caps at 177; corpus only via WP REST) | coverage | No row — DB spine already correct; R1's single /shop/ is operationally equivalent. Note caveat: no HTML spine reaches OOS corpus. |
| canadafirstammo | perPage | 12 | 100 | high | strong (API cap=100 verified; 12 is HTML render) | none | **APPLY** — 12 forces ~11 API reqs vs 2; pure waste, runtime is API. |
| canadafirstammo | productCountMethod | `wc-store-api-header` | `{wp-rest-header, /wc/store/v1/products, x-wp-total}` | high | strong (throws→null; C2 even uses this exact pair as its example) | count-gate (latent; count present) | **APPLY** — silent-null landmine if count ever cleared. Endpoint+header unchanged. |
| canadafirstammo | catalogUrls | 10 (no gunsmithing) | 11 (+gunsmithing) | high | medium (gunsmithing 0 in-stock today, 16 OOS in taxonomy) | coverage | **APPLY** — Mistake-12 keep-empty; zero coverage risk today, future-proofs restock. |
| canadafirstammo | expectedProductCount | 132 | 132 | high | strong | none | No row — both correct; reconfirmed by 2nd method. |
| dantesports | expectedProductCount | 2086 | 2149 | high | strong (full dedup walk = x-wp-total both surfaces) | none | **APPLY (count-cosmetic)**. |
| dantesports | perPage | 100 | 100 | high | strong | none | No row — DB correct; R1's 12 is the regression. |
| dantesports | productCountMethod | bare `'wp-rest-api'` | `{wp-rest-header, /wc/store/v1/products, x-wp-total}` | high | strong (bare string throws→null) | count-gate (latent) | **APPLY** — object form is valid + live 2149. |
| dantesports | hasWaf | true (wordfence-on-cf-passive) | keep true | high | strong (410 after ~7 unspaced; safe at ≥1s) | none | No row — DB JUSTIFIED (real burst rate-limit); R1's false would be unsafe. perPage=100 set so no throttle. |
| dantesports | watermark.dateFilterField | `after` | `modified_after` (or drop) | high | strong (adapter hardcodes modified_after; field is DEAD) | none | **NEEDS-ADVERSARIAL-RECHECK** — field is adapter-ignored either way; changing it is cosmetic. Real action is the cross-cutting "dead dateFilterField" decision (§B5). Don't apply per-site in isolation. |
| dantesports | catalogUrls | (per-cat spine) | keep per-cat HTML spine | high | strong (API global = 100%/overlap-free) | none | No row — keep promo cats (no full HTML walk proved them pure subsets). |
| doubletapsports | expectedProductCount | 1855 | 1872 | high | strong | none | **APPLY (count-cosmetic)**. |
| doubletapsports | catalogUrls | 7-cat (incl brands) | same 7-cat | high | strong (brands has 122 unique; R1's drop loses them) | coverage | No row — DB 7-cat is the answer key; R1's set MISSES 122. Drop redundant children/range-gear/clearance/specials if R1 added them. |
| doubletapsports | hasWaf | true | false | high | strong (cf passive; /.env 404, all 200) | waf | **APPLY** — theme-D over-throttle. Keep wafType=cloudflare-passive. |
| doubletapsports | paginationPattern.template | `page/{N}/` (no slash) | `/page/{N}` | high | strong (theme-B; INERT — API path) | none | **APPLY (defensive)** — broken but inert; fix for HTML-fallback correctness. |
| doubletapsports | sortParam | null | `?orderby=date` | high | medium (server honors orderby w/o UI widget; sort-independent for runtime) | none | **APPLY** — corrects per persona rule "no UI ≠ no sort"; non-load-bearing (watermark is api-date). Low risk. |
| durhamoutdoors | expectedProductCount | 389 | 389 | high | strong (ID-dedup walk = DB) | none | No row — DB correct; R1's 580 too high, sitemap 147 undercount. |
| durhamoutdoors | needsPlaywright | true | false | high | strong (85+ plain-axios 200 + runtime adapter extracted live) | none | **APPLY** — stale defensive flag; plain HTTP works at scale. |
| durhamoutdoors | platform | custom | shift4shop-3dcart | high | strong (registry keys on adapterType, not platform; retag silences drift warning) | none | **APPLY** — zero routing risk (adapterType stays generic-retail). |
| durhamoutdoors | catalogUrls (/RESTRICTED) | 8-cat | keep 9 (incl RESTRICTED) | high | strong (200/0, not 404) | coverage | **APPLY** — keep-empty Rule C. Low cost (1 page/cycle). |
| durhamoutdoors | searchUrl | (DB has it) | `/search.asp?keyword={keyword}` | high | medium (keyword honored today BUT WAF on search.asp is IP/time-variable — was 403 on 2026-05-22) | none | **APPLY** — form is unambiguous; production must live-probe before relying (caveat). Fix SKILL B3 (§B7). |
| durhamoutdoors | sortParam/watermark | (DB) | confirm ?sortby=4 / navigate-from-watermark | high | strong (sortby=4 = strict desc; combined forms verified) | none | No row — DB correct. |

### Wave-2 enabled sites

| Site | Field | Current DB | Proposed | r2Conf | Evidence | applyRisk | Verdict |
|---|---|---|---|---|---|---|---|
| firearmsoutletcanada | perPage / paginationPattern.perPage | 250 | 250 (type query, template page) | high | strong (limit=250 honored; query pagination carries sort+limit) | none | No row — DB perPage=250 already; R1's 52 is the regression. |
| firearmsoutletcanada | expectedProductCount | 3260 | 3437 | high | strong (live sitemap page=1; page=2=404) | none | **APPLY (count-cosmetic)**. |
| firearmsoutletcanada | productCountMethod | `{sitemap-index, sitemapUrl, subSitemapPattern}` (legacy) | `{sitemap, url:'/xmlsitemap.php?type=products&page=1'}` | high | strong (legacy shape has no `urls[]` → `for…of m.urls` TypeError → null; VERIFIED silent-null) | count-gate (latent; count present) | **APPLY** — this is a real silent-null shape. Scalar `sitemap` returns 3437. |
| firearmsoutletcanada | hasWaf | true | false | high | strong (9 multi-UA 200, no escalation) | waf | **APPLY** — invalid passive combo. Keep wafType=cloudflare-passive. |
| firearmsoutletcanada | sortParam/sortVerified | `?sort=newest`/(?) | `?sort=newest`/true | high | strong (3-outcome control; survives pagination) | none | **APPLY** sortVerified=true if not already. |
| firearmsoutletcanada | catalogUrls | 12 (incl /pre-owned, limit=250) | same 12 | high | strong (all 12 contribute unique; 87.7% ceiling, gap is sitemap-only PDPs) | coverage | No row — DB 12 correct; R1 dropped /pre-owned + omitted limit (regression). Gap acceptable per DB design. |
| firearmsoutletcanada | searchUrl | `/search.php?search_query={keyword}` | keep | med | medium (platform default; not live-fired) | none | No row — DB has it; R1 omitted (theme-E). |
| frontierfirearms | expectedProductCount | 1281 | 1277 | high | strong (live sitemap) | none | **APPLY (count-cosmetic)**. |
| frontierfirearms | productCountMethod.url | `/xmlsitemap.php?…` (path-rel) | keep path-relative | high | strong (absolute double-prefixes origin → null) | count-gate | No row — DB already path-relative; R1's ABSOLUTE url is the regression. Reject R1. |
| frontierfirearms | catalogUrls | 13-cat (incl dead `/surplus-bags-hats-clothing/` 301) | 28-URL greedy spine + drop the 301 | high | strong (DB-13=49%; full leaf=85.2%; PLP ceiling structural) | coverage | **NEEDS-ADVERSARIAL-RECHECK** — the spine REPLACEMENT is a large 28-URL rewrite reaching only 85%; 100% needs a products-sitemap walk the runtime doesn't do. APPLY only the minimal safe parts (drop the dead 301 URL); treat the 28-URL spine as a proposal needing operator sign-off, not an auto-apply. |
| frontierfirearms | searchUrl | `/search.php?search_query={keyword}` | keep | high | strong (live 200) | none | No row — DB has it; R1 omitted. |
| frontierfirearms | perPage | 40 | 40 | high | strong (inert for HTML walk) | none | No row — cosmetic; R1's 50 non-load-bearing. |
| frontierfirearms | platform | bigcommerce-stencil | keep | high | strong (meta+CDN+stencil.js) | none | No row — DB FIELD correct; only the DB `notes` string ("Blueprint") is stale prose. Optional: fix the note. |
| frontierfirearms | hasWaf | false | false | high | strong | none | No row. |
| fulcrum | paginationPattern.match + template | `.html?sort=newest` / `page{N}.html?sort=newest` | `/?sort=newest` / `/page{N}.html?sort=newest` | high | strong (TRACED: base ends `?sort=newest`; both R1 & DB match fail endsWith → mangled page-1 loop; fix verified rebuilds correctly) | coverage | **APPLY — this is the one LIVE coverage bug.** See §B1. Without the fix fulcrum indexes only 12 products/category silently. |
| fulcrum | catalogUrls (host + /cool-stuff) | 12 cats on shoplightspeed host | 7 firearm-relevant on canonical www.fulcrumoutdoors.ca incl /cool-stuff/ | high | strong (host 301; per-cat walks lossless; cool-stuff = self-defense/air-pistol/ballistic) | coverage | **APPLY** — re-host to canonical + include /cool-stuff/ (walk-before-drop), exclude /camping/. |
| fulcrum | perPage | 100 | paginationPattern.perPage=12 + perPageCap=100 | high | strong (12=render default for pageN.html; 250 reverts to 12) | coverage | **NEEDS-ADVERSARIAL-RECHECK** — `perPageCap` is a NEW field with no runtime consumer. The page-walk math MUST use perPage=12 (the pageN.html form renders 12). Applying perPage=12 is correct; do NOT invent perPageCap unless the HTML walker is taught to append &limit (out of scope). Apply perPage=12 only. |
| fulcrum | expectedProductCount | 3651 | 3285 | high | strong (fresh sitemap; walk=3203 subset) | none | **APPLY** — DB 3651 is inflated ~10%; matters because coverage% is judged against it. |
| g4c | wafType | (DB cloudflare-passive) | cloudflare-passive | high | strong (70 req Safari UA, 0×403) | none | No row — DB correct; R1's "cloudflare-active" is the regression (Chrome-UA-only 403 over-generalized). |
| g4c | userAgentOverride | Safari 17.2 | keep | high | strong (resolveUserAgent honors it; the load-bearing fix) | waf | No row — DB correct; KEEP. Pre-enable: confirm override loaded into adapter cache. |
| g4c | expectedProductCount | 5863 | 5890 | high | strong (x-wp-total + 59-page walk) | none | **APPLY (count-cosmetic)**. |
| g4c | crawlers.maintain.verifyMethod | `detail-page` (verifyBehavior describes wp-rest+HTML split) | reconcile to `wp-rest`+HTML enrichment | med | weak (R2 itself flags internal inconsistency; not end-to-end tested) | count-gate/restock | **NEEDS-ADVERSARIAL-RECHECK** — verifyMethod string vs verifyBehavior mismatch is real but the proposed `wp-rest` value is medium-confidence and touches restock detection. Don't auto-apply; R4 must trace the verify worker for `wp-rest` support before changing. |
| g4c | catalogUrls | `['/shop/']` | keep `['/shop/']` | high | strong (246-page spine, 100%) | none | No row — DB correct. |
| g4c | all other (count/watermark/sort) | (DB) | no change | high | strong | none | No row — R1 lost 6/6 to DB. |
| intersurplus | productCountMethod | `{sitemap-index, stale cursors, &amp;}` | `{shopify-products-walk, /products.json, 250}` | high | strong (REFUTES R1's 400/entity theory; CONFIRMS silent UNDERCOUNT 2806 vs 3196 via stale cursors) | count-gate (latent) | **APPLY** — robust method; stale-cursor rot is silent (validateMethod doesn't catch it). |
| intersurplus | expectedProductCount | 3125 | 3196 | high | strong (products.json walk = sitemap = 3196) | none | **APPLY (count-cosmetic)**. |
| intersurplus | perPage | 32 | 250 | high | strong (shopify.ts:199 hardcodes 250; 32 is HTML-grid, inert) | none | **APPLY (documentation)** — 32 is misleading; runtime uses 250 regardless. No behavior change. |
| intersurplus | hasWaf | true (cloudflare-passive) | false | high | medium (cf passive; re-confirm from production IP per R2) | waf | **APPLY** — but R2 itself hedges "re-confirm from production IP". Low risk (shopify path ignores hasWaf for perPage anyway). |
| intersurplus | paginationPattern | query | api-page (doc-only) | high | strong (inert; shopify hardcoded loop) | none | **NEEDS-ADVERSARIAL-RECHECK** — pure documentation nit, both inert. Skip unless trivially batched; not worth a write. |
| intersurplus | catalogUrls | `/collections/all` | keep | high | strong | none | No row. |
| irunguns | expectedProductCount | 104 | 95 | high | strong (bare /product.php = dept-union = 95; R1's 145 triple-counts subsets) | none | **APPLY (count-cosmetic)** — but note 95 vs 104 is inventory drift, self-healing via html-pagination count. |
| irunguns | catalogUrls | `['/product.php']` | keep | high | strong (bare = 100%; dept spine redundant/harmful) | none | No row — DB correct; R1's 8-dept spine is the regression. |
| irunguns | perPage | 100 | 100 | high | strong (?page inert; jPages client-side) | none | No row — DB correct; R1's 12 is UI render-slice. |
| irunguns | crawlers.watermark.method | navigate-from-watermark | (carry forward UNVERIFIED) | inconclusive | weak (p.id DESC could NOT be re-proven under no-SQL-endpoint constraint) | none | **NEEDS-ADVERSARIAL-RECHECK** — R2 explicitly inconclusive. Carry DB value; do NOT change. Note: single-response catalog makes navigate vs full-sweep operationally equivalent for coverage. |
| marstar | sortParam/sortVerified | null/false | keep null/false | high | strong (Store API ignores orderby; fcgi=BYPASS falsifies cache theory; WP-REST-core honors it but not needed) | none | No row — DB correct. Fix is the validator (§B3 theme-I), not the profile. |
| marstar | expectedProductCount | 5862 | 5862 | high | strong (3 surfaces agree) | none | No row. |
| marstar | perPage | 100 | 100 | high | strong (Store API caps 100; 200/999→400) | none | No row — DB correct; R1's 999 unusable. |
| marstar | catalogUrls | 9 per-cat | keep as HTML-fallback spine | high | strong (global endpoint = 100%) | none | No row. |
| nordicmarksman | catalogUrls | `/categories.php` | keep `['/categories.php']` | high | strong (walkable global grid; 10-cat spine reaches only 94.6%) | coverage | No row — DB correct; R1's 10-cat nav spine is the regression. |
| nordicmarksman | perPage | 2500 | 2500 | high | strong (server ceiling; INERT at runtime — HTML walk never appends ?limit) | none | No row — DB correct; R1's 250 under-probed. Caveat: inert (§B4 perPage-inert). |
| nordicmarksman | expectedProductCount | 4761 | 4781 | high | strong (live sitemap 3023+1758) | none | **APPLY (count-cosmetic)**. |
| nordicmarksman | searchUrl | `/search.php?search_query={keyword}` | keep | high | strong (live B4 probe) | none | No row — DB has it; R1 MISSED (SKILL B4 named nordic as prior miss — repeated). Fix SKILL (§B7). |
| nordicmarksman | sortParam | `?sort=newest` | keep (REQUIRED, not optional) | high | strong (default = curated NOT newest; corrects R1 narrative) | none | No row — value unchanged; narrative corrected. |

### Held sites (reachability verdicts; profile changes secondary)

| Site | Verdict | Key field | Proposed | Evidence | R3 Verdict |
|---|---|---|---|---|---|
| basspro | **KEEP HELD** (isEnabled=false) | wafWorkaround.notes | replace stale robots/sitemap-403 prose; keep "uncrawlable for products" | strong (robots+sitemap 200 today; product pages Akamai 403/challenge under every UA; no Akamai handler in playwright-fetcher.ts) | **APPLY** the note correction; **KEEP HELD**. Akamai no-handler is real (see §B6, DEFER the handler). |
| basspro | — | expectedProductCount | leave 16543 or refresh ~16736 | medium (sitemap /p/ count; global not firearm-subset) | **NEEDS-ADVERSARIAL-RECHECK** — low priority while held; it's a global all-dept count, not the firearm subset. |
| dlaskarms | **SAFE-TO-ENABLE** (≥2s pace) | isEnabled | enable + keep baseBudget=1800 | high (9 prod-UA reqs API+HTML clean, 0 MalCare markers) | **APPLY enable** with conservative pacing; reset consecutiveFailures=0 at enable. |
| dlaskarms | — | expectedProductCount | 235 | high (x-wp-total both surfaces) | **APPLY (count-cosmetic)**. |
| dlaskarms | — | paginationPattern.template | `/page/{N}/` | high (DB `page/{N}/` no slash — theme-B; INERT, API path) | **APPLY (defensive)**. |
| dlaskarms | — | hasWaf/wafType | keep true/malcare | high | No row — JUSTIFIED (burst-ban); not a hard blocker at pace. |
| doctordeals | **SAFE-TO-ENABLE** (iPhone UA, ≥1.5s) | isEnabled | enable; reset consecutiveFailures=0 | high (19/19 cold iPhone-UA 200) | **APPLY enable** (operator action). |
| doctordeals | — | crawlers.maintain.verifyMethod | `detail-page` (keep DB) | high (detail page has JSON-LD avail/price/stock; store-api drops restock) | No row — DB correct; REJECT R1's store-api (weakens restock per CLAUDE.md rule + worker.ts:715-725). |
| doctordeals | — | expectedProductCount | 975 (WP REST surface) | high (WP REST 975; Store API 576 wrong surface for WP-REST watermark) | **APPLY (count-cosmetic)** — surface matters: pair to WP REST. |
| doctordeals | — | productCountMethod | `{wp-rest-header, /wp/v2/product, x-wp-total}` | high | **APPLY** — REJECT R1's Store-API-endpoint variant (576). |
| doctordeals | — | needsPlaywright | keep true | high (cookie-cache safety net for 202/403) | No row — keep. |
| gotenda | **SAFE-TO-ENABLE** (iPhone Playwright solve + ≥2.5s) | isEnabled | enable | high (22/22 spaced 200, 0 Sucuri re-challenge) | **APPLY enable**; pre-enable confirm iPhone UA override loaded (cookie fingerprint binding). |
| gotenda | — | expectedProductCount | 16785 | high | **APPLY (count-cosmetic)**. |
| gotenda | — | catalogUrls | `/shop/` (DB) sufficient | high (700-page walkable index; NOT a page-1 collapse at /shop/ level) | No row — DB correct; per-cat page-1 IS a 6-card hero trap, so keep /shop/. |
| gotenda | — | paginationPattern | `/page/{N}` path | high | No row — DB works; note soft-tail (page>last = 200 clamped, terminate on empty/repeat not 404). |
| hical | **SAFE-TO-ENABLE** (Incapsula Playwright solve + cookie) | isEnabled | enable | high (15/15 spaced 200 incl /wp/v2/product watermark surface) | **APPLY enable**; reset consecutiveFailures=0. |
| hical | — | crawlers.watermark.method | `api-date-since-watermark` (keep DB) | high (modified_after honored with cookie) | No row — REJECT R1's full-catalog-sweep (cookieless blind artifact). |
| hical | — | expectedProductCount | 1656 | high (both surfaces agree; DB 1676 stale) | **APPLY (count-cosmetic)**. |
| hical | — | catalogUrls | keep DB 23-cat spine | high (reachable w/ cookie) | No row — REJECT R1's `[]`. |
| hical | — | needsPlaywright | keep true | high (Incapsula solve needed once/~90min) | No row. |

---

## B) CROSS-CUTTING CODE FIXES (verified against actual lines)

### B1. fulcrum suffix-replace pagination — THE ONE LIVE COVERAGE BUG
- **theme:** B (suffix-replace)
- **file:line:** `catalog-crawler.ts:128-137` (suffix-replace branch); invoked at `:781` with `stream.url` = catalogUrl
- **bug:** fulcrum catalogUrls are `.../firearms/?sort=newest`. buildPaginatedUrl does `baseUrl.endsWith(match)`.
  Both R1 `match='.html'` and DB `match='.html?sort=newest'` fail endsWith (base tail is `?sort=newest`),
  so the no-match fallback (132-133) appends template raw → `.../firearms/?sort=newestpage2.html` →
  Lightspeed serves page-1/default-sort with HTTP 200. Silent page-1 loop (terminated only by the
  prevPageSignature repeat guard at :790). Net: exactly 12 products/category indexed. Not a crash.
- **fix:** per-site profile: `match='/?sort=newest'`, `template='/page{N}.html?sort=newest'` (I traced it:
  base endsWith `/?sort=newest` → withoutSuffix = `.../firearms` → `+ /page2.html?sort=newest` = correct).
- **blast-radius:** any generic-retail/Lightspeed site whose catalogUrls bake a `?sort=` query AND use
  suffix-replace. fulcrum is the confirmed one. The primitive assumes the matched suffix is the URL tail;
  appending sortParam breaks that assumption.
- **live-or-latent:** LIVE coverage bug for fulcrum once enabled.
- **recommended:** **FIX-NOW (per-site profile)** + **FIX-DEFENSIVE** the primitive: when `match` is not a
  suffix, prefer matching against the path-before-query, or warn loudly instead of silently appending.
  Add a validator rule: suffix-replace `match` must be a suffix of the catalogUrl(s).

### B2. Theme-F silent-null count methods
- **theme:** F
- **file:line:** `product-count-probe.ts:110-122` (VALID_METHOD_NAMES), `:138-171` (validateMethod throws),
  `:245` (called before switch), `:299-311` (sitemap-index iterates `m.urls`), `:540-543` (catch→null)
- **bug:** Unrecognized method strings (`dual-api`, `wp-rest-api` bare, `wc-store-api-header`) THROW in
  validateMethod → caught → null (NOT the `default:` arm; Ledger wording stale). SEPARATELY, the legacy
  `sitemap-index` shape `{sitemapUrl, subSitemapPattern}` (no `urls[]`, foc) makes `for…of m.urls`
  TypeError → null. AND a present-but-stale `urls[]` with rotted Shopify cursors (intersurplus) returns a
  200 + WRONG count (2806 vs 3196) — silent UNDERCOUNT, not null. validateMethod does NOT guard stale
  cursors or `&amp;` entities (the `&amp;` is a non-issue; Shopify ignores the malformed param).
- **fix:** per-site method corrections (alsimmons→wp-rest-header/corpus, canadafirstammo+dantesports→
  wp-rest-header object, foc→scalar sitemap, intersurplus→shopify-products-walk). Defensive: have
  validateMethod reject a `sitemap-index` without a non-empty `urls[]` so the legacy shape fails LOUD.
- **blast-radius:** all sites with a drifted/legacy count method. LATENT everywhere expectedProductCount is
  present (probe gated on `!expectedProductCount` at crawl-scheduler.ts:290 + worker.ts:398) — landmine if
  count is ever cleared.
- **recommended:** **FIX-NOW** the per-site method strings (cheap, removes landmines). **FIX-DEFENSIVE**
  the sitemap-index `urls[]` guard. The stale-cursor rot is best solved by migrating Shopify sites to
  shopify-products-walk (no per-site cursor maintenance) rather than a validator rule.

### B3. Theme-I validator over-requires sort for api-date-since-watermark
- **theme:** I
- **file:line:** `profile-validator.ts:106-118` (sortVerification); consumer `audit-review-pipeline.ts:117`;
  NOT consumed by `maintain-readiness.ts:366` transitionSiteToMaintain (verified)
- **bug:** sortVerification requires `sortVerified===true || sortParam` for every watermark method except
  full-catalog-sweep. api-date-since-watermark is date-driven (modified_after) and provably sort-independent
  (marstar: modified_after future=0/past=5862 honored). marstar → `{valid:false, score:95}`. ALSO the
  full-catalog-sweep branch requires `reason` and the alflahertys promoted DB profile uses `notes` (no
  `reason` key) → would fail.
- **scope (critical nuance):** blocks ONLY the AUDIT-PROMOTION pipeline (Stage-1), NOT the runtime
  maintain transition. So this does not stop the live crawler; it stops a profile being approved-for-maintain
  by the audit tooling.
- **fix:** after the full-catalog-sweep branch (line 114) add `if (method === 'api-date-since-watermark') return null;`.
  Keep the sort requirement only for navigate-from-watermark (genuinely page-1-newest-first). Add a unit test
  mirroring profile-validator-method-and-verify.test.ts. Separately, emit `reason` for full-catalog-sweep in
  the skill (and add `reason` to alflahertys DB profile).
- **blast-radius:** every api-date-since-watermark site at promotion time (most WC sites here). Latent for
  runtime.
- **recommended:** **FIX-NOW** (validator one-liner + test). Low risk, removes a systematic false-negative.

### B4. nordicmarksman perPage-inert (HTML catalog never appends ?limit)
- **theme:** H / perPage
- **file:line:** `generic-retail.ts:196-204, 265-280, 213-253` (URL builders append sortParam, never
  `?limit`); `catalog-crawler.ts:290` passes perPage only to fetchCatalogPage (returns null for non-API BC);
  shopify.ts:250 + product-count-probe.ts is the only `limit=` injection (Shopify-only)
- **bug:** perPage is consumed only by API adapters. For HTML-walk BC/Magento sites (nordicmarksman) the
  walk follows the site's own rel=next at the BC default 20/page; perPage=2500 mis-documents request volume
  (~239 pages of 20, not 2 pages of 2500). Coverage is correct; only the volume estimate is wrong.
- **live-or-latent:** latent/cosmetic (no coverage impact).
- **recommended:** **SKILL-ONLY** — flag perPage as "API-only; inert on HTML-walk BC/Magento". Teaching the
  HTML walker to append `?limit` is a behavior change, out of scope (DEFER).

### B5. Dead `watermark.dateFilterField`
- **theme:** dead field
- **file:line:** `watermark-crawler.ts:207-211` (passes `options.dateAfter`, never reads the profile field);
  `woocommerce.ts:339-344` (hardcodes `modified_after` + `orderby=modified`)
- **bug:** the adapter always sends `modified_after`+`orderby=modified` regardless of the profile's
  `apiDateFilterField`/`dateFilterField`. dantesports DB `after` is aspirational/dead; g4c live-distinguished
  `after` (publish, 94) vs `modified_after` (restock, 2996) — meaningful difference the field cannot express.
- **live-or-latent:** latent (field is ignored).
- **recommended:** **DEFER** the decision: either wire the adapter to read the field (behavior change —
  note g4c WANTS publish-date `after` for new-item watermark, so this is not purely cosmetic there) OR drop
  the field from the schema. Do NOT silently apply per-site dateFilterField changes (dantesports) since the
  field is inert — that's a no-op write. Flag the g4c publish-vs-modified semantic for the schema decision.

### B6. basspro Akamai — no playwright-fetcher handler
- **theme:** WAF-handling gap
- **file:line:** `playwright-fetcher.ts` (has Incapsula/Cloudflare/sgcaptcha/Sucuri branches; ZERO
  akamai/sec-if-cpt/_abck handling — per R2, not re-grepped this round)
- **bug:** Akamai Bot Manager blocks all basspro product surfaces (Chrome 403, iPhone 200-challenge <5KB so
  the >5KB Playwright auto-fallback wouldn't even fire). No handler exists.
- **recommended:** **DEFER** — basspro stays HELD. Building an Akamai behavioral-challenge solver (or
  residential proxy / curl_cffi) is a large infra task, not a Round-4 apply-table item. Apply only the
  wafWorkaround.notes prose fix.

### B7. SKILL.md doc gaps
- **theme:** skill accuracy
- **recommended:** **SKILL-ONLY** (FIX-NOW, doc-only):
  - **B3 durham search example STALE/WRONG** — claims byte-identical CF-403 for `?s=`; real form is
    `/search.asp?keyword=` and keyword is honored (IP/time-variable WAF caveat). Correct or remove the example.
  - **searchUrl not enforced (theme E)** — emit platform-default searchUrl when the live probe is deferred
    (BC Stencil `/search.php?search_query={keyword}`). nordicmarksman was NAMED as a prior miss and missed
    again; foc/frontier omitted it. Make it a gating step.
  - **pagination-base / suffix-replace** — document that suffix-replace `match` must be the actual tail of
    the post-sort catalogUrl (the fulcrum failure).
  - **SPA-API primary surface (theme C)** — Klevu/Shopify: catalogUrls + klevuCategoryPaths are runtime-INERT
    for coverage (global wildcard/products.json walk = 100%); document the api-offset shape; stop building
    catalogUrls as if HTML is primary.
  - **perPage is API-only for HTML-walk BC/Magento** (B4 above).
  - **Stage-9 relative path** resolved to backend/docs instead of repo-root (marstar) — fix the base.

---

## Cross-agent disagreements flagged
- **durhamoutdoors search:** B5R2 + B5R3 (2026-05-22) BOTH found `/search.asp?keyword=*` → CF-403 for all
  keywords and concluded OMIT. R1-blind (2026-06-02) AND this-session R2 found 200 + keyword-honored. This
  is a genuine prior-R2-vs-this-R2 disagreement; resolution = search.asp WAF is IP/time-variable. APPLY the
  searchUrl form but with the production-must-live-probe caveat (do not treat as always-on).
- **nordicmarksman sortParam narrative:** B4R1/B4R2 claimed "default==newest"; B4R3 + this R2 found default
  is curated, ?sort=newest REQUIRED. This R2 sides with B4R3 (the role-switch catching the page-1 first-ID
  coincidence — exactly the documented R2→R3 value). Value unchanged; narrative corrected.
- **gotenda catalogUrls:** B4R2 (page-1-only, "1 top-level cat") vs B4R3/R1 (15 cats). This R2 sides with
  B4R3 via live /products/categories walk. Resolved in favor of DB /shop/ + 12 real top-level cats.
- **intersurplus count failure mode:** R1 ledger said "400 + &amp; entity breakage"; this R2 REFUTES that
  (200, &amp; ignored) and reclassifies as silent stale-cursor undercount. Same fix (shopify-products-walk),
  corrected root cause.

## Highest-risk APPLY items to double-check in R4 (a wrong apply is the worst outcome)
1. **fulcrum suffix-replace** (B1) — the only live coverage bug; the match/template fix is exact but
   coverage-critical. Verify the catalogUrls all end in `?sort=newest` before applying (they must, or the
   match changes per-URL).
2. **frontierfirearms 28-URL catalogUrls rewrite** — large, reaches only 85%; do NOT auto-apply the full
   spine. Apply only "drop the dead 301 URL"; route the spine to operator review.
3. **fulcrum perPageCap / g4c verifyMethod / dantesports dateFilterField** — all involve NEW or
   adapter-ignored fields; marked NEEDS-ADVERSARIAL-RECHECK. Apply only the load-bearing sub-part
   (fulcrum perPage=12; nothing for the others without a runtime change).
4. **irunguns watermark.method** — R2 inconclusive on p.id DESC; carry DB value, do NOT change.
