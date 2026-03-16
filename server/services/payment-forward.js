/**
 * Atomic payment forwarding with HODL invoices.
 *
 * Flow per transaction:
 *   pending  → sender paid HODL invoice? → held
 *   held     → pay recipient invoice     → forwarding
 *   forwarding → recipient paid?         → forwarded (settle HODL) ✓
 *   forwarding → recipient failed?       → cancelled (cancel HODL, sender refunded) ✗
 *   pending  → 1 hour no payment?        → expired (cancel HODL)
 */

const wallet = require('./wallet');
const { getDb } = require('../models/database');

const POLL_INTERVAL_MS = 3000;
const MAX_FORWARD_ATTEMPTS = 3;

let running = false;

async function tick() {
  if (!wallet.isEnabled()) return;
  const db = getDb();

  // ── 1. Detect HODL payments (pending → held) ──
  const pending = db.prepare(`
    SELECT * FROM brix_fee_transactions
    WHERE status = 'pending' AND created_at > datetime('now', '-1 hour')
    ORDER BY created_at ASC
  `).all();

  for (const tx of pending) {
    try {
      const held = await wallet.checkInvoiceHeld(tx.server_payment_hash);
      if (held) {
        db.prepare(`
          UPDATE brix_fee_transactions SET status = 'held', paid_at = datetime('now') WHERE id = ?
        `).run(tx.id);
        console.log(`[FEE] HODL held: ${tx.gross_amount_sats} sats (tx ${tx.id.substring(0, 8)})`);
      }
    } catch (err) {
      // Will retry next tick
    }
  }

  // ── 2. Forward held payments to recipients ──
  const heldToForward = db.prepare(`
    SELECT * FROM brix_fee_transactions WHERE status = 'held' ORDER BY paid_at ASC
  `).all();

  for (const tx of heldToForward) {
    try {
      db.prepare(`UPDATE brix_fee_transactions SET status = 'forwarding' WHERE id = ?`).run(tx.id);
      console.log(`[FEE] Forwarding ${tx.net_amount_sats} sats to recipient (tx ${tx.id.substring(0, 8)})...`);

      const result = await wallet.payInvoice(tx.recipient_invoice);

      // Recipient paid — now settle the HODL invoice (server keeps the fee)
      await wallet.settleHodlInvoice(tx.preimage);

      db.prepare(`
        UPDATE brix_fee_transactions
        SET status = 'forwarded', forwarded_at = datetime('now'), forward_hash = ?
        WHERE id = ?
      `).run(result.paymentHash, tx.id);

      console.log(`[FEE] ✓ Atomic complete: ${tx.net_amount_sats} forwarded, ${tx.fee_sats} kept`);
    } catch (err) {
      const attempts = (tx.forward_attempts || 0) + 1;

      if (attempts >= MAX_FORWARD_ATTEMPTS) {
        // All retries failed — CANCEL the HODL invoice → sender gets refund
        try {
          await wallet.cancelHodlInvoice(tx.server_payment_hash);
          console.log(`[FEE] ✗ Forward failed permanently → HODL cancelled → sender refunded`);
        } catch (cancelErr) {
          console.error(`[FEE] ✗ CRITICAL: Forward failed AND cancel failed: ${cancelErr.message}`);
        }

        db.prepare(`
          UPDATE brix_fee_transactions
          SET status = 'cancelled', forward_attempts = ?, error = ?
          WHERE id = ?
        `).run(attempts, err.message, tx.id);
      } else {
        // Retry later
        db.prepare(`
          UPDATE brix_fee_transactions
          SET status = 'held', forward_attempts = ?, error = ?
          WHERE id = ?
        `).run(attempts, err.message, tx.id);
        console.error(`[FEE] Forward attempt ${attempts}/${MAX_FORWARD_ATTEMPTS} failed: ${err.message}`);
      }
    }
  }

  // ── 3. Expire old unpaid HODLs ──
  const stale = db.prepare(`
    SELECT id, server_payment_hash FROM brix_fee_transactions
    WHERE status = 'pending' AND created_at < datetime('now', '-1 hour')
  `).all();

  for (const tx of stale) {
    try {
      await wallet.cancelHodlInvoice(tx.server_payment_hash);
    } catch (_) {
      // HODL may have already expired on its own
    }
    db.prepare(`UPDATE brix_fee_transactions SET status = 'expired' WHERE id = ?`).run(tx.id);
  }

  if (stale.length > 0) {
    console.log(`[FEE] Expired ${stale.length} unpaid HODL invoice(s)`);
  }
}

function start() {
  if (running || !wallet.isEnabled()) {
    if (!wallet.isEnabled()) console.log('[FEE] Wallet not configured — forwarder disabled');
    return;
  }
  running = true;
  console.log('[FEE] Atomic payment forwarder started (HODL mode)');

  const loop = async () => {
    if (!running) return;
    try {
      await tick();
    } catch (err) {
      console.error('[FEE] Forwarder error:', err.message);
    }
    setTimeout(loop, POLL_INTERVAL_MS);
  };
  loop();
}

function stop() {
  running = false;
}

/**
 * Webhook shortcut: if wallet notifies us of a HODL being held, mark it immediately.
 */
function handleWebhook(paymentHash) {
  if (!paymentHash) return false;
  const db = getDb();

  const tx = db.prepare(`
    SELECT id FROM brix_fee_transactions
    WHERE server_payment_hash = ? AND status = 'pending'
  `).get(paymentHash);

  if (tx) {
    db.prepare(`
      UPDATE brix_fee_transactions SET status = 'held', paid_at = datetime('now') WHERE id = ?
    `).run(tx.id);
    console.log(`[FEE] Webhook: HODL held (tx ${tx.id.substring(0, 8)})`);
    return true;
  }
  return false;
}

module.exports = { start, stop, handleWebhook };
