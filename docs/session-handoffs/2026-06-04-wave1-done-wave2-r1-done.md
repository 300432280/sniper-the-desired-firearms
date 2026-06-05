# Session Handoff — 2026-06-04 — 13-site onboarding (Wave 1 done, Wave 2 R1 done)

Continuation of the 13 parked-retail-site bootstrap→maintain drive with re-verified counts.
Hit session limit (resets 11:40pm America/Toronto) mid Wave-2 R2. Read this + the ledgers:
- docs/site-audit/_WAVE1-R4-SYNTHESIS-2026-06-03.md (Wave 1 final corrections + lessons L1-L6)
- docs/site-audit/_WAVE2-R1-LEDGER-2026-06-03.md (Wave 2 R1 per-site findings + 2 harness gaps)

## STATE — the 13 sites
WAVE 1 (6 near-ready) — DONE:
- pavillon, rangeview, g4c*, wolverine, oleys → MAINTAIN. Validated PASS: pavillon, rangeview, g4c, wolverine. **oleys validation still PENDING.**
- shooterschoice → bootstrap, plateaued ~94.3% of corrected 11409 (slow oldest-OOS WP REST tail). Either finishes the sweep or force-transition (deepVerify ok; remaining backfills in maintain). Then validate.
- truenortharms → bootstrap. **Index bloat FIXED**: _tna-cleanup-404 deactivated 3655 confirmed-404 (0 alive touched, 20 renames spared); active ~1017 / count 1125 (~90%). Site unpaused + crawling. Let it reach ~100% then force-transition + validate.
(* g4c + frontier were the original overwatch pair, both maintain+validated.)

WAVE 2 (7 parked giants) — R1 DONE, R2 must RE-RUN (session limit truncated all 7 R2 agents):
- store.theshootingcentre.com, thegundealer.ca, store.prophetriver.com, rdsc.ca, www.gagnonsports.com, sail.ca, www.gobles.ca — all still isEnabled=false (parked). NONE hard-blocked. See _WAVE2-R1-LEDGER for per-site count + fixes.

## APPLIED THIS SESSION (DB writes, with backups)
- backend/scripts/_w1-apply-corrections-2026-06-03.ts (--apply done) — 6 Wave-1 sites' siteProfile corrections + hasWaf/requiresSucuri flips + truenortharms streamState reset. Backup: _w1-corrections-backup-2026-06-03.json.
- backend/scripts/_w1-enable-2026-06-03.ts (--apply done) — enabled+bumped the 6 (pavillon 1800, rest 3600). Backup: _w1-enable-backup-2026-06-03.json.
- backend/scripts/_tna-cleanup-404-2026-06-03.ts (--apply done) — deactivated 3655. Report: _tna-cleanup-report-2026-06-03.json.
- Force-transitions: pavillon, rangeview, g4c, wolverine, oleys (+ frontier earlier).
- Budgets STILL BUMPED for the old-20 (via _budget-throughput) AND the 6 Wave-1 sites. Restore at wrap.

## NEXT SESSION — resume order
1. Re-run **Wave 2 Round 2** (7 testing-api-tester agents, GENTLE probe only — heavy probe bans IPs (L3)). Missions per _WAVE2-R1-LEDGER "OPEN FOR R2": per-site count-SURFACE (L1), catalogUrls coverage (gagnon firearms tree, sail /en/hunting re-scope, gobles dead-URL fix, theshootingcentre +clearance), and PROPHETRIVER failure-trace (query CrawlEvent failed/errorMessage before re-enabling). Then R3 (engineering-code-reviewer adversarial) → R4 synthesis.
2. **Wave 2 Phase B**: write _w2-apply-corrections + _w2-enable (mirror the _w1 scripts), apply, enable, crawl, transition at >=95% (or proven ceiling), validate. NOTE prophetriver: do NOT re-enable until its failure cause is traced (only unexplained blocker; count is 2.6x inflated -> ~5414). sail: re-scope to /en/hunting + count 3223 BEFORE enabling (else it re-stalls on whole-store walk).
3. **Finish Wave 1 tail**: validate oleys; transition+validate shooterschoice (force at ~94% ok) and truenortharms (after it re-crawls to ~100%).
4. **WRAP**: restore budgets (_budget-restore-2026-06-02.json for old-20; _w1-enable-backup-2026-06-03.json for the 6); deliver consolidated final report.

## HARNESS/SKILL FIXES SURFACED (for a code/SKILL pass, not yet applied)
- L1 count-surface rule (expectedProductCount must match the runtime-crawled surface) — SKILL.md.
- L2 productCountMethod must match real <loc> URL shape + canonical `url` key (generic-product-sitemap silent-nulls on trailing-slash; bc-xmlsitemap bare-string silent-nulls).
- L3 heavy 8-batch probe bans IP-reputation WAFs (Imunify360) — gate it off for onboarded sites.
- json-api-count (product-count-probe.ts:~265) lacks absolute-URL guard -> can't count foreign-origin Searchspring/Algolia (sail).
- Scope enforcement: general retailers (sail) need firearm-relevant catalogUrls, not whole-store.

## GOTCHAS
- Dev server (PID changes) must be running on :4000; if down/zombie, kill only FIREARM-ALERT node procs, restart `cd backend && npm run dev`.
- Bash cwd resets to repo root intermittently -> always `cd /d/Projects/FIREARM-ALERT/backend &&` before npx tsx.
- 04:00 UTC daily adjuster reverts baseBudget -> re-bump if a site crawls too slowly.
- Candidate JSONs for all 13 sites are in docs/site-audit/<domain>-*.json.
