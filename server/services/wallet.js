/**
 * BRIX Server Wallet — provides Lightning invoice/payment via Spark SDK.
 *
 * The server runs its OWN Spark wallet to:
 *   1. Receive payments on behalf of offline users (create invoice → receive sats)
 *   2. Forward sats to users when they come online (pay their Spark invoice)
 *
 * Two modes:
 *   REGULAR (default):
 *     1. Server creates invoice for amount
 *     2. Sender pays → money in server Spark wallet
 *     3. Server pays recipient when online, keeps fee
 *
 *   HODL (not supported with Spark — use regular):
 *     Reserved for future use
 *
 * Environment variables:
 *   BRIX_FEE_ENABLED=true                — enable wallet
 *   WALLET_PROVIDER=spark|lnbits|mock
 *   WALLET_MODE=regular                  — only regular supported with Spark
 *
 *   For Spark:
 *     SPARK_MNEMONIC=<12/24 word mnemonic for server wallet>
 *     BREEZ_API_KEY=<breez sdk api key>
 *     SPARK_NETWORK=mainnet|regtest       — default: mainnet
 *
 *   For LNbits (legacy):
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

  // Spark provider works independently of fee settings (used for offline fallback)
  // LNbits/mock require FEE_ENABLED
  if (!FEE_ENABLED && WALLET_PROVIDER !== 'spark') {
    walletConfig = false;
    return false;
  }

  switch (WALLET_PROVIDER) {
    case 'spark': {
      const mnemonic = process.env.SPARK_MNEMONIC;
      const apiKey = process.env.BREEZ_API_KEY;
      const network = process.env.SPARK_NETWORK || 'mainnet';

      if (!mnemonic || !apiKey) {
        console.warn('[WALLET] Spark config incomplete (need SPARK_MNEMONIC + BREEZ_API_KEY) — wallet disabled');
        walletConfig = false;
        return false;
      }

      walletConfig = { provider: 'spark', mnemonic, apiKey, network };
      break;
    }

    case 'lnbits': {
      const walletUrl = process.env.WALLET_URL;
      const invoiceKey = process.env.LNBITS_INVOICE_KEY;
      const adminKey = process.env.LNBITS_ADMIN_KEY;

      if (!walletUrl || !invoiceKey || !adminKey) {
        console.warn('[WALLET] LNbits config incomplete — wallet disabled');
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
      console.warn(`[WALLET] Unknown provider "${WALLET_PROVIDER}" — wallet disabled`);
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
      // Follow redirects (LNURL endpoints commonly 301/302 to a canonical host).
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, requestUrl).toString();
        resolve(httpRequest(next, method, headers, body));
        return;
      }
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

// ─── Spark provider (Breez SDK) ───

let sparkSdk = null;
let sparkInitializing = false;
let sparkSyncTimer = null;
let sparkLnAddress = null;

async function getSparkSdk() {
  if (sparkSdk) return sparkSdk;
  if (sparkInitializing) {
    // Wait for ongoing init
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (sparkSdk) return sparkSdk;
    }
    throw new Error('Spark SDK init timeout');
  }

  sparkInitializing = true;
  try {
    const { defaultConfig, SdkBuilder } = require('@breeztech/breez-sdk-spark/nodejs');
    const config = getWalletConfig();
    if (!config || config.provider !== 'spark') throw new Error('Spark not configured');

    const sdkConfig = defaultConfig(config.network);
    sdkConfig.apiKey = config.apiKey;

    let builder = SdkBuilder.new(sdkConfig, {
      type: 'mnemonic',
      mnemonic: config.mnemonic,
    });
    builder = await builder.withDefaultStorage('/data/spark_server_wallet');

    sparkSdk = await builder.build();
    console.log('[WALLET:spark] SDK initialized successfully');

    // The WASM/Node SDK does NOT auto-claim incoming Lightning payments on its
    // own — its background sync must be driven from JS. Without this, HTLCs
    // that arrive at the SSP are never claimed and sit "pending" on the sender
    // side forever (nothing lands in the wallet). Register an event listener
    // and periodically sync to claim incoming transfers.
    try {
      await sparkSdk.addEventListener({
        onEvent: (e) => {
          if (e && e.type && e.type !== 'synced') {
            if (e.type === 'paymentSucceeded' || e.type === 'paymentPending' || e.type === 'paymentFailed') {
              const amt = e.payment && (e.payment.amount ?? e.payment.amountSats);
              console.log(`[WALLET:spark] event ${e.type} amount=${amt}`);
            } else {
              console.log(`[WALLET:spark] event ${e.type}`);
            }
          }
        },
      });
    } catch (e) {
      console.error(`[WALLET:spark] addEventListener failed: ${e.message}`);
    }

    // Drive periodic sync so incoming Lightning transfers get claimed promptly.
    if (!sparkSyncTimer) {
      sparkSyncTimer = setInterval(() => {
        if (sparkSdk) sparkSdk.syncWallet({}).catch((e) => {
          console.error(`[WALLET:spark] syncWallet error: ${e && e.message}`);
        });
      }, 5000);
      if (sparkSyncTimer.unref) sparkSyncTimer.unref();
    }
    // Kick an immediate sync to claim anything already waiting.
    sparkSdk.syncWallet({}).catch(() => {});

    // Log balance
    try {
      const info = await sparkSdk.getInfo({});
      console.log(`[WALLET:spark] Balance: ${info.balanceSats} sats`);
    } catch (_) {}

    // Register an SSP webhook so incoming Lightning payments are delivered to
    // this (server) wallet even without a persistent realtime connection. The
    // WASM/Node SDK does not hold a reliable receive stream; without a webhook
    // the SSP has no way to notify us and the HTLC sits pending on the sender
    // side forever. This is the officially supported server-side receive path.
    try {
      const domain = process.env.BRIX_DOMAIN || 'brix.brostr.app';
      const webhookUrl = `https://${domain}/brix/spark-webhook`;
      // vSEC: secret compartilhado — env var ou aleatório efêmero (NUNCA mais
      // o default público 'brix-spark-webhook', que qualquer um conhecia).
      const { webhookSecret } = require('./webhook-secret');
      const secret = webhookSecret;
      let existing = [];
      try { existing = await sparkSdk.listWebhooks(); } catch (_) {}
      const existingHook = Array.isArray(existing)
        ? existing.find(w => w && w.url === webhookUrl)
        : null;

      // vSEC: o objeto Webhook NÃO expõe o secret, então não dá para saber se o
      // hook registrado usa o secret ANTIGO (inseguro) ou o novo. Quando estamos
      // usando o secret NOVO via env (BRIX_WEBHOOK_SECRET), precisamos GARANTIR
      // que o SSP assina com ele — senão a verificação HMAC do servidor rejeita
      // webhooks LEGÍTIMOS (quebra recebimento offline). Estratégia: se existe
      // um hook para a URL mas NÃO foi registrado por esta versão, re-registrar.
      const usingNewSecret = !!process.env.BRIX_WEBHOOK_SECRET;
      if (existingHook && usingNewSecret) {
        try {
          await sparkSdk.unregisterWebhook({ webhookId: existingHook.id });
          console.log(`[WALLET:spark] webhook antigo removido p/ re-registro c/ novo secret (id=${existingHook.id})`);
        } catch (e) {
          console.error(`[WALLET:spark] unregisterWebhook falhou: ${e && e.message}`);
        }
      }

      const stillThere = existingHook && !usingNewSecret;
      if (!stillThere) {
        await sparkSdk.registerWebhook({
          url: webhookUrl,
          secret,
          eventTypes: [
            { type: 'lightningReceiveFinished' },
            { type: 'lightningSendFinished' },
          ],
        });
        console.log(`[WALLET:spark] webhook registered -> ${webhookUrl}`);
      } else {
        console.log(`[WALLET:spark] webhook already registered -> ${webhookUrl}`);
      }
    } catch (e) {
      console.error(`[WALLET:spark] registerWebhook failed: ${e && e.message}`);
    }

    // Register a Spark/Breez lightning address for THIS server wallet. In the
    // current Spark model, registering a lightning address is what sets up the
    // SSP-side receive channel (so incoming Lightning HTLCs are held, the wallet
    // is notified, and the transfer is delivered/claimed). The app does this on
    // setup — which is why the app receives fine — but the server wallet never
    // did (getLightningAddress() was undefined) → external Lightning never
    // reached it. This does NOT affect the @brix.brostr.app addresses (those are
    // served by BRIX's own LNURL); it only enables the server wallet to receive.
    try {
      let la = null;
      try { la = await sparkSdk.getLightningAddress(); } catch (_) {}
      if (la && la.lightningAddress) {
        sparkLnAddress = la;
        console.log(`[WALLET:spark] lightning address present: ${la.lightningAddress}`);
      } else {
        const suffix = crypto.createHash('sha256')
          .update(String(config.mnemonic)).digest('hex').slice(0, 8);
        const candidates = [
          process.env.BRIX_SERVER_LN_USERNAME,
          'broserverwallet',
          'brixserverwallet',
          `broserver${suffix}`,
        ].filter(Boolean);
        for (const uname of candidates) {
          try {
            const info = await sparkSdk.registerLightningAddress({
              username: uname,
              description: 'BRIX server wallet',
            });
            sparkLnAddress = info;
            console.log(`[WALLET:spark] lightning address registered: ${info && info.lightningAddress}`);
            break;
          } catch (e) {
            console.error(`[WALLET:spark] registerLightningAddress('${uname}') failed: ${e && e.message}`);
          }
        }
      }
    } catch (e) {
      console.error(`[WALLET:spark] lightning address setup error: ${e && e.message}`);
    }

    return sparkSdk;
  } catch (err) {
    console.error(`[WALLET:spark] SDK init failed: ${err.message}`);
    sparkInitializing = false;
    throw err;
  }
}

const spark = {
  // Fetch a bolt11 from THIS server wallet's own Breez lightning address LNURL.
  // On a WASM/Node server, direct receivePayment(bolt11) invoices are NOT
  // reliably delivered by the SSP (the HTLC sits pending on the sender side).
  // Invoices obtained through the registered lightning address ARE delivered,
  // because the Breez SSP hosts/holds them server-side and hands the transfer
  // to the wallet (confirmed working). So we route receive through the address.
  async createInvoiceViaLnAddress(amountSats) {
    const info = sparkLnAddress;
    if (!info) return null;
    // Build the well-known LNURL-pay URL from the address (user@domain), and
    // keep the SDK-provided lnurl.url as a secondary candidate.
    const urls = [];
    if (info.lightningAddress && info.lightningAddress.includes('@')) {
      const [user, domain] = info.lightningAddress.split('@');
      if (user && domain) urls.push(`https://${domain}/.well-known/lnurlp/${user}`);
    }
    if (info.lnurl && info.lnurl.url) urls.push(info.lnurl.url);
    if (urls.length === 0) return null;
    for (const lnurlUrl of urls) {
      try {
        const meta = await httpRequest(lnurlUrl, 'GET', {}, null);
        if (!meta || !meta.callback) continue;
        const amountMsat = Number(amountSats) * 1000;
        if (meta.minSendable && amountMsat < Number(meta.minSendable)) return null;
        if (meta.maxSendable && amountMsat > Number(meta.maxSendable)) return null;
        const sep = meta.callback.includes('?') ? '&' : '?';
        const cbRes = await httpRequest(`${meta.callback}${sep}amount=${amountMsat}`, 'GET', {}, null);
        if (!cbRes || !cbRes.pr) continue;
        const bolt11 = cbRes.pr;
        const paymentHash = crypto.createHash('sha256').update(bolt11).digest('hex');
        return { bolt11, paymentHash };
      } catch (e) {
        console.error(`[WALLET:spark] createInvoiceViaLnAddress(${lnurlUrl}) error: ${e && e.message}`);
      }
    }
    return null;
  },

  async createInvoice(amountSats, memo) {
    const sdk = await getSparkSdk();
    // Use receivePayment (bolt11) which produces a plain-description invoice
    // (bolt11 "d" tag), NOT a description-hash ("h" tag). External wallets
    // following LUD-06 validate an "h" tag against our served LNURL metadata;
    // a lightning-address LNURL invoice carries breez.tips's own metadata hash,
    // which does NOT match ours and causes the payer's HTLC to hang. A plain
    // "d" tag invoice is accepted without that cross-check. Receiving is armed
    // by the registered lightning address, so these invoices now deliver.
    const resp = await sdk.receivePayment({
      paymentMethod: {
        type: 'bolt11Invoice',
        description: memo || 'BRIX Payment',
        amountSats: Number(amountSats),
      },
    });
    const bolt11 = resp.paymentRequest;
    const paymentHash = crypto.createHash('sha256').update(bolt11).digest('hex');
    console.log(`[WALLET:spark] receivePayment invoice for ${amountSats} sats`);
    return { bolt11, paymentHash };
  },

  async checkInvoicePaid(paymentHash, bolt11) {
    if (!bolt11) return false;
    try {
      const sdk = await getSparkSdk();
      const resp = await sdk.listPayments({
        typeFilter: ['receive'],
        statusFilter: ['completed'],
        paymentDetailsFilter: [{ type: 'lightning' }],
        limit: 50,
        sortAscending: false,
      });
      return resp.payments.some(p =>
        p.details?.type === 'lightning' && p.details.invoice === bolt11
      );
    } catch (err) {
      console.error(`[WALLET:spark] checkInvoicePaid error: ${err.message}`);
      return false;
    }
  },

  async payInvoice(bolt11) {
    const sdk = await getSparkSdk();
    const prepareResp = await sdk.prepareSendPayment({
      paymentRequest: { type: 'input', input: bolt11 },
    });
    // vSEC: idempotencyKey derivado do hash do invoice (estável entre retries
    // do MESMO invoice). Se um forward for re-tentado após crash/timeout, o
    // SSP/SDK deduplica por essa chave — defesa em profundidade além da
    // recuperação via checkOutgoingPayment no payment-forward.
    const idempotencyKey = crypto.createHash('sha256').update(String(bolt11)).digest('hex');
    const sendResp = await sdk.sendPayment({
      prepareResponse: prepareResp,
      idempotencyKey,
    });
    return { paymentHash: sendResp.payment?.id || crypto.randomUUID() };
  },

  // vSEC: consulta pagamento ENVIADO por invoice — usado para recuperação
  // pós-crash (nunca re-pagar um invoice que já foi pago antes do crash).
  async checkOutgoingPayment(bolt11) {
    if (!bolt11) return false;
    try {
      const sdk = await getSparkSdk();
      const resp = await sdk.listPayments({
        typeFilter: ['send'],
        statusFilter: ['completed'],
        limit: 50,
        sortAscending: false,
      });
      return (resp.payments || []).some(p =>
        p.details?.type === 'lightning' && p.details.invoice === bolt11
      );
    } catch (err) {
      console.error(`[WALLET:spark] checkOutgoingPayment error: ${err.message}`);
      return false;
    }
  },

  // HODL not supported with Spark
  async createHodlInvoice() { throw new Error('HODL not supported with Spark provider'); },
  async settleHodlInvoice() { throw new Error('HODL not supported with Spark provider'); },
  async cancelHodlInvoice() { throw new Error('HODL not supported with Spark provider'); },
  async checkInvoiceHeld() { return false; },
};

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
  async checkInvoicePaid(paymentHash, bolt11) {
    const config = getWalletConfig();
    const result = await httpRequest(
      `${config.walletUrl}/api/v1/payments/${encodeURIComponent(paymentHash)}`,
      'GET',
      { 'X-Api-Key': config.invoiceKey },
      null,
    );
    return result.paid === true;
  },

  // vSEC: LNbits — não há lookup confiável de pagamento enviado por bolt11;
  // retornar null ("incerto") força o forwarder a marcar p/ revisão manual
  // em vez de arriscar duplo pagamento.
  async checkOutgoingPayment(_bolt11) {
    return null;
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

  async checkInvoicePaid(paymentHash, bolt11) {
    const p = mockPayments.get(paymentHash);
    return p ? p.status === 'paid' : false;
  },
};

// ─── Unified interface ───

const providers = { spark, lnbits, mock };

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

async function checkInvoicePaid(paymentHash, bolt11) {
  const provider = getProvider();
  if (!provider) throw new Error('Wallet not configured');
  return provider.checkInvoicePaid(paymentHash, bolt11);
}

// vSEC: true = pago | false = não pago | null = incerto (provider não suporta)
async function checkOutgoingPayment(bolt11) {
  const provider = getProvider();
  if (!provider) throw new Error('Wallet not configured');
  if (typeof provider.checkOutgoingPayment !== 'function') return null;
  return provider.checkOutgoingPayment(bolt11);
}

async function getWalletBalance() {
  const config = getWalletConfig();
  if (!config) return null;

  if (config.provider === 'spark') {
    try {
      const sdk = await getSparkSdk();
      const info = await sdk.getInfo({});
      return { balance_sats: Number(info.balanceSats), provider: 'spark' };
    } catch (e) {
      return { balance_sats: 0, provider: 'spark', error: e.message };
    }
  }

  if (config.provider === 'lnbits') {
    const result = await httpRequest(
      `${config.walletUrl}/api/v1/wallet`,
      'GET',
      { 'X-Api-Key': config.invoiceKey },
      null,
    );
    return { balance_msats: result.balance, name: result.name, url: config.walletUrl };
  }

  return null;
}

/**
 * Force an immediate wallet sync (claims any pending incoming Lightning
 * transfers). Safe to call from the webhook handler. No-op for non-spark.
 */
async function syncNow() {  const config = getWalletConfig();
  if (!config || config.provider !== 'spark') return false;
  try {
    const sdk = await getSparkSdk();
    await sdk.syncWallet({});
    try {
      const info = await sdk.getInfo({});
      console.log(`[WALLET:spark] syncNow balance=${Number(info.balanceSats)} sats`);
      const resp = await sdk.listPayments({ limit: 8, sortAscending: false });
      for (const p of (resp.payments || [])) {
        const amt = p.amount ?? p.amountSats;
        const inv = p.details && p.details.type === 'lightning' ? String(p.details.invoice || '').slice(0, 25) : '';
        console.log(`[WALLET:spark] recent pay: type=${p.paymentType || p.type} status=${p.status} amt=${amt} ${inv}`);
      }
    } catch (di) {
      console.error(`[WALLET:spark] syncNow debug error: ${di && di.message}`);
    }
    return true;
  } catch (e) {
    console.error(`[WALLET:spark] syncNow error: ${e && e.message}`);
    return false;
  }
}

async function parseInvoice(input) {
  const config = getWalletConfig();
  if (!config || config.provider !== 'spark') return null;
  try {
    const sdk = await getSparkSdk();
    const details = await sdk.parse(input);
    const now = Math.floor(Date.now() / 1000);
    const secsLeft = (details.timestamp && details.expiry)
      ? (details.timestamp + details.expiry - now) : null;
    console.log(`[WALLET:spark] parse: type=${details.type} amountMsat=${details.amountMsat} expiry=${details.expiry}s timestamp=${details.timestamp} secsLeft=${secsLeft} payee=${String(details.payeePubkey || '').slice(0, 16)} hints=${(details.routingHints || []).length}`);
    console.log(`[WALLET:spark] parse desc: description=${JSON.stringify(details.description)} descriptionHash=${details.descriptionHash}`);
    try {
      const hints = details.routingHints || [];
      hints.forEach((h, i) => {
        const hops = (h.hops || []).map(hop => `${String(hop.srcNodeId || hop.src || '').slice(0, 16)}#${hop.shortChannelId || hop.scid || ''}`).join(' -> ');
        console.log(`[WALLET:spark] parse hint[${i}]: ${hops}`);
      });
    } catch (_) {}
    return details;
  } catch (e) {
    console.error(`[WALLET:spark] parseInvoice error: ${e && e.message}`);
    return null;
  }
}

module.exports = {
  isEnabled, getMode, isHodlMode, generatePreimage,
  createInvoice, checkInvoicePaid,
  createHodlInvoice, settleHodlInvoice, cancelHodlInvoice,
  payInvoice, checkInvoiceHeld,
  checkOutgoingPayment,
  getWalletBalance, syncNow, parseInvoice,
};