const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getDb } = require('../models/database');
const { sendSmsVerification, checkSmsVerification, sendEmailVerification, checkEmailVerification, normalizeBrazilianPhone } = require('../services/sms');

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
  const existing = db.prepare('SELECT id, verified FROM brix_users WHERE username = ?').get(username);

  // Block if username is already taken (verified blocks always, unverified blocks only if recent)
  if (existing) {
    if (existing.verified) {
      return res.json({ available: false, username });
    }
    // Unverified entries older than 1 hour are considered stale and can be reclaimed
    const stale = db.prepare("SELECT id FROM brix_users WHERE id = ? AND created_at < datetime('now', '-1 hour')").get(existing.id);
    if (!stale) {
      return res.json({ available: false, username });
    }
  }

  res.json({ available: true, username });
});

/**
 * POST /brix/register
 * Body: { username, phone?, email?, nostr_pubkey? }
 * At least one of phone/email required for verification
 */
router.post('/register', async (req, res) => {
  const { username, phone, email, nostr_pubkey: bodyPubkey } = req.body;

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

  const nostr_pubkey = bodyPubkey || req.headers['x-nostr-pubkey'] || `web_${crypto.randomBytes(16).toString('hex')}`;
  const db = getDb();
  // Normalize phone: strip non-digits and auto-fix Brazilian mobile numbers
  const rawPhone = phone ? phone.replace(/\D/g, '') : null;
  const cleanPhone = rawPhone ? normalizeBrazilianPhone(rawPhone).replace(/\D/g, '') : null;
  const cleanEmail = email ? email.trim().toLowerCase() : null;

  // Check if username is already taken
  const existingUsername = db.prepare('SELECT id, verified, nostr_pubkey, email, phone FROM brix_users WHERE username = ?').get(cleanUsername);
  if (existingUsername && existingUsername.verified) {
    // If the existing BRIX was created on the web (web_ pubkey) and the email matches,
    // allow the app to claim it by updating the pubkey
    if (existingUsername.nostr_pubkey.startsWith('web_') && cleanEmail && existingUsername.email === cleanEmail) {
      const domain = process.env.BRIX_DOMAIN || 'brix.app';
      db.prepare("UPDATE brix_users SET nostr_pubkey = ?, updated_at = datetime('now') WHERE id = ?").run(nostr_pubkey, existingUsername.id);
      if (cleanPhone) {
        db.prepare("UPDATE brix_users SET phone = ?, updated_at = datetime('now') WHERE id = ?").run(cleanPhone, existingUsername.id);
      }
      console.log(`[BRIX] Web BRIX claimed by app: ${cleanUsername}@${domain} -> ${nostr_pubkey.substring(0, 16)}...`);
      return res.json({
        success: true,
        verified: true,
        message: 'BRIX vinculado ao app!',
        user_id: existingUsername.id,
        username: cleanUsername,
        brix_address: `${cleanUsername}@${domain}`,
      });
    }
    return res.status(409).json({ error: 'Este username já está em uso' });
  }

  // Check if email is already used by ANY user (verified or not) with a DIFFERENT username
  if (cleanEmail) {
    const existingEmail = db.prepare('SELECT id, username, verified FROM brix_users WHERE email = ? AND username != ?').get(cleanEmail, cleanUsername);
    if (existingEmail) {
      if (existingEmail.verified) {
        return res.status(409).json({ error: 'Este email já está vinculado a outro username' });
      }
      // Clean up stale unverified entry with different username but same email
      db.prepare('DELETE FROM brix_verifications WHERE user_id = ?').run(existingEmail.id);
      db.prepare('DELETE FROM brix_users WHERE id = ?').run(existingEmail.id);
    }
  }

  // Check if phone is already used by ANY user (verified or not) with a DIFFERENT username
  if (cleanPhone) {
    const existingPhone = db.prepare('SELECT id, username, verified FROM brix_users WHERE phone = ? AND username != ?').get(cleanPhone, cleanUsername);
    if (existingPhone) {
      if (existingPhone.verified) {
        return res.status(409).json({ error: 'Este celular já está vinculado a outro username' });
      }
      // Clean up stale unverified entry with different username but same phone
      db.prepare('DELETE FROM brix_verifications WHERE user_id = ?').run(existingPhone.id);
      db.prepare('DELETE FROM brix_users WHERE id = ?').run(existingPhone.id);
    }
  }

  const hasTwilio = !!process.env.TWILIO_ACCOUNT_SID;
  const domain = process.env.BRIX_DOMAIN || 'brix.app';

  // If unverified entry exists with same username, update it instead of delete+recreate
  if (existingUsername && !existingUsername.verified) {
    const userId = existingUsername.id;
    db.prepare(`
      UPDATE brix_users SET phone = ?, email = ?, nostr_pubkey = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(cleanPhone, cleanEmail, nostr_pubkey, userId);

    const verifyVia = cleanPhone ? 'sms' : 'email';

    // All verification via Twilio Verify (SMS or Email)
    if (hasTwilio) {
      let sent = false;
      try {
        sent = verifyVia === 'sms'
          ? await sendSmsVerification(cleanPhone)
          : await sendEmailVerification(cleanEmail);
      } catch (err) {
        console.error(`[BRIX] Erro ao enviar ${verifyVia}: ${err.message}`);
      }
      return res.json({
        success: true, verified: false,
        message: sent ? (verifyVia === 'sms' ? 'Código enviado por SMS' : 'Código enviado para seu email') : `Erro ao enviar ${verifyVia}`,
        user_id: userId, username: cleanUsername, verify_via: verifyVia,
      });
    }

    return res.status(500).json({ error: 'Serviço de verificação indisponível' });
  }

  // New registration
  const userId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO brix_users (id, username, phone, email, nostr_pubkey)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, cleanUsername, cleanPhone, cleanEmail, nostr_pubkey);

  const verifyVia = cleanPhone ? 'sms' : 'email';

  // All verification via Twilio Verify (SMS or Email)
  if (hasTwilio) {
    let sent = false;
    try {
      sent = verifyVia === 'sms'
        ? await sendSmsVerification(cleanPhone)
        : await sendEmailVerification(cleanEmail);
    } catch (err) {
      console.error(`[BRIX] Erro ao enviar ${verifyVia}: ${err.message}`);
    }
    return res.json({
      success: true, verified: false,
      message: sent ? (verifyVia === 'sms' ? 'Código enviado por SMS' : 'Código enviado para seu email') : `Erro ao enviar ${verifyVia}`,
      user_id: userId, username: cleanUsername, verify_via: verifyVia,
    });
  }

  res.status(500).json({ error: 'Serviço de verificação indisponível' });
});

/**
 * POST /brix/verify
 * Body: { user_id, code }
 */
router.post('/verify', async (req, res) => {
  const { user_id, code } = req.body;

  if (!user_id || !code) {
    return res.status(400).json({ error: 'Campos obrigatórios: user_id, code' });
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM brix_users WHERE id = ?').get(user_id);
  if (!user) {
    return res.status(404).json({ error: 'Usuário não encontrado' });
  }

  // Verify via Twilio Verify API (SMS or Email)
  const verifyTarget = user.phone || user.email;
  if (!verifyTarget || !process.env.TWILIO_ACCOUNT_SID) {
    return res.status(500).json({ error: 'Serviço de verificação indisponível' });
  }

  const valid = user.phone
    ? await checkSmsVerification(user.phone, code)
    : await checkEmailVerification(user.email, code);

  if (!valid) {
    return res.status(400).json({ error: 'Código inválido ou expirado' });
  }

  db.prepare("UPDATE brix_users SET verified = 1, updated_at = datetime('now') WHERE id = ?").run(user_id);

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

  const verifyVia = user.phone ? 'sms' : 'email';
  const hasTwilio = !!process.env.TWILIO_ACCOUNT_SID;

  if (!hasTwilio) {
    return res.status(500).json({ error: 'Serviço de verificação indisponível' });
  }

  let sent = false;
  try {
    sent = verifyVia === 'sms'
      ? await sendSmsVerification(user.phone)
      : await sendEmailVerification(user.email);
  } catch (err) {
    console.error(`[BRIX] Erro ao reenviar ${verifyVia}: ${err.message}`);
  }

  res.json({
    success: true, verified: false,
    message: sent
      ? (verifyVia === 'sms' ? 'Novo código enviado por SMS' : 'Novo código enviado para seu email')
      : `Erro ao reenviar ${verifyVia}`,
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
    SELECT id, amount_sats, fee_sats, net_amount_sats, sender_note, created_at
    FROM brix_pending_payments
    WHERE user_id = ? AND status = 'received'
    ORDER BY created_at DESC
  `).all(user.id);

  // Return net_amount_sats as the claim amount (what recipient gets)
  const result = payments.map(p => ({
    id: p.id,
    amount_sats: p.net_amount_sats || p.amount_sats,
    gross_amount_sats: p.amount_sats,
    fee_sats: p.fee_sats || 0,
    sender_note: p.sender_note,
    created_at: p.created_at,
  }));

  res.json({ payments: result });
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
    db.prepare("UPDATE brix_pending_payments SET status = 'claiming' WHERE id = ?").run(payment_id);

    const amountToPay = payment.net_amount_sats || payment.amount_sats;
    const forwardHash = crypto.randomBytes(32).toString('hex');

    db.prepare(`
      UPDATE brix_pending_payments
      SET status = 'forwarded', forwarded_at = datetime('now'), forward_hash = ?
      WHERE id = ?
    `).run(forwardHash, payment_id);

    res.json({
      success: true,
      amount_sats: amountToPay,
      forward_hash: forwardHash,
    });
  } catch (err) {
    db.prepare("UPDATE brix_pending_payments SET status = 'received' WHERE id = ?").run(payment_id);
    console.error('[BRIX] Erro ao resgatar:', err);
    res.status(500).json({ error: 'Falha ao resgatar pagamento' });
  }
});

/**
 * POST /brix/link-pubkey
 * Body: { username, nostr_pubkey }
 * Links a verified BRIX to a real nostr pubkey (replaces web_ placeholder)
 */
router.post('/link-pubkey', (req, res) => {
  const { username, nostr_pubkey } = req.body;
  const currentPubkey = req.headers['x-nostr-pubkey'];

  if (!username || !nostr_pubkey) {
    return res.status(400).json({ error: 'username e nostr_pubkey obrigatórios' });
  }

  if (!nostr_pubkey.match(/^[0-9a-f]{64}$/) && !nostr_pubkey.startsWith('npub1')) {
    return res.status(400).json({ error: 'nostr_pubkey inválido' });
  }

  const db = getDb();
  const cleanUsername = username.toLowerCase().trim();
  const user = db.prepare('SELECT id, nostr_pubkey FROM brix_users WHERE username = ? AND verified = 1').get(cleanUsername);

  if (!user) {
    return res.status(404).json({ error: 'BRIX não encontrado ou não verificado' });
  }

  // Only allow linking if current key is a web placeholder (and caller provides any pubkey)
  // or if the authenticated pubkey matches the current one
  if (user.nostr_pubkey.startsWith('web_')) {
    // Web-created account — allow first link
  } else if (currentPubkey && currentPubkey === user.nostr_pubkey) {
    // Authenticated owner — allow re-link
  } else {
    return res.status(403).json({ error: 'Não autorizado a vincular esta chave' });
  }

  // Check if pubkey already has a different BRIX
  const existingPubkey = db.prepare('SELECT username FROM brix_users WHERE nostr_pubkey = ? AND verified = 1 AND username != ?').get(nostr_pubkey, cleanUsername);
  if (existingPubkey) {
    return res.status(409).json({ error: `Esta chave já está vinculada ao username "${existingPubkey.username}"` });
  }

  db.prepare("UPDATE brix_users SET nostr_pubkey = ?, updated_at = datetime('now') WHERE id = ?").run(nostr_pubkey, user.id);

  const domain = process.env.BRIX_DOMAIN || 'brix.app';
  console.log(`[BRIX] Pubkey vinculada: ${cleanUsername}@${domain} -> ${nostr_pubkey.substring(0, 16)}...`);

  res.json({
    success: true,
    username: cleanUsername,
    brix_address: `${cleanUsername}@${domain}`,
    message: 'Chave nostr vinculada ao BRIX com sucesso',
  });
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
  // Only return sensitive contact info to the owner (authenticated via header)
  const authedPubkey = req.headers['x-nostr-pubkey'];
  const isOwner = authedPubkey === pubkey;
  const response = { brix_address: `${user.username}@${domain}`, username: user.username };
  if (isOwner) {
    response.phone = user.phone;
    response.email = user.email;
  }
  res.json(response);
});

/**
 * GET /brix/find-by-email/:email
 * Find a BRIX by email (used by app to find web-created BRIX)
 */
router.get('/find-by-email/:email', (req, res) => {
  const email = req.params.email.trim().toLowerCase();
  const db = getDb();
  const user = db.prepare('SELECT username, phone, email, nostr_pubkey FROM brix_users WHERE email = ? AND verified = 1').get(email);

  if (!user) {
    return res.status(404).json({ error: 'Nenhum BRIX encontrado' });
  }

  const domain = process.env.BRIX_DOMAIN || 'brix.app';
  res.json({
    brix_address: `${user.username}@${domain}`,
    username: user.username,
    phone: user.phone,
    email: user.email,
    has_web_pubkey: user.nostr_pubkey.startsWith('web_'),
  });
});

/**
 * GET /brix/history/:pubkey
 */
router.get('/history/:pubkey', (req, res) => {
  const { pubkey } = req.params;
  const authedPubkey = req.headers['x-nostr-pubkey'];
  if (!authedPubkey || authedPubkey !== pubkey) {
    return res.status(403).json({ error: 'Não autorizado' });
  }
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

  // Try phone (clean digits only, exact match)
  const cleanPhone = query.replace(/\D/g, '');
  if (cleanPhone.length >= 8) {
    user = db.prepare('SELECT username, nostr_pubkey FROM brix_users WHERE phone = ? AND verified = 1').get(cleanPhone);
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

  const rawPhone2 = phone ? phone.replace(/\D/g, '') : null;
  const cleanPhone = rawPhone2 ? normalizeBrazilianPhone(rawPhone2).replace(/\D/g, '') : null;
  const cleanEmail = email ? email.trim().toLowerCase() : null;
  const verifyVia = cleanPhone ? 'sms' : 'email';

  const hasTwilio = !!process.env.TWILIO_ACCOUNT_SID;
  if (!hasTwilio) {
    return res.status(500).json({ error: 'Serviço de verificação indisponível' });
  }

  let sent = false;
  try {
    sent = verifyVia === 'sms'
      ? await sendSmsVerification(cleanPhone)
      : await sendEmailVerification(cleanEmail);
  } catch (err) {
    console.error(`[BRIX] Erro ao enviar ${verifyVia}: ${err.message}`);
  }

  res.json({
    success: true,
    message: sent
      ? (verifyVia === 'sms' ? 'Código enviado por SMS' : 'Código enviado para o novo email')
      : `Erro ao enviar ${verifyVia}`,
    verify_via: verifyVia,
  });
});

/**
 * POST /brix/confirm-update
 * Step 2: Confirm contact change with verification code
 * Body: { code, phone?, email? }
 * Header: x-nostr-pubkey
 */
router.post('/confirm-update', async (req, res) => {
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

  const cleanPhone = phone ? phone.replace(/\D/g, '') : null;
  const cleanEmail = email ? email.trim().toLowerCase() : null;

  // Verify via Twilio Verify API (SMS or Email)
  const verifyTarget = cleanPhone || cleanEmail;
  if (!verifyTarget || !process.env.TWILIO_ACCOUNT_SID) {
    return res.status(500).json({ error: 'Serviço de verificação indisponível' });
  }

  const valid = cleanPhone
    ? await checkSmsVerification(cleanPhone, code)
    : await checkEmailVerification(cleanEmail, code);

  if (!valid) {
    return res.status(400).json({ error: 'Código inválido ou expirado' });
  }

  if (cleanPhone) {
    db.prepare("UPDATE brix_users SET phone = ?, updated_at = datetime('now') WHERE id = ?").run(cleanPhone, user.id);
  } else if (cleanEmail) {
    db.prepare("UPDATE brix_users SET email = ?, updated_at = datetime('now') WHERE id = ?").run(cleanEmail, user.id);
  }

  const domain = process.env.BRIX_DOMAIN || 'brix.app';
  res.json({
    success: true,
    message: 'Contato atualizado com sucesso!',
    brix_address: `${user.username}@${domain}`,
  });
});

module.exports = router;
