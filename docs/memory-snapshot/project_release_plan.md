---
name: release-plan
description: Release plan from pre-launch to production — deployment, pre-bootstrap system, deferred fixes
type: project
---

## Release Plan — firearm-alert

### Phase 0: Pre-launch fixes (BEFORE deployment)
**Must fix — blocking production launch:**

1. **API→HTML Fallback Gap** (Mistake 34) — `apiCrawlUsed` flag prevents HTML fallback when API returns empty. ~15 lines in `catalog-crawler.ts`. Add consecutive-empty-API-cycles counter; force `apiCrawlUsed=false` after 3 consecutive 0-product cycles. See `project_api_fallback_gap.md`.

2. **Rate limiter store** — `express-rate-limit` uses in-memory store, resets on deploy. Switch to `rate-limit-redis` backed by Upstash. One-line change.

3. **CORS origin** — currently `http://localhost:3000`. Set to real domain via env var.

4. **Secrets** — use Railway/Vercel env vars, never deploy `.env` files.

5. **Backend Dockerfile** — Node 20 + Chromium deps for Playwright (~400MB).

### Phase 1: Deployment (Vercel + Railway)
**Recommended stack** (from Software Architect evaluation 2026-04-11):
- Vercel for Next.js frontend (free tier or Pro $20/mo)
- Railway for Express backend + BullMQ workers ($5-20/mo)
- Neon PostgreSQL (already serverless)
- Upstash Redis (already serverless)
- Estimated: $5-25/mo at 10K daily visitors

Steps:
1. Create backend Dockerfile
2. Set up Railway project, connect repo, env vars
3. Deploy frontend to Vercel
4. Switch rate limiter to Redis
5. Set production CORS
6. Test full flow: register → alert → crawl → email

### Phase 2: Pre-Bootstrap System
**Build the automated site onboarding process** (from `project_pre_bootstrap_plan.md`):

Priority 1: `backend/scripts/pre-bootstrap-probe.ts` (~500 lines, mechanical probes, JSON output)
Priority 2: `.claude/skills/pre-bootstrap/SKILL.md` (Claude Code skill, judgment layer)
Priority 3: `backend/src/services/profile-validator.ts` (~50 lines, validation gate)

### Phase 3: Deferred code fixes
1. **WooCommerce Store-API-only fetchCatalogPage** — for sites where WP REST is 401 but Store API works (tacord.com). ~40 lines in `woocommerce.ts`.
2. **TownPost adapter extraction** — add `/marketplace/` link selector to `generic-retail.ts` SELECTORS. Currently 0 selectors match townpost.ca HTML.
3. **LightSpeed `.product-element` selector** — add to `generic-retail.ts` SELECTORS for custom/developer theme sites (gobles.ca works via generic selectors today but fragile).
4. **MalCare 403 detection + domain cooldown** — detect "MalCare" in 403 body → pause domain for 30 min. ~10 lines in `http-client.ts`. Monitor dlaskarms.com first.

### Phase 4: Post-launch optimization
1. **Structured logging** — replace `console.log` with pino
2. **Error alerting** — Discord/Slack webhook for BullMQ failures
3. **Health check** — point Railway at `/health` endpoint
4. Split BullMQ workers to separate Railway service (when crawl load competes with API latency)
5. CDN (Cloudflare) in front of Vercel for DDoS protection
6. Sentry for error monitoring
