---
name: pre-bootstrap-plan
description: Architecture plan for the pre-bootstrap site onboarding system — script + skill + validation gate
type: project
---

## Goal
Build a **pre-bootstrap process** that takes a site from URL → fully profiled → ready for bootstrap crawl. The process outputs a **site profile** as the single source of truth. All downstream operations (watermark T1, catalog T2-4, notifications, product processing) consume this profile.

## Design principles (user-defined, non-negotiable)
1. **Generic** — works across projects, not just firearms monitoring
2. **Not domain-specific** — no hardcoded firearm/gun/ammo keywords
3. **No hardcoding** — all site-specific info goes into the profile, never into code
4. **Standalone and decoupled** — constructor that outputs a site profile. No dependency on upstream (how URL was discovered) or downstream (how profile is consumed)
5. **Profile schema versioned** — `profileVersion: number` for migrations
6. **Confidence scored per field** — `verified` / `inferred` / `default` + `verifiedAt` timestamp
7. **Re-audit triggerable** — consecutive failures, count drift, WAF change → flag for re-probe
8. **Error taxonomy** — `transient` / `waf-escalation` / `platform-change` / `configuration-drift`
9. **Validation gated** — profile must pass completeness check before entering bootstrap

## Architecture: Script + Skill + Validation Gate

### Component 1: Script (`backend/scripts/pre-bootstrap-probe.ts`)
**~500 lines. Mechanical probes, outputs JSON report. CI-runnable. No AI needed.**

What it does:
- Canonical host resolution (redirect chain)
- Heavy 8-batch WAF probe (shells out to `heavy-waf-probe.sh`)
- Platform marker grep (~20 known patterns from homepage HTML)
- API endpoint probing (WP REST, Store API, `/products.json`, GraphQL, sitemap)
- Sort `<select>` HTML extraction (parse all `<option>` values)
- Pagination pattern detection (fetch page 1 vs page 2, compare products)
- Product count via platform API or sitemap
- Robots.txt crawl-delay parsing
- JS overlay detection (Searchspring, Klevu, FastSimon script tag grep)
- Rendering mode classification (static HTML vs server-rendered JS vs SPA)
- Rate limit calibration burst

**Output**: structured JSON report with raw evidence per phase.

**Also useful for regression**: re-run against all 65+ sites to detect profile drift.

### Component 2: Skill (`.claude/skills/pre-bootstrap/SKILL.md`)
**Claude Code skill invoked as `/pre-bootstrap <url>`. Judgment layer.**

What it does:
- Invokes the script as first step → gets JSON probe report
- Makes judgment calls the script can't:
  - CatalogUrl minimum-overlap when parent-child inclusion varies by theme
  - Adapter selection for ambiguous platforms (Ecwid-on-WordPress)
  - SPA API discovery via Playwright UI-drive (capture real XHR field names)
  - Sort verification on custom-PHP/legacy sites with no `<select>`
  - Interpreting ambiguous WAF results
  - Fallback path tracing (Mistake 34)
- Writes final siteProfile to DB after validation
- References the 35 playbook mistakes as decision rules

For known platforms (WooCommerce, Shopify, BC Stencil), the script produces a near-complete profile that the skill only validates. For unknown platforms/SPAs, the skill does the investigative work.

### Component 3: Validation Gate (`backend/src/services/profile-validator.ts`)
**~50 lines. Function that reads siteProfile → returns pass/fail with specific gaps.**

Checks:
- All required fields present (platform, hasWaf, expectedProductCount, catalogUrls, sortParam or explicit full-catalog-sweep, paginationPattern, perPage, watermark method, adapter type)
- catalogUrls non-empty
- Sort verified (or explicitly marked `full-catalog-sweep` with reason)
- Pagination tested (paginationVerified or paginationPattern present)
- Product count recorded and > 0
- Adapter selected and tested
- `profileVersion` matches current schema

Prevents partially-complete profiles from entering production.

## The 7-Phase Process

### Phase 1: Access & Security
- Canonical host resolution
- Heavy 8-batch WAF probe
- Working HTTP method (axios vs Playwright) + required UA
- Robots.txt crawl-delay + disallowed paths
- **Output**: `canonicalUrl`, `hasWaf`, `wafType`, `userAgentOverride`, `crawlDelay`

### Phase 2: Platform & Rendering
- Grep homepage for ALL platform markers
- Grep for JS overlay scripts (Searchspring/Klevu/Algolia/FastSimon/Ecwid)
- Classify rendering: static HTML / server-rendered+JS / full SPA
- Probe platform-specific APIs (WP REST, Store API, Shopify /products.json, BC GraphQL, sitemap)
- If SPA → Playwright mandatory for phases 4-6
- Bilingual/multilingual detection (WPML, Polylang, `/en/` prefix)
- **Output**: `platform`, `jsOverlay`, `renderingMode`, `availableApis[]`, `needsPlaywright`, `multilingual`

### Phase 3: Adapter Selection & Testing
- Select adapter based on platform + APIs + rendering mode
- Run `extractCatalogProducts()` against one live page → verify non-zero
- Determine primary crawl method + fallback method
- **Simulate fallback trigger** — verify it actually fires (Mistake 34)
- Product data field inventory: what's available? (price, stock, thumbnail, date/postDate, sourceId)
- **Output**: `adapterType`, `primaryMethod`, `fallbackMethod`, `fallbackVerified`, `availableFields[]`

### Phase 4: Catalog Discovery
- Product count (API / sitemap / walk)
- Enumerate ALL categories (API taxonomy, sitemap, nav HTML)
- Parent-child inclusion test (does parent show child products?)
- Build minimum-overlap set → 100% coverage (NEVER drop categories for being "too small")
- Per-catalogUrl extraction verification
- **Output**: `catalogUrls[]`, `expectedProductCount`, `categoryStats{}`

### Phase 5: Sort Verification
- Read `<select>` HTML (or drive SPA dropdown via Playwright)
- ID-jump test with counter-control per catalogUrl (3-outcome: honored / honored-default-is-newest / noop-small)
- Platform-specific traps:
  - OpenCart: hidden sort columns (Mistake 21)
  - Magento: merchant-customized values (Mistake 20)
  - Volusion: `searching=Y` required (Mistake 24)
  - Searchspring: hash-fragment sort (Mistake 25)
  - Shopify: sorts by `published_at` not `created_at` (Mistake 32)
- If no sort UI: cross-reference DOM order vs independent newest signal (Mistake 15/18)
- **Output**: `sortParam`, `sortVerified`, `watermarkMethod`

### Phase 6: Pagination Verification
- Page 1 vs page 2 zero-overlap test
- Pattern determination (query/path/suffix-replace/api-offset)
- Platform-specific traps:
  - LightSpeed: `?page=N` silently ignored, only `pageN.html` works (Mistake 26)
  - LightSpeed + sortParam: suffix-replace match must anchor on sort segment (Mistake 26)
  - Wix: sub-category pagination leaks to global `/shop` (Mistake 27)
- Walk to last page → confirm total matches count
- Test WITH sort param applied
- **Output**: `paginationPattern`, `perPage`, `totalPages`, `paginationVerified`

### Phase 7: Assembly & Validation Gate
- Assemble all outputs → siteProfile JSON with `profileVersion` + per-field confidence
- Run validation gate
- If fails → list specific gaps for manual investigation
- **Output**: complete validated siteProfile

## Build order (for next session)

### Priority 1: The script (`pre-bootstrap-probe.ts`)
~500 lines. Covers phases 1-2 fully + partial 3-6 (mechanical probes only). Immediate value: run on any URL, get structured JSON report. Reusable across projects.

### Priority 2: The skill (`.claude/skills/pre-bootstrap/SKILL.md`)
References the script. Adds judgment. Encodes 35 playbook mistakes as decision rules. Invoked as `/pre-bootstrap <url>`.

### Priority 3: The validation gate (`profile-validator.ts`)
~50 lines. Prevents bad profiles from entering production.

## Gaps identified vs user's original 6 steps
1. **API availability probing** — missing from original steps, added to Phase 2
2. **JS overlay / SPA detection** — missing, added to Phase 2
3. **Rendering mode classification** — missing, added to Phase 2
4. **Rate limit / budget calibration** — missing, added to Phase 1
5. **Fallback path verification** — missing, added to Phase 3 (Mistake 34)
6. **Product data field inventory** — missing, added to Phase 3
7. **Bilingual / multilingual handling** — missing, added to Phase 2

## Gaps identified vs user's original design principles
1. **Profile schema versioning** — `profileVersion` field for migrations
2. **Confidence scoring per field** — `verified` / `inferred` / `default`
3. **Re-audit triggers** — failure count, drift, WAF change → flag re-probe
4. **Error taxonomy** — transient / waf-escalation / platform-change / configuration-drift
5. **Profile validation gate** — completeness check before bootstrap

## Cross-references
- `.claude/catalog-url-discovery-playbook.md` — the manual 7-phase process + 35 mistakes this formalizes
- `.claude/agents/crawler-specialist.md` — accumulated lessons from 65+ audits
- `project_api_fallback_gap.md` — Mistake 34 (apiCrawlUsed prevents HTML fallback)
- `project_future_tasks.md` — deferred tasks (Store-API-only path, TownPost adapter, LightSpeed selector)
- `~/.claude/CLAUDE.md` — global principles ("Trace flows, not layers", "Never describe a fallback without verifying the trigger")
