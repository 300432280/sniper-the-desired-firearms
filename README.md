# FirearmAlert

Canadian firearm market monitoring web app. Monitors retailer websites for user-defined keywords and sends email/SMS alerts when **new** matches are found. Includes a built-in test store for end-to-end testing of the notification pipeline.

---

## Stack

| Layer | Tech | Purpose |
|-------|------|---------|
| Frontend | Next.js 14 (App Router) + TailwindCSS | Dashboard, alert management, SEO pages |
| Backend | Express.js + TypeScript | REST API, scraper orchestration, test store |
| Database | PostgreSQL (Prisma ORM) | Users, searches, matches, notifications |
| Queue | BullMQ + Redis | Scheduled scrape jobs |
| Scraping | Axios + Cheerio | HTML parsing with keyword matching |
| Auth | JWT (httpOnly cookies) + bcrypt | Session management |
| Email | Resend | Alert notification emails |
| SMS | Twilio | Alert notification SMS |
| Frontend deploy | Vercel | Static + SSR hosting |
| Backend deploy | Railway | API + worker process |

---

## Architecture Overview

```
User creates alert (keyword + URL + interval)
        │
        ▼
  ┌─────────────┐     ┌──────────────┐
  │ Express API │────▶│ PostgreSQL   │  (Search, Match, Notification)
  └──────┬──────┘     └──────────────┘
         │
         ▼
  ┌─────────────┐     ┌──────────────┐
  │ BullMQ      │◀───▶│ Redis        │  (Repeating jobs)
  │ Worker      │     └──────────────┘
  └──────┬──────┘
         │ every N minutes (or 10s in test mode)
         ▼
  ┌─────────────┐
  │ Scraper     │  Axios + Cheerio → parse HTML → extract matches
  └──────┬──────┘
         │
         ▼
  Delta Detection (URL-based)
  ├── New URLs   → INSERT into matches table
  │              → Create Notification → Send Email/SMS
  └── Known URLs → UPDATE title/price only (no notification)
```

### Deduplication & Delta Detection

1. **DB-level**: `@@unique([searchId, url])` constraint on the `Match` model prevents duplicate rows.
2. **Worker-level**: Before inserting, the worker queries all existing match URLs for the search. Only URLs not already in the DB are treated as "new" and trigger notifications.
3. **Content hash**: A SHA-256 hash of sorted match URLs is stored as `lastMatchHash` on the Search. If the hash hasn't changed since the last check, the worker skips all processing (no DB writes, no notifications).

### Notification Flow

1. Worker detects new matches via URL delta.
2. A `Notification` record is created **before** sending (to generate the notification ID for the landing page URL).
3. New matches are linked to the notification via `NotificationMatch` join table.
4. Email/SMS is sent with a link to `/notifications/{id}` — a self-contained HTML landing page.
5. Notification status is updated to `sent` or `failed`.

---

## Database Schema

```prisma
model User {
  id           String   @id @default(cuid())
  email        String   @unique
  passwordHash String
  phone        String?
  tier         Tier     @default(FREE)    // FREE | PRO
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  searches     Search[]
}

model Search {
  id               String           @id @default(cuid())
  userId           String?                              // null = guest
  keyword          String
  websiteUrl       String
  checkInterval    Int              @default(30)         // 0=10s test, 5/30/60 min
  notificationType NotificationType @default(EMAIL)      // EMAIL | SMS | BOTH
  notifyEmail      String?                              // guest-only
  isActive         Boolean          @default(true)
  inStockOnly      Boolean          @default(false)
  maxPrice         Float?
  lastChecked      DateTime?
  lastMatchHash    String?                              // SHA-256 of sorted URLs
  expiresAt        DateTime?                            // guest 24h expiry
  matches          Match[]
  notifications    Notification[]
}

model Match {
  id            String              @id @default(cuid())
  searchId      String
  title         String
  price         Float?
  url           String
  hash          String
  foundAt       DateTime            @default(now())
  notifications NotificationMatch[]
  @@unique([searchId, url])         // prevents duplicates
}

model Notification {
  id       String              @id @default(cuid())
  searchId String
  type     NotificationType
  sentAt   DateTime            @default(now())
  status   String              @default("sent")   // pending | sent | failed
  matches  NotificationMatch[]
}

model NotificationMatch {
  notificationId String
  matchId        String
  @@id([notificationId, matchId])
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
| `ADMIN_EMAILS` | No | Comma-separated admin emails (e.g., `a@b.com,admin@example.com`) |

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

### 6. Start both servers

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
| Prisma Studio | `npm run db:studio` → http://localhost:5555 |

---

## Admin System

Admin users are defined by the `ADMIN_EMAILS` environment variable. Admins get:

1. **All Pro features unlocked** — 5-min checks, SMS, BOTH notifications (regardless of tier).
2. **10-second test interval** — Special `checkInterval: 0` option for rapid testing.
3. **Test Store access** — Dynamic product page at `/test-page` with add/remove/reset controls and notification preview.
4. **Admin toolbar** in the dashboard — Quick links to Test Store, Debug Log, Match History.
5. **Debug Log SSE** — Real-time streaming of scrape events, match detections, email/SMS sends.

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
8. Click the **match count** on any alert card to expand and see all historical matches (newest first).
9. Click **View Notification** to see the notification landing page.
10. Visit **Preview Notification** in the test portal to see mock notification landing page, email, and SMS.

### Test Store Admin Controls:

- **Add Listing** — Title, price, stock status; generates a slug-based URL
- **Remove** — Delete individual listings
- **Reset** — Restore all default listings
- **Recent Notifications** panel — Preview links to notification landing pages
- **Preview Notification** — Dedicated page (`/test-page/notification-preview`) showing mock notification landing page, email template, and SMS text exactly as users would see them

---

## API Endpoints

### Auth

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | — | Create account (returns `isAdmin` flag) |
| POST | `/api/auth/login` | — | Login (returns JWT cookie + `isAdmin` flag) |
| POST | `/api/auth/logout` | — | Clear JWT cookie |
| GET | `/api/auth/me` | Cookie | Current user info (includes `isAdmin`) |
| PATCH | `/api/auth/profile` | Cookie | Update phone number |

### Searches (Alerts)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/searches` | Cookie | List all user's alerts |
| POST | `/api/searches` | Optional | Create alert (guest or authenticated) |
| GET | `/api/searches/:id` | Cookie | Single alert with recent matches |
| DELETE | `/api/searches/:id` | Cookie | Delete alert + cancel scheduled job |
| PATCH | `/api/searches/:id/toggle` | Cookie | Pause/resume alert |
| GET | `/api/searches/matches/:id` | Cookie | Match history (up to 50) |
| POST | `/api/searches/:id/scan` | Cookie | Manual scan — persists new matches, triggers notifications, returns results with `isNew` flags |

### Backend Pages (HTML)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/test-page` | — | Test store listings (admin sees control panel) |
| GET | `/test-page/notification-preview` | — | Mock notification preview (landing page, email, SMS) |
| POST | `/test-page/add` | Admin | Add a test listing |
| POST | `/test-page/remove/:slug` | Admin | Remove a test listing |
| POST | `/test-page/reset` | Admin | Reset to default listings |
| GET | `/notifications/:id` | — | Notification landing page (public) |
| GET | `/admin/debug/events` | Admin | SSE stream of debug events |

---

## Project Structure

```
firearm-alert/
├── package.json              # Root workspace config
├── docker-compose.yml        # Local PostgreSQL + Redis
├── README.md                 # This file
│
├── frontend/                 # Next.js 14 app (Vercel)
│   ├── package.json
│   ├── next.config.ts        # API proxy rewrite rules
│   ├── tailwind.config.ts    # Tactical dark theme tokens
│   ├── vercel.json           # Vercel deployment config
│   ├── src/
│   │   ├── app/
│   │   │   ├── layout.tsx          # Root layout (Navbar)
│   │   │   ├── page.tsx            # Landing page (SEO hero)
│   │   │   ├── globals.css         # TailwindCSS base styles
│   │   │   ├── sitemap.ts          # Dynamic sitemap
│   │   │   ├── robots.ts           # robots.txt
│   │   │   ├── login/page.tsx
│   │   │   ├── register/page.tsx
│   │   │   ├── alerts/[slug]/page.tsx  # SEO programmatic pages
│   │   │   └── dashboard/
│   │   │       ├── layout.tsx      # Auth guard (cookie check)
│   │   │       ├── page.tsx        # Alert list + stats (Monitoring / Items Found)
│   │   │       ├── alerts/new/page.tsx  # Create alert form
│   │   │       ├── history/page.tsx     # All match history
│   │   │       └── admin/debug/page.tsx # Real-time debug log
│   │   ├── components/
│   │   │   ├── Navbar.tsx
│   │   │   ├── GuestSearchForm.tsx
│   │   │   └── AlertCard.tsx       # Alert card with Scan Now + expandable match history
│   │   └── lib/
│   │       ├── api.ts              # Typed API client
│   │       └── hooks.ts            # useAuth, useSearches hooks
│   └── .env.local.example
│
└── backend/                  # Express API + worker (Railway)
    ├── package.json
    ├── tsconfig.json
    ├── railway.json          # Railway build config
    ├── Procfile              # Process command
    ├── .env.example
    ├── prisma/
    │   └── schema.prisma     # Full DB schema
    └── src/
        ├── index.ts          # Express app, test store, notification page, notification preview
        ├── config.ts         # Env var config + validation
        ├── lib/
        │   └── prisma.ts     # Prisma client singleton
        ├── routes/
        │   ├── auth.ts       # Register, login, logout, me, profile
        │   └── searches.ts   # CRUD, toggle, scan, match history
        ├── services/
        │   ├── scraper.ts    # Axios + Cheerio scraping engine
        │   ├── queue.ts      # BullMQ queue + scheduleSearch
        │   ├── worker.ts     # Job processor (delta detection)
        │   ├── email.ts      # Resend email (NEW badges, landing URL)
        │   ├── sms.ts        # Twilio SMS
        │   └── debugLog.ts   # In-memory event log + SSE
        ├── middleware/
        │   ├── auth.ts       # requireAuth, optionalAuth, requireAdmin
        │   └── rateLimit.ts  # express-rate-limit (auth + guest)
        └── scripts/
            └── test-scraper.ts  # CLI scraper test tool
```

---

## Key Design Decisions

1. **URL-based delta detection** instead of content hash comparison — Content hashes change when any product detail (price, title) changes, causing false "new" notifications. URL-based detection only flags genuinely new products.

2. **Notification created before sending** — The notification ID is needed for the landing page URL embedded in the email/SMS body. So the DB record is created first with `status: 'pending'`, then updated to `sent` or `failed` after delivery.

3. **NotificationMatch join table** — Links specific matches to specific notifications, so the landing page shows exactly which items triggered that notification.

4. **In-memory test store** — Test products are stored in memory (not DB) so they reset on server restart. This keeps the test environment clean and separate from real data.

5. **Admin via env var** — `ADMIN_EMAILS` is a comma-separated list. No DB column needed — checked at runtime against the JWT email claim.

6. **httpOnly JWT cookies** — Tokens are stored in httpOnly cookies (not localStorage) to prevent XSS access. The frontend Next.js config proxies API requests to the backend, so cookies are same-origin.

7. **`checkInterval: 0` = 10 seconds** — A special sentinel value for admin-only rapid testing. The queue converts `0` to 10,000ms instead of the normal `minutes * 60 * 1000`.

---

## Scraper Engine

The scraper (`backend/src/services/scraper.ts`) handles diverse retailer page structures:

1. **Product card detection** — Tries 20+ CSS selectors in order of specificity (e-commerce → classified → generic article).
2. **Keyword matching** — Case-insensitive text matching within detected product containers.
3. **Auto-search fallback** — If the URL is a bare domain with no matches, the scraper:
   - Detects search forms on the page and submits the keyword
   - Falls back to common search URL patterns (WordPress, Shopify, Magento, Drupal)
4. **Price extraction** — Regex-based extraction supporting `$1,299.99`, `CAD 499`, etc.
5. **Stock detection** — Heuristic based on "in stock" / "out of stock" / disabled cart button patterns.
6. **Deduplication** — In-scrape title-based dedup prevents the same product from appearing twice.
7. **Anti-detection** — Random user agent rotation, randomized delays (800-2500ms), standard browser headers.

---

## Deployment

### Frontend → Vercel

1. Push to GitHub
2. Import repo in Vercel dashboard
3. Set root directory: `frontend/`
4. Add env var: `NEXT_PUBLIC_API_URL=https://your-backend.railway.app`
5. Deploy — Vercel auto-detects Next.js

### Backend → Railway

1. Push to GitHub
2. Create Railway project, connect repo
3. Set root directory: `backend/`
4. Add PostgreSQL and Redis plugins (or use Neon + Upstash)
5. Set all env vars from `backend/.env.example`
6. Set `BACKEND_URL` to the Railway public URL
7. Set `FRONTEND_URL` to the Vercel URL
8. Railway auto-detects `railway.json` and deploys

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
