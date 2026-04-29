# Site Audit Runbook (Operator)

All commands assume working directory `d:/VScode/Projects/firearm-alert` and bash shell (Git Bash on Windows).

## When to use this runbook

- Onboarding a new site (Section 2)
- Watchdog alert triggered for an existing site (Section 3)
- Periodic verification of a known-good site (Section 4)
- Diagnosing failures (Section 5)

---

## Section 1: Prerequisites

| Requirement | How to verify |
|---|---|
| Node 20+ | `node -v` |
| tsx available | `npx tsx --version` |
| Backend `.env` populated | `ls backend/.env` (must contain `DATABASE_URL` and `REDIS_URL`) |
| DB reachable | `cd backend && npx prisma studio` (opens browser GUI on port 5555) |
| Redis reachable | `cd backend && node -e "const{Redis}=require('ioredis');const r=new Redis(process.env.REDIS_URL);r.ping().then(p=>{console.log(p);r.disconnect()})"` |

Verify DB connectivity with a quick query:

```bash
cd backend && npx tsx -e "
const {prisma} = require('./src/lib/prisma');
async function main() {
  const count = await prisma.monitoredSite.count();
  console.log('MonitoredSite count:', count);
  await prisma.\$disconnect();
}
main();
"
```

> **Windows note:** If the inline command fails due to `$disconnect` escaping, write the above to a `.js` file and run it with `node`. See `CLAUDE.md` > Gotchas.

---

## Section 2: Onboard a new site (5 stages)

### 2.1 Run the audit skill

Invoke via Claude Code:

```
/pre-bootstrap https://newsite.example.ca
```

The skill (defined in `.claude/skills/pre-bootstrap/SKILL.md`) runs 9 probe modules under `backend/scripts/probe/` and writes:

- `docs/site-audit/<domain>-<timestamp>.json` -- candidate siteProfile
- `docs/site-audit/<domain>-<timestamp>-evidence.json` -- raw per-phase evidence

Verify the output exists:

```bash
ls -la docs/site-audit/ | grep newsite
```

### 2.2 Run the review pipeline

The review pipeline (`backend/scripts/audit-review-pipeline.ts`) validates the candidate profile in 5 stages:

| Stage | Name | What it checks |
|---|---|---|
| 1 | Spec compliance | Schema validation + Mistake-pattern programmatic check |
| 2 | Live walk test | Small N pages on each catalogUrl; at least 1 product per URL |
| 3 | Multi-method count | API + sitemap + walk; pairwise within 10% |
| 4 | Operator review | Gates on `--approve` flag or `--prompt` interactive Y/N |
| 5 | Output review report | JSON + markdown summary; gates on operator approval |

Run it (without approval, to inspect first):

```bash
npx tsx backend/scripts/audit-review-pipeline.ts docs/site-audit/<domain>-<ts>.json
```

Expected: Stages 1-3 PASS, Stage 4 prints summary and exits awaiting approval.

Exit codes:
- `0` -- all stages PASS (including operator approval)
- `1` -- Stage 1-3 FAIL (skill output not usable; re-run `/pre-bootstrap`)
- `2` -- Stage 4 declined by operator
- `3` -- Stage 5 write-prep error

### 2.3 Operator review

Before approving, inspect three files:

```bash
# Candidate profile -- the proposed siteProfile JSON
cat docs/site-audit/<domain>-<ts>.json | npx tsx -e "process.stdin.pipe(require('stream').PassThrough()).on('data',d=>console.log(JSON.stringify(JSON.parse(d),null,2)))"

# Review markdown -- stage-by-stage results
cat docs/site-audit/<domain>-<ts>-review.md

# Evidence JSON -- raw probe data
cat docs/site-audit/<domain>-<ts>-evidence.json | npx tsx -e "process.stdin.pipe(require('stream').PassThrough()).on('data',d=>console.log(JSON.stringify(JSON.parse(d),null,2)))"
```

Or, more simply, open them in your editor:

```bash
code docs/site-audit/<domain>-<ts>.json docs/site-audit/<domain>-<ts>-review.md
```

**Checklist before approving:**

- [ ] `platform` matches what you see on the site (Shopify, WooCommerce, BigCommerce, etc.)
- [ ] `catalogUrls` cover all major product categories (no missing top-level nav items)
- [ ] `expectedProductCount` is plausible (cross-check against the site's own "N products" text)
- [ ] `paginationPattern` format looks correct for the platform
- [ ] `wafType` matches reality (check response headers: `cf-ray` = Cloudflare, `x-sucuri-id` = Sucuri, etc.)
- [ ] `adapterType` maps to a known adapter in `backend/src/services/scraper/adapters/`

### 2.4 Approve

```bash
npx tsx backend/scripts/audit-review-pipeline.ts docs/site-audit/<domain>-<ts>.json --approve
```

This sets `approvedForDbWrite: true` in the review JSON (`docs/site-audit/<domain>-<ts>-review.json`).

Alternatively, use interactive mode:

```bash
npx tsx backend/scripts/audit-review-pipeline.ts docs/site-audit/<domain>-<ts>.json --prompt
```

### 2.5 Insert + bootstrap

```bash
npx tsx backend/scripts/enable-new-site.ts docs/site-audit/<domain>-<ts>.json
```

This script (`backend/scripts/enable-new-site.ts`):

1. Loads the approved profile JSON
2. INSERTs a new `MonitoredSite` row (`isEnabled=false`, `hasWaf` and `adapterType` from profile)
3. Enqueues one catalog-crawler pass via BullMQ
4. Polls job status for up to 10 minutes
5. Verifies `ProductIndex` count >= 50% of `expectedProductCount`
6. If PASS: flips `isEnabled=true`
7. If FAIL: leaves disabled, surfaces to operator

Exit codes:
- `0` -- success
- `1` -- bootstrap walk failed verification (< 50% products)
- `2` -- site already exists (use the update flow in Section 3.4)
- `3` -- generic error
- `4` -- review JSON missing or not approved

Dry-run mode (does not write to DB):

```bash
npx tsx backend/scripts/enable-new-site.ts docs/site-audit/<domain>-<ts>.json --dry-run
```

After successful insertion, verify the site exists in DB:

```bash
cd backend && npx tsx -e "
const {prisma} = require('./src/lib/prisma');
async function main() {
  const site = await prisma.monitoredSite.findFirst({ where: { domain: 'newsite.example.ca' }, select: { id: true, domain: true, isEnabled: true, hasWaf: true, adapterType: true } });
  console.log(JSON.stringify(site, null, 2));
  await prisma.\$disconnect();
}
main();
"
```

---

## Section 3: Handle a watchdog alert

### 3.1 Identify the failing site

The watchdog runs as part of the HealthWorker BullMQ cron (daily at 6:00 AM UTC, scheduled in `backend/src/services/queue.ts`). It calls `verifyAllSiteProfiles()` from `backend/src/services/health-monitor.ts`.

Alerts surface when a site has 3 consecutive `checkType = 'watchdog'` failures in the `site_health_checks` table. The alert type logged is `siteprofile_drift_3strikes`.

Query recent watchdog failures:

```bash
cd backend && npx tsx -e "
const {prisma} = require('./src/lib/prisma');
async function main() {
  const fails = await prisma.siteHealthCheck.findMany({
    where: { checkType: 'watchdog', canScrape: false },
    orderBy: { checkedAt: 'desc' },
    take: 20,
    select: { site: { select: { domain: true } }, errorMessage: true, checkedAt: true }
  });
  fails.forEach(f => console.log(f.site.domain, '|', f.checkedAt.toISOString(), '|', f.errorMessage?.substring(0, 80)));
  await prisma.\$disconnect();
}
main();
"
```

Check dismissed issues (operator previously dismissed but condition may have resurfaced):

```bash
cd backend && npx tsx -e "
const {prisma} = require('./src/lib/prisma');
async function main() {
  const dismissed = await prisma.dismissedIssue.findMany({
    where: { issueType: { contains: 'siteprofile_drift' } },
    select: { site: { select: { domain: true } }, issueType: true, dismissedAt: true, conditionSnapshot: true }
  });
  dismissed.forEach(d => console.log(d.site.domain, '|', d.issueType, '|', d.dismissedAt.toISOString()));
  await prisma.\$disconnect();
}
main();
"
```

### 3.2 Verify with one-off run

Run the standalone verifier (`backend/scripts/verify-site-profile.ts`) against the specific domain:

```bash
npx tsx backend/scripts/verify-site-profile.ts <domain>
```

This tests every load-bearing siteProfile parameter against the live site:
- `catalogUrls` -- HEAD probe + GET page 1 + product extract (>= 1 product per URL)
- `paginationPattern` -- page 1 vs page 2 first-product slugs must differ
- `sortParam` -- with-sort vs without-sort first-product slug must differ
- `expectedProductCount` -- re-derived via best API/sitemap method (within +/- 10%)
- `wafType` -- HEAD probe + vendor-header match

Output is written to `docs/site-verification/<domain>-<timestamp>.json` and a per-parameter PASS/WARN/FAIL table is printed to console.

Inspect the output:

```bash
ls -la docs/site-verification/ | grep <domain>
cat docs/site-verification/<domain>-*.json | python -m json.tool
```

### 3.3 Re-audit

If the verifier shows FAIL on structural parameters (catalogUrls, platform, pagination), re-run the full audit:

```
/pre-bootstrap <url>
```

Compare the new candidate JSON to the current DB siteProfile. Focus on which fields changed and whether the change reflects a real site update or a probe error.

### 3.4 Update via review pipeline

Run the review pipeline on the new candidate, same as Section 2.2-2.4:

```bash
npx tsx backend/scripts/audit-review-pipeline.ts docs/site-audit/<domain>-<ts>.json
# ... review output ...
npx tsx backend/scripts/audit-review-pipeline.ts docs/site-audit/<domain>-<ts>.json --approve
```

**Important:** `enable-new-site.ts` REFUSES to update existing sites (exit code 2). For updates to existing sites, apply the approved changes manually via Prisma Studio or a targeted update script:

```bash
cd backend && npx prisma studio
```

In Prisma Studio (browser GUI):
1. Navigate to the `MonitoredSite` table
2. Find the site by domain
3. Edit the `siteProfile` JSON column with the approved changes
4. Save

Alternatively, write a one-off update script:

```bash
cd backend && npx tsx -e "
const {prisma} = require('./src/lib/prisma');
const fs = require('fs');
async function main() {
  const profile = JSON.parse(fs.readFileSync('../docs/site-audit/<domain>-<ts>.json', 'utf-8'));
  await prisma.monitoredSite.update({
    where: { domain: '<domain>' },
    data: { siteProfile: profile }
  });
  console.log('Updated siteProfile for <domain>');
  await prisma.\$disconnect();
}
main();
"
```

> Replace `<domain>` and `<ts>` with actual values. Review the profile JSON before running.

---

## Section 4: Periodic verification

### Automatic (watchdog)

The watchdog runs automatically as part of the HealthWorker cron at **6:00 AM UTC daily**. It is scheduled in `backend/src/services/queue.ts` and executed by `startHealthWorker()` in `backend/src/services/worker.ts`.

The watchdog calls `verifyAllSiteProfiles()` from `backend/src/services/health-monitor.ts`, which:
1. Verifies every enabled site's siteProfile parameters against the live site
2. Persists each result as a `SiteHealthCheck` row (`checkType = 'watchdog'`)
3. Checks the last 3 watchdog rows per site -- if all 3 FAIL, logs a `siteprofile_drift_3strikes` alert

### Manual: all sites

Force a full watchdog run outside of the cron schedule:

```bash
cd backend && npx tsx -e "
const {verifyAllSiteProfiles} = require('./src/services/health-monitor');
async function main() {
  const results = await verifyAllSiteProfiles();
  const alerts = results.filter(r => r.shouldAlert);
  console.log('Total sites verified:', results.length);
  console.log('Drift alerts:', alerts.length);
  alerts.forEach(a => console.log(' -', a.domain, a.failedChecks));
  const {prisma} = require('./src/lib/prisma');
  await prisma.\$disconnect();
}
main();
"
```

### Manual: single site

```bash
npx tsx backend/scripts/verify-site-profile.ts <domain>
```

### Manual: all sites (via CLI)

```bash
npx tsx backend/scripts/verify-site-profile.ts --all
```

This runs the standalone verifier against every enabled `MonitoredSite` and writes per-site JSON reports to `docs/site-verification/`.

---

## Section 5: Troubleshooting

### "Skill output disagrees with stored siteProfile"

The stored DB `siteProfile` is the answer key. See `C:/Users/TNT/.claude/projects/d--VScode-Projects-firearm-alert/memory/feedback_per_room_ground_truth.md` for the full rationale.

**DO NOT modify the DB siteProfile to match the skill output.** First investigate:

1. **Did the site change?** Check the site in a browser. Look for redesigns, new category pages, platform migrations, or maintenance pages.

2. **Did the skill make an error?** Re-read the evidence file:
   ```bash
   cat docs/site-audit/<domain>-<ts>-evidence.json | python -m json.tool | less
   ```

3. **Did the review pipeline verification fail?** Run the specific checks manually:
   ```bash
   # Test a catalogUrl manually
   curl -sS -o /dev/null -w "%{http_code}" "https://<domain>/collections/firearms"

   # Check pagination (page 1 vs page 2 should return different products)
   curl -sS "https://<domain>/collections/firearms?page=1" | grep -c 'product'
   curl -sS "https://<domain>/collections/firearms?page=2" | grep -c 'product'
   ```

4. **Compare candidate to stored profile:**
   ```bash
   cd backend && npx tsx -e "
   const {prisma} = require('./src/lib/prisma');
   async function main() {
     const site = await prisma.monitoredSite.findFirst({ where: { domain: '<domain>' }, select: { siteProfile: true } });
     console.log(JSON.stringify(site?.siteProfile, null, 2));
     await prisma.\$disconnect();
   }
   main();
   "
   ```

### "Audit pipeline Stage 3 FAILED on count drift > 10%"

Likely causes:

- **Stale stored count:** `expectedProductCount` was not re-derived this audit. Re-run the audit skill (`/pre-bootstrap <url>`) to get a fresh count.

- **Sitemap regen lag on classifieds:** Classified sites (e.g., gunpost.ca) may have stale sitemaps. Use the pagination-walk count method instead:
  ```bash
  # Verify the sitemap count vs live count
  curl -sS "https://<domain>/sitemap.xml" | grep -c '<url>'
  npx tsx backend/scripts/verify-site-profile.ts <domain>
  ```

- **Sub-category tile trap (Mistake 38):** The page lists sub-category tiles instead of products. Walk deeper into leaf categories:
  ```bash
  # Check if a category URL returns tiles or products
  curl -sS "https://<domain>/collections/firearms" | grep -c 'product'
  ```
  If product count is 0 but sub-category links exist, the catalogUrl needs to be updated to leaf categories.

### "enable-new-site.ts says ProductIndex count < 50% expected"

The bootstrap pass under-collected. Investigate:

1. **Check CrawlEvent logs** (table: `crawl_events`):
   ```bash
   cd backend && npx tsx -e "
   const {prisma} = require('./src/lib/prisma');
   async function main() {
     const site = await prisma.monitoredSite.findFirst({ where: { domain: '<domain>' } });
     if (!site) { console.log('Site not found'); await prisma.\$disconnect(); return; }
     const events = await prisma.crawlEvent.findMany({
       where: { siteId: site.id },
       orderBy: { crawledAt: 'desc' },
       take: 10,
       select: { status: true, jobType: true, pagesScanned: true, matchesFound: true, errorMessage: true, crawledAt: true }
     });
     events.forEach(e => console.log(e.crawledAt.toISOString(), '|', e.jobType, '|', e.status, '|', 'pages:', e.pagesScanned, '|', 'matches:', e.matchesFound, '|', e.errorMessage?.substring(0, 60)));
     await prisma.\$disconnect();
   }
   main();
   "
   ```

2. **Check which catalogUrls returned 0 products:**
   ```bash
   cd backend && npx tsx -e "
   const {prisma} = require('./src/lib/prisma');
   async function main() {
     const site = await prisma.monitoredSite.findFirst({ where: { domain: '<domain>' }, select: { siteProfile: true } });
     const profile = site?.siteProfile;
     const urls = profile?.catalogUrls || [];
     console.log('catalogUrls in profile:');
     urls.forEach((u, i) => console.log(i+1, u));
     await prisma.\$disconnect();
   }
   main();
   "
   ```
   Then test each URL manually:
   ```bash
   curl -sS -o /dev/null -w "%{http_code} %{size_download}b" "https://<domain>/collections/firearms"
   ```

3. **Check WAF cookie status:** The WAF cookie manager (`backend/src/services/scraper/waf-cookie-manager.ts`) handles Cloudflare and Sucuri challenges via Playwright. If WAF cookies were not obtained, crawls will be blocked:
   ```bash
   cd backend && npx tsx -e "
   const {prisma} = require('./src/lib/prisma');
   async function main() {
     const site = await prisma.monitoredSite.findFirst({ where: { domain: '<domain>' }, select: { hasWaf: true, siteProfile: true } });
     console.log('hasWaf:', site?.hasWaf);
     console.log('wafType:', site?.siteProfile?.wafType);
     await prisma.\$disconnect();
   }
   main();
   "
   ```

**DO NOT flip `isEnabled=true` manually** until the gap is understood. Enabling a site with incomplete product data will produce false-negative alerts for users.

### "verifyAllSiteProfiles() throws or times out"

The watchdog fetches live pages for every enabled site, which can take several minutes:

```bash
# Check how many enabled sites exist (each gets verified)
cd backend && npx tsx -e "
const {prisma} = require('./src/lib/prisma');
async function main() {
  const count = await prisma.monitoredSite.count({ where: { isEnabled: true } });
  console.log('Enabled sites:', count);
  await prisma.\$disconnect();
}
main();
"
```

If the watchdog times out, run it for a single site to isolate the problem:

```bash
npx tsx backend/scripts/verify-site-profile.ts <domain>
```

### "Site was working yesterday, now returns 403/503"

Likely WAF challenge or rate limit. Check:

```bash
# Quick HEAD probe
curl -sS -o /dev/null -w "%{http_code}" -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" "https://<domain>/"

# Check recent crawl events for the site
cd backend && npx tsx -e "
const {prisma} = require('./src/lib/prisma');
async function main() {
  const site = await prisma.monitoredSite.findFirst({ where: { domain: '<domain>' } });
  if (!site) { console.log('Not found'); await prisma.\$disconnect(); return; }
  const events = await prisma.crawlEvent.findMany({
    where: { siteId: site.id },
    orderBy: { crawledAt: 'desc' },
    take: 5,
    select: { status: true, statusCode: true, errorMessage: true, crawledAt: true }
  });
  events.forEach(e => console.log(e.status, e.statusCode, e.errorMessage?.substring(0, 80), e.crawledAt.toISOString()));
  await prisma.\$disconnect();
}
main();
"
```

---

## Key file reference

| File | Purpose |
|---|---|
| `.claude/skills/pre-bootstrap/SKILL.md` | Audit skill definition (judgment layer over probe evidence) |
| `backend/scripts/probe/` | 9 probe modules (Room 1-5 + shared utilities) |
| `backend/scripts/audit-review-pipeline.ts` | 5-stage review pipeline (spec check, live walk, count, operator gate, report) |
| `backend/scripts/verify-site-profile.ts` | Standalone live verifier (single site or `--all`) |
| `backend/scripts/enable-new-site.ts` | Post-approval DB insert + bootstrap crawl |
| `backend/src/services/health-monitor.ts` | Daily watchdog (`verifyAllSiteProfiles()`) + connectivity checks |
| `backend/src/services/worker.ts` | BullMQ workers including `startHealthWorker()` |
| `backend/src/services/queue.ts` | Cron scheduling (health check at 6:00 AM UTC) |
| `backend/src/services/profile-validator.ts` | Schema validation for siteProfile JSON |
| `backend/src/services/scraper/waf-cookie-manager.ts` | Playwright-based WAF cookie acquisition |
| `backend/prisma/schema.prisma` | DB schema (`MonitoredSite`, `SiteHealthCheck`, `DismissedIssue`, `CrawlEvent`) |
| `docs/site-audit/` | Audit output directory (candidate profiles, evidence, reviews) |
| `docs/site-verification/` | Verification output directory (per-site JSON reports) |
