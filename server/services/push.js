/**
 * Firebase Cloud Messaging (FCM) push notification service.
 * Uses FCM HTTP v1 API with service account credentials.
 */
const https = require('https');
const crypto = require('crypto');
const { getDb } = require('../models/database');

// Service account credentials from environment
const PROJECT_ID = process.env.FCM_PROJECT_ID;
const CLIENT_EMAIL = process.env.FCM_CLIENT_EMAIL;
const PRIVATE_KEY = process.env.FCM_PRIVATE_KEY?.replace(/\\n/g, '\n');

let _cachedToken = null;
let _tokenExpiry = 0;

/**
 * Create a JWT for Google OAuth2 service account authentication.
 */
function createJwt() {
  if (!CLIENT_EMAIL || !PRIVATE_KEY) {
    throw new Error('FCM service account credentials not configured');
  }

  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url');

  const signInput = `${header}.${payload}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signInput), PRIVATE_KEY).toString('base64url');

  return `${signInput}.${signature}`;
}

/**
 * Get an OAuth2 access token using the service account JWT.
 */
async function getAccessToken() {
  const now = Date.now();
  if (_cachedToken && now < _tokenExpiry) {
    return _cachedToken;
  }

  const jwt = createJwt();
  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) {
            _cachedToken = json.access_token;
            _tokenExpiry = now + (json.expires_in - 60) * 1000; // refresh 1 min early
            resolve(json.access_token);
          } else {
            reject(new Error(`OAuth2 error: ${data}`));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Send a DATA-ONLY FCM push to wake up the app for background processing.
 * IMPORTANT: Must be data-only (no 'notification' field) so that the
 * background handler fires on Android even when app is killed.
 * If 'notification' field is present, Android shows the notification but
 * does NOT call onBackgroundMessage → invoice generation never happens.
 *
 * @param {string} fcmToken - The device FCM token
 * @param {object} data - Key-value data payload (strings only)
 * @returns {Promise<{sent: boolean, unregistered: boolean}>} result
 */
async function sendPush(fcmToken, data) {
  if (!PROJECT_ID) {
    console.log('[PUSH] FCM_PROJECT_ID not configured, skipping push');
    return { sent: false, unregistered: false };
  }

  try {
    const accessToken = await getAccessToken();

    // brix_invoice_request and brix_pending_claim MUST be data-only / silent
    // so the recipient app can generate/claim a Spark invoice in the background
    // WITHOUT user action.
    // - apns-push-type: background  → triggers iOS silent background handler
    // - apns-push-type: alert       → would show banner + suppress background → breaks invoice gen
    //
    // For other notification types (status updates etc.), use alert so iOS shows the banner.
    // Regression history: commit 312ca4f changed BRIX to 'alert' which broke iOS background
    // invoice generation — sender saw "Payment Failed: Problem processing the LNURL" from
    // WoS while iOS showed an English banner that the recipient had no way to act on.
    const isBrixSilent = data.type === 'brix_invoice_request' || data.type === 'brix_pending_claim';
    const apnsHeaders = {
      'apns-priority': isBrixSilent ? '5' : '10',
      'apns-push-type': isBrixSilent ? 'background' : 'alert',
    };
    const apsPayload = isBrixSilent
      ? { 'content-available': 1 }
      : {          'alert': {
            'title': 'Bro',
            'body': 'New notification',
          },
          'badge': 1,
          'sound': 'default',
          'content-available': 1,
        };

    const message = {
      message: {
        token: fcmToken,
        data: data,
        android: {
          priority: 'high',
        },
        apns: {
          headers: apnsHeaders,
          payload: {
            aps: apsPayload,
          },
        },
      },
    };

    const body = JSON.stringify(message);

    return new Promise((resolve) => {
      const req = https.request({
        hostname: 'fcm.googleapis.com',
        path: `/v1/projects/${PROJECT_ID}/messages:send`,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            console.log('[PUSH] FCM message sent successfully');
            resolve({ sent: true, unregistered: false });
          } else {
            const isUnregistered = data.includes('UNREGISTERED') || data.includes('NOT_FOUND') || data.includes('THIRD_PARTY_AUTH_ERROR');
            console.error('[PUSH] FCM error:', res.statusCode, data);
            resolve({ sent: false, unregistered: isUnregistered });
          }
        });
      });
      req.on('error', (err) => {
        console.error('[PUSH] FCM request error:', err.message);
        resolve({ sent: false, unregistered: false });
      });
      req.write(body);
      req.end();
    });
  } catch (err) {
    console.error('[PUSH] Failed to send push:', err.message);
    return { sent: false, unregistered: false };
  }
}

/**
 * Send a wake-up push to a BRIX user by user ID.
 * Used when an LNURL payment request arrives and the recipient is offline.
 * Automatically clears stale (UNREGISTERED) FCM tokens from the database.
 *
 * @param {string} userId - The brix_users.id
 * @param {string} requestId - The invoice request ID
 * @param {number} amountSats - Payment amount
 * @returns {Promise<boolean>} whether push was sent
 */
async function sendWakeUpPush(userId, requestId, amountSats) {
  const db = getDb();
  const user = db.prepare('SELECT fcm_token, username FROM brix_users WHERE id = ?').get(userId);

  if (!user || !user.fcm_token) {
    console.log(`[PUSH] No FCM token for user ${userId}`);
    return false;
  }

  console.log(`[PUSH] Sending wake-up push to ${user.username} for request ${requestId} (${amountSats} sats)`);

  const result = await sendPush(user.fcm_token, {
    type: 'brix_invoice_request',
    request_id: requestId,
    amount_sats: String(amountSats),
  });

  // Clear stale tokens so we don't keep trying dead FCM tokens
  if (result.unregistered) {
    console.log(`[PUSH] Clearing stale FCM token for ${user.username} (UNREGISTERED)`);
    db.prepare("UPDATE brix_users SET fcm_token = NULL WHERE id = ?").run(userId);
  }

  return result.sent;
}

/**
 * Send a wake-up push to claim a pending offline payment.
 * Used by the auto-forward retry loop while a payment sits in status='received'.
 * The app receives this in the FCM background handler (even when fully killed),
 * generates a Spark invoice, and POSTs to /brix/claim — completing the forward
 * without any user interaction.
 *
 * @param {string} userId - The brix_users.id
 * @param {string} paymentId - brix_pending_payments.id
 * @param {number} amountSats - net amount the app should request in its invoice
 * @returns {Promise<{sent: boolean, unregistered: boolean}>}
 */
async function sendClaimPush(userId, paymentId, amountSats) {
  const db = getDb();
  let user = db.prepare('SELECT id, fcm_token, username, nostr_pubkey FROM brix_users WHERE id = ?').get(userId);

  if (!user) {
    return { sent: false, unregistered: false };
  }

  // If this user has no FCM token, look for a sibling with same pubkey
  // (same Nostr identity, possibly a different username on the same device).
  let fcmTokenUserId = user.id;
  let fcmToken = user.fcm_token;
  if (!fcmToken && user.nostr_pubkey && !user.nostr_pubkey.startsWith('web_')) {
    const sibling = db.prepare(
      'SELECT id, fcm_token FROM brix_users WHERE nostr_pubkey = ? AND id != ? AND fcm_token IS NOT NULL ORDER BY last_seen DESC LIMIT 1'
    ).get(user.nostr_pubkey, user.id);
    if (sibling && sibling.fcm_token) {
      fcmToken = sibling.fcm_token;
      fcmTokenUserId = sibling.id;
    }
  }

  if (!fcmToken) {
    return { sent: false, unregistered: false };
  }

  const result = await sendPush(fcmToken, {
    type: 'brix_pending_claim',
    payment_id: paymentId,
    amount_sats: String(amountSats),
  });

  if (result.unregistered) {
    console.log(`[PUSH] Clearing stale FCM token for ${user.username} (claim push UNREGISTERED)`);
    db.prepare("UPDATE brix_users SET fcm_token = NULL WHERE id = ?").run(fcmTokenUserId);
  }

  return result;
}

module.exports = { sendPush, sendWakeUpPush, sendClaimPush };
