# Session Handoff — YYYY-MM-DD

> Copy this template at the END of each session: `cp HANDOFF-TEMPLATE.md YYYY-MM-DD-end-of-session.md` (or use the date the session ENDS, not started).
>
> The next session's orchestrator reads the most recent handoff first (per the "How to Resume" section of `docs/superpowers/plans/2026-04-27-pivot-to-ai-audit.md`).

---

## Session metadata

| Field | Value |
|---|---|
| Session date | YYYY-MM-DD |
| Session ID (transcript file or commit pointer) | _e.g._ `0e25b91d-3faf-...` |
| Active plan file | `docs/superpowers/plans/2026-04-27-pivot-to-ai-audit.md` |
| Orchestrator agent | _e.g._ Claude (top-level) |
| Total subagent dispatches | _e.g._ 4 implementer + 8 reviewer = 12 |

---

## Tasks COMPLETED in this session

For each task: checkbox ticked + reference the file:line ranges added/modified.

- [ ] **Task N: <task name>** — files: `<path>:<line-range>`, `<path>:<line-range>`
  - Acceptance criteria verified: <yes/no/partial>
  - Reviewer 1 (code-reviewer): <PASS/FAIL>
  - Reviewer 2 (spec-compliance): <PASS/FAIL>

---

## Tasks IN-PROGRESS at session end

For each: which step number we left off on, what was done, what remains.

- **Task N: <task name>** — left off at Step N.M
  - Done: <bullet list>
  - Remaining: <bullet list>
  - Blocking question (if any): <text>

---

## Blocking questions awaiting USER

List anything the orchestrator could not autonomously decide and is queued for user response next session.

1. _e.g._ "Task 4 Step 4.4 — daily cron entry point not located by automated search. Suggested location: `backend/src/worker.ts`. Confirm?"
2. ...

---

## Exact NEXT-TASK pointer

Single line that the next session's orchestrator pastes into its first subagent dispatch.

> **NEXT:** Dispatch `<agent-role>` (loaded with `.claude/agents/<persona>.md`) for **Task N Step N.M-N.M** of `docs/superpowers/plans/2026-04-27-pivot-to-ai-audit.md`. Acceptance criteria reproduced verbatim in the dispatch.

---

## Files MODIFIED this session (uncommitted)

```
M  backend/scripts/verify-site-profile.ts          (Task 1, NEW)
M  backend/src/services/health-monitor.ts          (Task 4, EXTEND)
M  .claude/skills/pre-bootstrap/SKILL.md           (Task 2, MODIFY)
?? docs/site-audit/<domain>-<ts>.json              (Task 2 canary output)
?? docs/site-verification/<domain>-<ts>.json       (Task 1 verifier output)
```

(Use `git status` to populate; do NOT include large generated files like full evidence dumps unless they are load-bearing.)

---

## Commits MADE this session

> If the user authorized commits, list each here with hash + message. Otherwise: "None — user did not authorize commits."

| Commit | Message |
|---|---|
| _none_ | — |

---

## Memory rules ADDED or UPDATED this session

For each: file path + one-line change description.

- _e.g._ `feedback_<name>.md` — created; documents <rule>
- _e.g._ `MEMORY.md` — added pointer to <file>

---

## Estimated CONTEXT BUDGET for next session

Rough estimate so the next orchestrator can plan compaction.

| Resource | Estimate |
|---|---|
| Required reading at start (memory + plan + handoff + persona) | ~25K tokens |
| Per-task subagent dispatch (with persona + task text) | ~10-15K tokens per dispatch |
| Reviewer dispatches (2 per task) | ~8-12K tokens each |
| Tasks remaining in plan | <count> |
| Recommended `/compact` cadence | After every 2-3 task completions OR when context > 60% |

---

## End-of-session checklist (orchestrator runs before stopping)

- [ ] Plan file checkboxes updated for completed tasks
- [ ] This handoff written and saved as `YYYY-MM-DD-end-of-session.md`
- [ ] `project_next_session.md` in memory updated with next-task pointer
- [ ] Memory hygiene done — completed tasks REMOVED from `project_next_session.md`
- [ ] Any persona-file lessons learned this session added to the appropriate `.claude/agents/<role>.md` (with what-happened + why-it-matters + which-code per CLAUDE.md persona-management rule)
- [ ] No commits made without explicit user authorization
- [ ] No `siteProfile` modifications made
- [ ] No site-specific code branches added
