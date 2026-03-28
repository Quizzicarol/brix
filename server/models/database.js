const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'brix.db');
let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function initialize() {
  const conn = getDb();

  conn.exec(`
    CREATE TABLE IF NOT EXISTS brix_users (
      id          TEXT PRIMARY KEY,
      username    TEXT UNIQUE NOT NULL,
      phone       TEXT,
      email       TEXT,
      nostr_pubkey TEXT NOT NULL,
      verified    INTEGER DEFAULT 0,
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS brix_verifications (
      id          TEXT PRIMARY KEY,
      user_id     TEXT REFERENCES brix_users(id),
      code        TEXT NOT NULL,
      type        TEXT NOT NULL CHECK(type IN ('sms', 'email')),
      destination TEXT NOT NULL,
      expires_at  TEXT NOT NULL,
      used        INTEGER DEFAULT 0,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS brix_pending_payments (
      id              TEXT PRIMARY KEY,
      user_id         TEXT REFERENCES brix_users(id),
      amount_sats     INTEGER NOT NULL,
      payment_hash    TEXT NOT NULL,
      status          TEXT DEFAULT 'received' CHECK(status IN ('pending_payment', 'received', 'claiming', 'forwarding', 'forwarded', 'expired')),
      sender_note     TEXT,
      server_invoice  TEXT,
      server_payment_hash TEXT,
      fee_sats        INTEGER DEFAULT 0,
      net_amount_sats INTEGER,
      created_at      TEXT DEFAULT (datetime('now')),
      forwarded_at    TEXT,
      forward_hash    TEXT
    );

    CREATE TABLE IF NOT EXISTS brix_invoice_requests (
      id          TEXT PRIMARY KEY,
      user_id     TEXT REFERENCES brix_users(id),
      amount_sats INTEGER NOT NULL,
      status      TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'ready', 'completed', 'expired')),
      invoice     TEXT,
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS brix_fee_transactions (
      id                  TEXT PRIMARY KEY,
      request_id          TEXT,
      user_id             TEXT REFERENCES brix_users(id),
      gross_amount_sats   INTEGER NOT NULL,
      fee_sats            INTEGER NOT NULL,
      net_amount_sats     INTEGER NOT NULL,
      fee_rate            REAL NOT NULL,
      server_invoice      TEXT,
      server_payment_hash TEXT,
      preimage            TEXT,
      recipient_invoice   TEXT,
      status              TEXT DEFAULT 'pending'
                          CHECK(status IN ('pending','paid','held','forwarding','forwarded','cancelled','failed','expired')),
      forward_attempts    INTEGER DEFAULT 0,
      forward_hash        TEXT,
      error               TEXT,
      created_at          TEXT DEFAULT (datetime('now')),
      paid_at             TEXT,
      forwarded_at        TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_users_username ON brix_users(username);
    CREATE INDEX IF NOT EXISTS idx_users_pubkey ON brix_users(nostr_pubkey);
    CREATE INDEX IF NOT EXISTS idx_pending_user ON brix_pending_payments(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_pending_hash ON brix_pending_payments(payment_hash);
    CREATE INDEX IF NOT EXISTS idx_fee_status ON brix_fee_transactions(status);
    CREATE INDEX IF NOT EXISTS idx_fee_server_hash ON brix_fee_transactions(server_payment_hash);
  `);

  // Migration: add last_seen column to brix_users for relay activity tracking
  try {
    const usersInfo = conn.prepare(`SELECT sql FROM sqlite_master WHERE name = 'brix_users'`).get();
    if (usersInfo && usersInfo.sql && !usersInfo.sql.includes('last_seen')) {
      console.log('[DB] Migrating brix_users: adding last_seen column...');
      conn.exec(`ALTER TABLE brix_users ADD COLUMN last_seen TEXT`);
      console.log('[DB] Migration complete: last_seen added');
    }
  } catch (e) { /* column may already exist */ }

  // Migration: add server wallet columns to brix_pending_payments for offline payments
  try {
    const ppInfo = conn.prepare(`SELECT sql FROM sqlite_master WHERE name = 'brix_pending_payments'`).get();
    if (ppInfo && ppInfo.sql && !ppInfo.sql.includes('server_invoice')) {
      console.log('[DB] Migrating brix_pending_payments: adding offline payment columns...');
      conn.exec(`
        ALTER TABLE brix_pending_payments RENAME TO brix_pending_payments_old;

        CREATE TABLE brix_pending_payments (
          id              TEXT PRIMARY KEY,
          user_id         TEXT REFERENCES brix_users(id),
          amount_sats     INTEGER NOT NULL,
          payment_hash    TEXT NOT NULL,
          status          TEXT DEFAULT 'received' CHECK(status IN ('pending_payment', 'received', 'claiming', 'forwarding', 'forwarded', 'expired')),
          sender_note     TEXT,
          server_invoice  TEXT,
          server_payment_hash TEXT,
          fee_sats        INTEGER DEFAULT 0,
          net_amount_sats INTEGER,
          created_at      TEXT DEFAULT (datetime('now')),
          forwarded_at    TEXT,
          forward_hash    TEXT
        );

        INSERT INTO brix_pending_payments (id, user_id, amount_sats, payment_hash, status, sender_note, created_at, forwarded_at, forward_hash)
        SELECT id, user_id, amount_sats, payment_hash, status, sender_note, created_at, forwarded_at, forward_hash
        FROM brix_pending_payments_old;

        DROP TABLE brix_pending_payments_old;

        CREATE INDEX IF NOT EXISTS idx_pending_user ON brix_pending_payments(user_id, status);
        CREATE INDEX IF NOT EXISTS idx_pending_hash ON brix_pending_payments(payment_hash);
        CREATE INDEX IF NOT EXISTS idx_pending_server_hash ON brix_pending_payments(server_payment_hash);
      `);
      console.log('[DB] Migration complete');
    }
  } catch (migrationErr) {
    // Table might not exist yet (fresh install)
  }

  // Migration: add 'paid' and 'failed' statuses to existing brix_fee_transactions
  try {
    const tableInfo = conn.prepare(`SELECT sql FROM sqlite_master WHERE name = 'brix_fee_transactions'`).get();
    if (tableInfo && tableInfo.sql && !tableInfo.sql.includes("'paid'")) {
      console.log('[DB] Migrating brix_fee_transactions: adding paid/failed statuses...');
      conn.exec(`
        ALTER TABLE brix_fee_transactions RENAME TO brix_fee_transactions_old;

        CREATE TABLE brix_fee_transactions (
          id                  TEXT PRIMARY KEY,
          request_id          TEXT,
          user_id             TEXT REFERENCES brix_users(id),
          gross_amount_sats   INTEGER NOT NULL,
          fee_sats            INTEGER NOT NULL,
          net_amount_sats     INTEGER NOT NULL,
          fee_rate            REAL NOT NULL,
          server_invoice      TEXT,
          server_payment_hash TEXT,
          preimage            TEXT,
          recipient_invoice   TEXT,
          status              TEXT DEFAULT 'pending'
                              CHECK(status IN ('pending','paid','held','forwarding','forwarded','cancelled','failed','expired')),
          forward_attempts    INTEGER DEFAULT 0,
          forward_hash        TEXT,
          error               TEXT,
          created_at          TEXT DEFAULT (datetime('now')),
          paid_at             TEXT,
          forwarded_at        TEXT
        );

        INSERT INTO brix_fee_transactions SELECT * FROM brix_fee_transactions_old;
        DROP TABLE brix_fee_transactions_old;

        CREATE INDEX IF NOT EXISTS idx_fee_status ON brix_fee_transactions(status);
        CREATE INDEX IF NOT EXISTS idx_fee_server_hash ON brix_fee_transactions(server_payment_hash);
      `);
      console.log('[DB] Migration complete');
    }
  } catch (migrationErr) {
    // Table might not exist yet (fresh install), ignore
  }

  // Create indexes that depend on migrated columns (safe to run after migrations)
  try {
    conn.exec(`CREATE INDEX IF NOT EXISTS idx_pending_server_hash ON brix_pending_payments(server_payment_hash);`);
  } catch (_) {
    // Index may already exist
  }

  // Migration: add fcm_token column to brix_users for push notifications
  try {
    const usersInfo = conn.prepare(`SELECT sql FROM sqlite_master WHERE name = 'brix_users'`).get();
    if (usersInfo && usersInfo.sql && !usersInfo.sql.includes('fcm_token')) {
      console.log('[DB] Migrating brix_users: adding fcm_token column...');
      conn.exec(`ALTER TABLE brix_users ADD COLUMN fcm_token TEXT;`);
      console.log('[DB] Migration complete: fcm_token added');
    }
  } catch (migrationErr) {
    // Column may already exist
  }

  // Migration: add phone_hash/email_hash for encrypted PII lookups + encrypt existing data
  try {
    const usersInfo2 = conn.prepare(`SELECT sql FROM sqlite_master WHERE name = 'brix_users'`).get();
    if (usersInfo2 && usersInfo2.sql && !usersInfo2.sql.includes('phone_hash')) {
      console.log('[DB] Migrating brix_users: adding phone_hash/email_hash columns...');
      conn.exec(`ALTER TABLE brix_users ADD COLUMN phone_hash TEXT`);
      conn.exec(`ALTER TABLE brix_users ADD COLUMN email_hash TEXT`);
      conn.exec(`CREATE INDEX IF NOT EXISTS idx_users_phone_hash ON brix_users(phone_hash)`);
      conn.exec(`CREATE INDEX IF NOT EXISTS idx_users_email_hash ON brix_users(email_hash)`);
      console.log('[DB] Migration complete: phone_hash/email_hash added');

      // Encrypt existing plaintext phone/email data
      const { encrypt, hmacHash } = require('../services/encryption');
      const users = conn.prepare('SELECT id, phone, email FROM brix_users WHERE phone IS NOT NULL OR email IS NOT NULL').all();
      const updateStmt = conn.prepare('UPDATE brix_users SET phone = ?, phone_hash = ?, email = ?, email_hash = ? WHERE id = ?');
      for (const u of users) {
        updateStmt.run(
          encrypt(u.phone), hmacHash(u.phone),
          encrypt(u.email), hmacHash(u.email),
          u.id
        );
      }
      if (users.length > 0) console.log(`[DB] Encrypted PII for ${users.length} existing users`);
    }
  } catch (migrationErr) {
    console.error('[DB] PII encryption migration error:', migrationErr.message);
  }

  // Migration: add sender_pubkey column to brix_invoice_requests
  // Prevents self-invoicing when sender and recipient share the same nostr pubkey
  try {
    const irInfo = conn.prepare(`SELECT sql FROM sqlite_master WHERE name = 'brix_invoice_requests'`).get();
    if (irInfo && irInfo.sql && !irInfo.sql.includes('sender_pubkey')) {
      console.log('[DB] Migrating brix_invoice_requests: adding sender_pubkey column...');
      conn.exec(`ALTER TABLE brix_invoice_requests ADD COLUMN sender_pubkey TEXT`);
      console.log('[DB] Migration complete: sender_pubkey added');
    }
  } catch (e) { /* column may already exist */ }

  // Migration: add comment column to brix_invoice_requests for LNURL-pay comments (LUD-12)
  try {
    const irInfo2 = conn.prepare(`SELECT sql FROM sqlite_master WHERE name = 'brix_invoice_requests'`).get();
    if (irInfo2 && irInfo2.sql && !irInfo2.sql.includes('comment')) {
      console.log('[DB] Migrating brix_invoice_requests: adding comment column...');
      conn.exec(`ALTER TABLE brix_invoice_requests ADD COLUMN comment TEXT`);
      console.log('[DB] Migration complete: comment added');
    }
  } catch (e) { /* column may already exist */ }

  console.log('BRIX database initialized');
}

module.exports = { getDb, initialize };
