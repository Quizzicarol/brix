const db = require('better-sqlite3')('/data/brix.db');
const pp = db.prepare("SELECT id, amount_sats, status, server_invoice IS NOT NULL as has_invoice, created_at FROM brix_pending_payments ORDER BY created_at DESC LIMIT 10").all();
console.log('Pending payments:');
pp.forEach(p => console.log(`${p.id.substring(0,8)} | ${p.amount_sats} sats | ${p.status} | invoice=${p.has_invoice} | ${p.created_at}`));
