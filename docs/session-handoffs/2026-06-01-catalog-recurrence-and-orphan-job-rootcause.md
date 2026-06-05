# Session Handoff — 2026-06-01 — Catalog bootstrap stall: full root-cause + applied fixes

This session continued the 14/15-site bootstrap→maintain push. It moved past the prior "issue #4" framing and found the *real* layered root causes. Read this before touching the 9 bootstrap sites.

## State at handoff
- **6 sites MAINTAIN + validated:** theammosource, surplusherbys, bullseyenorth, gunpost, townpost, fishingworldgc.
- **9 still BOOTSTRAP** (coverage / exp / verdict):
  - reliablegun 86% (real ~14% gap; near threshold)
  - londerosports 84.6% — `bootstrap complete` w/ COVERAGE WARNING after 4 passes; WON'T transition; expected 12414 may be inflated by Magento variant overlap
  - outfitters 64.3% (exp corrected 1880→1962)
  - northprosports 62% and **climbing** (the one healthy site — www fix working)
  - ellwoodepps 58.9%
  - lockharttactical 34.4%
  - precisionoptics 25.2%
  - solelyoutdoors 20.4%
  - jobrookoutdoors 8.6%
- 7 prior code fixes still uncommitted. NOTHING committed/pushed this session.

## What this session FIXED
1. **Global crawl freeze (was THE blocker):** 13 hung leftover tsx scripts from the prior session held Upstash/Postgres connections; the dev-server scheduler was idle (events1h=0 across ALL sites incl. maintain). Fix: killed the 13 scripts + clean dev-server restart. Crawling resumed immediately.
2. **3 siteProfile patches applied + read-back-verified** (via `backend/scripts/_apply-coverage-fixes-2026-06-01.ts`, lastVerified=2026-06-01T21:11Z):
   - **lockharttactical**: paginationPattern → `{type:'offset-query', template:'limitstart', perPage:40}` (was `type:'query'` sending page-numbers as offsets → infinite walk). Single `/recent` stream lists all 2450.
   - **outfitters.goldnloan**: added `https://outfitters.goldnloan.com/shop` global stream; expectedProductCount 1880→1962.
   - **northprosports**: catalogUrls host `northprosports.com`→`www.northprosports.com` (bare host TIMES OUT; www loads). This is why northpro now climbs. (Brief's "leaf subcategory gap" was WRONG — parents are inclusive.)
3. Fixed `_rca-catalog-stall-2026-06-01.ts` to end with `process.exit(0)` (was hanging).

## VERIFIED ROOT CAUSES still open (all CODE — need src edit + restart = Part B)

### A. Orphaned-active catalog jobs re-run with STALE data on restart (THE durable blocker)
- The in-process BullMQ worker (concurrency 20, `worker.ts:1054`) does NOT close gracefully on SIGTERM/SIGKILL. In-flight `crawl-catalog` jobs orphan into `active`.
- On worker restart, BullMQ **re-assigns** the orphaned-active jobs to the new worker and re-runs them **with their original job data** (streamState/profile snapshot from enqueue time) — so cov-fixer's profile fixes do NOT reach them, and they re-hang.
- `removeStaleJob` (queue.ts) SKIPS `active` jobs; force-removing a live-locked job throws "could not be removed because it is locked by another worker". Manual clear only works in the ~5-min window after worker death **before** lock TTL (lockDuration 300000) expires AND before a new worker grabs them.
- Evidence: after restart, ellwood/jobrook/lockhart/outfitters/precision/solely catalog jobs were all `active(93-95m)` and re-locked by the fresh worker.
- **Correct manual clear sequence (until durable fix lands):** kill dev server → WAIT >5 min (lock TTL expires, no live worker) → `npx tsx backend/scripts/_force-clear-orphaned-catalog-2026-06-01.ts --apply` → restart dev server → `node backend/scripts/_nudge-due-2026-06-01.js --apply`.
- **Durable fix (Part B-1, highest priority):** (a) graceful shutdown in `backend/src/index.ts` — `process.on('SIGTERM'/'SIGINT', () => worker.close())` for all workers so jobs release locks; (b) `removeStaleJob` (queue.ts) ALSO remove an `active` job whose lock expired (`processedOn` age > lockDuration) via try/remove catch-on-locked. Without this, every restart re-orphans.

### B. catalog crawls hang in infinite pagination loops (per-platform)
- **outfitters (Odoo):** out-of-range pages (`/shop/category/archery-131/page/98`) return **page-1 content with products** → walk never hits 0 → loops p98,99,100… forever (job ran 91 min). Fix (Part B-2): in `catalog-crawler.ts` stream-walk (~756-905), detect when a page's product set is byte/URL-identical to a prior page (or page 1) → terminate the stream. (cov-fixer proved this on `/shop/category/archery-131/page/98` byte-identical first-href to page 1.)
- **lockharttactical (HikaShop):** old pagination sent `limitstart=202` (page number as offset) → always returned products → infinite. The applied offset-query fix resolves this ONCE the stale hung job is cleared (see A).

### C. Playwright Cloudflare false-positive (jobrook, solely; also gunpost, londero en-* streams)
- `playwright-fetcher.ts:~257` treats the page as "still challenged" while `html.includes('challenge-platform')` — but that beacon is present on EVERY page of these passive-CF sites, so resolution NEVER succeeds and pages return ~0 products. `hasWaf:true` already routes to Playwright, so `needsPlaywright` is moot.
- Fix (Part B-3): change the challenge-resolved check to a positive signal (product markup / expected selector present, or title != "Just a moment") instead of absence of `challenge-platform`. Verify against jobrook + solely live.

### D. Bootstrap coverage-retry resets stream to page 1 (secondary)
- `worker.ts:292-301` (and 312-314): when site coverage <95% on cycleComplete, sets `tierState.currentPage=1` + never sets `lastCycleCompletedAt` → re-walks each stream from p1, up to 3 passes, then marks complete w/ `coverageWarning` (stuck below 95%, won't transition).
- MOOT once catalogUrls are correct (a correct single pass hits ≥95% → gate passes → markComplete). Fix only if a site legitimately needs >1 pass. Low priority.

### E. Inflated expectedProductCount on near-threshold sites
- londerosports (12414) & possibly reliablegun (6441): the missing ~14% may be Magento configurable-variant overlap / OOS-hidden, not real products. Re-derive authoritative count (catalog-walk distinct URLs, NOT sitemap) before deciding; if inflated, correct expected → site transitions.

## Crawler facts re-confirmed this session
- baseBudget still ~5000 (reliablegun/others crawl at 4998 tokens) — daily adjuster hasn't reverted. Restore via `_basebudget-bump2-2026-06-01.js --restore --apply` (+ check `_basebudget-restore-2026-06-01.json`) when wrapping.
- Scheduler catalog dispatch gate (`crawl-scheduler.ts:309`) reads LEGACY tierState `activeTiers` (all sites show ANY_ACTIVE=true — not the blocker). Reseed (`maybeReseedStreamState`) fires when `streamState.detectedAt < siteProfile.lastVerified`; crawl-scheduler reseed loop EXCLUDES null streamState (don't null it to force reseed — bump lastVerified instead).
- gunpost.ca (maintain) watermark loops on unresolved Cloudflare challenges (35s timeouts) — same root cause as C.

## Recommended next-session order
1. **Part B-1 (graceful shutdown + removeStaleJob lock-expiry)** via harness (engineering-backend-architect + engineering-code-reviewer + everything-claude-code:silent-failure-hunter). tsc + vitest. This stops the orphan-job churn permanently.
2. Clear stale hung jobs (correct sequence in A), restart, nudge → lockhart should reach ~95% (pagination fixed) → transition + Phase-3.
3. **Part B-2 (Odoo out-of-range loop)** → unblocks outfitters.
4. **Part B-3 (CF false-positive)** → unblocks jobrook, solely (+ helps gunpost, londero).
5. Re-derive londero/reliablegun authoritative counts (E); transition if inflated.
6. ellwood/precision/northpro: with A+B fixed, let them crawl to ≥95% then transition.
7. Wrap: restore baseBudgets; final per-site report.

## UPDATE 2 (2026-06-02): Part D applied+live; maintain validation done; Parts E/F + gap audits remain

### Live now (applied + reviewed): Part D (round-robin end-of-round coverage gate + all-streams readiness)
worker.ts processStreamCatalogCrawl: each completed stream now ALWAYS sets lastCycleCompletedAt (round-robin rotates to unvisited streams instead of re-walking one); coverage probe moved to end-of-round site-level gate (site-level bootstrapPassCount on streams[0]:4, bounded 3 rounds); maintain-readiness requires ALL streams' T4 complete. 2 reviewers PASS (R1 verified the 3-round bound holds; R2 findings non-blocking/unreachable). tsc clean, tests pass. Verified live: streams rotate + complete (freeze gone).

### MAINTAIN = 9 (added this session: lockharttactical, outfitters.goldnloan, londerosports)
All 3 validated (parallel testing-api-tester team):
- **lockhart**: keyword search PASS (0 misses, clean precision, mag≠magpul guard works); tiers PASS (7d, 0 failures).
- **outfitters**: keyword search PASS (higher recall than retailer, 0 false positives); tiers PASS (23 events, 0 fail).
- **londero**: tiers PASS (183 events, 0 fail, Playwright works under Sucuri); keyword search CONCERN — REAL BUG (below).

### Two validation-found issues (Part F — implemented in a worktree but NOT applied; needs rework + review)
1. **Corrupted product tags (real, FLEET-WIDE):** `deriveCategoryFromUrl` (stream-detector.ts) used URL segments verbatim, so a catalogUrl ending in `firearms.html`/`categories.php` leaked the filename into `stream.category` → `product.tags` (catalog-crawler.ts:926). Effect: searching "ammunition" tag-matches `ammunition.html` rows that are mis-tagged FISHING TACKLE (Rapala) → false positives. Fleet-wide: 1937 bad-tag rows across 4 sites (110 cleanable by stripping ext, 1827 garbage = Volusion numeric-id residue `category_s-662`, solely pagination junk `firearms.htmlpage209.html`).
   - **partf-fixer's fix is UNSAFE as written:** it normalizes inside `deriveCategoryFromUrl`, which produces the stream **id** (not just the tag). Stripping `.html` would CHANGE stream IDs for .html/.htm sites (ellwood, precision, …) → orphan their streamState → reset bootstrap progress. ALSO its worktree branched from origin/main and LACKS all uncommitted Part A/B/C/D work — DO NOT file-copy its stream-detector.ts/keyword-matcher.ts/worker.ts/catalog-crawler.ts (would wipe 4 sessions).
   - **CORRECT fix (rework):** normalize the **category/tag only** — at the tagging site (catalog-crawler.ts:924-927, clean `stream.category` before assigning to `p.tags`) OR set `stream.category` via a normalizer that does NOT touch `stream.id`. Then the cleanup script (`_partf-fix-tags-2026-06-01.ts`, in the partf worktree; dry-run = 110 cleaned / 1827 nulled) needs 2-reviewer review before --apply (1937-row write that nulls garbage tags → reduces tag-based recall only for those garbage rows).
2. **Silent take:1000 search cap (cross-cutting, benign):** keyword-matcher.ts searchProductIndex caps at 1000 fleet-wide; big keywords (rifle/reloading) silently truncate per-site. partf added a SEARCH_INDEX_CAP constant + warn/pushEvent on cap-hit — safe small change, but lives in the unsynced worktree; re-apply by hand to main's current keyword-matcher.ts.
   - Also: T1 watermark only scans page 1 (fine while no new arrivals; confirm it indexes >0 after a real new arrival). T3 verify unproven on freshly-maintain sites (nothing in its age band yet) — re-check later.

### REMAINING to push the last 6 bootstrap → maintain (the core goal, NOT done)
Coverage: ellwood 93%, reliablegun 86%, northpro 82% (CLOSE); precision 30%, solely 27%, jobrook 16% (FAR). All mechanism bugs fixed; blockers now are throughput + coverage:
- **Part E (throughput):** the end-of-round gate clears ALL lastCycleCompletedAt to start a new round → re-walks EVERY stream → burns the hourly token budget (5000) re-indexing already-done products (observed: dispatches now use 34-54 tokens; reliablegun re-walks firearms's 884 already-indexed). Fix: on a new round, do NOT re-walk fully-covered streams — only continue under-covered/token-truncated ones (preserve resume). Unblocks the CLOSE sites.
- **catalogUrl gap audits (FAR sites):** jobrook (1196 reachable vs 1669 expected = real gap), precision (19 cats may not cover 6049), solely (49 streams + `firearms.htmlpage209.html` pagination junk = catalogUrl/pagination bug). Per-site /pre-bootstrap-style audits to add missing catalogUrls or correct expected counts.

### Operator state / wrap items
- baseBudget still bumped to ~5000 (restore via `_basebudget-bump2-2026-06-01.js --restore --apply` at final wrap).
- Backups: `backend/_partb_backup_2026-06-01/` (delete once Part B confirmed stable).
- Session worktrees can be `git worktree remove`d once their fixes are confirmed applied.

## UPDATE (late 2026-06-01): Part B APPLIED + LIVE; per-site driver findings

**Part B applied to main** (manually merged — git apply failed, main had uncommitted changes in all 4 files): index.ts (6-worker graceful shutdown + allSettled/timeout), queue.ts (removeStaleJob lock-expiry + non-lock rethrow, using new queue-stale-job.ts), catalog-crawler.ts (repeat-page guard + new catalog-page-signature.ts), playwright-fetcher.ts (CF interstitial classifier + new cf-interstitial.ts). tsc clean, 32 tests pass (prior remove-stale-job test updated to new contract). Orphaned jobs cleared, server restarted, fixes confirmed live in logs. Backup of the 4 originals at `backend/_partb_backup_2026-06-01/` (delete after fixes confirmed stable).

**Verified working:** outfitters repeat-guard ended the Odoo loop; removeStaleJob removed lock-expired orphans + correctly skipped fresh-locked jobs; northpro 62→82%.

**site-driver per-site verdicts (all live-verified):**
- **londerosports — count was INFLATED, FIXED:** expectedProductCount 12414→10732 (live Magento-2 toolbar sum; sitemap over-counted). Now 97.9%. Transition still BLOCKED by readiness "bootstrap tier not completed" — needs one clean catalog cycle at the new count to set lastCycleCompletedAt (Sucuri site → slow Playwright cycle). Will clear on its own.
- **outfitters — 100% of DISTINCT products (1962).** The 123% = 461 DUPLICATE rows: `/shop/category/*` streams emit category-prefixed URL variants of products already captured by the `/shop` all-products stream (every dup shares an Odoo product-id with a clean row; zero unique). FIX OPTIONS (your call): (a) Odoo URL canonicalization in adapter `/shop/category/X/slug-ID`→`/shop/slug-ID` (backend/src), or (b) drop the 8 `/shop/category/*` streams from catalogUrls (profile; loses per-category tags). Not blocked.
- **ellwood — count REAL (live toolbars 33,945≈33,601), pagination CORRECT** (accessories 177 pages walk fully, `?limit=100&p=N` honored, no early stop). Pure VOLUME under round-robin. Needs crawl time, no fix.
- **precisionoptics — profile CORRECT, repeat-guard handles Volusion overflow. Throughput-bound.** No fix.
- **reliablegun — 6441 (sitemap distinct) is CORRECT, do NOT lower** (per-category sums overlap heavily — `sales` cat 400pp duplicates firearms/ammo). Throughput-bound (big `sales` cat). No fix.
- **northpro — NOT an IP ban** (www 200; bare non-www host simply not served; our IP fine via google/reliablegun controls). Origin is LOAD-SENSITIVE (started timing out under crawler+probe combined). 81.6%; whether remaining ~18% is subcategory gap vs 3-pass-limit is DEFERRED — re-probe at low load.

## Part C — REMAINING code fixes flagged by site-driver (backend/src, need restart; do via harness)
1. **jobrook + solely (throughput unlock):** both are PASSIVE Cloudflare (static fetch returns 200 + full product HTML, no challenge) but `hasWaf:true` forces `fetchWithPlaywright` per page (catalog-crawler.ts:785) AND the scheduler RE-LATCHES hasWaf false→true on any cf-ray response (crawl-scheduler.ts:442). Combined with one-stream-per-tick round-robin (worker.ts:195-200), throughput is glacial (49 streams, everCompleted=0). FIX: don't treat passive CF (status 200 + product HTML) as hasWaf, OR guard the scheduler:442 re-latch so flipping hasWaf=false sticks → switches to the fast static path (Playwright fallback at catalog-crawler.ts:819-827 remains the safety net). Pagination is already CORRECT for both (verified: page2 returns distinct products).
2. **lockharttactical (REAL save bug):** catalog runs report `pages=58 found=2378 success` but `latest firstSeenAt = 2026-05-30T10:34` — ZERO ProductIndex rows created since, despite extraction succeeding + products passing the saveProducts filter. lockhart-specific (8 other sites created rows in the same window). Start at the swallowed-error path `product-upsert.ts:415-420` (console.error only). This is THE reason lockhart is stuck at 34%.
3. **outfitters dup** (see above) — optional.

## Part B code fixes — IMPLEMENTED in a worktree, reviewed, reworked (now APPLIED — see UPDATE above)
Worktree: `D:\Projects\FIREARM-ALERT\.claude\worktrees\agent-a3f0e4e0cb93aa8db` (branch `worktree-agent-a3f0e4e0cb93aa8db`), agentId `a3f0e4e0cb93aa8db`.
Files changed: `backend/src/index.ts` (FIX 1a graceful shutdown), `backend/src/services/queue.ts` + new `queue-stale-job.ts` (FIX 1b removeStaleJob lock-expiry), `backend/src/services/catalog-crawler.ts` + new `catalog-page-signature.ts` (FIX 2 repeat-page guard), `backend/src/services/scraper/playwright-fetcher.ts` + new `scraper/cf-interstitial.ts` (FIX 3 CF classifier). tsc clean + 19 unit tests in worktree.

Two reviewers (engineering-code-reviewer + silent-failure-hunter) verdicts:
- FIX 1a: rework — bare `Promise.all` aborts shutdown on one rejection + no timeout (wedged Playwright hangs shutdown). Rework: `Promise.allSettled` + 25s `Promise.race` timeout, keep unconditional exit (server.close callback intentionally removed — SSE would hang it).
- FIX 1b: kill-live-crawl SAFE (boundary correct, Redis-lock-guarded). Rework: catch must rethrow non-`/lock|could not remove/i` errors (don't swallow Redis failures as 'skipped').
- FIX 2: **FAIL** — `firstURL|count` signature falsely truncates catalogs that pin a featured product to page-top (page2/3 share first+count → silent catalog truncation, worse than the loop bug). Rework: signature → `firstURL|lastURL|count` + guard empty `|0`.
- FIX 3: PASS (detection correctly narrowed; dead `isCfResolved` is a harmless nit).
Rework sent to the agent (resumed in worktree) on 2026-06-01 ~late session. CONFIRM the rework landed (re-read its report) before applying.

### ⚠ APPLY/MERGE PROCEDURE — READ CAREFULLY (the reviewed fixes are NOT applied to main)
**Applyable artifact:** `docs/session-handoffs/2026-06-01-partb-fixes.patch` (549-line `git diff` from the worktree, includes all 10 files: 4 modified + 3 new modules + 3 test files). Use this; the worktree branch (`worktree-agent-a3f0e4e0cb93aa8db`) may be auto-cleaned.

**CRITICAL merge reality (verified via git status):** the worktree branched from committed HEAD, but main's working tree has UNCOMMITTED changes in ALL FOUR modified files — `index.ts`, `catalog-crawler.ts`, `queue.ts`, `playwright-fetcher.ts` (these were already `M` at session start, weeks of prior work). So:
- **DO NOT file-copy any of the 4 modified files** worktree→main — it would clobber main's uncommitted work.
- **3 new modules + 3 tests apply cleanly** (new files, no conflict): `services/queue-stale-job.ts`, `services/catalog-page-signature.ts`, `services/scraper/cf-interstitial.ts`, + their `__test__` files.
- **`queue.ts`:** main ALREADY has a `removeStaleJob` (uncommitted Fix #5). The patch's queue.ts hunk ADDS removeStaleJob (worktree HEAD lacked it) → it will DUPLICATE/conflict. Resolve by hand: enhance main's EXISTING `removeStaleJob` to (a) import + use `decideStaleJobAction` from the new `queue-stale-job.ts` (lock-expired-active removal), (b) add the catch that rethrows non-`/lock|could not (be )?remove/i` errors. Keep main's existing callers.
- **index.ts / catalog-crawler.ts / playwright-fetcher.ts:** apply the patch hunks with `git apply --3way docs/session-handoffs/2026-06-01-partb-fixes.patch` (or manual). Likely apply cleanly IF main's uncommitted edits don't touch the same regions (shutdown handler in index.ts; the HTML stream-walk ~L880 in catalog-crawler.ts; CF detection/resolution in playwright-fetcher.ts). If a hunk rejects, apply that hunk by hand from the patch — the changes are small + well-described in this doc's "Part B code fixes" section.
- **After merge: `npx tsc --noEmit` on the MERGED main tree** (the worktree tsc did NOT include main's other uncommitted fixes — integration types may surface) + `npx vitest run`.
- Apply requires the dev server STOPPED (editing main src restarts ts-node-dev). Sequence: stop server → wait >5 min (orphan lock TTL expires) → `_force-clear-orphaned-catalog --apply` → apply patch/merge → tsc + vitest → `npm run dev` → `_nudge-due --apply` → verify sites climb (lockhart should reach ~95% with its pagination fix once the stale hung job is cleared).
