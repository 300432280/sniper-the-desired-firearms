---
name: deferred-infrastructure
description: Infrastructure and deployment tasks deferred from 2026-04-12 session — Dockerfile, Railway, Vercel, logging, monitoring, alerting
type: project
---

## Deferred Infrastructure & Deployment Tasks

These were identified as pending but deferred to a dedicated deployment session.

### Deployment (Phase 1)
1. **Backend Dockerfile** — Node 20 + Chromium for Railway (~400MB). Needed for Playwright headless browser in production.
2. **Railway setup** — connect repo, env vars, deploy Express backend + BullMQ workers. Estimated $5-20/mo.
3. **Vercel setup** — deploy Next.js frontend. Free tier or Pro $20/mo.
4. **Secrets management** — use Railway/Vercel env vars, never deploy `.env` files.
5. **End-to-end test** — register → alert → crawl → email flow on production.

### Observability (Phase 4)
6. **Structured logging** — replace `console.log` with pino. All backend services.
7. **Error alerting** — Discord/Slack webhook for BullMQ job failures. In `worker.ts` error handler.
8. **Health check endpoint** — `/health` route for Railway health probes. Simple Express route returning DB + Redis connectivity status.
9. **Sentry error monitoring** — frontend + backend error tracking. Requires Sentry DSN env var.

### Architecture (Phase 4)
10. **Split BullMQ workers** — separate Railway service when crawl load competes with API latency.
11. **CDN (Cloudflare)** — in front of Vercel for DDoS protection.

**Why deferred:** User wants to focus on code fixes and pre-bootstrap system first. Deployment stack is already evaluated (Vercel + Railway recommended by Software Architect, 2026-04-11). These tasks are straightforward once code fixes are complete.

**Cross-references:**
- `project_release_plan.md` — Phase 1 (deployment) and Phase 4 (optimization)
- `project_next_session.md` — full pending work list
