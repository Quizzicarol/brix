# Copilot Instructions for BRIX Server

## CRITICAL: NEVER use LNbits
- The server uses its own Spark wallet (`@breeztech/breez-sdk-spark`)
- LNbits was removed. Do NOT re-introduce it.

## Architecture
- **wallet.js**: Server Spark wallet — createInvoice, payInvoice, checkInvoicePaid
- **payment-forward.js**: Polls for payment status changes every 3s, transitions pending_payment → received
- **brix.js**: All API endpoints with NIP-98 auth
- **lnurl.js**: LNURL callback — creates server invoices for offline recipients
- **nip98.js**: Verifies NIP-98 signed Nostr events, requires method + URL tags

## Security Rules
- `pending-payments` and `claim` require `req.verifiedPubkey` (NIP-98 strict)
- Other auth endpoints use `req.verifiedPubkey || req.headers['x-nostr-pubkey']`
- Claim validates: bolt11 format, amount matches expected, rejects 0-amount invoices
- Atomic `UPDATE WHERE status = 'received'` prevents double-spend
- `claim_failed` status on error — never revert to `received`

## Known Pitfalls
1. `paymentForward.start()` MUST be called in server.js — without it, payments stay pending forever
2. `server_invoice` column must be stored in lnurl.js when creating offline fallback
3. `checkInvoicePaid` matches by bolt11 string, not by payment hash
