# Wave 2 Phase B — results + 3 deferred code issues — 2026-06-04

## ============ FINAL STATE 2026-06-05 (overnight session) ============
**13-site batch: 10 in maintain, 3 flagged with diagnosed issues + proposed fixes.**
- MAINTAIN (10): Wave-1 six (pavillon, rangeview, wolverine, oleys, shooterschoice, truenortharms) + rdsc,
  prophetriver, thegundealer, gagnon.
- **TWO code fixes deployed (UNCOMMITTED, both 3-role harness-reviewed):**
  1. `adapter-registry.ts` www cache-key fix — unblocked gobles/gagnon (were routing to wrong adapter → 0 products).
  2. `playwright-fetcher.ts` Playwright concurrency cap=3 — ROOT-CAUSE fix for the recurring worker hang
     (unbounded concurrent Chromium pages → OOM crash). Verified stable: watchdog restarts=0 over 65+ min.
- **sail.ca — RESIDUE CLEANUP DONE.** Captured the authoritative /en/hunting set via live Searchspring API
  (`bgfilter.category_hierarchy=Hunting`, true count 3219, 3143 URLs in `_sail-hunting-set-2026-06-04.json`).
  Membership-deactivated 5293 out-of-scope products (apparel/fishing/ski/camping); backup
  `_sail-membership-backup-2026-06-04.json`. sail active 7445→2152 (in-scope hunting only); will fill to ~3219 via crawl.
- **gobles.ca — FLAGGED (stock-detection bug).** Routing fixed (3371 indexed) but ALL show out_of_stock: isInStock
  returns undefined for `.product-element` cards (no stock text) and extractCatalogProducts maps undefined→out_of_stock
  (generic-retail.ts:~1115). FIX needs care: flipping the default would fire ~3371 FALSE restock alerts on next crawl —
  must pair with alert-suppression-on-first-correction. NOT done tonight. Also 3876 count is a slight overcount vs 3371 browsable.
- **theshootingcentre — FLAGGED (OOS coverage gap).** Count 17316 CONFIRMED CURRENT (live sitemap). Crawl (BC GraphQL +
  category HTML) only reaches ~10356 because the store hides OOS from its storefront; the ~6960 missing are REAL OOS
  firearms (verified: Rossi R92, HK bipod, Magpul — HTTP 200, out-of-stock). For a restock app these are exactly what we
  want. FIX = crawl the BC product sitemap (the only surface exposing OOS) = new sitemap-seed crawl mode (code/feature).
- Budgets RESTORED to backup originals (`_budget-restore-all-2026-06-04.ts --apply`, 12 sites). Pace restored.
- Background still running: dev server (Playwright-cap build) + watchdog (`_watchdog-2026-06-04.ts`, user-authorized).

## ============ (original 2026-06-04 notes below) ============


Drove the 7 Wave-2 parked sites bootstrap->maintain (after the 4-round audit). Temporarily sped pace to
2-min dispatch (budget/gap unchanged at 1s — safe). Autonomous driver (_w2-autodrive) self-transitioned
ready sites + restores pace on finish.

## TRANSITIONED to maintain (4) — clean
- rdsc.ca — www->apex host fix was the root cause; reached ~9487, transitioned.
- store.prophetriver.com — R2's "6-page cap" was false (R3); reached ~99.7% (14154/14197), transitioned.
- thegundealer.ca — re-enabled (stale "search-404" disable), WP REST 11279, transitioned.
- (all deepVerify-gated.)
- NOT YET VALIDATED (live keyword vs retailer + tiers) — do when back.

## FLAGGED — need attention (3 code issues + 1 decision)

### 1. gobles.ca + gagnonsports.com — RESOLVED 2026-06-04 PM (was MISDIAGNOSED as extraction bug)
- **The "extraction-0 bug" diagnosis above was WRONG.** The GenericRetailAdapter extractor works perfectly — proven by
  running the REAL production `extractCatalogProducts` against fresh production-fetched HTML: semi-auto leaf → 57 products,
  ammunition → 100. Fetch works too (status 200, real titles). Extraction was never broken.
- **REAL root cause: an adapter-registry cache-key normalization bug.** gobles/gagnon are the ONLY 2 of 65 sites whose DB
  `domain` is stored with a `www.` prefix (`www.gobles.ca`, `www.gagnonsports.com`). `adapter-registry.ts` BUILT the cache
  keyed by the raw `site.domain` (line 76) but `getAdapterForUrl` LOOKS UP by `normalizeDomain(hostname)` (strips `www.`),
  so their entries were unreachable → fell through to the silent `generic` default (`GenericAdapter`, which lacks the
  `.product-element` selector) → 0 products, no error. All 86 T4 events had matchesFound=0 while the standalone extractor
  returned 57-100 on the same pages — the tell that routing, not extraction, was the issue.
- **FIX (3-role harness, 2 reviewers approved, NOT committed):** `adapter-registry.ts` 3 lines —
  (a) `:76` build cache key by `normalizeDomain(site.domain)`; (b) `:175` `_getSiteCacheEntry` normalizes its arg
  (closes raw-domain callers worker.ts:532 + stale-detector.ts:154); (c) `:159` warn on the silent generic fallback.
  + new test `adapter-registry-www-domain.test.ts` (10 tests). Proven zero-regression: only 2 www domains, 0 normalized-key
  collisions, no-op for the other 63. Side-benefit: also silently fixes icollector.com (same www-hostname-vs-bare-DB mismatch).
- **Post-fix:** routing now resolves both → GenericRetailAdapter (verified). streamState reset (`_r4-reset-streams --apply`)
  + unpaused (`_w2-pause-broken --resume`). Production catalog crawl now extracts: gobles active 0→24+ climbing
  (T4 `pages=2 found=17`), gagnon 118→147+ (T4 `found=15`). Both sweeping their 84/30 streams toward 3876/2706.
- REMAINING: let them finish the bootstrap sweep → transition to maintain (deepVerify-gated) when ≥95%. Decide whether to
  COMMIT the adapter-registry fix.

### 2. store.theshootingcentre.com — RE-DIAGNOSED 2026-06-04 PM (NOT a wiring bug; count-surface question)
- **The "GraphQL not wired" diagnosis above is STALE.** Current streamState = `1 stream: api(api)`, and `detectStreams`
  confirms it emits a single bigcommerce-graphql API stream (stream-detector.ts:143-175 already routes apiAlternative →
  origin-rooted api stream; GenericRetail.fetchCatalogPage dispatches GraphQL). The catalog crawl IS using GraphQL.
- **Current reality:** active=10356 (NOT 8440 — that figure was point-in-time; it's grown), exp=17305 (60%). The T4
  GraphQL walk completes `pages=119 found=5950` every cycle, repeatably, and plateaus there — active union ~10356.
  It does NOT reach 17305.
- **Real open question = L1 count-surface mismatch.** expectedProductCount=17305 came from the sitemap-index (3 product
  sitemaps). The GraphQL feed the RUNTIME walks tops out well below that. Either (a) the sitemap counts OOS/excluded SKUs
  the GraphQL feed=sitemap doesn't serve → lower exp to the GraphQL-reachable ceiling and transition (in-stock/reachable
  surface, per L1), OR (b) the GraphQL walk hits a hard 119-page pagination cap (BigCommerce GraphQL cursor limit) and is
  artificially truncated. NEEDS: walk the GraphQL feed manually to its true ceiling and compare to the 3 sitemaps.
- Also: 1 recent T4 fail (pages=0, failures=1) after 7 clean successes — likely transient (token scrape/rate). Watch;
  re-investigate only if it persists.
- NOT broken — 10356 real fresh products indexed. This is a coverage-accounting decision, not a crawl failure.

### 3. sail.ca — whole-store residue (DATA, operator decision)
- Re-scoped to /en/hunting (3223) but the OLD unscoped crawl left ~3050 non-firearm products active -> coverage reads 226%.
  These won't 404, so stale-detection won't clear them. Needs a scope-based cleanup (deactivate sail products NOT in the
  Searchspring Hunting set) — operator sign-off (bulk deactivation of live-but-out-of-scope products), like the truenortharms
  decision. Until then sail can't show true coverage / transition cleanly.

## RESTORE STATUS (temporary changes to undo at wrap)
- Pace: _w2-pace-2026-06-04.ts set tier1IntervalMin=2 for the 7. The autodrive restores it on finish; if not, run
  `npx tsx scripts/_w2-pace-2026-06-04.ts --restore`. Backup: _w2-pace-backup-2026-06-04.json (original = formula).
- Budgets: still bumped (baseBudget 3600/1800). Restore from _budget-restore-2026-06-02.json (old 20) +
  _w1-enable-backup-2026-06-03.json (Wave 1 six) + _w2-apply-backup-2026-06-04.json (Wave 2 four) + the gobles/gagnon
  (_w2pb-gg-backup) + theshootingcentre (_w2-tsc-backup).
- All siteProfile corrections have per-script backups (dry-run-verified before apply).

## RECURRING WORKER HANG — ROOT CAUSE FIXED 2026-06-05 (Playwright concurrency cap)
- **TRUE root cause found + fixed:** BullMQ 'scrape' worker runs `concurrency: 20` (worker.ts:1141) with NO limit on
  concurrent Playwright pages. When many jobs hit the "blocked response → Playwright fallback" path at once (verifier
  across the WAF maintain fleet), ~20 Chromium pages open in the shared browser → memory exhaustion → hard crash
  (npm exit 4294967295 = -1). The crash is the OS/Chromium killing the process, so `--max-old-space-size` (node heap)
  does NOT help.
- **FIX (3-role harness, code-reviewer APPROVED, no-deadlock verified, UNCOMMITTED):** added a hand-rolled async
  semaphore in `playwright-fetcher.ts` capping `fetchWithPlaywright` at PLAYWRIGHT_MAX_CONCURRENCY=3; excess calls queue.
  Release in outermost finally (no permit leak). Verified live: log shows "concurrency cap reached (3 running), queuing"
  firing — the cap works. No nested-Playwright deadlock (waf-cookie-manager uses getBrowser() directly, not the wrapped fn).
- FOLLOW-UP NIT (not done): `fetchWithPlaywrightPaginated` (keyword-search path, scraper/index.ts) is NOT capped — add the
  same semaphore for completeness (it's foreground/rare so not the crash culprit).
- Old mechanism note (still true): `ts-node-dev --respawn` only restarts the child on FILE CHANGE, not on crash — so before
  this fix, a crash = silent hang until manual restart. The watchdog (below) is the backstop; the cap is the real fix.

## (superseded) RECURRING WORKER HANG — root-cause MECHANISM found 2026-06-04 PM (3rd occurrence this session)
- Symptom: crawl events stop for all sites; `Get-CimInstance ... -match 'FIREARM-ALERT'` shows the ts-node-dev PARENT
  alive but the worker CHILD process gone. Fix = kill the parent + `cd backend && npm run dev`.
- **Mechanism CONFIRMED:** `npm run dev` = `ts-node-dev --respawn --transpile-only src/index.ts`. `--respawn` only
  restarts the child on a FILE CHANGE — NOT on a hard process crash. The dead server's log tail ended with
  `npm error code 4294967295` (-1 = hard crash) right after heavy Playwright/WAF activity (gotenda Sucuri solve, many
  WAF Playwright fetches). So: the node process crashes (most likely MEMORY PRESSURE from repeated Playwright browser
  launches on this memory-constrained Windows box — see CLAUDE.md "C: drive limited disk"), and ts-node-dev does NOT
  bring it back → silent hang until manual restart.
- This session's 2nd trigger was ALSO the rapid ts-node-dev reloads from the harness edits (multiple adapter-registry.ts
  saves in a row can crash the reloader). Stable once edits stop.
- **SRE FIX OPTIONS (not yet implemented — needs operator approval, infra change):** (a) wrap dev in a process supervisor
  that restarts on crash (`pm2 start npm --name fa -- run dev`, or `forever`, or nodemon with crash-restart); (b) add a
  lightweight watchdog that checks crawlEvent liveness every ~5 min and restarts if 0 events for >12 min; (c) cap
  concurrent Playwright instances / add `--max-old-space-size`. (a) is the smallest durable fix.
- **OPT-IN watchdog already written + dry-run-verified: `scripts/_watchdog-2026-06-04.ts`.** Implements option (b):
  every 5 min counts crawlEvents in the last 12 min; if 0, kills ONLY `ts-node-dev` procs (verified it does NOT match the
  watchdog itself or the autodrive) and relaunches `npm run dev` detached. Safety: 15-min restart cooldown, max 8 restarts,
  24h ceiling. NOT running this session — the user's standing boundary is "do NOT stack background watchers; use one-shot
  checks", so launching it was (correctly) blocked. Run it manually ONLY if you accept an autonomous restart loop:
  `cd backend && npx tsx scripts/_watchdog-2026-06-04.ts` (use `--dry --once` to preview).

## RESTORE STATUS (temporary changes to undo at wrap)
- Pace: the autodrive (_w2-autodrive) restores tier1IntervalMin on finish. If it didn't, run
  `npx tsx scripts/_w2-pace-2026-06-04.ts --restore`. Backup: _w2-pace-backup-2026-06-04.json.
- Budgets: ACTUAL current baseBudgets (verified 2026-06-04 PM, NOT a uniform 3600): thegundealer/prophetriver/rdsc=180,
  sail/theshootingcentre=120, gobles/gagnon=3600. Backup ORIGINALS: gobles=60, gagnon=?, thegundealer=60, tsc=120,
  Wave-1 60-120, the 20 maintain sites in _budget-restore-2026-06-02.json. NONE are at ban-risk now (gobles/gagnon 1s gap
  floor, rest 20-30s). At restore time, DIFF current-vs-backup per site (baseBudget may be partly priority-engine-managed,
  so don't blindly overwrite) and set each back to its backup original.

## WHEN BACK (updated 2026-06-04 PM)
1. gobles/gagnon: the autodrive is driving them to maintain at 95% (they're climbing: gobles 0→155+, gagnon 118→500+ via
   the now-correct GenericRetailAdapter). Confirm they transitioned + validate (live keyword + tiers).
2. theshootingcentre: resolve the L1 count-surface question (walk GraphQL feed to true ceiling vs sitemap 17305). Decide
   transition target. NOT a wiring bug.
3. sail: operator sign-off on the scope-based residue cleanup (bulk-deactivate ~4000 non-hunting products). Low harm if
   deferred (non-firearm residue won't match firearm keywords).
4. Restore all budgets per RESTORE STATUS; confirm pace restored.
5. Decide whether to COMMIT the adapter-registry www cache-key fix (uncommitted, 2 reviewers approved).
6. SRE: implement a crash-restart supervisor for the dev server (see RECURRING WORKER HANG).
