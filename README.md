# FirearmAlert

Canadian firearm market monitoring web app. Monitors retailer websites for user-defined keywords and sends email/SMS alerts when matches are found.

## Stack

| Layer | Tech |
|-------|------|
| Frontend | Next.js 14 (App Router) + TailwindCSS |
| Backend | Express.js + TypeScript |
| Database | PostgreSQL (Prisma ORM) |
| Queue | BullMQ + Redis |
| Scraping | Axios + Cheerio |
| Auth | JWT (httpOnly cookies) |
| Email | Resend |
| SMS | Twilio |
| Frontend deploy | Vercel |
| Backend deploy | Railway |

## Local Development

### Prerequisites
- Node.js 20+
- Docker Desktop

### 1. Start infrastructure

```bash
docker compose up -d
```

This starts PostgreSQL on port 5432 and Redis on port 6379.

### 2. Configure backend environment

```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env` and fill in:
- `RESEND_API_KEY` — get from [resend.com](https://resend.com)
- `TWILIO_*` keys — from [twilio.com](https://twilio.com) (optional for SMS)
- `JWT_SECRET` — use a long random string

The database/Redis URLs already match docker-compose defaults.

### 3. Configure frontend environment

```bash
cp frontend/.env.local.example frontend/.env.local
```

Default value (`http://localhost:4000`) is correct for local dev.

### 4. Install dependencies

```bash
npm install
```

### 5. Create database tables

```bash
npm run db:push
```

This runs `prisma db push` and generates the Prisma client.

### 6. Start both servers

```bash
npm run dev
```

- Frontend: http://localhost:3000
- Backend API: http://localhost:4000
- Prisma Studio: `npm run db:studio` → http://localhost:5555

## Project Structure

```
firearm-alert/
├── docker-compose.yml        # Local postgres + redis
├── frontend/                 # Next.js 14 app (Vercel)
│   ├── src/
│   │   ├── app/              # App Router pages + API routes
│   │   │   ├── page.tsx      # Landing page (SEO hero)
│   │   │   ├── login/
│   │   │   ├── register/
│   │   │   ├── dashboard/    # Auth-guarded dashboard
│   │   │   └── alerts/[slug] # SEO programmatic pages
│   │   ├── components/
│   │   │   ├── Navbar.tsx
│   │   │   ├── GuestSearchForm.tsx
│   │   │   └── AlertCard.tsx
│   │   └── lib/
│   │       ├── api.ts        # Typed fetch client
│   │       └── hooks.ts      # React hooks (useAuth, useSearches)
│   └── tailwind.config.ts    # Tactical design tokens
└── backend/                  # Express API + worker (Railway)
    ├── prisma/schema.prisma  # DB schema
    └── src/
        ├── index.ts          # App entry + worker start
        ├── config.ts         # Env var validation
        ├── routes/           # auth, searches
        ├── services/
        │   ├── scraper.ts    # Axios + Cheerio
        │   ├── queue.ts      # BullMQ queue
        │   ├── worker.ts     # Job processor
        │   ├── email.ts      # Resend
        │   └── sms.ts        # Twilio
        └── middleware/       # JWT auth, rate limiting
```

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /api/auth/register | — | Create account |
| POST | /api/auth/login | — | Login |
| POST | /api/auth/logout | — | Clear cookie |
| GET | /api/auth/me | Cookie | Current user |
| PATCH | /api/auth/profile | Cookie | Update phone |
| GET | /api/searches | Cookie | List alerts |
| POST | /api/searches | Optional | Create alert (guest or auth) |
| GET | /api/searches/:id | Cookie | Single alert + matches |
| DELETE | /api/searches/:id | Cookie | Delete alert |
| PATCH | /api/searches/:id/toggle | Cookie | Pause/resume |
| GET | /api/searches/matches/:id | Cookie | Match history |

## Deployment

### Frontend → Vercel

1. Push to GitHub
2. Import repo in Vercel dashboard
3. Set root directory to `frontend/`
4. Add env var: `NEXT_PUBLIC_API_URL=https://your-backend.railway.app`

### Backend → Railway

1. Push to GitHub
2. Create new Railway project, connect repo
3. Set root directory to `backend/`
4. Add PostgreSQL and Redis plugins
5. Set all env vars from `backend/.env.example`
6. Railway auto-runs `railway.json` build command

## Legal Notice

FirearmAlert is a notification service for publicly available retail listings.
We are not affiliated with any Canadian firearm retailer.
Users are solely responsible for compliance with applicable Canadian federal and provincial firearm laws.
This service does not facilitate sales or transfer of firearms.
