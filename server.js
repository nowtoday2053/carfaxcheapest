require('dotenv').config();
const express = require('express');
const path = require('path');
const Stripe = require('stripe');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const session = require('express-session');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.CARFAX_API_KEY;
const API_BASE = 'https://carfaxcheaper.com/api/v1';
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const PRICE_CENTS = parseInt(process.env.STRIPE_PRICE) || 599;

const CREDIT_BUNDLES = {
  '10': { credits: 10, price_cents: 3000, label: '10 Report Credits' },
  '30': { credits: 30, price_cents: 6000, label: '30 Report Credits' },
};

/* ==========================================================
   Database Setup
   ========================================================== */
const db = new Database(path.join(__dirname, 'cheapcarfax.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    credits INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    vin TEXT NOT NULL,
    vehicle_name TEXT,
    stripe_session_id TEXT,
    paid_with_credits INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS credit_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    credits INTEGER NOT NULL,
    stripe_session_id TEXT UNIQUE,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// Shared reports table for PDF download & link sharing
db.exec(`
  CREATE TABLE IF NOT EXISTS shared_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE NOT NULL,
    vin TEXT,
    report_html TEXT NOT NULL,
    source TEXT DEFAULT 'paid',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Add credits column if it doesn't exist (for existing databases)
try { db.exec('ALTER TABLE users ADD COLUMN credits INTEGER DEFAULT 0'); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE reports ADD COLUMN paid_with_credits INTEGER DEFAULT 0'); } catch (e) { /* already exists */ }

/* ==========================================================
   Helpers
   ========================================================== */
function generateToken() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function saveSharedReport(vin, html, source) {
  const token = generateToken();
  db.prepare('INSERT OR IGNORE INTO shared_reports (token, vin, report_html, source) VALUES (?, ?, ?, ?)').run(token, vin, html, source || 'paid');
  return token;
}

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'carfaxisthebest';

function requireAdmin(req, res, next) {
  if (req.session.isAdmin) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

/* ==========================================================
   Middleware
   ========================================================== */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'cheapcarfax-session-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
  }
}));
app.use(express.static(path.join(__dirname)));

/* ==========================================================
   Auth Endpoints
   ========================================================== */
app.post('/api/signup', async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) {
    return res.status(409).json({ error: 'An account with this email already exists.' });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users (name, email, password) VALUES (?, ?, ?)').run(name.trim(), email.toLowerCase().trim(), hash);

    req.session.userId = result.lastInsertRowid;
    req.session.userName = name.trim();
    req.session.userEmail = email.toLowerCase().trim();

    res.json({ success: true, user: { name: name.trim(), email: email.toLowerCase().trim() } });
  } catch (err) {
    console.error('Signup error:', err.message);
    res.status(500).json({ error: 'Failed to create account.' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  req.session.userId = user.id;
  req.session.userName = user.name;
  req.session.userEmail = user.email;

  res.json({ success: true, user: { name: user.name, email: user.email } });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) {
    return res.json({ loggedIn: false });
  }
  const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(req.session.userId);
  res.json({
    loggedIn: true,
    user: {
      name: req.session.userName,
      email: req.session.userEmail,
      credits: user ? user.credits : 0
    }
  });
});

/* ==========================================================
   VIN Decode (free)
   ========================================================== */
app.get('/api/decode', async (req, res) => {
  const { vin } = req.query;
  if (!vin) return res.status(400).json({ error: 'VIN is required' });

  try {
    const response = await fetch(`${API_BASE}/decode?vin=${encodeURIComponent(vin)}`, {
      headers: { 'X-API-Key': API_KEY }
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Decode error:', err.message);
    res.status(500).json({ error: 'Failed to decode VIN' });
  }
});

/* ==========================================================
   Create Stripe Checkout — single report ($5.99)
   ========================================================== */
app.post('/api/create-checkout', async (req, res) => {
  const { vin, vehicle_name } = req.body;
  if (!vin) return res.status(400).json({ error: 'VIN is required' });

  try {
    const sessionConfig = {
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Carfax Vehicle History Report',
            description: vehicle_name ? `Full report for ${vehicle_name} (${vin})` : `Full report for VIN: ${vin}`,
          },
          unit_amount: PRICE_CENTS,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${req.protocol}://${req.get('host')}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.protocol}://${req.get('host')}/index.html`,
      metadata: { vin, type: 'single_report' },
    };

    if (req.session.userId) {
      sessionConfig.customer_email = req.session.userEmail;
      sessionConfig.metadata.user_id = String(req.session.userId);
      sessionConfig.metadata.vehicle_name = vehicle_name || '';
    }

    const checkoutSession = await stripe.checkout.sessions.create(sessionConfig);
    res.json({ url: checkoutSession.url });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

/* ==========================================================
   Create Stripe Checkout — credit bundles (15 or 40)
   ========================================================== */
app.post('/api/buy-credits', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Please log in to purchase credits.', redirect: '/login.html' });
  }

  const { bundle } = req.body;
  const plan = CREDIT_BUNDLES[bundle];
  if (!plan) {
    return res.status(400).json({ error: 'Invalid bundle. Choose 15 or 40.' });
  }

  try {
    const checkoutSession = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_email: req.session.userEmail,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: plan.label,
            description: `${plan.credits} vehicle history report credits for your CheapCarfax account`,
          },
          unit_amount: plan.price_cents,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${req.protocol}://${req.get('host')}/credit-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.protocol}://${req.get('host')}/pricing.html`,
      metadata: {
        type: 'credit_purchase',
        user_id: String(req.session.userId),
        credits: String(plan.credits),
        bundle: bundle,
      },
    });

    res.json({ url: checkoutSession.url });
  } catch (err) {
    console.error('Credit purchase error:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

/* ==========================================================
   Verify credit purchase & add credits
   ========================================================== */
app.get('/api/verify-credits', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'Session ID is required' });

  try {
    const checkoutSession = await stripe.checkout.sessions.retrieve(session_id);

    if (checkoutSession.payment_status !== 'paid') {
      return res.status(402).json({ error: 'Payment not completed' });
    }

    if (checkoutSession.metadata.type !== 'credit_purchase') {
      return res.status(400).json({ error: 'Invalid session type' });
    }

    const userId = parseInt(checkoutSession.metadata.user_id);
    const credits = parseInt(checkoutSession.metadata.credits);

    // Prevent double-crediting
    const existing = db.prepare('SELECT id FROM credit_purchases WHERE stripe_session_id = ?').get(session_id);
    if (!existing) {
      db.prepare('INSERT INTO credit_purchases (user_id, credits, stripe_session_id) VALUES (?, ?, ?)').run(userId, credits, session_id);
      db.prepare('UPDATE users SET credits = credits + ? WHERE id = ?').run(credits, userId);
    }

    const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(userId);

    res.json({ success: true, credits_added: credits, total_credits: user.credits });
  } catch (err) {
    console.error('Verify credits error:', err.message);
    if (err.type === 'StripeInvalidRequestError') {
      return res.status(400).json({ error: 'Invalid or expired session.' });
    }
    res.status(500).json({ error: 'Failed to verify credit purchase' });
  }
});

/* ==========================================================
   Use credit to get report (no Stripe needed)
   ========================================================== */
app.post('/api/use-credit', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Please log in.' });
  }

  const { vin, vehicle_name } = req.body;
  if (!vin) return res.status(400).json({ error: 'VIN is required' });

  const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(req.session.userId);
  if (!user || user.credits < 1) {
    return res.status(402).json({ error: 'No credits remaining. Please purchase more.' });
  }

  try {
    // Deduct credit
    db.prepare('UPDATE users SET credits = credits - 1 WHERE id = ?').run(req.session.userId);

    // Save report
    db.prepare('INSERT INTO reports (user_id, vin, vehicle_name, paid_with_credits) VALUES (?, ?, ?, 1)')
      .run(req.session.userId, vin, vehicle_name || '');

    // Fetch the report
    const response = await fetch(`${API_BASE}/report?vin=${encodeURIComponent(vin)}`, {
      headers: { 'X-API-Key': API_KEY }
    });
    const data = await response.json();

    if (data.success && data.data && data.data.html_content) {
      const token = saveSharedReport(vin, data.data.html_content, 'credit');
      data.shareToken = token;
    }

    const updatedUser = db.prepare('SELECT credits FROM users WHERE id = ?').get(req.session.userId);
    data.remaining_credits = updatedUser.credits;

    res.json(data);
  } catch (err) {
    // Refund the credit if API call failed
    db.prepare('UPDATE users SET credits = credits + 1 WHERE id = ?').run(req.session.userId);
    console.error('Use credit error:', err.message);
    res.status(500).json({ error: 'Failed to fetch report. Credit has been refunded.' });
  }
});

/* ==========================================================
   Verify payment & fetch report (single $5.99 purchase)
   ========================================================== */
app.get('/api/report', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'Session ID is required' });

  try {
    const checkoutSession = await stripe.checkout.sessions.retrieve(session_id);

    if (checkoutSession.payment_status !== 'paid') {
      return res.status(402).json({ error: 'Payment not completed' });
    }

    const vin = checkoutSession.metadata.vin;
    if (!vin) return res.status(400).json({ error: 'No VIN found in session' });

    const userId = checkoutSession.metadata.user_id || (req.session.userId ? String(req.session.userId) : null);
    if (userId) {
      const existing = db.prepare('SELECT id FROM reports WHERE stripe_session_id = ?').get(session_id);
      if (!existing) {
        db.prepare('INSERT INTO reports (user_id, vin, vehicle_name, stripe_session_id) VALUES (?, ?, ?, ?)')
          .run(parseInt(userId), vin, checkoutSession.metadata.vehicle_name || '', session_id);
      }
    }

    const response = await fetch(`${API_BASE}/report?vin=${encodeURIComponent(vin)}`, {
      headers: { 'X-API-Key': API_KEY }
    });
    const data = await response.json();

    if (data.success && data.data && data.data.html_content) {
      const token = saveSharedReport(vin, data.data.html_content, 'paid');
      data.shareToken = token;
    }

    res.json(data);
  } catch (err) {
    console.error('Report error:', err.message);
    if (err.type === 'StripeInvalidRequestError') {
      return res.status(400).json({ error: 'Invalid or expired session. Please try again.' });
    }
    res.status(500).json({ error: 'Failed to fetch report' });
  }
});

/* ==========================================================
   User's past reports
   ========================================================== */
app.get('/api/my-reports', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Please log in.' });
  }
  const reports = db.prepare('SELECT vin, vehicle_name, stripe_session_id, paid_with_credits, created_at FROM reports WHERE user_id = ? ORDER BY created_at DESC').all(req.session.userId);
  const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(req.session.userId);
  res.json({ success: true, reports, credits: user ? user.credits : 0 });
});

/* ==========================================================
   Admin Auth
   ========================================================== */
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Incorrect password. Try again.' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  req.session.isAdmin = false;
  res.json({ success: true });
});

app.get('/api/admin/check', (req, res) => {
  res.json({ isAdmin: !!req.session.isAdmin });
});

/* ==========================================================
   Admin: Free Report (no Stripe)
   ========================================================== */
app.post('/api/admin/report', requireAdmin, async (req, res) => {
  const { vin } = req.body;
  if (!vin) return res.status(400).json({ error: 'VIN is required' });

  try {
    const response = await fetch(`${API_BASE}/report?vin=${encodeURIComponent(vin)}`, {
      headers: { 'X-API-Key': API_KEY }
    });
    const data = await response.json();

    if (data.success && data.data && data.data.html_content) {
      const token = saveSharedReport(vin, data.data.html_content, 'admin');
      data.shareToken = token;
    }

    res.json(data);
  } catch (err) {
    console.error('Admin report error:', err.message);
    res.status(500).json({ error: 'Failed to fetch report' });
  }
});

app.get('/api/admin/reports', requireAdmin, (req, res) => {
  const reports = db.prepare('SELECT token, vin, source, created_at FROM shared_reports ORDER BY created_at DESC LIMIT 50').all();
  res.json({ success: true, reports });
});

/* ==========================================================
   Shared Report Viewer (public link)
   ========================================================== */
app.get('/shared/:token/raw', (req, res) => {
  const report = db.prepare('SELECT * FROM shared_reports WHERE token = ?').get(req.params.token);
  if (!report) return res.status(404).send('<h1 style="font-family:sans-serif;text-align:center;margin-top:4rem">Report not found or expired.</h1>');
  // Inject auto-print so "Save as PDF" works seamlessly
  const withPrint = report.report_html.replace('</body>', '<script>window.onload=function(){window.print();}<\/script></body>');
  res.send(withPrint);
});

app.get('/shared/:token', (req, res) => {
  const report = db.prepare('SELECT * FROM shared_reports WHERE token = ?').get(req.params.token);
  if (!report) {
    return res.status(404).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Not Found</title><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f9fafb}div{text-align:center}</style></head><body><div><h2>Report not found or expired.</h2><p><a href="/">Return to homepage</a></p></div></body></html>`);
  }

  const shareUrl = `${req.protocol}://${req.get('host')}/shared/${report.token}`;
  const pdfUrl   = `${req.protocol}://${req.get('host')}/shared/${report.token}/raw`;

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vehicle History Report — ${report.vin || 'CheapCarfax'}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400;14..32,500;14..32,600;14..32,700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Inter', sans-serif; background: #f3f4f6; min-height: 100vh; }
    .toolbar {
      position: sticky; top: 0; z-index: 100;
      background: #111827; color: #fff;
      padding: 0.75rem 1.5rem;
      display: flex; align-items: center; gap: 1rem; flex-wrap: wrap;
      box-shadow: 0 2px 12px rgba(0,0,0,0.3);
    }
    .toolbar-brand { font-weight: 700; font-size: 1rem; color: #fff; text-decoration: none; margin-right: auto; display: flex; align-items: center; gap: 0.5rem; }
    .toolbar-brand span { color: #60a5fa; }
    .toolbar-btn {
      display: inline-flex; align-items: center; gap: 0.4rem;
      padding: 0.5rem 1rem; border-radius: 8px; font-size: 0.875rem; font-weight: 600;
      border: none; cursor: pointer; transition: background 0.15s, transform 0.1s; text-decoration: none;
    }
    .btn-pdf { background: #2563eb; color: #fff; }
    .btn-pdf:hover { background: #1d4ed8; transform: translateY(-1px); }
    .btn-copy { background: #374151; color: #e5e7eb; }
    .btn-copy:hover { background: #4b5563; }
    .btn-copy.copied { background: #065f46; color: #6ee7b7; }
    .vin-badge { font-size: 0.75rem; color: #9ca3af; background: #1f2937; padding: 0.25rem 0.6rem; border-radius: 6px; font-family: monospace; }
    .report-wrap { max-width: 980px; margin: 1.5rem auto; padding: 0 1rem 3rem; }
    .report-card { background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1), 0 8px 24px rgba(0,0,0,0.06); }
    .report-card iframe { width: 100%; min-height: 85vh; border: none; display: block; }
    @media print { .toolbar { display: none; } }
  </style>
</head>
<body>
  <div class="toolbar">
    <a class="toolbar-brand" href="/"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 17h1a2 2 0 0 0 2-2v-1h8v1a2 2 0 0 0 2 2h1a1 1 0 0 0 1-1v-4l-2.3-6.1A2 2 0 0 0 15.8 4H8.2a2 2 0 0 0-1.9 1.3L4 11v5a1 1 0 0 0 1 1z"/><circle cx="7.5" cy="17.5" r="1.5"/><circle cx="16.5" cy="17.5" r="1.5"/></svg>Cheap<span>Carfax</span></a>
    ${report.vin ? `<span class="vin-badge">VIN: ${report.vin}</span>` : ''}
    <a class="toolbar-btn btn-pdf" href="${pdfUrl}" target="_blank">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      Download PDF
    </a>
    <button class="toolbar-btn btn-copy" id="copyBtn" onclick="copyLink()">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
      <span id="copyText">Copy Link</span>
    </button>
  </div>

  <div class="report-wrap">
    <div class="report-card">
      <iframe id="reportFrame" title="Vehicle History Report" sandbox="allow-same-origin"></iframe>
    </div>
  </div>

  <script>
    var shareUrl = ${JSON.stringify(shareUrl)};

    // Load report HTML into iframe
    (function() {
      var iframe = document.getElementById('reportFrame');
      var doc = iframe.contentDocument || iframe.contentWindow.document;
      doc.open();
      doc.write(${JSON.stringify(report.report_html)});
      doc.close();
      function resize() {
        try {
          var h = doc.documentElement.scrollHeight || doc.body.scrollHeight;
          if (h > 300) iframe.style.height = h + 'px';
        } catch(e) {}
      }
      iframe.onload = resize;
      setTimeout(resize, 600);
      setTimeout(resize, 1800);
      setTimeout(resize, 3500);
    })();

    function copyLink() {
      navigator.clipboard.writeText(shareUrl).then(function() {
        var btn = document.getElementById('copyBtn');
        var txt = document.getElementById('copyText');
        btn.classList.add('copied');
        txt.textContent = 'Copied!';
        setTimeout(function() { btn.classList.remove('copied'); txt.textContent = 'Copy Link'; }, 2500);
      }).catch(function() {
        prompt('Copy this link:', shareUrl);
      });
    }
  </script>
</body>
</html>`);
});

/* ==========================================================
   Process handlers
   ========================================================== */
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err.message);
});

process.stdin.resume();

app.listen(PORT, () => {
  console.log(`CheapCarfax server running at http://localhost:${PORT}`);
});
