const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getDb } = require('../models/database');
const wallet = require('../services/wallet');
const { calculateFee } = require('../services/fee');

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
  const feeEnabled = wallet.isEnabled();

  const metadataText = feeEnabled
    ? `Payment to ${lnAddress} (1% service fee)`
    : `Payment to ${lnAddress}`;

  const metadata = JSON.stringify([
    ['text/plain', metadataText],
    ['text/identifier', lnAddress],
  ]);

  res.json({
    callback: `${PROTOCOL}://${DOMAIN}/lnurlp/${identifier}/callback`,
    maxSendable: MAX_SENDABLE_MSATS,
    minSendable: feeEnabled ? Math.max(MIN_SENDABLE_MSATS, 2000) : MIN_SENDABLE_MSATS,
    metadata,
    tag: 'payRequest',
    commentAllowed: 140,
  });
});

/**
 * LNURL-pay callback — with optional 1% fee collection.
 *
 * When fees are enabled (BRIX_FEE_ENABLED=true):
 *   1. App generates invoice for NET amount (gross - 1%)
 *   2. Server creates its OWN invoice for GROSS amount via wallet
 *   3. Sender pays server invoice
 *   4. Background forwarder pays app invoice (net), keeps fee
 *
 * When fees are disabled (default):
 *   Same as before — app's invoice is returned directly to sender.
 */
router.get('/:identifier/callback', async (req, res) => {
  const { identifier } = req.params;
  const { amount, comment } = req.query;
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
    const grossAmountSats = Math.floor(amountMsats / 1000);
    const lnAddress = `${identifier}@${DOMAIN}`;
    const sanitizedComment = comment ? String(comment).slice(0, 140) : null;

    // ── Calculate fee (if enabled) ──
    const feeEnabled = wallet.isEnabled();
    let feeInfo = null;
    let invoiceAmountSats = grossAmountSats;

    if (feeEnabled) {
      try {
        feeInfo = calculateFee(grossAmountSats);
        invoiceAmountSats = feeInfo.netAmountSats;
      } catch (_) {
        // Amount too small for fee — process without fee
        feeInfo = null;
      }
    }

    // ── Create invoice request (app sees this amount) ──
    const requestId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO brix_invoice_requests (id, user_id, amount_sats, status)
      VALUES (?, ?, ?, 'pending')
    `).run(requestId, user.id, invoiceAmountSats);

    console.log(`[LNURL] Request ${requestId} for ${lnAddress}: ${invoiceAmountSats} sats` +
      (feeInfo ? ` (gross: ${grossAmountSats}, fee: ${feeInfo.feeSats})` : '') +
      ' — waiting for app...');

    // ── Poll for app to submit invoice ──
    const invoice = await pollForInvoice(db, requestId);

    if (!invoice) {
      // ═══ OFFLINE PATH: Accept payment via server wallet ═══
      if (wallet.isEnabled()) {
        try {
          console.log(`[LNURL] Request ${requestId} timed out — creating server invoice for offline delivery`);

          const serverInvoice = await wallet.createInvoice(
            grossAmountSats,
            `BRIX: ${lnAddress} (offline)`,
          );

          const feeSats = feeInfo ? feeInfo.feeSats : 0;
          const netSats = feeInfo ? feeInfo.netAmountSats : grossAmountSats;
          const paymentId = crypto.randomUUID();

          db.prepare(`
            INSERT INTO brix_pending_payments
            (id, user_id, amount_sats, payment_hash, status, sender_note,
             server_invoice, server_payment_hash, fee_sats, net_amount_sats)
            VALUES (?, ?, ?, ?, 'pending_payment', ?, ?, ?, ?, ?)
          `).run(paymentId, user.id, grossAmountSats, serverInvoice.paymentHash,
                 sanitizedComment, serverInvoice.bolt11, serverInvoice.paymentHash,
                 feeSats, netSats);

          db.prepare(`UPDATE brix_invoice_requests SET status = 'completed' WHERE id = ?`).run(requestId);

          console.log(`[LNURL] Offline invoice for ${lnAddress}: ${grossAmountSats} sats (fee: ${feeSats}, net: ${netSats})`);

          return res.json({
            pr: serverInvoice.bolt11,
            routes: [],
            successAction: {
              tag: 'message',
              message: `Pagamento de ${grossAmountSats} sats enviado para ${lnAddress}! Será entregue quando o destinatário ficar online.`,
            },
          });
        } catch (walletErr) {
          console.error(`[LNURL] Failed to create offline invoice: ${walletErr.message}`);
        }
      }

      console.log(`[LNURL] Request ${requestId} timed out — no offline fallback available`);
      return res.json({ status: 'ERROR', reason: 'BRIX_RECIPIENT_OFFLINE' });
    }

    // ═══ FEE PATH: Create server invoice → forward to recipient ═══
    if (feeInfo) {
      try {
        let serverInvoice;
        let preimage = null;

        if (wallet.isHodlMode()) {
          // HODL mode: atomic, sender refunded on failure
          const hodl = await wallet.createHodlInvoice(
            grossAmountSats,
            `BRIX: ${lnAddress}`,
          );
          serverInvoice = { bolt11: hodl.bolt11, paymentHash: hodl.paymentHash };
          preimage = hodl.preimage;
        } else {
          // Regular mode: simple invoice, works with any LNbits
          serverInvoice = await wallet.createInvoice(
            grossAmountSats,
            `BRIX: ${lnAddress}`,
          );
        }

        const feeId = crypto.randomUUID();
        db.prepare(`
          INSERT INTO brix_fee_transactions
          (id, request_id, user_id, gross_amount_sats, fee_sats, net_amount_sats, fee_rate,
           server_invoice, server_payment_hash, preimage, recipient_invoice, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
        `).run(feeId, requestId, user.id, grossAmountSats, feeInfo.feeSats,
               feeInfo.netAmountSats, feeInfo.feeRate,
               serverInvoice.bolt11, serverInvoice.paymentHash, preimage, invoice);

        db.prepare(`UPDATE brix_invoice_requests SET status = 'completed' WHERE id = ?`).run(requestId);

        console.log(`[LNURL] ${wallet.isHodlMode() ? 'HODL' : 'Regular'} invoice: ${grossAmountSats} → ${feeInfo.netAmountSats} net + ${feeInfo.feeSats} fee`);

        return res.json({
          pr: serverInvoice.bolt11,
          routes: [],
          successAction: {
            tag: 'message',
            message: `Pagamento de ${grossAmountSats} sats enviado para ${lnAddress}!`,
          },
        });
      } catch (walletErr) {
        // Wallet failed — fall back to direct (no fee)
        console.error(`[LNURL] Wallet error, falling back to direct: ${walletErr.message}`);
      }
    }

    // ═══ DIRECT PATH (no fee / fallback) ═══
    const paymentId = crypto.randomUUID();
    const paymentHash = crypto.randomBytes(32).toString('hex');
    db.prepare(`
      INSERT INTO brix_pending_payments (id, user_id, amount_sats, payment_hash, sender_note)
      VALUES (?, ?, ?, ?, ?)
    `).run(paymentId, user.id, grossAmountSats, paymentHash, sanitizedComment);

    db.prepare(`UPDATE brix_invoice_requests SET status = 'completed' WHERE id = ?`).run(requestId);

    console.log(`[LNURL] Invoice relayed for ${lnAddress}: ${grossAmountSats} sats (direct)`);

    return res.json({
      pr: invoice,
      routes: [],
      successAction: {
        tag: 'message',
        message: `Pagamento de ${grossAmountSats} sats enviado para ${lnAddress}!`,
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

function pollForInvoice(db, requestId) {
  const TIMEOUT_MS = 25000;
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

      if (Date.now() - startTime > TIMEOUT_MS) {
        db.prepare(`UPDATE brix_invoice_requests SET status = 'expired' WHERE id = ?`).run(requestId);
        resolve(null);
        return;
      }

      setTimeout(check, POLL_INTERVAL);
    };
    check();
  });
}

module.exports = router;
