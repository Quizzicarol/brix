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
 * Flow:
 * 1. Try to get a Spark invoice from the recipient's app (polling + FCM push)
 * 2. Sender pays the Spark invoice → money goes to recipient's Spark channel
 * 3. Recipient sees payment when they open the app (Spark is cloud-hosted)
 *
 * IMPORTANT: The invoice MUST always be a Spark invoice from the recipient's device.
 * Do NOT use LNbits or any server wallet as fallback.
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

    // Check if user's app is reachable (has FCM token or was recently seen polling)
    // Also check sibling users with same pubkey (multiple usernames, same device)
    let recentlySeen = user.last_seen && (Date.now() - new Date(user.last_seen + 'Z').getTime()) < 30000;
    let hasFcm = !!user.fcm_token;
    let fcmUserId = user.id;

    // If this user has no FCM/recentlySeen, check siblings with same pubkey
    if ((!hasFcm || !recentlySeen) && user.nostr_pubkey && !user.nostr_pubkey.startsWith('web_')) {
      const sibling = db.prepare(
        'SELECT id, fcm_token, last_seen FROM brix_users WHERE nostr_pubkey = ? AND id != ? AND verified = 1 ORDER BY last_seen DESC LIMIT 1'
      ).get(user.nostr_pubkey, user.id);
      if (sibling) {
        if (!hasFcm && sibling.fcm_token) {
          hasFcm = true;
          fcmUserId = sibling.id;
          console.log(`[LNURL] Using sibling FCM token for ${identifier}`);
        }
        if (!recentlySeen && sibling.last_seen && (Date.now() - new Date(sibling.last_seen + 'Z').getTime()) < 30000) {
          recentlySeen = true;
        }
      }
    }

    let sparkInvoice = null;

    if (hasFcm || recentlySeen) {
      console.log(`[LNURL] Request ${requestId} for ${lnAddress}: ${amountSats} sats (source=${source || 'external'}) — waiting for app... (fcm=${hasFcm}, recentlySeen=${recentlySeen})`);

      if (recentlySeen) {
        // App is actively polling — should respond quickly
        const QUICK_TIMEOUT = 8000;
        sparkInvoice = await pollForInvoice(db, requestId, QUICK_TIMEOUT);
      }

      // ── If not recently seen or quick poll failed, send push immediately ──
      if (!sparkInvoice) {
        let pushSent = await sendWakeUpPush(fcmUserId, requestId, amountSats);

        if (pushSent) {
          console.log(`[LNURL] Push sent to ${lnAddress}, extending timeout for background SDK init...`);
        } else {
          console.log(`[LNURL] No push available for ${lnAddress}, polling anyway...`);
        }
        // Extended poll — app needs time for background SDK cold-start + invoice generation
        const PUSH_TIMEOUT = 55000;
        sparkInvoice = await pollForInvoice(db, requestId, PUSH_TIMEOUT);
      }
    } else {
      // No FCM and not recently seen — still try polling, app might come online
      console.log(`[LNURL] User ${identifier} has no FCM token and app not recently seen — polling with extended timeout`);
      const EXTENDED_TIMEOUT = 55000;
      sparkInvoice = await pollForInvoice(db, requestId, EXTENDED_TIMEOUT);
    }

    // ── App responded with a Spark invoice ──
    if (sparkInvoice) {
      db.prepare(`UPDATE brix_invoice_requests SET status = 'completed' WHERE id = ?`).run(requestId);
      console.log(`[LNURL] ✓ Spark invoice ready for ${lnAddress}: ${amountSats} sats`);

      return res.json({
        pr: sparkInvoice,
        routes: [],
        successAction: {
          tag: 'message',
          message: `Pagamento de ${amountSats} sats enviado para ${lnAddress}!`,
        },
      });
    }

    // ── App didn't respond — payment cannot proceed without Spark invoice ──
    db.prepare(`UPDATE brix_invoice_requests SET status = 'expired' WHERE id = ?`).run(requestId);
    console.log(`[LNURL] ✗ App offline for ${lnAddress} — no Spark invoice generated. Payment cannot proceed.`);

    return res.json({
      status: 'ERROR',
      reason: 'Destinatário offline. Tente novamente em alguns minutos.',
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
