---
name: project-current-state
description: Current project status, recent fixes, and active concerns as of 2026-03-25
type: project
---

## Active Systems
- **Daily stale detection** (stale-detector.ts): runs at 4 AM UTC via BullMQ cron. Cross-tier cycle completion determines disappeared products. Verifies via detail page: sold → out_of_stock, 404 → isActive=false. Sold items re-checked after 5 days.
- **Daily budget auto-adjustment**: runs in same daily job. Tiers: <100→20, 100-500→40, 500-2000→60, 2000-5000→90, 5000-10000→120, 10000+→180 tokens/hr. New sites default to 60.
- **WAF cookie manager** (waf-cookie-manager.ts): Playwright-based Sucuri cookie solver with Redis cache (90min TTL). Shared browser singleton. Enables WooCommerce API on WAF sites (gotenda, etc).
- **Scheduler tier recovery**: runs on ALL enabled sites every 2 minutes. Resets stuck in_progress (>15min) and expired cooldowns.
- **Page-skip on fetch failure**: catalog crawler skips blocked pages instead of retrying forever.

## Architecture Changes (2026-03-25)
- `waf-cookie-manager.ts` — Sucuri cookie acquisition, Redis mutex, failure tracking
- WooCommerce adapter: cookie injection via `hasWaf` flag, retry on 307/403
- `hasWaf` threaded through full pipeline: scheduler → detectStreams → probeStreamTotalPages → crawlStreamTier/crawlCatalogTier → fetchCatalogPage
- `PLAYWRIGHT_UA` shared constant (was duplicated in 3 files)
- N+1 budget query replaced with single groupBy
- C3 probe: HTML entity decoding (fixes false title mismatches)
- Gotenda switched from generic-retail (HTML) to woocommerce (API with WAF cookies) — 16k+ products accessible

## Known Issues (not bugs)
- canadafirstammo 42% price coverage — OOS items genuinely have no price on live site
- bullseyenorth investigation script shows ALL_UAS_BLOCKED — script limitation, crawler uses Playwright fine
- gotenda 0% sourceId/tags — just switched adapter, filling as crawler runs
- gunpost sourceId 9% — filling slowly through Cloudflare (1693 pages)

## Deployment
Not yet done — running locally on Windows. Need backend restart to deploy scheduler fixes (stuck tiers on canadafirst/alsimmons).

## Key Rules
- Never deactivate products based on lastSeenAt alone — only after cross-tier verification + detail page check
- Investigation script D2 is report-only — stale-detector.ts handles fixes automatically
- Run /simplify after every implementation session before committing
- Use proper agents for complex investigations and code reviews
