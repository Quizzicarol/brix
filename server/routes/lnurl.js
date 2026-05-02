const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { getDb } = require('../models/database');
const { sendWakeUpPush } = require('../services/push');
const wallet = require('../services/wallet');

const DOMAIN = process.env.BRIX_DOMAIN || 'localhost:3100';
const PROTOCOL = process.env.NODE_ENV === 'production' ? 'https' : 'http';

const MIN_SENDABLE_MSATS = 1000;        // 1 sat
const MAX_SENDABLE_MSATS = 1000000000;  // 1M sats

// Concurrent poll limiter: max 5 active polls per user to prevent resource exhaustion
const activePolls = new Map();

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

// Rate limit LNURL callback per IP+identifier to prevent DDoS
const lnurlCallbackLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 5,               // Max 5 callbacks per IP per identifier per minute
  keyGenerator: (req) => `${req.ip}:${req.params.identifier}`,
  message: { status: 'ERROR', reason: 'Rate limit exceeded. Try again later.' },
});

/**
 * LNURL-pay callback
 *
 * Flow:
 * 1. Try to get a Spark invoice from the recipient's app (polling + FCM push)
 * 2. If app responds: sender pays Spark invoice → direct to recipient
 * 3. If app is offline: server wallet creates invoice → stores pending payment
 *    → recipient claims when they open the app
 */
router.get('/:identifier/callback', lnurlCallbackLimiter, async (req, res) => {
  const { identifier } = req.params;
  const { amount, comment, source, sender } = req.query;
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

    // Limit concurrent polls per user to prevent resource exhaustion
    const pollKey = `user:${user.id}`;
    const currentPolls = activePolls.get(pollKey) || 0;
    if (currentPolls >= 5) {
      return res.status(429).json({
        status: 'ERROR',
        reason: 'Too many pending payments for this user. Try again shortly.',
      });
    }
    activePolls.set(pollKey, currentPolls + 1);

    // ── Create invoice request for app to fulfill ──
    // If sender pubkey is provided (internal BRIX→BRIX send), store it so
    // the sender's own relay doesn't intercept this request
    const senderPubkey = (sender && /^[0-9a-f]{64}$/.test(sender)) ? sender : null;
    const requestId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO brix_invoice_requests (id, user_id, amount_sats, status, sender_pubkey, comment)
      VALUES (?, ?, ?, 'pending', ?, ?)
    `).run(requestId, user.id, amountSats, senderPubkey, sanitizedComment);

    // Check if user's app is reachable (has FCM token or was recently seen polling)
    // Also check sibling users with same pubkey (multiple usernames, same device)
    let recentlySeen = user.last_seen && (Date.now() - new Date(user.last_seen + 'Z').getTime()) < 120000;
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
        if (!recentlySeen && sibling.last_seen && (Date.now() - new Date(sibling.last_seen + 'Z').getTime()) < 120000) {
          recentlySeen = true;
        }
      }
    }

    console.log(`[LNURL] Request ${requestId} for ${lnAddress}: ${amountSats} sats (source=${source || 'external'}) — racing app vs server fallback... (fcm=${hasFcm}, recentlySeen=${recentlySeen})`);

    // Always send FCM push immediately (in parallel with polling)
    // so the app wakes up ASAP even if it missed a poll cycle
    if (hasFcm) {
      sendWakeUpPush(fcmUserId, requestId, amountSats).then(sent => {
        if (sent) console.log(`[LNURL] Push sent to ${lnAddress}`);
      }).catch(() => {});
    }

    // ── Parallel race: app Spark invoice vs server wallet fallback ──
    //
    // External LN wallets (Wallet of Satoshi, Coinos, etc.) typically time out
    // LNURL callbacks at ~30s. We must respond within that window.
    //
    // Strategy:
    //   1. Start server-wallet invoice creation immediately (in parallel)
    //   2. Poll for app's Spark invoice with ~18s budget
    //   3. If app wins → use Spark (preferred, direct routing)
    //   4. Else → use server invoice (already in-flight, ~5s)
    //
    // Worst case: ~23s total, well within external wallet timeout.
    const POLL_BUDGET_MS = 18000;
    const memo = sanitizedComment
      ? `BRIX: ${sanitizedComment}`
      : `BRIX Payment to ${lnAddress}`;

    // Kick off server invoice creation in parallel (only if wallet enabled)
    let serverInvoicePromise = null;
    if (wallet.isEnabled()) {
      serverInvoicePromise = wallet.createInvoice(amountSats, memo)
        .catch(err => {
          console.error(`[LNURL] Server wallet invoice creation failed: ${err.message}`);
          return null;
        });
    }

    const sparkInvoice = await pollForInvoice(db, requestId, POLL_BUDGET_MS);

    // ── App responded with a Spark invoice ──
    if (sparkInvoice) {
      db.prepare(`UPDATE brix_invoice_requests SET status = 'completed' WHERE id = ?`).run(requestId);
      console.log(`[LNURL] ✓ Spark invoice ready for ${lnAddress}: ${amountSats} sats (app online)`);

      // Server invoice (if any) was created but won't be paid — Spark SDK
      // will let it expire naturally, no DB row created.
      return res.json({
        pr: sparkInvoice,
        routes: [],
        successAction: {
          tag: 'message',
          message: `Pagamento de ${amountSats} sats enviado para ${lnAddress}!`,
        },
      });
    }

    // ── App didn't respond — use server wallet as offline fallback ──
    db.prepare(`UPDATE brix_invoice_requests SET status = 'expired' WHERE id = ?`).run(requestId);

    if (serverInvoicePromise) {
      console.log(`[LNURL] App offline for ${lnAddress} — using server wallet fallback for ${amountSats} sats`);

      const serverInvoice = await serverInvoicePromise;
      if (serverInvoice && serverInvoice.bolt11) {
        const { bolt11, paymentHash } = serverInvoice;

        // Store as pending payment — will be forwarded when recipient comes online
        const pendingId = crypto.randomUUID();
        db.prepare(`
          INSERT INTO brix_pending_payments
            (id, user_id, amount_sats, payment_hash, status, sender_note, server_payment_hash, server_invoice)
          VALUES (?, ?, ?, ?, 'pending_payment', ?, ?, ?)
        `).run(pendingId, user.id, amountSats, paymentHash, sanitizedComment, paymentHash, bolt11);

        console.log(`[LNURL] ✓ Offline invoice created for ${lnAddress}: ${amountSats} sats (pending_id=${pendingId.substring(0, 8)})`);

        return res.json({
          pr: bolt11,
          routes: [],
          successAction: {
            tag: 'message',
            message: `Pagamento de ${amountSats} sats será entregue a ${lnAddress} quando abrir o app.`,
          },
        });
      }

      console.error(`[LNURL] Server wallet fallback returned no invoice for ${lnAddress}`);
      return res.json({
        status: 'ERROR',
        reason: 'Destinatário offline e fallback indisponível. Tente novamente.',
      });
    } else {
      console.log(`[LNURL] ✗ App offline for ${lnAddress} — no Spark invoice generated. Server wallet disabled.`);
      return res.json({
        status: 'ERROR',
        reason: 'Destinatário offline. Tente novamente em alguns minutos.',
      });
    }
  } catch (err) {
    console.error('Error in LNURL callback:', err);
    res.status(500).json({
      status: 'ERROR',
      reason: 'Failed to generate invoice',
    });
  } finally {
    // Decrement concurrent poll counter
    const pollKey = `user:${user.id}`;
    const count = activePolls.get(pollKey) || 1;
    if (count <= 1) {
      activePolls.delete(pollKey);
    } else {
      activePolls.set(pollKey, count - 1);
    }
  }
});

// ── Helper ──

function pollForInvoice(db, requestId, timeoutMs = 25000) {
  const POLL_INTERVAL = 200;
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
