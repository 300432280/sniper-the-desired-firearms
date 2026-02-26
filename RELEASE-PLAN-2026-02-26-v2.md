# FirearmAlert — Crawl Engine v2 Release Plan

**Date:** 2026-02-26
**Status:** Draft — Pending approval

---

## Executive Summary

Redesign the crawl and scheduling engine from keyword-based scraping to catalog-based indexing. This decouples crawl load from user count, replaces the fragile multiplier-based interval formula with a continuous pressure/capacity model, and properly differentiates crawl strategies by site type.

---

## 1. Architecture: Catalog-Based Crawling

### Core Principle

Crawl site catalogs → store all discovered products locally → match user keywords against our DB. Crawl load is proportional to number of sites (50), not number of users (200,000) or keywords.

### Current vs New

| Aspect | Current | New |
|--------|---------|-----|
| What we crawl | Site search URL per keyword | Site catalog (new arrivals + periodic full refresh) |
| Keyword matching | On the target site (HTTP request per keyword) | In our DB (SQL query, zero HTTP) |
| Load growth | Grows with keywords × sites | Fixed per site |
| User search response | Wait for crawl | Instant DB query |

### New DB Models

#### ProductIndex

Stores all discovered products from all monitored sites.

```prisma
model ProductIndex {
  id          String   @id @default(cuid())
  siteId      String
  site        MonitoredSite @relation(fields: [siteId], references: [id])
  url         String        // Product URL on the source site
  title       String
  price       Float?
  stockStatus String?       // "in_stock" | "out_of_stock" | "unknown"
  thumbnail   String?
  category    String?       // "new" | "used" | "auction_lot" | "classified"
  closingAt   DateTime?     // For auction lots — enables live countdown timer
  firstSeenAt DateTime      @default(now())
  lastSeenAt  DateTime      @default(now())  // Updated when seen in any crawl
  isActive    Boolean       @default(true)    // False when product disappears

  @@unique([siteId, url])
  @@index([siteId, lastSeenAt])
  @@index([title])   // For keyword matching
}
```

#### KeywordGroup & KeywordAlias

Maps keyword variations to a canonical form so "ruger 1022", "ruger 10/22", "ruger 10 22" all match the same product.

```prisma
model KeywordGroup {
  id             String   @id @default(cuid())
  canonicalName  String   @unique  // e.g. "Ruger 10/22"
  aliases        KeywordAlias[]
}

model KeywordAlias {
  id       String   @id @default(cuid())
  groupId  String
  group    KeywordGroup @relation(fields: [groupId], references: [id])
  alias    String   @unique  // e.g. "ruger 1022", "10/22", "ruger 10 22"

  @@index([alias])
}
```

### Keyword Matching Flow

1. Crawl discovers new product → insert into ProductIndex
2. Keyword matcher runs: for each active Search, expand keyword to all aliases via KeywordGroup
3. Check if product title contains any alias (word-boundary match)
4. If match → create Match record → trigger notification per user tier
5. When user creates new Search → immediately query ProductIndex with expanded aliases → return existing matches instantly

---

## 2. Site Categories & Crawl Strategies

### Three distinct categories with different crawl approaches.

### A. Retailers (40 sites)

**Characteristics:** Stable inventory of mass-produced products. New items added irregularly (weekly product drops, seasonal restocks). Also may have used/consignment sections that behave like classifieds.

| Crawl Type | What | Method | Frequency |
|-----------|------|--------|-----------|
| **New Items (Tier 1)** | Hit "new arrivals" / "sort by newest" page | Watermark: paginate from newest until we hit last-known product | Every 30 min |
| **Full Catalog (Tiers 2-4)** | Re-verify existing products by date range | Date-based tiers: recent → aging → archive (see Section 3) | Tier 2: 5hr, Tier 3: 9hr, Tier 4: 17hr |

**Full catalog purpose:** Update prices, stock status, detect removed/sold products, catch items missed by new-items crawl. NOT for time-sensitive discovery. Unsold old items are still valuable to searchers.

**API-based catalog (WooCommerce, Shopify):**
- WooCommerce: `GET /wp-json/wc/store/v1/products?per_page=100&page=N`
- Shopify: `GET /products.json?limit=250&page=N`
- Returns structured JSON with prices, images, stock — most efficient method
- Can filter by date range for tier-specific crawls

**HTML-based catalog (BigCommerce, Magento, custom):**
- Crawl category pages or "all products" sorted by newest
- Extract using existing adapter selectors
- Page positions estimated from ProductIndex firstSeenAt data

### B. Forums / Classifieds (4 sites)

**Characteristics:** One-of-kind items posted by individuals. High velocity — new posts appear throughout the day. Sell fast (hours to days). Catalogs are large and always growing (e.g. GunPost: 20,000+ listings, 1100+ pages).

| Crawl Type | What | Method | Frequency |
|-----------|------|--------|-----------|
| **New Posts (Tier 1)** | Hit "latest listings" / "recent posts" page | Watermark: paginate from newest until we hit last-known post | Every 15 min |
| **Full Catalog (Tiers 2-4)** | Re-verify older listings (still for sale? removed?) | Date-based tiers, same as retailers (see Section 3) | Tier 2: 5hr, Tier 3: 9hr, Tier 4: 17hr |

**Why full catalog IS included for classifieds:**
- Unsold old items are still valuable. A "Marlin 336" listed 25 days ago that's still available should appear in search results.
- The date-based tier system handles the scale naturally — Tier 4 (22+ days) crawls slowly at low priority.
- GunPost's 1100+ archive pages are handled by Tier 4's budget allocation over multiple cycles.
- Most old classified listings ARE sold — but the ones that aren't are worth finding.

**Forum-specific considerations:**
- Authentication may be required (CGN, Gun Owners of Canada)
- Session cookies cached and reused (existing auth-manager.ts)
- Posts may be edited/deleted — catalog tier re-verification catches these changes

### C. Auctions (4 sites)

**Characteristics:** Lots announced in batches when an auction event launches. Bidding happens over days/weeks. New lots don't appear frequently — they appear all at once when an event starts. Time-sensitive moment is lot closing, not lot discovery.

| Crawl Type | What | Method | Frequency |
|-----------|------|--------|-----------|
| **Event Discovery** | Check for newly announced auction events | Hit main listing page | Every 6-12 hours |
| **Lot Indexing** | When new event found, crawl all lots in that event | Drip-fed within token budget | On detection of new event |

**Auction-specific features:**
- ProductIndex records for auction lots include `closingAt` timestamp
- Frontend renders live countdown timer (client-side JavaScript, no crawl needed)
- Future PRO feature: push notification N hours before lot closes

---

## 3. Token Budget & Date-Based Catalog Tiers

### Base Budget

Each site has a **base hourly request budget** (default: **60 req/hour**). Admin can override per site. The effective budget is scaled by capacity:

```
effective_budget = max(5, floor(BASE_BUDGET × capacity))

min_gap = 3600 / effective_budget   (seconds between any request to this site)

Example: BASE_BUDGET=60, capacity=0.86 → effective=51 tokens/hour, min_gap=70s
Example: BASE_BUDGET=60, capacity=0.22 → effective=13 tokens/hour, min_gap=277s
Example: BASE_BUDGET=60, capacity=0.05 → effective=5 tokens/hour (floor), min_gap=720s
```

The `min_gap` ensures requests are evenly spaced within each hour, preventing burst patterns. All tiers (1-4) respect the same min_gap — no request to a site fires faster than this interval.

Admin portal displays both the base budget and the effective budget per site.

### Tier 1 — New Items (Watermark Crawl)

- **Allocation:** 70% of effective hourly budget (reserved)
- **Runs:** Every crawl interval (15 min for classifieds, 30 min for retailers)
- **Method:** Watermark — paginate from newest until hitting last-known item
- **Priority:** Always runs first each hour. Unused Tier 1 tokens flow downstream to catalog tiers.

### Catalog Tiers (2, 3, 4) — Date-Based Full Catalog Refresh

After Tier 1 finishes each hour, **all remaining tokens** (the 30% catalog allocation + any unused Tier 1 tokens) are distributed to whichever catalog tiers are currently running or due to start:

| Tier | Date Range | Min Spacing | Share of Remaining |
|------|-----------|------------|-------------------|
| **Tier 2** (Recent) | Last Tier 1 crawl → 7 days back | 5 hours | 35% |
| **Tier 3** (Aging) | 8 → 21 days back | 9 hours | 35% |
| **Tier 4** (Archive) | 22+ days back | 17 hours | 30% |

**Token distribution rules:**
- If only one tier is active this hour → it gets 100% of remaining tokens
- If multiple tiers are active → split proportionally by their base shares
  - Example: Tier 2 + Tier 3 active → Tier 2 gets 35/(35+35) = 50%, Tier 3 gets 50%
  - Example: All three active → 35/35/30 split as listed

### Crawl Direction

All catalog tiers crawl from **most recent to least recent** within their date range. If tokens run out mid-cycle, the oldest (least urgent) items are deferred to the next hour. Most valuable items are always checked first.

### Cycle Lifecycle & Cooldown Rules

Each tier operates in cycles:

1. **Start:** Tier snapshots its date boundaries as **absolute dates** (e.g., "Feb 5 to Feb 18"), locked for the cycle
2. **Run:** Crawls pages from most recent to least recent, consuming allocated tokens each hour
3. **Continue:** If cycle can't finish in one hour, it continues the next hour (no pause — picks up where it left off)
4. **Complete:** Cycle finishes → cooldown timer starts
5. **Cooldown:** Wait for minimum spacing (5/9/17 hours from cycle start), then begin next cycle
6. **Overrun:** If cycle takes longer than the cooldown period → start next cycle immediately after completion (no extra wait)

**Key rule:** The cooldown is the minimum gap between **cycle starts**, not between continuation runs. An in-progress cycle is never paused — it gets tokens every hour until complete.

### Absolute Date Snapshotting

When a tier starts a new cycle, it recalculates its date boundaries from the **current date**:

```
Tier 3 starts new cycle at Feb 26:
  snapshot_start = Feb 5   (21 days back from now)
  snapshot_end   = Feb 18  (8 days back from now)
  Boundaries LOCKED until cycle completes.

Tier 3 finishes Feb 27, cooldown elapses, starts new cycle Feb 27:
  snapshot_start = Feb 6   (recalculated from current date)
  snapshot_end   = Feb 19
```

This prevents the sliding window bug: if boundaries were relative ("8-21 days back"), a cycle that takes 2 days would re-check items that shifted between tiers or miss items that slipped through.

### Examples

#### Healthy Retailer (capacity=0.86, effective=51 tokens/hr, min_gap=70s, 60 catalog pages)

```
Tier 1 runs: uses 3 tokens (quiet site, 3 pages, no new items)
Remaining: 51 - 3 = 48 tokens

Hour 0: Tier 2 starts → gets all 48 tokens → finishes 48 pages
Hour 1: No tier due (Tier 2 cooldown: 5hr, Tier 3: not yet due)
Hour 5: Tier 2 due → starts new cycle, gets 48 tokens
Hour 9: Tier 2 mid-cycle + Tier 3 starts → split 50/50 = 24 each
Hour 17: Tier 2 + Tier 4 starts → Tier 2 gets 26, Tier 4 gets 22
```

#### Busy Classified — GunPost (capacity=0.74, effective=44 tokens/hr, min_gap=82s, 1100+ pages)

```
Tier 1 runs: uses 15 tokens (busy forum, 15 pages of new posts)
Remaining: 44 - 15 = 29 tokens

Hour 0: Tier 2 starts → gets all 29 tokens → crawls 29 recent pages
Hour 1: Tier 2 still running → gets 29 tokens → continues
Hour 5: Tier 2 finishes, cooldown starts. Tier 2 due again later.
Hour 9: Tier 2 + Tier 3 both start → split 50/50 = 14-15 each
Hour 17: Tier 4 starts → Tier 4 has ~900 archive pages
         Gets 30% share when other tiers also active
         Continues across many hours until complete
```

**GunPost Tier 4 math:** 900 archive pages. When running alone: ~29 tokens/hr = 31 hours to complete. When sharing with other tiers: ~9 tokens/hr = 100 hours. Either way, completes within cooldown period or continues until done, then waits for 17hr cooldown before restarting.

---

## 4. Interval Formula: Continuous Pressure/Capacity Model

### Replaces the current multiplier stack entirely.

**Current formula (being replaced):**
```
interval = BASE × difficulty × traffic × failures × WAF × rateLimit × CAPTCHA × peak × season × demand × yield
```

**Problems with current formula:**
- Multipliers stack multiplicatively → tiny signals become massive interval jumps (30x+ explosion)
- Hard-step penalties (3 failures → 1hr, 5 → 6hr) cause oscillation
- Recovery lag: one success after failures doesn't help until consecutive failure count drops below threshold
- Traffic class buckets cause threshold jumps and misclassification

### New formula:

#### Step 1 — Compute Site Pressure

Rolling window of last 20 crawls:

```
pressure = 0.4 × failure_rate              (HTTP errors / total crawls)
         + 0.2 × block_rate                (429 + captcha + WAF / total)
         + 0.2 × latency_score             (normalized 0-1: 0=fast, 1=very slow)
         + 0.2 × extraction_failure_rate    (200 OK but empty/suspicious HTML / total)

Clamp pressure to [0, 1]
```

#### Step 2 — Compute Capacity

```
capacity = e^(-3 × pressure)
```

| Pressure | Capacity | Interpretation |
|----------|----------|---------------|
| 0.0 | 1.00 | Fully healthy, no issues |
| 0.1 | 0.74 | Occasional hiccups |
| 0.2 | 0.55 | Some resistance |
| 0.3 | 0.41 | Moderate issues |
| 0.5 | 0.22 | Significant pushback |
| 0.7 | 0.12 | Heavy resistance |
| 1.0 | 0.05 | Nearly blocked |

Smooth continuous curve. No step functions. No oscillation. Recovery is gradual — each successful crawl nudges the rolling average slightly.

#### Step 3 — Base Rate by Site Type (for Tier 1 new-items crawl)

| Site Type | Base Rate (new-items crawls/hour) |
|-----------|----------------------------------|
| Forum / Classified | 4/hour (every 15 min) |
| Retailer | 2/hour (every 30 min) |
| Auction | 0.17/hour (every 6 hours) |

#### Step 4 — Compute Final Interval (Tier 1)

```
target_rate = base_rate × capacity

interval = 60 / target_rate    (minutes)

Clamp to [15 min, 1440 min]
```

Note: This interval controls Tier 1 (new-items crawl) frequency only. Catalog tiers (2-4) have their own scheduling described in Section 3. The **token budget** (default 60 req/hour per site, see Section 3) governs total request throughput across all tiers.

#### Step 5 — Peak Hour Modulation

Crawl MORE during business hours when our traffic blends with real customers.
Crawl LESS at night when we'd stand out on small sites.

```
if 9 AM - 9 PM EST (14:00 - 02:00 UTC):
    interval = interval × 0.85    (crawl slightly more)
else:
    interval = interval × 1.2     (crawl slightly less)
```

#### Examples

| Site | Type | Pressure | Capacity | Base Rate | Interval |
|------|------|----------|----------|-----------|----------|
| Lever Arms | Retailer | 0.05 | 0.86 | 2/hr | 35 min |
| Wolverine Supplies | Retailer | 0.15 | 0.64 | 2/hr | 47 min |
| GunPost | Classified | 0.1 | 0.74 | 4/hr | 20 min |
| Canadian Gun Nutz | Forum | 0.2 | 0.55 | 4/hr | 27 min |
| hical.ca | Retailer | 0.6 | 0.17 | 2/hr | 176 min (~3 hrs) |
| iCollector | Auction | 0.05 | 0.86 | 0.17/hr | 414 min (~7 hrs) |

### What this formula does NOT include

| Removed Factor | Why |
|---------------|-----|
| User tier (PRO/FREE) | Crawl frequency is a site property, not user property. Tiers only affect notification delivery. |
| Keyword popularity | With catalog architecture, keywords don't affect crawl load. |
| Traffic class buckets | Replaced by continuous capacity factor. |
| Zero-match streak | Measures "product doesn't exist" not "site is hard to scrape." |
| Demand bonus | All enabled sites get crawled at their site-type rate. |
| Yield bonus | Low yield = site doesn't have what users want, not a crawl scheduling concern. |
| Seasonal factor | Minor optimization, can add later if needed. |

---

## 5. Watermark-Based New-Items Crawl (Tier 1)

### How it works

This is Tier 1 in the token budget system (Section 3). Each MonitoredSite stores a `lastWatermarkUrl` (the most recent product URL seen in the previous new-items crawl).

**Crawl process:**

1. Fetch page 1 of "new arrivals" / "sort by newest" (most recent first)
2. Extract product listings
3. For each product:
   - If URL already exists in ProductIndex → STOP (we've reached the watermark)
   - If URL is new → add to ProductIndex, continue to next page
4. Stop when: watermark found, OR Tier 1 token budget exhausted (whichever comes first)
5. After adding new products: run keyword matcher against all active Searches
6. Update `lastWatermarkUrl` to the newest product found
7. Return unused Tier 1 tokens to the catalog tier pool for this hour

**Self-adjusting:**
- Busy forum (20 new posts since last crawl) → crawls 2-3 pages, uses 2-3 tokens
- Quiet retailer (0 new products) → crawls 1 page, finds nothing new, stops — 1 token used
- Load naturally scales with actual site activity
- Unused Tier 1 tokens flow to catalog tiers (Tiers 2-4) automatically

**Edge case — watermark not found within token budget:**
If Tier 1 exhausts all its tokens without hitting the watermark (e.g., crawler was down for hours and hundreds of new items appeared, or the site restructured its URLs):
- Index whatever was found so far, move the watermark forward to the newest product found
- Zero remaining tokens this hour → catalog tiers (2-4) get nothing this round, pause until next hour
- Next Tier 1 run continues from the new watermark — if the backlog clears, catalog tiers resume
- Log a warning for admin visibility

---

## 6. Keyword Organizer (Alias System)

### Problem

"Ruger 1022", "Ruger 10/22", "Ruger 10 22" are the same product but different keyword strings. Without normalization, a user searching "ruger 1022" misses products titled "Ruger 10/22 Carbine."

### Solution

#### KeywordGroup table

Maps all variations of a product name to a canonical form.

**Examples:**

| Canonical Name | Aliases |
|---------------|---------|
| Ruger 10/22 | ruger 1022, ruger 10/22, ruger 10 22, 10/22 |
| SKS | sks, sks-45, type 56 |
| CZ 75 | cz75, cz-75, cz 75, ceska zbrojovka 75 |
| Remington 870 | rem 870, remington870, rem870, r870 |
| Glock 19 | glock19, g19, glock 19 gen 5 |

#### Matching logic

When checking if a product matches a keyword:

1. Look up the keyword in KeywordAlias → get KeywordGroup
2. Get all aliases in the group
3. Check product title against ALL aliases (word-boundary match)
4. If no alias group exists → match against the raw keyword as-is

#### Population

- **Seed file:** Pre-populate common firearm model aliases (50-100 groups covering popular models)
- **Admin portal:** Interface to add/edit keyword groups and aliases
- **Future:** Auto-suggest aliases based on common user search variations (if User A searches "ruger 1022" and User B searches "ruger 10/22", suggest grouping them)

---

## 7. Notification & User Tiers

### Crawl system is tier-blind

The scheduler crawls based on site type + capacity. It does not know or care about user tiers. Notification logic is a separate layer.

### Tier Definitions

| Tier | Active Alerts | Alert Duration | Delivery Method | Timing | Price |
|------|-------------|---------------|----------------|--------|-------|
| **PRO** | Unlimited | Never expires | Email + SMS | Instant on match | $14/mo |
| **FREE** | 3 max | 14 days per alert | Email only | Daily digest 6 PM EST | Free |
| **Guest** | 0 (search only) | — | — | — | — |

### FREE User Rules

- Can have up to 3 active alerts at any time
- Each alert auto-expires after 14 days from creation
- After expiry: alert becomes inactive, no new notifications, but match history remains viewable
- User can cancel any alert anytime → frees up a slot
- User can recreate the same keyword alert (resets 14-day clock)
- Receives daily digest email at 6 PM EST with all new matches from past 24 hours
- "Search All Sites" counts as 1 alert toward the 3-alert limit (the group, not per-site)
- Upgrade prompts shown when: alert expires, hits limit, wants instant/SMS

### Guest User Rules

- Can use search function (query our ProductIndex) up to 5 times per session
- Each search shows results with a registration banner
- After 5 searches → prompted to register (free account)
- No background monitoring, no alerts, no notifications

### PRO User Rules

- Unlimited alerts, never expire
- Instant email + SMS on new match detection
- All features unlocked
- Search All Sites with no limits

### Notification Delivery

- Notifications sent regardless of login status — user set up the alert, they get notified
- FREE alert auto-expiry (14 days) handles the "abandoned user" problem naturally
- No login-based deactivation needed

---

## 8. Cold Start: New Site Onboarding

When admin adds a new MonitoredSite:

### Phase 1 — Conservative Discovery (Days 1-2)

- Token budget hardcoded to 10 requests/hour (regardless of BASE_BUDGET setting)
- Capacity initialized at 0.5 (neutral)
- Tier 1 (new items) runs at reduced pace, catalog tiers (2-4) get minimal tokens
- **For retailers:** Begin Tier 1 watermark crawl + Tier 2 starts with ~3 tokens/hr
- **For forums/classifieds:** Begin Tier 1 watermark crawl. Start watermark at "now" — only capture posts going forward. Catalog tiers begin but at minimal pace.
- **For auctions:** Crawl current active events/lots

### Phase 2 — Learning (Days 3-7)

- Rolling pressure window accumulates real crawl data (needs 20 crawls to be fully data-driven)
- Capacity adjusts based on actual site responses
- Token budget gradually scales: `max(10, floor(BASE_BUDGET × capacity))` where BASE_BUDGET defaults to 60

### Phase 3 — Steady State (Day 8+)

- Full data-driven scheduling with full BASE_BUDGET available
- Behaves like any other established site
- All four tiers operating normally

---

## 9. Admin Portal Revisions

### New Admin Features Needed

#### 9.1 Site Monitor Dashboard Updates

| Feature | Description |
|---------|-------------|
| **Capacity gauge** | Replace difficulty score display with capacity factor (0-1) as a visual gauge (green/yellow/red) |
| **Pressure breakdown** | Clickable: shows failure_rate, block_rate, latency_score, extraction_failure_rate |
| **Base budget field** | Per-site editable field (default 60). Shows effective budget (`floor(base × capacity)`) alongside |
| **Token budget display** | Show tokens consumed this hour: Tier 1 used / Tier 2-4 used / remaining |
| **Tier status panel** | For each tier (1-4): current cycle state, date range snapshot, pages crawled / remaining, next cycle due |
| **Crawl type indicators** | Show Tier 1 (New Items) and Tiers 2-4 (Catalog) status separately (last run, next due) |
| **Watermark info** | Show the last-known product URL/date for each site |
| **ProductIndex count** | Number of products indexed per site, growth rate |
| **Site type badge** | Retailer / Forum / Classified / Auction — editable by admin |
| **Site category assignment** | Dropdown to set site category (affects base crawl rate and Tier 1 interval) |

#### 9.2 Keyword Organizer Interface

| Feature | Description |
|---------|-------------|
| **Keyword groups list** | Table of all keyword groups with canonical name and alias count |
| **Add/Edit group** | Create new keyword group, add/remove aliases |
| **Search integration** | When viewing a Search, show which keyword group it belongs to |
| **Orphan detection** | Flag keywords that don't belong to any group (may need aliases added) |
| **Auto-suggest** | Show frequently searched keywords that might be aliases of existing groups |

#### 9.3 ProductIndex Browser

| Feature | Description |
|---------|-------------|
| **Browse by site** | View all indexed products for a specific site with pagination |
| **Search products** | Full-text search across ProductIndex |
| **Product details** | Show firstSeenAt, lastSeenAt, isActive, price history |
| **Stats dashboard** | Total products indexed, products per site, new products today |

#### 9.4 Crawl Controls

| Feature | Description |
|---------|-------------|
| **Force Live Crawl** | Admin-only button. Triggers immediate Tier 1 crawl for selected sites. After completion, sites return to normal schedule automatically. |
| **Force Full Catalog** | Admin can manually reset all catalog tier cycles for a site, triggering fresh full sweeps |
| **Base Budget Override** | Per-site editable field. Default 60 req/hour. |
| **Cold Start Override** | Admin can skip the cold start phase for a site they know is safe |
| **Site type assignment** | Dropdown to set site as Retailer / Forum / Classified / Auction |

#### 9.5 Removed/Changed Admin Features

| Feature | Change |
|---------|--------|
| Difficulty score | Replaced by capacity factor (0-1) |
| Traffic class dropdown | Removed — capacity is auto-computed from real crawl data |
| Override difficulty | Removed — no difficulty score to override |
| Override traffic class | Removed — no traffic classes |
| Override interval | Kept — admin can still force a specific interval |

---

## 10. Safety & Resilience

### Hard Safety Ceilings

| Limit | Value |
|-------|-------|
| Max concurrent crawls | 10 |
| Max requests per site per hour | Token bucket enforced (default 60, scaled by capacity) |
| Min gap between requests to same site | `3600 / effective_budget` seconds (see Section 3) |
| Crawl lock timeout | 5 minutes (auto-expire) |

### Capacity-Based Protections

| Condition | Action |
|-----------|--------|
| Capacity drops below 0.1 | Site crawl interval expands significantly (300+ min for retailers) |
| Capacity below 0.05 for 7+ days | Flag for admin review (dashboard badge), don't auto-disable |
| Single crawl failure | Rolling average nudges slightly — no hard reaction |
| Recovery after failures | Gradual — capacity climbs back as successes accumulate in rolling window |

### Admin Force Crawl Behavior

1. Admin clicks "Force Live Crawl" for selected sites (or all)
2. Selected sites' `nextCrawlAt` set to `now()`
3. Scheduler tick triggered immediately
4. Sites crawled with their current token budget (not unlimited)
5. After each forced crawl completes: `onCrawlComplete` → recalculates normal interval and restores regular schedule
6. Sites naturally re-stagger because they finish at different times
7. Force crawl results saved to ProductIndex → keyword matching → notifications as normal

---

## 11. Search Lifecycle

### Creating a Search

1. User enters keyword + selects sites (or "Search All")
2. Backend creates Search records
3. Expand keyword via KeywordAlias → get all variations
4. Immediately query ProductIndex for existing matching products → create Match records → return results
5. User sees all current matches instantly, zero crawl needed

### Ongoing Monitoring

1. Crawl system discovers new products → adds to ProductIndex
2. Keyword matcher checks all active Searches (with alias expansion) → creates Match records for new matches
3. Notification system delivers per tier rules

### FREE Alert Expiry

- After 14 days, Search.isActive → false
- No more keyword matching or notifications for this search
- Matches remain in DB for history viewing
- User can create a new alert for the same keyword (resets 14-day clock)

### Search All Behavior

- Creates one Search per enabled site (existing behavior)
- Each Search individually subject to tier limits
- For FREE: counts as 1 alert toward 3-alert limit (the group, not individual searches)

---

## 12. Implementation Roadmap

### Phase 1 — Immediate Fixes (no architecture change)

**Scope: Small code changes to existing files**

| Task | File(s) | Description |
|------|---------|-------------|
| Remove zero-match streak from difficulty | `priority-engine.ts` | Remove `zeroMatchStreak` scoring from `computeDifficulty()` |
| Fix Gun Owners of Canada | DB update | Set appropriate traffic class |
| Fix auto-detection | `traffic-classifier.ts` | Remove CDN presence as sole traffic indicator |
| Fix user endpoints | `searches.ts` | Search creation returns existing Match data. Refresh/scan = pure DB reads. Remove `nextCrawlAt` manipulation and `schedulerTick` triggers from user endpoints. |
| Fix peak hours | `priority-engine.ts` | Invert: crawl more during business hours (0.85x), less at night (1.2x) |
| Fix daily digest time | `daily-digest.ts` | Change to 6 PM EST (11 PM UTC) |

### Phase 2 — Replace Interval Formula

**Scope: Rewrite priority-engine.ts, update crawl-scheduler.ts**

| Task | Description |
|------|-------------|
| Implement pressure computation | Rolling window of last 20 CrawlEvents per site |
| Implement capacity factor | `e^(-3 × pressure)` replacing all multipliers |
| Add `siteCategory` to MonitoredSite | New field: retailer / forum / classified / auction |
| Replace `computeCrawlPriority()` | New formula: `interval = 60 / (base_rate × capacity)` |
| Remove old multiplier system | Delete traffic class, WAF/CAPTCHA/rateLimit multipliers, seasonal, demand, yield factors |
| Implement peak hour modulation | More during 9AM-9PM EST, less overnight |
| Update admin dashboard | Show capacity gauge, pressure breakdown |

### Phase 3 — ProductIndex & Catalog Crawling

**Scope: New Prisma model, new crawler logic, adapter changes**

| Task | Description |
|------|-------------|
| Add ProductIndex model | Prisma schema + migration |
| Add `crawlCatalog()` to adapter interface | New optional method on SiteAdapter |
| Implement WooCommerce catalog crawl | Paginate `/wp-json/wc/store/v1/products` (supports date range filtering) |
| Implement Shopify catalog crawl | Paginate `/products.json` (supports date range filtering) |
| Implement HTML-based catalog crawl | Category page crawler for BigCommerce, Magento, etc. |
| Implement token budget system | Per-site `TokenBucket` class with Tier 1 reservation (70%) and catalog tier allocation |
| Add `baseBudget` to MonitoredSite | Default 60, admin-configurable, effective budget = floor(base × capacity) |
| Implement date-based catalog tiers | Tier 2 (recent 7d), Tier 3 (8-21d), Tier 4 (22+d) with cooldowns (5/9/17hr) |
| Add `tierState` JSON to MonitoredSite | Track per-tier cycle state: date snapshot, page progress, cycle start time |
| Implement min_gap spacing | Enforce `3600 / effective_budget` seconds between any request to same site |
| Update worker to save to ProductIndex | Products go to index first, then matched to searches |

### Phase 4 — Watermark New-Items Crawl

**Scope: New crawl logic, MonitoredSite field addition**

| Task | Description |
|------|-------------|
| Add `lastWatermarkUrl` to MonitoredSite | Track last-seen product for watermark |
| Implement watermark crawl logic | Paginate from newest until hitting known product, capped by Tier 1 token budget |
| Add "sort by newest" URL patterns | Per-adapter: new arrivals URL for each platform |
| Handle edge cases | Watermark not found within token budget → index found items, move watermark forward, log warning |
| Separate Tier 1 from Tier 2-4 scheduling | Independent schedule tracking per crawl type |

### Phase 5 — Keyword Matching Engine

**Scope: New matching service, KeywordGroup tables**

| Task | Description |
|------|-------------|
| Add KeywordGroup and KeywordAlias models | Prisma schema + migration |
| Seed common firearm keyword groups | Script with 50-100 groups |
| Implement keyword matcher service | On new ProductIndex entry → check all active Searches with alias expansion |
| Update search creation | Query ProductIndex with alias expansion → return instant results |
| Build admin keyword organizer UI | CRUD for keyword groups/aliases |

### Phase 6 — Cold Start & Onboarding

**Scope: Onboarding logic (token bucket already implemented in Phase 3)**

| Task | Description |
|------|-------------|
| Implement cold start phases | Budget capped at 10/hr for days 1-2, gradual ramp-up days 3-7 |
| Add `addedAt` tracking to MonitoredSite | For cold start phase calculation |
| Cold start override for admin | Admin can skip cold start for sites known to be safe |

### Phase 7 — FREE Tier Lifecycle

**Scope: Search expiry logic, notification changes**

| Task | Description |
|------|-------------|
| Add alert expiry (14 days for FREE) | Cron job to deactivate FREE user searches after 14 days |
| Update 3-alert cap enforcement | Search All counts as 1 toward limit |
| Change daily digest to 6 PM EST | Update cron schedule to 11 PM UTC |
| Add expiry warnings | Email user 2 days before alert expires with upgrade prompt |

### Phase 8 — Auction Specific

**Scope: Adapter changes, frontend timer**

| Task | Description |
|------|-------------|
| Add `closingAt` to ProductIndex | Auction lots store their closing time |
| Implement auction event detection | Adapter method to detect new auction events |
| Frontend countdown timer | Client-side timer component for auction lot matches |
| Auction discovery schedule | Separate longer interval (6-12 hr) for auction sites |

### Phase 9 — Guest Limits & Admin Portal

**Scope: Frontend + backend changes**

| Task | Description |
|------|-------------|
| Guest search limits | 5 searches per session, then registration prompt |
| Admin keyword organizer UI | Full CRUD for keyword groups/aliases |
| Admin ProductIndex browser | Browse/search indexed products per site |
| Admin capacity dashboard | New visualizations replacing difficulty/traffic class |
| Admin crawl controls | Force crawl, trigger catalog refresh, cold start override |

---

## 13. Data Migration

When transitioning from current system to catalog-based:

1. **Existing Match records** remain valid — they already contain matched products
2. **ProductIndex** starts empty and populates over time as crawls run
3. **No big-bang migration needed** — new system can run alongside old for a transition period
4. **Keyword groups** seeded from a prepared dataset, then refined by admin

---

## 14. Monitoring & Observability

### Key Metrics to Track

| Metric | What it shows |
|--------|-------------|
| Capacity per site (graph over time) | Site health trend — stable, declining, or recovering? |
| ProductIndex growth rate per site | Are we discovering new products? |
| Keyword match rate | What % of new products match active searches? |
| Token utilization per tier per site | Tier 1 vs Tier 2-4 usage — are we balanced? |
| Tier 1 pages per cycle | Self-adjusting indicator — busy sites crawl more pages |
| Tier 2-4 cycle completion time | How long does each catalog tier take to complete a full sweep? |
| Watermark age per site | Time since last watermark update — detects stale crawls |
| Min gap adherence | Are requests properly spaced per the min_gap rule? |
| Notification delivery rate | Email sent/failed ratio |
| User alert expiry rate (FREE) | How many FREE alerts expire vs get renewed? |

---

## Appendix A: Why NOT Included

| Concept | Source | Why Excluded |
|---------|--------|-------------|
| Per-product scheduling | Engineer A | We crawl site pages, not individual product URLs |
| Multi-lane priority queuing | Engineer B | 50 sites don't need 4 priority lanes |
| Popularity decay formula | Engineer A, B | With catalog model, keyword count doesn't affect crawl load |
| Multi-armed bandit | Engineer C | Not exploring unknown sites — we know all 50 |
| Complex PopScore formula | Engineer B | All enabled sites get crawled at their site-type rate |
| Load factor math | Engineer A | At ~100 req/hour total, nowhere near system overload |
| PID controller | Engineer C (excluded it too) | Nonlinear system, delayed feedback, hard constraints |
| Page-level hash change detection | Original plan | Too sensitive — any single price change or product removal changes the hash. Almost never detects "unchanged." Date-based tiers provide "crawl old stuff less often" behavior more reliably. |
| Page-number-based tiers | Original plan | Too static — page 10 on one site might be 2 days of items, on another 2 months. Date-based tiers are meaningful regardless of site structure. |

---

## Appendix B: Current vs v2 Comparison

| Aspect | Current | v2 |
|--------|---------|-----|
| Interval formula | 11 multipliers, unstable, oscillates | 3-step pressure/capacity, smooth, stable |
| Traffic classification | 4 categories (auto-detected, often wrong) | Continuous capacity (0-1), computed from real crawl data |
| Failure handling | Hard steps (3→1hr, 5→6hr), oscillates | Rolling average, gradual recovery |
| Crawl trigger | User endpoints can trigger crawls | Only scheduler + admin force-crawl trigger crawls |
| Keyword scaling | More keywords = more HTTP requests | Keywords matched in DB, zero HTTP impact |
| Token budget | None (global ceilings only) | Per-site token bucket (default 60/hr), capacity-scaled, min_gap enforced |
| Catalog refresh | Single-pass full crawl or none | Date-based 4-tier system: Tier 1 new items + Tiers 2-4 catalog (recent/aging/archive) |
| Classified sites | Same as retailers (broken at scale) | Tier 1 watermark + Tiers 2-4 catalog at low priority for unsold items |
| Auction sites | Same as retailers | Separate strategy: event discovery + lot indexing + closing timer |
| User search response | Wait for crawl or see stale data | Instant ProductIndex query with alias expansion |
| FREE tier | No expiry, weak limit enforcement | 3 alerts, 14-day expiry, daily digest 6 PM EST |
| Peak hours | Crawl slower during peak (wrong) | Crawl more during business hours to blend with real traffic |
| Rate limiting | Global safety ceilings only | Per-site token bucket + min_gap spacing |
| New site onboarding | Full speed immediately | Conservative cold start (10/hr), gradual ramp-up over 7 days |
