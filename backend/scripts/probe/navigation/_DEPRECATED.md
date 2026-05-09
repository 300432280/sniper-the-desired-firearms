# DEPRECATED — Generic Sort Detection + Watermark Method Selection (Round 1-4)

**Status as of 2026-04-27:** these modules are kept as historical reference for the AI audit skill.

**Folder renamed from `room4-navigation` to `navigation` on 2026-05-05.**

**Files in this directory:**
- `sort-detect.ts`, `watermark-method.ts`, `index.ts`

**Why deprecated:** generic discovery code = per-platform code wearing a generic costume. Net value = 0. The pivot (2026-04-27) replaced this with AI-driven per-site audit. See `docs/superpowers/plans/2026-04-27-pivot-to-ai-audit.md`.

**Do NOT import from this folder in new code.** The pre-bootstrap skill at `.claude/skills/pre-bootstrap/SKILL.md` is the new entry point.

**Why not deleted:** the 18 platform detectors in `backend/scripts/probe/access-identity/detectors/` and the shared utilities under `backend/scripts/probe/shared/` are STILL USED. This DEPRECATED note is scoped to this folder only.
