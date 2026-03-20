/**
 * NIP-98 HTTP Auth middleware.
 * Verifies Schnorr-signed Nostr events (kind 27235) in the Authorization header.
 * Falls back to x-nostr-pubkey header for backward compatibility.
 */
const crypto = require('crypto');

let schnorr;
try {
  schnorr = require('@noble/curves/secp256k1').schnorr;
  console.log('[AUTH] NIP-98 signature verification enabled');
} catch (e) {
  console.warn('[AUTH] @noble/curves not available — NIP-98 verification disabled');
}

/**
 * Verify a Nostr event's ID and Schnorr signature.
 */
function verifyNostrEvent(event) {
  if (!schnorr) return false;
  if (!event || !event.id || !event.pubkey || !event.sig || !event.tags) return false;
  if (typeof event.pubkey !== 'string' || !/^[0-9a-f]{64}$/.test(event.pubkey)) return false;
  if (typeof event.sig !== 'string' || !/^[0-9a-f]{128}$/.test(event.sig)) return false;

  // Compute expected event ID (sha256 of serialized array per NIP-01)
  const serialized = JSON.stringify([
    0, event.pubkey, event.created_at, event.kind, event.tags, event.content,
  ]);
  const expectedId = crypto.createHash('sha256').update(serialized).digest('hex');
  if (expectedId !== event.id) return false;

  try {
    return schnorr.verify(event.sig, expectedId, event.pubkey);
  } catch {
    return false;
  }
}

/**
 * Express middleware: extracts and verifies NIP-98 Authorization header.
 * Sets req.verifiedPubkey if signature is valid.
 * Overrides x-nostr-pubkey header with verified pubkey for backward compat.
 */
function nip98Auth(req, res, next) {
  req.verifiedPubkey = null;

  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Nostr ')) {
    try {
      const token = authHeader.slice(6);
      const eventJson = Buffer.from(token, 'base64').toString('utf8');
      const event = JSON.parse(eventJson);

      // Must be kind 27235 (NIP-98 HTTP Auth)
      if (event.kind !== 27235) return next();

      // Timestamp must be within 2 minutes
      const now = Math.floor(Date.now() / 1000);
      if (Math.abs(now - event.created_at) > 120) return next();

      // Verify method tag matches request method
      const methodTag = (event.tags || []).find(t => t[0] === 'method');
      if (methodTag && methodTag[1].toUpperCase() !== req.method.toUpperCase()) return next();

      // Verify URL path matches (flexible: compare paths only, ignore protocol/host)
      const urlTag = (event.tags || []).find(t => t[0] === 'u');
      if (urlTag) {
        try {
          const eventPath = new URL(urlTag[1]).pathname;
          if (eventPath !== req.path) return next();
        } catch {
          return next();
        }
      }

      // Verify cryptographic signature
      if (verifyNostrEvent(event)) {
        req.verifiedPubkey = event.pubkey;
        // Override header so existing route code automatically gets the verified pubkey
        req.headers['x-nostr-pubkey'] = event.pubkey;
      }
    } catch {
      // Invalid auth header — continue without verified pubkey
    }
  }

  next();
}

module.exports = { nip98Auth, verifyNostrEvent };
