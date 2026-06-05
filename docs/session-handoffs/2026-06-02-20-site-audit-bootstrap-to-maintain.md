# Session Handoff — 2026-06-02 — 20-site audit + bootstrap→maintain

4-round adversarial audit on 20 retail sites (stress-test SKILL.md) + drive them bootstrap→maintain.
Skills: karpathy-guidelines + ECC verification-loop. Harness: testing-api-tester (R1/R2),
engineering-code-reviewer (R3), 3-role review on code fixes.

## Outcome
- **All 20 sites were `isEnabled=false`** (bulk-parked at the 2026-04-27 pivot, NOT banned; failure
  counts stale/pre-fixes). Investigated cause → **enabled 19** (basspro held). Budgets bumped to
  gap≥2s (token-budget = baseBudget×capacity; safe, can't round to 0). Restore file:
  `backend/scripts/_budget-restore-2026-06-02.json`. **Daily adjuster reverts baseBudget at 04:00 UTC.**
- **11 transitioned to maintain** (deepVerify-gated): intersurplus, dantesports, hical, dlaskarms,
  alflahertys, marstar, budgetshootersupply, doubletapsports, gotenda, firearmsoutletcanada, alsimmonsgunshop.
- **7 still crawling toward 95%** (transition when ready): nordicmarksman (94.8%), durhamoutdoors (90%),
  g4cgunstore (22%), frontierfirearms (12%), fulcrum (1.5%), irunguns (0%) — large/just-enabled.
  Re-run `npx tsx scripts/_r4-coverage-2026-06-02.ts` then `_force-transition-2026-06-02.ts <domains>`.
- **2 held by the hard verify gate (legitimate):**
  - **canadafirstammo** — verifyMethod=store-api can't verify OOS-indexed products (Store API = in-stock
    only). Fix: switch verifyMethod→detail-page OR sample in-stock for deepVerify. FOLLOW-UP.
  - **doctordeals** — detail-page deepVerify didn't solve **sgcaptcha** (WafCookieManager handled Sucuri for
    others, not SiteGround sgcaptcha). Wire sgcaptcha bypass into the maintain/deepVerify path. FOLLOW-UP.
- **basspro** — KEEP HELD. Akamai Bot Manager blocks all product surfaces (Chrome 403; iPhone 200 = <5KB
  challenge interstitial, below the >5KB Playwright auto-fallback; no Akamai handler in playwright-fetcher).
  Hard external blocker (northpro-class). DEFER (Akamai solver = large infra task).

## Code fixes applied (tsc clean, 61 tests pass, both reviewers APPROVE)
- **theme-I** `profile-validator.ts:119` — exempt `api-date-since-watermark` from the sortVerification
  required-check (date-driven, sort-independent). Promotion-gate only (NOT runtime transition). + test.
- **B2** `product-count-probe.ts:188-193` — `validateMethod` throws (descriptive) when `sitemap-index`
  has no non-empty `urls[]` (the legacy `{sitemapUrl,subSitemapPattern}` shape that silent-null'd, e.g.
  firearmsoutletcanada). + removed the `.substring(0,80)` log truncation at :551 so the remediation hint
  reaches logs. + tests.

## siteProfile corrections applied (17 sites + 4 hasWaf column flips)
`backend/scripts/_r4-apply-corrections-2026-06-02.ts` (backup: `_r4-profile-backup-2026-06-02.json`).
expectedProductCount refreshes; hasWaf→false (alsimmons/doubletap/foc/intersurplus, column+profile);
needsPlaywright→false (alflahertys/durham); perPage (canadafirstammo 100, intersurplus 250);
platform retag (durham); alflahertys watermark.reason; doubletap/dlaskarms pagination leading-slash (inert).

## CRITICAL LESSON — R2 fulcrum misread (caught in R4 dry-run)
R2 claimed fulcrum's DB `paginationPattern.match` was `.html?sort=newest` (→ "the one live coverage bug").
The ACTUAL DB value is `?sort=newest`, which `buildPaginatedUrl` handles correctly (endsWith→strip→rebuild).
R3 consolidation trusted R2's quoted value instead of re-reading the field. **Always dry-run profile writes
against ACTUAL DB values before applying.** Only fulcrum's count refresh (3285) was applied; the
pagination/catalogUrls "fix" was pulled.

## Cross-cutting findings (the SKILL.md stress-test deliverable) — see docs/site-audit/_ROUND1-LEDGER + _R2-CONSOLIDATED
- **API-first dispatch makes paginationPattern/perPage/catalogUrls runtime-INERT for WC/Shopify/Klevu** —
  most R1 "bugs" were latent. Theme B bites ONLY HTML-paginating platforms (Lightspeed/3dcart/BC suffix-replace).
- **Theme F** count-method drift (dual-api/wp-rest-api/wc-store-api-header/legacy-sitemap-index) → silent null;
  LATENT (probe gated on !expectedProductCount). B2 guard now makes the legacy sitemap-index shape fail loud.
- **`watermark.dateFilterField` is DEAD** (woocommerce.ts hardcodes modified_after). `crawlers.catalog.api-full-catalog`
  string is NEVER read (dispatch keys on adapter.fetchCatalogPage presence).
- **DB profiles were largely correct; R1-blind over-corrected** — R2/R3 rejected most R1 regressions.

## FOLLOW-UPS (not done)
1. productCountMethod object rewrites (pass 2, latent): alsimmons/canadafirstammo/dantesports→wp-rest-header,
   foc→scalar sitemap, intersurplus→shopify-products-walk. Need exact `/wp-json/...` endpoints. LOW urgency.
2. canadafirstammo + doctordeals verify-method fixes (above) → then transition.
3. SKILL.md doc fixes (B7): durham B3 search example is STALE/WRONG (real form `/search.asp?keyword=`, keyword
   honored, CF on search.asp is IP/time-variable); enforce platform-default searchUrl when probe deferred;
   suffix-replace `match` must be the post-sort URL tail; SPA-API surfaces are coverage-inert; perPage is
   API-only for HTML-walk BC/Magento; Stage-9 relative path → repo-root.
4. Transition the 7 remaining sites as they reach 95%.
5. Restore budgets (`_budget-throughput-2026-06-02.ts` restore / `_budget-restore-2026-06-02.json`) — or let
   the 04:00 UTC adjuster do it. Kept bumped to help the 7 finish.
6. Scratch cleanup: `_r1read-*` files left by R1 agents; session `_*-2026-06-02` scripts (keep apply/coverage/
   transition as records).
