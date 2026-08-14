// Shared Spark webhook secret.
//
// SECURITY (vSEC): previously the secret defaulted to the hardcoded, public
// string 'brix-spark-webhook' — anyone could forge webhook calls. Now:
//   1. BRIX_WEBHOOK_SECRET env var wins when set (recommended for production,
//      so the secret survives restarts and matches re-registrations).
//   2. Otherwise a random 256-bit secret is generated once per process and
//      shared between wallet.js (registration) and server.js (verification).
//      An ephemeral secret is still infinitely better than a public constant:
//      an attacker cannot know it. On restart a NEW secret is registered.
const crypto = require('crypto');

const secret = process.env.BRIX_WEBHOOK_SECRET || crypto.randomBytes(32).toString('hex');

if (!process.env.BRIX_WEBHOOK_SECRET) {
  console.warn('[WEBHOOK] BRIX_WEBHOOK_SECRET not set — using ephemeral random secret (set the env var for production)');
}

module.exports = { webhookSecret: secret };
