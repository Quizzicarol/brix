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

  console.log('BRIX database initialized');
}

module.exports = { getDb, initialize };
