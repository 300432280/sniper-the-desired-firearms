# FirearmAlert — Per-Stream Tier Crawler Redesign

**Date:** 2026-03-09
**Status:** Pending implementation

---

## Executive Summary

Redesign the catalog crawler's tier system from "all tiers crawl all URLs" to a per-stream model where each category/endpoint is treated as an independent stream with its own tier structure. This eliminates triplication of work on HTML sites, enables proper page-range division across tiers, and introduces change detection (ETags) to reduce unnecessary processing. The design is general-purpose and decoupled from domain-specific logic for cross-industry reusability.

---

## 1. Current Problems

### 1a. Tier triplication (HTML sites)
Tiers 2, 3, and 4 all crawl the same 13 category URLs from scratch. A site with 9 categories wastes 3x tokens re-crawling identical pages.

### 1b. No effective date-based page division (all site types)
API sites (Shopify/WooCommerce) accept `dateAfter`/`dateBefore` but filter by publish date, not modification date — so tiers don't actually get different slices of recently-changed products (see 1e). HTML sites have no date filtering at all — all tiers start from page 1 of every URL.

### 1c. Pagination skip bug
When tokens run out mid-pagination on a URL, the crawler does `urlIdx++` and never returns to the remaining pages of that URL. Products on skipped pages are permanently missed for that cycle.

### 1d. Restock blind spot
Out-of-stock items that get restocked don't appear on "sort by newest" pages. Tier 1 (watermark) won't catch them. Only T2-4's blind re-crawl catches restocks currently — but with the triplication bug, this is accidental rather than by design.

### 1e. API date filtering uses publish date, not modified date
WooCommerce adapter uses `after`/`before` params which filter by **publish date** — when the product was first listed. Stock changes, price changes, and restocks update `modified` date, not publish date. This means:
- T2 filtering "last 7 days" only gets products LISTED in last 7 days
- A product listed 30 days ago that restocks today → invisible to T2/T3, only caught by T4's blind pagination
- Shopify adapter ignores `dateAfter`/`dateBefore` entirely (parameters accepted but never passed to API)

Both APIs support modification-date filtering that would catch restocks:
- WooCommerce: `modified_after` param + `orderby=modified`
- Shopify: `updated_at_min` param on `/products.json`
Neither is currently used.

---

## 2. Design: Per-Stream Tier Structure

### 2a. Core concept

A **stream** is a paginated list of products sortable by date (newest first). The **tier engine** is a general-purpose component that divides any stream's pages across tiers:

```
Stream (any paginated product list sorted by newest):
  Page 1 ── Page 2 ── Page 3 ── ... ── Page N

  Tier 1: Page 1 → watermark      (discover NEW products)
  Tier 2: watermark → page X      (refresh RECENT, 5hr cooldown)
  Tier 3: page X → page Y         (refresh AGING, 9hr cooldown)
  Tier 4: page Y → page N         (refresh ARCHIVE, 17hr cooldown)
```

The tier engine doesn't know or care what the stream represents. It only knows: pages, positions, tokens, cooldowns.

### 2b. Stream detection (find best partition)

For each site, detect the best way to partition all products into streams:

**Step 1 — Try single stream:**
- API endpoint (Shopify `/products.json`, WooCommerce `/wp-json/wp/v2/product`)
- Single "all products" HTML page with date sort (`/shop?sort=newest`, `/products?orderby=date`)
- If it covers all products with date sorting → use 1 stream (best case)

**Step 2 — If no single stream, detect partitioning patterns:**
- Category-based: `/firearms`, `/ammunition`, `/knives` (N streams)
- Price-based: `$10-100`, `$100-1000`, `$1000+` (M streams)
- Brand-based, alphabetical, etc.

**Step 3 — Score and pick best pattern:**
| Factor | Weight | Description |
|--------|--------|-------------|
| Domain relevance | Strongest | Pattern includes domain keywords? (e.g., "firearms", "ammunition") Prefer even if more streams. |
| Stream count | Secondary | Fewer streams = more tokens per stream = better |
| Coverage | Required | Must cover all products on the site |
| Date sortability | Required | Each stream must support sort-by-newest |

**Example:** Category pattern with 4 streams including "firearms" beats price pattern with 3 streams — domain relevance outweighs stream count.

### 2c. Sort parameter auto-detection

Adapters must know how to sort each stream by newest. Per-platform config (not hardcoded per-site):

| Platform | Sort parameter |
|----------|---------------|
| BigCommerce | `?sort=newest` |
| Magento | `?product_list_order=new` |
| WordPress/WooCommerce | `?orderby=date` |
| Custom CMS | Detected per-site or configured in adapter |

---

## 3. Tier Engine (General-Purpose)

### 3a. Interface

```typescript
interface Stream {
  id: string;           // e.g., "firearms", "ammunition"
  url: string;          // base URL for this stream
  sortParam?: string;   // e.g., "?sort=newest"
  totalPages?: number;  // estimated from previous crawls
  category?: string;    // for classification (from URL path)
}

interface TierEngine {
  crawlStream(
    stream: Stream,
    tier: 1 | 2 | 3 | 4,
    tokensAllocated: number,
    state: StreamTierState,
  ): Promise<CrawlResult>;
}

interface StreamPriority {
  (streams: StreamState[]): StreamState[];  // return sorted by priority
}
```

### 3b. Tier responsibilities

| Tier | Page range | Cooldown | Purpose |
|------|-----------|----------|---------|
| T1 | Page 1 → watermark | Per crawl interval | Discover new products |
| T2 | Watermark → page X | 5 hours | Refresh recent items (price/stock changes, restocks) |
| T3 | Page X → page Y | 9 hours | Refresh aging items |
| T4 | Page Y → end | 17 hours | Refresh archive items |

**All tiers do full fetch** — no ETag/304 optimization for sorted-by-newest HTML streams because adding any new product shifts all page contents (item #36 on page 1 drops to page 2, cascading through every page). ETags would never return 304.

ETag optimization is only viable for:
- API endpoints with absolute date-range queries (pages don't shift)
- Streams NOT sorted by date (alphabetical, etc.)
- Future consideration, not part of this release

**Restocks are caught naturally by page-range division:**
A restocked product stays on the same page (its listing date doesn't change). Whichever tier owns that page catches the restock at that tier's frequency. Recent products (pages 1-X, more likely to be restocked) are refreshed every 5 hours by T2. Old products on deep pages are refreshed every 17 hours by T4. No special "safety net" tier needed.

### 3c. State tracking per stream per tier

```typescript
interface StreamTierState {
  streamId: string;
  tier: 2 | 3 | 4;
  currentPage: number;       // resume position within this tier's page range
  pageRangeStart: number;    // first page this tier owns
  pageRangeEnd?: number;     // last page (null for T4 = open-ended)
  lastRefreshedAt: Date;     // for staleness-based rotation
  cycleStartedAt?: Date;
  cooldownEndsAt?: Date;
  status: 'idle' | 'in_progress' | 'cooldown';
}
```

### 3d. Total page estimation

After first full crawl of a stream, store total page count. This allows pre-calculating tier boundaries:
- T2 owns pages 1 to `ceil(totalPages * 0.3)`
- T3 owns next `ceil(totalPages * 0.35)`
- T4 owns the rest

Re-estimate periodically as products are added/removed.

---

## 4. Token Allocation Across Streams

### 4a. Per-site budget (unchanged)
```
effectiveBudget = max(5, floor(baseBudget × capacity))
T1 reserve: 70% of effectiveBudget
Catalog pool: remaining 30% → T2 (35%), T3 (35%), T4 (30%)
```

### 4b. Per-stream allocation
Each tier concentrates tokens on **one stream at a time** rather than spreading thin:
- Tier gets its token budget for this tick
- Picks the highest-priority stream (via priority function)
- Spends all tokens on that stream
- Next tick: picks the next priority stream
- Streams that finish quickly don't take from others

### 4c. Default rotation: staleness-based
The stream whose tier data is oldest goes next. Self-balancing:
- Small streams (1 page) finish fast, don't come back for a while
- Large streams (20 pages) take longer but get proportionally more attention
- No configuration needed

---

## 5. Domain Priority Plugin (Decoupled)

### 5a. General engine default
Staleness-based rotation. No domain knowledge.

### 5b. Firearms industry plugin

```typescript
const STREAM_WEIGHTS: Record<string, number> = {
  firearms: 3,
  ammunition: 2,
  // everything else defaults to 1
};

const firearmPriority: StreamPriority = (streams) =>
  streams.sort((a, b) => {
    const aW = STREAM_WEIGHTS[a.category] ?? 1;
    const bW = STREAM_WEIGHTS[b.category] ?? 1;
    if (aW !== bW) return bW - aW;  // higher weight first
    return a.lastRefreshedAt - b.lastRefreshedAt;  // then staleness
  });
```

### 5c. Separation from engine
- Plugin lives in its own file (e.g., `stream-priority-firearms.ts`)
- Engine accepts `StreamPriority` function as parameter
- Swappable for other industries without touching engine code
- Other domain-specific code (CATEGORY_FILTERS, product classifier) also stays decoupled

---

## 6. Out-of-Stock Handling

### 6a. Restocks caught by page-range ownership
Each tier owns a page range. A restocked product stays on the same page (listing date unchanged). The tier that owns that page catches the restock at its cooldown frequency:
- Recent product restocked → T2 catches within 5 hours
- Old product restocked → T4 catches within 17 hours

### 6b. Optional: "Back in Stock" stream
If a site has a "Back in Stock" or "Recently Restocked" page, add it as a T1 stream for instant restock detection. This is a bonus optimization, not required for correctness.

### 6c. OOS products still get full upsert
All tiers do full upsert on every product they encounter. No skipping OOS products — their stock status might have changed (restocked). The page fetch is the expensive part; the DB upsert cost is negligible by comparison.

---

## 7. Deduplication & Classification

### 7a. Cross-stream deduplication
Same product may appear in multiple streams (e.g., `/firearms` and `/on-sale`). Track URLs globally per-site per-cycle:
- First encounter: full process + upsert
- Subsequent encounters: skip or merge tags only

### 7b. Classification from stream identity
URL path provides classification: `/firearms` → tag "firearms". Works for all tiers because every tier crawls within a specific stream.

### 7c. Cross-stream tag enrichment
If product appears in `/firearms` AND `/on-sale`, merge tags: `"firearms,on-sale"`. Don't overwrite — append unique tags.

---

## 8. Stream Health Monitoring

If a stream returns 0 products for 2+ consecutive crawls:
- Flag as potential issue (URL changed, site redesign, blocked)
- Surface in admin panel as site issue
- Don't silently lose coverage
- Auto-retry with Playwright before flagging

---

## 9. Files to Modify

| File | Changes |
|------|---------|
| `catalog-crawler.ts` | Major refactor — per-stream tier engine, page-range division, ETag support |
| `watermark-crawler.ts` | Per-stream watermark tracking (one watermark per stream) |
| `token-budget.ts` | Stream-aware allocation, per-stream token tracking |
| `crawl-scheduler.ts` | Stream detection on site init, pass streams to crawl jobs |
| `scraper/types.ts` | Add `Stream` interface, `StreamTierState` |
| `scraper/adapters/*.ts` | Add `getStreams()` method, sort parameter config |
| NEW: `stream-priority.ts` | General-purpose staleness rotation |
| NEW: `stream-priority-firearms.ts` | Domain plugin: firearms 3x > ammunition 2x > rest 1x |
| `prisma/schema.prisma` | `streamState` JSON field on MonitoredSite (replaces `tierState`) |
| `routes/admin.ts` | Expose stream state in dashboard API |
| Frontend admin sites page | Show per-stream tier progress instead of per-site |

---

## 10. Migration Strategy

### Phase 1: Fix immediate bugs (can ship independently) ✓ COMPLETE
- [x] Fix pagination skip bug (resume from same page, not next URL) — `currentPageUrl` saved in TierCycleState
- [x] Add sort parameters to catalog URLs where supported
- [x] **WooCommerce**: Switch from `after`/`before` (publish date) to `modified_after`/`modified_before` + `orderby=modified` — catches restocks, price changes, any product modification
- [x] **Shopify**: Add `updated_at_min` param to `/products.json` calls — catches restocks via inventory updates
- [x] Both: T2-4 date ranges now filter by modification date, so tiers actually get different slices of recently-changed products (not just recently-published)

### Phase 2: Per-stream tier engine ✓ COMPLETE
- [x] Implement Stream interface and tier engine (`scraper/types.ts`)
- [x] Refactor catalog-crawler.ts to use stream-based crawling (`crawlStreamTier()`)
- [x] Stream detection and state management (`stream-detector.ts`)
- [x] Stream priority plugins (`stream-priority.ts`, `stream-priority-firearms.ts`)
- [x] Scheduler integration — auto-detects streams, passes `streamState` in jobs
- [x] Worker integration — `processStreamCatalogCrawl()` with legacy fallback
- [x] Add `streamState Json?` to schema, DB pushed

### Phase 3: Restock + OOS handling
- [ ] All tiers do full upsert (no OOS skipping — stock status may change)
- [ ] Optional: detect "Back in Stock" pages and add as T1 streams
- [ ] Future consideration: ETag optimization for API-based or non-date-sorted streams only

### Phase 4: Stream detection + priority plugin
- [ ] Auto-detect stream partitioning patterns per site
- [ ] Stream scoring (domain relevance, count, coverage)
- [ ] Pluggable priority function
- [ ] Firearms domain priority plugin
- [ ] Stream health monitoring

### Phase 5: Admin UI
- [ ] Per-stream tier progress in admin dashboard
- [ ] Stream configuration per site
- [ ] Stream health alerts

---

## 11. Verification

After each phase:
1. Run `verify-site.js` — product coverage should improve, not regress
2. Compare token usage before/after — should decrease with ETag optimization
3. Check that restocks are caught within 17hr window
4. Verify classification tags preserved across streams
5. Monitor stream health for 0-product alerts
