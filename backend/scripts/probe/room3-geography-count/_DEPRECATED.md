# DEPRECATED — Generic Catalog/Sitemap/Count Discovery (Round 1-4)

**Status as of 2026-04-27:** these modules are kept as historical reference for the AI audit skill.

**Files in this directory:**
- `catalog-urls.ts`, `sitemap-products.ts`, `sitemap-parse.ts`, `select-catalog-set.ts`, `walk-verify.ts`, `global-count.ts`, `pagination-detect.ts`

**Why deprecated:** generic discovery code = per-platform code wearing a generic costume. Net value = 0. The pivot (2026-04-27) replaced this with AI-driven per-site audit. See `docs/superpowers/plans/2026-04-27-pivot-to-ai-audit.md`.

**Do NOT import from this folder in new code.** The pre-bootstrap skill at `.claude/skills/pre-bootstrap/SKILL.md` is the new entry point.

**Why not deleted:** the 18 platform detectors in `backend/scripts/probe/room2-access-identity/detectors/` and the shared utilities under `backend/scripts/probe/shared/` are STILL USED. This DEPRECATED note is scoped to this folder only.
