# Pivot to AI-Driven Per-Site Audit + Hybrid Architecture — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the failed generic onboarding pipeline with a hybrid system: AI-driven per-site audit (skill) → operator-reviewed `siteProfile` JSON → DB write → existing production crawler picks up automatically. Add a watchdog that re-verifies all 60 enabled sites daily and flags drift.

**Architecture:** Three flows — (1) NEW-site onboarding via the AI audit skill + 5-stage review pipeline, (2) EXISTING-site operations (production crawler unchanged), (3) WATCHDOG continuous verification (extends `health-monitor.ts`). The 60 existing `siteProfile` JSON entries in DB are the asset; production crawlers (`catalog-crawler.ts`, `watermark-crawler.ts`, adapters under `scraper/adapters/`) are unchanged. Generic discovery code from Rounds 1-4 is deprecated, not deleted.

**Tech Stack:** Node 20 + TypeScript (CJS), Prisma (Neon Postgres), BullMQ (Upstash Redis), Playwright (existing), Express, Next.js 14 admin UI. New code uses `npx tsx` (no build step), reuses `backend/scripts/probe/shared/fetch.ts` (`fetchUrl`/`safeFetch`), `backend/src/services/scraper/adapters/*` for live extraction, and `backend/src/services/profile-validator.ts` for spec-compliance checks.

---

## How to Resume (READ THIS FIRST — every session)

This plan runs across many sessions. Each session uses a 3-role agent harness. Lone-Claude implementation is forbidden by the user.

### Mandatory reading at session start
1. **`C:/Users/TNT/.claude/projects/d--VScode-Projects-firearm-alert/memory/MEMORY.md`** — memory index
2. **`C:/Users/TNT/.claude/projects/d--VScode-Projects-firearm-alert/memory/feedback_agent_harness_pattern.md`** — the 3-role pattern (mandatory)
3. **This plan file** — check the task progress checkboxes
4. **The most recent file in `docs/session-handoffs/`** — what was done last session, what's next
5. **`d:/VScode/Projects/firearm-alert/CLAUDE.md`** — project rules
6. **`d:/VScode/Projects/firearm-alert/.claude/agents/crawler-specialist.md`** — persona (39 lessons)
7. **`d:/VScode/Projects/firearm-alert/.claude/probe-rewrite-lessons.md`** — distilled anti-patterns

### Roles per session

**Orchestrator (top-level Claude in the session):**
- Reads MEMORY.md + plan + most recent handoff at start
- Dispatches subagents for each task — never implements directly
- Runs `using-superpowers` every turn
- Writes the new session handoff at end of session

**Overseer (Senior PM agent):**
- Updates this plan's task checkboxes as work completes
- Records blocking questions in handoff
- Tracks which task each implementer subagent owns

**Implementer (one per task):**
- Always one of `crawler-specialist`, `backend-engineer`, or `frontend-engineer` — chosen by domain
- Always loaded with the matching `.claude/agents/<role>.md` persona file content (mandatory per CLAUDE.md)
- Receives the full task text + acceptance criteria from the orchestrator
- Returns code diff + verification output (not just "done")

**Reviewer (one per task per stage):**
- Stage 1: `code-reviewer` agent — code quality, regressions, correctness
- Stage 2: `general-purpose` agent — spec compliance against this plan + skill expectations

### Per-task dispatch sequence
1. Orchestrator reads next unchecked task here
2. Spawn implementer (with persona + task text + acceptance criteria)
3. Spawn `code-reviewer` (loaded with `.claude/agents/code-reviewer.md`)
4. Spawn spec-compliance reviewer (`general-purpose` agent, loaded with this plan section + acceptance criteria)
5. If both reviewers pass → orchestrator checks the task box here
6. If either fails → orchestrator dispatches implementer again with review notes
7. Repeat for next task

### Compaction safeguard
Before any `/compact` operation, the orchestrator:
1. Updates this plan's checkboxes
2. Writes new handoff at `docs/session-handoffs/YYYY-MM-DD-end-of-session.md` (use `docs/session-handoffs/HANDOFF-TEMPLATE.md`)
3. Updates `project_next_session.md` in memory with current state pointer

### What NOT to do
- Do NOT commit (user authorizes commits)
- Do NOT modify `MonitoredSite.siteProfile` in DB during audit work — it is the answer key
- Do NOT add site-specific code branches — fix the abstraction or document a per-site override in profile JSON
- Do NOT skip the review pipeline (the user explicitly forbade corner-cutting)
- Do NOT implement directly without dispatching an implementer subagent

---

## Pivot Context (encode the user's decisions)

After 4 rounds of building generic onboarding code, the user determined:
- Generic onboarding code = per-platform code wearing a generic costume. Net value = 0.
- AI is excellent at one-site investigation (proven by `34-site-audit-history.md` + the live-verify-65 work)
- Industry standard for fleet scrapers = per-target adapters maintained continuously, not generic systems
- The 60 existing `siteProfile` entries in DB are the asset; production crawler already works for them
- New sites need: AI audit → review pipeline → DB insert. Production crawler picks up automatically.
- Watchdog detects degradation; re-audit triggered on alert

### Three flows

| Flow | Trigger | Code path |
|---|---|---|
| NEW site onboarding | Operator runs the audit skill | Skill → `audit-review-pipeline.ts` → operator approves → `enable-new-site.ts` → DB insert |
| EXISTING site operations | Crawler tick (every 2 min) | UNCHANGED — `crawl-scheduler.ts` → `catalog-crawler.ts` / `watermark-crawler.ts` → adapters → `product-upsert.ts` |
| WATCHDOG continuous | Daily cron in `health-monitor.ts` | `verifyAllSiteProfiles()` → per-site `verify-site-profile.ts` logic → 3-strike alert |

### 6 phases of the audit (per playbook + new explicit Phase 2)

| Phase | Name | Inputs | Output |
|---|---|---|---|
| 0 | Read existing profile + canonical URL | DB siteProfile (if exists) + URL | Baseline state |
| 1 | WAF probe + platform detection | URL | `wafType`, `platform`, evidence |
| 2 | API accessibility (NEW explicit) | Phase 1 output | API endpoints reachable + response shapes |
| 3 | Catalog URL discovery | Phase 1+2 | `catalogUrls[]` (sitemap + nav + taxonomy + view-all) |
| 4 | Pagination detection | Phase 3 | `paginationPattern` + 4-test verification |
| 5 | Sort param + watermark method | Phase 3+4 | `sortParam`, `watermarkMethod` (A/B/C) |
| 6 | Coverage verification + multi-method count cross-check | All prior | `expectedProductCount` + per-source agreement |
| Output | siteProfile JSON + evidence files | All | File at `docs/site-audit/<domain>-<timestamp>.json` |

### Review pipeline (5 stages, fail-stops, no corner-cutting)

1. **Spec compliance check** — programmatic: pattern matches platform conventions, no Mistake patterns triggered (fed by `profile-validator.ts`)
2. **Live walk test** — fetch small N pages on each catalogUrl, confirm extraction returns ≥1 product per URL
3. **Multi-method count verification** — API count + sitemap count + walk count must agree within 10%
4. **Operator review in admin UI** — operator sees JSON + evidence + test results
5. **DB write** — only after operator approves (`--approve` flag or admin-UI button)

### Production crawler (UNCHANGED)
- `backend/src/services/catalog-crawler.ts` (T2-T4)
- `backend/src/services/watermark-crawler.ts` (T1)
- `backend/src/services/scraper/adapters/*.ts`
- `backend/src/services/product-upsert.ts`
- `backend/src/services/crawl-scheduler.ts`
- `backend/src/services/health-monitor.ts` (to be EXTENDED with watchdog)

### Salvage from Rounds 1-4 (uncommitted)

| Action | Files |
|---|---|
| KEEP | `backend/scripts/probe/room1-intake/`, `backend/scripts/probe/room2-access-identity/` (incl. 18 detectors), `backend/scripts/probe/shared/` (`fetch.ts` HPE_HEADER_OVERFLOW fix, `redis-cookies.ts`, `extract.ts`, `types.ts`, `ua.ts`, `url-utils.ts`), `backend/scripts/probe/__test__/` comparison harness, memory rules added this session |
| DEPRECATE (mark unused, don't delete) | `backend/scripts/probe/room3-geography-count/*` (catalog-urls, sitemap-products, sitemap-parse, select-catalog-set, walk-verify, global-count, pagination-detect), `backend/scripts/probe/room4-navigation/*` (sort-detect, watermark-method, pagination-detect already covered), `backend/scripts/probe/room5-bootstrap/*` (1055 lines) |

---

## File Structure

This plan creates / modifies these files:

| Path | Action | Owner role | Purpose |
|---|---|---|---|
| `backend/scripts/verify-site-profile.ts` | CREATE | crawler-specialist | Permanent live-parameter verifier; doubles as watchdog cron logic |
| `.claude/skills/pre-bootstrap/SKILL.md` | MODIFY (in-place) | crawler-specialist | Rename intent to "site-audit"; add explicit Phase 2; output candidate siteProfile JSON |
| `backend/scripts/audit-review-pipeline.ts` | CREATE | backend-engineer | 5-stage review orchestrator with fail-stops + operator gate |
| `backend/src/services/health-monitor.ts` | EXTEND | backend-engineer | Add `verifyAllSiteProfiles()` for watchdog; persist to `SiteHealthCheck` |
| `backend/scripts/enable-new-site.ts` | CREATE | backend-engineer | ~50-line post-review insert + bootstrap trigger |
| `backend/scripts/probe/room3-geography-count/_DEPRECATED.md` | CREATE | crawler-specialist | Header note explaining deprecation |
| `backend/scripts/probe/room4-navigation/_DEPRECATED.md` | CREATE | crawler-specialist | Header note explaining deprecation |
| `backend/scripts/probe/room5-bootstrap/_DEPRECATED.md` | CREATE | crawler-specialist | Header note explaining deprecation |
| `docs/site-verification/` | CREATE (dir) | — | Output directory for `verify-site-profile.ts` runs |
| `docs/site-verification/baseline-2026-04-27.md` | CREATE | crawler-specialist | Baseline watchdog report on 60 enabled sites |
| `docs/site-audit-runbook.md` | CREATE | backend-engineer | Operator runbook (onboard new site, handle alerts) |
| `docs/session-handoffs/HANDOFF-TEMPLATE.md` | CREATE | overseer | Template for end-of-session handoff (created in this overseer session) |
| `C:/Users/TNT/.claude/projects/d--VScode-Projects-firearm-alert/memory/feedback_agent_harness_pattern.md` | CREATE | overseer | Memory rule documenting the 3-role pattern (created in this overseer session) |

---

## Task 1: Build `verify-site-profile.ts` — live parameter verifier

**Owner:** `crawler-specialist`

**Files:**
- Create: `backend/scripts/verify-site-profile.ts`
- Reuses: `backend/scripts/probe/shared/fetch.ts` (`fetchUrl`, `safeFetch`)
- Reuses: `backend/src/services/scraper/adapters/*` (`extractCatalogProducts`, `fetchCatalogPage`)
- Reuses: `backend/src/lib/prisma.ts` (`prisma`)
- Output dir (created at runtime): `docs/site-verification/`

**Why this is permanent (not throwaway):** the same logic powers the watchdog cron in Task 4. One file, two callers (CLI + cron).

### Step 1.1: Verify required imports compile against current code

- [ ] **Confirm `fetchUrl` signature** in `backend/scripts/probe/shared/fetch.ts` (read offset 1-30 then 200-230)
- [ ] **Confirm `extractCatalogProducts` is exported** from `backend/src/services/scraper/adapters/generic-retail.ts`
- [ ] **Confirm `prisma` is importable** from `backend/src/lib/prisma.ts` (check the path; some scripts use `../src/lib/prisma`)
- [ ] **Confirm `MonitoredSite.siteProfile` shape** by reading `backend/prisma/schema.prisma` lines 142-280

### Step 1.2: Define output type + CLI shape

- [ ] **Write file header + types**

```ts
// backend/scripts/verify-site-profile.ts
/**
 * verify-site-profile — live parameter verifier for MonitoredSite.siteProfile.
 *
 * Tests every load-bearing siteProfile parameter against the live site:
 *  - catalogUrls    (HEAD probe + GET page 1 + production extract → ≥1 product per URL)
 *  - paginationPattern (page 1 vs page 2: first product slugs MUST differ)
 *  - sortParam      (with-sort vs without-sort: first product slug MUST differ)
 *  - expectedProductCount (re-derive via best API/sitemap method; expect ±10%)
 *  - wafType        (curl-equivalent HEAD; vendor-header match)
 *
 * CLI:
 *   npx tsx backend/scripts/verify-site-profile.ts <domain>
 *   npx tsx backend/scripts/verify-site-profile.ts --all
 *
 * Output:
 *   docs/site-verification/<domain>-<timestamp>.json
 *   Console: per-parameter PASS / WARN / FAIL table
 *
 * Library use (Task 4 — health-monitor watchdog):
 *   import { verifySiteProfile } from './verify-site-profile';
 *   const result = await verifySiteProfile(site);
 */

export type Verdict = 'PASS' | 'WARN' | 'FAIL';

export interface ParameterCheck {
  name: 'catalogUrls' | 'paginationPattern' | 'sortParam' | 'expectedProductCount' | 'wafType';
  verdict: Verdict;
  expected: unknown;
  actual: unknown;
  evidence: Record<string, unknown>;
  reason?: string;
}

export interface VerificationResult {
  siteId: string;
  domain: string;
  timestamp: string;
  durationMs: number;
  overallVerdict: Verdict;       // worst of all checks
  checks: ParameterCheck[];
  rawSiteProfile: unknown;        // snapshot for diffing
}
```

### Step 1.3: Implement `checkCatalogUrls`

- [ ] **Per-catalogUrl check:** HEAD probe (status), then GET page 1 via `fetchUrl`, then call production `extractCatalogProducts` (use the adapter selected by `siteProfile.adapterType`). Verdicts:
  - **PASS:** status 200 + ≥1 product extracted
  - **WARN:** status 200 + 0 products (sub-category tile page possible — Mistake 38)
  - **FAIL:** status ≥ 400 OR fetch error

- [ ] **Aggregate:** if any single URL is FAIL → overall check FAIL. If any WARN and none FAIL → WARN. All PASS → PASS.

- [ ] **Evidence to capture:** `perUrl: { url, status, productCount, sampleSlugs: string[] }[]`

### Step 1.4: Implement `checkPaginationPattern`

- [ ] **Use first catalogUrl** that returned products in 1.3
- [ ] **Build page 1 + page 2 URLs** using existing `buildPaginatedUrl` from `backend/src/services/catalog-crawler.ts:118-166` (import directly; do not duplicate)
- [ ] **Extract first 3 product URLs from each page**
- [ ] Verdicts:
  - **PASS:** zero overlap between page1 and page2 first-3
  - **WARN:** partial overlap (1-2 of 3 match — may indicate small category)
  - **FAIL:** all 3 identical (silent-ignore — Mistake 26 LightSpeed pattern)

- [ ] **Evidence:** `{ page1Url, page2Url, page1First3, page2First3, overlapCount }`

### Step 1.5: Implement `checkSortParam`

- [ ] **Skip if `siteProfile.crawlers.watermark.method === 'full-catalog-sweep'`** (Method C — sort verification N/A; verdict PASS with reason `not-applicable-method-c`)
- [ ] **Build with-sort and without-sort URLs** (without-sort = strip the sort param from a catalogUrl)
- [ ] **Extract first product slug from each**
- [ ] Verdicts:
  - **PASS:** first slugs differ
  - **WARN:** first slugs identical AND counter-control (alphaasc / price-asc) returns the SAME first slug (matches Mistake 29 honored-default-is-newest pattern — sort is honored, but default already equals newest)
  - **FAIL:** first slugs identical AND counter-control gives a third different slug (sort silently ignored — site-side change)

- [ ] **Evidence:** `{ withSortUrl, withoutSortUrl, withSortFirst, withoutSortFirst, counterControlUrl, counterControlFirst }`

### Step 1.6: Implement `checkExpectedProductCount`

- [ ] **Re-derive count** using the same priority chain as `siteProfile.productCountMethod`:
  1. WP REST `x-wp-total` header (if `adapterType: woocommerce`)
  2. WC Store API `x-wp-total`
  3. Shopify `/products/count.json` → `count`
  4. Ecwid `POST /catalog/search` → `totalProductsCount`
  5. Sitemap-derived (filter `<loc>` to product URLs)
  6. Walk-only (sum of pages × perPage on first catalogUrl, last page truncated)
- [ ] **Compute drift:** `|stored - actual| / stored × 100`
- [ ] Verdicts:
  - **PASS:** drift ≤ 10%
  - **WARN:** drift 10-25%
  - **FAIL:** drift > 25%
- [ ] **Evidence:** `{ storedCount, actualCount, methodUsed, driftPct }`

### Step 1.7: Implement `checkWafType`

- [ ] **Run a single curl-equivalent HEAD** via `fetchUrl(url, { method: 'HEAD' })` (extend `fetchUrl` if HEAD not yet supported — small additive change to `shared/fetch.ts`)
- [ ] **Match vendor headers:**
  - `cf-ray` / `server: cloudflare` → `cloudflare-passive` (or active if 403 + `cf-mitigated: challenge` on browser UA)
  - `x-sucuri-id` / `server: Sucuri/Cloudproxy` → `sucuri`
  - `sg-captcha: challenge` → `sgcaptcha`
  - `set-cookie: visid_incap_*` / `incap_ses_*` → `incapsula`
  - `server: AkamaiGHost` → `akamai`
  - body contains MalCare markers → `malcare`
  - none → `null`
- [ ] Verdicts:
  - **PASS:** detected vendor matches `siteProfile.wafType`
  - **WARN:** detected `null` but stored non-null (vendor may have been removed)
  - **FAIL:** detected vendor differs from stored vendor (Mistake 35 — wrong-vendor cascade)
- [ ] **Evidence:** `{ storedWafType, detectedWafType, headers: Record<string, string> }`

### Step 1.8: Wire CLI + library entry points

- [ ] **Library entry:** `export async function verifySiteProfile(site: { id: string; domain: string; url: string; siteProfile: unknown }): Promise<VerificationResult>` — runs all checks, returns result. NO console output, NO file write (caller decides).
- [ ] **CLI entry:** `async function main()` — parses argv, fetches site(s) from DB, calls library entry, writes JSON to `docs/site-verification/<domain>-<ISOtimestamp>.json`, prints console table.
- [ ] **`--all` mode:** queries `prisma.monitoredSite.findMany({ where: { isEnabled: true }})`, runs sequentially (NOT parallel — respect token budget), prints summary at end. Use `await new Promise(r => setTimeout(r, 2000))` between sites (anti-ban; matches `feedback_catalog_urls_full_coverage.md` rule).
- [ ] **CJS exit pattern:** wrap main in `async function main() { ... }` then `main().catch(console.error).finally(() => prisma.$disconnect())` (Windows constraint per CLAUDE.md "Gotchas")

### Step 1.9: Verification (Task 1 acceptance)

- [ ] **Run on 3 known-good Tier-1 sites** sequentially:
  - `npx tsx backend/scripts/verify-site-profile.ts canadafirstammo.ca`
  - `npx tsx backend/scripts/verify-site-profile.ts aagcanada.ca`
  - `npx tsx backend/scripts/verify-site-profile.ts theammosource.com`
- [ ] **Expected:** all 5 checks PASS for each (these are the canonical ground-truth sites — `feedback_per_room_ground_truth.md`)
- [ ] **Verify JSON files** were written to `docs/site-verification/` with the timestamp filename
- [ ] **`tsc --noEmit` clean** in `backend/`

### Step 1.10: Run on the user's 10 priority sites

- [ ] **Run sequentially** (script handles sequencing):
  - `npx tsx backend/scripts/verify-site-profile.ts gunpost.ca`
  - ... and the other 9 (gotenda.com, g4cgunstore.com, bullseyenorth.com, ellwoodepps.com, truenortharms.com, marstar.ca, solelyoutdoors.com, canadasgunstore.ca, intersurplus.com)
- [ ] **Generate aggregate report** at `docs/site-verification/priority-10-2026-04-27.md` (markdown table: domain | overall verdict | failing checks)
- [ ] **DO NOT modify any siteProfile** based on results — record findings only. The user reviews, then later sessions act.

**Acceptance criteria:**
- File compiles (`tsc --noEmit` clean)
- 3 ground-truth sites: all 5 checks PASS
- Library entry `verifySiteProfile()` is callable from `health-monitor.ts` without further refactor (no `process.argv` reads, no `process.exit` calls inside the library function)
- Output JSON shape matches `VerificationResult` interface
- Sequential execution with 2s gap (visible in run timing)
- 10 priority-site reports written

---

## Task 2: Modify `pre-bootstrap` skill → `site-audit` skill (in-place)

**Owner:** `crawler-specialist`

**Files:**
- Modify: `.claude/skills/pre-bootstrap/SKILL.md` (in-place; keep at same path so existing `/pre-bootstrap` invocation continues to work)

**Why in-place modification (not new skill):** the playbook + 38 mistakes are already encoded; we are not rewriting them. We are reframing the OUTPUT (now: candidate siteProfile JSON for review) and adding ONE phase (Phase 2 — explicit API accessibility).

### Step 2.1: Read current SKILL.md fully (already done as required reading)

- [ ] **Re-read** to identify exact insertion points for the changes

### Step 2.2: Update front matter `description`

- [ ] **Change** the `description:` field from:
  - OLD: `"Automated site onboarding — runs probes, applies judgment, builds siteProfile, validates, and writes to DB"`
  - NEW: `"AI-driven per-site audit producing siteProfile JSON for operator review (NOT direct DB write)"`

### Step 2.3: Restructure phases section

- [ ] **Above the existing "9-Step Process" section, INSERT a new "6 Audit Phases" section** that maps the 9 mechanical steps to the 6 conceptual phases of the playbook:

```markdown
## 6 Audit Phases (conceptual; mapped to 9 mechanical steps below)

| Phase | Name | Mechanical steps used |
|---|---|---|
| 0 | Read existing profile + canonical URL | Step 1 (orchestrator preamble) |
| 1 | WAF probe + platform detection | Steps 1-2 (`probe-access`, `probe-platform`) |
| 2 | API accessibility (NEW explicit phase) | Step 2 sub-judgment + extra curl probes (see Phase 2 detail below) |
| 3 | Catalog URL discovery | Steps 3-4 (`probe-sitemap`, `probe-catalog-urls`) |
| 4 | Pagination detection | Step 9 (`probe-pagination`) |
| 5 | Sort param + watermark method | Step 8 (`probe-sort`) + watermark decision table |
| 6 | Coverage verification + multi-method count cross-check | Steps 6-7 + count cross-check (NEW) |

Output: candidate siteProfile JSON written to `docs/site-audit/<domain>-<timestamp>.json` PLUS a sibling `<domain>-<timestamp>-evidence.json` with per-phase raw evidence. **The skill does NOT write to DB.** The downstream `audit-review-pipeline.ts` (Task 3) gates the DB write.
```

### Step 2.4: Add explicit Phase 2 (API accessibility) detail

- [ ] **Insert a new section between current Step 2 and Step 3** (named "Phase 2 detail: API accessibility — explicit verification"):

```markdown
### Phase 2 detail: API accessibility — explicit verification (NEW)

After `probe-platform` reports `apiEndpointsReachable.*`, run ONE additional verification curl per API your judgment plans to use. This catches Mistake 33 (subagent fabricated 405 on internationalshootingsupplies WP REST API).

| API | Verification curl | Expect |
|---|---|---|
| WP REST | `curl -sI '<base>/wp-json/wp/v2/product?per_page=1'` | 200 + `x-wp-total` header (number) |
| WC Store API | `curl -sI '<base>/wp-json/wc/store/v1/products?per_page=1'` | 200 + `x-wp-total` header (number) |
| Shopify | `curl -s '<base>/products.json?limit=1'` | JSON with `products[]` array (length 0 or 1) |
| Shopify count | `curl -s '<base>/products/count.json'` | JSON with numeric `count` field |
| Ecwid | `curl -s -X POST '<storefrontApiBase>/catalog/search' -H 'Content-Type: application/json' -d '{"lang":"en","pagination":{"offset":0,"limit":1}}'` | JSON with numeric `totalProductsCount` |
| BigCommerce GraphQL | `curl -sI '<base>/graphql'` | 200 (we use sitemap for count, but accessibility flags the path) |

**Record in evidence:** for each API your skill plans to depend on, the verification status code + first 200 bytes of body. If verification fails, do NOT silently downgrade adapter — flag it as a Phase 2 hard fail and abort.

**Reason this is its own phase:** Phase 1 detects markers; Phase 2 confirms accessibility. The two were conflated in earlier rooms (Room 2 + Room 3 both produced count via overlapping methods — see spec §1.1). Separating them avoids the Mistake 33 fabrication trap and the api-vs-html count drift trap.
```

### Step 2.5: Update Step 9 (DB write) → "Output candidate JSON for review"

- [ ] **Replace** the current Step 9 ("Write to DB") code block with a candidate-JSON-output block:

```markdown
### Step 9: Output candidate JSON for review (NOT DB write)

The skill writes TWO files:

```bash
mkdir -p docs/site-audit
```

```javascript
const fs = require('fs');
const path = require('path');

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const domain = '<canonical-domain>';

fs.writeFileSync(
  path.join('docs', 'site-audit', `${domain}-${ts}.json`),
  JSON.stringify(profile, null, 2)
);

fs.writeFileSync(
  path.join('docs', 'site-audit', `${domain}-${ts}-evidence.json`),
  JSON.stringify(evidence, null, 2)
);

console.log(`Candidate profile written: docs/site-audit/${domain}-${ts}.json`);
console.log(`Run review pipeline:`);
console.log(`  npx tsx backend/scripts/audit-review-pipeline.ts docs/site-audit/${domain}-${ts}.json`);
```

**The skill terminates here.** DB writes happen ONLY after `audit-review-pipeline.ts` (Task 3) passes all 5 stages AND operator approves.
```

### Step 2.6: Update "Quick Validation Checklist" — add Phase 2 line

- [ ] **Insert** at the appropriate position in the checklist:
  - `- [ ] Each API endpoint your judgment plans to use was independently re-verified with one curl (Phase 2)`

### Step 2.7: Verification (Task 2 acceptance)

- [ ] **Diff the file** — confirm only the targeted sections changed (no incidental edits)
- [ ] **Verify the skill is still discoverable** — list with `find ~/.claude/skills -name SKILL.md` (we are working in `.claude/` not `~/.claude/`, so confirm by listing `.claude/skills/pre-bootstrap/`)
- [ ] **Manually invoke** the skill on `bullseyenorth.com` (Tier-1 ground truth, simplest — no WAF) and confirm it writes `docs/site-audit/bullseyenorth.com-<ts>.json` instead of writing to DB
- [ ] **DO NOT** delete `Step 9` content from earlier — it should be REPLACED, not appended

**Acceptance criteria:**
- Skill description reflects new intent
- 6-phase mapping section present at top of process
- Phase 2 (API accessibility) explicit verification section present with curl examples
- Step 9 outputs candidate JSON files only — no DB write
- One canary invocation on bullseyenorth.com produces JSON files in `docs/site-audit/` and does NOT touch DB
- All 38 Mistake references and platform trap tables retained verbatim

---

## Task 3: Build `audit-review-pipeline.ts` — 5-stage review orchestrator

**Owner:** `backend-engineer`

**Files:**
- Create: `backend/scripts/audit-review-pipeline.ts`
- Reuses: `backend/src/services/profile-validator.ts` (`validateSiteProfile`)
- Reuses: `backend/scripts/verify-site-profile.ts` (the library entry from Task 1)
- Reuses: `backend/src/services/scraper/adapters/*` for live walks
- Reuses: `backend/scripts/probe/shared/fetch.ts`

### Step 3.1: Define stage shape + result types

- [ ] **Write file header + types**

```ts
// backend/scripts/audit-review-pipeline.ts
/**
 * audit-review-pipeline — 5-stage review of an audit-skill-produced candidate profile.
 *
 * Stages (fail-stops; each must PASS before the next runs):
 *   1. Spec compliance check     (validateSiteProfile + Mistake-pattern programmatic check)
 *   2. Live walk test            (small N pages on each catalogUrl; ≥1 product per URL)
 *   3. Multi-method count        (API + sitemap + walk; pairwise within 10%)
 *   4. Operator review           (gates on --approve flag OR --prompt Y/N)
 *   5. Output review report      (JSON + markdown summary; gates on operator approval flag)
 *
 * CLI:
 *   npx tsx backend/scripts/audit-review-pipeline.ts <profile-json-path>
 *   npx tsx backend/scripts/audit-review-pipeline.ts <profile-json-path> --approve
 *   npx tsx backend/scripts/audit-review-pipeline.ts <profile-json-path> --prompt
 *
 * Exit codes:
 *   0 — all stages PASS (incl. operator approval)
 *   1 — Stage 1-3 FAIL (skill output not usable)
 *   2 — Stage 4 declined by operator
 *   3 — Stage 5 write-prep error
 */

export type StageVerdict = 'PASS' | 'FAIL';

export interface StageResult {
  stage: 1 | 2 | 3 | 4 | 5;
  name: string;
  verdict: StageVerdict;
  details: Record<string, unknown>;
  blockingErrors: string[];
}

export interface ReviewResult {
  profilePath: string;
  domain: string;
  timestamp: string;
  stages: StageResult[];
  overallVerdict: StageVerdict;
  approvedForDbWrite: boolean;
}
```

### Step 3.2: Implement Stage 1 — spec compliance

- [ ] **Load candidate profile JSON** from CLI arg
- [ ] **Call `validateSiteProfile(profile)`** from `backend/src/services/profile-validator.ts`
- [ ] **Programmatic Mistake-pattern check (additive on top of validator):**
  - If `platform: 'shopify'` AND profile uses `created_at` for date sort → FAIL with reason `mistake-32-use-published_at`
  - If `platform.includes('lightspeed-ecom')` AND `paginationPattern.type !== 'suffix-replace'` → FAIL `mistake-26-lightspeed-suffix-replace-required`
  - If `platform.includes('wix')` AND any catalogUrl contains a path segment beyond `/shop` → FAIL `mistake-27-wix-shop-only`
  - If `platform.includes('volusion')` AND no catalogUrl contains `searching=Y` → FAIL `mistake-24-volusion-searchingY-required`
  - If `wafType !== null` AND `hasWaf !== true` → FAIL `consistency-guard-wafType-vs-hasWaf`
  - If `crawlers.watermark.method === 'full-catalog-sweep'` AND no `crawlers.watermark.reason` → FAIL `method-c-requires-reason`
- [ ] **Return StageResult** with `verdict: 'PASS'` only when validator passes AND zero programmatic-check failures

### Step 3.3: Implement Stage 2 — live walk test

- [ ] **Pick small N = 3** (3 pages per catalogUrl; balances signal vs cost)
- [ ] **For each catalogUrl** — fetch page 1, 2, 3 via the adapter selected by `adapterType`; extract products
- [ ] **PASS criteria:**
  - Every URL returns ≥1 product on page 1
  - Page 2 differs from page 1 (matches `verify-site-profile.ts` Step 1.4 logic)
  - Page 3 either has products OR is the last page (perPage truncation OK)
- [ ] **Reuse** the `checkPaginationPattern` logic from Task 1 — import the function, do not duplicate
- [ ] **Sleep 2s between catalogUrls** (anti-ban)

### Step 3.4: Implement Stage 3 — multi-method count cross-check

- [ ] **Compute count via 3 methods (where available):**
  1. API (per `productCountMethod` in profile)
  2. Sitemap (filter `<loc>` to product pattern; reuse logic from `backend/scripts/probe/room3-geography-count/sitemap-parse.ts` IF salvageable, otherwise inline a small filter)
  3. Walk-only (sum of perPage × pages on first catalogUrl)
- [ ] **Pairwise drift check:** compute `|a - b| / max(a,b) × 100` for each pair (API-vs-sitemap, API-vs-walk, sitemap-vs-walk). Skip pairs where one source unavailable.
- [ ] **PASS:** every available pair drift ≤ 10%
- [ ] **FAIL:** any pair drift > 10%
- [ ] **Evidence:** `{ counts: { api?, sitemap?, walk? }, driftPairs: { 'api-sitemap'?: number, 'api-walk'?: number, 'sitemap-walk'?: number } }`

### Step 3.5: Implement Stage 4 — operator review gate

- [ ] **Print summary table** to console showing:
  - Profile JSON file path
  - Stage 1, 2, 3 verdicts + key evidence
  - Top-level profile fields: `platform`, `wafType`, `hasWaf`, `expectedProductCount`, `productCountMethod`, `catalogUrls.length`, `crawlers.watermark.method`
- [ ] **Three modes:**
  - **Default (no flag):** print summary, exit 0 with `approvedForDbWrite: false` — operator must re-run with `--approve`
  - **`--approve`:** non-interactive; if Stages 1-3 PASS → set `approvedForDbWrite: true`
  - **`--prompt`:** read one Y/N line from stdin (`readline.createInterface`); Y → approve, N → exit 2
- [ ] **Operator approval is captured in the result JSON** (audit trail)

### Step 3.6: Implement Stage 5 — output review report

- [ ] **Write** `docs/site-audit/<domain>-<ts>-review.json` (full ReviewResult)
- [ ] **Write** `docs/site-audit/<domain>-<ts>-review.md` (human-readable: stage table + per-stage details + final approval status + next-step pointer to `enable-new-site.ts`)

### Step 3.7: Verification (Task 3 acceptance)

- [ ] **Run on the candidate JSON** produced by Task 2's canary invocation (bullseyenorth.com):
  - `npx tsx backend/scripts/audit-review-pipeline.ts docs/site-audit/bullseyenorth.com-<ts>.json`
- [ ] **Expected:** Stages 1-3 PASS (bullseyenorth is a known-good ground-truth site); Stage 4 prints summary and exits without approval; review files written
- [ ] **Re-run with `--approve`:** confirm `approvedForDbWrite: true` in result JSON
- [ ] **`tsc --noEmit` clean**

**Acceptance criteria:**
- File compiles
- All 5 stages implemented as separate functions
- Stages run in order; first FAIL halts subsequent stages (fail-stop)
- bullseyenorth.com candidate produces PASS for Stages 1-3
- `--approve` and `--prompt` modes work correctly
- No DB writes from this script

---

## Task 4: Extend `health-monitor.ts` — watchdog

**Owner:** `backend-engineer`

**Files:**
- Modify: `backend/src/services/health-monitor.ts`
- Reuses: `backend/scripts/verify-site-profile.ts` (`verifySiteProfile` library entry)
- Reuses: `backend/src/lib/prisma.ts`
- Schema dependency: `SiteHealthCheck` model (already exists at `backend/prisma/schema.prisma:284-296`)

### Step 4.1: Read current health-monitor.ts fully

- [ ] **Read** `backend/src/services/health-monitor.ts` end-to-end
- [ ] **Confirm** the existing daily cron entry point (function name, where it's invoked from)
- [ ] **Confirm** the existing `SiteHealthCheck.create()` shape

### Step 4.2: Add `verifyAllSiteProfiles()` function

- [ ] **Append** (do not modify existing connectivity-check function):

```ts
import { verifySiteProfile, VerificationResult } from '../../scripts/verify-site-profile';

interface WatchdogResult {
  siteId: string;
  domain: string;
  verification: VerificationResult;
  consecutiveFailCount: number;  // queried from last 3 SiteHealthCheck rows
  shouldAlert: boolean;
}

export async function verifyAllSiteProfiles(): Promise<WatchdogResult[]> {
  const sites = await prisma.monitoredSite.findMany({
    where: { isEnabled: true },
    select: { id: true, domain: true, url: true, siteProfile: true },
  });

  const results: WatchdogResult[] = [];

  for (const site of sites) {
    if (!site.siteProfile) continue;  // sites without profile: skip (handled by onboarding flow)

    let verification: VerificationResult;
    try {
      verification = await verifySiteProfile({
        id: site.id,
        domain: site.domain,
        url: site.url,
        siteProfile: site.siteProfile,
      });
    } catch (err) {
      // Hard error — record as failure
      verification = {
        siteId: site.id,
        domain: site.domain,
        timestamp: new Date().toISOString(),
        durationMs: 0,
        overallVerdict: 'FAIL',
        checks: [],
        rawSiteProfile: site.siteProfile,
      };
    }

    // Persist to SiteHealthCheck
    await prisma.siteHealthCheck.create({
      data: {
        siteId: site.id,
        isReachable: verification.overallVerdict !== 'FAIL',
        canScrape: verification.overallVerdict === 'PASS',
        responseTimeMs: verification.durationMs,
        errorMessage: verification.overallVerdict === 'FAIL'
          ? JSON.stringify(verification.checks.filter(c => c.verdict === 'FAIL').map(c => ({ name: c.name, reason: c.reason })))
          : null,
      },
    });

    // Count consecutive failures from the last 3 checks
    const recent = await prisma.siteHealthCheck.findMany({
      where: { siteId: site.id },
      orderBy: { checkedAt: 'desc' },
      take: 3,
    });
    const consecutiveFailCount = recent.findIndex(r => r.canScrape) === -1
      ? recent.length
      : recent.findIndex(r => r.canScrape);

    const shouldAlert = consecutiveFailCount >= 3;

    results.push({ siteId: site.id, domain: site.domain, verification, consecutiveFailCount, shouldAlert });

    // Anti-ban delay
    await new Promise(r => setTimeout(r, 2000));
  }

  return results;
}
```

### Step 4.3: Wire alerts (3-strike rule)

- [ ] **Identify** how the existing daily cron emits alerts (search the codebase for existing alert emission — likely an admin-UI table or a Discord webhook stub)
- [ ] **For sites where `shouldAlert === true`:** insert a `DismissedIssue`-style row OR call the existing alert function with issueType `siteprofile_drift_3strikes` and `conditionSnapshot: JSON.stringify(verification.checks.filter(c => c.verdict === 'FAIL'))`
- [ ] **Re-surface logic:** the existing `dismissed_issues` table re-surfaces if `conditionSnapshot` changes. Reuse this; do not invent a new mechanism.
- [ ] **Log a suggestion line** to console: `Suggest: re-run /pre-bootstrap on <domain> (or load skill via Skill tool: pre-bootstrap)`

### Step 4.4: Wire the daily cron

- [ ] **Identify** the existing daily-cron invocation site (likely in `backend/src/server.ts` or a `worker.ts` BullMQ schedule)
- [ ] **Add** `verifyAllSiteProfiles()` invocation to that same schedule (after the existing connectivity check; the two are complementary)
- [ ] **Do NOT change** the cron frequency without operator approval

### Step 4.5: Verification (Task 4 acceptance)

- [ ] **Manual run** the function once with a node script:
  ```js
  // backend/scripts/_test-watchdog-once.js
  const { verifyAllSiteProfiles } = require('../src/services/health-monitor');
  verifyAllSiteProfiles().then(results => {
    console.log(`Verified ${results.length} sites; alerts: ${results.filter(r => r.shouldAlert).length}`);
  }).finally(() => process.exit(0));
  ```
- [ ] **Confirm** rows appear in `SiteHealthCheck` table for every enabled site
- [ ] **Confirm** no rows in `MonitoredSite` were modified (read-only watchdog)
- [ ] **Delete** the temp test script after validating
- [ ] **`tsc --noEmit` clean**

**Acceptance criteria:**
- `verifyAllSiteProfiles()` exported from `health-monitor.ts`
- Each enabled site gets one `SiteHealthCheck` row per run
- 3-consecutive-fail sites surface as alerts via existing mechanism
- Sequential execution with 2s gap between sites
- Watchdog is read-only — never modifies `siteProfile`, `hasWaf`, or any other site state

---

## Task 5: Build `enable-new-site.ts` — post-review insert + bootstrap

**Owner:** `backend-engineer`

**Files:**
- Create: `backend/scripts/enable-new-site.ts` (≤ 100 lines including comments — replaces 1055-line Room 5)
- Reuses: `backend/src/lib/prisma.ts`
- Reuses: `backend/src/services/catalog-crawler.ts` (existing T2-T4 — invoked once for bootstrap pass)
- Reuses: `backend/src/queue/*` (BullMQ — to enqueue one-shot crawl)

### Step 5.1: Define inputs + behavior

- [ ] **Write file header**:

```ts
// backend/scripts/enable-new-site.ts
/**
 * enable-new-site — post-review DB insert + one-shot bootstrap.
 *
 * Prereq: audit-review-pipeline.ts has approved the candidate profile.
 *
 * Steps:
 *   1. Load approved profile JSON
 *   2. INSERT MonitoredSite (isEnabled=false, hasWaf from profile, adapterType from profile)
 *   3. Enqueue ONE catalog-crawler pass via existing BullMQ queue
 *   4. Wait for completion (poll job status; max 10 min)
 *   5. Verify ProductIndex count ≥ 50% of expectedProductCount
 *   6. If PASS: flip isEnabled=true, log success
 *   7. If FAIL: leave disabled, surface to operator
 *
 * CLI:
 *   npx tsx backend/scripts/enable-new-site.ts <approved-profile-json-path>
 */
```

### Step 5.2: Implement INSERT

- [ ] **Load profile** from CLI arg
- [ ] **Verify the sibling `*-review.json` exists and contains `approvedForDbWrite: true`** — otherwise refuse to insert (`exit 4`)
- [ ] **Upsert MonitoredSite**:
  ```ts
  const site = await prisma.monitoredSite.upsert({
    where: { url: profile.canonicalUrl },
    update: { /* refuse update — this script is for NEW sites only */ },
    create: {
      domain: profile.canonicalDomain,
      name: profile.siteName,
      url: profile.canonicalUrl,
      siteType: profile.siteType ?? 'retailer',
      adapterType: profile.adapterType,
      hasWaf: profile.hasWaf,
      siteProfile: profile,
      isEnabled: false,  // gated until bootstrap verifies
      siteCategory: profile.siteCategory ?? 'retailer',
    },
  });
  ```
  - If a row already exists for the URL → exit non-zero with message `Site exists; use existing audit-update flow`

### Step 5.3: Enqueue one bootstrap crawl pass

- [ ] **Find** the existing BullMQ queue used by `crawl-scheduler.ts` (likely `backend/src/queue/queues.ts` — search for `Queue('crawl-catalog')` or similar)
- [ ] **Enqueue** ONE job for the new site with high priority (`{ siteId: site.id, mode: 'bootstrap' }`)
- [ ] **DO NOT** invoke `catalog-crawler.ts` directly — go through the queue so the same instrumentation/budget applies

### Step 5.4: Poll for completion + verify

- [ ] **Poll `prisma.crawlJob.findFirst({ where: { siteId, ... }, orderBy: { createdAt: 'desc' }})`** every 30s, max 20 iterations (10 min timeout)
- [ ] **After completion:** count `prisma.productIndex.count({ where: { siteId } })`
- [ ] **PASS:** count ≥ 50% of `profile.expectedProductCount` AND no errors in job
- [ ] **PASS action:** `prisma.monitoredSite.update({ where: { id }, data: { isEnabled: true } })`; print success
- [ ] **FAIL action:** print failure summary; leave `isEnabled: false`; do NOT delete the site row (operator inspects)

### Step 5.5: Verification (Task 5 acceptance)

- [ ] **DO NOT actually insert a real site during plan-implementation** (would require live operator approval)
- [ ] **Dry-run mode:** add a `--dry-run` flag that does Step 5.2 logic but rolls back via a Prisma transaction (insert + rollback) and skips Step 5.3+
- [ ] **Run dry-run** against the bullseyenorth.com candidate JSON: `npx tsx backend/scripts/enable-new-site.ts docs/site-audit/bullseyenorth.com-<ts>.json --dry-run`
- [ ] **Expected:** prints "Dry-run: would insert MonitoredSite { domain: 'bullseyenorth.com', ... }" and rolls back
- [ ] **`tsc --noEmit` clean**

**Acceptance criteria:**
- File ≤ 100 lines (excluding comment headers)
- Refuses to run unless sibling `*-review.json` shows `approvedForDbWrite: true`
- `--dry-run` mode works without persisting
- Real insert path uses upsert with NEW-only semantics (refuses to update)
- ProductIndex check uses 50% threshold of expectedProductCount

---

## Task 6: Salvage + cleanup checkpoint (DOCUMENT ONLY — no commits)

**Owner:** `crawler-specialist`

**Files:**
- Create: `backend/scripts/probe/room3-geography-count/_DEPRECATED.md`
- Create: `backend/scripts/probe/room4-navigation/_DEPRECATED.md`
- Create: `backend/scripts/probe/room5-bootstrap/_DEPRECATED.md`
- Document (do NOT execute): planned commit splits for the user to authorize later

### Step 6.1: Write `_DEPRECATED.md` files

- [ ] **`backend/scripts/probe/room3-geography-count/_DEPRECATED.md`** content:

```markdown
# DEPRECATED — Generic Catalog/Sitemap/Count Discovery (Round 1-4)

**Status as of 2026-04-27:** these modules are kept as historical reference for the AI audit skill.

**Files in this directory:**
- `catalog-urls.ts`, `sitemap-products.ts`, `sitemap-parse.ts`, `select-catalog-set.ts`, `walk-verify.ts`, `global-count.ts`, `pagination-detect.ts`

**Why deprecated:** generic discovery code = per-platform code wearing a generic costume. Net value = 0. The pivot (2026-04-27) replaced this with AI-driven per-site audit. See `docs/superpowers/plans/2026-04-27-pivot-to-ai-audit.md`.

**Do NOT import from this folder in new code.** The pre-bootstrap skill at `.claude/skills/pre-bootstrap/SKILL.md` is the new entry point.

**Why not deleted:** the 18 platform detectors in `backend/scripts/probe/room2-access-identity/detectors/` and the shared utilities under `backend/scripts/probe/shared/` are STILL USED. This DEPRECATED note is scoped to this folder only.
```

- [ ] **Create the analogous file** for `room4-navigation/` (mention `sort-detect.ts`, `watermark-method.ts`)
- [ ] **Create the analogous file** for `room5-bootstrap/` (mention `index-products.ts`, `walk-strategies.ts`, `strategy-dispatch.ts`, `detail-enrich.ts` — note 1055-line Room 5 superseded by ~100-line `enable-new-site.ts`)

### Step 6.2: Add header comment to each `.ts` file in those folders

- [ ] **For each `.ts` file** in the three deprecated folders, prepend a header comment:

```ts
/**
 * @deprecated 2026-04-27 — Generic discovery superseded by AI-driven per-site audit.
 * See `_DEPRECATED.md` in this folder and `docs/superpowers/plans/2026-04-27-pivot-to-ai-audit.md`.
 * Do not import from this file in new code.
 */
```

- [ ] **Use the Edit tool** for each file (one tool call each — these are small additive prepends)
- [ ] **Verify `tsc --noEmit` still clean** after all comments added (comments do not affect compilation, but check anyway)

### Step 6.3: Document planned commit splits (for user to authorize later)

- [ ] **Write a section in this plan's session handoff** (NOT in this plan; in the per-session handoff file produced at session end) listing the recommended commit splits:

  **Commit A (KEEP — proven Rounds 1-4 wins):**
  - `backend/scripts/probe/room1-intake/`
  - `backend/scripts/probe/room2-access-identity/` (canonical-host, waf-detect, waf-heavy-probe, platform-detect, all 18 detectors)
  - `backend/scripts/probe/shared/` (fetch.ts with HPE_HEADER_OVERFLOW fix, redis-cookies, ua, url-utils, extract, types)
  - `backend/scripts/probe/__test__/` (compare-vs-siteprofile.ts, run-3-sites.sh, run-4-sites.sh, run-all-5.sh)
  - `backend/scripts/pre-bootstrap.ts` (the orchestrator written in Round 1-4)
  - Memory rules added this session

  **Commit B (DEPRECATE — historical):**
  - All `_DEPRECATED.md` files
  - All `@deprecated` header comments in room3/4/5 .ts files

  **Commit C (PIVOT — new infrastructure):**
  - `backend/scripts/verify-site-profile.ts` (Task 1)
  - `.claude/skills/pre-bootstrap/SKILL.md` modifications (Task 2)
  - `backend/scripts/audit-review-pipeline.ts` (Task 3)
  - `backend/src/services/health-monitor.ts` modifications (Task 4)
  - `backend/scripts/enable-new-site.ts` (Task 5)
  - `docs/site-audit-runbook.md` (Task 8)
  - `docs/superpowers/plans/2026-04-27-pivot-to-ai-audit.md` (this plan)
  - `docs/session-handoffs/HANDOFF-TEMPLATE.md` (created by this overseer)

- [ ] **DO NOT execute** any `git commit` — the user authorizes commits

### Step 6.4: Verification (Task 6 acceptance)

- [ ] **Three `_DEPRECATED.md` files exist** with the documented content
- [ ] **Every `.ts` file in those folders has the `@deprecated` header**
- [ ] **`tsc --noEmit` clean in `backend/`**
- [ ] **No git commits made**

**Acceptance criteria:**
- Three `_DEPRECATED.md` files written
- All `.ts` files in deprecated folders carry the `@deprecated` JSDoc tag
- Commit split documented in session handoff (NOT in this plan; in the dated handoff file)
- Zero commits

---

## Task 7: Run watchdog once on all 60 enabled sites

**Owner:** `crawler-specialist`

**Files:**
- Generate: `docs/site-verification/baseline-2026-04-27.md`
- Reuses: `backend/scripts/verify-site-profile.ts --all` (from Task 1)

### Step 7.1: Pre-flight

- [ ] **Confirm Tasks 1-4 are complete** (this task depends on them)
- [ ] **Confirm DB connection works** (`cd backend && npx prisma studio` opens; close it after verifying)

### Step 7.2: Run

- [ ] **Execute** the `--all` mode:
  ```bash
  cd backend && npx tsx scripts/verify-site-profile.ts --all 2>&1 | tee ../docs/site-verification/_run-2026-04-27.log
  ```
- [ ] **Expected duration:** ~60 sites × ~30s/site = ~30 min (sequential with 2s gap; some sites may be Playwright + slow)

### Step 7.3: Aggregate report

- [ ] **Write** `docs/site-verification/baseline-2026-04-27.md` with:
  - Run timestamp + duration
  - Total sites checked
  - Pass/Warn/Fail counts
  - **Per-site table** (3 columns: domain | overall verdict | failing checks)
  - **Sorted:** FAIL first, WARN second, PASS last
  - **Footer:** "Re-audit candidates" section listing every FAIL site with the recommended next action (`Run /pre-bootstrap on <domain>`)
- [ ] **Reference** the per-site JSON files in `docs/site-verification/<domain>-*.json` so operators can drill in

### Step 7.4: Verification (Task 7 acceptance)

- [ ] **Baseline report file exists** with at least 60 rows
- [ ] **JSON file count** in `docs/site-verification/` increased by ~60
- [ ] **DO NOT** modify any siteProfile based on findings — record only

**Acceptance criteria:**
- 60 sites verified (one row per enabled site)
- Baseline markdown report has FAIL→WARN→PASS sort
- Operator-action recommendations included for every FAIL
- Zero `MonitoredSite` rows modified

---

## Task 8: Production rollout document

**Owner:** `backend-engineer`

**Files:**
- Create: `docs/site-audit-runbook.md`

### Step 8.1: Write operator runbook

- [ ] **Sections required (every section has concrete commands):**

```markdown
# Site Audit Runbook (Operator)

## When to use this runbook
- Onboarding a new site (Section 2)
- Watchdog alert triggered for an existing site (Section 3)
- Periodic verification of a known-good site (Section 4)

## Section 1: Prerequisites
- Working directory: `d:/VScode/Projects/firearm-alert`
- Node 20 + tsx available
- Backend `.env` populated (DB + Redis URLs)
- DB reachable: `cd backend && npx prisma studio`

## Section 2: Onboard a new site (5 stages)

### 2.1 Run the audit skill
Invoke via Claude Code:
> /pre-bootstrap https://newsite.example.ca

The skill writes:
- `docs/site-audit/<domain>-<ts>.json` (candidate profile)
- `docs/site-audit/<domain>-<ts>-evidence.json` (raw evidence)

### 2.2 Run the review pipeline
```bash
npx tsx backend/scripts/audit-review-pipeline.ts docs/site-audit/<domain>-<ts>.json
```
Expected: Stages 1-3 PASS, Stage 4 prints summary, exits awaiting approval.

### 2.3 Operator review (in admin UI OR via JSON inspection)
Inspect:
- `docs/site-audit/<domain>-<ts>.json` (candidate profile)
- `docs/site-audit/<domain>-<ts>-review.md` (stage results)
- `docs/site-audit/<domain>-<ts>-evidence.json` (raw evidence)

### 2.4 Approve
```bash
npx tsx backend/scripts/audit-review-pipeline.ts docs/site-audit/<domain>-<ts>.json --approve
```
Sets `approvedForDbWrite: true` in the review JSON.

### 2.5 Insert + bootstrap
```bash
npx tsx backend/scripts/enable-new-site.ts docs/site-audit/<domain>-<ts>.json
```
Inserts MonitoredSite (isEnabled=false), enqueues bootstrap crawl, waits ≤10 min, verifies ProductIndex ≥ 50% of expectedProductCount, flips isEnabled=true on success.

## Section 3: Handle a watchdog alert

### 3.1 Identify the failing site
Watchdog logs are in:
- `SiteHealthCheck` table (DB) — last 3 rows per site
- `dismissed_issues` table — issueType `siteprofile_drift_3strikes`

### 3.2 Verify with one-off run
```bash
npx tsx backend/scripts/verify-site-profile.ts <domain>
```
Inspect output JSON — which check FAILED?

### 3.3 Re-audit
> /pre-bootstrap <url>

Re-runs the full audit. Compare new candidate JSON to current DB siteProfile.

### 3.4 Update via review pipeline
Same as Section 2.2-2.4. NOTE: `enable-new-site.ts` REFUSES to update existing sites; for updates, run a small script (TODO: build `update-existing-site.ts` if/when needed — until then, manually update via Prisma Studio after operator review).

## Section 4: Periodic verification
The watchdog auto-runs daily via `health-monitor.ts`. To force a manual run:
```bash
cd backend && npx tsx -e "require('./src/services/health-monitor').verifyAllSiteProfiles().then(r => console.log(r.length))"
```
Or to verify one site:
```bash
npx tsx backend/scripts/verify-site-profile.ts <domain>
```

## Section 5: Troubleshooting

### "Skill output disagrees with stored siteProfile"
The stored profile is the answer key (`feedback_per_room_ground_truth.md`). DO NOT modify the DB siteProfile to match the skill output. First investigate:
1. Did the site change? (check news, recent commits, vendor updates)
2. Did the skill make an error? (re-read evidence files)
3. Did Phase 2 verification fail? (run the curls manually)

### "Audit pipeline Stage 3 FAILED on count drift > 10%"
Likely causes:
- Stale stored count (`expectedProductCount` not re-derived this audit)
- Sitemap regen lag on classifieds (use pagination-walk method)
- Sub-category tile trap (Mistake 38 — walk deeper)

### "enable-new-site.ts says ProductIndex count < 50% expected"
The bootstrap pass under-collected. Inspect:
- BullMQ job logs (`crawl-jobs` table)
- The first catalogUrl walk results (which categories returned 0?)
- Whether WAF cookies were obtained (check `waf-cookie-manager` logs)

Do NOT flip `isEnabled=true` manually until the gap is understood.
```

### Step 8.2: Verification (Task 8 acceptance)

- [ ] **File exists** at `docs/site-audit-runbook.md`
- [ ] **Every section has at least one concrete command** (no "TBD")
- [ ] **Cross-references** to relevant skill files + memory rules

**Acceptance criteria:**
- File written
- All 5 sections present
- Onboarding workflow + alert-handling workflow + troubleshooting all concrete

---

## Self-Review (Overseer's checklist after writing this plan)

### Spec coverage check (against the user's pivot prompt)

| User requirement | Plan task |
|---|---|
| Build `verify-site-profile.ts` (live verifier, doubles as watchdog) | Task 1 |
| Modify `pre-bootstrap` skill in-place + add Phase 2 (API accessibility) | Task 2 |
| Build `audit-review-pipeline.ts` (5-stage, fail-stops) | Task 3 |
| Extend `health-monitor.ts` watchdog (3-strike alert) | Task 4 |
| Build `enable-new-site.ts` (~50-100 lines, replaces Room 5) | Task 5 |
| Salvage Rounds 1-4 — KEEP rooms 1+2+shared, DEPRECATE room 3-5 | Task 6 |
| Run watchdog once on 60 sites for baseline | Task 7 |
| Production runbook | Task 8 |
| 3-role agent harness documented | "How to Resume" section + memory rule (separate file) |
| Session handoff template | Separate file (`docs/session-handoffs/HANDOFF-TEMPLATE.md`) |
| Memory rule for the harness pattern | Separate file (`feedback_agent_harness_pattern.md` + MEMORY.md update) |
| 6 phases of the audit | "Pivot Context" section + Task 2 Step 2.3 |
| 5-stage review pipeline | Task 3 |
| 3 flows (NEW/EXISTING/WATCHDOG) | "Pivot Context" section table |
| Production crawler unchanged | "Pivot Context" + explicit non-modification in tasks |
| No commits | Task 6 Step 6.3 + plan-wide rule in "How to Resume" |
| No siteProfile modification | "How to Resume" + Task 1 Step 1.10 + Task 7 Step 7.4 |
| No site-specific code branches | Acceptance criteria across tasks |
| writing-plans skill invoked | Done at start of overseer session |

### Placeholder scan
Searched for: TBD, TODO, "implement later", "fill in details", "Add appropriate error handling", "similar to". One TODO survives intentionally: Section 3.4 of the runbook says `update-existing-site.ts` is a future build — this is a documented future-work pointer (legitimate scope deferral), not a hidden requirement.

### Type/file path consistency
- `verifySiteProfile()` library entry from Task 1 is imported in Task 4 — same name, same module
- `audit-review-pipeline.ts` reuses `checkPaginationPattern` from `verify-site-profile.ts` — Task 3 Step 3.3 explicitly says "import the function, do not duplicate"
- `enable-new-site.ts` reads the sibling `*-review.json` produced by Task 3 — paths consistent
- All paths use forward slashes; absolute paths use `d:/VScode/Projects/firearm-alert/...`

### Risks acknowledged (not blocking)
- Task 4 watchdog cron wiring needs the existing daily cron entry point identified by reading the codebase — Step 4.4 says "search the codebase for existing alert emission" rather than naming the file (we don't yet know if it's in `server.ts` vs `worker.ts`)
- Task 5 Step 5.4 BullMQ queue name needs identification at implementation time
- Task 7 baseline run is ~30 min wall-clock — if the session times out, restart-friendly via the JSON-per-site output

### What I would change with a fresh look
- Tasks 1-5 could in principle be parallelized after Task 1 (others depend on Task 1's library entry). The 3-role harness pattern means each task already runs in its own subagent dispatch — sequential execution by the orchestrator is the safer default given the user's "don't cut corners" mandate.

---

## First-Task Pointer (ready to dispatch)

**Next action for the orchestrator after this plan is reviewed:**

Dispatch a `crawler-specialist` subagent (loaded with `.claude/agents/crawler-specialist.md` content per CLAUDE.md mandatory rule) for **Task 1: Build `verify-site-profile.ts`**.

Subagent prompt MUST include:
1. The full text of Task 1 (Steps 1.1–1.10) from this plan
2. The persona file content
3. The acceptance criteria
4. The note: "DO NOT commit. DO NOT modify any DB siteProfile. Return your diff + the verification output from running on canadafirstammo.ca, aagcanada.ca, theammosource.com."

After implementer returns, orchestrator dispatches:
- `code-reviewer` agent (loaded with `.claude/agents/code-reviewer.md`) — Stage 1 review
- `general-purpose` agent — Stage 2 spec-compliance review against Task 1 acceptance criteria

When both reviewers PASS → orchestrator checks the Task 1 boxes here AND writes a session handoff at `docs/session-handoffs/<date>-end-of-session.md` per the template.

---

**End of plan.**
