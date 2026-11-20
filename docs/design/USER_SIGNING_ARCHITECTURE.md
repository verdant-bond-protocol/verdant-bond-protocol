# User Signing Architecture — Design Document

**Status**: Design Phase  
**Priority**: Critical Security Issue  
**Scope**: API architecture refactor to enable per-user wallet signing

---

## Problem Statement

The current API implementation signs all user-authorization-required contract transactions (e.g., `subscribe()`, `transfer()`, `listBondTokens()`) with **shared process secret keys** (`INVESTOR_SECRET_KEY`, `ADMIN_SECRET_KEY`), regardless of which user initiated the action.

### Why This Is Critical

1. **Authorization Bypass**: Contract functions call `.require_auth(user_address)`, which checks that the transaction is signed by the user's keypair. Using a shared key violates this check — it's technically invalid.

2. **Custodial Control**: The API holds a single key that can act on behalf of all users. In production, this means:
   - The API operator has unilateral control over all user funds
   - Any compromise of `INVESTOR_SECRET_KEY` compromises all investor positions
   - No per-user audit trail of who authorized what action

3. **Non-Functional for Multisig/KYC**: If the system ever requires user-specific KYC, multisig, or hardware wallet integration, this architecture cannot support it.

4. **Regulatory Risk**: Many jurisdictions require proof that the account holder (not a custodian) authorized a transaction. This architecture fails that requirement.

---

## Proposed Solution: Unsigned Transaction → Client Signing → Submission

### High-Level Flow

```
1. Frontend calls API endpoint with action (e.g., POST /bonds/:id/subscribe)
   └─ API builds an UNSIGNED transaction XDR
   └─ Returns XDR + metadata to frontend

2. Frontend receives unsigned XDR
   └─ Prompts user to sign via Freighter (or other wallet)
   └─ User's wallet signs with user's keypair
   └─ Signed XDR returned to frontend

3. Frontend submits signed XDR back to API (or directly to Soroban RPC)
   └─ API validates nonce, simulates, prepares, and submits
   └─ OR frontend submits directly to Soroban RPC (optional)
   └─ Returns result to frontend
```

### Benefits

✅ **Per-user authorization** — Each transaction is signed by the user's own key  
✅ **Non-custodial** — API never holds user keys  
✅ **Auditable** — Ledger shows user address signed each action  
✅ **Multisig-ready** — Can extend to require multiple user signatures  
✅ **KYC-compatible** — Per-user signing enables KYC flows  

---

## Implementation Strategy

### Phase 1: Proof of Concept (Bonds Subscribe)

Start with **`POST /bonds/:id/subscribe`** as a single, complete example:

#### 1a. New Endpoint: `POST /bonds/:id/build-subscribe`

```typescript
// bonds.controller.ts
@Post(':id/build-subscribe')
async buildSubscribe(@Param('id') id: string, @Body() dto: SubscribeDto) {
  // API builds unsigned transaction XDR
  // Does NOT sign it
  return this.bondsService.buildSubscribeTransaction(+id, dto);
}

// Returns:
{
  transactionXdr: "AAAAAgA...",
  networkPassphrase: "Test SDF Network ; September 2015",
  nonce: 5,
  amount: 1000,
  bondId: 42,
}
```

**Service implementation** (`buildSubscribeTransaction`):

```typescript
async buildSubscribeTransaction(
  bondId: number,
  dto: SubscribeDto,
): Promise<UnsignedTransactionResponse> {
  // Fetch next nonce for this user
  const nonce = await this.nonceService.next(BOND_ISSUER(), dto.investorAddress);

  // Build transaction (same logic as before, but DO NOT SIGN)
  const keypair = Keypair.random(); // throwaway, no real key
  const account = new Account(keypair.publicKey(), '0');
  const contract = new Contract(BOND_ISSUER());

  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: this.stellarService.getNetworkPassphrase(),
  })
    .addOperation(contract.call('subscribe', [
      Address.fromString(dto.investorAddress).toScVal(),
      nativeToScVal(BigInt(bondId), { type: 'u64' }),
      nativeToScVal(BigInt(dto.amount), { type: 'i128' }),
    ]))
    .setTimeout(30)
    .build();

  // Simulate only (validate args, get resource footprint)
  const simulation = await this.contractService.simulateTransaction(transaction);

  // Prepare transaction (add auth, resources, etc.) but do NOT sign
  const prepared = await this.sorobanRpc.prepareTransaction(transaction);

  return {
    transactionXdr: prepared.toXDR(),
    networkPassphrase: this.stellarService.getNetworkPassphrase(),
    nonce,
    bondId,
    amount: dto.amount,
  };
}
```

#### 1b. Update Existing Endpoint: `POST /bonds/:id/subscribe` → Submit Signed XDR

```typescript
// bonds.controller.ts
@Post(':id/subscribe')
async subscribe(@Param('id') id: string, @Body() dto: SubscribeSignedDto) {
  // DTO now contains the SIGNED XDR from frontend
  return this.bondsService.submitSignedSubscription(+id, dto);
}

// Receives:
{
  signedTransactionXdr: "AAAAAgA...", // Signed by user via Freighter
  investorAddress: "G...",
}

// Returns:
{
  bondId: 42,
  investorAddress: "G...",
  amount: 1000,
  transactionHash: "abc123...",
}
```

**Service implementation** (`submitSignedSubscription`):

```typescript
async submitSignedSubscription(
  bondId: number,
  dto: SubscribeSignedDto,
): Promise<SubscriptionResponse> {
  // Validate signature (ensure it's actually signed by investorAddress)
  const tx = TransactionBuilder.fromXDR(dto.signedTransactionXdr, this.networkPassphrase);
  const signers = tx.getSigners(); // Extract signer addresses from signatures

  if (!signers.includes(dto.investorAddress)) {
    throw new BadRequestException(
      'Transaction must be signed by the investor address',
    );
  }

  // Submit to Soroban RPC (already signed, just relay)
  const response = await this.sorobanRpc.sendTransaction(tx);

  if (response.status === 'ERROR') {
    throw new BadRequestException('Transaction submission failed');
  }

  return {
    bondId,
    investorAddress: dto.investorAddress,
    amount: dto.amount,
    transactionHash: response.hash,
  };
}
```

#### 1c. Frontend Changes

```typescript
// Example: bond-subscribe.component.ts
async onSubscribe(bondId: number, amount: number) {
  // Step 1: Get unsigned XDR from API
  const build = await this.apiService.post(
    `/bonds/${bondId}/build-subscribe`,
    { investorAddress: this.walletService.address(), amount },
  );

  const { transactionXdr, networkPassphrase } = build;

  // Step 2: Sign with user's wallet (Freighter)
  const signedXdr = await this.walletService.signTransaction(transactionXdr, networkPassphrase);

  // Step 3: Submit signed XDR back to API
  const result = await this.apiService.post(
    `/bonds/${bondId}/subscribe`,
    { signedTransactionXdr: signedXdr, investorAddress: this.walletService.address() },
  );

  console.log('Subscribed:', result);
}
```

---

### Phase 2: Extend to Other Bond Operations

Apply the same pattern to:
- `POST /bonds/:id/transfer` → `build-transfer` + `transfer`
- `POST /bonds/:id/claim-credits` → `build-claim` + `claim`

---

### Phase 3: DEX / Marketplace Operations

Apply to:
- `POST /marketplace/orders/list` → `build-list` + `list`
- `POST /marketplace/orders/:id/buy` → `build-buy` + `buy`
- `POST /marketplace/orders/:id/cancel` → `build-cancel` + `cancel`
- `POST /marketplace/escrow/deposit` → `build-deposit` + `deposit`
- `POST /marketplace/escrow/withdraw` → `build-withdraw` + `withdraw`

---

### Phase 4: Admin Operations (Unchanged)

Admin-only operations (e.g., `issue_bond`, `register_provider`) remain API-signed because:
- Only the protocol admin should call these
- The admin key is held securely (env var or KMS in prod)
- No per-user authorization needed

These operations return `transactionHash` directly (one-step flow).

---

## API Endpoint Convention

### User-Authorization-Required Operations (Two-step)

**Build endpoint**: `POST /resource/build-action`
- Returns unsigned XDR + nonce + metadata
- No side effects
- Idempotent

**Submit endpoint**: `POST /resource/action`
- Accepts signed XDR
- Validates signature matches user address
- Submits and returns result
- Side effects (cache invalidation, etc.)

### Admin-Only Operations (One-step)

**Action endpoint**: `POST /admin/resource/action`
- Builds, signs with admin key, submits
- Returns result directly
- Unchanged from current pattern

---

## Testing Strategy

### Service-Level Tests

```typescript
describe('BondsService signing', () => {
  it('buildSubscribeTransaction returns unsigned XDR', async () => {
    const result = await service.buildSubscribeTransaction(42, {
      investorAddress: 'G...',
      amount: 1000,
    });

    expect(result.transactionXdr).toBeDefined();
    // Verify XDR can be parsed
    const tx = TransactionBuilder.fromXDR(result.transactionXdr, networkPassphrase);
    // Verify it's NOT signed yet
    expect(tx.getSigners().length).toBe(0);
  });

  it('submitSignedSubscription rejects unsigned XDR', async () => {
    const unsignedXdr = buildUnsignedXdr();
    await expect(
      service.submitSignedSubscription(42, {
        signedTransactionXdr: unsignedXdr,
        investorAddress: 'G...',
      }),
    ).rejects.toThrow('must be signed by');
  });

  it('submitSignedSubscription rejects XDR signed by wrong address', async () => {
    const wrongSignerXdr = signXdrWith(buildUnsignedXdr(), wrongKeypair);
    await expect(
      service.submitSignedSubscription(42, {
        signedTransactionXdr: wrongSignerXdr,
        investorAddress: 'G...',
      }),
    ).rejects.toThrow('must be signed by');
  });

  it('submitSignedSubscription accepts XDR signed by correct address', async () => {
    const correctSignedXdr = signXdrWith(buildUnsignedXdr(), correctKeypair);
    const result = await service.submitSignedSubscription(42, {
      signedTransactionXdr: correctSignedXdr,
      investorAddress: 'G...',
    });
    expect(result.transactionHash).toBeDefined();
  });
});
```

### Integration Tests

```typescript
describe('POST /bonds/:id/build-subscribe + /bonds/:id/subscribe', () => {
  it('end-to-end signing flow', async () => {
    // 1. Build unsigned XDR
    const buildRes = await request(app.getHttpServer())
      .post('/bonds/42/build-subscribe')
      .send({ investorAddress: 'G...', amount: 1000 })
      .expect(200);

    const { transactionXdr } = buildRes.body;

    // 2. Sign with test keypair
    const tx = TransactionBuilder.fromXDR(transactionXdr, networkPassphrase);
    tx.sign(testKeypair);
    const signedXdr = tx.toXDR();

    // 3. Submit signed XDR
    const subRes = await request(app.getHttpServer())
      .post('/bonds/42/subscribe')
      .send({ signedTransactionXdr: signedXdr, investorAddress: testKeypair.publicKey() })
      .expect(200);

    expect(subRes.body.transactionHash).toBeDefined();
  });
});
```

---

## Security Checklist

- [ ] API never builds a transaction and signs it with a non-user key
- [ ] Signature validation checks that signer matches the claimed user address
- [ ] Build endpoints return unsigned XDR with zero signatures
- [ ] Submit endpoints reject unsigned XDR
- [ ] Submit endpoints reject XDR signed by wrong address
- [ ] Nonce is correctly consumed per user per action
- [ ] Frontend uses Freighter (or other whitelisted wallet) for signing
- [ ] No user secret keys stored on API
- [ ] All user-authorization endpoints follow two-step pattern

---

## Rollout Plan

1. **Week 1**: Implement bonds subscribe flow (build + submit) with tests
2. **Week 2**: Extend to bonds transfer, claim-credits
3. **Week 3**: Extend to marketplace (list, buy, cancel, deposit, withdraw)
4. **Week 4**: Update frontend to use new flow
5. **Week 5**: Integration testing and hardening
6. **Week 6**: Audit and security review
7. **Week 7**: Deploy to staging
8. **Week 8**: Deploy to production with deprecation of old flow

---

## Backward Compatibility

During rollout:
- Old one-step endpoints remain functional but deprecated
- New two-step flow runs in parallel
- Frontend gradually migrates to new flow
- Old flow removed after 2 weeks of dual operation

---

## Future Enhancements

1. **Hardware Wallet Support**: No API changes needed — frontend signs from hardware key
2. **Multisig**: Frontend can gather N signatures and submit once
3. **KYC Verification**: Per-user signing enables KYC flows
4. **Rate Limiting**: Per-user, not per-API-key
5. **Audit Logging**: Clear record of who signed what, when

---

## Questions for Design Review

1. Should we allow frontends to submit signed XDR directly to Soroban RPC (skipping API)?
   - **Pros**: Reduced load on API, client resilience
   - **Cons**: API loses visibility into submissions

2. Should build endpoints require authentication?
   - **Pros**: Prevents abuse
   - **Cons**: Adds latency for unauthenticated users

3. Should nonces be pre-consumed on build or consumed on submit?
   - **Current proposal**: Pre-consumed on build (ensures ordering)
   - **Alternative**: Consumed on submit (allows retry with same build)

---

