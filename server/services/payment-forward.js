/**
 * Atomic payment forwarding — supports regular and HODL modes.
 *
 * REGULAR mode (default, works with any LNbits):
 *   pending   → sender paid server invoice?  → paid
 *   paid      → pay recipient invoice        → forwarding
 *   forwarding → recipient paid?             → forwarded ✓
 *   forwarding → recipient failed?           → failed (money in server wallet, needs manual action) ✗
 *
 * HODL mode (requires LND backend):
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
  const hodlMode = wallet.isHodlMode();

  // ── 1. Detect payments (pending → paid/held) ──
  const pending = db.prepare(`
    SELECT * FROM brix_fee_transactions
    WHERE status = 'pending' AND created_at > datetime('now', '-1 hour')
    ORDER BY created_at ASC
  `).all();

  for (const tx of pending) {
    try {
      let received = false;
      if (hodlMode) {
        received = await wallet.checkInvoiceHeld(tx.server_payment_hash);
      } else {
        received = await wallet.checkInvoicePaid(tx.server_payment_hash);
      }

      if (received) {
        const newStatus = hodlMode ? 'held' : 'paid';
        db.prepare(`
          UPDATE brix_fee_transactions SET status = ?, paid_at = datetime('now') WHERE id = ?
        `).run(newStatus, tx.id);
        console.log(`[FEE] ${hodlMode ? 'HODL held' : 'Invoice paid'}: ${tx.gross_amount_sats} sats (tx ${tx.id.substring(0, 8)})`);
      }
    } catch (err) {
      // Will retry next tick
    }
  }

  // ── 2. Forward payments to recipients ──
  const readyStatus = hodlMode ? 'held' : 'paid';
  const toForward = db.prepare(`
    SELECT * FROM brix_fee_transactions WHERE status = ? ORDER BY paid_at ASC
  `).all(readyStatus);

  for (const tx of toForward) {
    try {
      db.prepare(`UPDATE brix_fee_transactions SET status = 'forwarding' WHERE id = ?`).run(tx.id);
      console.log(`[FEE] Forwarding ${tx.net_amount_sats} sats to recipient (tx ${tx.id.substring(0, 8)})...`);

      const result = await wallet.payInvoice(tx.recipient_invoice);

      if (hodlMode) {
        // Settle HODL invoice — server keeps the fee
        await wallet.settleHodlInvoice(tx.preimage);
      }

      db.prepare(`
        UPDATE brix_fee_transactions
        SET status = 'forwarded', forwarded_at = datetime('now'), forward_hash = ?
        WHERE id = ?
      `).run(result.paymentHash, tx.id);

      console.log(`[FEE] ✓ Complete: ${tx.net_amount_sats} forwarded, ${tx.fee_sats} kept`);
    } catch (err) {
      const attempts = (tx.forward_attempts || 0) + 1;

      if (attempts >= MAX_FORWARD_ATTEMPTS) {
        if (hodlMode) {
          // HODL: Cancel → sender refunded
          try {
            await wallet.cancelHodlInvoice(tx.server_payment_hash);
            console.log(`[FEE] ✗ Forward failed → HODL cancelled → sender refunded`);
          } catch (cancelErr) {
            console.error(`[FEE] ✗ CRITICAL: Forward failed AND cancel failed: ${cancelErr.message}`);
          }
          db.prepare(`
            UPDATE brix_fee_transactions
            SET status = 'cancelled', forward_attempts = ?, error = ?
            WHERE id = ?
          `).run(attempts, err.message, tx.id);
        } else {
          // Regular: Money in server wallet, mark as failed for manual review
          console.error(`[FEE] ✗ Forward failed permanently — money in server wallet, needs manual refund`);
          db.prepare(`
            UPDATE brix_fee_transactions
            SET status = 'failed', forward_attempts = ?, error = ?
            WHERE id = ?
          `).run(attempts, err.message, tx.id);
        }
      } else {
        // Retry later
        db.prepare(`
          UPDATE brix_fee_transactions
          SET status = ?, forward_attempts = ?, error = ?
          WHERE id = ?
        `).run(readyStatus, attempts, err.message, tx.id);
        console.error(`[FEE] Forward attempt ${attempts}/${MAX_FORWARD_ATTEMPTS} failed: ${err.message}`);
      }
    }
  }

  // ── 3. Expire old unpaid invoices ──
  const stale = db.prepare(`
    SELECT id, server_payment_hash FROM brix_fee_transactions
    WHERE status = 'pending' AND created_at < datetime('now', '-1 hour')
  `).all();

  for (const tx of stale) {
    if (hodlMode) {
      try {
        await wallet.cancelHodlInvoice(tx.server_payment_hash);
      } catch (_) {
        // HODL may have already expired on its own
      }
    }
    db.prepare(`UPDATE brix_fee_transactions SET status = 'expired' WHERE id = ?`).run(tx.id);
  }

  if (stale.length > 0) {
    console.log(`[FEE] Expired ${stale.length} unpaid invoice(s)`);
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
