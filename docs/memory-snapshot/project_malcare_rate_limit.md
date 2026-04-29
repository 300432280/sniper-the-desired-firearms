---
name: malcare-rate-limit-issue
description: MalCare WordPress WAF on dlaskarms.com triggers IP ban after ~30 rapid requests — need production-level handling if it becomes a recurring problem
type: project
---

## Issue
MalCare WordPress security plugin on dlaskarms.com (site B8) triggers a hard 403 IP ban after ~30 rapid requests. Ban message: "MalCare WordPress Security Plugin - Blocked because of Malicious Activities." Ban persists 10+ minutes.

**Why:** Discovered during heavy 8-batch WAF probe (2026-04-11) which fires ~30 requests in seconds with attack-shaped payloads. Normal production crawling at 40 req/hr (90s gaps) should NOT trigger it.

**How to apply:** Monitor dlaskarms.com crawl jobs in production. If MalCare 403s appear in logs, implement one of these fixes:

### Fix options (ordered by simplicity)
1. **Lower budget** — reduce dlaskarms budget from 40 to 20 req/hr (180s gap). Profile-only change.
2. **MalCare 403 detection + domain cooldown** — in `http-client.ts`, detect "MalCare" in 403 response body → pause all requests to that domain for 30 min (longer than ban window). ~10 lines.
3. **Profile field `rateLimitCooldownMinutes: 30`** — per-site cooldown the scheduler reads: if last crawl hit rate-limit 403, skip site for N minutes. Profile-driven, no hardcoding.

### Detection signature
- HTTP 403 with body containing "MalCare WordPress Security Plugin"
- `server: Apache` (not a CDN WAF — application-level plugin)
- Triggers on rapid request volume, NOT on specific paths or payloads

### Fleet impact
Only dlaskarms.com has MalCare in the current 63-site fleet. But any WordPress site can install MalCare — worth building the generic detection (option 2) eventually.

### Status
**Deferred** — verify in production first. Don't solve a problem that doesn't exist yet.
