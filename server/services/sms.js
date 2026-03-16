const https = require('https');

let twilioConfigured = null;

function getTwilioConfig() {
  if (twilioConfigured !== null) return twilioConfigured;

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const verifySid = process.env.TWILIO_VERIFY_SID;

  if (!accountSid || !authToken || !verifySid) {
    console.warn('[SMS] TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_VERIFY_SID not set — SMS sending disabled');
    twilioConfigured = false;
    return false;
  }

  twilioConfigured = { accountSid, authToken, verifySid };
  console.log(`[SMS] Twilio Verify configured (Service: ${verifySid})`);
  return twilioConfigured;
}

function twilioRequest(path, formData) {
  const config = getTwilioConfig();
  if (!config) return Promise.resolve(null);

  const body = new URLSearchParams(formData).toString();
  const auth = Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64');

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'verify.twilio.com',
      port: 443,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Basic ${auth}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          console.error(`[SMS] Parse error: ${e.message}`);
          resolve(null);
        }
      });
    });
    req.on('error', (err) => {
      console.error(`[SMS] Network error: ${err.message}`);
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

/**
 * Send SMS verification via Twilio Verify (Twilio generates and sends the code)
 * @param {string} to - Phone number in E.164 format (e.g., +5548996242870)
 * @returns {Promise<boolean>} true if sent successfully
 */
async function sendSmsVerification(to) {
  const config = getTwilioConfig();
  if (!config) {
    console.log(`[SMS] (dev) Twilio not configured for ${to}`);
    return false;
  }

  const toFormatted = to.startsWith('+') ? to : `+${to}`;
  const result = await twilioRequest(
    `/v2/Services/${config.verifySid}/Verifications`,
    { To: toFormatted, Channel: 'sms' }
  );

  if (result && result.status === 'pending') {
    console.log(`[SMS] Verificação enviada para ${toFormatted} (SID: ${result.sid})`);
    return true;
  }

  console.error(`[SMS] Erro ao enviar: ${result ? (result.message || JSON.stringify(result)) : 'null response'}`);
  return false;
}

/**
 * Check SMS verification code via Twilio Verify
 * @param {string} to - Phone number in E.164 format
 * @param {string} code - 6-digit code entered by user
 * @returns {Promise<boolean>} true if code is valid
 */
async function checkSmsVerification(to, code) {
  const config = getTwilioConfig();
  if (!config) return false;

  const toFormatted = to.startsWith('+') ? to : `+${to}`;
  const result = await twilioRequest(
    `/v2/Services/${config.verifySid}/VerificationCheck`,
    { To: toFormatted, Code: code }
  );

  if (result && result.status === 'approved') {
    console.log(`[SMS] Código verificado para ${toFormatted}`);
    return true;
  }

  console.log(`[SMS] Código inválido para ${toFormatted}: ${result ? result.status : 'null'}`);
  return false;
}

module.exports = { sendSmsVerification, checkSmsVerification };

