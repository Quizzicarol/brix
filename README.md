# ⚡ BRIX — Lightning Address for Everyone

<p align="center">
  <img src="https://img.shields.io/badge/Bitcoin-Lightning-orange?style=for-the-badge&logo=bitcoin" alt="Bitcoin Lightning" />
  <img src="https://img.shields.io/badge/Nostr-Protocol-purple?style=for-the-badge" alt="Nostr" />
  <img src="https://img.shields.io/badge/Open_Source-MIT-green?style=for-the-badge" alt="MIT License" />
</p>

**BRIX** is a Lightning Address service that lets anyone receive Bitcoin instantly using a simple, human-readable address — like email, but for money.

> `yourname@brix.brostr.app` → Receive sats instantly, anywhere in the world.

---

## 🚀 What is BRIX?

BRIX gives every user a **Lightning Address** — a simple identifier (like `alice@brix.brostr.app`) that anyone can use to send Bitcoin via the Lightning Network.

No complicated invoices. No QR codes. Just a name.

### How it works

1. **Choose your username** → Pick a unique name like `alice`
2. **Verify your contact** → Confirm via SMS or email
3. **Done!** → Your Lightning Address `alice@brix.brostr.app` is active

Now anyone can send you sats using just your address — from any Lightning wallet that supports [LNURL-pay](https://github.com/lnurl/luds).

---

## ✨ Features

- ⚡ **Instant payments** — Receive Bitcoin in seconds via Lightning Network
- 📧 **Human-readable addresses** — `yourname@brix.brostr.app` instead of long invoices
- 🔒 **Verified accounts** — SMS or email verification ensures real ownership
- 🌐 **Universal compatibility** — Works with any wallet that supports Lightning Addresses (Wallet of Satoshi, Phoenix, Zeus, Breez, BlueWallet, and more)
- 📱 **Mobile app integration** — Built into the [Bro App](https://github.com/brostr/bro_app) for seamless experience
- 🌍 **Web registration** — Create your BRIX at [brix.brostr.app](https://brix.brostr.app)
- 🔑 **Nostr-native** — Linked to your Nostr identity for decentralized authentication
- 🌎 **Multi-language** — Available in Portuguese, English, and Spanish

---

## 📱 For Users

### Get your BRIX

**Option 1 — Via the Bro App:**
1. Open the Bro App
2. Go to the BRIX tab
3. Enter your phone or email
4. Choose your username
5. Verify with the code sent to you
6. Start receiving sats!

**Option 2 — Via the website:**
1. Visit [brix.brostr.app](https://brix.brostr.app)
2. Choose cell phone or email
3. Pick your username
4. Verify and activate

### Receive payments

Share your address with anyone:

```
yourname@brix.brostr.app
```

They can paste it in any Lightning wallet and send you sats instantly.

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

- **BRIX Server** — Node.js + Express + SQLite
- **LNURL-pay** — Implements [LUD-16](https://github.com/lnurl/luds/blob/luds/16.md) for Lightning Address resolution
- **Verification** — SMS via Twilio Verify API, email via SMTP/Nodemailer
- **Hosting** — Deployed on [Fly.io](https://fly.io)

---

## 🛠️ Self-hosting

Want to run your own BRIX server with a custom domain?

### Prerequisites

- Node.js 20+
- A domain name
- (Optional) Twilio account for SMS verification
- (Optional) SMTP credentials for email verification

### Setup

```bash
git clone https://github.com/brostr/brix.git
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

## 🤝 Part of the Bro Ecosystem

BRIX is the Lightning Address layer of the **Bro** ecosystem — a privacy-focused Bitcoin trading platform built on Nostr.

- **Bro App** — P2P Bitcoin trading (buy/sell via Pix, bank transfer, etc.)
- **BRIX** — Lightning Addresses for instant payments
- **Nostr** — Decentralized identity and communication

---

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

---

<p align="center">
  <strong>⚡ Get your BRIX today at <a href="https://brix.brostr.app">brix.brostr.app</a></strong>
</p>
