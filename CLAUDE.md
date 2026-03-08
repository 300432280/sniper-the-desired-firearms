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

## Gotchas
- On Windows: bash escapes `$disconnect` in inline node `-e` commands. Write `.js` script files instead.
- After changing `schema.prisma`, must kill running node processes before `prisma generate` (DLL lock on Windows).
- C: drive has limited disk space. Clear npm cache logs if builds fail with ENOSPC.
- `npx tsx` is available for running `.ts` scripts directly. Wrap in `async function main()` (no top-level await — project is CJS).
