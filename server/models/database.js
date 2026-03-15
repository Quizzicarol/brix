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
      status          TEXT DEFAULT 'received' CHECK(status IN ('received', 'forwarding', 'forwarded', 'expired')),
      sender_note     TEXT,
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

    CREATE INDEX IF NOT EXISTS idx_users_username ON brix_users(username);
    CREATE INDEX IF NOT EXISTS idx_users_pubkey ON brix_users(nostr_pubkey);
    CREATE INDEX IF NOT EXISTS idx_pending_user ON brix_pending_payments(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_pending_hash ON brix_pending_payments(payment_hash);
  `);

  console.log('BRIX database initialized');
}

module.exports = { getDb, initialize };
