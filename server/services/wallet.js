/**
 * BRIX Server Wallet — provides Lightning invoice/payment for fee collection.
 *
 * Two modes:
 *   REGULAR (default, works with any LNbits):
 *     1. Server creates regular invoice for GROSS amount
 *     2. Sender pays → money in server wallet
 *     3. Server pays recipient NET amount, keeps fee
 *
 *   HODL (requires LND backend):
 *     1. Server creates HODL invoice for GROSS amount (locked, not settled)
 *     2. Server pays recipient invoice for NET amount
 *     3. On success → settle HODL invoice → server keeps fee
 *     4. On failure → cancel HODL invoice → sender refunded automatically
 *
 * Environment variables:
 *   BRIX_FEE_ENABLED=true         — enable fee collection
 *   WALLET_PROVIDER=lnbits|mock
 *   WALLET_MODE=regular|hodl      — invoice mode (default: regular)
 *
 *   For LNbits:
 *     WALLET_URL=https://your-lnbits.com
 *     LNBITS_INVOICE_KEY=<invoice/read key>
 *     LNBITS_ADMIN_KEY=<admin key>
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');

const FEE_ENABLED = process.env.BRIX_FEE_ENABLED === 'true';
const WALLET_PROVIDER = process.env.WALLET_PROVIDER || 'mock';
const WALLET_MODE = process.env.WALLET_MODE || 'regular';

let walletConfig = null;

function getWalletConfig() {
  if (walletConfig !== null) return walletConfig;

  if (!FEE_ENABLED) {
    walletConfig = false;
    return false;
  }

  switch (WALLET_PROVIDER) {
    case 'lnbits': {
      const walletUrl = process.env.WALLET_URL;
      const invoiceKey = process.env.LNBITS_INVOICE_KEY;
      const adminKey = process.env.LNBITS_ADMIN_KEY;

      if (!walletUrl || !invoiceKey || !adminKey) {
        console.warn('[WALLET] LNbits config incomplete — fee disabled');
        walletConfig = false;
        return false;
      }

      walletConfig = { provider: 'lnbits', walletUrl: walletUrl.replace(/\/$/, ''), invoiceKey, adminKey };
      break;
    }

    case 'mock': {
      walletConfig = { provider: 'mock' };
      break;
    }

    default:
      console.warn(`[WALLET] Unknown provider "${WALLET_PROVIDER}" — fee disabled`);
      walletConfig = false;
      return false;
  }

  console.log(`[WALLET] Provider: ${walletConfig.provider} (${WALLET_MODE} mode)`);
  return walletConfig;
}

// ─── HTTP helper ───

function httpRequest(requestUrl, method, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(requestUrl);
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;

    const bodyStr = body ? JSON.stringify(body) : null;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...headers,
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(json)}`));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(new Error(`Parse error (${res.statusCode}): ${data.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── Preimage/hash helpers ───

function generatePreimage() {
  const preimage = crypto.randomBytes(32);
  const paymentHash = crypto.createHash('sha256').update(preimage).digest();
  return {
    preimage: preimage.toString('hex'),
    paymentHash: paymentHash.toString('hex'),
  };
}

// ─── LNbits provider (HODL via LND backend) ───

const lnbits = {
  /**
   * Create a HODL invoice — sender pays, but funds are LOCKED until settle/cancel.
   * Uses the /api/v1/payments endpoint with unhashed preimage excluded.
   */
  async createHodlInvoice(amountSats, memo, paymentHash) {
    const config = getWalletConfig();
    const result = await httpRequest(
      `${config.walletUrl}/api/v1/payments`,
      'POST',
      { 'X-Api-Key': config.invoiceKey },
      {
        out: false,
        amount: amountSats,
        memo,
        // LNbits HODL: provide hash but NOT the preimage
        payment_hash: paymentHash,
        unhashed: false,
      },
    );
    return { bolt11: result.payment_request, paymentHash: result.payment_hash };
  },

  /**
   * Settle a HODL invoice — release the locked funds to the server wallet.
   */
  async settleHodlInvoice(preimage) {
    const config = getWalletConfig();
    await httpRequest(
      `${config.walletUrl}/api/v1/payments/settle`,
      'POST',
      { 'X-Api-Key': config.adminKey },
      { preimage },
    );
  },

  /**
   * Cancel a HODL invoice — refund the sender automatically.
   */
  async cancelHodlInvoice(paymentHash) {
    const config = getWalletConfig();
    await httpRequest(
      `${config.walletUrl}/api/v1/payments/cancel`,
      'POST',
      { 'X-Api-Key': config.adminKey },
      { payment_hash: paymentHash },
    );
  },

  async payInvoice(bolt11) {
    const config = getWalletConfig();
    const result = await httpRequest(
      `${config.walletUrl}/api/v1/payments`,
      'POST',
      { 'X-Api-Key': config.adminKey },
      { out: true, bolt11 },
    );
    return { paymentHash: result.payment_hash };
  },

  async checkInvoiceHeld(paymentHash) {
    const config = getWalletConfig();
    const result = await httpRequest(
      `${config.walletUrl}/api/v1/payments/${encodeURIComponent(paymentHash)}`,
      'GET',
      { 'X-Api-Key': config.invoiceKey },
      null,
    );
    // For HODL: "paid" means HTLC received and held (not yet settled)
    return result.paid === true || result.status === 'held';
  },

  /**
   * Create a regular invoice (works with any LNbits, no HODL needed).
   */
  async createInvoice(amountSats, memo) {
    const config = getWalletConfig();
    const result = await httpRequest(
      `${config.walletUrl}/api/v1/payments`,
      'POST',
      { 'X-Api-Key': config.invoiceKey },
      { out: false, amount: amountSats, memo },
    );
    return { bolt11: result.payment_request, paymentHash: result.payment_hash };
  },

  /**
   * Check if a regular invoice has been paid (money in wallet).
   */
  async checkInvoicePaid(paymentHash) {
    const config = getWalletConfig();
    const result = await httpRequest(
      `${config.walletUrl}/api/v1/payments/${encodeURIComponent(paymentHash)}`,
      'GET',
      { 'X-Api-Key': config.invoiceKey },
      null,
    );
    return result.paid === true;
  },
};

// ─── Mock provider ───

const mockPayments = new Map();

const mock = {
  async createHodlInvoice(amountSats, memo, paymentHash) {
    const bolt11 = `lnbcrt${amountSats}hodl${paymentHash.substring(0, 20)}`;
    mockPayments.set(paymentHash, { status: 'pending', amountSats });
    console.log(`[WALLET:mock] HODL invoice: ${amountSats} sats (${paymentHash.substring(0, 16)}...)`);
    // Simulate sender paying after 2s
    setTimeout(() => {
      const p = mockPayments.get(paymentHash);
      if (p && p.status === 'pending') p.status = 'held';
    }, 2000);
    return { bolt11, paymentHash };
  },

  async settleHodlInvoice(preimage) {
    const hash = crypto.createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
    const p = mockPayments.get(hash);
    if (p) p.status = 'settled';
    console.log(`[WALLET:mock] HODL settled (${hash.substring(0, 16)}...)`);
  },

  async cancelHodlInvoice(paymentHash) {
    const p = mockPayments.get(paymentHash);
    if (p) p.status = 'cancelled';
    console.log(`[WALLET:mock] HODL cancelled → sender refunded (${paymentHash.substring(0, 16)}...)`);
  },

  async payInvoice(bolt11) {
    const paymentHash = crypto.randomBytes(32).toString('hex');
    console.log(`[WALLET:mock] Paid: ${bolt11.substring(0, 40)}...`);
    return { paymentHash };
  },

  async checkInvoiceHeld(paymentHash) {
    const p = mockPayments.get(paymentHash);
    return p ? p.status === 'held' : false;
  },

  async createInvoice(amountSats, memo) {
    const paymentHash = crypto.randomBytes(32).toString('hex');
    const bolt11 = `lnbcrt${amountSats}reg${paymentHash.substring(0, 20)}`;
    mockPayments.set(paymentHash, { status: 'pending', amountSats });
    console.log(`[WALLET:mock] Regular invoice: ${amountSats} sats (${paymentHash.substring(0, 16)}...)`);
    setTimeout(() => {
      const p = mockPayments.get(paymentHash);
      if (p && p.status === 'pending') p.status = 'paid';
    }, 2000);
    return { bolt11, paymentHash };
  },

  async checkInvoicePaid(paymentHash) {
    const p = mockPayments.get(paymentHash);
    return p ? p.status === 'paid' : false;
  },
};

// ─── Unified interface ───

const providers = { lnbits, mock };

function getProvider() {
  const config = getWalletConfig();
  if (!config) return null;
  return providers[config.provider] || null;
}

function isEnabled() {
  return !!getWalletConfig();
}

function getMode() {
  return WALLET_MODE;
}

function isHodlMode() {
  return WALLET_MODE === 'hodl';
}

async function createHodlInvoice(amountSats, memo) {
  const provider = getProvider();
  if (!provider) throw new Error('Wallet not configured');
  const { preimage, paymentHash } = generatePreimage();
  const result = await provider.createHodlInvoice(amountSats, memo, paymentHash);
  return { bolt11: result.bolt11, paymentHash, preimage };
}

async function settleHodlInvoice(preimage) {
  const provider = getProvider();
  if (!provider) throw new Error('Wallet not configured');
  return provider.settleHodlInvoice(preimage);
}

async function cancelHodlInvoice(paymentHash) {
  const provider = getProvider();
  if (!provider) throw new Error('Wallet not configured');
  return provider.cancelHodlInvoice(paymentHash);
}

async function payInvoice(bolt11) {
  const provider = getProvider();
  if (!provider) throw new Error('Wallet not configured');
  return provider.payInvoice(bolt11);
}

async function checkInvoiceHeld(paymentHash) {
  const provider = getProvider();
  if (!provider) throw new Error('Wallet not configured');
  return provider.checkInvoiceHeld(paymentHash);
}

async function createInvoice(amountSats, memo) {
  const provider = getProvider();
  if (!provider) throw new Error('Wallet not configured');
  return provider.createInvoice(amountSats, memo);
}

async function checkInvoicePaid(paymentHash) {
  const provider = getProvider();
  if (!provider) throw new Error('Wallet not configured');
  return provider.checkInvoicePaid(paymentHash);
}

async function getWalletBalance() {
  const config = getWalletConfig();
  if (!config || config.provider !== 'lnbits') return null;
  const result = await httpRequest(
    `${config.walletUrl}/api/v1/wallet`,
    'GET',
    { 'X-Api-Key': config.invoiceKey },
    null,
  );
  return { balance_msats: result.balance, name: result.name, url: config.walletUrl };
}

module.exports = {
  isEnabled, getMode, isHodlMode, generatePreimage,
  createInvoice, checkInvoicePaid,
  createHodlInvoice, settleHodlInvoice, cancelHodlInvoice,
  payInvoice, checkInvoiceHeld,
  getWalletBalance,
};
