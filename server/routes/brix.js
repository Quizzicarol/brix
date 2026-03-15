const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getDb } = require('../models/database');
const { sendVerificationCode } = require('../services/email');

/**
 * GET /brix/check-username/:username
 * Check if a username is available
 */
router.get('/check-username/:username', (req, res) => {
  const username = req.params.username.toLowerCase().trim();

  if (!/^[a-z0-9_]{3,20}$/.test(username)) {
    return res.json({ available: false, error: 'Use 3-20 caracteres: letras, números e _' });
  }

  const db = getDb();
  const existing = db.prepare('SELECT id FROM brix_users WHERE username = ? AND verified = 1').get(username);

  res.json({ available: !existing, username });
});

/**
 * POST /brix/register
 * Body: { username, phone?, email? }
 * At least one of phone/email required for verification
 */
router.post('/register', async (req, res) => {
  const { username, phone, email } = req.body;

  if (!username) {
    return res.status(400).json({ error: 'Username obrigatório' });
  }
  if (!phone && !email) {
    return res.status(400).json({ error: 'Informe pelo menos um: celular ou email' });
  }

  const cleanUsername = username.toLowerCase().trim();
  if (!/^[a-z0-9_]{3,20}$/.test(cleanUsername)) {
    return res.status(400).json({ error: 'Username: 3-20 caracteres, apenas letras, números e _' });
  }

  const nostr_pubkey = req.headers['x-nostr-pubkey'] || `web_${crypto.randomBytes(16).toString('hex')}`;
  const db = getDb();

  // Check username availability (only verified users block)
  const existingUsername = db.prepare('SELECT id, verified FROM brix_users WHERE username = ?').get(cleanUsername);
  if (existingUsername && existingUsername.verified) {
    return res.status(409).json({ error: 'Este username já está em uso' });
  }

  // Cleanup unverified entries with same username
  if (existingUsername && !existingUsername.verified) {
    db.prepare('DELETE FROM brix_verifications WHERE user_id = ?').run(existingUsername.id);
    db.prepare('DELETE FROM brix_users WHERE id = ?').run(existingUsername.id);
  }

  const cleanPhone = phone ? phone.replace(/\D/g, '') : null;
  const cleanEmail = email ? email.trim().toLowerCase() : null;

  const userId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO brix_users (id, username, phone, email, nostr_pubkey)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, cleanUsername, cleanPhone, cleanEmail, nostr_pubkey);

  // Send verification to phone (priority) or email
  const verifyVia = cleanPhone ? 'sms' : 'email';
  const destination = cleanPhone || cleanEmail;

  const code = String(crypto.randomInt(100000, 999999));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const verificationId = crypto.randomUUID();

  db.prepare(`
    INSERT INTO brix_verifications (id, user_id, code, type, destination, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(verificationId, userId, code, verifyVia, destination, expiresAt);

  console.log(`[BRIX] Código de verificação para ${destination}: ${code}`);

  // Send email if verification is via email
  let emailSent = false;
  if (verifyVia === 'email' && cleanEmail) {
    try {
      emailSent = await sendVerificationCode(cleanEmail, code);
    } catch (err) {
      console.error(`[BRIX] Erro ao enviar email: ${err.message}`);
    }
  }

  const hasSmtp = !!process.env.SMTP_USER;
  res.json({
    success: true,
    message: emailSent ? 'Código enviado para seu email' : (hasSmtp ? 'Erro ao enviar email' : 'Código gerado (DEV)'),
    user_id: userId,
    username: cleanUsername,
    verify_via: verifyVia,
    ...(!hasSmtp && { dev_code: code }),
  });
});

/**
 * POST /brix/verify
 * Body: { user_id, code }
 */
router.post('/verify', (req, res) => {
  const { user_id, code } = req.body;

  if (!user_id || !code) {
    return res.status(400).json({ error: 'Campos obrigatórios: user_id, code' });
  }

  const db = getDb();

  const verification = db.prepare(`
    SELECT * FROM brix_verifications
    WHERE user_id = ? AND code = ? AND used = 0 AND expires_at > datetime('now')
    ORDER BY created_at DESC LIMIT 1
  `).get(user_id, code);

  if (!verification) {
    return res.status(400).json({ error: 'Código inválido ou expirado' });
  }

  const tx = db.transaction(() => {
    db.prepare('UPDATE brix_verifications SET used = 1 WHERE id = ?').run(verification.id);
    db.prepare("UPDATE brix_users SET verified = 1, updated_at = datetime('now') WHERE id = ?").run(user_id);
  });
  tx();

  const user = db.prepare('SELECT username, phone, email FROM brix_users WHERE id = ?').get(user_id);
  const domain = process.env.BRIX_DOMAIN || 'brix.app';

  console.log(`[BRIX] Endereço ativado: ${user.username}@${domain}`);

  res.json({
    success: true,
    brix_address: `${user.username}@${domain}`,
    username: user.username,
    message: 'BRIX ativado com sucesso!',
  });
});

/**
 * POST /brix/resend
 * Body: { user_id }
 */
router.post('/resend', async (req, res) => {
  const { user_id } = req.body;

  if (!user_id) {
    return res.status(400).json({ error: 'user_id obrigatório' });
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM brix_users WHERE id = ? AND verified = 0').get(user_id);
  if (!user) {
    return res.status(404).json({ error: 'Usuário não encontrado ou já verificado' });
  }

  db.prepare("UPDATE brix_verifications SET used = 1 WHERE user_id = ? AND used = 0").run(user_id);

  const code = String(crypto.randomInt(100000, 999999));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const verificationId = crypto.randomUUID();
  const verifyVia = user.phone ? 'sms' : 'email';
  const destination = user.phone || user.email;

  db.prepare(`
    INSERT INTO brix_verifications (id, user_id, code, type, destination, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(verificationId, user_id, code, verifyVia, destination, expiresAt);

  console.log(`[BRIX] Novo código para ${destination}: ${code}`);

  // Send email if verification is via email
  let emailSent = false;
  if (verifyVia === 'email' && user.email) {
    try {
      emailSent = await sendVerificationCode(user.email, code);
    } catch (err) {
      console.error(`[BRIX] Erro ao reenviar email: ${err.message}`);
    }
  }

  const hasSmtp = !!process.env.SMTP_USER;
  res.json({
    success: true,
    message: emailSent ? 'Novo código enviado para seu email' : (hasSmtp ? 'Erro ao reenviar' : 'Novo código gerado (DEV)'),
    ...(!hasSmtp && { dev_code: code }),
  });
});

/**
 * GET /brix/pending-payments
 * Header: x-nostr-pubkey
 */
router.get('/pending-payments', (req, res) => {
  const nostr_pubkey = req.headers['x-nostr-pubkey'];

  if (!nostr_pubkey) {
    return res.status(401).json({ error: 'Autenticação obrigatória' });
  }

  const db = getDb();
  const user = db.prepare('SELECT id FROM brix_users WHERE nostr_pubkey = ? AND verified = 1').get(nostr_pubkey);
  if (!user) {
    return res.status(404).json({ error: 'Usuário não encontrado' });
  }

  const payments = db.prepare(`
    SELECT id, amount_sats, sender_note, created_at
    FROM brix_pending_payments
    WHERE user_id = ? AND status = 'received'
    ORDER BY created_at DESC
  `).all(user.id);

  res.json({ payments });
});

/**
 * POST /brix/claim
 * Body: { payment_id, invoice }
 * Header: x-nostr-pubkey
 */
router.post('/claim', async (req, res) => {
  const { payment_id, invoice } = req.body;
  const nostr_pubkey = req.headers['x-nostr-pubkey'];

  if (!payment_id || !invoice || !nostr_pubkey) {
    return res.status(400).json({ error: 'Campos obrigatórios: payment_id, invoice' });
  }

  const db = getDb();
  const user = db.prepare('SELECT id FROM brix_users WHERE nostr_pubkey = ? AND verified = 1').get(nostr_pubkey);
  if (!user) {
    return res.status(404).json({ error: 'Usuário não encontrado' });
  }

  const payment = db.prepare(`
    SELECT * FROM brix_pending_payments
    WHERE id = ? AND user_id = ? AND status = 'received'
  `).get(payment_id, user.id);

  if (!payment) {
    return res.status(404).json({ error: 'Pagamento não encontrado ou já resgatado' });
  }

  try {
    db.prepare("UPDATE brix_pending_payments SET status = 'forwarding' WHERE id = ?").run(payment_id);

    // TODO: Pay user invoice via Spark SDK when server wallet is configured
    const forwardHash = crypto.randomBytes(32).toString('hex');

    db.prepare(`
      UPDATE brix_pending_payments
      SET status = 'forwarded', forwarded_at = datetime('now'), forward_hash = ?
      WHERE id = ?
    `).run(forwardHash, payment_id);

    res.json({
      success: true,
      amount_sats: payment.amount_sats,
      forward_hash: forwardHash,
    });
  } catch (err) {
    db.prepare("UPDATE brix_pending_payments SET status = 'received' WHERE id = ?").run(payment_id);
    console.error('[BRIX] Erro ao resgatar:', err);
    res.status(500).json({ error: 'Falha ao resgatar pagamento' });
  }
});

/**
 * GET /brix/address/:pubkey
 */
router.get('/address/:pubkey', (req, res) => {
  const { pubkey } = req.params;
  const db = getDb();
  const user = db.prepare('SELECT username, phone, email FROM brix_users WHERE nostr_pubkey = ? AND verified = 1').get(pubkey);

  if (!user) {
    return res.status(404).json({ error: 'Nenhum BRIX registrado' });
  }

  const domain = process.env.BRIX_DOMAIN || 'brix.app';
  res.json({ brix_address: `${user.username}@${domain}`, username: user.username, phone: user.phone, email: user.email });
});

/**
 * GET /brix/history/:pubkey
 */
router.get('/history/:pubkey', (req, res) => {
  const { pubkey } = req.params;
  const db = getDb();
  const user = db.prepare('SELECT id FROM brix_users WHERE nostr_pubkey = ? AND verified = 1').get(pubkey);
  if (!user) {
    return res.status(404).json({ error: 'Usuário não encontrado' });
  }

  const payments = db.prepare(`
    SELECT id, amount_sats, status, sender_note, created_at, forwarded_at
    FROM brix_pending_payments
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 50
  `).all(user.id);

  res.json({ payments });
});

/**
 * GET /brix/resolve/:query
 * Resolve phone, email, or username to a BRIX address
 * Query can be: phone number, email, or username
 */
router.get('/resolve/:query', (req, res) => {
  const query = req.params.query.trim().toLowerCase();
  const db = getDb();
  const domain = process.env.BRIX_DOMAIN || 'brix.app';

  // Try username first
  let user = db.prepare('SELECT username, nostr_pubkey FROM brix_users WHERE username = ? AND verified = 1').get(query);
  if (user) {
    return res.json({ found: true, brix_address: `${user.username}@${domain}`, username: user.username, nostr_pubkey: user.nostr_pubkey, matched_by: 'username' });
  }

  // Try as brix address (user@brix.app)
  if (query.includes('@')) {
    const parts = query.split('@');
    if (parts[1] === domain) {
      user = db.prepare('SELECT username, nostr_pubkey FROM brix_users WHERE username = ? AND verified = 1').get(parts[0]);
      if (user) {
        return res.json({ found: true, brix_address: `${user.username}@${domain}`, username: user.username, nostr_pubkey: user.nostr_pubkey, matched_by: 'brix_address' });
      }
    }
  }

  // Try email
  if (query.includes('@')) {
    user = db.prepare('SELECT username, nostr_pubkey FROM brix_users WHERE email = ? AND verified = 1').get(query);
    if (user) {
      return res.json({ found: true, brix_address: `${user.username}@${domain}`, username: user.username, nostr_pubkey: user.nostr_pubkey, matched_by: 'email' });
    }
  }

  // Try phone (clean digits only)
  const cleanPhone = query.replace(/\D/g, '');
  if (cleanPhone.length >= 8) {
    user = db.prepare('SELECT username, nostr_pubkey FROM brix_users WHERE phone = ? AND verified = 1').get(cleanPhone);
    if (user) {
      return res.json({ found: true, brix_address: `${user.username}@${domain}`, username: user.username, nostr_pubkey: user.nostr_pubkey, matched_by: 'phone' });
    }
    // Try partial match (without country code)
    user = db.prepare("SELECT username, nostr_pubkey FROM brix_users WHERE phone LIKE ? AND verified = 1").get(`%${cleanPhone.slice(-9)}`);
    if (user) {
      return res.json({ found: true, brix_address: `${user.username}@${domain}`, username: user.username, nostr_pubkey: user.nostr_pubkey, matched_by: 'phone' });
    }
  }

  res.json({ found: false });
});

/**
 * POST /brix/submit-invoice
 * App submits a generated invoice for a pending invoice request
 * Body: { request_id, invoice }
 * Header: x-nostr-pubkey
 */
router.post('/submit-invoice', (req, res) => {
  const { request_id, invoice } = req.body;
  const nostr_pubkey = req.headers['x-nostr-pubkey'];

  if (!request_id || !invoice || !nostr_pubkey) {
    return res.status(400).json({ error: 'Campos obrigatórios: request_id, invoice' });
  }

  const db = getDb();
  const request = db.prepare(`
    SELECT ir.*, u.nostr_pubkey FROM brix_invoice_requests ir
    JOIN brix_users u ON ir.user_id = u.id
    WHERE ir.id = ? AND ir.status = 'pending' AND u.nostr_pubkey = ?
  `).get(request_id, nostr_pubkey);

  if (!request) {
    return res.status(404).json({ error: 'Solicitação não encontrada' });
  }

  db.prepare(`UPDATE brix_invoice_requests SET status = 'ready', invoice = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(invoice, request_id);

  console.log(`[BRIX] Invoice submitted for request ${request_id}`);
  res.json({ success: true });
});

/**
 * GET /brix/invoice-requests/:pubkey
 * Get pending invoice requests for a user
 */
router.get('/invoice-requests/:pubkey', (req, res) => {
  const { pubkey } = req.params;
  const db = getDb();

  const user = db.prepare('SELECT id FROM brix_users WHERE nostr_pubkey = ? AND verified = 1').get(pubkey);
  if (!user) {
    return res.json({ requests: [] });
  }

  const requests = db.prepare(`
    SELECT id, amount_sats, created_at FROM brix_invoice_requests
    WHERE user_id = ? AND status = 'pending' AND created_at > datetime('now', '-2 minutes')
    ORDER BY created_at DESC
  `).all(user.id);

  res.json({ requests });
});

/**
 * POST /brix/update-contact
 * Step 1: Request contact change (sends verification code to NEW contact)
 * Body: { phone?, email? }
 * Header: x-nostr-pubkey
 */
router.post('/update-contact', async (req, res) => {
  const { phone, email } = req.body;
  const nostr_pubkey = req.headers['x-nostr-pubkey'];

  if (!nostr_pubkey) {
    return res.status(401).json({ error: 'Autenticação obrigatória' });
  }
  if (!phone && !email) {
    return res.status(400).json({ error: 'Informe o novo celular ou email' });
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM brix_users WHERE nostr_pubkey = ? AND verified = 1').get(nostr_pubkey);
  if (!user) {
    return res.status(404).json({ error: 'Usuário não encontrado' });
  }

  const cleanPhone = phone ? phone.replace(/\D/g, '') : null;
  const cleanEmail = email ? email.trim().toLowerCase() : null;
  const verifyVia = cleanPhone ? 'sms' : 'email';
  const destination = cleanPhone || cleanEmail;

  // Invalidate old verification codes
  db.prepare("UPDATE brix_verifications SET used = 1 WHERE user_id = ? AND used = 0").run(user.id);

  const code = String(crypto.randomInt(100000, 999999));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const verificationId = crypto.randomUUID();

  db.prepare(`
    INSERT INTO brix_verifications (id, user_id, code, type, destination, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(verificationId, user.id, code, verifyVia, destination, expiresAt);

  console.log(`[BRIX] Update-contact code for ${destination}: ${code}`);

  let emailSent = false;
  if (verifyVia === 'email' && cleanEmail) {
    try {
      emailSent = await sendVerificationCode(cleanEmail, code);
    } catch (err) {
      console.error(`[BRIX] Erro ao enviar email: ${err.message}`);
    }
  }

  const hasSmtp = !!process.env.SMTP_USER;
  res.json({
    success: true,
    message: emailSent ? 'Código enviado para o novo email' : (hasSmtp ? 'Erro ao enviar email' : 'Código gerado (DEV)'),
    verify_via: verifyVia,
    ...(!hasSmtp && { dev_code: code }),
  });
});

/**
 * POST /brix/confirm-update
 * Step 2: Confirm contact change with verification code
 * Body: { code, phone?, email? }
 * Header: x-nostr-pubkey
 */
router.post('/confirm-update', (req, res) => {
  const { code, phone, email } = req.body;
  const nostr_pubkey = req.headers['x-nostr-pubkey'];

  if (!nostr_pubkey || !code) {
    return res.status(400).json({ error: 'Campos obrigatórios: code' });
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM brix_users WHERE nostr_pubkey = ? AND verified = 1').get(nostr_pubkey);
  if (!user) {
    return res.status(404).json({ error: 'Usuário não encontrado' });
  }

  const verification = db.prepare(`
    SELECT * FROM brix_verifications
    WHERE user_id = ? AND code = ? AND used = 0 AND expires_at > datetime('now')
    ORDER BY created_at DESC LIMIT 1
  `).get(user.id, code);

  if (!verification) {
    return res.status(400).json({ error: 'Código inválido ou expirado' });
  }

  const cleanPhone = phone ? phone.replace(/\D/g, '') : null;
  const cleanEmail = email ? email.trim().toLowerCase() : null;

  const tx = db.transaction(() => {
    db.prepare('UPDATE brix_verifications SET used = 1 WHERE id = ?').run(verification.id);
    if (cleanPhone) {
      db.prepare("UPDATE brix_users SET phone = ?, updated_at = datetime('now') WHERE id = ?").run(cleanPhone, user.id);
    }
    if (cleanEmail) {
      db.prepare("UPDATE brix_users SET email = ?, updated_at = datetime('now') WHERE id = ?").run(cleanEmail, user.id);
    }
  });
  tx();

  const domain = process.env.BRIX_DOMAIN || 'brix.app';
  res.json({
    success: true,
    message: 'Contato atualizado com sucesso!',
    brix_address: `${user.username}@${domain}`,
  });
});

module.exports = router;
