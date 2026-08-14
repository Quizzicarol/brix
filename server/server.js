require('dotenv').config();
const express = require('express');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const db = require('./models/database');
const lnurlRoutes = require('./routes/lnurl');
const brixRoutes = require('./routes/brix');
const { nip98Auth } = require('./middleware/nip98');

const app = express();
const PORT = process.env.PORT || 3100;
const HOST = process.env.HOST || '0.0.0.0';

// Trust proxy (required behind Fly.io reverse proxy for rate limiting)
app.set('trust proxy', 1);

// Security
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
    },
  },
}));
app.use(cors({
  origin: [
    'https://brix.brostr.app',
    'https://www.brostr.app',
    'https://brostr.app',
  ],
  methods: ['GET', 'POST'],
}));
// v566: capture raw body so NIP-98 payload tag (sha256 of body) can be verified
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// NIP-98 HTTP Auth — verify signed requests (backward-compatible)
app.use(nip98Auth);

// Global rate limiting (high enough for relay polling at ~1.5s intervals)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1500,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip rate limiting for relay polling and LNURL (time-critical paths)
    return req.path.startsWith('/brix/invoice-requests') ||
           req.path.startsWith('/brix/submit-invoice') ||
           req.path.startsWith('/.well-known/lnurlp') ||
           req.path.startsWith('/lnurlp') ||
           req.path === '/health';
  },
});
app.use(limiter);

// Strict rate limiting for registration and verification
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});
app.use('/brix/register', authLimiter);
app.use('/brix/verify', authLimiter);
app.use('/brix/resend', authLimiter);
app.use('/brix/update-contact', authLimiter);
app.use('/brix/confirm-update', authLimiter);

// vSEC: rate limit dedicado para /brix/claim (movimenta dinheiro).
// 30/15min por IP é folgado p/ uso legítimo (vários pagamentos pendentes)
// e bloqueia floods automatizados. O claim em si já é atômico + autenticado.
const claimLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many claim requests, please try again later' },
});
app.use('/brix/claim', claimLimiter);

// Rate limiting for lookup endpoints (prevent enumeration/scraping)
const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many lookup requests, please try again later' },
});
app.use('/brix/resolve', lookupLimiter);
app.use('/brix/find-by-email', lookupLimiter);

// Rate limiting for LNURL callback (prevent DDoS via invoice request flooding)
const lnurlCallbackLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.params.identifier || req.ip,
  message: { status: 'ERROR', reason: 'Too many payment requests. Try again in a minute.' },
});
app.use('/.well-known/lnurlp/:identifier/callback', lnurlCallbackLimiter);
app.use('/lnurlp/:identifier/callback', lnurlCallbackLimiter);

// Serve static web frontend
app.use(express.static(path.join(__dirname, '..', 'web')));

// Spark SSP webhook — the Spark SSP calls this when an incoming Lightning
// payment for the server wallet is received/finished. We immediately sync the
// wallet (claims the pending transfer) and run a forward tick so the sats are
// forwarded to the offline recipient. This makes offline receiving work
// server-side without requiring the recipient's app to be open. The action is
// idempotent and exposes no sensitive data.
//
// SECURITY (vSEC): the SSP signs every webhook call with an
// `X-Spark-Signature` header = HMAC-SHA256(rawBody, webhookSecret). Verify it
// BEFORE doing any work — without this, anyone could spam syncNow()/tick()
// (DoS) or use the `parse` shortcut as an oracle.
const { webhookSecret } = require('./services/webhook-secret');
const crypto = require('crypto');
app.post('/brix/spark-webhook', (req, res) => {
  const signature = req.headers['x-spark-signature'];
  const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const expected = crypto.createHmac('sha256', webhookSecret).update(raw).digest('hex');
  const sigBuf = Buffer.from(String(signature || ''), 'utf8');
  const expBuf = Buffer.from(expected, 'utf8');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    console.warn('[SPARK-WEBHOOK] REJEITADO: assinatura inválida/ausente');
    return res.status(401).json({ ok: false, error: 'invalid signature' });
  }
  (async () => {
    try {
      console.log('[SPARK-WEBHOOK] received (assinatura OK): ' + JSON.stringify(req.body || {}));
    } catch (_) {}
    res.status(200).json({ ok: true });
    try {
      const wallet = require('./services/wallet');
      if (req.body && req.body.parse) {
        await wallet.parseInvoice(String(req.body.parse));
        return;
      }
      await wallet.syncNow();
      const paymentForward = require('./services/payment-forward');
      if (paymentForward.tick) paymentForward.tick().catch(() => {});
    } catch (e) {
      console.error('[SPARK-WEBHOOK] handler error: ' + (e && e.message));
    }
  })();
});

// LNURL routes (public, follows LUD-16 spec)
app.use('/.well-known/lnurlp', lnurlRoutes);

// Callback route (needs to be at root level for LNURL compatibility)
app.use('/lnurlp', lnurlRoutes);

// BRIX app routes (authenticated)
app.use('/brix', brixRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'brix-server', version: '0.2.0' });
});

// Admin-only debug endpoint — requires NIP-98 auth from ADMIN_PUBKEY
const ADMIN_PUBKEY = process.env.ADMIN_PUBKEY || '';
app.get('/debug/brix-status', (req, res) => {
  if (!req.verifiedPubkey || req.verifiedPubkey !== ADMIN_PUBKEY) {
    return res.status(403).json({ error: 'admin auth required' });
  }
  try {
    const conn = db.getDb();
    const users = conn.prepare(`
      SELECT username, nostr_pubkey, last_seen, verified, created_at
      FROM brix_users ORDER BY last_seen DESC LIMIT 20
    `).all();
    const recentRequests = conn.prepare(`
      SELECT ir.id, ir.user_id, ir.amount_sats, ir.status, ir.created_at, ir.updated_at,
             u.username
      FROM brix_invoice_requests ir
      LEFT JOIN brix_users u ON u.id = ir.user_id
      ORDER BY ir.created_at DESC LIMIT 20
    `).all();
    const recentPayments = conn.prepare(`
      SELECT pp.id, pp.amount_sats, pp.status, pp.server_invoice IS NOT NULL as has_invoice, pp.created_at,
             u.username
      FROM brix_pending_payments pp
      LEFT JOIN brix_users u ON u.id = pp.user_id
      ORDER BY pp.created_at DESC LIMIT 20
    `).all();
    res.json({ users, recentRequests, recentPayments });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Initialize database and start
db.initialize();

// One-time fix: carol's nostr_pubkey was incorrectly set to quizzicarol's pubkey
try {
  const conn = db.getDb();
  const carolCorrectPubkey = '0b31181f021539d1afcda76e66577d5a7797a9603ac4a7aa46514745c8acfc26';
  const carol = conn.prepare('SELECT nostr_pubkey FROM brix_users WHERE username = ? AND verified = 1').get('carol');
  if (carol && carol.nostr_pubkey !== carolCorrectPubkey) {
    conn.prepare('UPDATE brix_users SET nostr_pubkey = ? WHERE username = ? AND verified = 1').run(carolCorrectPubkey, 'carol');
    console.log(`[FIX] Updated carol's nostr_pubkey from ${carol.nostr_pubkey?.substring(0,16)}... to ${carolCorrectPubkey.substring(0,16)}...`);
  } else if (carol) {
    console.log('[FIX] carol pubkey already correct');
  }
} catch (e) {
  console.log('[FIX] Error fixing carol pubkey:', e.message);
}

// Startup diagnostic: check user states
try {
  const conn = db.getDb();
  const users = conn.prepare(`
    SELECT username, nostr_pubkey, last_seen, verified, fcm_token IS NOT NULL as has_fcm
    FROM brix_users WHERE verified = 1 ORDER BY last_seen DESC LIMIT 10
  `).all();
  for (const u of users) {
    console.log(`[STARTUP] user=${u.username} pubkey=${u.nostr_pubkey?.substring(0,16)}... last_seen=${u.last_seen} fcm=${u.has_fcm} verified=${u.verified}`);
  }
} catch (e) {
  console.log('[STARTUP] Diagnostic error:', e.message);
}

app.listen(PORT, HOST, () => {
  console.log(`BRIX server running on http://${HOST}:${PORT}`);
  console.log(`Web UI: http://localhost:${PORT}`);
  console.log(`API:    http://localhost:${PORT}/brix`);
  console.log(`LNURL:  http://localhost:${PORT}/.well-known/lnurlp/<identifier>`);

  // Log wallet status
  const wallet = require('./services/wallet');
  console.log(`[WALLET] enabled=${wallet.isEnabled()} provider=${process.env.WALLET_PROVIDER || 'none'} mode=${wallet.getMode()}`);

  // Start payment forwarder (polls for paid invoices and forwards to recipients)
  const paymentForward = require('./services/payment-forward');
  paymentForward.start();
});

// Cleanup expired invoice requests daily (prevent DB bloat from DDoS/spam)
setInterval(() => {
  try {
    const conn = db.getDb();
    const result = conn.prepare(`
      DELETE FROM brix_invoice_requests
      WHERE status IN ('expired', 'completed') AND created_at < datetime('now', '-7 days')
    `).run();
    if (result.changes > 0) {
      console.log(`[CLEANUP] Deleted ${result.changes} old invoice requests`);
    }
  } catch (e) {
    console.error('[CLEANUP] Error:', e.message);
  }
}, 24 * 60 * 60 * 1000); // Every 24 hours

module.exports = app;
