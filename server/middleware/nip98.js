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
  const isAuthPath = req.path.includes('pending-payments') || req.path.includes('claim');

  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Nostr ')) {
    try {
      const token = authHeader.slice(6);
      const eventJson = Buffer.from(token, 'base64').toString('utf8');
      const event = JSON.parse(eventJson);

      // Must be kind 27235 (NIP-98 HTTP Auth)
      if (event.kind !== 27235) {
        if (isAuthPath) console.log(`[NIP98] FAIL ${req.method} ${req.path}: wrong kind ${event.kind}`);
        return next();
      }

      // Timestamp must be within 2 minutes
      const now = Math.floor(Date.now() / 1000);
      if (Math.abs(now - event.created_at) > 120) {
        if (isAuthPath) console.log(`[NIP98] FAIL ${req.method} ${req.path}: timestamp expired (delta=${now - event.created_at}s)`);
        return next();
      }

      // Verify method tag matches request method
      const methodTag = (event.tags || []).find(t => t[0] === 'method');
      if (methodTag && methodTag[1].toUpperCase() !== req.method.toUpperCase()) {
        if (isAuthPath) console.log(`[NIP98] FAIL ${req.method} ${req.path}: method mismatch (event=${methodTag[1]}, req=${req.method})`);
        return next();
      }

      // Verify URL path matches (flexible: compare paths only, ignore protocol/host)
      const urlTag = (event.tags || []).find(t => t[0] === 'u');
      if (urlTag) {
        try {
          const eventPath = new URL(urlTag[1]).pathname;
          if (eventPath !== req.path) {
            if (isAuthPath) console.log(`[NIP98] FAIL ${req.method} ${req.path}: path mismatch (event=${eventPath}, req=${req.path})`);
            return next();
          }
        } catch {
          if (isAuthPath) console.log(`[NIP98] FAIL ${req.method} ${req.path}: invalid URL in tag`);
          return next();
        }
      }

      // Verify cryptographic signature
      if (verifyNostrEvent(event)) {
        req.verifiedPubkey = event.pubkey;
        // Override header so existing route code automatically gets the verified pubkey
        req.headers['x-nostr-pubkey'] = event.pubkey;
        if (isAuthPath) console.log(`[NIP98] OK ${req.method} ${req.path} pubkey=${event.pubkey.substring(0,8)}...`);
      } else {
        if (isAuthPath) console.log(`[NIP98] FAIL ${req.method} ${req.path}: signature verification failed for ${event.pubkey.substring(0,8)}...`);
      }
    } catch (e) {
      // Invalid auth header — continue without verified pubkey
      if (isAuthPath) console.log(`[NIP98] FAIL ${req.method} ${req.path}: parse error: ${e.message}`);
    }
  } else {
    if (isAuthPath) console.log(`[NIP98] MISS ${req.method} ${req.path}: no Authorization header (has x-nostr-pubkey: ${!!req.headers['x-nostr-pubkey']})`);
  }

  next();
}

module.exports = { nip98Auth, verifyNostrEvent };
