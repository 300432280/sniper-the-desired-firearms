# Session Handoff — 2026-04-26 End of Session

> **Workspace-clickable copy** of the memory files Claude will auto-load at the start of next session. The CANONICAL source-of-truth lives in `C:\Users\TNT\.claude\projects\d--VScode-Projects-firearm-alert\memory\` and is auto-injected into Claude's context every session. This file is for YOU to verify what Claude knows.

---

## Memory Files (where Claude reads from)

| File | Auto-loaded? | Lines | Purpose |
|---|---|---|---|
| `MEMORY.md` | YES (every session, system reminder injection) | 67 | Index of all memory files |
| `project_next_session.md` | YES | 209 | The kickoff manifest — current state + Phase 7 plan + mandatory reading list |
| `34-site-audit-INDEX.md` | NO (read on-demand) | 199 | Searchable cliff-notes for the 34-site audit history |
| `34-site-audit-history.md` | NO (read line-ranges on-demand via INDEX) | 5832 | Full per-site investigation notes — DO NOT load whole file |
| `feedback_index_maintenance.md` | YES | 25 | Rule: index maintenance is Claude's job, not user's |
| `feedback_*.md` (other 5) | YES | ~150 total | Existing project-specific feedback rules |
| `architecture.md` | YES | small | Key files, patterns, gotchas |

**Total auto-loaded at session start: ~600 lines / ~12K tokens** (vs ~147K I loaded this session).

These all live at: `C:\Users\TNT\.claude\projects\d--VScode-Projects-firearm-alert\memory\`

---

## Files Claude Reads from the Workspace (clickable)

These are the project files referenced by the kickoff manifest — they ARE in your workspace:

- [docs/superpowers/specs/2026-04-24-pre-bootstrap-rebuild-design.md](../superpowers/specs/2026-04-24-pre-bootstrap-rebuild-design.md) — full spec (1062 lines). Phase 7 needs §4.5, §6.4, §5.4, §11.2.
- [docs/superpowers/plans/2026-04-25-pre-bootstrap-rebuild.md](../superpowers/plans/2026-04-25-pre-bootstrap-rebuild.md) — full plan (3089 lines). Phase 7 = Tasks 7.1-7.7.
- [.claude/catalog-url-discovery-playbook.md](../../.claude/catalog-url-discovery-playbook.md) — playbook (1218 lines, 39 Mistakes). Phase 7 needs Mistakes 9, 10, 12, 14, 32, 38.
- [.claude/agents/crawler-specialist.md](../../.claude/agents/crawler-specialist.md) — persona (82 lines, dense bullets). Mistakes 30-39 most relevant for Phase 7.
- [.claude/probe-rewrite-lessons.md](../../.claude/probe-rewrite-lessons.md) — anti-patterns (167 lines).
- [CLAUDE.md](../../CLAUDE.md) — project rules (you opened this).

Newly-shipped this session (the WORK):
- [backend/scripts/probe/room3-geography-count/](../../backend/scripts/probe/room3-geography-count/) — Phase 4 Room 3
- [backend/scripts/probe/room4-navigation/](../../backend/scripts/probe/room4-navigation/) — Phase 5 Room 4
- [backend/scripts/pre-bootstrap.ts](../../backend/scripts/pre-bootstrap.ts) — Phase 6 orchestrator (83 lines)
- [backend/scripts/probe/__test__/](../../backend/scripts/probe/__test__/) — dry-run smoke + fleet harnesses
- [docs/pre-bootstrap-output/canadafirstammo.ca-report.md](../pre-bootstrap-output/canadafirstammo.ca-report.md) — sample output verifying orchestrator works

---

## Branch State

**Branch:** `main`, **84 commits ahead of origin** (NOT pushed). Working tree clean.

To push when ready: `git push origin main`. Or review with: `git log --oneline origin/main..HEAD`.

---

## FULL CONTENT of `project_next_session.md` (the kickoff manifest)

This is what Claude will see at the start of next session:

````markdown
---
name: next-session-state
description: Session end 2026-04-26 — Phases 3, 4, 5, 6 of pre-bootstrap rebuild COMPLETE. Phase 7 (Room 5 bootstrap utility) is next.
type: project
---

# Pre-Bootstrap Rebuild — Phases 3+4+5+6 COMPLETE, resume at Phase 7

## ⚠️ CRITICAL LESSONS FROM 2026-04-26 SESSION (READ FIRST)

These are session-end realizations the previous Claude wishes she had known at session start. Internalize before starting Phase 7:

### 1. Context discipline: file loading is the SMALLEST cost
A naive read of "files I loaded at session start" added up to ~147K tokens (~30% of 500K used). But TOTAL session consumed ~382K — the gap (~150K) came from:
- Subagent dispatch prompts I wrote myself (3-5K each × 10 dispatches = 40K). Could have been 1-2K each — saving ~20K.
- Re-reading files after small edits to verify surroundings (~15K). The Edit tool's diff already shows surroundings; trust it.
- Displaying full smoke JSON outputs in my reply text (~15K). Summarize counts/methods only.
- Verbose commit messages 30-50 lines (~10K). Useful for git log but consumes immediate context — keep terse.
- Reading the full 5832-line audit history when only ~10 site sections needed (~30K wasted). Now solved by `34-site-audit-INDEX.md` (193 lines).

**Rule for next session: assume OPERATIONAL overhead is 1.5-2× file-loading cost. Budget aggressively.**

### 2. The verbatim plan code HAS BUGS — review every implementer output
Phase 4 + Phase 5 code reviews caught 9 real bugs in code lifted verbatim from the plan:
- Bail-counter conflated 404 with WAF challenge (sitemap-parse)
- SITEMAP_CANDIDATES missing BC `/xmlsitemap.php` index path
- Over-broad `/\.html$/i` positive pattern (matches Magento category pages)
- Missing BC Stencil bare-slug pattern (47K products would be missed)
- Playwright fallback strips response headers, breaks API count probes (global-count)
- Missing Ecwid POST timeout (could hang forever)
- Hardcoded `/product-category/{slug}/` ignores WC API's `link` field
- Homepage `/` and `/#` survive isLikelyNavUrl (10+ Tier-2 sites affected)
- Missing `offset` in pagination-detect candidate patterns

Plan code is a STARTING POINT, not gospel. NEVER skip code review.

### 3. Mission framing: defining NEW sites generically (not matching existing)
When existing infra fails on a new platform, BUILD generic infrastructure. This session built 3:
- `extract.ts` platform-aware dispatch (drupal-commerce → GunpostAdapter)
- `catalog-urls.ts` Drupal Views form-discovery + path-probe
- `global-count.ts` Celerant `/perpage/9999` + `catalog-urls.ts` Wix /shop-only

When facing a new platform, ask: "Can I build for ANY future site of this kind?" not "How do I make THIS site work?"

### 4. Searchable indexes in `memory/` are MY responsibility
Never use "if you add..." wording that delegates to user. See `feedback_index_maintenance.md`.

### 5. Plan code's "verbatim" tasks vs "algorithm-spec" tasks
- Verbatim (Phases 4, 6): plan provides full code → implementer + code review only
- Algorithm-spec (Phases 5, 7): plan provides algorithm → implementer + spec compliance review + code review (TWO review passes)

Phase 7 is algorithm-spec.

---

## Status as of 2026-04-26 session end

**Branch:** main, **84+ commits ahead of origin** (NOT pushed). Working tree clean.

### Built across this session

**Phase 4 — Room 3 (Geography & Count) — 12 commits**
- `backend/scripts/probe/room3-geography-count/sitemap-parse.ts` — sitemap discovery + product-URL classification + md5 dedup
- `backend/scripts/probe/room3-geography-count/global-count.ts` — 7-priority API/sitemap dispatch
- `backend/scripts/probe/room3-geography-count/catalog-urls.ts` — taxonomy API + nav + empirical filter
- `backend/scripts/probe/room3-geography-count/walk-verify.ts` — paginated walk + dedupe
- `backend/scripts/probe/room3-geography-count/index.ts` — composer with soft-warn drift gate

**Phase 4 BONUS — Generic infrastructure (3 commits)**
- Drupal-classifieds: `extract.ts` platform dispatch + `catalog-urls.ts` Drupal Views form/path-probe (gunpost discovers `/ads?sort_by=created&sort_order=DESC` generically)
- Celerant `/perpage/9999`: `global-count.ts` priority 8 (bullseyenorth count: 7 false-positive → 3,285 real)
- Wix /shop-only: `catalog-urls.ts` Wix branch (Mistake 27 sub-cat leak avoided generically)

**Phase 5 — Room 4 (Navigation) — 5 commits**
- `backend/scripts/probe/room4-navigation/pagination-detect.ts` — 4-pattern test + 4-test verification (A/B/C/D)
- `backend/scripts/probe/room4-navigation/sort-detect.ts` — `<select>` HTML + 3-outcome counter-control
- `backend/scripts/probe/room4-navigation/watermark-method.ts` — Method A/B/C selection per spec §6.3
- `backend/scripts/probe/room4-navigation/index.ts` — composer

**Phase 6 — Orchestrator + Dry-Run Harnesses — 2 commits**
- `backend/scripts/pre-bootstrap.ts` — 83 lines (under 150 spec limit), composes Rooms 1-4 → writes profile.json + report.md
- `backend/scripts/probe/__test__/dry-run-smoke.ts` — 5-site Tier-1
- `backend/scripts/probe/__test__/dry-run-fleet.ts` — 29-site Tier-2
- `docs/pre-bootstrap-output/.gitkeep`

**Live-verified**: canadafirstammo end-to-end through orchestrator → clean profile.json + report.md.

---

## NEXT: Phase 7 — Room 5 Bootstrap Utility

Per plan Tasks 7.1-7.7:

### Task 7.1 — `room5-bootstrap/` modules
- `strategy-dispatch.ts` — pick api-walk vs html-walk vs hybrid per platform
- `detail-enrich.ts` — fill missing price/date from detail pages (concurrency ≤3, batch by catalogUrl, reuse token-budget)
- `index-products.ts` — productClassifier + ProductIndex upsert + watermark seed
- `index.ts` — Room 5 composer

### Task 7.2 — `backend/scripts/bootstrap.ts` entry script (≤200 lines per spec §11.2)
- Loads `<domain>-profile.json` from disk
- Runs Room 5 → writes DB
- The first room that ACTUALLY WRITES TO DB (creates MonitoredSite, upserts ProductIndex, seeds watermark, sets isEnabled=true)

### Tasks 7.3-7.7 — Bootstrap each Tier-1 site
- canadafirstammo, aagcanada, theammosource, bullseyenorth, gunpost
- Per site: run `pre-bootstrap.ts <url>` → review report → run `bootstrap.ts <domain>` → verify DB

After Phase 7: Phase 8 (Tier-2 fleet 29-site regression — milestone gate), Phase 9 (SKILL.md update + cleanup).

---

## MANDATORY READING (read these BEFORE any code work)

In order:
1. **This file** — current state + Phase 7 entry point
2. `MEMORY.md` — index of other memory files
3. spec `2026-04-24-pre-bootstrap-rebuild-design.md` — §4.5 Room 5, §6.4, §5.4, §11.2 (≤200 lines)
4. plan `2026-04-25-pre-bootstrap-rebuild.md` — Tasks 7.1-7.7 (algorithm summaries, NOT verbatim)
5. playbook `catalog-url-discovery-playbook.md` — Mistakes 9, 10, 12, 14, 32, 38
6. **`memory/34-site-audit-INDEX.md`** — searchable cliff-notes (saves ~45K tokens vs full file)
7. `.claude/agents/crawler-specialist.md` — Mistakes 30-39
8. `.claude/probe-rewrite-lessons.md` — anti-patterns

## SKILLS TO INVOKE EVERY TURN
- `using-superpowers` — call the Skill tool, do not just narrate

## WORKFLOW (subagent-driven-development pattern)
1. Invoke `using-superpowers` skill
2. Read task from plan
3. Dispatch implementer subagent with FULL context
4. Verify commit + working tree before review
5. Dispatch code-reviewer subagent
6. Apply fix-commits for ANY Important issues caught (commit per logical fix)
7. Mark task complete in TodoWrite

For algorithm-spec tasks (Phases 5, 7): ALSO dispatch spec compliance reviewer between implementer and code reviewer.

## DISCIPLINE RULES (12)
1. Audit memory is point-in-time. ALWAYS verify live before trusting stored markers. Theme name ≠ platform name (Mistake 39).
2. Smoke against ALL fleet sites for a detector, not just 1.
3. Live-investigate before writing detector code. `curl -sI` + grep for markers.
4. Anti-ban discipline. 2-3s delay between fleet site fetches.
5. tsc --noEmit clean after EVERY code change.
6. Code review catches real bugs. Phase 4+5 reviews caught 9 bugs. NEVER skip.
7. Cherry-pick discipline. Snapshots are reference, not copy-paste source.
8. Composite detector pattern. Multi-marker-family detectors MUST gate on BOTH families.
9. Never edit `_remaining-issues.md` without explicit per-edit permission.
10. Don't commit unless explicitly asked. Subagents inherit session-level auth but commit as part of atomic task.
11. Use audit INDEX (memory/34-site-audit-INDEX.md), not the full source file.
12. Define NEW sites generically. Build infrastructure, don't add site-specific code.

## ARCHITECTURAL STATE
```
✓ Phase 0: revert + cleanup
✓ Phase 1: shared/ (6 modules + tests)
✓ Phase 2: Room 1 (intake)
✓ Phase 3: Room 2 (access + identity, 18 detectors, composer)
✓ Phase 4: Room 3 (geography + count, 4 sub-tasks) + 3 bonus generic infrastructures
✓ Phase 5: Room 4 (navigation, 3 sub-tasks)
✓ Phase 6: orchestrator + dry-run harnesses
→ Phase 7: Room 5 (bootstrap utility) + Tier-1 site bootstraps ← NEXT
  Phase 8: Tier-2 fleet regression (29 sites milestone gate)
  Phase 9: SKILL.md update + cleanup
```

## OPEN ISSUES (deferred — user-acknowledged triage)

| Phase | Issue | Severity | Proposed fix |
|---|---|---|---|
| 4 | Klevu API count not generic | MINOR | Add Klevu branch to global-count.ts |
| 4 | Wix sites emit `generic-product-sitemap` instead of `wix-store-products-sitemap` | COSMETIC | Add label-only Wix branch |
| 5 | sort-detect / watermark-method only checks priorities 2 + 5 | IMPORTANT | Add priority 3 (detail-page) + 4 (sitemap lastmod) per spec §6.2 |
| 5 | Searchspring + Ecwid sort returns null — blocks Method B | MINOR | Platform-specific verifications |
| 6 | Full smoke not run end-to-end (~30 min) | DEFERRED | Run as Phase 8 gate |

## TOOL QUIRKS
- Bash cwd persists between calls. Always `cd /d/VScode/Projects/firearm-alert &&` before commits.
- `.git-commit-msg-tmp` pattern: write the message via Write tool, then `git commit -F .git-commit-msg-tmp && rm` in the SAME bash call.
- Skill tool: bare skill name (NOT `superpowers:brainstorming`).
- Vitest installed; use `npx vitest run path/to/test.test.ts`.
- Smoke test files: write `.ts` (not `.mts`) — project is CJS.
- Long fetches (Playwright on CF sites): use `run_in_background: true` + `Monitor` with grep filter.
- Production code in `backend/src/` is OUT OF SCOPE per spec §1.2 except cookie capture (commit `aaac44a`) and waf-cookie-manager wait fix (Mistake 30) — those STAY.

## ESTIMATED PHASE 7 BUDGET
Largest remaining phase. Room 5 has design freedom (algorithm-spec). Plus 5 Tier-1 site bootstraps (each writes to DB). Estimate ~12-15% of context window.
````

---

## How to verify next session has this

1. Start a fresh Claude Code session in this project
2. Within the first 1-2 messages, Claude should reference "Phase 7" and "Room 5 bootstrap utility" as the next task
3. Claude should NOT re-read the full 5832-line audit history (the index makes that unnecessary)
4. Claude should mention the 5 critical lessons (context discipline, plan code has bugs, generic infrastructure, index maintenance, verbatim vs algorithm-spec)

If next session's Claude doesn't reference these, the auto-load failed — point them at this file.
