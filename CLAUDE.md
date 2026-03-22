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
- `watermark-crawler.ts` — Tier 1: paginate from newest until hitting last-known product
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

## Skills & Agents
- Always follow the `using-superpowers` skill at conversation start.
- Check `~/.claude/agents/agency-agents/` for general-purpose agent personas.
- Project-specific agents in `.claude/agents/`:
  - `backend-engineer` — Node/Express/Prisma/BullMQ infrastructure
  - `frontend-engineer` — Next.js 14 dashboard and admin UI
  - `crawler-specialist` — adapter development, scraping, stream/tier logic
  - `sre-reliability` — crawler uptime, job health, self-healing, diagnostics
  - `devops-engineer` — deployment (Vercel/Railway), infra, reliability
  - `code-reviewer` — correctness, security, regression prevention
- Use project agents first; fall back to general agents for broader tasks.
- **MANDATORY: When spawning a subagent, ALWAYS read the matching `.claude/agents/*.md` persona file and include its content in the subagent prompt.** The persona files contain accumulated lessons from real mistakes. A subagent without its persona will repeat past mistakes. No exceptions.

### Persona File Management
- **Before adding a lesson:** Read the persona file first. Check for duplicates or contradictions.
- **Each lesson must include:** What happened, why it matters, and which code/file it relates to.
- **Before using a lesson:** Verify it still applies — check if the referenced code/function still exists. Code changes can make lessons obsolete.
- **Review trigger:** At the start of each session, if working on a domain that matches a persona (e.g. crawler work → crawler-specialist.md), read the persona file and verify its lessons against current code. Flag any that reference deleted functions, renamed files, or reversed decisions.
- **Rollback:** If the user says "remove the X lesson" or "that rule is wrong," delete it from the persona file immediately. Don't just add a contradicting lesson — remove the wrong one.
- **No time-based expiry.** A lesson is valid until the code it references changes or the user overrides it. Age alone is not a reason to remove.

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

### Installed Agent Personas (project-specific)
| Agent | File | Purpose | Created |
|-------|------|---------|---------|
| `backend-engineer` | `.claude/agents/backend-engineer.md` | Express/Prisma/BullMQ infrastructure | 2026-03-22 |
| `frontend-engineer` | `.claude/agents/frontend-engineer.md` | Next.js 14 dashboard UI | 2026-03-22 |
| `crawler-specialist` | `.claude/agents/crawler-specialist.md` | Adapter dev, scraping, stream/tier logic | 2026-03-22 |
| `sre-reliability` | `.claude/agents/sre-reliability.md` | Crawler uptime, job health, self-healing | 2026-03-22 |
| `devops-engineer` | `.claude/agents/devops-engineer.md` | Deployment, infra, reliability | 2026-03-22 |
| `code-reviewer` | `.claude/agents/code-reviewer.md` | Correctness, security, regression prevention | 2026-03-22 |

### Global Agent Collection
| Collection | Location | Count | Source |
|------------|----------|-------|--------|
| `agency-agents` | `~/.claude/agents/agency-agents/` | 100+ | [github.com/obra/superpowers](https://github.com/obra/superpowers) |

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

## Gotchas
- On Windows: bash escapes `$disconnect` in inline node `-e` commands. Write `.js` script files instead.
- After changing `schema.prisma`, must kill running node processes before `prisma generate` (DLL lock on Windows).
- C: drive has limited disk space. Clear npm cache logs if builds fail with ENOSPC.
- `npx tsx` is available for running `.ts` scripts directly. Wrap in `async function main()` (no top-level await — project is CJS).
