const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getDb } = require('../models/database');
const { sendWakeUpPush } = require('../services/push');

const DOMAIN = process.env.BRIX_DOMAIN || 'localhost:3100';
const PROTOCOL = process.env.NODE_ENV === 'production' ? 'https' : 'http';

const MIN_SENDABLE_MSATS = 1000;        // 1 sat
const MAX_SENDABLE_MSATS = 1000000000;  // 1M sats

/**
 * LUD-16: Lightning Address resolution
 * GET /.well-known/lnurlp/:identifier
 */
router.get('/:identifier', (req, res) => {
  const { identifier } = req.params;
  const db = getDb();

  const user = db.prepare(
    'SELECT * FROM brix_users WHERE username = ? AND verified = 1'
  ).get(identifier);

  if (!user) {
    return res.status(404).json({
      status: 'ERROR',
      reason: 'User not found or not verified',
    });
  }

  const lnAddress = `${identifier}@${DOMAIN}`;

  const metadataText = `Payment to ${lnAddress}`;

  const metadata = JSON.stringify([
    ['text/plain', metadataText],
    ['text/identifier', lnAddress],
  ]);

  res.json({
    callback: `${PROTOCOL}://${DOMAIN}/lnurlp/${identifier}/callback`,
    maxSendable: MAX_SENDABLE_MSATS,
    minSendable: MIN_SENDABLE_MSATS,
    metadata,
    tag: 'payRequest',
    commentAllowed: 140,
  });
});

/**
 * LNURL-pay callback
 *
 * All senders (BRIX app or external wallets) get the Spark invoice directly.
 * The app generates a Spark/Greenlight invoice and the server returns it.
 * Platform fees (0.5%) are collected app-side after payment settles.
 *
 * If recipient app is offline: BRIX_RECIPIENT_OFFLINE error returned.
 */
router.get('/:identifier/callback', async (req, res) => {
  const { identifier } = req.params;
  const { amount, comment, source } = req.query;
  const db = getDb();

  const amountMsats = parseInt(amount, 10);
  if (!amountMsats || amountMsats < MIN_SENDABLE_MSATS || amountMsats > MAX_SENDABLE_MSATS) {
    return res.status(400).json({
      status: 'ERROR',
      reason: `Amount must be between ${MIN_SENDABLE_MSATS} and ${MAX_SENDABLE_MSATS} msats`,
    });
  }

  const user = db.prepare(
    'SELECT * FROM brix_users WHERE username = ? AND verified = 1'
  ).get(identifier);

  if (!user) {
    return res.status(404).json({ status: 'ERROR', reason: 'User not found' });
  }

  try {
    const amountSats = Math.floor(amountMsats / 1000);
    const lnAddress = `${identifier}@${DOMAIN}`;
    const sanitizedComment = comment ? String(comment).slice(0, 140) : null;

    // ── Create invoice request for app to fulfill ──
    const requestId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO brix_invoice_requests (id, user_id, amount_sats, status)
      VALUES (?, ?, ?, 'pending')
    `).run(requestId, user.id, amountSats);

    console.log(`[LNURL] Request ${requestId} for ${lnAddress}: ${amountSats} sats (source=${source || 'external'}) — waiting for app...`);

    // ── First try: quick poll (app may already be online polling) ──
    const QUICK_TIMEOUT = 8000;
    let sparkInvoice = await pollForInvoice(db, requestId, QUICK_TIMEOUT);

    // ── If no response, send push notification to wake up the app ──
    if (!sparkInvoice) {
      const pushSent = await sendWakeUpPush(user.id, requestId, amountSats);
      if (pushSent) {
        console.log(`[LNURL] Push sent to ${lnAddress}, extending timeout...`);
        // Give app time to wake up and generate invoice (extra 30s)
        const PUSH_TIMEOUT = 30000;
        sparkInvoice = await pollForInvoice(db, requestId, PUSH_TIMEOUT);
      }
    }

    if (!sparkInvoice) {
      console.log(`[LNURL] Request ${requestId} timed out — recipient offline`);
      db.prepare(`UPDATE brix_invoice_requests SET status = 'expired' WHERE id = ?`).run(requestId);
      return res.json({ status: 'ERROR', reason: 'BRIX_RECIPIENT_OFFLINE' });
    }

    db.prepare(`UPDATE brix_invoice_requests SET status = 'completed' WHERE id = ?`).run(requestId);

    console.log(`[LNURL] Invoice ready for ${lnAddress}: ${amountSats} sats`);

    return res.json({
      pr: sparkInvoice,
      routes: [],
      successAction: {
        tag: 'message',
        message: `Pagamento de ${amountSats} sats enviado para ${lnAddress}!`,
      },
    });
  } catch (err) {
    console.error('Error in LNURL callback:', err);
    res.status(500).json({
      status: 'ERROR',
      reason: 'Failed to generate invoice',
    });
  }
});

// ── Helper ──

function pollForInvoice(db, requestId, timeoutMs = 25000) {
  const POLL_INTERVAL = 500;
  const startTime = Date.now();

  return new Promise((resolve) => {
    const check = () => {
      const request = db.prepare(
        `SELECT invoice FROM brix_invoice_requests WHERE id = ? AND status = 'ready'`
      ).get(requestId);

      if (request && request.invoice) {
        resolve(request.invoice);
        return;
      }

      if (Date.now() - startTime > timeoutMs) {
        resolve(null);
        return;
      }

      setTimeout(check, POLL_INTERVAL);
    };
    check();
  });
}

module.exports = router;
