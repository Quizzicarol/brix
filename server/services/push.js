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
 * Send a data-only FCM push notification to wake up the app.
 * Data messages are handled by the app even when in background.
 *
 * @param {string} fcmToken - The device FCM token
 * @param {object} data - Key-value data payload (strings only)
 * @returns {Promise<boolean>} success
 */
async function sendPush(fcmToken, data) {
  if (!PROJECT_ID) {
    console.log('[PUSH] FCM_PROJECT_ID not configured, skipping push');
    return false;
  }

  try {
    const accessToken = await getAccessToken();

    const message = {
      message: {
        token: fcmToken,
        data: data,
        android: {
          priority: 'high',
        },
        apns: {
          headers: {
            'apns-priority': '10',
          },
          payload: {
            aps: {
              'content-available': 1,
            },
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
            resolve(true);
          } else {
            console.error('[PUSH] FCM error:', res.statusCode, data);
            resolve(false);
          }
        });
      });
      req.on('error', (err) => {
        console.error('[PUSH] FCM request error:', err.message);
        resolve(false);
      });
      req.write(body);
      req.end();
    });
  } catch (err) {
    console.error('[PUSH] Failed to send push:', err.message);
    return false;
  }
}

/**
 * Send a wake-up push to a BRIX user by user ID.
 * Used when an LNURL payment request arrives and the recipient is offline.
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

  return sendPush(user.fcm_token, {
    type: 'brix_invoice_request',
    request_id: requestId,
    amount_sats: String(amountSats),
  });
}

module.exports = { sendPush, sendWakeUpPush };
