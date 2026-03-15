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
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

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
  res.json({ status: 'ok', service: 'brix-server', version: '0.1.0' });
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
