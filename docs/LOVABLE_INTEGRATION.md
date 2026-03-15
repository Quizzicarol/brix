# BRIX — Integração no Site via Lovable

## Contexto

O site **brostr.app** é mantido no Lovable. Precisamos adicionar as seções e páginas do BRIX ao site existente.

O design deve seguir o estilo do site atual (dark theme, verde #4ade80, laranja #FF6B35). O Lovable deve cuidar do design/polish — aqui estão apenas as **orientações de conteúdo e estrutura**.

---

## 1. Alterações na Navbar

Adicionar link "⚡ BRIX" na navbar, entre os links existentes e o CTA:

```
[O que é] [Como funciona] [⚡ BRIX] [App] [Vantagens] [Criar meu BRIX]
```

- O link "⚡ BRIX" faz scroll até a seção `#brix` na home
- O botão "Criar meu BRIX" navega para `/brix` (página dedicada)
- Cor do "⚡ BRIX": usar accent laranja/amber (`#F7931A` ou `#FF8C00`)

---

## 2. Nova Seção na Home: BRIX

Inserir uma seção entre "Como funciona" e "Veja o App", com o id `#brix`.

### Conteúdo da seção:

**Badge:** `NOVO`
**Título:** `⚡ BRIX`
**Subtítulo:** `Seu número de celular ou email é seu endereço Bitcoin.`
**Descrição:** `Receba Bitcoin pelo celular ou email, mesmo offline. Quando abrir o app, o saldo já está lá. Como um PIX, mas em Bitcoin.`

### Features (3 cards):

| Ícone | Título | Descrição | Exemplo |
|-------|--------|-----------|---------|
| 📱 | Use seu Celular | Seu número de telefone vira um endereço Lightning. Qualquer pessoa pode te enviar Bitcoin digitando seu número. | `5511999887766@brix.app` |
| 📧 | Ou seu Email | Prefere email? Use como endereço Lightning. Funciona com qualquer wallet compatível. | `maria@brix.app` |
| 😴 | Receba Offline | Não precisa estar com o app aberto. Os sats ficam guardados e aparecem quando você abrir a carteira. | — |

### Como funciona (3 steps):

1. **Cadastre seu número ou email** — Informe seu celular ou email para criar seu endereço BRIX.
2. **Verifique com o código** — Receba um código de 6 dígitos via SMS ou email e confirme.
3. **Pronto! Receba Bitcoin** — Compartilhe seu endereço BRIX. Qualquer wallet Lightning pode te pagar.

### CTA:
- Botão: `⚡ Criar meu BRIX agora` → navega para `/brix`
- Sub-texto: `Grátis. Sem KYC. Sem cadastro bancário.`

### Notas de design:
- Usar accent amber/laranja para diferenciar do verde do Bro
- O badge "NOVO" pode pulsar ou ter um brilho sutil
- Os endereços de exemplo devem parecer monospace/code

---

## 3. Nova Página: `/brix` (Registro)

Página dedicada para o fluxo de registro BRIX. Tem 3 etapas visuais:

### Etapa 1 — Cadastro

**Título:** `⚡ Crie seu BRIX`
**Subtítulo:** `Receba Bitcoin pelo celular ou email`

**Formulário:**
- Campo: `Username` (ex: maria_btc) — lowercase, 3-20 chars, letras/números/_
- Toggle: `Telefone` | `Email`
- Se Telefone: input com máscara de celular brasileiro (+55 padrão)
- Se Email: input de email
- Preview em tempo real: `Seu endereço será: maria_btc@brix.brostr.app`
- Botão: `Criar meu BRIX`

**Validação em tempo real do username:**
- Enquanto digita, chamar `GET /brix/check-username/{username}` (com debounce 500ms)
- Mostrar ✅ verde se disponível, ❌ vermelho se já em uso
- Bloquear botão se username indisponível

**API call:** `POST https://brix.brostr.app/brix/register`
```json
{
  "username": "maria_btc",
  "email": "maria@email.com"
}
```
ou com telefone:
```json
{
  "username": "maria_btc",
  "phone": "+5511999887766"
}
```

**Resposta (auto-verificado):**
```json
{
  "success": true,
  "verified": true,
  "message": "BRIX criado e ativado!",
  "user_id": "uuid",
  "username": "maria_btc",
  "brix_address": "maria_btc@brix.brostr.app"
}
```

**Lógica do frontend:**
- Se `response.verified === true` → **pular Etapa 2**, ir direto para Etapa 3 (Sucesso)
- Se `response.verified === false` → mostrar Etapa 2 (verificação por código)
- Se `response.error` → mostrar erro (ex: "Este username já está em uso")

### Etapa 2 — Verificação (somente quando `verified === false`)

**Título:** `Verificação`
**Subtítulo:** `Enviamos um código para seu email/celular`

**Formulário:**
- 6 inputs de dígito (auto-avança ao digitar)
- Botão: `Verificar`
- Link: `Reenviar código` (com timer de 60s)

**API calls:**
- Verificar: `POST /brix/verify` com `{ "user_id": "...", "code": "123456" }`
- Reenviar: `POST /brix/resend` com `{ "user_id": "..." }`

### Etapa 3 — Sucesso

**Título:** `✅ BRIX Ativado!`
**Subtítulo:** `Seu endereço Lightning está pronto`

**Conteúdo:**
- Endereço BRIX grande e copiável: `maria_btc@brix.brostr.app`
- Botão copiar (clipboard API)
- Botão compartilhar (Web Share API)
- QR code do endereço

### Botões de Download do Bro App:

Após o BRIX ser criado, exibir uma seção destacada:

**Texto:** `📲 Baixe o Bro App para usar seu BRIX`
**Subtexto:** `Gerencie seu BRIX, receba pagamentos e acumule sats direto na sua carteira.`

**Botões (lado a lado):**
- 🤖 **Android** → `https://github.com/Quizzicarol/bro-releases/releases/latest/download/bro-latest.apk` (texto: "Baixar Android APK")
- 🍎 **iOS TestFlight** → `https://testflight.apple.com/join/rkHbPQ94` (texto: "TestFlight iOS")

**Estilo dos botões:**
- Botões grandes com ícone do sistema (Android/Apple)
- Cor principal amber/laranja (#F7931A)
- Hover com brilho sutil

### Layout:
- Lado esquerdo: formulário/etapas
- Lado direito: mockup de celular mostrando o app
- Mobile: empilhado (formulário em cima, mockup embaixo)

---

## 4. CTAs Adicionais

Adicionar botão "⚡ Criar meu BRIX" nos seguintes lugares:

- **Hero section**: ao lado do "Baixar o App"
- **Footer CTA section**: ao lado do "Baixar o App"
- **Navbar**: como botão CTA (já descrito acima)

---

## 5. Backend API

O BRIX tem seu próprio backend Node.js separado do backend do Bro. 

**URL de produção:** `https://brix.brostr.app`
**URL alternativa:** `https://brix.fly.dev`

### Endpoints principais:

| Método | Path | Descrição |
|--------|------|-----------|
| GET | `/health` | Health check |
| GET | `/brix/check-username/:username` | Verifica disponibilidade do username |
| POST | `/brix/register` | Registrar username + phone/email |
| POST | `/brix/verify` | Verificar código (quando `verified=false`) |
| POST | `/brix/resend` | Reenviar código |
| POST | `/brix/link-pubkey` | Vincular chave nostr a um BRIX |
| GET | `/brix/address/:pubkey` | Buscar endereço BRIX de um pubkey |
| GET | `/brix/history/:pubkey` | Histórico de pagamentos |
| GET | `/brix/pending-payments` | Pagamentos pendentes (header x-nostr-pubkey) |
| POST | `/brix/claim` | Reivindicar pagamento pendente |
| GET | `/.well-known/lnurlp/:identifier` | LNURL-pay metadata (LUD-16) |
| GET | `/lnurlp/:identifier/callback?amount=...` | Gerar invoice LNURL |

### Erros comuns:

| Código | Significado |
|--------|-------------|
| 400 | Dados inválidos (username curto, sem email/phone) |
| 409 | Username ou email/phone já em uso por outro usuário verificado |
| 404 | Usuário não encontrado |

### Headers:
- `Content-Type: application/json`

### Respostas de erro:
```json
{ "error": "mensagem de erro" }
```

---

## 6. Notas para o Lovable

- **NÃO** implementar o backend no Lovable. O backend BRIX já existe e roda separado.
- O site no Lovable é apenas o **frontend** que chama as APIs acima.
- Para testar localmente, o backend roda em `http://localhost:3100`.
- Em produção, apontar para `https://brix.brostr.app`.
- O Lovable pode usar `fetch()` para as chamadas API.
- Manter o estilo visual consistente com o resto do site brostr.app.
- O design é livre — estas instruções definem apenas conteúdo e comportamento.
