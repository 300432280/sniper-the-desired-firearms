# Release Plan: Crawler Architecture Redesign — Bootstrap/Maintain Two-Phase System

**Date:** 2026-03-28
**Status:** APPROVED — Ready for implementation
**Priority:** CRITICAL — Architectural redesign

## Context
The current crawler crawls LISTING PAGES only. This causes: dead products staying in DB forever, changed URLs creating duplicates, data from listing cards (truncated titles, missing prices), and T1 watermark failing on 35+ sites. The new design: Bootstrap phase indexes via listing pages, then Maintain phase verifies FROM THE DB by visiting each product's detail page.

## Rules
- Use proper agents to deploy — be efficient and effective
- Verify before claim — no assumptions
- Push current code as backup BEFORE making changes

---

## Phase 1: Foundation (Schema + Core Module)

### 1.1 Backup current code
- `git add -A && git commit -m "backup: pre-redesign snapshot"`
- `git push`

### 1.2 Schema changes (`backend/prisma/schema.prisma`)
- Add to MonitoredSite:
  - `crawlPhase String @default("bootstrap")` — "bootstrap" | "maintain"
  - `bootstrapStartedAt DateTime?`
  - `bootstrapCompletedAt DateTime?`
- Add to ProductIndex:
  - `verifyErrors Int @default(0)` — consecutive verification errors, after 5 → mark deleted
  - `@@index([siteId, isActive, lastSeenAt])` — for T2-T4 maintain queries
- Run: `prisma db push` + `prisma generate`

### 1.3 Create `backend/src/services/product-verifier.ts` (NEW)
Core module. Visits a single product detail page URL and extracts current data.

```typescript
interface VerifyProductResult {
  status: 'alive' | 'sold' | 'wanted' | 'deleted' | 'error';
  title?: string;
  price?: number;
  regularPrice?: number;
  stockStatus?: 'in_stock' | 'out_of_stock';
  thumbnail?: string;
  responseTimeMs: number;
  statusCode?: number;
  errorMessage?: string;
}

async function verifyProduct(params: {
  url: string; domain: string; hasWaf?: boolean;
}): Promise<VerifyProductResult>
```

Extraction strategy (layered):
1. JSON-LD / Schema.org `<script type="application/ld+json">` — covers ~80% of sites
2. Open Graph meta tags (`og:title`, `og:image`, `product:price:amount`)
3. HTML selectors (`h1`, `[itemprop="name"]`, `.price`, stock indicators)
4. Reuse base.ts helpers (`extractPrice`, `extractThumbnail`)
5. Playwright fallback for WAF/JS-rendered sites

Status detection:
- HTTP 404/410 → `deleted`
- Soft-404 (200 with "not found" in h1) → `deleted`
- Sold indicators → `sold`
- Wanted indicators → `wanted`
- Otherwise → `alive` with extracted data

---

## Phase 2: Worker + Scheduler

### 2.1 Add `processVerifyCrawl()` to `backend/src/services/worker.ts`
New job processor for `crawl-verify` jobs:
- Receives batch of product IDs
- For each: call `verifyProduct()` → update DB
- Result handling:
  - `alive` → update title, price, stock, thumbnail, lastSeenAt, reset verifyErrors=0
  - `sold` → set stockStatus='out_of_stock', keep isActive=true, set staleSince
  - `wanted` → set category='wanted'
  - `deleted` → set isActive=false (PRESERVE all last known data for reporting)
  - `error` → increment verifyErrors. After 5 consecutive → mark as deleted

### 2.2 Modify `backend/src/services/crawl-scheduler.ts`
Phase-aware scheduling:
- `site.crawlPhase === 'bootstrap'` → current listing-page approach (unchanged)
- `site.crawlPhase === 'maintain'` → query DB products → queue `crawl-verify` jobs

New `queueMaintainVerification()`:
- T2: lastSeenAt 1-7 days ago, share=42.5%
- T3: lastSeenAt 8-20 days ago, share=32.5%
- T4: lastSeenAt 21+ days ago, share=25%
- T1 gets priority, T2-T4 share ALL remaining budget
- Remainder tokens (can't divide evenly) go to T2
- No cooldowns — always working, limited only by budget

New `checkBootstrapComplete()`:
- All streams × all tiers have `lastCycleCompletedAt` → auto-transition
- **CRITICAL**: Compare DB count vs live count. If significantly lower, extend bootstrap.
- On transition: `crawlPhase='maintain'`, `bootstrapCompletedAt=now()`, clear `streamState`

### 2.3 Modify `backend/src/services/token-budget.ts`
- New `allocateMaintainTokens()` — T1 priority, T2-T4 share remainder
- No cooldown gating on token release

### 2.4 Modify `backend/src/services/crawl-tuning.ts`
- Remove cooldown configs (t2CooldownHrs, t3CooldownHrs, t4CooldownHrs)
- T2-T4 run continuously in BOTH phases, limited only by budget
- Add: `maintainT2MinDays: 1, maintainT2MaxDays: 7, maintainT3MinDays: 8, maintainT3MaxDays: 20, maintainT4MinDays: 21, maintainT4MaxDays: null`

---

## Phase 3: T1 Sort URL Fixes

### 3.1 Fix `getNewArrivalsUrls()` in adapters

**THIS IS THE KEY OF THE ENTIRE STRUCTURE.** T1 MUST reliably catch ALL new listings on ALL sites.

| Platform | Sort Parameter | File |
|----------|---------------|------|
| Shopify | `sort_by=created-descending` | adapters/shopify.ts (already correct) |
| WooCommerce | `orderby=date` REST API | adapters/woocommerce.ts (already correct) |
| BigCommerce | `?sort=newest` | adapters/generic-retail.ts |
| Magento | `?product_list_order=created_at&product_list_dir=desc` | adapters/generic-retail.ts |
| Lightspeed | `?sort=newest` | adapters/generic-retail.ts |
| ColdFusion | `?sort=new-arrivals` | adapters/generic-retail.ts |
| Klevu | `sort=NEW_ARRIVAL` | adapters/generic-retail.ts (already correct) |
| Gunpost | `sort_by=date_pub` | adapters/classifieds-gunpost.ts (already correct) |

---

## Phase 4: Migration + Cleanup

### 4.1 Migration script
- Check each enabled site: if all streams × tiers completed → `crawlPhase='maintain'`
- Sites that haven't completed bootstrap stay in bootstrap

### 4.2 Cleanup
- Remove cooldown logic from catalog-crawler.ts
- Remove page-range partitioning code that conflicts with new structure
- Ensure old structure does NOT interfere with new structure
- Guard stale-detector to skip maintain-phase sites
- Keep stream-detector.ts, stream-priority.ts for bootstrap (new sites always start in bootstrap)

### 4.3 Update documentation
- README.md: new architecture section (bootstrap/maintain phases)
- Remove outdated sections about stream/tier partitioning, cooldowns
- Update investigate-site.js with new verification methods

---

## Phase 5: Verification

- Test `verifyProduct()` on real URLs from each platform
- Run investigate-site.js --quick with multiple agents on key sites
- C6 User Simulation on sites in maintain phase
- Verify T1 catches newest products on ALL platforms
- Push and deploy

---

## Key Decisions
- T2-T4 shares: 42.5%, 32.5%, 25% (remainder to T2)
- No cooldowns in either phase — budget is the only limiter
- 5 consecutive verify errors → mark as deleted (garbage collection)
- Bootstrap MUST catch all products — compare DB vs live count before transitioning
- Preserve all data on deletion (for reporting/analytics/price tracking)
- Keep last known status before marking deleted
- Push backup before starting, clean old code immediately after deploy
