const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getDb } = require('../models/database');

// Domain where the server is hosted (required for LNURL-pay callback URL)
const DOMAIN = process.env.BRIX_DOMAIN || 'localhost:3100';
const PROTOCOL = process.env.NODE_ENV === 'production' ? 'https' : 'http';

// Min/max sendable in millisats
const MIN_SENDABLE_MSATS = 1000;        // 1 sat
const MAX_SENDABLE_MSATS = 1000000000;  // 1M sats

/**
 * LUD-16: Lightning Address resolution
 * GET /.well-known/lnurlp/:identifier
 * 
 * Returns LNURL-pay metadata for the given identifier (phone, email, username)
 */
router.get('/:identifier', (req, res) => {
  const { identifier } = req.params;
  const db = getDb();

  // Look up verified user by username
  const user = db.prepare(
    'SELECT * FROM brix_users WHERE username = ? AND verified = 1'
  ).get(identifier);

  if (!user) {
    return res.status(404).json({
      status: 'ERROR',
      reason: 'User not found or not verified',
    });
  }

  // Build LNURL-pay response per LUD-06 / LUD-16
  const lnAddress = `${identifier}@${DOMAIN}`;
  const metadata = JSON.stringify([
    ['text/plain', `Payment to ${lnAddress}`],
    ['text/identifier', lnAddress],
  ]);

  res.json({
    callback: `${PROTOCOL}://${DOMAIN}/lnurlp/${identifier}/callback`,
    maxSendable: MAX_SENDABLE_MSATS,
    minSendable: MIN_SENDABLE_MSATS,
    metadata,
    tag: 'payRequest',
    // LUD-12: comments allowed
    commentAllowed: 140,
  });
});

/**
 * LNURL-pay callback — generates a Lightning invoice for the payment
 * GET /lnurlp/:identifier/callback?amount=<msats>&comment=<text>
 */
router.get('/:identifier/callback', async (req, res) => {
  const { identifier } = req.params;
  const { amount, comment } = req.query;
  const db = getDb();

  // Validate amount
  const amountMsats = parseInt(amount, 10);
  if (!amountMsats || amountMsats < MIN_SENDABLE_MSATS || amountMsats > MAX_SENDABLE_MSATS) {
    return res.status(400).json({
      status: 'ERROR',
      reason: `Amount must be between ${MIN_SENDABLE_MSATS} and ${MAX_SENDABLE_MSATS} msats`,
    });
  }

  // Verify user exists
  const user = db.prepare(
    'SELECT * FROM brix_users WHERE username = ? AND verified = 1'
  ).get(identifier);

  if (!user) {
    return res.status(404).json({
      status: 'ERROR',
      reason: 'User not found',
    });
  }

  try {
    const amountSats = Math.floor(amountMsats / 1000);
    const lnAddress = `${identifier}@${DOMAIN}`;

    // Create invoice request — the user's app will generate and submit the invoice
    const requestId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO brix_invoice_requests (id, user_id, amount_sats, status)
      VALUES (?, ?, ?, 'pending')
    `).run(requestId, user.id, amountSats);

    console.log(`[LNURL] Invoice request ${requestId} created for ${lnAddress}: ${amountSats} sats — waiting for app...`);

    // Poll for the app to submit the invoice (max 25 seconds)
    const startTime = Date.now();
    const TIMEOUT_MS = 25000;
    const POLL_INTERVAL = 500;

    const pollForInvoice = () => {
      return new Promise((resolve) => {
        const check = () => {
          const request = db.prepare(
            `SELECT invoice FROM brix_invoice_requests WHERE id = ? AND status = 'ready'`
          ).get(requestId);

          if (request && request.invoice) {
            resolve(request.invoice);
            return;
          }

          if (Date.now() - startTime > TIMEOUT_MS) {
            // Timeout — clean up
            db.prepare(`UPDATE brix_invoice_requests SET status = 'expired' WHERE id = ?`).run(requestId);
            resolve(null);
            return;
          }

          setTimeout(check, POLL_INTERVAL);
        };
        check();
      });
    };

    const invoice = await pollForInvoice();

    if (!invoice) {
      console.log(`[LNURL] Invoice request ${requestId} timed out`);
      return res.json({
        status: 'ERROR',
        reason: 'BRIX_RECIPIENT_OFFLINE',
      });
    }

    // Record pending payment
    const paymentId = crypto.randomUUID();
    const paymentHash = crypto.randomBytes(32).toString('hex');
    const sanitizedComment = comment ? String(comment).slice(0, 140) : null;
    db.prepare(`
      INSERT INTO brix_pending_payments (id, user_id, amount_sats, payment_hash, sender_note)
      VALUES (?, ?, ?, ?, ?)
    `).run(paymentId, user.id, amountSats, paymentHash, sanitizedComment);

    // Mark request as completed
    db.prepare(`UPDATE brix_invoice_requests SET status = 'completed' WHERE id = ?`).run(requestId);

    console.log(`[LNURL] Invoice relayed for ${lnAddress}: ${amountSats} sats`);

    res.json({
      pr: invoice,
      routes: [],
      successAction: {
        tag: 'message',
        message: `Pagamento de ${amountSats} sats enviado para ${lnAddress}!`,
      },
    });
  } catch (err) {
    console.error('Error generating invoice:', err);
    res.status(500).json({
      status: 'ERROR',
      reason: 'Failed to generate invoice',
    });
  }
});

module.exports = router;
