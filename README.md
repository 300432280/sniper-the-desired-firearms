# FirearmAlert

Canadian firearm market monitoring web app. Monitors 63 retailer websites, classifieds, forums, and auction platforms for user-defined keywords and sends email/SMS alerts when **new** matches are found.

---

## Stack

| Layer | Tech | Purpose |
|-------|------|---------|
| Frontend | Next.js 14 (App Router) + TailwindCSS | Dashboard, alert management, SEO pages |
| Backend | Express.js + TypeScript | REST API, scraper orchestration, test store |
| Database | PostgreSQL (Prisma ORM) | Users, searches, matches, monitored sites, health checks |
| Queue | BullMQ + Redis | Scheduled scrape jobs |
| Scraping | Axios + Cheerio + adapter framework | Platform-aware HTML/API extraction |
| Credential Encryption | AES-256-GCM | Encrypted storage for forum login credentials |
| Auth | JWT (httpOnly cookies) + bcrypt | Session management |
| Email | Resend | Alert notification emails |
| SMS | Twilio | Alert notification SMS |
| Frontend deploy | Vercel | Static + SSR hosting |
| Backend deploy | Railway | API + worker process |

---

## Architecture v3.1 -- Two-Phase Crawler

The crawler operates in two distinct phases per site. There is no automatic transition between phases -- an admin must approve the move from Bootstrap to Maintain.

### Phase 1: Bootstrap

Goal: index all products with complete data as fast as possible.

- **Single continuous paginated crawl** -- no date filters, no tier split.
- All catalog tokens go to one crawler. Self-queues next batch immediately.
- T1 watermark crawl runs concurrently to catch new listings.
- Must achieve near-100% product/price/stock coverage before admin approves transition.
- Transition command: `node scripts/verify-maintain-ready.js --transition`
- Readiness check: product count >= 80%, price coverage >= 95%, stock coverage >= 95%.

### Phase 2: Maintain

Goal: keep existing product data fresh and detect sold/deleted/wanted items.

T2-T4 verify products **from the database** by visiting each product's detail page. The `product-verifier.ts` service extracts title, price, stock status, and thumbnail via a three-layer fallback: JSON-LD, then OG meta tags, then HTML selectors.

| Detection | Action |
|-----------|--------|
| Alive | Update price/title/stock/thumbnail |
| Sold / out of stock | Set `stockStatus = out_of_stock` |
| Wanted listing | Set `category = wanted`, preserve separately |
| Deleted (404/gone) | Set `isActive = false`, all data preserved for reporting |
| 5 consecutive verify errors | Auto-delete (garbage collection) |

**Tier structure (Maintain phase):**

| Tier | Products Verified | Budget Share | Cooldown |
|------|-------------------|-------------|----------|
| T1 | New listings (watermark crawl) | 70% reserve | ~20 min interval |
| T2 | Verified 1-7 days ago | 42.5% of remainder | 3 hours |
| T3 | Verified 8-20 days ago | 32.5% of remainder | 5 hours |
| T4 | Verified 21+ days ago | 25% of remainder | 9 hours |

### T1: Watermark Crawl

Catches **new** listings using platform-specific sort-by-date URLs. Runs on interval (~20 min for retailers). Gets budget priority -- 70% of effective tokens are reserved for T1; unused T1 tokens flow to catalog tiers.

Sort URLs by platform: Shopify (`created-descending`), WooCommerce (`orderby=date`), BigCommerce (`?sort=newest`), Magento (`product_list_order=created_at`), Lightspeed (`?sort=newest`), ColdFusion (`?sort=new-arrivals`).

### Token Budget

Each site has a base hourly request budget (default 60, admin-configurable). Effective budget is scaled by the site's capacity score:

```
effective_budget = max(5, floor(BASE_BUDGET * capacity))
min_gap = 3600 / effective_budget  (seconds between requests to same site)
```

- T1 reserves 70% of effective budget.
- T2-T4 share the remaining 30% plus any unused T1 tokens.
- WAF-protected sites use 30s timeout (vs 15s default).

---

## Site Profile System (v3.1)

All 63 sites have a complete **SiteProfile** JSON stored in `MonitoredSite.siteProfile`. Zero hardcoded domain checks exist in adapter code.

A profile contains:
- Platform type, adapter, search URL, catalog URLs, sort parameter
- Per-page count, timeout overrides, WAF type, Playwright requirements
- Data flow documentation (e.g., "WP REST for discovery, Store API for prices")
- Crawler config: bootstrap/maintain methods, cooldowns, tier shares
- Custom selectors, Klevu API keys, forum sections
- Structural notes persisting across sessions

Generic adapters read from profiles for all site-specific behavior. New sites are onboarded via a DB insert -- no code changes required. Maintain cooldowns and tier shares are configurable per-site via the profile.

---

## Key Services

| Service | Purpose |
|---------|---------|
| `product-verifier.ts` | Visits detail pages, extracts via JSON-LD -> OG meta -> HTML selectors |
| `maintain-cooldown.ts` | Shared cooldown tracking between scheduler and worker |
| `waf-cookie-manager.ts` | Sucuri/WAF cookie solving with Playwright |
| `investigate-site.js` | 18-probe site investigation including C6 User Simulation Test |
| `verify-maintain-ready.js` | Checks coverage >= 80%, price >= 95%, stock >= 95%; runs transition |

**Store API enrichment:** 3x retry with fresh cookies, 800ms delay between chunks.

---

## Product Tracking

- **140,000+ products** across 63 sites.
- **sourceId tracking** -- platform-stable IDs (Shopify product ID, WP post ID, Drupal node ID, etc.) prevent duplicates when sellers edit listing titles.
- **Deleted products**: `isActive = false`, all data preserved for reporting and analytics.
- **Wanted items**: `category = wanted`, preserved separately.

### sourceId by Platform

| Platform | sourceId Source | Stable across edits? |
|----------|---------------|---------------------|
| Shopify | `product.id` from API | Yes |
| WooCommerce | `post_id` from WP REST API | Yes |
| BigCommerce | `data-product-id` HTML attr | Yes |
| Drupal (Gunpost) | `data-history-node-id` attr | Yes |
| iCollector | `ItemID` from API | Yes |
| HiBid | Lot ID from URL | Yes |
| XenForo | Thread ID from URL | Yes |
| ColdFusion (Bullseye) | Numeric ID from URL slug | Yes |

When a seller edits a listing title (changing the URL slug), the sourceId match updates the existing row instead of creating a duplicate. Match records link to ProductIndex via `productIndexId` FK for live data enrichment -- users always see current titles and prices.

---

## Keyword Matching (Zero HTTP)

```
User creates alert (keyword)
        |
        v
  Expand keyword via KeywordAlias table (e.g., "ruger 1022" -> "ruger 10/22", "10/22", "ruger 10 22")
        |
        v
  Query ProductIndex with all aliases (SQL, instant)
        |
        v
  Return existing matches immediately + monitor for new products going forward
```

---

## Scraper Framework

The scraper uses an **adapter-based architecture** where each site is matched to the best adapter for its platform. The adapter registry reads from the `MonitoredSite` database table and caches lookups for 5 minutes.

### Adapter Pipeline

```
scrapeWithAdapter(url, keyword, options)
  |
  +-> Resolve adapter via AdapterRegistry (domain -> MonitoredSite -> adapterType)
  |
  +-> Step 1: Try API search (if adapter supports it)
  |   - WooCommerce Store API: /wp-json/wc/store/v1/products?search=...
  |   - WooCommerce WP REST: /wp-json/wp/v2/product?search=...
  |   - iCollector CloudSearch JSON API
  |   - Only accepted if results include prices (otherwise falls back to HTML)
  |
  +-> Step 2: Fetch search URL + adapter HTML extraction
  |   - Uses searchUrlPattern from DB, or adapter's getSearchUrl()
  |   - Cheerio-based extraction with platform-specific selectors
  |
  +-> Step 3: Paginate (if adapter supports getNextPageUrl)
  +-> Step 4: Set seller, deduplicate by URL, compute content hash
```

### Adapters

| Adapter | Platform | Sites | Search URL | Key Selectors |
|---------|----------|-------|------------|---------------|
| `ShopifyAdapter` | Shopify | 2 | `/search?q={kw}&type=product` | `[data-product-id]`, `.product-card` |
| `WooCommerceAdapter` | WooCommerce | 17 | `/?s={kw}&post_type=product` | `li.product`, `.wd-product`, `div[class*="product"]` |
| `GenericRetailAdapter` | BigCommerce, Magento, nopCommerce, custom PHP | 23 | Configurable via `searchUrlPattern` | `.card`, `.product-item`, link-based fallback |
| `GunpostAdapter` | Drupal classifieds | 1 | `/ads?key={kw}` | Listing card selectors |
| `XenForoAdapter` | XenForo forums | 2 | `/search/?q={kw}&t=post` | `.structItem`, thread selectors |
| `VBulletinAdapter` | vBulletin forums | -- | `/search.php?do=process` | `.threadtitle a` |
| `ICollectorAdapter` | iCollector | 1 | CloudSearch JSON API | JSON lot parsing |
| `HiBidAdapter` | HiBid | 1 | `?searchPhrase={kw}` | Lot card selectors |
| `GenericAuctionAdapter` | Generic auctions | 2 | Site-specific | `[class*="lot"]`, bid price extraction |
| `GenericAdapter` | Ultimate fallback | 1 | `/search?q={kw}` | All selector families |

### Extraction Features

- **Smart title extraction** -- Prefers `.card-title`, `.product-title`, `[class*="title"]` over raw h-tags (avoids grabbing brand-only headings on BigCommerce).
- **Multi-strategy price extraction** -- Tries sale/discount selectors first, then platform-specific classes, then iterates all `[class*="price"]` elements (skipping struck-through/regular prices), then falls back to full-text regex. Extracts both sale price and regular price.
- **Sale price + strikethrough display** -- `regularPrice` field tracks the original price. Frontend shows strikethrough regular price next to the sale price.
- **Lazy-load thumbnail handling** -- Prefers `data-src` over `src`, detects placeholder/loading SVGs.
- **Link-based fallback** -- When no product card selectors match, extracts from `<a>` tags whose text contains the keyword.
- **WooCommerce API** -- Tries Store API and WP REST API before HTML (5s timeout in fast mode).
- **Stock detection** -- Heuristic based on in-stock/out-of-stock patterns. Detects OOS signals including "notify me when", "back in stock", "email when available", "waitlist", "pre-order", "currently unavailable", "coming soon".
- **Price from forum titles** -- Extracts "$450 OBO" patterns from marketplace thread titles.
- **Auction bid prices** -- Extracts "Current Bid: $1,200" patterns.
- **Product classification** -- 7-category system (firearm, ammunition, optics, parts, gear, knives, other) with 4-layer fallback: source category, strong pattern match, brand+model, caliber-based.

### Monitored Sites (63 active)

| Category | Count | Examples |
|----------|-------|---------|
| Retailers (WooCommerce) | 20+ | Lever Arms, Corwin Arms, Rangeview Sports, Marstar, CTC Supplies, Bullseye London |
| Retailers (BigCommerce) | 8 | Wolverine Supplies, Al Flaherty's, The Ammo Source, Frontier Firearms |
| Retailers (Magento) | 3 | Ellwood Epps, RDSC, True North Arms |
| Retailers (Shopify) | 3 | Fish World Guns, Jo Brook Outdoors, Tenda Canada |
| Retailers (Other) | 15+ | iRunGuns, Reliable Gun, Cabela's, Bass Pro, Canadian Tire, SAIL, Prophet River |
| Forums | 2 | Canadian Gun Nutz (XenForo), Gun Owners of Canada (XenForo) |
| Classifieds | 2 | GunPost, TownPost |
| Auctions | 4 | iCollector, HiBid Canada, Miller & Miller, Switzer's |

### Playwright Fallback

A shared headless Chromium instance (lazy-launched, auto-closed after 5 min idle) handles JS-rendered sites:

- **Trigger conditions**: Static HTML < 2KB, or Incapsula WAF challenge detected, or 0 matches from large HTML (SPA).
- **Anti-detection**: `--disable-blink-features=AutomationControlled`, realistic viewport/locale/user-agent.
- **Resource blocking**: Images, fonts, media, stylesheets blocked for speed.
- **Incapsula handling**: Detects `_Incapsula_Resource` challenge, waits for JS resolution + cookie set + page reload.
- **Idle management**: Browser auto-closes after 5 minutes of inactivity, graceful shutdown on SIGTERM.

### HTTP Client

- **Sucuri WAF bypass** -- Solves JavaScript challenges via `vm.runInNewContext` (Base64 decode), carries cookies across redirect chains.
- **User agent rotation** -- Deterministic per-domain (MD5 hash picks from 4 UAs so the same site always sees the same browser).
- **Rate limiting** -- Difficulty-aware delays (1-4s between requests, higher for difficult sites).
- **Retry with backoff** -- 3 attempts with exponential backoff (2s base).
- **Difficulty signal detection** -- Auto-detects WAF (Cloudflare/Sucuri headers), rate limits (HTTP 429), CAPTCHAs (body keywords).

---

## Unified Crawl Scheduler

Sites are crawled on a **site-level schedule** (not per-user). One crawl per site serves all users who have searches on that site. A BullMQ cron job ticks every 2 minutes and queues crawls for due sites.

### Safety Ceilings (hard limits, no override)

| Limit | Value |
|-------|-------|
| Max concurrent crawls | 10 |
| Max crawls per site per hour | 4 |
| Max global crawls per hour | 200 |
| Crawl lock timeout | 5 minutes (auto-expire) |

### Pressure/Capacity Model

**Step 1 -- Site Pressure** (rolling window of last 20 crawls):

```
pressure = 0.4 * failure_rate          (HTTP errors / total crawls)
         + 0.2 * block_rate            (429 + captcha + WAF / total)
         + 0.2 * latency_score         (normalized 0-1: 0=fast, 1=very slow)
         + 0.2 * extraction_failure_rate (200 OK but 0 matches / total)

Clamped to [0, 1]

Latency score auto-adapts to site type:
  Standard sites: 500ms -> 0, 10s -> 1
  Playwright-heavy sites (hasWaf or avgMs > 5s): 5s -> 0, 45s -> 1
```

**Step 2 -- Capacity:**

```
capacity = e^(-3 * pressure)
```

| Pressure | Capacity | Interpretation |
|----------|----------|---------------|
| 0.0 | 1.00 | Fully healthy |
| 0.1 | 0.74 | Occasional hiccups |
| 0.3 | 0.41 | Moderate issues |
| 0.5 | 0.22 | Significant pushback |
| 1.0 | 0.05 | Nearly blocked |

**Step 3 -- Interval Computation:**

```
Base rate by site type:
  Forum / Classified: 4/hour (every 15 min)
  Retailer:           2/hour (every 30 min)
  Auction:            0.17/hour (every 6 hours)

target_rate = base_rate * capacity
interval = 60 / target_rate  (minutes), clamped to [15, 1440]

Peak hours (9 AM - 9 PM EST): interval * 0.85
Off-peak: interval * 1.2
```

### Catalog URL Resolution

| Path | Adapters | URL Source | How it works |
|------|----------|------------|--------------|
| **API-based** | Shopify, WooCommerce, iCollector | `fetchCatalogPage(origin, page)` | Paginated JSON API -- structured data with prices, stock, images. |
| **HTML-based** | GenericRetail (BigCommerce, Magento, custom PHP) | `getCatalogUrls(origin)` | Per-site category/listing page URLs crawled with Cheerio + optional Playwright for WAF sites. |

### Cold Start (New Site Onboarding)

| Phase | Duration | Budget Cap | Catalog Tiers |
|-------|----------|-----------|---------------|
| Probe | Hours 0-6 | 10 req/hr (hard cap) | Tier 1 only |
| Ramp | Hours 6-48 | `min(BASE, 10 + hours*2)` | All tiers begin |
| Steady | Hour 48+ | Full BASE_BUDGET | Normal operation |

Admin can skip cold start via `coldStartOverride` for sites known to be safe.

### Failure Backoff

| Condition | Action |
|-----------|--------|
| Any failure | 30 min minimum interval |
| 3+ consecutive failures | 1 hour circuit breaker |
| 5+ consecutive failures | 6 hour backoff |
| Blocked / CAPTCHA | 2 hour minimum |
| 10+ consecutive failures | Site auto-disabled |

---

## Deduplication & Delta Detection

1. **DB-level**: `@@unique([searchId, url])` constraint on the `Match` model prevents duplicate rows.
2. **Worker-level**: Before inserting, the worker queries all existing match URLs for the search. Only URLs not already in the DB are treated as "new" and trigger notifications.
3. **Content hash**: A SHA-256 hash of sorted match URLs is stored as `lastMatchHash` on the Search. If the hash hasn't changed since the last check, the worker skips all processing.

---

## Notification Flow

1. Worker detects new matches via URL delta.
2. A `Notification` record is created **before** sending (to generate the notification ID for the landing page URL).
3. New matches are linked to the notification via `NotificationMatch` join table.
4. Email/SMS is sent with a link to `/notifications/{id}` -- a self-contained HTML landing page.
5. Notification status is updated to `sent` or `failed`.

### Notification Tiers

| Tier | Active Alerts | Alert Duration | Delivery | Timing |
|------|---------------|----------------|----------|--------|
| PRO ($14/mo) | Unlimited | Never expires | Email + SMS | Instant (on match detection) |
| FREE | 3 max | 14 days per alert | Email only | Daily digest (6 PM EST / 11 PM UTC) |
| Guest | Search only | -- | -- | -- |

**FREE tier rules:** Each alert auto-expires 14 days after creation. "Search All Sites" counts as 1 alert toward the 3-alert limit (the group, not per-site). User can recreate the same keyword alert to reset the 14-day clock.

---

## Search All Sites

The "Search All Sites" feature creates a grouped alert that scans across all 63 enabled monitored sites simultaneously.

### How it works:

1. User creates an alert with "Search All Canadian Sites" toggle enabled.
2. Backend generates a `searchAllGroupId` and creates one `Search` record per enabled `MonitoredSite`.
3. Group scan endpoint scrapes all sites in parallel (all-concurrent with 20s per-site timeout).
4. Results are aggregated and displayed in a unified match history sorted by date.

### Group API:

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/searches` (with `searchAll: true`) | Create grouped alert |
| GET | `/api/searches/group/:groupId` | Get group with aggregated matches |
| POST | `/api/searches/group/:groupId/scan` | Scan all sites (SSE progress events) |
| PATCH | `/api/searches/group/:groupId/toggle` | Pause/resume all in group |
| DELETE | `/api/searches/group/:groupId` | Delete entire group |

---

## Site Verification & Testing

### investigate-site.js (18 probes)

Comprehensive per-site investigation including the C6 User Simulation Test:

```bash
node scripts/investigate-site.js <domain>           # full test (DB + live HTTP)
node scripts/investigate-site.js <domain> --db-only  # fast (DB checks only)
node scripts/investigate-site.js <domain> --json     # JSON output
```

**Probes:**

| Category | Probe | What it checks |
|----------|-------|---------------|
| DB State | A1: Stream State | Tier partitioning, stuck tiers, expired cooldowns |
| DB State | A2: Crawl Events | Success rate, phantom successes, response time trends, gaps |
| DB State | A3: Product Index | Freshness, price/stock/thumbnail coverage, stale products |
| DB State | A4: Watermark | Watermark validity and age |
| DB State | A5: sourceId Coverage | % of products with platform-stable IDs |
| Live | B1: Platform Detection | Detect if adapter type is wrong |
| Live | B4: Pagination | Discover totalPages from HTML |
| Simulation | C1: Multi-Keyword Search | 30 keywords tested against DB |
| Simulation | C2: Product Spot-Check | Random products: URL resolves, title matches page |
| Simulation | C3: Data Accuracy | Title, price, thumbnail, sourceId, URL, Match staleness -- 15 products sampled |
| Simulation | C4: Duplicate Detection | Products sharing same sourceId (should be 0) |
| Simulation | C6: User Simulation | End-to-end user journey test |

### verify-maintain-ready.js

```bash
node scripts/verify-maintain-ready.js <domain>                # check readiness
node scripts/verify-maintain-ready.js <domain> --transition    # approve transition to maintain
```

Checks: product count >= 80% of live catalog, price coverage >= 95%, stock coverage >= 95%.

### verify-site.js (data quality)

```bash
node scripts/verify-site.js <domain>               # full (52 keywords)
node scripts/verify-site.js <domain> --quick        # quick (12 keywords)
node scripts/verify-site.js --all                   # all enabled sites
```

9 test suites: schema validation, data quality scoring, keyword search comparison (DB vs live API), stock accuracy, thumbnail validation, API health check, catalog freshness, sourceId coverage, match freshness.

---

## Database Schema

```prisma
model User {
  id, email (unique), passwordHash, phone?, tier (FREE|PRO)
  -> searches[], credentials[]
}

model SiteCredential {
  id, userId, domain, username, encryptedPassword (AES-256-GCM), sessionCookies?
  @@unique([userId, domain])
}

model Search {
  id, userId?, credentialId?, keyword, websiteUrl,
  checkInterval (0=10s test, 5/30/60 min),
  notificationType (EMAIL|SMS|BOTH), notifyEmail?,
  isActive, inStockOnly, maxPrice?, lastChecked?, lastMatchHash?,
  expiresAt?, searchAllGroupId?
  -> matches[], notifications[]
}

model Match {
  id, searchId, productIndexId?,  // FK to ProductIndex (nullable for legacy matches)
  title, price?, regularPrice?, url, hash, thumbnail?, postDate?, seller?, foundAt
  @@unique([searchId, url])
  // When displaying matches, title/price/url are enriched from ProductIndex via productIndexId FK
}

model Notification {
  id, searchId, type, sentAt, status (pending|sent|failed)
  -> matches[] (via NotificationMatch join)
}

model MonitoredSite {
  id, domain (unique), name, url, siteType, adapterType,
  isEnabled, requiresSucuri, requiresAuth, searchUrlPattern?, notes?,

  // Site Profile (v3.1)
  siteProfile (Json),           // Complete site-specific config -- platform, URLs, WAF, selectors

  // Crawl scheduling
  lastCrawlAt?, nextCrawlAt?, crawlIntervalMin (default 120),
  crawlLock?, crawlLockExpiresAt?,

  // Catalog fields
  lastWatermarkUrl?,          // Last-known product URL for T1 watermark crawl
  tierState (Json),           // Per-tier cycle state
  addedAt,                    // For cold start phase calculation
  coldStartOverride (false),  // Admin can skip cold start
  baseBudget (60),            // Hourly token budget (admin-configurable)

  // Difficulty signals (auto-measured)
  avgResponseTimeMs?, consecutiveFailures,
  hasWaf, hasRateLimit, hasCaptcha,

  // Per-site crawl tuning (JSON overrides, null -> use defaults)
  crawlTuning? (Json),
  -> healthChecks[], crawlEvents[], products[]
}

model ProductIndex {
  id, siteId, url,
  sourceId?,            // Platform-stable product ID
  title, price?, regularPrice?, stockStatus?, thumbnail?,
  category? ("new"|"used"|"auction_lot"|"classified"),
  productType? ("firearm"|"ammunition"|"optics"|"parts"|"gear"|"knives"|"other"),
  tags?,                // Comma-separated product tags from source
  closingAt?,           // For auction lots
  firstSeenAt, lastSeenAt, isActive
  matches Match[]
  @@unique([siteId, url])
  @@unique([siteId, sourceId]) WHERE sourceId IS NOT NULL
  @@index([siteId, sourceId])
  @@index([siteId, lastSeenAt])
  @@index([title])
}

model KeywordGroup {
  id, canonicalName (unique)   // e.g. "Ruger 10/22"
  -> aliases[]
}

model KeywordAlias {
  id, groupId, alias (unique)  // e.g. "ruger 1022", "10/22", "ruger 10 22"
  @@index([alias])
}

model CrawlEvent {
  id, siteId, status (success|fail|timeout|blocked|captcha),
  responseTimeMs?, statusCode?, matchesFound, errorMessage?, crawledAt
  @@index([siteId, crawledAt])
}

model SiteHealthCheck {
  id, siteId, isReachable, canScrape, responseTimeMs?, errorMessage?, checkedAt
  @@index([siteId, checkedAt])
}

model SiteMap {
  id, domain (unique), siteType, listingUrls, searchUrl?, hitCount
}
```

---

## Local Development

### Prerequisites

- Node.js 22+
- Docker Desktop (for local PostgreSQL + Redis) **OR** remote Neon/Upstash URLs

### 1. Start infrastructure

**Option A -- Docker (local):**
```bash
docker compose up -d
```
This starts PostgreSQL on port 5432 and Redis on port 6379.

**Option B -- Cloud (remote):**
Use [Neon](https://neon.tech) for PostgreSQL and [Upstash](https://upstash.com) for Redis. Set their URLs in `backend/.env`.

### 2. Configure backend environment

```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env`:

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `REDIS_URL` | Yes | Redis connection string (supports `rediss://` for TLS) |
| `JWT_SECRET` | Yes | Long random string for signing tokens |
| `JWT_EXPIRY` | No | Token expiry (default: `7d`) |
| `BCRYPT_ROUNDS` | No | Password hash rounds (default: `10`) |
| `PORT` | No | Server port (default: `4000`) |
| `NODE_ENV` | No | `development` or `production` |
| `FRONTEND_URL` | No | Frontend URL (default: `http://localhost:3000`) |
| `BACKEND_URL` | No | Backend URL for notification links (default: `http://localhost:4000`) |
| `RESEND_API_KEY` | Yes | From [resend.com](https://resend.com) (free tier) |
| `FROM_EMAIL` | No | Sender email (default: `alerts@firearm-alert.ca`) |
| `TWILIO_ACCOUNT_SID` | No | From [twilio.com](https://twilio.com) (for SMS) |
| `TWILIO_AUTH_TOKEN` | No | Twilio auth token |
| `TWILIO_FROM_NUMBER` | No | Twilio phone number |
| `ADMIN_EMAILS` | No | Comma-separated admin emails |

### 3. Configure frontend environment

```bash
cp frontend/.env.local.example frontend/.env.local
```

| Variable | Default | Description |
|----------|---------|-------------|
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` | Backend API URL (proxied via Next.js rewrite) |

### 4. Install dependencies

```bash
npm install
```

This installs dependencies for root, backend, and frontend workspaces.

### 5. Create database tables

```bash
npm run db:push
```

Runs `prisma db push` -- creates tables from the schema and generates the Prisma client.

### 6. Seed monitored sites and keywords

```bash
cd backend && npx ts-node src/scripts/seed-sites.ts
cd backend && npx ts-node src/scripts/seed-keywords.ts
```

- **seed-sites.ts**: Populates the `MonitoredSite` table with 63 Canadian firearm retailer/forum/auction sites, each tagged with the correct adapter type, search URL pattern, and site category.
- **seed-keywords.ts**: Populates the `KeywordGroup` and `KeywordAlias` tables with 68 keyword groups and 238 aliases covering common firearm models, calibers, and optics.

### 7. Start both servers

```bash
npm run dev
```

| Service | URL |
|---------|-----|
| Frontend | http://localhost:3000 |
| Backend API | http://localhost:4000 |
| Test Store | http://localhost:4000/test-page |
| Notification Preview | http://localhost:4000/test-page/notification-preview |
| Debug Log (admin) | http://localhost:3000/dashboard/admin/debug |
| Prisma Studio | `npm run db:studio` -> http://localhost:5555 |

---

## Admin System

Admin users are defined by the `ADMIN_EMAILS` environment variable. Admins get:

1. **All Pro features unlocked** -- 5-min checks, SMS, BOTH notifications (regardless of tier).
2. **10-second test interval** -- Special `checkInterval: 0` option for rapid testing.
3. **Test Store access** -- Dynamic product page at `/test-page` with add/remove/reset controls and notification preview.
4. **Admin toolbar** in the dashboard -- Quick links to Test Store, Debug Log, Match History, Site Monitor.
5. **Debug Log SSE** -- Real-time streaming of scrape events, match detections, email/SMS sends.
6. **Site Monitor dashboard** -- Crawl metrics, difficulty/interval breakdowns, signal badges, overrides.
7. **Site management** -- CRUD for monitored sites, health check triggers, test scrape, force crawl.

### Site Monitor Dashboard (`/dashboard/admin/sites`)

Table showing all 63 monitored sites with:
- Adapter type and traffic class badge
- Capacity gauge (pressure/capacity model) and difficulty score
- Crawl interval with pressure breakdown (clickable)
- Next crawl countdown timer
- Last crawl status, response time, matches found
- Consecutive failures count
- Signal badges: WAF, Rate Limit, CAPTCHA, Sucuri
- Active search count
- ProductIndex count per site
- Enable/disable toggle

Features: sortable columns, filterable by adapter/traffic/enabled, auto-refreshes every 60 seconds.

### Admin Account Setup

1. Register a user at http://localhost:3000/register
2. Add their email to `ADMIN_EMAILS` in `backend/.env`
3. Restart the backend server
4. The user now has admin privileges

---

## Test Store

The test store (`/test-page`) is a dynamic in-memory product listing page that mimics a real retailer website. It allows end-to-end testing of the entire notification pipeline.

### How to test notifications:

1. Log in as admin at http://localhost:3000/login
2. Go to **+ New Alert**, set:
   - Keyword: a word that matches test products (e.g., `rifle`)
   - URL: `http://localhost:4000/test-page`
   - Check interval: **10 Sec** (admin-only test mode)
3. The alert is created and initial matches are found.
4. Open the **Test Store** (button in dashboard or http://localhost:4000/test-page)
5. Add a new listing with a title containing the keyword.
6. Within 10 seconds, the worker detects the new listing and sends a notification.
7. Click **Scan Now** on the alert card to see results with **NEW** badges.
8. Click the **match count** on any alert card to expand and see all historical matches.

### Test Store Admin Controls:

- **Add Listing** -- Title, price, stock status; generates a slug-based URL.
- **Remove** -- Delete individual listings.
- **Reset** -- Restore all default listings.
- **Recent Notifications** panel -- Preview links to notification landing pages.
- **Preview Notification** -- Dedicated page showing mock notification landing page, email template, and SMS text.

---

## API Endpoints

### Auth

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | -- | Create account |
| POST | `/api/auth/login` | -- | Login (returns JWT cookie) |
| POST | `/api/auth/logout` | -- | Clear JWT cookie |
| GET | `/api/auth/me` | Cookie | Current user info |
| PATCH | `/api/auth/profile` | Cookie | Update phone number |

### Searches (Alerts)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/searches` | Cookie | List user's alerts |
| POST | `/api/searches` | Optional | Create alert (supports `searchAll: true`) |
| GET | `/api/searches/:id` | Cookie | Single alert with matches |
| DELETE | `/api/searches/:id` | Cookie | Delete alert |
| PATCH | `/api/searches/:id/toggle` | Cookie | Pause/resume alert |
| POST | `/api/searches/:id/scan` | Cookie | Manual scan with SSE progress |
| GET | `/api/searches/matches/:searchId` | Cookie | Match history |

### Search All Groups

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/searches/group/:groupId` | Cookie | Group with aggregated matches |
| POST | `/api/searches/group/:groupId/scan` | Cookie | Parallel scan all sites (SSE) |
| PATCH | `/api/searches/group/:groupId/toggle` | Cookie | Pause/resume group |
| DELETE | `/api/searches/group/:groupId` | Cookie | Delete entire group |

### Credentials

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/searches/credentials` | Cookie | List stored site credentials |
| POST | `/api/searches/credentials` | Cookie | Store encrypted credential |
| DELETE | `/api/searches/credentials/:id` | Cookie | Delete credential |

### Admin

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/admin/sites` | Admin | List all monitored sites with health check |
| POST | `/api/admin/sites` | Admin | Add monitored site |
| PATCH | `/api/admin/sites/:id` | Admin | Update site config |
| DELETE | `/api/admin/sites/:id` | Admin | Remove site (cascades health checks + crawl events) |
| POST | `/api/admin/sites/:id/test` | Admin | Test scrape a site with keyword |
| GET | `/api/admin/sites/dashboard` | Admin | All sites with crawl metrics, difficulty, priority |
| PATCH | `/api/admin/sites/:id/overrides` | Admin | Set admin overrides (traffic, difficulty, interval) |
| POST | `/api/admin/crawl-now` | Admin | Force immediate crawl of all enabled sites |
| GET | `/api/admin/health` | Admin | Latest health check results |
| POST | `/api/admin/health/run` | Admin | Trigger manual health check |
| POST | `/api/admin/health/prune` | Admin | Prune old health data |
| GET | `/api/admin/debug-log` | Admin | SSE stream of debug events |
| GET | `/api/admin/debug-log/history` | Admin | Buffered debug events (JSON) |
