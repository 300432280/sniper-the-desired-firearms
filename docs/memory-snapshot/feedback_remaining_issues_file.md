---
name: remaining-issues-file-owned-by-user
description: Do not edit `backend/scripts/pre-bootstrap-output/_remaining-issues.md` without explicit permission for that specific edit.
type: feedback
originSessionId: 0e25b91d-3faf-45c8-a84d-fc6dca43f333
---
## Rule

Never edit `backend/scripts/pre-bootstrap-output/_remaining-issues.md` without explicit user permission for that specific edit.

**Why:** 2026-04-24 — user caught me editing `_remaining-issues.md` to "add context" during a probe investigation without asking. User rule: "don't ever edit remaining issue again without my permission."

**How to apply:**
- The file documents known limits (e.g., dlaskarms.com MalCare origin-level block) + deferred items. It's user-owned for tracking.
- When a probe fix resolves an item in the file, say so in the response — do NOT auto-remove the entry. Ask user: "I've fixed X; permission to remove it from `_remaining-issues.md`?"
- If the user tells me to remove a specific item, that's authorization for that specific edit. Not for adding other items.
- If I discover a new remaining issue, report it in the response. Ask permission before appending.
- Agent subprocesses also must not edit this file without explicit user permission — when dispatching agents, include this rule.

The file lives at: `d:\VScode\Projects\firearm-alert\backend\scripts\pre-bootstrap-output\_remaining-issues.md`.
