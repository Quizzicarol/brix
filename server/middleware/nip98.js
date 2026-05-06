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
  console.error('[AUTH] CRITICAL: @noble/curves not available — NIP-98 verification DISABLED. Server cannot authenticate requests.');
  process.exit(1);
}

// v570: Replay protection — keep recently-seen event IDs in memory.
// Without this, the same NIP-98 event could be reused for the entire timestamp
// tolerance window. Even with payload-tag body-binding, an attacker who
// captures one valid request can replay it (e.g. on GET endpoints with no body,
// or on POST endpoints where the body is intentionally identical).
const TIMESTAMP_TOLERANCE_SEC = 60; // tightened from 120 → 60s
const REPLAY_WINDOW_MS = (TIMESTAMP_TOLERANCE_SEC + 5) * 1000;
const REPLAY_MAX_SIZE = 10000;
const seenEventIds = new Map(); // eventId → expiresAtMs

setInterval(() => {
  const now = Date.now();
  for (const [id, expiresAt] of seenEventIds) {
    if (now > expiresAt) seenEventIds.delete(id);
  }
}, 60000).unref?.();

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

      // Timestamp must be within tolerance window
      const now = Math.floor(Date.now() / 1000);
      if (Math.abs(now - event.created_at) > TIMESTAMP_TOLERANCE_SEC) {
        if (isAuthPath) console.log(`[NIP98] FAIL ${req.method} ${req.path}: timestamp expired (delta=${now - event.created_at}s)`);
        return next();
      }

      // v570: Replay protection — reject reused event IDs.
      // Check BEFORE signature verify so attackers can't burn CPU.
      if (typeof event.id === 'string' && /^[0-9a-f]{64}$/.test(event.id)) {
        if (seenEventIds.has(event.id)) {
          if (isAuthPath) console.log(`[NIP98] FAIL ${req.method} ${req.path}: replay detected (event ${event.id.substring(0,12)})`);
          return next();
        }
        // Cap size to prevent unbounded growth under burst load
        if (seenEventIds.size >= REPLAY_MAX_SIZE) {
          const evict = Math.floor(REPLAY_MAX_SIZE / 10);
          let i = 0;
          for (const key of seenEventIds.keys()) {
            if (i++ >= evict) break;
            seenEventIds.delete(key);
          }
        }
      }

      // Verify method tag matches request method (required)
      const methodTag = (event.tags || []).find(t => t[0] === 'method');
      if (!methodTag) {
        if (isAuthPath) console.log(`[NIP98] FAIL ${req.method} ${req.path}: missing method tag`);
        return next();
      }
      if (methodTag[1].toUpperCase() !== req.method.toUpperCase()) {
        if (isAuthPath) console.log(`[NIP98] FAIL ${req.method} ${req.path}: method mismatch (event=${methodTag[1]}, req=${req.method})`);
        return next();
      }

      // Verify URL path matches (required, compare paths only, ignore protocol/host)
      const urlTag = (event.tags || []).find(t => t[0] === 'u');
      if (!urlTag) {
        if (isAuthPath) console.log(`[NIP98] FAIL ${req.method} ${req.path}: missing URL tag`);
        return next();
      }
      {
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

      // v566: NIP-98 payload tag — binds auth event to request body (replay protection).
      // Strict when present; lenient when absent (transitional, until all clients send it).
      const payloadTag = (event.tags || []).find(t => t[0] === 'payload');
      const methodHasBody = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method.toUpperCase());
      if (payloadTag) {
        const expected = (typeof payloadTag[1] === 'string' ? payloadTag[1] : '').toLowerCase();
        const rawBody = req.rawBody && req.rawBody.length ? req.rawBody : Buffer.alloc(0);
        const actual = crypto.createHash('sha256').update(rawBody).digest('hex');
        if (expected !== actual) {
          if (isAuthPath) console.log(`[NIP98] FAIL ${req.method} ${req.path}: payload hash mismatch (event=${expected.substring(0,12)}, body=${actual.substring(0,12)})`);
          return next();
        }
      } else if (methodHasBody && req.rawBody && req.rawBody.length > 0) {
        if (isAuthPath) console.log(`[NIP98] WARN ${req.method} ${req.path}: missing payload tag (transitional, will be required)`);
      }

      // Verify cryptographic signature
      if (verifyNostrEvent(event)) {
        req.verifiedPubkey = event.pubkey;
        // Override header so existing route code automatically gets the verified pubkey
        req.headers['x-nostr-pubkey'] = event.pubkey;
        // v570: Mark event as seen ONLY after full verification (signature + payload).
        // This prevents attackers from polluting the replay set with random IDs,
        // and confirms real one-time-use enforcement on legitimate requests.
        if (typeof event.id === 'string') {
          seenEventIds.set(event.id, Date.now() + REPLAY_WINDOW_MS);
        }
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
