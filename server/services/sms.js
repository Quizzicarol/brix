const https = require('https');

let twilioConfigured = null;

/**
 * Normalize Brazilian mobile phone numbers.
 * Brazilian mobile numbers have 13 digits: +55 XX 9XXXX-XXXX
 * Users often omit the 9th digit, entering +55 XX XXXX-XXXX (12 digits).
 * This function auto-adds the mobile 9 prefix when needed.
 */
function normalizeBrazilianPhone(phone) {
  const digits = phone.replace(/\D/g, '');
  // Pattern: 55 + 2-digit area code + 8-digit number (12 digits total)
  // The 8-digit number starts with 6-9 (mobile range)
  if (digits.length === 12 && digits.startsWith('55')) {
    const areaCode = digits.substring(2, 4);
    const number = digits.substring(4);
    if (/^[6-9]/.test(number)) {
      const fixed = `+55${areaCode}9${number}`;
      console.log(`[SMS] Auto-fixed BR mobile: +${digits} → ${fixed}`);
      return fixed;
    }
  }
  return phone.startsWith('+') ? phone : `+${phone}`;
}

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

  const toFormatted = normalizeBrazilianPhone(to);

  // E.164: minimum 11 digits (country code + number), maximum 15
  const digits = toFormatted.replace(/\D/g, '');
  if (digits.length < 11 || digits.length > 15) {
    console.error(`[SMS] Invalid phone number (${digits.length} digits): ${toFormatted}`);
    return false;
  }
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

  const toFormatted = normalizeBrazilianPhone(to);
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

module.exports = { sendSmsVerification, checkSmsVerification, normalizeBrazilianPhone };

