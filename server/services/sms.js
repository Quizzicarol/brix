const https = require('https');

let twilioConfigured = null;

function getTwilioConfig() {
  if (twilioConfigured !== null) return twilioConfigured;

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;

  if (!accountSid || !authToken || !fromNumber) {
    console.warn('[SMS] TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_PHONE_NUMBER not set — SMS sending disabled');
    twilioConfigured = false;
    return false;
  }

  twilioConfigured = { accountSid, authToken, fromNumber };
  console.log(`[SMS] Twilio configured with number: ${fromNumber}`);
  return twilioConfigured;
}

/**
 * Send SMS verification code via Twilio REST API (no SDK needed)
 * @param {string} to - Phone number in E.164 format (e.g., +5511999887766)
 * @param {string} code - 6-digit verification code
 * @returns {Promise<boolean>} true if sent successfully
 */
async function sendSmsVerificationCode(to, code) {
  const config = getTwilioConfig();
  if (!config) {
    console.log(`[SMS] (dev) Código para ${to}: ${code}`);
    return false;
  }

  // Ensure phone has + prefix for E.164
  const toFormatted = to.startsWith('+') ? to : `+${to}`;

  const body = new URLSearchParams({
    To: toFormatted,
    From: config.fromNumber,
    Body: `⚡ BRIX - Seu código de verificação: ${code}\n\nEsse código expira em 10 minutos.`,
  }).toString();

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.twilio.com',
      port: 443,
      path: `/2010-04-01/Accounts/${config.accountSid}/Messages.json`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': 'Basic ' + Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64'),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log(`[SMS] Código enviado para ${toFormatted} (SID: ${parsed.sid})`);
            resolve(true);
          } else {
            console.error(`[SMS] Erro Twilio: ${parsed.message || data}`);
            resolve(false);
          }
        } catch (e) {
          console.error(`[SMS] Erro ao parsear resposta: ${e.message}`);
          resolve(false);
        }
      });
    });

    req.on('error', (err) => {
      console.error(`[SMS] Erro de rede: ${err.message}`);
      resolve(false);
    });

    req.write(body);
    req.end();
  });
}

module.exports = { sendSmsVerificationCode };
