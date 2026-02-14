import './config'; // Validate env vars first
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { config } from './config';
import { generalLimiter, authLimiter } from './middleware/rateLimit';
import authRouter from './routes/auth';
import searchesRouter from './routes/searches';
import adminRouter from './routes/admin';
import { startWorker } from './services/worker';
import { prisma } from './lib/prisma';

// Check if the request has a valid admin JWT cookie
function isAdmin(req: express.Request): boolean {
  const token = req.cookies?.token as string | undefined;
  if (!token) return false;
  try {
    const payload = jwt.verify(token, config.jwtSecret) as { email?: string };
    return !!payload.email && config.adminEmails.includes(payload.email);
  } catch {
    return false;
  }
}

const app = express();

// CORS — must allow credentials for httpOnly cookie to be sent
app.use(
  cors({
    origin: config.frontendUrl,
    credentials: true,
  })
);

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(generalLimiter);

// Routes
app.use('/api/auth', authLimiter, authRouter);
app.use('/api/searches', searchesRouter);
app.use('/api/admin', adminRouter);

// Health check endpoint (used by Railway)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Dynamic Test Page ──────────────────────────────────────────────────
// In-memory product store for testing the scraper pipeline.
// Point an alert at http://localhost:4000/test-page with keyword "rifle", "sks", "glock", etc.

interface TestProduct {
  id: string;
  title: string;
  price: number;
  stock: string;
  slug: string;
}

const DEFAULT_PRODUCTS: TestProduct[] = [
  { id: '1', title: 'Norinco SKS 7.62x39 Semi-Auto Rifle', price: 449.99, stock: 'In Stock', slug: 'sks-001' },
  { id: '2', title: 'GSG-16 .22LR Rifle - German Sport Guns', price: 599.00, stock: 'In Stock', slug: 'gsg16-002' },
  { id: '3', title: 'Smith & Wesson SD9 VE 9mm Pistol', price: 519.99, stock: 'In Stock', slug: 'sw-sd9-003' },
  { id: '4', title: 'Glock 19 Gen5 9mm Handgun', price: 799.00, stock: 'In Stock', slug: 'glock19-004' },
  { id: '5', title: 'Ruger 10/22 Carbine .22LR Rifle', price: 399.95, stock: 'In Stock', slug: 'ruger1022-005' },
  { id: '6', title: 'Federal 9mm 115gr FMJ Ammunition - 50 Rounds', price: 24.99, stock: 'In Stock', slug: 'ammo-9mm-006' },
  { id: '7', title: 'Remington 870 Express 12ga Shotgun', price: 549.00, stock: 'Add to Cart', slug: 'rem870-007' },
];

const testProducts: TestProduct[] = [...DEFAULT_PRODUCTS];
let nextTestId = 8;

const TEST_STYLES = `
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background:#0D0D0D; color:#E2E2E2; font-family:Inter,Arial,sans-serif; padding:20px 30px; }
  h1 { color:#E2E2E2; border-bottom:2px solid #4D7A3C; padding-bottom:10px; margin-bottom:20px; font-size:24px; }
  .admin-panel { background:#161616; border:1px solid #1E1E1E; border-top:3px solid #D4620A; padding:20px; margin-bottom:24px; }
  .admin-panel h2 { color:#D4620A; font-size:12px; text-transform:uppercase; letter-spacing:0.2em; margin-bottom:12px; }
  .admin-note { color:#6B7280; font-size:11px; margin-bottom:12px; }
  .form-row { display:flex; gap:8px; flex-wrap:wrap; align-items:end; }
  label { font-size:10px; color:#6B7280; display:block; text-transform:uppercase; letter-spacing:0.1em; margin-bottom:2px; }
  input, select { background:#0D0D0D; border:1px solid #1E1E1E; color:#E2E2E2; padding:8px 12px; font-size:13px; }
  input:focus, select:focus { outline:none; border-color:#4D7A3C; }
  button { border:none; padding:8px 20px; cursor:pointer; text-transform:uppercase; letter-spacing:0.15em; font-size:11px; font-weight:600; }
  .btn-add { background:#4D7A3C; color:#fff; }
  .btn-add:hover { background:#5A8A47; }
  .btn-danger { background:#8B2500; color:#fff; }
  .btn-danger:hover { background:#A52F00; }
  .btn-sm { padding:4px 10px; font-size:10px; }
  .product-card { background:#111111; border:1px solid #1E1E1E; padding:14px 18px; margin:8px 0; display:flex; align-items:center; justify-content:space-between; }
  .product-info { flex:1; }
  .product-title { color:#E2E2E2; font-size:15px; margin-bottom:6px; }
  .price { color:#D4620A; font-weight:600; margin-right:12px; }
  .stock { color:#4D7A3C; font-size:12px; }
  a { color:#4D7A3C; text-decoration:none; }
  a:hover { text-decoration:underline; }
  .product-actions { flex-shrink:0; margin-left:12px; }
  .count { color:#6B7280; font-size:12px; margin-bottom:8px; }
</style>`;

app.get('/test-page', async (req, res) => {
  const ts = new Date().toISOString();
  const admin = isAdmin(req);

  const productCards = testProducts.map((p) => `
    <div class="product-card">
      <div class="product-info">
        <h3 class="product-title">${p.title}</h3>
        <span class="price">$${p.price.toFixed(2)}</span>
        <span class="stock">${p.stock}</span>
        <a href="http://localhost:${config.port}/test-page/${p.slug}">View Details</a>
      </div>
      ${admin ? `<div class="product-actions">
        <form method="POST" action="/test-page/remove/${p.slug}" style="display:inline;">
          <button type="submit" class="btn-danger btn-sm">X</button>
        </form>
      </div>` : ''}
    </div>`).join('');

  // Admin-only: fetch recent notifications to preview landing pages
  let notificationsPanel = '';
  if (admin) {
    try {
      const recentNotifs = await prisma.notification.findMany({
        orderBy: { sentAt: 'desc' },
        take: 10,
        include: {
          search: { select: { keyword: true, websiteUrl: true } },
          _count: { select: { matches: true } },
        },
      });
      const notifRows = recentNotifs.map((n) => {
        const time = new Date(n.sentAt).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: false });
        const statusColor = n.status === 'sent' ? '#4D7A3C' : n.status === 'failed' ? '#8B2500' : '#D4620A';
        return `<div style="display:flex; align-items:center; gap:12px; padding:6px 0; border-bottom:1px solid #1E1E1E;">
          <span style="color:#6B7280; font-size:11px; font-family:monospace; min-width:42px;">${time}</span>
          <span style="font-size:9px; padding:2px 6px; letter-spacing:0.1em; text-transform:uppercase; background:${statusColor}; color:#fff;">${n.status}</span>
          <span style="font-size:9px; padding:2px 6px; letter-spacing:0.1em; text-transform:uppercase; border:1px solid #1E1E1E; color:#6B7280;">${n.type}</span>
          <span style="color:#E2E2E2; font-size:12px; flex:1;">"${n.search.keyword}" &mdash; ${n._count.matches} item(s)</span>
          <a href="/notifications/${n.id}" target="_blank" style="color:#4D7A3C; font-size:10px; text-transform:uppercase; letter-spacing:0.15em; border:1px solid rgba(77,122,60,0.3); padding:3px 10px; text-decoration:none;">Preview</a>
        </div>`;
      }).join('');

      notificationsPanel = `
      <div class="admin-panel" style="border-top-color:#4D7A3C;">
        <h2 style="color:#4D7A3C;">Recent Notifications</h2>
        <p class="admin-note">Click "Preview" to see the notification landing page a user receives.</p>
        ${recentNotifs.length > 0 ? notifRows : '<p style="color:#6B7280; font-size:12px;">No notifications yet. Add a listing and wait for the next scrape cycle.</p>'}
      </div>`;
    } catch {
      // Silently skip if DB query fails
    }
  }

  const adminPanel = admin ? `
  <div class="admin-panel">
    <h2>Test Control Panel</h2>
    <p class="admin-note">Add/remove listings to test notification detection. State is in-memory (resets on server restart).</p>
    <form method="POST" action="/test-page/add" class="form-row">
      <div><label>Title</label>
        <input name="title" required placeholder="e.g. Tikka T3x .308 Rifle" style="width:300px;"></div>
      <div><label>Price</label>
        <input name="price" type="number" step="0.01" required placeholder="899.99" style="width:110px;"></div>
      <div><label>Stock</label>
        <select name="stock"><option>In Stock</option><option>Add to Cart</option><option>Out of Stock</option></select></div>
      <button type="submit" class="btn-add">+ Add Listing</button>
    </form>
    <form method="POST" action="/test-page/reset" style="margin-top:12px;">
      <button type="submit" class="btn-danger">Reset to Defaults</button>
    </form>
  </div>
  ${notificationsPanel}
  <div style="margin-bottom:16px; display:flex; gap:8px; flex-wrap:wrap;">
    <a href="/test-page/notification-preview" style="color:#D4620A; font-size:11px; text-transform:uppercase; letter-spacing:0.15em; border:1px solid rgba(212,98,10,0.3); padding:6px 14px; text-decoration:none; display:inline-block;">Preview Notification &rarr;</a>
    <a href="${config.frontendUrl}/dashboard/admin/debug" style="color:#4D7A3C; font-size:11px; text-transform:uppercase; letter-spacing:0.15em; border:1px solid rgba(77,122,60,0.3); padding:6px 14px; text-decoration:none; display:inline-block;">Debug Log &rarr;</a>
  </div>` : '';

  res.type('html').send(`<!DOCTYPE html>
<html><head><title>Test Firearms Store</title>${TEST_STYLES}</head>
<body>
  <h1>Test Store — Generated ${ts}</h1>
  ${adminPanel}
  <p class="count">${testProducts.length} listing(s)</p>
  ${productCards}
</body></html>`);
});

// Admin-only POST endpoints for test page management
app.post('/test-page/add', (req, res) => {
  if (!isAdmin(req)) return res.status(403).send('Admin access required');
  const { title, price, stock } = req.body;
  if (!title || !price) return res.status(400).send('Title and price are required');
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) + '-' + nextTestId;
  testProducts.push({
    id: String(nextTestId++),
    title: String(title),
    price: parseFloat(price),
    stock: stock || 'In Stock',
    slug,
  });
  res.redirect('/test-page');
});

app.post('/test-page/remove/:slug', (req, res) => {
  if (!isAdmin(req)) return res.status(403).send('Admin access required');
  const idx = testProducts.findIndex((p) => p.slug === req.params.slug);
  if (idx !== -1) testProducts.splice(idx, 1);
  res.redirect('/test-page');
});

app.post('/test-page/reset', (req, res) => {
  if (!isAdmin(req)) return res.status(403).send('Admin access required');
  testProducts.length = 0;
  testProducts.push(...DEFAULT_PRODUCTS.map((p) => ({ ...p })));
  nextTestId = 8;
  res.redirect('/test-page');
});

// ── Notification Preview Page ─────────────────────────────────────────
// Admin-only: shows a mock notification landing page + email preview using test data.
app.get('/test-page/notification-preview', (req, res) => {
  const admin = isAdmin(req);
  const mockKeyword = 'rifle';
  const mockSentAt = new Date().toLocaleString('en-CA', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const mockWebsite = `http://localhost:${config.port}/test-page`;
  const mockMatches = [
    { title: 'Norinco SKS 7.62x39 Semi-Auto Rifle', price: 449.99, url: `${mockWebsite}/sks-001` },
    { title: 'Ruger 10/22 Carbine .22LR Rifle', price: 399.95, url: `${mockWebsite}/ruger1022-005` },
    { title: 'Remington 870 Express 12ga Shotgun', price: 549.00, url: `${mockWebsite}/rem870-007` },
  ];

  // ── Notification Landing Page (same HTML as real /notifications/:id) ──
  const landingMatchRows = mockMatches.map((m) => `
    <div style="background:#161616; border:1px solid #1E1E1E; padding:14px 18px; margin:8px 0; display:flex; align-items:center; justify-content:space-between;">
      <div style="flex:1;">
        <span style="display:inline-block; background:#4D7A3C; color:#fff; font-size:9px; padding:2px 6px; letter-spacing:0.1em; text-transform:uppercase; margin-right:8px; vertical-align:middle;">NEW</span>
        <span style="color:#E2E2E2; font-size:14px;">${m.title}</span>
      </div>
      <div style="flex-shrink:0; text-align:right;">
        <span style="color:#D4620A; font-weight:600; margin-right:16px;">$${m.price.toFixed(2)}</span>
        <a href="${m.url}" target="_blank" rel="noopener noreferrer" style="color:#4D7A3C; text-decoration:none; font-size:11px; text-transform:uppercase; letter-spacing:0.15em; border:1px solid rgba(77,122,60,0.3); padding:4px 12px;">View &rarr;</a>
      </div>
    </div>`).join('');

  // ── Email Preview (same HTML as real sendAlertEmail) ──
  const emailMatchRows = mockMatches.map((m) => `
    <tr>
      <td style="padding:10px 14px; color:#E2E2E2; border-bottom:1px solid #1E1E1E;">
        <span style="display:inline-block; background:#4D7A3C; color:#fff; font-size:9px; padding:2px 6px; letter-spacing:0.1em; text-transform:uppercase; margin-right:8px; vertical-align:middle;">NEW</span>
        <a href="${m.url}" style="color:#4D7A3C; text-decoration:none;">${m.title}</a>
      </td>
      <td style="padding:10px 14px; color:#D4620A; font-weight:600; border-bottom:1px solid #1E1E1E; white-space:nowrap;">
        $${m.price.toFixed(2)}
      </td>
    </tr>`).join('');

  const emailHtml = `
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0D0D0D; padding:40px 20px;">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="background:#111111; border:1px solid #1E1E1E; border-top:3px solid #4D7A3C;">
      <tr>
        <td style="padding:28px 32px 16px;">
          <div style="font-size:11px; color:#6B7280; letter-spacing:0.2em; text-transform:uppercase; margin-bottom:8px;">
            Tactical Alert
          </div>
          <h1 style="margin:0; font-size:22px; color:#E2E2E2; letter-spacing:0.05em;">
            ${mockMatches.length} new items: <span style="color:#4D7A3C;">${mockKeyword}</span>
          </h1>
        </td>
      </tr>
      <tr>
        <td style="padding:0 32px 24px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #1E1E1E;">
            <tr>
              <th style="padding:8px 14px; text-align:left; font-size:10px; color:#6B7280; text-transform:uppercase; letter-spacing:0.15em; background:#161616; border-bottom:1px solid #1E1E1E;">Item</th>
              <th style="padding:8px 14px; text-align:left; font-size:10px; color:#6B7280; text-transform:uppercase; letter-spacing:0.15em; background:#161616; border-bottom:1px solid #1E1E1E;">Price</th>
            </tr>
            ${emailMatchRows}
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:0 32px 16px;">
          <a href="#" style="display:inline-block; background:#4D7A3C; color:#ffffff; padding:10px 24px; font-size:12px; letter-spacing:0.15em; text-transform:uppercase; text-decoration:none;">
            View New Items
          </a>
        </td>
      </tr>
      <tr>
        <td style="padding:0 32px 32px;">
          <a href="${config.frontendUrl}/dashboard" style="color:#6B7280; font-size:11px; text-decoration:underline;">
            Manage Alerts
          </a>
        </td>
      </tr>
      <tr>
        <td style="padding:16px 32px; border-top:1px solid #1E1E1E;">
          <p style="margin:0; font-size:11px; color:#4A4A4A; line-height:1.6;">
            FirearmAlert is a notification service. We are not affiliated with any retailer.
            Users are responsible for complying with all applicable Canadian firearm laws.
          </p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>`;

  // ── SMS Preview ──
  const smsText = `[FirearmAlert] ${mockMatches.length} NEW items for "${mockKeyword}": ${mockWebsite}/notifications/preview-sample`;

  res.type('html').send(`<!DOCTYPE html>
<html><head>
<title>Notification Preview — FirearmAlert Test Portal</title>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:#0D0D0D;color:#E2E2E2;font-family:Inter,Arial,sans-serif;padding:0;}
  .wrap{max-width:700px;margin:0 auto;padding:40px 20px;}
  .back{font-size:11px;color:#6B7280;text-decoration:none;letter-spacing:0.15em;text-transform:uppercase;display:inline-block;margin-bottom:24px;}
  .back:hover{color:#4D7A3C;}
  .section-label{font-size:11px;color:#D4620A;letter-spacing:0.2em;text-transform:uppercase;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #1E1E1E;}
  .section{margin-bottom:40px;}
  .preview-box{border:1px solid #1E1E1E;overflow:hidden;}
  .label{font-size:11px;color:#6B7280;letter-spacing:0.2em;text-transform:uppercase;margin-bottom:8px;}
  h1{font-size:24px;color:#E2E2E2;letter-spacing:0.05em;margin-bottom:6px;}
  .meta{font-size:12px;color:#6B7280;margin-bottom:24px;}
  .keyword{color:#4D7A3C;}
  .footer{margin-top:32px;padding-top:16px;border-top:1px solid #1E1E1E;}
  .footer a{color:#6B7280;font-size:11px;text-decoration:underline;}
  .footer p{color:#4A4A4A;font-size:11px;line-height:1.6;margin-top:12px;}
  .sms-box{background:#161616;border:1px solid #1E1E1E;padding:16px 20px;font-family:monospace;font-size:13px;color:#E2E2E2;line-height:1.5;}
  ${!admin ? '.admin-only{display:none;}' : ''}
</style>
</head><body>
<div class="wrap">
  <a href="/test-page" class="back">&larr; Back to Test Store</a>

  <div style="margin-bottom:32px;">
    <div style="font-size:10px;color:#D4620A;letter-spacing:0.25em;text-transform:uppercase;margin-bottom:6px;">Test Portal</div>
    <h1 style="font-size:28px;">Notification Preview</h1>
    <p style="font-size:12px;color:#6B7280;margin-top:4px;">This page shows exactly what a user sees when they receive a notification. All data below is mock/sample data.</p>
  </div>

  <!-- Section 1: Notification Landing Page -->
  <div class="section">
    <div class="section-label">Notification Landing Page</div>
    <p style="font-size:11px;color:#6B7280;margin-bottom:12px;">This is the page users see when they click the link in their email or SMS.</p>
    <div class="preview-box" style="padding:32px 24px;">
      <div class="label">Tactical Alert</div>
      <h1>${mockMatches.length} new items: <span class="keyword">${mockKeyword}</span></h1>
      <div class="meta">Found on ${mockSentAt} &middot; Monitoring ${mockWebsite}</div>
      ${landingMatchRows}
      <div class="footer">
        <a href="${config.frontendUrl}/dashboard">Manage Alerts</a>
        <p>FirearmAlert is a notification service. We are not affiliated with any retailer.
        Users are responsible for complying with all applicable Canadian firearm laws.</p>
      </div>
    </div>
  </div>

  <!-- Section 2: Email Preview -->
  <div class="section">
    <div class="section-label">Email Notification</div>
    <p style="font-size:11px;color:#6B7280;margin-bottom:4px;">Subject: <span style="color:#E2E2E2;">[FirearmAlert] ${mockMatches.length} new items: &quot;${mockKeyword}&quot;</span></p>
    <p style="font-size:11px;color:#6B7280;margin-bottom:12px;">From: <span style="color:#E2E2E2;">${config.fromEmail}</span></p>
    <div class="preview-box">
      ${emailHtml}
    </div>
  </div>

  <!-- Section 3: SMS Preview -->
  <div class="section">
    <div class="section-label">SMS Notification</div>
    <p style="font-size:11px;color:#6B7280;margin-bottom:12px;">The SMS message is a short text with a link to the notification landing page.</p>
    <div class="sms-box">${smsText}</div>
  </div>
</div>
</body></html>`);
});

// ── Notification Landing Page ──────────────────────────────────────────
// Public route — the CUID notification ID serves as an unguessable auth token.
app.get('/notifications/:id', async (req, res) => {
  try {
    const notification = await prisma.notification.findUnique({
      where: { id: req.params.id },
      include: {
        search: { select: { keyword: true, websiteUrl: true } },
        matches: {
          include: {
            match: { select: { id: true, title: true, price: true, url: true, foundAt: true } },
          },
        },
      },
    });

    if (!notification) {
      return res.status(404).type('html').send(`<!DOCTYPE html>
<html><head><title>Not Found — FirearmAlert</title>
<style>body{background:#0D0D0D;color:#E2E2E2;font-family:Inter,Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
.box{text-align:center;}.code{font-size:72px;color:#1E1E1E;font-weight:700;}.msg{color:#6B7280;margin-top:8px;}</style>
</head><body><div class="box"><div class="code">404</div><div class="msg">Notification not found or has expired.</div></div></body></html>`);
    }

    const matchItems = notification.matches.map((nm) => nm.match);
    const keyword = notification.search.keyword;
    const sentAt = new Date(notification.sentAt).toLocaleString('en-CA', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });

    const matchRows = matchItems.map((m) => `
      <div style="background:#161616; border:1px solid #1E1E1E; padding:14px 18px; margin:8px 0; display:flex; align-items:center; justify-content:space-between;">
        <div style="flex:1;">
          <span style="display:inline-block; background:#4D7A3C; color:#fff; font-size:9px; padding:2px 6px; letter-spacing:0.1em; text-transform:uppercase; margin-right:8px; vertical-align:middle;">NEW</span>
          <span style="color:#E2E2E2; font-size:14px;">${m.title}</span>
        </div>
        <div style="flex-shrink:0; text-align:right;">
          <span style="color:#D4620A; font-weight:600; margin-right:16px;">${m.price ? `$${m.price.toFixed(2)}` : ''}</span>
          <a href="${m.url}" target="_blank" rel="noopener noreferrer" style="color:#4D7A3C; text-decoration:none; font-size:11px; text-transform:uppercase; letter-spacing:0.15em; border:1px solid rgba(77,122,60,0.3); padding:4px 12px;">View &rarr;</a>
        </div>
      </div>`).join('');

    return res.type('html').send(`<!DOCTYPE html>
<html><head>
<title>New Items Found — FirearmAlert</title>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:#0D0D0D;color:#E2E2E2;font-family:Inter,Arial,sans-serif;padding:0;}
  .wrap{max-width:640px;margin:0 auto;padding:40px 20px;}
  .label{font-size:11px;color:#6B7280;letter-spacing:0.2em;text-transform:uppercase;margin-bottom:8px;}
  h1{font-size:24px;color:#E2E2E2;letter-spacing:0.05em;margin-bottom:6px;}
  .meta{font-size:12px;color:#6B7280;margin-bottom:24px;}
  .keyword{color:#4D7A3C;}
  .footer{margin-top:32px;padding-top:16px;border-top:1px solid #1E1E1E;}
  .footer a{color:#6B7280;font-size:11px;text-decoration:underline;}
  .footer p{color:#4A4A4A;font-size:11px;line-height:1.6;margin-top:12px;}
</style>
</head><body>
<div class="wrap">
  <div class="label">Tactical Alert</div>
  <h1>${matchItems.length} new item${matchItems.length > 1 ? 's' : ''}: <span class="keyword">${keyword}</span></h1>
  <div class="meta">Found on ${sentAt} &middot; Monitoring ${notification.search.websiteUrl}</div>
  ${matchRows}
  <div class="footer">
    <a href="${config.frontendUrl}/dashboard">Manage Alerts</a>
    <p>FirearmAlert is a notification service. We are not affiliated with any retailer.
    Users are responsible for complying with all applicable Canadian firearm laws.</p>
  </div>
</div>
</body></html>`);
  } catch (err) {
    console.error('[Server] Notification page error:', err);
    return res.status(500).type('html').send('Internal server error');
  }
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Server] Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// Start BullMQ worker in same process for MVP
// In production, split into separate Railway service for horizontal scaling
const worker = startWorker();

const server = app.listen(config.port, () => {
  console.log(`[Server] Running on port ${config.port} (${config.nodeEnv})`);
  console.log(`[Server] CORS origin: ${config.frontendUrl}`);
});

// Graceful shutdown
const shutdown = async () => {
  console.log('[Server] Shutting down gracefully...');
  await worker.close();
  server.close(() => {
    console.log('[Server] Server closed');
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
