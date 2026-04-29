---
name: agent-harness-pattern-3-roles
description: Mandatory 3-role agent harness for ALL non-trivial multi-step work on firearm-alert. Lone-Claude implementation is forbidden. Orchestrator dispatches Implementer + 2 Reviewers per task.
type: feedback
originSessionId: 2026-04-27-pivot-overseer-session
---
# 3-role agent harness — mandatory for firearm-alert project

**Rule:** When starting any non-trivial multi-step task in the firearm-alert project, the orchestrator (top-level Claude in the session) MUST follow the 3-role agent harness. Lone-Claude implementation is forbidden by user mandate (2026-04-27).

## The 3 roles

1. **Orchestrator** — top-level Claude in the session. Reads MEMORY.md + active plan + most recent session handoff at session start. Dispatches subagents for every task. Never implements directly. Writes the new session handoff at end of session.
2. **Implementer** — one per task. Always one of `crawler-specialist`, `backend-engineer`, `frontend-engineer`, or `devops-engineer` — chosen by domain. ALWAYS loaded with the matching `.claude/agents/<role>.md` persona file content (mandatory per CLAUDE.md). Receives the full task text + acceptance criteria. Returns code diff + verification output.
3. **Reviewer** — two per task per stage:
   - Stage 1: `code-reviewer` agent (loaded with `.claude/agents/code-reviewer.md`) — code quality, regressions, correctness
   - Stage 2: `general-purpose` agent — spec compliance against the plan + acceptance criteria

## Session lifecycle

**At session start (mandatory reading order):**
1. `C:/Users/TNT/.claude/projects/d--VScode-Projects-firearm-alert/memory/MEMORY.md`
2. This file (`feedback_agent_harness_pattern.md`)
3. The active plan (currently `docs/superpowers/plans/2026-04-27-pivot-to-ai-audit.md`)
4. The most recent file in `docs/session-handoffs/`
5. `d:/VScode/Projects/firearm-alert/CLAUDE.md`
6. The relevant persona file in `.claude/agents/` for the domain being worked

**Per task dispatch sequence:**
1. Orchestrator reads next unchecked task in the plan
2. Spawn Implementer (with persona content + task text + acceptance criteria)
3. Spawn `code-reviewer` (Stage 1 review)
4. Spawn `general-purpose` agent (Stage 2 spec-compliance review)
5. If both reviewers PASS → orchestrator checks the task box in the plan
6. If either FAILS → orchestrator re-dispatches Implementer with review notes
7. Repeat for next task

**At session end (mandatory):**
1. Update plan checkboxes for completed tasks
2. Write new handoff at `docs/session-handoffs/YYYY-MM-DD-end-of-session.md` (use `docs/session-handoffs/HANDOFF-TEMPLATE.md`)
3. Update `project_next_session.md` in memory with current state pointer
4. Memory hygiene per CLAUDE.md (delete completed tasks from `project_next_session.md`)

**Compaction safeguard:**
Before any `/compact` operation, the orchestrator MUST do all 3 end-of-session steps above first. The handoff is the cache that survives compaction.

## Why

User mandated this pattern on 2026-04-27 after observing across multiple prior sessions:
- Lone-Claude direct implementation accumulated bugs that proper review would have caught
- Skipped persona files = subagents repeat documented mistakes (already covered in CLAUDE.md "Always load persona files into subagents" rule, but not previously enforced systematically)
- Per-room ground-truth validation was deferred and bugs accumulated across rooms (see `feedback_per_room_ground_truth.md`)
- The Pivot-to-AI-audit plan (Task 6 retrospective) traced 4 rounds of failed generic onboarding work to insufficient agent harness discipline

This is THE workflow for any non-trivial work on this project. No exceptions.

## How to apply (decision rule)

| Task scope | Pattern |
|---|---|
| Single line edit, typo fix, dependency bump | Orchestrator may do directly |
| Adding a single file < 50 lines with no review-worthy logic | Orchestrator may do directly |
| Anything in the Pivot plan | MANDATORY 3-role harness |
| Anything touching scraper adapters, crawlers, watermark logic, profile validation | MANDATORY 3-role harness |
| Anything touching DB schema | MANDATORY 3-role harness + user authorization before write |
| Refactor / rename across files | MANDATORY 3-role harness |

## Anti-patterns

- Orchestrator implementing tasks directly to "save time" — this is what the harness was created to prevent
- Skipping the persona file load — subagent repeats documented mistakes
- Skipping Stage 2 reviewer because "code-reviewer already approved" — they cover different concerns
- Re-dispatching the same Implementer subagent across multiple tasks (each task gets a fresh dispatch with focused context)
- Writing handoff "later" — write it BEFORE compact, or context is lost

## Affected files

- `docs/superpowers/plans/2026-04-27-pivot-to-ai-audit.md` — active plan; "How to Resume" section encodes this pattern
- `docs/session-handoffs/HANDOFF-TEMPLATE.md` — handoff format
- `.claude/agents/*.md` — persona files (must be loaded into subagent prompts)
- `CLAUDE.md` — global project rules (already mandates persona loading; this rule extends with full harness)
- All work on the firearm-alert project from 2026-04-27 onward
