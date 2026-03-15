# BRIX — Arquitetura e Plano de Ação

## O que é o BRIX?

BRIX = "Bitcoin Real-time Internet eXchange" (ou simplesmente "Brix" como "um PIX, mas em Bitcoin").

Permite que qualquer pessoa receba Bitcoin Lightning usando seu **telefone** ou **email** como endereço, mesmo **estando offline**. Quando abrir o app, o saldo já estará lá.

Formato: `5511999887766@brix.app` ou `maria@brix.app`

---

## Análise de Viabilidade: HODL Invoices + Spark SDK 0.9.0

### O que o Spark SDK 0.9.0 oferece

O PR #620 (merged) adicionou suporte a HODL invoices:

```
- Criar invoice com payment_hash externo → HODL mode
- SSP (Spark Service Provider) segura o HTLC até:
  - claim_htlc_payment(preimage) → sats vão pro receiver
  - ou HTLC expira → sats voltam pro payer
- Novos campos: htlc_details com SparkHtlcStatus
- Filtro: PaymentDetailsFilter::Lightning com htlc_status
```

### O Problema: HODL Invoices NÃO servem para offline infinito

HODL invoices seguram o HTLC por tempo **limitado** (~1-24h dependendo da rota). Depois disso, o pagamento expira e o payer é reembolsado. Isso funciona para:
- ✅ Usuário offline por algumas horas
- ❌ Usuário offline por dias/semanas

### Solução: Servidor BRIX com Custódia Temporária

A maioria dos provedores de Lightning Address (Coinos, WoS, Alby, Strike) usa **custódia temporária** — o servidor recebe os sats e quando o usuário abre o app, faz o forward para a wallet self-custodial do usuário.

**É assim que funciona a maioria dos serviços de LN Address no mercado.** Não existe solução 100% self-custodial para recebimento offline.

---

## Arquitetura Final

```
┌──────────────────────────────────────────────────────────────┐
│                 PAGADOR (qualquer wallet Lightning)           │
│                                                               │
│  Digita: 5511999887766@brix.app                               │
│  Wallet resolve via LNURL-pay (LUD-16)                        │
└───────────────┬───────────────────────────────────────────────┘
                │
                │ 1. GET https://brix.app/.well-known/lnurlp/5511999887766
                │ 2. GET callback?amount=50000 (50k msats = 50 sats)
                ▼
┌──────────────────────────────────────────────────────────────┐
│                    SERVIDOR BRIX                              │
│                                                               │
│  Componentes:                                                 │
│  ├── LNURL Server (Express.js)                                │
│  │   ├── .well-known/lnurlp/:identifier → metadata           │
│  │   └── /callback?amount=X → gera invoice                   │
│  │                                                            │
│  ├── Spark SDK Wallet (Rust/Node)                             │
│  │   └── Wallet do servidor que RECEBE os pagamentos          │
│  │                                                            │
│  ├── Banco de Dados                                           │
│  │   ├── users (identifier, type, verified, pubkey)           │
│  │   ├── pending_payments (user_id, amount, hash, status)     │
│  │   └── verifications (code, type, expires_at)               │
│  │                                                            │
│  ├── Verification Service                                     │
│  │   ├── SMS (Twilio ou similar)                              │
│  │   └── Email (SendGrid ou similar)                          │
│  │                                                            │
│  └── Forward Service                                          │
│      └── Quando user abre app → paga invoice do user          │
│                                                               │
└───────────────┬───────────────────────────────────────────────┘
                │
                │ 3. User abre o app
                │ 4. App cria invoice via Breez Spark SDK
                │ 5. Servidor paga o invoice → sats na wallet do user
                ▼
┌──────────────────────────────────────────────────────────────┐
│               USUÁRIO (Bro App / Flutter)                      │
│                                                               │
│  ├── Registra telefone/email no BRIX                          │
│  ├── Verifica via SMS/Email (código 6 dígitos)                │
│  ├── Ao abrir app: sync com BRIX server                       │
│  │   ├── Busca pagamentos pendentes                           │
│  │   ├── Cria invoice para cada pendente                      │
│  │   └── Recebe sats → balanço atualizado                    │
│  └── Breez Spark SDK (self-custodial wallet)                  │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

---

## Fluxo Detalhado

### 1. Registro

```
User abre Bro App → Tela BRIX → Escolhe: Telefone ou Email
  → Digita número/email
  → Server envia código 6 dígitos via SMS/Email
  → User digita código
  → Server confirma: "5511999887766@brix.app ativado!"
  → Server armazena: {identifier, nostr_pubkey, verified: true}
```

### 2. Recebendo Pagamento (user offline)

```
Pagador digita "5511999887766@brix.app" na sua wallet
  → Wallet busca: GET https://brix.app/.well-known/lnurlp/5511999887766
  → Resposta: {callback, minSendable, maxSendable, metadata}
  → Wallet pede invoice: GET callback?amount=100000 (100 sats em msats)
  → BRIX Server:
      1. Cria invoice na wallet do servidor via Spark SDK
      2. Registra pending_payment: {user, amount: 100, hash, status: "held"}
      3. Retorna: {pr: "lnbc1000n1...", routes: []}
  → Pagador paga o invoice
  → Server recebe evento PaymentSucceeded
  → Server atualiza: pending_payment.status = "received"
  → (Opcionalmente) Server envia push notification pro user
```

### 3. User Abre o App (settlement)

```
User abre Bro App
  → App faz: GET /brix/pending-payments (autenticado via NIP-98)
  → Server retorna: [{amount: 100, from: "anonimo", created_at: ...}]
  → Para cada pagamento pendente:
      1. App cria invoice de 100 sats via Breez Spark SDK local
      2. App envia invoice pro servidor: POST /brix/claim {invoice}
      3. Servidor paga o invoice usando sua wallet
      4. App recebe os sats → balanço atualizado
      5. Server marca: pending_payment.status = "forwarded"
  → UI mostra: "Você recebeu 100 sats via BRIX! 🎉"
```

---

## Onde entram os HODL Invoices?

Os HODL invoices do Spark SDK 0.9.0 são úteis em duas situações:

### A. Rate-limiting e anti-fraude
O servidor pode criar HODL invoices ao invés de invoices normais. Isso permite:
- Segurar o pagamento por até ~1h
- Verificar se o pagador é legítimo antes de settlar
- Cancelar pagamentos suspeitos (HTLC expira, payer é reembolsado)

### B. Modo online (device bridge)
Se o user está online no momento do pagamento:
1. Server recebe request
2. Server cria HODL invoice na wallet do servidor
3. Envia push pro device do user
4. Device cria invoice real
5. Servidor paga device invoice, depois claim HODL → swap atômico
6. Zero custódia nesse caso!

### C. Pool de invoices pré-gerados
User pode pré-gerar HODL invoices enquanto online:
1. App cria N invoices com preimage que só o device conhece
2. Envia pro servidor
3. Servidor serve esses invoices quando recebe pagamentos
4. User abre app → claim_htlc_payment(preimage) → sats vão direto
5. Limitação: expira em ~24h, precisa renovar periodicamente

**Recomendação: Usar custódia temporária como base + HODL para anti-fraude e modo online.**

---

## Stack Técnica

| Componente | Tecnologia | Justificativa |
|------------|-----------|---------------|
| Servidor BRIX | Node.js + Express | Mesmo stack do backend Bro |
| Spark SDK Server | breez-sdk-spark (Rust ou Node bindings) | Para gerar invoices e pagar |
| Banco de dados | SQLite (dev) → PostgreSQL (prod) | Simples, escalável |
| SMS Verification | Twilio Verify API | Robusto, global, ~$0.05/SMS |
| Email Verification | SendGrid ou Nodemailer + SMTP | Gratuito em baixo volume |
| Push Notifications | FCM + APNs (já existe no Bro app) | Reusar infra existente |
| Domínio | brix.app ou brix.bro.app | Precisa HTTPS (obrigatório) |
| Flutter (app) | Tela BRIX dentro do Bro app | Serviço + UI |

---

## Modelo de Dados

```sql
-- Usuários BRIX
CREATE TABLE brix_users (
    id          TEXT PRIMARY KEY,           -- UUID
    identifier  TEXT UNIQUE NOT NULL,       -- "5511999887766" ou "maria"
    type        TEXT NOT NULL,              -- "phone", "email", "username"
    raw_value   TEXT NOT NULL,              -- "+5511999887766" ou "maria@gmail.com"
    nostr_pubkey TEXT NOT NULL,             -- hex pubkey do Nostr (identifica o user)
    verified    BOOLEAN DEFAULT FALSE,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Códigos de verificação
CREATE TABLE brix_verifications (
    id          TEXT PRIMARY KEY,
    user_id     TEXT REFERENCES brix_users(id),
    code        TEXT NOT NULL,              -- "482917"
    type        TEXT NOT NULL,              -- "sms" ou "email"
    destination TEXT NOT NULL,              -- "+5511999887766" ou "maria@gmail.com"
    expires_at  DATETIME NOT NULL,
    used        BOOLEAN DEFAULT FALSE,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Pagamentos pendentes (custódia temporária)
CREATE TABLE brix_pending_payments (
    id              TEXT PRIMARY KEY,
    user_id         TEXT REFERENCES brix_users(id),
    amount_sats     INTEGER NOT NULL,
    payment_hash    TEXT NOT NULL,
    status          TEXT DEFAULT 'received', -- received, forwarding, forwarded, expired
    sender_note     TEXT,                    -- comentário do pagador (LNURL-pay)
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    forwarded_at    DATETIME,
    forward_hash    TEXT                     -- hash do pagamento de forward pro user
);
```

---

## Endpoints da API

### LNURL (público, padrão LUD-16)
```
GET  /.well-known/lnurlp/:identifier     → LNURL-pay metadata
GET  /lnurlp/:identifier/callback        → Gera invoice (query: amount em msats)
```

### App (autenticado via NIP-98)
```
POST /brix/register                       → Registra phone/email
POST /brix/verify                         → Confirma código SMS/email
GET  /brix/pending-payments               → Lista pagamentos pendentes
POST /brix/claim                          → Envia invoice para receber sats
GET  /brix/history                        → Histórico de recebimentos
GET  /brix/address                        → Retorna endereço BRIX do user
```

---

## Plano de Ação (Fases)

### Fase 1 — Servidor LNURL + Spark Wallet (MVP)
- [ ] Configurar Spark SDK no servidor (Node.js bindings ou processo separado)
- [ ] Implementar .well-known/lnurlp endpoint
- [ ] Implementar callback (gera invoice no server wallet)
- [ ] Receber pagamentos e registrar em pending_payments
- [ ] API de claim: user envia invoice → server paga
- [ ] Testar com wallet externa (Phoenix, Zeus, etc.)

### Fase 2 — Verificação SMS/Email
- [ ] Integrar Twilio Verify API para SMS
- [ ] Integrar email verification (SendGrid ou SMTP)
- [ ] Endpoint de registro com rate-limiting
- [ ] Mapeamento phone/email → identifier no LNURL

### Fase 3 — Integração no Bro App (Flutter)
- [ ] Tela de registro BRIX (phone ou email)
- [ ] Tela de digitação do código de verificação
- [ ] Serviço brix_service.dart (registro, sync, claim)
- [ ] Auto-claim ao abrir app (sync pagamentos pendentes)
- [ ] Mostrar "Seu BRIX: +5511...@brix.app" no perfil
- [ ] Notificação push quando recebe pagamento

### Fase 4 — HODL invoices para modo online
- [ ] Atualizar breez_sdk_spark_flutter para 0.9.0+
- [ ] Quando user está online: device bridge com HODL (zero custódia)
- [ ] Pool de invoices pré-gerados (claim_htlc_payment)
- [ ] Fallback para custódia temporária quando offline

### Fase 5 — Domínio e produção
- [ ] Adquirir domínio (brix.app ou similar)
- [ ] Deploy servidor (VPS, Railway, Fly.io)
- [ ] SSL/HTTPS (obrigatório para LNURL)
- [ ] Monitoramento e alertas

---

## Custos Estimados

| Item | Custo |
|------|-------|
| Domínio brix.app | ~$15/ano |
| VPS (servidor BRIX) | ~$5-20/mês |
| Twilio SMS (por verificação) | ~$0.05/SMS |
| SendGrid (email) | Grátis até 100/dia |
| Breez API key | Já temos |
| Liquidez inicial (wallet servidor) | Depende do volume |

---

## Riscos e Mitigações

| Risco | Mitigação |
|-------|-----------|
| Custódia temporária regulatória | Limitar valor máximo por transação; disclosure claro; auto-forward ASAP |
| Servidor fora do ar | Monitoramento; fallback para recebimento direto via Spark |
| Liquidez insuficiente no servidor | Alertas de saldo baixo; recarregar automaticamente |
| Spam/abuso de SMS | Rate limiting; captcha; custo do SMS desincentiva |
| Roubo da wallet do servidor | HSM ou secure enclave; backup de mnemonic; cold storage |

---

## Resposta: É possível fazer como pedido?

**SIM**, com uma ressalva importante:

✅ **Receber bitcoin por telefone/email** → Totalmente possível via Lightning Address (LUD-16)
✅ **Verificação SMS/Email** → Twilio + SendGrid
✅ **Receber offline** → Sim, via custódia temporária no servidor
✅ **"Abrir carteira e saldo tá lá"** → Sim, auto-claim ao abrir app
⚠️ **100% self-custodial offline** → Impossível no Lightning atual. Sats ficam no servidor até user abrir o app. Todos os provedores de LN Address (WoS, Strike, Coinos) funcionam assim.

Os HODL invoices do Spark 0.9.0 ajudam quando o user está **online** (zero custódia) e como mecanismo de **anti-fraude**, mas não eliminam a custódia temporária para offline.
