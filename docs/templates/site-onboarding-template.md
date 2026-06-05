# Site Onboarding Template — bootstrap → maintain → validated

Reusable prompt for driving N sites end-to-end through the bootstrap → maintain transition + tier validation. Fill in the **Sites** list at the top and paste this prompt verbatim into a session.

This template encodes lessons from the 2026-05-30 session (15-site batch). Anti-patterns it explicitly forbids:
- Writing a custom bulk-bootstrap script (it drops the production Playwright cascade).
- Touching `monitoredSite.baseBudget` or the per-domain rate-limit delay (production controls).
- Imposing a 30-minute give-up cap per site (fix-and-retry is unbounded).
- Trusting subagent status claims without DB verification.
- Unpausing previously-paused sites without checking the prior pause reason.

---

# GOAL — drive the sites listed below all the way through bootstrap → maintain → validated. Active, push through, do not pause halfway.

Sites:
<comma-or-newline-separated list of domains>

**MANDATORY at session start**: load the `andrej-karpathy-skills:karpathy-guidelines` skill. Apply its 4 principles (think-before-coding, simplicity-first, surgical-changes, goal-driven) to every code change and every fix attempt.

**MANDATORY for every non-trivial code change**: use team of agents. The 3-role harness is one implementer + two reviewers, dispatched IN PARALLEL after the implementer commits the change to disk:
- **Implementer**: an `engineering-backend-architect` (or `engineering-frontend-developer` / `crawler-specialist` / `testing-api-tester` etc.) with the matching `.claude/agents/<role>.md` persona inlined verbatim in the spawn prompt. This is non-negotiable per the project's CLAUDE.md persona-load rule.
- **Reviewer 1**: `engineering-code-reviewer` (with `.claude/agents/engineering-code-reviewer.md` persona inlined) — project-aware correctness/regression review.
- **Reviewer 2**: an ECC skill matched to the failure mode. Pick the right one:
  - silent-failure / false-PASS / data-loss risk → `everything-claude-code:silent-failure-hunter`
  - general code quality / overengineering → `everything-claude-code:code-reviewer`
  - auth / secrets / SSRF / injection / OWASP → `everything-claude-code:security-reviewer`
  - type errors blocking progress → `everything-claude-code:build-error-resolver`
  - database queries / migrations / schema → `everything-claude-code:database-reviewer`
  - performance regressions / N+1 / heavy queries → `everything-claude-code:performance-optimizer`
  - test coverage gaps → `everything-claude-code:pr-test-analyzer`
  - dead code from your fix → `everything-claude-code:refactor-cleaner`

Apply the change to disk only when BOTH reviewers PASS. If either reviewer FAILS or surfaces a HIGH/MEDIUM concern: rework, re-dispatch the reviewers, repeat. ONE rework round per change; if still rejected, mark that hypothesis dead and try a different one (per Global posture below).

DB writes ARE AUTHORIZED for this goal (profile promotion, isEnabled, isPaused, crawlPhase transition, surgical profile field corrections during fix loops). DO NOT COMMIT, DO NOT PUSH. Use TodoWrite to track per-site state. Surface ONLY true blockers (irreversible destructive action, unrecoverable infrastructure failure, genuine ambiguity).

## Global error-handling posture (applies to ALL phases — this is the heart of the prompt)

When ANY operation fails for ANY site:
1. INVESTIGATE the root cause. Read code, query DB, fetch live URLs, read backend stdout (`npm run dev | tee /tmp/backend.log`), grep for the specific log lines that should have fired.
2. Form a hypothesis. Apply the surgical fix: one-line code change, one profile field correction, one DB cleanup, swap fetch path, fix a Mistake-style platform quirk (Mistake 20 Magento sort, 21 OpenCart, 22 Odoo, 24 Volusion `searching=Y`, 26 LightSpeed suffix pagination, 34 WC `apiCrawlUsed`, etc.).
2a. If the fix is a non-trivial code change (not a one-line profile field edit, not a DB cleanup): dispatch the team-of-agents harness defined above. Don't ship a code change without the implementer + 2 reviewers signing off. For one-line profile/DB edits, the harness is overkill — apply directly + verify with live data.
3. RE-RUN the failing step. Verify the fix took effect with live data, not "should work."
4. If the first hypothesis didn't fix it: discard, form a DIFFERENT hypothesis, apply a different fix, re-test. Keep looping. There is NO 30-min give-up timer. There is NO fixed hypothesis count. Stop only when the site IS in maintain + tier-validated, OR when the next step is genuinely bigger than fix-and-retry (full pre-bootstrap re-audit, new adapter, schema redesign).
5. NEVER silently swallow an error. Every fix attempt is logged in the final report: site, what failed, what was tried, what worked, what's still pending.

## Pre-flight (always)

- Backend dev server running on :4000 (`cd backend && npm run dev` in background; capture stdout to a tee'd log so silent-drop defects can be diagnosed). If it dies during the run, restart and verify HTTP response before continuing.
- `npx tsc --noEmit` exit 0 and `npx vitest run` passing before starting.
- Confirm each listed site exists in `monitoredSite`. Note current `crawlPhase`, `isEnabled`, `isPaused`. If a site is paused from a prior session, read the prior `notes` or session handoff for the pause reason — that's the FIRST hypothesis to investigate in Phase 2/3.

## Speed vs. politeness (read carefully — easy to get wrong)

You may change crawl-time speed parameters. You may NOT change per-site token budget or per-domain rate limit.

- **DO NOT change `monitoredSite.baseBudget`** for any site. The token budget is a production setting and gates per-site request rate. Leave it at the existing value the auto-adjuster set (`<100=20, 100-500=40, 500-2000=60, 2000-5000=90, 5000-10000=120, 10000+=180`).
- **DO NOT remove or shorten the per-domain rate-limit delay** in `http-client.ts` (~800ms-3s gap between requests to the same domain). That's the "respect the site" guarantee.
- **DO change** (if needed to make wall-clock faster):
  - Scheduler tick interval (default 2 min in `crawl-scheduler.ts`) — can be tightened for this session if sites are sitting idle waiting for the next tick.
  - `MAX_CONCURRENT_CRAWLS` (default 10, `crawl-scheduler.ts:31`) — bump to >= N (number of sites) for this session so all sites run in parallel.
  - `MAX_GLOBAL_CRAWLS_PER_HOUR` (default 200, `crawl-scheduler.ts:32`) — bump to accommodate parallel sites.
  - BullMQ worker concurrency (`worker.ts:976`, default 20) — bump if you observe queue backup.

These are session-scoped tweaks to the running dev server. Revert before the next production-style run.

## Phase 1 — Bootstrap (production scheduler/worker drives it; you do not write a bootstrap script)

### 1a. Profile promotion (one canonical script, idempotent)
For each site: find newest `<domain>-<ISO>.json` candidate-profile in `docs/site-audit/` (exclude `-diff.md`, `-investigation.md`, `-review.json`, `-counter.md`, `-review.md`, `-corrections.json`, `-evidence.json`). Promote if audit `lastVerified` strictly newer than DB `lastVerified`. Merge rule: `next = { ...db, ...audit }` then overlay back from DB: top-level `budget, timeout, t1IntervalMin, dataFlow, notes, name, siteCategory, hasRateLimit`; nested `crawlers.maintain.cooldowns/tierShares/tierWindows, crawlers.maintain.method, crawlers.bootstrap.*`. Dry-run → `--apply`. Idempotent re-run = 0 promotions. On error: Global posture.

### 1b. Enable + speed tweaks
Set `isEnabled=true` for all listed sites. If any is `isPaused=true`, set `isPaused=false`. Apply the session-scoped speed tweaks above so the production scheduler can run all N sites in parallel.

### 1c. Let production bootstrap
You do NOT write a bootstrap script. The running backend's scheduler (`crawl-scheduler.ts:62-315`) ticks, queues `crawl-watermark` and `crawl-catalog` jobs, the worker (`worker.ts:179-355`) processes them via `processStreamCatalogCrawl` → `crawlStreamTier` (`catalog-crawler.ts`) → `saveProducts`. Production already has the Playwright cascade in `fetchHtml` at `watermark-crawler.ts:71-125` and in `catalog-crawler.ts:425-433`. The worker self-queues the next batch after each batch via `worker.ts:328-352`.

Your job during Phase 1c: monitor + intervene. Poll DB every ~2 min:
- `crawlEvent` counts per site (watermark + catalog status)
- `productIndex` count per site vs. `siteProfile.expectedProductCount`
- `streamState.tiers[*].lastCycleCompletedAt` (signals coverage gate hit)
- Backend stdout for `[Scheduler]` / `[CatalogWorker]` / `[CatalogWorker] Bootstrap complete for <domain>` lines

For each site, the bootstrap is DONE when coverage ≥95% AND streamState tiers complete. If a site stays stuck (no progress in N ticks, or coverage plateauing well below 95%), apply Global posture: investigate root cause (read backend log lines, query stuck stream tier state, fetch live catalog URL, etc.), fix, let the scheduler resume.

## Phase 2 — Refresh + transition (per site, as each completes bootstrap)

When a site signals bootstrap-done (coverage ≥95%, streamState.tiers complete):
1. Call `refreshFullReadiness(siteId)` (`maintain-readiness.ts:943-960`). All 4 gates must be GREEN:
   - `readiness`: verifyMethod present + endpoint when needed + coverage thresholds (retailer 95%, classifieds 70%, forum/auction 50%) + tier completion. C1 fix counts `stockStatus='unknown'` as missing.
   - `deepLight`: urlOk + titleOk + watermarkOk
   - `deepVerify`: 3/3 sample products reachable through verifyMethod end-to-end
   - `watermarkWalk`: walkOk AND `sortAxisOk !== false` (C2 + Gap 2)
2. If all GREEN: call `transitionSiteToMaintain(siteId)` (`maintain-readiness.ts:335-424`). NOT force, NOT skipReadinessCheck — the hard gates are not bypassable. Verify `crawlPhase='maintain'` in DB.
3. If any RED: Global posture. The gate that failed names the file:line. Common fixes: clear a stale `lastWatermarkUrl`, fix a dual-sortParam profile field (gunpost-style URL doubling), correct an adapter URL extraction quirk, etc. Re-run refresh after each fix. Loop until GREEN.

## Phase 3 — E2E + tier validation (per transitioned site, as each transitions)

### 3a. E2E search test
Login `POST /api/auth/login` with `email=a@b.com password=a@b.com`, capture cookie. For each keyword in `["AR-15", "SKS", "Glock", "9mm ammo", "Lee-Enfield", "scope", "magazine", "shotgun", "rifle case", "holster"]`:
- `GET /api/searches/live?keyword=<KW>&searchAll=true` with the cookie.
- Filter results to ONLY transitioned domains.
- Sample up to 5 per site per keyword: fetch URL via production `fetchHtml` cascade (NOT bare axios — let it Playwright-fall-back), assert status=200, NOT a soft-404 (B1 + per-site `deletionMarkers` if set), keyword-matched via `expandKeyword` from `keyword-matcher.ts`, price>0 when stockStatus=in_stock.
- On failure: Global posture. Don't accept "the script's literal substring check is too strict" as a fix — actually invoke `expandKeyword` and `matchesKeyword` from production code to mirror server-side matching.

### 3b. Tier validation
For each transitioned site, watch `crawlEvent` for at least:
- One `crawl-watermark tier=1 status=success pagesScanned>0`
- One `crawl-verify tier=2 status=success`
- T3/T4: note as "pending — observe in 24h" only if no products fall in the tier's age window (8-20d for T3, 21+d for T4). Otherwise expect them to fire.
- No 3+ consecutive failures.

**Critical defect class to watch for**: T1 fires but T2/T3/T4 verify NEVER enqueues. This is a job-silently-dropped between `[Scheduler] <domain>: maintain phase, queuing verification` (`crawl-scheduler.ts:222`) and `[VerifyWorker] T<n> verifying` (`worker.ts:773`). Diagnose via tee'd backend log. Apply Global posture — this WILL need a code fix to the scheduler or worker; do not defer.

## Scope

### IN scope
- Promoting siteProfiles + enabling sites + monitoring production bootstrap + refresh + transition + E2E + tier validation, for every domain listed at the top.
- Re-attempting previously-paused sites in the list. Prior pause reason is the FIRST hypothesis; if it no longer applies, move to the next hypothesis under Global posture.
- Code-base bug fixes when surgical — one-line change, one profile field, one DB cleanup, swap fetch path, fix a Mistake-style platform quirk. These are required to push paused sites through; do not refuse them.
- Speed-parameter tweaks (scheduler tick, concurrency caps, BullMQ worker concurrency) for the running dev server.

### OUT of scope
- Sites NOT explicitly listed at the top of this prompt.
- Architectural changes bigger than fix-and-retry: a new adapter from scratch, a new platform family, a schema redesign, a new auth flow. If a fix attempt reveals one of these is needed, document it as DEFERRED with the concrete next-session action and continue with the other sites.
- Changing `monitoredSite.baseBudget` (token budget) or the per-domain rate-limit delay in `http-client.ts`. Those are production-level controls; touching them defeats "respect the site."
- `--apply` on Gap 4's `_detect-deletion-markers` script for **triggersandbows.com** — that capture produces a false-positive title pattern (`store - triggers and bows`) that would deletion-flag every live product. Skip that specific apply.

### How to interpret "deferred"
A site is DEFERRED only when multiple distinct hypotheses have each been tried, applied, and re-tested without crossing the gate, AND the next step is genuinely bigger than this session can absorb (full pre-bootstrap re-audit, new adapter, schema change). The final report names every hypothesis tried + result + the concrete next-session action. DEFERRED never means "I ran out of time" — it means "the next step is bigger than fix-and-retry."

## Constraints (apply throughout)

- ALL subagent prompts inline the matching `.claude/agents/<role>.md` persona content.
- Backend dev server stays up on :4000 with stdout tee'd to a file.
- DB writes authorized for the categories listed above.
- DO NOT commit, push, or amend prior commits.
- Use `prisma db push` (never `prisma migrate`).
- On Windows: `.js` script files instead of inline `node -e`.
- After Phase 3, run `npx tsc --noEmit` + `npx vitest run` to confirm no test regressions from in-loop fixes.
- Revert session-scoped speed tweaks (scheduler tick, concurrency caps) before finishing so the dev server returns to production-style behavior.

## Final deliverable

Single end-of-run report with:
- **Per-site outcome**: PASS (in maintain + tier-validated) / DEFERRED (with concrete next-session action) for every listed site. No "FAIL" — only PASS or DEFERRED.
- **Per-site fix log**: every hypothesis tried + fix applied (file:line for code) + retest result. Reads as a chronological story per site.
- **Phase 1 monitoring summary**: bootstrap completion times per site, any sites stuck-and-fixed.
- **Phase 2 summary**: refresh+transition outcomes, any RED gates fixed.
- **Phase 3 summary**: E2E pass-rate per keyword × site, tier validation per site, any defects fixed.
- **Session-scoped speed tweaks**: list of what was changed and confirmation it was reverted.
- **Anything genuinely DEFERRED**: explicit concrete next-session action per item.
