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

// Add credits column if it doesn't exist (for existing databases)
try { db.exec('ALTER TABLE users ADD COLUMN credits INTEGER DEFAULT 0'); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE reports ADD COLUMN paid_with_credits INTEGER DEFAULT 0'); } catch (e) { /* already exists */ }

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
