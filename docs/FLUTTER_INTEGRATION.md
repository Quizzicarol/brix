# BRIX — Flutter Integration Plan

## Novos arquivos no Bro App

### 1. `lib/services/brix_service.dart`
Serviço que comunica com o servidor BRIX.

```dart
class BrixService {
  final String baseUrl; // BRIX_SERVER_URL from env
  
  // Registro
  Future<RegisterResult> register(String identifier, String type, String rawValue);
  Future<VerifyResult> verify(String userId, String code);
  
  // Sync
  Future<List<PendingPayment>> getPendingPayments();
  Future<ClaimResult> claimPayment(String paymentId, String invoice);
  
  // Info
  Future<String?> getBrixAddress();
}
```

### 2. `lib/screens/brix/brix_registration_screen.dart`
Tela de registro com phone/email.

```
┌─────────────────────────────┐
│  🟠 Ative seu BRIX          │
│                              │
│  Receba Bitcoin pelo celular │
│  ou email, mesmo offline!    │
│                              │
│  ○ Telefone  ○ Email         │
│                              │
│  ┌──────────────────────┐   │
│  │ +55 11 99988-7766    │   │
│  └──────────────────────┘   │
│                              │
│  [ Ativar BRIX ]             │
│                              │
│  Seu endereço será:          │
│  5511999887766@brix.app      │
└─────────────────────────────┘
```

### 3. `lib/screens/brix/brix_verify_screen.dart`
Tela de verificação do código.

```
┌─────────────────────────────┐
│  Verificação                 │
│                              │
│  Enviamos um código para:    │
│  +55 11 99988-7766           │
│                              │
│  ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐
│  │4 │ │8 │ │2 │ │9 │ │1 │ │7 │
│  └──┘ └──┘ └──┘ └──┘ └──┘ └──┘
│                              │
│  [ Verificar ]               │
│                              │
│  Reenviar código (45s)       │
└─────────────────────────────┘
```

### 4. `lib/widgets/brix_badge.dart`
Badge que mostra o BRIX address no perfil.

```
┌─────────────────────────────────┐
│ ⚡ 5511999887766@brix.app       │
│ Seu endereço BRIX está ativo    │
└─────────────────────────────────┘
```

## Integração no fluxo existente

### Auto-claim ao abrir app
Em `main.dart` ou no `BreezProvider`, após inicializar wallet:

```dart
// After wallet sync
final brixService = BrixService(baseUrl: env.BRIX_SERVER_URL);
final pending = await brixService.getPendingPayments();
for (final payment in pending) {
  // Create invoice via Breez Spark SDK
  final invoice = await breezProvider.createInvoice(payment.amountSats, 'BRIX payment');
  // Claim from BRIX server
  await brixService.claimPayment(payment.id, invoice);
}
```

### Push notifications
Quando o BRIX server recebe pagamento para um user offline:
1. Server envia push via FCM/APNs
2. App recebe push → abre → auto-claim
3. User vê notificação: "Você recebeu 100 sats via BRIX!"

### Perfil / Settings
Adicionar seção BRIX na tela de configurações:
- Ver endereço BRIX ativo
- Desativar BRIX
- Alterar phone/email

## Dependências adicionais no pubspec.yaml
Nenhuma nova dependência necessária — usa apenas http (já existente).
