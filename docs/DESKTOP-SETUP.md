# Desktop Workspace Migration — Setup Guide

This guide bootstraps the FirearmAlert workspace on a fresh machine from the GitHub repo + this document. **Time estimate: 30-45 minutes.**

---

## Prerequisites on the new machine

- **Git** with auth to GitHub (SSH key OR HTTPS PAT) for `300432280/sniper-the-desired-firearms`
- **Node.js 20** + npm (LTS recommended)
- **Claude Code CLI** installed and signed in (matching your laptop's Claude account)
- **VS Code** (optional but assumed by team conventions)

---

## Step 1: Clone the repo

```bash
git clone https://github.com/300432280/sniper-the-desired-firearms.git
cd sniper-the-desired-firearms
git checkout main
git pull
```

Recommended path: place the repo at the SAME folder structure as the laptop (`d:\VScode\Projects\firearm-alert` or equivalent on the new machine). This makes path-based memory/agent restoration trivial. If you use a different path, see Step 5 for the workspace-key adjustment.

---

## Step 2: Install dependencies

```bash
cd backend && npm install
cd ../frontend && npm install
```

This re-creates `node_modules/` (gitignored, ~600 MB combined).

---

## Step 3: Recreate `.env` files

The actual secret values are NOT in git. Copy them from your laptop via password manager / encrypted note. Templates exist at `backend/.env.example` and `frontend/.env.local.example`.

### `backend/.env` — create from template + fill secrets

```bash
cp backend/.env.example backend/.env
# Then edit backend/.env to fill these values from your password manager:
```

| Variable | Source |
|---|---|
| `DATABASE_URL` | Neon Postgres connection string (matches laptop) |
| `REDIS_URL` | Upstash Redis connection string (matches laptop) |
| `JWT_SECRET` | Long random string (MUST MATCH laptop value, otherwise existing user sessions break) |
| `RESEND_API_KEY` | Resend email API key (`re_xxx...`) |
| `TWILIO_ACCOUNT_SID` | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Twilio auth token |
| `TWILIO_FROM_NUMBER` | Twilio outgoing number |

Non-secret config (use defaults from `.env.example`): `JWT_EXPIRY`, `BCRYPT_ROUNDS`, `PORT=4000`, `NODE_ENV=development`, `FRONTEND_URL=http://localhost:3000`, `FROM_EMAIL`.

### `frontend/.env.local` — only one variable, non-secret

```bash
cp frontend/.env.local.example frontend/.env.local
# Default value works: NEXT_PUBLIC_API_URL=http://localhost:4000
```

---

## Step 4: Generate Prisma client

```bash
cd backend
npx prisma generate
```

Do NOT run `prisma migrate` — schema is already deployed to Neon. `prisma generate` produces the local TypeScript types only.

Verify DB connectivity:
```bash
npx prisma studio
# Opens browser at http://localhost:5555 — close after confirming you can list tables
```

---

## Step 5: Restore Claude Code memory

The Claude Code memory directory lives OUTSIDE the repo on each machine. The repo includes a snapshot at `docs/memory-snapshot/` — copy it to the new machine's Claude path.

### Find the right destination path

Claude derives the project key from the workspace path. On Windows, the key looks like:
- Workspace `D:\VScode\Projects\firearm-alert` → key `d--VScode-Projects-firearm-alert`
- Workspace `C:\dev\firearm-alert` → key `c--dev-firearm-alert`

Memory dir path:
```
%USERPROFILE%\.claude\projects\<KEY>\memory\
```

### Copy

PowerShell:
```powershell
$key = "d--VScode-Projects-firearm-alert"   # adjust for your desktop path
$dst = "$env:USERPROFILE\.claude\projects\$key\memory"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item -Recurse -Force "docs\memory-snapshot\*" $dst
```

Git Bash / WSL:
```bash
KEY=d--VScode-Projects-firearm-alert
DST="$HOME/.claude/projects/$KEY/memory"
mkdir -p "$DST"
cp -r docs/memory-snapshot/* "$DST/"
```

### Verify

Open Claude Code in the workspace. The first message should show MEMORY.md auto-loaded. If you see "Pivot (2026-04-27): generic onboarding ABANDONED..." in the system reminders, restoration worked.

---

## Step 6: Restore global Claude Code agents + skills

These live in your home directory, NOT in the repo. The 6 project-specific agents at `.claude/agents/` are in the repo and load automatically. The 100+ global agency-agents and 16 global skills are NOT in the repo.

### Global agents (~100+)

Source: [github.com/obra/superpowers](https://github.com/obra/superpowers)

```bash
# Clone into ~/.claude/agents/agency-agents/ (the path the harness expects)
mkdir -p ~/.claude/agents
cd ~/.claude/agents
git clone https://github.com/obra/superpowers.git agency-agents
```

Or copy your laptop's directory directly via USB / network share:
- Source on laptop: `C:\Users\TNT\.claude\agents\agency-agents\`
- Destination on desktop: `%USERPROFILE%\.claude\agents\agency-agents\`

### Global skills (16 expected)

The Superpowers skills (using-superpowers, brainstorming, subagent-driven-development, etc.) install via the same Superpowers repo OR install Claude Code's official skills via:

```bash
# If a skill installer is part of your Claude Code distribution:
claude skill install using-superpowers
claude skill install find-skills
claude skill install ui-ux-pro-max
# Or simply copy the directory:
```

Or copy from laptop:
- Source: `C:\Users\TNT\.claude\skills\`
- Destination: `%USERPROFILE%\.claude\skills\`

### Verify skills

In a Claude Code session, run:
> /find-skills

If it lists at least 16 skills (using-superpowers, brainstorming, etc.), restoration worked.

---

## Step 7: Smoke test

```bash
# Backend
cd backend
npm run dev
# Should output: "Server listening on port 4000" + "[Redis] Connection ready"
```

In another terminal:
```bash
cd frontend
npm run dev
# Should output: "▲ Next.js 14.x" + "Local: http://localhost:3000"
```

Open http://localhost:3000 — login with your existing account (sessions persist via Neon DB).

---

## Step 8: Verify the watchdog can run

```bash
cd backend
npx tsx scripts/verify-site-profile.ts canadafirstammo.ca
```

Expected: 5 checks ALL PASS (canadafirstammo is the canonical ground-truth site). Output JSON written to `docs/site-verification/canadafirstammo.ca-<timestamp>.json`.

If this works, the audit + verification stack is fully functional on the new machine.

---

## Troubleshooting

### "Cannot find module '@prisma/client'"
Run `npx prisma generate` in `backend/`.

### "DATABASE_URL is not set"
Re-check `backend/.env` exists and has `DATABASE_URL=...` (no quotes mismatch).

### "Redis connection error" / "ENOTFOUND"
Verify `REDIS_URL` in `backend/.env`. Test: `curl -m 5 -o /dev/null -w "%{http_code}\n" "$REDIS_URL"` (Upstash should return 401, indicating reachable but auth required — expected).

### Claude Code doesn't auto-load MEMORY.md
The workspace path key didn't match. Check that the desktop folder structure mirrors what the key expects, OR symlink the memory directory.

### "Skill `using-superpowers` not found"
Re-install via Step 6.

### `prisma db push` — DON'T RUN
The schema is already deployed to Neon. Running `db push` from desktop will be a no-op IF nothing changed locally, but it's safer to never run it unless you're intentionally migrating schema.

---

## What's NOT migrating (and why it's fine)

- **DB data**: Neon Postgres is cloud-hosted. Both machines see the same DB via DATABASE_URL.
- **Redis cache + cookies**: Upstash is cloud-hosted. Same Redis on both machines.
- **`.claude/scheduled_tasks.lock`**: harness file, regenerated at session start.
- **BullMQ job state**: stored in Redis; survives the migration.
- **Per-site JSON outputs in `docs/site-verification/`, `docs/site-audit/`**: committed as audit trail; new runs overwrite or add timestamped files.

---

## Reference docs

- [docs/site-audit-runbook.md](site-audit-runbook.md) — operator workflow for new sites + watchdog alerts
- [docs/superpowers/plans/2026-04-27-pivot-to-ai-audit.md](superpowers/plans/2026-04-27-pivot-to-ai-audit.md) — full implementation plan
- [docs/session-handoffs/2026-04-28-end-of-session.md](session-handoffs/2026-04-28-end-of-session.md) — session handoff (commit splits, current state)
- [CLAUDE.md](../CLAUDE.md) — project rules (Claude conventions, gotchas)
