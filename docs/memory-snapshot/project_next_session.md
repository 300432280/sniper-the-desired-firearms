---
name: next-session-state
description: Session end 2026-04-26 — Phases 3, 4, 5, 6 of pre-bootstrap rebuild COMPLETE. Phase 7 (Room 5 bootstrap utility) is next. Read EVERYTHING in the "Mandatory reading" section before any code work.
type: project
originSessionId: (current session)
---
# Pre-Bootstrap Rebuild — Phases 3+4+5+6 COMPLETE, resume at Phase 7

## ⚠️ CRITICAL LESSONS FROM 2026-04-26 SESSION (READ FIRST)

These are session-end realizations the previous Claude (me) wishes she had known at session start. Internalize before starting Phase 7:

### 1. Context discipline: file loading is the SMALLEST cost

A naive read of "files I loaded at session start" added up to ~147K tokens (~30% of 500K used). But the TOTAL session consumed ~382K — the gap (~150K) came from:
- **Subagent dispatch prompts I wrote myself** (3-5K each × 10 dispatches = 40K). Could have been 1-2K each with tighter pointers — saving ~20K.
- **Re-reading files after small edits to verify surroundings** (~15K). The Edit tool's diff confirmation already shows surroundings; trust it.
- **Displaying full smoke JSON outputs in my reply text** (~15K). Summarize counts/methods only; the JSON is in the output file if needed.
- **Verbose commit messages (30-50 lines)** with full Mistake context (~10K). Useful for git log but consumes immediate context — keep terse.
- **Reading the full 5832-line audit history** when I only needed ~10 site sections (~30K wasted). Now solved by `34-site-audit-INDEX.md` (193 lines).

**Rule for next session: assume the OPERATIONAL overhead will be 1.5-2× the file-loading cost. Budget aggressively.**

### 2. The verbatim plan code HAS BUGS — review every implementer output

Phase 4 + Phase 5 code reviews caught **9 real bugs** in code lifted verbatim from the plan:
- Bail-counter conflated 404 with WAF challenge (sitemap-parse)
- SITEMAP_CANDIDATES missing BC `/xmlsitemap.php` index path
- Over-broad `/\.html$/i` positive pattern (matches Magento category pages)
- Missing BC Stencil bare-slug pattern (47K products would be missed)
- Playwright fallback strips response headers, breaks API count probes (global-count)
- Missing Ecwid POST timeout (could hang forever)
- Hardcoded `/product-category/{slug}/` ignores WC API's `link` field
- Homepage `/` and `/#` survive isLikelyNavUrl (10+ Tier-2 sites affected)
- Missing `offset` in pagination-detect candidate patterns

The plan code is a STARTING POINT, not gospel. NEVER skip code review just because "the plan said so."

### 3. Mission framing: defining NEW sites generically (not matching existing)

Mid-session correction from user. When existing infrastructure can't handle a new platform (e.g., Drupal classifieds gunpost), the answer is **build generic infrastructure**, not "defer site to Phase 7 manual profile." This session built 3 generic infrastructures:
- `extract.ts` platform-aware dispatch (drupal-commerce → GunpostAdapter — selectors are platform-generic despite file name)
- `catalog-urls.ts` Drupal Views form-discovery + path-probe (`/ads`, `/listings`, `/products`, `/shop`, `/inventory`, `/catalog` × 4 sort fields)
- `global-count.ts` Celerant `/perpage/9999` priority + `catalog-urls.ts` Wix `/shop`-only branch

When facing a new platform in Phase 7+, ask: "Can I build this for ANY future site of this kind?" not "How do I make THIS site work?"

### 4. Searchable indexes in `memory/` are MY responsibility

User correction late this session. When I create a summary/index of a long memory file, I maintain it incrementally — never push that work onto the user via wording like "if you add new sites..." See `feedback_index_maintenance.md`.

### 5. Plan code's "verbatim" tasks vs "algorithm-spec" tasks

- **Verbatim** (Phases 4, 6): plan provides full code. Implementer writes it as-is, reviewer catches the plan's bugs.
- **Algorithm-spec** (Phases 5, 7): plan provides algorithm + key data structures. Implementer makes design choices. Higher review yield — they need spec compliance review IN ADDITION TO code review.

Phase 7 is algorithm-spec. Plan for both review passes.

---

## Status as of 2026-04-26 session end

**Branch:** main, **84+ commits ahead of origin** (NOT pushed). Working tree clean.

**Built across this session (Phases 4, 5, 6 + 3 bonus generic infrastructures):**

### Phase 4 — Room 3 (Geography & Count) — 12 commits
- `backend/scripts/probe/room3-geography-count/sitemap-parse.ts` — sitemap discovery + product-URL classification + md5 dedup
- `backend/scripts/probe/room3-geography-count/global-count.ts` — 7-priority API/sitemap dispatch
- `backend/scripts/probe/room3-geography-count/catalog-urls.ts` — taxonomy API + nav + empirical filter
- `backend/scripts/probe/room3-geography-count/walk-verify.ts` — paginated walk + dedupe
- `backend/scripts/probe/room3-geography-count/index.ts` — composer with soft-warn drift gate

### Phase 4 BONUS — Generic infrastructure (3 commits)
- **Drupal-classifieds**: `extract.ts` platform-aware dispatch (drupal-commerce → GunpostAdapter) + `catalog-urls.ts` Drupal Views form-discovery + path-probe (gunpost now discovers `/ads?sort_by=created&sort_order=DESC` generically)
- **Celerant `/perpage/9999`**: `global-count.ts` priority 8 (bullseyenorth count: 7 false-positive → 3,285 real)
- **Wix /shop-only**: `catalog-urls.ts` Wix branch (Mistake 27 sub-cat leak avoided generically)

### Phase 5 — Room 4 (Navigation) — 5 commits
- `backend/scripts/probe/room4-navigation/pagination-detect.ts` — 4-pattern test (query/path/offset-query/suffix-replace) + 4-test verification (A/B/C/D)
- `backend/scripts/probe/room4-navigation/sort-detect.ts` — read `<select>` HTML + 3-outcome counter-control (handles Volusion `?searching=Y`, Searchspring hash → null+evidence, Ecwid POST body → null+evidence)
- `backend/scripts/probe/room4-navigation/watermark-method.ts` — Method A/B/C selection per spec §6.3 (probes WC/Shopify date filters, falls back to listing-HTML date or sourceId monotonicity)
- `backend/scripts/probe/room4-navigation/index.ts` — composer

### Phase 6 — Orchestrator + Dry-Run Harnesses — 2 commits
- `backend/scripts/pre-bootstrap.ts` — 83 lines (well under 150 spec limit), composes Rooms 1-4 → writes `<domain>-profile.json` + `<domain>-report.md`
- `backend/scripts/probe/__test__/dry-run-smoke.ts` — 5-site Tier-1 regression
- `backend/scripts/probe/__test__/dry-run-fleet.ts` — 29-site Tier-2 fleet harness (per spec §8.1)
- `docs/pre-bootstrap-output/.gitkeep`

**Live-verified per Phase**: canadafirstammo end-to-end through orchestrator emits clean profile.json + report.md (`docs/pre-bootstrap-output/canadafirstammo.ca-{profile.json,report.md}`).

## NEXT: Phase 7 — Room 5 Bootstrap Utility

Per plan `docs/superpowers/plans/2026-04-25-pre-bootstrap-rebuild.md` Tasks 7.1-7.7:

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
3. `docs/superpowers/specs/2026-04-24-pre-bootstrap-rebuild-design.md` — spec, especially **§4.5 Room 5** (BootstrapState, Pass criteria, detail-page enrichment), **§6.4** (Room 5 detail-page enrichment policy), **§5.4** (DB creation deferred to Room 5), **§11.2** (Room 5 ≤200 lines)
4. `docs/superpowers/plans/2026-04-25-pre-bootstrap-rebuild.md` — Tasks 7.1-7.7 (Room 5 has algorithm summaries, NOT verbatim code — design freedom needed)
5. `.claude/catalog-url-discovery-playbook.md` — Mistakes 9 (catalogUrls are HTML fallback for API sites), 10 (Klevu key rotation self-heal), 12 (don't drop categories), 14 (paginationPattern templates), 32 (Shopify published_at), 38 (Sucuri/CF Playwright fallback for API-blocked WC)
6. **`memory/34-site-audit-INDEX.md`** — NEW THIS SESSION: searchable cliff-notes for the 5832-line audit history. Read this first; only Read specific line ranges of `34-site-audit-history.md` when investigating a particular site or pattern. Saves ~45K tokens.
7. `.claude/agents/crawler-specialist.md` — Mistakes 30 (sgcaptcha iPhone UA + waf-cookie-manager wait fix), 31 (Ecwid storefront API), 32 (Shopify published_at), 36 (Celerant HPE), 37 (Drupal classifieds), 38 (Sucuri/CF Playwright)
8. `.claude/probe-rewrite-lessons.md` — anti-patterns

## SKILLS TO INVOKE EVERY TURN

- `using-superpowers` — call the Skill tool, do not just narrate. The tool actually loads the discipline rules.

## WORKFLOW (subagent-driven-development pattern that worked through Phase 6)

For each substantive task:

1. Invoke `using-superpowers` skill (via Skill tool)
2. Read the task from the plan
3. **Dispatch implementer subagent** with FULL context:
   - Required reading list (specific spec section, playbook mistake numbers, persona references, audit-history INDEX entries)
   - Verbatim code block from plan (or clear pattern + reference for design-spec tasks)
   - Step-by-step instructions (write file, tsc check, smoke test, commit)
   - Acceptance criteria
   - Self-review prompts
   - Bash on Windows note (`.git-commit-msg-tmp` pattern)
4. Verify the commit + working tree before review
5. **Dispatch code-reviewer subagent** with:
   - What was implemented
   - Plan / spec references
   - BASE → HEAD SHAs
   - Specific concerns to scrutinize
6. Apply fix-commits for ANY Important issues caught (commit per logical fix)
7. Mark task complete in TodoWrite

For value=low tasks (cherry-picks from prior session), ALSO dispatch spec compliance reviewer between implementer and code reviewer. Verbatim-code tasks (Phases 4, 6) skip spec review — code review only. Algorithm-spec tasks (Phases 5, 7) need both.

## DISCIPLINE RULES (carried forward + updated this session)

1. **Audit memory is point-in-time.** Sites migrate platforms, change themes, update WAF configs. ALWAYS verify live before trusting any stored marker. Theme name ≠ platform name (Mistake 39).
2. **Smoke against ALL fleet sites for a detector**, not just 1. Single-site validation missed BC Stencil single-quote regex; 8-site smoke caught it.
3. **Live-investigate before writing detector code.** `curl -sI` + `curl -s | head -200` then grep for candidate markers. Don't write regex from memory.
4. **Anti-ban discipline.** 2-3s delay between fleet site fetches. Single GET per site. Standard browser UA. NEVER bot UAs for access.
5. **tsc --noEmit clean after EVERY code change.** No exceptions.
6. **Code review catches real bugs.** Phase 4 + Phase 5 reviews caught 7+ real bugs (bail-counter conflation, Playwright header strip on hasWaf, hardcoded WC permalink, missing offset pattern, OUTPUT_DIR cwd dependency, etc.). NEVER skip code review.
7. **Cherry-pick discipline.** Snapshots in `docs/superpowers/plans/cherry-pick-snapshots/` (gitignored) are reference, not copy-paste source.
8. **Composite detector pattern.** Multi-marker-family detectors MUST gate on BOTH families being present.
9. **Never edit `_remaining-issues.md`** without explicit per-edit permission.
10. **Don't commit unless explicitly asked.** Subagents inherit the session-level authorization but should commit as part of their atomic task.
11. **NEW**: Use the audit INDEX (memory/34-site-audit-INDEX.md) instead of loading the full audit history. Only Read specific line ranges from the source when needed.
12. **NEW (mission framing)**: We are defining NEW sites generically, NOT matching to existing ones. When existing infrastructure can't handle a new platform, BUILD generic infrastructure. Site-specific code violates the architecture.

## ARCHITECTURAL STATE (what's done, what's next)

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

## OPEN ISSUES (deferred — listed in user-acknowledged triage)

| Phase | Issue | Severity | Proposed fix |
|---|---|---|---|
| 4 | Klevu API count not generic — alflahertys-style sites fall through to sitemap | MINOR | Add Klevu branch to global-count.ts |
| 4 | Wix sites emit `generic-product-sitemap` label instead of spec's `wix-store-products-sitemap` | COSMETIC | Add label-only Wix branch |
| 5 | sort-detect / watermark-method only checks priorities 2 + 5 (listing HTML, sourceId) | IMPORTANT | Add priority 3 (detail-page) + priority 4 (sitemap lastmod) per spec §6.2 |
| 5 | Searchspring + Ecwid sort returns null — blocks Method B | MINOR | Platform-specific verifications |
| 6 | Full smoke not run end-to-end (~30 min) | DEFERRED | Run as Phase 8 gate |

## TOOL QUIRKS (carried forward)

- Bash cwd persists between calls. Always `cd /d/VScode/Projects/firearm-alert &&` before commits.
- `.git-commit-msg-tmp` pattern: write the message via Write tool, then `git commit -F .git-commit-msg-tmp && rm` in the SAME bash call.
- Skill tool: bare skill name (NOT `superpowers:brainstorming` style).
- Vitest installed; use `npx vitest run path/to/test.test.ts`.
- Smoke test files: write `.ts` (not `.mts`) — project is CJS.
- Long fetches (Playwright on CF sites): use `run_in_background: true` + `Monitor` with grep filter.
- Production code in `backend/src/` is OUT OF SCOPE per spec §1.2 except for cookie capture (commit `aaac44a`) and waf-cookie-manager wait fix (Mistake 30) — those STAY.

## ESTIMATED PHASE 7 BUDGET

Largest remaining phase. Room 5 has design freedom (algorithm spec, not verbatim code). Plus 5 Tier-1 site bootstraps (each writes to DB). Estimate ~12-15% of context window if dispatch-review-fix pattern continues.
