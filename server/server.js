require('dotenv').config();
const express = require('express');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const db = require('./models/database');
const lnurlRoutes = require('./routes/lnurl');
const brixRoutes = require('./routes/brix');

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
app.use(express.json());

// Global rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
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
app.use('/brix/register-push', lookupLimiter);

// Serve static web frontend
app.use(express.static(path.join(__dirname, '..', 'web')));

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

// Initialize database and start
db.initialize();

app.listen(PORT, HOST, () => {
  console.log(`BRIX server running on http://${HOST}:${PORT}`);
  console.log(`Web UI: http://localhost:${PORT}`);
  console.log(`API:    http://localhost:${PORT}/brix`);
  console.log(`LNURL:  http://localhost:${PORT}/.well-known/lnurlp/<identifier>`);
});

module.exports = app;
