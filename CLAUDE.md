# FirearmAlert — Claude Instructions

## Rules
- Never make claims about code or data without reading/querying first
- Always read a file before modifying it
- When unsure, say so — do not guess or fabricate
- Do not commit unless explicitly asked

## Project Structure
Monorepo with two packages at root:
- `backend/` — Express + TypeScript + Prisma + BullMQ
- `frontend/` — Next.js 14 + React 18 + Tailwind CSS

## Commands

### Backend (port 4000)
```bash
cd backend && npm run dev          # ts-node-dev, auto-restarts
cd backend && npx tsc --noEmit     # type-check
cd backend && npx prisma db push   # sync schema to DB (NOT prisma migrate)
cd backend && npx prisma generate  # regenerate Prisma client after schema changes
cd backend && npx prisma studio    # DB GUI
```

### Frontend (port 3000)
```bash
cd frontend && npm run dev         # next dev on port 3000
cd frontend && npx tsc --noEmit    # type-check
```
Frontend proxies `/api/*` to backend via next.config.mjs rewrites.

### Known pre-existing TS errors
`frontend/src/app/dashboard/admin/debug/page.tsx` has 2 `Type 'unknown' is not assignable to type 'ReactNode'` errors. These are pre-existing and not caused by new changes.

## Database
- Neon PostgreSQL (connection string in `backend/.env`)
- Redis via Upstash (BullMQ job queues)
- Schema: `backend/prisma/schema.prisma`
- Uses `prisma db push`, NOT `prisma migrate`

## Architecture

### Backend Services (`backend/src/services/`)
- `crawl-scheduler.ts` — ticks every 2 min, queues crawl jobs
- `worker.ts` — BullMQ workers: `crawl-site`, `crawl-watermark`, `crawl-catalog`
- `watermark-crawler.ts` — Tier 1 new-items crawl. Walks **from the watermark toward newest**, indexing new products. Two methods: (A) `api-date-since-watermark` filters API by `dateAfter=watermark_date` order=asc and walks forward; (B) `navigate-from-watermark` paginates page 1 (newest) backward only to FIND the watermark, then walks BACK toward page 1 to INDEX new products (the find phase is locator-only; indexing direction is watermark→newest). (C) `full-catalog-sweep` when no sort works.
- `catalog-crawler.ts` — Tiers 2-4: full catalog refresh on cooldown cycles
- `scraper/index.ts` — keyword search scraper (has Playwright fallback for WAF)
- `scraper/playwright-fetcher.ts` — headless browser for WAF/SPA sites
- `token-budget.ts` — per-site hourly request budgets
- `priority-engine.ts` — pressure/capacity model

### Scraper Adapters (`backend/src/services/scraper/adapters/`)
Each adapter handles search + catalog extraction for a site type:
- `shopify.ts`, `woocommerce.ts` — retailer APIs + HTML
- `generic-retail.ts` — BigCommerce, Magento, other retail
- `auction-hibid.ts`, `auction-icollector.ts`, `auction-generic.ts`
- `classifieds-gunpost.ts`, `forum-xenforo.ts`, `forum-vbulletin.ts`
- `generic.ts` — ultimate fallback
- `base.ts` — abstract base class

### API Routes (`backend/src/routes/`)
- `auth.ts` — login/register/JWT
- `searches.ts` — user keyword alerts
- `admin.ts` — site management, dashboard, overrides, site-issues

### Frontend Pages (`frontend/src/app/`)
- `dashboard/` — main user dashboard
- `dashboard/admin/sites/` — site monitor (capacity, budget, intervals, issues panel)
- `dashboard/admin/debug/` — debug tools
- `dashboard/alerts/` — user alert management
- `dashboard/history/` — match history

## Skills, Agents, and Personas
- Always follow the `using-superpowers` skill at conversation start.
- **Agents** (the entities that do work) live outside this repo:
  - `~/.claude/agents/agency-agents-main/` — 200+ general-purpose agency agents
  - `~/.claude/plugins/cache/.../agents/` — plugin-shipped agents (e.g. `code-reviewer` from superpowers)
- **Personas** (project-specific context **injected into** an agent's spawn prompt — NOT standalone agents) live in `.claude/agents/`. Each filename matches the agency-agent it's auto-loaded for:
  - `engineering-backend-architect.md` — Express/Prisma/BullMQ + adapter framework + platform-specific extraction quirks
  - `engineering-frontend-developer.md` — Next.js 14 dashboard and admin UI
  - `engineering-security-engineer.md` — WAF bypass (Sucuri/Cloudflare/SiteGround), heavy probe, security research
  - `engineering-sre.md` — crawler uptime, job health, self-healing
  - `engineering-devops-automator.md` — deployment (Vercel/Railway), infrastructure
  - `engineering-code-reviewer.md` — correctness, security, regression prevention
  - `testing-api-tester.md` — SPA API discovery, live UI driving, pre-bootstrap probe development
  - `crawler-specialist.md` — TOC pointing to the 3 split personas above (use when you want "everything")
- **MANDATORY: When spawning an agent (any source) whose basename matches a persona file in `.claude/agents/`, ALWAYS read that persona file and include its content in the agent's spawn prompt.** The persona files contain accumulated lessons from real mistakes. An agent spawned without its matching persona will repeat past mistakes. No exceptions.

### Persona File Management
- **Before adding a lesson:** Read the persona file first. Check for duplicates or contradictions.
- **Each lesson must include:** What happened, why it matters, and which code/file it relates to.
- **Before using a lesson:** Verify it still applies — check if the referenced code/function still exists. Code changes can make lessons obsolete.
- **Review trigger:** At the start of each session, if working on a domain that matches a persona (e.g. crawler work → crawler-specialist.md), read the persona file and verify its lessons against current code. Flag any that reference deleted functions, renamed files, or reversed decisions.
- **Rollback:** If the user says "remove the X lesson" or "that rule is wrong," delete it from the persona file immediately. Don't just add a contradicting lesson — remove the wrong one.
- **No time-based expiry.** A lesson is valid until the code it references changes or the user overrides it. Age alone is not a reason to remove.

### Memory Hygiene (MANDATORY at session start)
- **Read `project_next_session.md` at the start of every session** (if it exists). Check each task listed:
  - If the task is already done (code exists, feature merged), **delete it from the file**.
  - If the task is partially done, **update it with current state**.
  - If the file is empty after cleanup, **delete the file and remove it from MEMORY.md**.
- **Never leave completed tasks in memory.** A stale "merge scripts in next session" entry will cause every future session to attempt a merge that was already done. This wastes time and causes confusion.
- **After completing work in a session,** update or remove any memory entries that are no longer accurate. Don't defer this — do it before the session ends.

## User Configuration Registry
<!-- This section tracks all user-decided configurations: installed skills, agents, custom rules, and settings.
     Managed by the user. Claude reads this section the same as any other, but the user can use it to
     audit, reset, rollback, or update their configuration choices. -->

### Installed Skills
| Skill | Location | Purpose | Installed |
|-------|----------|---------|-----------|
| `using-superpowers` | `~/.claude/skills/using-superpowers/` | Auto-check for relevant skills/agents before every response | 2026-03-22 |
| `find-skills` | `~/.claude/skills/find-skills/` | Search and install skills from the open ecosystem | pre-existing |
| `ui-ux-pro-max` | `~/.claude/skills/ui-ux-pro-max/` | UI/UX design intelligence: styles, palettes, fonts, a11y | pre-existing |

### Installed Personas (project-specific)
| Persona | File | Auto-loads for agency-agent | Purpose |
|---|---|---|---|
| `engineering-backend-architect` | `.claude/agents/engineering-backend-architect.md` | `engineering-backend-architect` | Express/Prisma/BullMQ + adapter framework + platform quirks |
| `engineering-frontend-developer` | `.claude/agents/engineering-frontend-developer.md` | `engineering-frontend-developer` | Next.js 14 dashboard UI |
| `engineering-security-engineer` | `.claude/agents/engineering-security-engineer.md` | `engineering-security-engineer` | WAF bypass / probe security |
| `engineering-sre` | `.claude/agents/engineering-sre.md` | `engineering-sre` | Crawler uptime, job health, self-healing |
| `engineering-devops-automator` | `.claude/agents/engineering-devops-automator.md` | `engineering-devops-automator` | Deployment, infra, reliability |
| `engineering-code-reviewer` | `.claude/agents/engineering-code-reviewer.md` | `engineering-code-reviewer` | Correctness, security, regression prevention |
| `testing-api-tester` | `.claude/agents/testing-api-tester.md` | `testing-api-tester` | SPA API discovery, live UI driving, probe development |
| `crawler-specialist` | `.claude/agents/crawler-specialist.md` | `crawler-specialist` (project) | Master TOC pointing to the 3 split personas |

### Global Agent Collection
| Collection | Location | Count | Source |
|------------|----------|-------|--------|
| `agency-agents-main` | `~/.claude/agents/agency-agents-main/` | 200+ | [github.com/obra/superpowers](https://github.com/obra/superpowers) |

### Global Settings
| Setting | Value | File |
|---------|-------|------|
| Agent teams enabled | `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` | `~/.claude/settings.json` |
| Teammate mode | `in-process` | `~/.claude/settings.json` |

### Custom Rules (user-decided)
| Rule | Reason | Added |
|------|--------|-------|
| Always load persona files into subagents | Subagents without personas repeat past mistakes | 2026-03-22 |
| Never deactivate products based on lastSeenAt alone | Crawlers may not have visited the page yet; 4,956 products wrongly deactivated | 2026-03-22 |
| Follow using-superpowers at conversation start | Ensures skills/agents are checked before every response | 2026-03-22 |
| All agent personas use Opus (not Sonnet) | Agents need full reasoning capability for complex site-specific investigations | 2026-03-22 |
| Verify persona lessons against current code before applying | Code changes can make lessons obsolete; age alone is not a reason to remove | 2026-03-22 |
| Run `/simplify` after every implementation session before committing | Dead scripts, unused imports, duplicated logic accumulate fast; simplify skill catches them | 2026-03-24 |
| Use professional agents for complex work | Software Architect for design, Code Reviewer for audit — don't do everything directly | 2026-03-24 |
| Stale detection only via cross-tier cycle completion | Never use time-based thresholds alone; all tiers must have completed a sweep before flagging products | 2026-03-24 |

## Past lessons — don't repeat

Real incidents from earlier work on this project. Cited so future sessions don't re-derive them.

- **API failures don't mean "impossible".** Multiple Store API failures turned out to be solvable via Playwright HTML. If a human can see it in their browser, Playwright can scrape it. Try HTML before declaring an API-only failure.
- **WAFs aren't always the cause.** Several "WAF blocked" claims were actually wrong URLs or skipping the existing `waf-cookie-manager` infrastructure. Test that path + Playwright cookies before claiming a WAF can't be bypassed.
- **Don't add site-specific workarounds without testing the generic adapter first.** Recurring incidents of bespoke code added when the generic approach already worked.
- **Weeks of "WAF limitation" claims** turned out to be wrong URLs. Verify the URL is correct before blaming the WAF.
- **WAF rate-limit delays exist for a reason.** The 800ms inter-request delay was added to prevent rate limiting. Don't remove it on a "speed" recommendation without first confirming rate limits are no longer a risk.
- **`worker.ts:549` silent loss-of-signal under `verifyMethod="store-api"`.** The L537-546 guard prevents wrongful deactivation (2026-04-03 incident fix), but L549's unconditional `handledProductIds.push` causes the caller at L711 to early-return — never reaching the Playwright fallback at L759-769. Result: OOS-transition products silently lose `stockStatus`/`lastSeenAt`/`price` updates → restock detection dies. Fix on branch `fix/batch-3-runtime-bugs-2026-05-19` moves the push inside the `if (apiProduct)` branch.
- **`wafType` is consumed by frontend admin UI, not just the crawler.** The crawler routes on `hasWaf` boolean only. `wafType` has zero non-presence-check reads in `backend/src/`, but `frontend/src/app/dashboard/admin/profiles/page.tsx` reads it at 5 places (sort key, column display, sticky-key, diff key, change-detection). Grep both directories before declaring a profile field "unused."
- **Keep the 4-round audit design (R1 blind → R2 live → R3 adversarial → R4 synth) with persona swap between R2 and R3.** R2 runs under `testing-api-tester` (build-mindset: confirm the live behavior, propose corrections). R3 runs under `engineering-code-reviewer` (break-mindset: broaden the sample, attack R2's assumptions, trace code paths end-to-end). Same-persona reruns miss bugs that a different mindset on the same evidence catches. Validated across batches 3 and 4 (2026-05-15 + 2026-05-19): batch-4 R3 reversed 7/7 R2 conclusions where R2's sample was too narrow (gotenda page-1-only, canadafirstammo wrong API surface, g4c single-moment UA matrix). The role-switch IS the value, not just the rerun — do not collapse R3 into another R2 pass.

## Gotchas
- On Windows: bash escapes `$disconnect` in inline node `-e` commands. Write `.js` script files instead.
- After changing `schema.prisma`, must kill running node processes before `prisma generate` (DLL lock on Windows).
- C: drive has limited disk space. Clear npm cache logs if builds fail with ENOSPC.
- `npx tsx` is available for running `.ts` scripts directly. Wrap in `async function main()` (no top-level await — project is CJS).
