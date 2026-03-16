/**
 * Fee calculation for BRIX transactions.
 * 
 * Environment variables:
 *   BRIX_FEE_RATE=0.01       — fee as decimal (0.01 = 1%)
 *   BRIX_MIN_FEE_SATS=1      — minimum fee in sats
 */

const FEE_RATE = parseFloat(process.env.BRIX_FEE_RATE || '0.01');
const MIN_FEE_SATS = parseInt(process.env.BRIX_MIN_FEE_SATS || '1', 10);

/**
 * Calculate fee split for a gross amount.
 * @param {number} grossAmountSats — total amount the sender wants to send
 * @returns {{ grossAmountSats, feeSats, netAmountSats, feeRate }}
 */
function calculateFee(grossAmountSats) {
  const feeSats = Math.max(MIN_FEE_SATS, Math.ceil(grossAmountSats * FEE_RATE));
  const netAmountSats = grossAmountSats - feeSats;

  if (netAmountSats < 1) {
    throw new Error(`Amount too small for fee: ${grossAmountSats} sats`);
  }

  return { grossAmountSats, feeSats, netAmountSats, feeRate: FEE_RATE };
}

module.exports = { calculateFee, FEE_RATE, MIN_FEE_SATS };
