---
name: project-agent-team
description: Agent team configuration for firearm-alert project — roles, how to spawn, and when to use each
type: project
---

Agent teams are enabled (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in global settings.json).
**Why:** User wants parallel specialist work on complex tasks — crawler fixes, UI improvements, deployment simultaneously.
**How to apply:** When a task involves multiple domains, spawn relevant agents as teammates. Teams are ephemeral (die with session) but agent personas persist in `.claude/agents/`.

## Project Agent Roster (in `.claude/agents/`)

| Agent | Role | When to use |
|-------|------|-------------|
| `backend-engineer` | Express/Prisma/BullMQ infrastructure | API routes, DB schema, job queue logic |
| `frontend-engineer` | Next.js 14 dashboard UI | Site monitor, alerts UI, admin pages |
| `crawler-specialist` | Adapter dev, scraping, stream/tier logic | New adapters, broken scrapers, catalog/watermark crawling |
| `sre-reliability` | Uptime, job health, self-healing | Stuck tiers, stalled jobs, monitoring, diagnostics |
| `devops-engineer` | Deployment, infra, reliability | Vercel/Railway setup, env config, CI/CD |
| `code-reviewer` | Correctness, security, regressions | Before merging, after big changes |

## Using Superpowers
The `using-superpowers` skill is active — check for relevant skills/agents before every response. Defined in CLAUDE.md.
