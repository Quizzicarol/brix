const db = require('/app/server/models/database');
const c = db.getDb();
const users = c.prepare("SELECT id, username, nostr_pubkey, last_seen, fcm_token IS NOT NULL as has_fcm FROM brix_users WHERE verified = 1 ORDER BY last_seen DESC").all();
console.log(JSON.stringify(users, null, 2));

// Check recent invoice requests
const reqs = c.prepare("SELECT ir.id, ir.user_id, ir.amount_sats, ir.status, ir.sender_pubkey, ir.created_at, u.username, u.nostr_pubkey FROM brix_invoice_requests ir JOIN brix_users u ON ir.user_id = u.id ORDER BY ir.created_at DESC LIMIT 20").all();
console.log("\n--- Recent Invoice Requests ---");
console.log(JSON.stringify(reqs, null, 2));
