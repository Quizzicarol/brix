const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getDb } = require('../models/database');
const { sendVerificationCode } = require('../services/email');
const { sendSmsVerification, checkSmsVerification, normalizeBrazilianPhone } = require('../services/sms');
const { encrypt, decrypt, hmacHash } = require('../services/encryption');

// debug-user endpoint REMOVED for security (information disclosure)

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
    if (existingUsername.nostr_pubkey.startsWith('web_') && cleanEmail && decrypt(existingUsername.email) === cleanEmail) {
      const domain = process.env.BRIX_DOMAIN || 'brix.app';
      db.prepare("UPDATE brix_users SET nostr_pubkey = ?, updated_at = datetime('now') WHERE id = ?").run(nostr_pubkey, existingUsername.id);
      if (cleanPhone) {
        db.prepare("UPDATE brix_users SET phone = ?, phone_hash = ?, updated_at = datetime('now') WHERE id = ?").run(encrypt(cleanPhone), hmacHash(cleanPhone), existingUsername.id);
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
    const existingEmail = db.prepare('SELECT id, username, verified FROM brix_users WHERE email_hash = ? AND username != ?').get(hmacHash(cleanEmail), cleanUsername);
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
    const existingPhone = db.prepare('SELECT id, username, verified FROM brix_users WHERE phone_hash = ? AND username != ?').get(hmacHash(cleanPhone), cleanUsername);
    if (existingPhone) {
      if (existingPhone.verified) {
        return res.status(409).json({ error: 'Este celular já está vinculado a outro username' });
      }
      // Clean up stale unverified entry with different username but same phone
      db.prepare('DELETE FROM brix_verifications WHERE user_id = ?').run(existingPhone.id);
      db.prepare('DELETE FROM brix_users WHERE id = ?').run(existingPhone.id);
    }
  }

  const hasSmtp = !!process.env.SMTP_USER;
  const hasSms = !!process.env.TWILIO_ACCOUNT_SID;
  const domain = process.env.BRIX_DOMAIN || 'brix.app';

  // If unverified entry exists with same username, update it instead of delete+recreate
  if (existingUsername && !existingUsername.verified) {
    const userId = existingUsername.id;
    db.prepare(`
      UPDATE brix_users SET phone = ?, phone_hash = ?, email = ?, email_hash = ?, nostr_pubkey = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(encrypt(cleanPhone), hmacHash(cleanPhone), encrypt(cleanEmail), hmacHash(cleanEmail), nostr_pubkey, userId);

    // Invalidate old verification codes
    db.prepare("UPDATE brix_verifications SET used = 1 WHERE user_id = ? AND used = 0").run(userId);

    const verifyVia = cleanPhone ? 'sms' : 'email';
    const destination = cleanPhone || cleanEmail;

    // For SMS: Twilio Verify generates & sends the code
    // For email: we generate code and send via SMTP
    if (verifyVia === 'sms' && hasSms) {
      let sent = false;
      try { sent = await sendSmsVerification(cleanPhone); } catch (err) {
        console.error(`[BRIX] Erro ao enviar SMS: ${err.message}`);
      }
      return res.json({
        success: true, verified: false,
        message: sent ? 'Código enviado por SMS' : 'Erro ao enviar SMS',
        user_id: userId, username: cleanUsername, verify_via: 'sms',
      });
    }

    const code = String(crypto.randomInt(100000, 999999));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const verificationId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO brix_verifications (id, user_id, code, type, destination, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(verificationId, userId, code, verifyVia, encrypt(destination), expiresAt);
    console.log(`[BRIX] Código de verificação (re-registro) enviado para ${cleanUsername} via ${verifyVia}`);

    let sent = false;
    if (verifyVia === 'email' && cleanEmail && hasSmtp) {
      try { sent = await sendVerificationCode(cleanEmail, code); } catch (err) {
        console.error(`[BRIX] Erro ao enviar email: ${err.message}`);
      }
    }

    const canSend = hasSmtp;
    return res.json({
      success: true, verified: false,
      message: sent ? 'Código enviado para seu email' : (canSend ? 'Erro ao enviar email' : 'Use o código de verificação'),
      user_id: userId, username: cleanUsername, verify_via: verifyVia,
    });
  }

  // New registration
  const userId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO brix_users (id, username, phone, phone_hash, email, email_hash, nostr_pubkey)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, cleanUsername, encrypt(cleanPhone), hmacHash(cleanPhone), encrypt(cleanEmail), hmacHash(cleanEmail), nostr_pubkey);

  const verifyVia = cleanPhone ? 'sms' : 'email';
  const destination = cleanPhone || cleanEmail;

  // For SMS: Twilio Verify generates & sends the code
  if (verifyVia === 'sms' && hasSms) {
    let sent = false;
    try {
      sent = await sendSmsVerification(cleanPhone);
    } catch (err) {
      console.error(`[BRIX] Erro ao enviar SMS: ${err.message}`);
    }
    return res.json({
      success: true, verified: false,
      message: sent ? 'Código enviado por SMS' : 'Erro ao enviar SMS',
      user_id: userId, username: cleanUsername, verify_via: 'sms',
    });
  }

  // For email: we generate code and send via SMTP
  const code = String(crypto.randomInt(100000, 999999));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const verificationId = crypto.randomUUID();

  db.prepare(`
    INSERT INTO brix_verifications (id, user_id, code, type, destination, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(verificationId, userId, code, verifyVia, encrypt(destination), expiresAt);

  console.log(`[BRIX] Código de verificação enviado para ${cleanUsername} via ${verifyVia}`);

  let sent = false;
  if (cleanEmail && hasSmtp) {
    try {
      sent = await sendVerificationCode(cleanEmail, code);
    } catch (err) {
      console.error(`[BRIX] Erro ao enviar email: ${err.message}`);
    }
  }

  const canSend = hasSmtp;
  if (!canSend) {
    console.log(`[BRIX] Sem SMTP — código gerado para ${cleanUsername}@${domain} (verifique logs locais)`);
  }

  res.json({
    success: true, verified: false,
    message: sent ? 'Código enviado para seu email' : (canSend ? 'Erro ao enviar email' : 'Use o código de verificação'),
    user_id: userId, username: cleanUsername, verify_via: verifyVia,
  });
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

  // If user registered with phone, verify via Twilio Verify API
  const userPhone = decrypt(user.phone);
  if (userPhone && !!process.env.TWILIO_ACCOUNT_SID) {
    const valid = await checkSmsVerification(userPhone, code);
    if (!valid) {
      return res.status(400).json({ error: 'Código inválido ou expirado' });
    }
    db.prepare("UPDATE brix_users SET verified = 1, updated_at = datetime('now') WHERE id = ?").run(user_id);
  } else {
    // Email verification: check code in our database
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
  }

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

  const resendPhone = decrypt(user.phone);
  const resendEmail = decrypt(user.email);
  const verifyVia = resendPhone ? 'sms' : 'email';
  const destination = resendPhone || resendEmail;
  const hasSmtp = !!process.env.SMTP_USER;
  const hasSms = !!process.env.TWILIO_ACCOUNT_SID;

  // For SMS: Twilio Verify sends a new code
  if (verifyVia === 'sms' && hasSms) {
    let sent = false;
    try {
      sent = await sendSmsVerification(resendPhone);
    } catch (err) {
      console.error(`[BRIX] Erro ao reenviar SMS: ${err.message}`);
    }
    return res.json({
      success: true, verified: false,
      message: sent ? 'Novo código enviado por SMS' : 'Erro ao reenviar SMS',
    });
  }

  // For email: generate code and send via SMTP
  db.prepare("UPDATE brix_verifications SET used = 1 WHERE user_id = ? AND used = 0").run(user_id);
  const code = String(crypto.randomInt(100000, 999999));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const verificationId = crypto.randomUUID();

  db.prepare(`
    INSERT INTO brix_verifications (id, user_id, code, type, destination, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(verificationId, user_id, code, verifyVia, encrypt(destination), expiresAt);
  console.log(`[BRIX] Novo código enviado para user ${user_id.slice(0,8)} via ${verifyVia}`);

  let sent = false;
  if (resendEmail && hasSmtp) {
    try {
      sent = await sendVerificationCode(resendEmail, code);
    } catch (err) {
      console.error(`[BRIX] Erro ao reenviar email: ${err.message}`);
    }
  }

  const canSend = hasSmtp;
  res.json({
    success: true, verified: false,
    message: sent ? 'Novo código enviado para seu email' : (canSend ? 'Erro ao reenviar' : 'Use o código de verificação'),
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

  // Allow same pubkey for multiple usernames when caller is the owner
  const existingPubkey = db.prepare('SELECT username FROM brix_users WHERE nostr_pubkey = ? AND verified = 1 AND username != ?').get(nostr_pubkey, cleanUsername);
  if (existingPubkey && currentPubkey !== nostr_pubkey) {
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
  const users = db.prepare('SELECT username, phone, email FROM brix_users WHERE nostr_pubkey = ? AND verified = 1 ORDER BY created_at ASC').all(pubkey);

  if (!users.length) {
    return res.status(404).json({ error: 'Nenhum BRIX registrado' });
  }

  const domain = process.env.BRIX_DOMAIN || 'brix.app';
  const primary = users[0];
  // Return primary + list of all usernames for this pubkey
  const allUsernames = users.map(u => u.username);
  res.json({
    brix_address: `${primary.username}@${domain}`,
    username: primary.username,
    all_usernames: allUsernames,
  });
});

/**
 * GET /brix/find-by-email/:email
 * Find a BRIX by email (used by app to find web-created BRIX)
 */
router.get('/find-by-email/:email', (req, res) => {
  const authedPubkey = req.verifiedPubkey;
  if (!authedPubkey) {
    return res.status(401).json({ error: 'Autenticação NIP-98 obrigatória' });
  }

  const email = req.params.email.trim().toLowerCase();
  const db = getDb();
  const user = db.prepare('SELECT username, nostr_pubkey FROM brix_users WHERE email_hash = ? AND verified = 1').get(hmacHash(email));

  if (!user) {
    return res.status(404).json({ error: 'Nenhum BRIX encontrado' });
  }

  const domain = process.env.BRIX_DOMAIN || 'brix.app';
  res.json({
    brix_address: `${user.username}@${domain}`,
    username: user.username,
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
  const callerPubkey = req.headers['x-nostr-pubkey'] || req.verifiedPubkey || 'anon';

  // Try username first
  let user = db.prepare('SELECT username FROM brix_users WHERE username = ? AND verified = 1').get(query);
  if (user) {
    console.log(`[RESOLVE] ${query} → ${user.username}@${domain} (by=username, caller=${callerPubkey.substring(0, 8)})`);
    return res.json({ found: true, brix_address: `${user.username}@${domain}`, username: user.username, matched_by: 'username' });
  }

  // Try as brix address (user@brix.app)
  if (query.includes('@')) {
    const parts = query.split('@');
    if (parts[1] === domain) {
      user = db.prepare('SELECT username FROM brix_users WHERE username = ? AND verified = 1').get(parts[0]);
      if (user) {
        return res.json({ found: true, brix_address: `${user.username}@${domain}`, username: user.username, matched_by: 'brix_address' });
      }
    }
  }

  // Phone/email lookup requires NIP-98 authentication
  const authedPubkey = req.verifiedPubkey;
  if (!authedPubkey) {
    return res.json({ found: false });
  }

  // Try email
  if (query.includes('@')) {
    user = db.prepare('SELECT username FROM brix_users WHERE email_hash = ? AND verified = 1').get(hmacHash(query));
    if (user) {
      return res.json({ found: true, brix_address: `${user.username}@${domain}`, username: user.username, matched_by: 'email' });
    }
  }

  // Try phone — normalize the same way registration does
  const rawPhone = query.replace(/\D/g, '');
  if (rawPhone.length >= 8) {
    // Build candidate list: raw, with +55 prefix (Brazilian local), and normalized
    const candidates = new Set([rawPhone]);
    // If user entered local BR number (10-11 digits without country code), try adding 55
    if (rawPhone.length <= 11 && !rawPhone.startsWith('55')) {
      candidates.add('55' + rawPhone);
      // Also normalize the 55-prefixed version (adds mobile 9 digit if needed)
      candidates.add(normalizeBrazilianPhone('55' + rawPhone).replace(/\D/g, ''));
    }
    candidates.add(normalizeBrazilianPhone(rawPhone).replace(/\D/g, ''));

    for (const candidate of candidates) {
      user = db.prepare('SELECT username FROM brix_users WHERE phone_hash = ? AND verified = 1').get(hmacHash(candidate));
      if (user) {
        return res.json({ found: true, brix_address: `${user.username}@${domain}`, username: user.username, matched_by: 'phone' });
      }
    }
  }

  console.log(`[RESOLVE] ${query} → NOT FOUND (caller=${callerPubkey.substring(0, 8)})`);
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
    // Diagnostic: check why not found
    const irOnly = db.prepare('SELECT status, user_id FROM brix_invoice_requests WHERE id = ?').get(request_id);
    if (irOnly) {
      const irUser = db.prepare('SELECT nostr_pubkey, username FROM brix_users WHERE id = ?').get(irOnly.user_id);
      console.log(`[SUBMIT-DIAG] request ${request_id.substring(0,8)} NOT matched: status=${irOnly.status}, db_pubkey=${irUser?.nostr_pubkey?.substring(0,8)}..., submitted_pubkey=${nostr_pubkey.substring(0,8)}..., username=${irUser?.username}`);
    } else {
      console.log(`[SUBMIT-DIAG] request ${request_id.substring(0,8)} NOT FOUND in DB`);
    }
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
  const username = req.query.username; // Optional: filter to specific BRIX account
  const authedPubkey = req.headers['x-nostr-pubkey'];
  if (!authedPubkey || authedPubkey !== pubkey) {
    return res.status(403).json({ error: 'Não autorizado' });
  }
  const db = getDb();

  let users;
  if (username) {
    // If username provided, only get that specific user (prevents cross-account leaks)
    users = db.prepare('SELECT id FROM brix_users WHERE nostr_pubkey = ? AND username = ? AND verified = 1').all(pubkey, username);
    if (!users.length) {
      // Diagnostic: check if user exists with different pubkey
      const altUser = db.prepare('SELECT nostr_pubkey, verified FROM brix_users WHERE username = ?').get(username);
      if (altUser) {
        console.log(`[POLL-DIAG] ${username} found BUT nostr_pubkey mismatch! DB=${altUser.nostr_pubkey?.substring(0,8)}... poll=${pubkey.substring(0,8)}... verified=${altUser.verified}`);
      } else {
        console.log(`[POLL-DIAG] ${username} NOT FOUND in brix_users at all`);
      }
    }
  } else {
    // Fallback: get ALL users with same pubkey (legacy clients without username)
    users = db.prepare('SELECT id FROM brix_users WHERE nostr_pubkey = ? AND verified = 1').all(pubkey);
  }
  if (!users.length) {
    return res.json({ requests: [] });
  }

  // Update last_seen for ALL users with this pubkey (so sibling FCM check works in LNURL callback)
  db.prepare("UPDATE brix_users SET last_seen = datetime('now') WHERE nostr_pubkey = ? AND verified = 1").run(pubkey);

  const userIds = users.map(u => u.id);
  const placeholders = userIds.map(() => '?').join(',');

  let requests;
  if (username) {
    // Per-username filtering already prevents self-invoicing (user_id scoped to this username)
    // No sender_pubkey filter needed — allows same-pubkey users to receive from each other
    requests = db.prepare(`
      SELECT id, amount_sats, created_at FROM brix_invoice_requests
      WHERE user_id IN (${placeholders}) AND status = 'pending' AND created_at > datetime('now', '-2 minutes')
      ORDER BY created_at DESC
    `).all(...userIds);
  } else {
    // Legacy clients without username: use sender_pubkey filter to prevent self-invoicing
    requests = db.prepare(`
      SELECT id, amount_sats, created_at FROM brix_invoice_requests
      WHERE user_id IN (${placeholders}) AND status = 'pending' AND created_at > datetime('now', '-2 minutes')
      AND (sender_pubkey IS NULL OR sender_pubkey != ?)
      ORDER BY created_at DESC
    `).all(...userIds, pubkey);
  }

  if (requests.length > 0) {
    console.log(`[POLL] ${username || pubkey.substring(0,8)} has ${requests.length} pending request(s): ${requests.map(r => r.id.substring(0,8) + '=' + r.amount_sats + 'sats').join(', ')}`);
  }
  res.json({ requests });
});

/**
 * POST /brix/update-contact
 * Step 1: Request contact change (sends verification code to NEW contact)
 * Body: { phone?, email? }
 * Requires NIP-98 cryptographic authentication
 */
router.post('/update-contact', async (req, res) => {
  const { phone, email } = req.body;
  const nostr_pubkey = req.verifiedPubkey;

  if (!nostr_pubkey) {
    return res.status(401).json({ error: 'Autenticação NIP-98 obrigatória' });
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
  const destination = cleanPhone || cleanEmail;

  // Invalidate old verification codes
  db.prepare("UPDATE brix_verifications SET used = 1 WHERE user_id = ? AND used = 0").run(user.id);

  const hasSmtp = !!process.env.SMTP_USER;
  const hasSms = !!process.env.TWILIO_ACCOUNT_SID;

  // For SMS: Twilio Verify sends the code
  if (verifyVia === 'sms' && hasSms) {
    let sent = false;
    try {
      sent = await sendSmsVerification(cleanPhone);
    } catch (err) {
      console.error(`[BRIX] Erro ao enviar SMS: ${err.message}`);
    }
    return res.json({
      success: true,
      message: sent ? 'Código enviado por SMS' : 'Erro ao enviar SMS',
      verify_via: 'sms',
    });
  }

  // For email: generate code and send via SMTP
  const code = String(crypto.randomInt(100000, 999999));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const verificationId = crypto.randomUUID();

  db.prepare(`
    INSERT INTO brix_verifications (id, user_id, code, type, destination, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(verificationId, user.id, code, verifyVia, encrypt(destination), expiresAt);
  console.log(`[BRIX] Update-contact code enviado para user ${user.id.slice(0,8)} via ${verifyVia}`);

  let sent = false;
  if (cleanEmail && hasSmtp) {
    try {
      sent = await sendVerificationCode(cleanEmail, code);
    } catch (err) {
      console.error(`[BRIX] Erro ao enviar email: ${err.message}`);
    }
  }

  const canSend = hasSmtp;
  res.json({
    success: true,
    message: sent ? 'Código enviado para o novo email' : (canSend ? 'Erro ao enviar email' : 'Código gerado'),
    verify_via: verifyVia,
  });
});

/**
 * POST /brix/confirm-update
 * Step 2: Confirm contact change with verification code
 * Body: { code, phone?, email? }
 * Requires NIP-98 cryptographic authentication
 */
router.post('/confirm-update', async (req, res) => {
  const { code, phone, email } = req.body;
  const nostr_pubkey = req.verifiedPubkey;

  if (!nostr_pubkey || !code) {
    return res.status(400).json({ error: 'Autenticação NIP-98 e código obrigatórios' });
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM brix_users WHERE nostr_pubkey = ? AND verified = 1').get(nostr_pubkey);
  if (!user) {
    return res.status(404).json({ error: 'Usuário não encontrado' });
  }

  const cleanPhone = phone ? phone.replace(/\D/g, '') : null;
  const cleanEmail = email ? email.trim().toLowerCase() : null;

  // For SMS-based contact update: verify via Twilio Verify
  if (cleanPhone && !!process.env.TWILIO_ACCOUNT_SID) {
    const valid = await checkSmsVerification(cleanPhone, code);
    if (!valid) {
      return res.status(400).json({ error: 'Código inválido ou expirado' });
    }
    db.prepare("UPDATE brix_users SET phone = ?, phone_hash = ?, updated_at = datetime('now') WHERE id = ?").run(encrypt(cleanPhone), hmacHash(cleanPhone), user.id);
  } else {
    // Email-based: check code in our database
    const verification = db.prepare(`
      SELECT * FROM brix_verifications
      WHERE user_id = ? AND code = ? AND used = 0 AND expires_at > datetime('now')
      ORDER BY created_at DESC LIMIT 1
    `).get(user.id, code);

    if (!verification) {
      return res.status(400).json({ error: 'Código inválido ou expirado' });
    }

    db.prepare('UPDATE brix_verifications SET used = 1 WHERE id = ?').run(verification.id);
    if (cleanEmail) {
      db.prepare("UPDATE brix_users SET email = ?, email_hash = ?, updated_at = datetime('now') WHERE id = ?").run(encrypt(cleanEmail), hmacHash(cleanEmail), user.id);
    }
  }

  const domain = process.env.BRIX_DOMAIN || 'brix.app';
  res.json({
    success: true,
    message: 'Contato atualizado com sucesso!',
    brix_address: `${user.username}@${domain}`,
  });
});

/**
 * POST /brix/register-push
 * Body: { fcm_token }
 * Header: x-nostr-pubkey
 * Registers/updates the FCM push token for a user.
 */
router.post('/register-push', (req, res) => {
  const pubkey = req.headers['x-nostr-pubkey'];
  const { fcm_token } = req.body;

  if (!pubkey) {
    return res.status(401).json({ error: 'Missing x-nostr-pubkey header' });
  }
  if (!fcm_token || typeof fcm_token !== 'string' || fcm_token.length < 20) {
    return res.status(400).json({ error: 'Invalid FCM token' });
  }

  const db = getDb();
  // Update FCM token for ALL users with same pubkey (handles multiple usernames)
  const result = db.prepare("UPDATE brix_users SET fcm_token = ?, updated_at = datetime('now') WHERE nostr_pubkey = ? AND verified = 1").run(fcm_token, pubkey);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'User not found' });
  }

  console.log(`[PUSH] FCM token registered for ${result.changes} user(s) with pubkey ${pubkey.slice(0, 8)}...`);
  res.json({ success: true });
});

/**
 * POST /brix/claim-web-accounts
 * Finds all web-created BRIX accounts with the same email as the caller
 * and links them to the caller's nostr pubkey.
 */
router.post('/claim-web-accounts', (req, res) => {
  const pubkey = req.headers['x-nostr-pubkey'];
  if (!pubkey) {
    return res.status(401).json({ error: 'Missing x-nostr-pubkey header' });
  }

  const db = getDb();

  // Find caller's user record to get their email_hash
  const caller = db.prepare(
    'SELECT id, email_hash FROM brix_users WHERE nostr_pubkey = ? AND verified = 1 LIMIT 1'
  ).get(pubkey);
  if (!caller || !caller.email_hash) {
    return res.json({ linked: [], count: 0 });
  }

  // Find all web-created accounts with same email that haven't been linked yet
  const webAccounts = db.prepare(
    "SELECT id, username FROM brix_users WHERE email_hash = ? AND nostr_pubkey LIKE 'web_%' AND verified = 1 AND id != ?"
  ).all(caller.email_hash, caller.id);

  if (webAccounts.length === 0) {
    return res.json({ linked: [], count: 0 });
  }

  const updateStmt = db.prepare(
    "UPDATE brix_users SET nostr_pubkey = ?, updated_at = datetime('now') WHERE id = ?"
  );

  const linked = [];
  for (const account of webAccounts) {
    updateStmt.run(pubkey, account.id);
    linked.push(account.username);
    console.log(`[BRIX] Auto-linked web account: ${account.username} -> pubkey ${pubkey.substring(0, 16)}...`);
  }

  res.json({ linked, count: linked.length });
});

module.exports = router;
