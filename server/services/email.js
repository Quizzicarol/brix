const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = parseInt(process.env.SMTP_PORT || '587', 10);

  if (!user || !pass) {
    console.warn('[EMAIL] SMTP_USER/SMTP_PASS not set — email sending disabled');
    return null;
  }

  const isSecure = port === 465;
  transporter = nodemailer.createTransport({
    host,
    port,
    secure: isSecure,
    auth: { user, pass },
    tls: { rejectUnauthorized: true },
  });

  console.log(`[EMAIL] SMTP configured: ${host}:${port} as ${user}`);
  return transporter;
}

async function sendVerificationCode(to, code) {
  const t = getTransporter();
  if (!t) {
    console.log(`[EMAIL] (dev) Código para ${to}: ${code}`);
    return false;
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;

  await t.sendMail({
    from: `"BRIX ⚡" <${from}>`,
    to,
    subject: `⚡ Seu código BRIX: ${code}`,
    text: `Seu código de verificação BRIX é: ${code}\n\nEsse código expira em 10 minutos.\n\nSe você não solicitou isso, ignore este email.`,
    html: `
      <div style="font-family: -apple-system, sans-serif; max-width: 400px; margin: 0 auto; padding: 32px; background: #0A0A0A; color: #fff; border-radius: 16px;">
        <div style="text-align: center; margin-bottom: 24px;">
          <span style="font-size: 48px;">⚡</span>
          <h1 style="color: #FFC107; margin: 8px 0 0;">BRIX</h1>
        </div>
        <p style="text-align: center; color: #ccc; font-size: 14px;">Seu código de verificação:</p>
        <div style="text-align: center; margin: 20px 0;">
          <span style="font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #FFC107; font-family: monospace;">${code}</span>
        </div>
        <p style="text-align: center; color: #888; font-size: 12px;">Expira em 10 minutos</p>
        <hr style="border: none; border-top: 1px solid #222; margin: 24px 0;">
        <p style="text-align: center; color: #555; font-size: 11px;">Se você não solicitou isso, ignore este email.</p>
      </div>
    `,
  });

  console.log(`[EMAIL] Código enviado para ${to}`);
  return true;
}

module.exports = { sendVerificationCode };
