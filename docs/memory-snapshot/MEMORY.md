# Memory Index — firearm-alert

Canadian firearms retail monitoring app. Backend (Node/Express/Prisma/PostgreSQL), Frontend (Next.js).

> Global working principles, user profile, and collaboration style live in `~/.claude/CLAUDE.md` (auto-loaded every session).

## Current work
- **PIVOT (2026-04-27): generic onboarding ABANDONED. New plan: `docs/superpowers/plans/2026-04-27-pivot-to-ai-audit.md` — AI-driven per-site audit + 5-stage review + watchdog. READ THIS FIRST. Read [Agent Harness Pattern](feedback_agent_harness_pattern.md) + most recent file in `docs/session-handoffs/` BEFORE any work.**
- [Next Session State](project_next_session.md) — superseded by the Pivot plan; will be cleaned up during Task 6 of the pivot plan
- **[34-Site Audit INDEX](34-site-audit-INDEX.md) — READ THIS FIRST for any audit query.** Searchable cliff-notes with line ranges into the source file (~5K tokens vs ~50K full read). Per-site lookup table + by-platform / by-WAF / by-Mistake cross-refs.
- [34-Site Audit History — SOURCE](34-site-audit-history.md) — full investigation notes (5832 lines). Read SPECIFIC line ranges via the INDEX above; do NOT load whole file.
- [34-Site Audit Progress](34-site-audit-progress.md) — Batch A+B tracker (34/34 + 23/23 complete)

## Project reference
- [Architecture Notes](architecture.md) — key files, patterns, and gotchas
- [Agent Team Setup](project_agent_team.md) — agent roster, how to spawn teams

## Project-specific feedback (lessons from user corrections)
- [Agent Discipline](feedback_agent_discipline.md) — always use superpower + proper agent, never take task over from stalled agent
- [Stale Cleanup Mistake](feedback_stale_cleanup.md) — never deactivate products based on lastSeenAt alone
- [Verify Before Proposing](feedback_verify_before_propose.md) — investigate actual behavior before suggesting solutions
- [Audit Phase Discipline](feedback_audit_phase_discipline.md) — report phases separately, live-verify per catalogUrl
- [Full Product Coverage](feedback_full_coverage.md) — catalogUrls must cover 100% of products, NEVER drop categories for being "too small"
- [Remaining-Issues File Ownership](feedback_remaining_issues_file.md) — never edit `_remaining-issues.md` without explicit per-edit permission
- [Index Maintenance Is My Job](feedback_index_maintenance.md) — searchable indexes in memory/ are mine to keep current; never push maintenance to the user via "if you add..." wording
- [Per-Room Ground-Truth Validation](feedback_per_room_ground_truth.md) — every Room must be diffed against validated DB siteProfile WHEN completed; tsc-clean is not enough; siteProfile is the answer key
- [catalogUrls Full Coverage Design Rule](feedback_catalog_urls_full_coverage.md) — catalogUrls must cover 100% of products with min overlap; multi-source discovery (API + nav + leaf-cat + view-all); they ARE the T1 crawl path, not just HTML fallback
- [Agent Harness Pattern (3 roles)](feedback_agent_harness_pattern.md) — **MANDATORY** for ALL non-trivial work on this project. Orchestrator + Implementer + 2 Reviewers per task. Lone-Claude implementation forbidden by user (2026-04-27).

## Completed in 2026-04-20 session (modular rebuild)
- Pre-bootstrap probe REBUILT as 9 modular scripts + thin orchestrator (see `project_next_session.md`)
- Old `pre-bootstrap-probe.ts` monolith DELETED (-2,751 lines)
- SKILL.md rewritten as judgment layer over evidence blob
- Every module passed 5-platform-family regression before commit
- Real abstraction gaps fixed (XML entity decoding, status nullification, OLDEST_REGEX filter, etc.)
- **Branch: 27 commits ahead of origin/main, NOT pushed**

## Completed in 2026-04-12 session 2
- API→HTML Fallback Gap FIXED — consecutive-empty counter in catalog-crawler.ts
- Rate limiter FIXED — Redis-backed with passOnStoreError
- CORS FIXED — env var CORS_ORIGIN with multi-origin support
- WooCommerce Store-API-only FIXED — standalone path for 401-gated WP REST (tacord.com)
- TownPost adapter FIXED — marketplace selector + numeric ID extraction
- LightSpeed selector FIXED — .product-element added
- MalCare detection FIXED — domain cooldown in http-client.ts

## Deferred issues
- [MalCare Rate Limit](project_malcare_rate_limit.md) — detection implemented, monitor in production
- [Deferred Infrastructure](project_deferred_infrastructure.md) — Dockerfile, Railway, Vercel, pino logging, Sentry, Discord alerts, health check

## Plans and reference
- [Pre-Bootstrap Plan](project_pre_bootstrap_plan.md) — OBSOLETE (replaced by modular architecture)
- [Release Plan](project_release_plan.md) — Phase 0 DONE → Phase 1 deployment next → Phase 2 DONE (modular) → Phase 3 mostly done → Phase 4 optimization
- [Future Tasks](project_future_tasks.md) — BC GraphQL status, CGN profile update pending

## Design principle
Decouple domain-specific logic (firearms priorities, category filters) from general-purpose infrastructure (tier engine, token budget, stream rotation) for cross-industry reusability.

**Modular probe principle**: each module does ONE job generically. No site-specific branches. When a site fails, fix the abstraction, not add a special case. 5 platform families must pass before commit.

## Key references (NOT memory files — read on demand)
- `.claude/catalog-url-discovery-playbook.md` — 7-phase audit process + 38 mistake patterns
- `.claude/agents/crawler-specialist.md` — crawler specialist persona (39 lessons; Mistake 39 = theme≠platform added 2026-04-26)
- `.claude/probe-rewrite-lessons.md` — distilled anti-patterns from prior failed session
- `docs/superpowers/specs/2026-04-24-pre-bootstrap-rebuild-design.md` — current rebuild spec
- `docs/superpowers/plans/2026-04-25-pre-bootstrap-rebuild.md` — current rebuild plan with verbatim per-task code
- `backend/scripts/probe/` — NEW location for the rebuilt pre-bootstrap pipeline (replaces deleted backend/scripts/probe-modules/)
- `backend/scripts/probe/shared/` — fetch, ua, redis-cookies, url-utils, extract, types
- `backend/scripts/probe/room1-intake/` — URL validation + canonicalization
- `backend/scripts/probe/room2-access-identity/` — canonical-host, waf-heavy-probe, waf-detect, platform-detect, 18 detectors, composer
- `CLAUDE.md` — project-level rules
