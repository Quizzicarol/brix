# ⚡ BRIX — Receive Bitcoin with your phone number or email

<p align="center">
  <img src="https://img.shields.io/badge/Bitcoin-Lightning-orange?style=for-the-badge&logo=bitcoin" alt="Bitcoin Lightning" />
  <img src="https://img.shields.io/badge/Open_Source-MIT-green?style=for-the-badge" alt="MIT License" />
</p>

**BRIX** lets people receive Bitcoin using information they already know by heart — their phone number or email address. No new addresses to memorize, no QR codes to share, no invoices to generate.

> Your phone. Your email. Your Bitcoin.

---

## The Problem

Receiving Bitcoin on Lightning usually requires generating invoices, scanning QR codes, or sharing long addresses that no one can remember. These are technical barriers that keep normal people away from using Bitcoin in daily life.

## The Solution

BRIX maps **your phone number or email** — things you already use every day — to a Lightning payment endpoint. When someone wants to send you sats, they just need the contact info you already share with everyone.

### How it works

1. **Register with your phone or email** — the info you already know
2. **Verify ownership** — a one-time code confirms it's really yours
3. **Receive Bitcoin** — anyone can now send you sats using your contact info, from any Lightning wallet

No new identifiers to learn. No addresses to bookmark. Just the phone number or email you already give to people.

---

## ✨ Features

- ⚡ **Instant** — Receive Bitcoin in seconds via Lightning Network
- 📱 **Use what you already know** — Your phone number or email becomes your payment address
- 🔒 **Verified ownership** — SMS or email code ensures only you can register your contact info
- 🌐 **Universal** — Works with any wallet that supports Lightning Addresses (Phoenix, Zeus, BlueWallet, Wallet of Satoshi, Breez, and more)
- 🌍 **Web + App** — Register at [brix.brostr.app](https://brix.brostr.app) or inside the [Bro App](https://www.brostr.app/#brix)
- 🌎 **Multi-language** — Portuguese, English, and Spanish

---

## Getting Started

### Register

**Option 1 — Website:**
1. Visit [brostr.app/#brix](https://www.brostr.app/#brix)
2. Enter your phone number or email
3. Pick a username
4. Enter the verification code you receive
5. Done — start receiving Bitcoin

**Option 2 — Bro App:**
1. Open the Bro App → BRIX tab
2. Same flow — phone or email, username, verify

### Receiving payments

Anyone can send you sats from any Lightning wallet. They just use the address BRIX generates from your registration (e.g., `username@brix.brostr.app`).

---

## Integration

BRIX is designed as a standalone service that any app can integrate. It implements [LUD-16](https://github.com/lnurl/luds/blob/luds/16.md) (Lightning Address) and exposes a simple REST API for registration and verification.

Currently integrated with the [Bro App](https://www.brostr.app/#brix), but any application can connect to a BRIX server to offer Lightning Address services to its users.

---

## 🏗️ Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────┐
│  Bro App    │────▶│   BRIX Server    │◀────│  Web Client  │
│  (Flutter)  │     │   (Node.js)      │     │  (HTML/CSS)  │
└─────────────┘     └──────────────────┘     └──────────────┘
                           │
                    ┌──────┴───────┐
                    │              │
              ┌─────▼─────┐ ┌─────▼─────┐
              │  Twilio   │ │   SMTP    │
              │  Verify   │ │  (Email)  │
              │  (SMS)    │ │           │
              └───────────┘ └───────────┘
```

- **Server** — Node.js + Express + SQLite
- **LNURL-pay** — [LUD-16](https://github.com/lnurl/luds/blob/luds/16.md) for Lightning Address resolution
- **Verification** — SMS via Twilio Verify API, email via SMTP/Nodemailer
- **Hosting** — Deployed on [Fly.io](https://fly.io)

---

## 🛠️ Self-hosting

Run your own BRIX server with a custom domain.

### Prerequisites

- Node.js 20+
- A domain name
- (Optional) Twilio account for SMS verification
- (Optional) SMTP credentials for email verification

### Setup

```bash
git clone https://github.com/Quizzicarol/brix.git
cd brix/server
cp .env.example .env
# Edit .env with your configuration
npm install
npm start
```

### Environment Variables

| Variable | Description |
|---|---|
| `PORT` | Server port (default: 3000) |
| `BRIX_DOMAIN` | Your domain (e.g., `brix.yourdomain.com`) |
| `SMTP_HOST` | SMTP server for email verification |
| `SMTP_USER` | SMTP username |
| `SMTP_PASS` | SMTP password |
| `TWILIO_ACCOUNT_SID` | Twilio Account SID for SMS |
| `TWILIO_AUTH_TOKEN` | Twilio Auth Token |
| `TWILIO_VERIFY_SID` | Twilio Verify Service SID |

---

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

<p align="center">
  <strong>⚡ Get your BRIX today at <a href="https://brix.brostr.app">brix.brostr.app</a></strong>
</p>
