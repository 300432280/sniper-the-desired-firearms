# FirearmAlert — Machine Bootstrap Guide

Set up a new development machine from scratch. Everything needed to get Claude Code working with the full agent team, skills, and memory system.

## 1. Clone the repo

```bash
git clone https://github.com/300432280/sniper-the-desired-firearms.git firearm-alert
cd firearm-alert
```

This gives you:
- `CLAUDE.md` — project instructions (loaded every session)
- `.claude/agents/*.md` — 6 project-specific agent personas (crawler-specialist, sre-reliability, etc.)

## 2. Install dependencies

```bash
cd backend && npm install && cd ../frontend && npm install && cd ..
```

## 3. Configure environment

```bash
cp backend/.env.example backend/.env
# Edit backend/.env with: DATABASE_URL, REDIS_URL, JWT_SECRET, RESEND_API_KEY
```

## 4. Sync database

```bash
cd backend && npx prisma db push && npx prisma generate
```

## 5. Install Claude Code skills

```bash
npx skills add https://github.com/obra/superpowers --skill using-superpowers -g -y
```

This installs:
- `using-superpowers` skill — auto-checks for relevant agents before every response
- 100+ general-purpose agent personas in `~/.claude/agents/agency-agents/`

## 6. Configure Claude Code settings

Create `~/.claude/settings.json`:
```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  },
  "teammateMode": "in-process"
}
```

## 7. Restore memory (optional)

Memory files are machine-local at `~/.claude/projects/<sanitized-cwd>/memory/`. They're NOT in git because they contain session-specific state.

If transferring from another machine, copy:
```
~/.claude/projects/d--VScode-Projects/memory/ → same path on new machine
```

Or start fresh — Claude will rebuild memory from CLAUDE.md and the codebase.

## 8. Verify setup

```bash
cd backend && npm run dev          # Backend on :4000
cd frontend && npm run dev         # Frontend on :3000
node scripts/investigate-site.js bullseyenorth.com --db-only  # Test investigation script
```

## What lives where

| Item | Location | In git? | Syncs across machines? |
|------|----------|---------|----------------------|
| Project instructions | `CLAUDE.md` | Yes | Via git |
| Agent personas | `.claude/agents/*.md` | Yes | Via git |
| Bootstrap guide | `BOOTSTRAP.md` | Yes | Via git |
| Skills | `~/.claude/skills/` | No | Re-install with npx |
| Global agents | `~/.claude/agents/agency-agents/` | No | Comes with superpowers skill |
| Memory files | `~/.claude/projects/*/memory/` | No | Copy manually or start fresh |
| Settings | `~/.claude/settings.json` | No | Create manually (step 6) |
| Verify/investigate scripts | `backend/scripts/` | Yes | Via git |
