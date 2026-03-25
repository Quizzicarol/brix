const db = require('better-sqlite3')('/data/brix.db');
const users = db.prepare("SELECT username, last_seen, fcm_token IS NOT NULL as has_fcm FROM brix_users WHERE verified=1 ORDER BY last_seen DESC LIMIT 5").all();
const now = new Date().toISOString();
console.log('NOW:', now);
users.forEach(u => {
  const age = u.last_seen ? Math.round((Date.now() - new Date(u.last_seen + 'Z').getTime()) / 1000) : 'never';
  console.log(`${u.username} | last_seen=${u.last_seen} | age=${age}s | fcm=${u.has_fcm}`);
});
const reqs = db.prepare("SELECT id, amount_sats, status, created_at, updated_at FROM brix_invoice_requests ORDER BY created_at DESC LIMIT 10").all();
console.log('\nRecent invoice requests:');
reqs.forEach(r => console.log(`${r.id.substring(0,8)} | ${r.amount_sats} sats | ${r.status} | ${r.created_at}`));
