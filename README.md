# FirearmAlert

Canadian firearm market monitoring web app. Monitors 50+ retailer websites, classifieds, forums, and auction platforms for user-defined keywords and sends email/SMS alerts when **new** matches are found. Uses an adapter-based scraping framework with platform-specific adapters for Shopify, WooCommerce, BigCommerce, Magento, and more. Supports "Search All Sites" to scan across the entire monitored network in one click. Includes authenticated forum scanning with encrypted credential storage and a built-in test store for end-to-end testing.

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

## Architecture Overview

```
User creates alert (keyword + URL) — or "Search All Sites"
        |
        v
  +-------------+     +--------------+
  | Express API |---->| PostgreSQL   |  (Search, Match, MonitoredSite, Notification)
  +------+------+     +--------------+
         |
         v
  +-------------+     +--------------+
  | BullMQ      |<--->| Redis        |  (Repeating jobs)
  | Worker      |     +--------------+
  +------+------+
         | every N minutes (or 10s in test mode)
         v
  +--------------------+
  | Adapter Registry   |  Domain -> adapter lookup (cached 5min)
  +--------+-----------+
           |
           v
  +-----------------------+
  | Scraper Engine (v2)   |
  | 1. Try API (WC Store) |
  | 2. Fetch HTML         |
  | 3. Adapter extraction |
  | 4. Paginate           |
  +-----------+-----------+
              |
              v
  Delta Detection (URL-based)
  +-- New URLs   -> INSERT into matches table
  |              -> Create Notification -> Send Email/SMS
  +-- Known URLs -> UPDATE title/price/thumbnail only (no notification)
```

### Deduplication & Delta Detection

1. **DB-level**: `@@unique([searchId, url])` constraint on the `Match` model prevents duplicate rows.
2. **Worker-level**: Before inserting, the worker queries all existing match URLs for the search. Only URLs not already in the DB are treated as "new" and trigger notifications.
3. **Content hash**: A SHA-256 hash of sorted match URLs is stored as `lastMatchHash` on the Search. If the hash hasn't changed since the last check, the worker skips all processing.

### Notification Flow

1. Worker detects new matches via URL delta.
2. A `Notification` record is created **before** sending (to generate the notification ID for the landing page URL).
3. New matches are linked to the notification via `NotificationMatch` join table.
4. Email/SMS is sent with a link to `/notifications/{id}` — a self-contained HTML landing page.
5. Notification status is updated to `sent` or `failed`.

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
| `VBulletinAdapter` | vBulletin forums | — | `/search.php?do=process` | `.threadtitle a` |
| `ICollectorAdapter` | iCollector | 1 | CloudSearch JSON API | JSON lot parsing |
| `HiBidAdapter` | HiBid | 1 | `?searchPhrase={kw}` | Lot card selectors |
| `GenericAuctionAdapter` | Generic auctions | 2 | Site-specific | `[class*="lot"]`, bid price extraction |
| `GenericAdapter` | Ultimate fallback | 1 | `/search?q={kw}` | All selector families |

### Extraction Features

- **Smart title extraction** — Prefers `.card-title`, `.product-title`, `[class*="title"]` over raw h-tags (avoids grabbing brand-only headings on BigCommerce)
- **Multi-strategy price extraction** — Tries platform-specific price classes (`.price--withoutTax`, `.woocommerce-Price-amount`), then iterates all `[class*="price"]` elements, then falls back to full-text regex
- **Lazy-load thumbnail handling** — Prefers `data-src` over `src`, detects placeholder/loading SVGs
- **Link-based fallback** — When no product card selectors match, extracts from `<a>` tags whose text contains the keyword
- **WooCommerce API** — Tries Store API and WP REST API before HTML (5s timeout in fast mode)
- **Stock detection** — Heuristic based on "in stock" / "out of stock" / disabled cart button patterns
- **Price from forum titles** — Extracts "$450 OBO" patterns from marketplace thread titles
- **Auction bid prices** — Extracts "Current Bid: $1,200" patterns

### Monitored Sites (50 active)

| Category | Count | Examples |
|----------|-------|---------|
| Retailers (WooCommerce) | 17 | Lever Arms, Corwin Arms, Rangeview Sports, Marstar, CTC Supplies |
| Retailers (BigCommerce) | 8 | Wolverine Supplies, Al Flaherty's, The Ammo Source, Frontier Firearms |
| Retailers (Magento) | 3 | Ellwood Epps, RDSC, True North Arms |
| Retailers (Shopify) | 2 | Fish World Guns, Jo Brook Outdoors |
| Retailers (Other) | 12 | iRunGuns, Reliable Gun, Cabela's, Bass Pro, Canadian Tire, SAIL |
| Forums | 2 | Canadian Gun Nutz (XenForo), Gun Owners of Canada (XenForo) |
| Classifieds | 2 | GunPost, TownPost |
| Auctions | 4 | iCollector, HiBid Canada, Miller & Miller, Switzer's |

### HTTP Client

- **Sucuri WAF bypass** — Solves JavaScript challenges, carries cookies across redirect chains, normalizes `www.` domain variants
- **User agent rotation** — Random selection from 8 modern browser user agents
- **Rate limiting** — Randomized delays (800–2500ms) between requests
- **Retry with backoff** — 3 attempts with exponential backoff

---

## Search All Sites

The "Search All Sites" feature creates a grouped alert that scans across all 50 enabled monitored sites simultaneously.

### How it works:

1. User creates an alert with "Search All Canadian Sites" toggle enabled
2. Backend generates a `searchAllGroupId` and creates one `Search` record per enabled `MonitoredSite`
3. Group scan endpoint scrapes all sites in parallel (all-concurrent with 20s per-site timeout)
4. Results are aggregated and displayed in a unified match history sorted by date

### Group API:

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/searches` (with `searchAll: true`) | Create grouped alert |
| GET | `/api/searches/group/:groupId` | Get group with aggregated matches |
| POST | `/api/searches/group/:groupId/scan` | Scan all sites (SSE progress events) |
| PATCH | `/api/searches/group/:groupId/toggle` | Pause/resume all in group |
| DELETE | `/api/searches/group/:groupId` | Delete entire group |

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
  id, searchId, title, price?, url, hash, thumbnail?, postDate?, seller?, foundAt
  @@unique([searchId, url])
}

model Notification {
  id, searchId, type, sentAt, status (pending|sent|failed)
  -> matches[] (via NotificationMatch join)
}

model MonitoredSite {
  id, domain (unique), name, url, siteType, adapterType,
  isEnabled, requiresSucuri, requiresAuth, searchUrlPattern?, notes?
  -> healthChecks[]
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

- Node.js 20+
- Docker Desktop (for local PostgreSQL + Redis) **OR** remote Neon/Upstash URLs

### 1. Start infrastructure

**Option A — Docker (local):**
```bash
docker compose up -d
```
This starts PostgreSQL on port 5432 and Redis on port 6379.

**Option B — Cloud (remote):**
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

Runs `prisma db push` — creates tables from the schema and generates the Prisma client.

### 6. Seed monitored sites

```bash
cd backend && npx ts-node src/scripts/seed-sites.ts
```

Populates the `MonitoredSite` table with 50 Canadian firearm retailer/forum/auction sites, each tagged with the correct adapter type and search URL pattern.

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

1. **All Pro features unlocked** — 5-min checks, SMS, BOTH notifications (regardless of tier).
2. **10-second test interval** — Special `checkInterval: 0` option for rapid testing.
3. **Test Store access** — Dynamic product page at `/test-page` with add/remove/reset controls and notification preview.
4. **Admin toolbar** in the dashboard — Quick links to Test Store, Debug Log, Match History.
5. **Debug Log SSE** — Real-time streaming of scrape events, match detections, email/SMS sends.
6. **Site management** — CRUD for monitored sites, health check triggers, test scrape.

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

- **Add Listing** — Title, price, stock status; generates a slug-based URL
- **Remove** — Delete individual listings
- **Reset** — Restore all default listings
- **Recent Notifications** panel — Preview links to notification landing pages
- **Preview Notification** — Dedicated page showing mock notification landing page, email template, and SMS text

---

## API Endpoints

### Auth

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | — | Create account |
| POST | `/api/auth/login` | — | Login (returns JWT cookie) |
| POST | `/api/auth/logout` | — | Clear JWT cookie |
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
| GET | `/api/admin/sites` | Admin | List all monitored sites |
| POST | `/api/admin/sites` | Admin | Add monitored site |
| PATCH | `/api/admin/sites/:id` | Admin | Update site config |
| DELETE | `/api/admin/sites/:id` | Admin | Remove site |
| POST | `/api/admin/sites/:id/test` | Admin | Test scrape a site |
| GET | `/api/admin/health` | Admin | Latest health check results |
| POST | `/api/admin/health/run` | Admin | Trigger manual health check |
| POST | `/api/admin/health/prune` | Admin | Prune old health data |
| GET | `/api/admin/debug-log` | Admin | SSE stream of debug events |
| GET | `/api/admin/debug-log/history` | Admin | Buffered debug events (JSON) |

### Backend Pages (HTML)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/test-page` | Test store listings |
| GET | `/test-page/notification-preview` | Mock notification preview |
| POST | `/test-page/add` | Add test listing (admin) |
| POST | `/test-page/remove/:slug` | Remove test listing (admin) |
| POST | `/test-page/reset` | Reset test listings (admin) |
| GET | `/notifications/:id` | Notification landing page (public) |

---

## Project Structure

```
firearm-alert/
+-- package.json              # Root workspace config (npm workspaces)
+-- docker-compose.yml        # Local PostgreSQL + Redis
+-- README.md
|
+-- frontend/                 # Next.js 14 app (Vercel)
|   +-- src/
|   |   +-- app/
|   |   |   +-- layout.tsx          # Root layout (Navbar)
|   |   |   +-- page.tsx            # Landing page (SEO hero)
|   |   |   +-- login/page.tsx
|   |   |   +-- register/page.tsx
|   |   |   +-- alerts/[slug]/page.tsx  # SEO programmatic pages
|   |   |   +-- dashboard/
|   |   |       +-- layout.tsx      # Auth guard
|   |   |       +-- page.tsx        # Alert list + stats
|   |   |       +-- alerts/new/page.tsx  # Create alert / Search All
|   |   |       +-- history/page.tsx     # All match history
|   |   |       +-- admin/debug/page.tsx # Real-time debug log
|   |   +-- components/
|   |   |   +-- Navbar.tsx
|   |   |   +-- GuestSearchForm.tsx
|   |   |   +-- AlertCard.tsx       # Alert card with scan, match history, thumbnails
|   |   +-- lib/
|   |       +-- api.ts              # Typed API client (Search, Match, MonitoredSite types)
|   |       +-- hooks.ts            # useAuth, useSearches hooks
|
+-- backend/                  # Express API + worker (Railway)
    +-- prisma/
    |   +-- schema.prisma     # Full DB schema
    +-- src/
        +-- index.ts          # Express app, test store, notification pages
        +-- config.ts         # Env var config + validation
        +-- lib/
        |   +-- prisma.ts     # Prisma client singleton
        |   +-- crypto.ts     # AES-256-GCM encrypt/decrypt
        +-- routes/
        |   +-- auth.ts       # Register, login, logout, me, profile
        |   +-- searches.ts   # CRUD, toggle, scan, group scan, credentials
        |   +-- admin.ts      # Site management, health checks, debug log
        +-- services/
        |   +-- scraper/              # Adapter-based scraping framework
        |   |   +-- index.ts          # scrapeWithAdapter() orchestrator
        |   |   +-- types.ts          # ScrapedMatch, ScrapeResult, SiteAdapter interfaces
        |   |   +-- adapter-registry.ts  # Domain -> adapter lookup (DB-backed, cached)
        |   |   +-- http-client.ts    # fetchPage(), Sucuri WAF bypass, UA rotation
        |   |   +-- adapters/
        |   |   |   +-- base.ts             # AbstractAdapter (shared helpers)
        |   |   |   +-- shopify.ts          # Shopify stores
        |   |   |   +-- woocommerce.ts      # WooCommerce (API + HTML)
        |   |   |   +-- generic-retail.ts   # BigCommerce, Magento, custom (+ link fallback)
        |   |   |   +-- generic.ts          # Ultimate fallback
        |   |   |   +-- forum-xenforo.ts    # XenForo forums
        |   |   |   +-- forum-vbulletin.ts  # vBulletin forums
        |   |   |   +-- classifieds-gunpost.ts  # GunPost.ca
        |   |   |   +-- auction-icollector.ts   # iCollector API
        |   |   |   +-- auction-hibid.ts    # HiBid
        |   |   |   +-- auction-generic.ts  # Generic auction HTML
        |   |   +-- utils/
        |   |       +-- price.ts      # extractPrice(), extractPriceFromTitle(), extractBidPrice()
        |   |       +-- stock.ts      # isInStock()
        |   |       +-- url.ts        # resolveUrl(), isBareDomain(), normalizeDomain()
        |   |       +-- html.ts       # detectSiteType(), isLoginPage()
        |   +-- scraper.ts          # Legacy scraper (deprecated, kept for reference)
        |   +-- site-navigator.ts   # Auto-search form detection for bare domain URLs
        |   +-- auth-manager.ts     # Forum login (vBulletin, XenForo), session caching
        |   +-- health-monitor.ts   # Site health checking, DB persistence
        |   +-- queue.ts            # BullMQ queue + scheduleSearch
        |   +-- worker.ts           # Job processor (delta detection, notifications)
        |   +-- email.ts            # Resend email (NEW badges, landing URL)
        |   +-- sms.ts              # Twilio SMS
        |   +-- debugLog.ts         # In-memory event log + SSE
        +-- middleware/
        |   +-- auth.ts       # requireAuth, optionalAuth, requireAdmin
        |   +-- rateLimit.ts  # express-rate-limit
        +-- scripts/
            +-- seed-sites.ts    # Populate MonitoredSite table (50 sites)
            +-- test-scrape.ts   # Search URL pattern tester
            +-- test-scraper.ts  # CLI scraper test tool
```

---

## Key Design Decisions

1. **Adapter-based scraping** — Each site is matched to the best adapter for its e-commerce platform (Shopify, WooCommerce, BigCommerce, Magento, etc.) via the `MonitoredSite` database table. This replaces the old monolithic scraper with a pluggable framework where adding support for a new platform means writing one adapter class.

2. **API-first, HTML-fallback** — WooCommerce sites are scraped via the public Store API first (which returns structured JSON with prices, images, stock status). HTML scraping is only used when the API isn't available or doesn't return complete data (e.g., missing prices).

3. **URL-based delta detection** instead of content hash comparison — Content hashes change when any product detail (price, title) changes, causing false "new" notifications. URL-based detection only flags genuinely new products.

4. **Notification created before sending** — The notification ID is needed for the landing page URL embedded in the email/SMS body. So the DB record is created first with `status: 'pending'`, then updated to `sent` or `failed` after delivery.

5. **MonitoredSite table** — Site configuration is stored in the database (not hardcoded) so it can be updated via the admin API. The seed script provides the initial dataset, but sites can be added/edited/disabled through the admin panel.

6. **Search All as grouped searches** — Rather than a special "search all" endpoint, each Search All alert creates one `Search` per enabled site, linked by `searchAllGroupId`. This reuses the existing per-site scraping and delta detection logic.

7. **In-memory test store** — Test products are stored in memory (not DB) so they reset on server restart. This keeps the test environment clean and separate from real data.

8. **Admin via env var** — `ADMIN_EMAILS` is a comma-separated list. No DB column needed — checked at runtime against the JWT email claim.

9. **httpOnly JWT cookies** — Tokens are stored in httpOnly cookies (not localStorage) to prevent XSS access. The frontend Next.js config proxies API requests to the backend, so cookies are same-origin.

10. **Encrypted credential storage** — Forum credentials are encrypted with AES-256-GCM (key derived from JWT_SECRET via PBKDF2) before database storage. Session cookies are cached to avoid re-logging in on every scan cycle.

---

## Forum Authentication

Forums requiring login (CGN, Gun Owners of Canada) are supported:

1. User provides forum credentials when creating an alert (optional "Site Login" toggle)
2. Credentials are encrypted with **AES-256-GCM** before storage
3. On each scan, the worker:
   - Checks for cached session cookies and validates them
   - If expired or missing, decrypts the password and logs in
   - Passes session cookies to the scraper for authenticated page fetches
   - Caches new session cookies in the DB for reuse

Supported forum software:
- **XenForo** — Fetches CSRF token (`_xfToken`), POST login, expects `xf_session` cookie
- **vBulletin** — POST login with `vb_login_username`/`vb_login_password`, expects `bbsessionhash` cookie

---

## Deployment

### Frontend -> Vercel

1. Push to GitHub
2. Import repo in Vercel dashboard
3. Set root directory: `frontend/`
4. Add env var: `NEXT_PUBLIC_API_URL=https://your-backend.railway.app`
5. Deploy — Vercel auto-detects Next.js

### Backend -> Railway

1. Push to GitHub
2. Create Railway project, connect repo
3. Set root directory: `backend/`
4. Add PostgreSQL and Redis plugins (or use Neon + Upstash)
5. Set all env vars from `backend/.env.example`
6. Set `BACKEND_URL` to the Railway public URL
7. Set `FRONTEND_URL` to the Vercel URL
8. Railway auto-detects `railway.json` and deploys
9. Run `npx ts-node src/scripts/seed-sites.ts` to populate monitored sites

---

## Rate Limiting

| Endpoint | Limit | Window |
|----------|-------|--------|
| Auth (login/register) | 10 requests | 15 minutes |
| Guest search creation | 3 requests | 1 hour |

Rate limits use in-memory storage and reset on server restart.

---

## Legal Notice

FirearmAlert is a notification service for publicly available retail listings.
We are not affiliated with any Canadian firearm retailer.
Users are solely responsible for compliance with applicable Canadian federal and provincial firearm laws.
This service does not facilitate sales or transfer of firearms.
