# Transaction Confirmation Flow — Design Document

**Status**: Design Phase  
**Priority**: Critical Data Integrity Issue  
**Scope**: Implement polling and confirmation before reporting success

---

## Problem Statement

### Current Behavior

```typescript
// api/src/stellar/contract.service.ts
async sendTransaction(options): Promise<ContractCallResult> {
  const response = await this.sorobanRpc.sendTransaction(preparedTransaction);

  if (response.status === 'ERROR') {
    throw new BadRequestException(...);
  }

  return {
    result: simulation.result?.retval,
    transactionHash: response.hash,
    successful: true,  // ← BUG: reported immediately, not confirmed
  };
}
```

The problem:
1. `sorobanRpc.sendTransaction()` returns status `PENDING` for transactions not yet in a ledger
2. Code treats `PENDING` as success and returns `successful: true` immediately
3. **Downstreaming consumers assume transaction landed on-chain and update internal state**

### Impact on Call Sites

**bonds.service.ts — Line 131**:
```typescript
const { transactionHash } = await this.contractService.invokeContractMethod(...);

await this.redis.del(`bond:${id}`);
await this.redis.sAdd(`bond:${id}:holders`, dto.investorAddress);  // ← Updated before confirmed!

return { bondId: id, ..., transactionHash };
```

**dex.service.ts — Lines 196–206** (depositQuote, withdrawQuote):
```typescript
const { transactionHash } = await this.contractService.invokeContractMethod(...);
return { address: callerAddress, asset, amount, transactionHash };  // ← Caller assumes confirmed
```

### Failure Scenarios

1. **Transaction expires before inclusion** → Redis updated but contract state unchanged
2. **Network congestion or node crash** → PENDING status never resolved
3. **Mempool reorg** → Transaction dropped, but API reported success
4. **Downstream coupon distribution** → Triggers based on Redis state that doesn't match contract

---

## Solution: Poll Until Confirmation

### New Flow

```
sendTransaction() called
  ↓
Submit to Soroban RPC (returns PENDING)
  ↓
Poll getTransaction() in loop:
  - Every 500ms, up to 30 seconds
  - Check status: NOT_FOUND, PENDING, SUCCESS, FAILED
  ↓
Status resolved:
  - SUCCESS → return { successful: true, transactionHash, ... }
  - FAILED → throw error
  - Timeout without resolution → return { status: 'PENDING', transactionHash } (caller decides)
  ↓
Call sites check response:
  - Update Redis ONLY if successful: true
  - Retry build + submit if status: 'PENDING'
  - Fail/report if successful: false
```

---

## Implementation

### 1. Update ContractCallResult Interface

```typescript
export interface ContractCallResult {
  result: xdr.ScVal;
  transactionHash?: string;
  successful: boolean;
  status?: 'SUCCESS' | 'FAILED' | 'PENDING';  // ← New field
}
```

### 2. Implement Polling in sendTransaction()

```typescript
async sendTransaction(
  options: ContractCallOptions,
  confirmationOptions?: {
    pollIntervalMs?: number;      // Default: 500ms
    maxWaitMs?: number;            // Default: 30000ms
    skipConfirmation?: boolean;    // For read-only or admin ops (optional)
  },
): Promise<ContractCallResult> {
  try {
    const { contractAddress, method, args, sourceSecretKey } = options;
    const {
      pollIntervalMs = 500,
      maxWaitMs = 30000,
      skipConfirmation = false,
    } = confirmationOptions || {};

    // ... existing simulation and prepare logic ...

    const response = await this.sorobanRpc.sendTransaction(preparedTransaction);

    if (response.status === 'ERROR') {
      throw new BadRequestException(
        `Transaction submission failed: ${response.errorResultXdr}`,
      );
    }

    // ← NEW: Poll for confirmation
    if (skipConfirmation) {
      // For admin ops, trust immediate response
      return {
        result: simulation.result?.retval ?? xdr.ScVal.scvVoid(),
        transactionHash: response.hash,
        successful: true,
        status: 'SUCCESS',
      };
    }

    // Poll until confirmed or timeout
    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitMs) {
      const txStatus = await this.sorobanRpc.getTransaction(response.hash);

      if (txStatus.status === 'SUCCESS') {
        return {
          result: simulation.result?.retval ?? xdr.ScVal.scvVoid(),
          transactionHash: response.hash,
          successful: true,
          status: 'SUCCESS',
        };
      }

      if (txStatus.status === 'FAILED') {
        throw new BadRequestException(
          `Transaction failed on-chain: ${JSON.stringify(txStatus.resultXdr)}`,
        );
      }

      // NOT_FOUND or PENDING — wait and retry
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    // Timeout: return PENDING status
    return {
      result: simulation.result?.retval ?? xdr.ScVal.scvVoid(),
      transactionHash: response.hash,
      successful: false,
      status: 'PENDING',
    };
  } catch (error) {
    if (error instanceof BadRequestException) {
      throw error;
    }
    throw new BadRequestException(
      `Failed to submit contract transaction: ${error.message}`,
    );
  }
}
```

### 3. Update invokeContractMethod() to Pass Through Status

```typescript
async invokeContractMethod(
  contractAddress: string,
  method: string,
  callerSecretKey: string,
  args: unknown[],
  nonce: number,
  confirmationOptions?: any,
): Promise<ContractCallResult> {
  const encodedArgs = args.map((arg) => {
    if (arg instanceof xdr.ScVal) {
      return arg;
    }
    return nativeToScVal(arg);
  });

  const nonceScVal = nativeToScVal(BigInt(nonce), { type: 'u64' });
  const allArgs = [...encodedArgs, nonceScVal];

  return this.sendTransaction(
    {
      contractAddress,
      method,
      args: allArgs,
      sourceSecretKey: callerSecretKey,
    },
    confirmationOptions,  // ← Pass through
  );
}
```

### 4. Update bonds.service.ts to Only Update Redis on Confirmation

```typescript
async subscribe(id: number, dto: SubscribeDto): Promise<SubscriptionResponse> {
  const investorSecret = this.signingKeys.investorSecret();
  const nonce = await this.nonceService.next(BOND_ISSUER(), dto.investorAddress);
  
  const result = await this.contractService.invokeContractMethod(
    BOND_ISSUER(), 'subscribe', investorSecret,
    [
      Address.fromString(dto.investorAddress).toScVal(),
      nativeToScVal(BigInt(id), { type: 'u64' }),
      nativeToScVal(BigInt(dto.amount), { type: 'i128' }),
    ],
    nonce,
  );

  // ← NEW: Only update Redis if confirmed
  if (result.successful && result.status === 'SUCCESS') {
    await this.redis.del(`bond:${id}`);
    await this.redis.sAdd(`bond:${id}:holders`, dto.investorAddress);
  } else if (result.status === 'PENDING') {
    // Transaction not yet confirmed
    throw new ConflictException(
      `Subscription transaction pending (${result.transactionHash}). ` +
      'Retry in a few seconds or check transaction status manually.',
    );
  } else {
    // successful: false, but not PENDING → likely failed
    throw new BadRequestException(
      `Subscription transaction did not confirm (${result.transactionHash})`,
    );
  }

  return {
    bondId: id,
    investorAddress: dto.investorAddress,
    amount: dto.amount,
    transactionHash: result.transactionHash || '',
  };
}
```

### 5. Update dex.service.ts Similarly

```typescript
async depositQuote(
  dto: DepositQuoteDto,
  callerAddress: string,
): Promise<QuoteTransactionResponse> {
  const adminSecret = this.getAdminSecret();
  const nonce = await this.nonceService.next(DEX_ROUTER(), callerAddress);

  const result = await this.contractService.invokeContractMethod(
    DEX_ROUTER(), 'deposit_quote', adminSecret,
    [
      Address.fromString(callerAddress).toScVal(),
      nativeToScVal(dto.asset, { type: 'symbol' }),
      nativeToScVal(BigInt(dto.amount), { type: 'i128' }),
    ],
    nonce,
  );

  // ← NEW: Check confirmation status
  if (!result.successful) {
    if (result.status === 'PENDING') {
      throw new ConflictException(
        `Deposit transaction pending (${result.transactionHash}). Retry in a few seconds.`,
      );
    }
    throw new BadRequestException(
      `Deposit transaction failed or did not confirm`,
    );
  }

  return {
    address: callerAddress,
    asset: dto.asset,
    amount: dto.amount,
    transactionHash: result.transactionHash,
  };
}
```

---

## Testing Strategy

### Unit Tests: contract.service.ts

```typescript
describe('ContractService.sendTransaction confirmation', () => {
  let service: ContractService;
  let mockRpc: jest.Mocked<rpc.Server>;

  beforeEach(() => {
    mockRpc = {
      sendTransaction: jest.fn(),
      getTransaction: jest.fn(),
      simulateTransaction: jest.fn(),
      prepareTransaction: jest.fn(),
    } as any;
    service = new ContractService(...);
    service['sorobanRpc'] = mockRpc;
  });

  describe('PENDING → SUCCESS', () => {
    it('polls until SUCCESS and returns successful: true', async () => {
      mockRpc.sendTransaction.mockResolvedValue({
        status: 'PENDING',
        hash: 'tx123',
      });

      // First two calls return PENDING, third returns SUCCESS
      mockRpc.getTransaction
        .mockResolvedValueOnce({ status: 'PENDING' })
        .mockResolvedValueOnce({ status: 'PENDING' })
        .mockResolvedValueOnce({ status: 'SUCCESS', resultXdr: '...' });

      const result = await service.sendTransaction(
        { contractAddress, method, args, sourceSecretKey },
        { pollIntervalMs: 10, maxWaitMs: 5000 },
      );

      expect(result.successful).toBe(true);
      expect(result.status).toBe('SUCCESS');
      expect(result.transactionHash).toBe('tx123');
      expect(mockRpc.getTransaction).toHaveBeenCalledTimes(3);
    });
  });

  describe('PENDING → FAILED', () => {
    it('throws error on FAILED status', async () => {
      mockRpc.sendTransaction.mockResolvedValue({
        status: 'PENDING',
        hash: 'tx456',
      });

      mockRpc.getTransaction
        .mockResolvedValueOnce({ status: 'PENDING' })
        .mockResolvedValueOnce({ status: 'FAILED', resultXdr: 'error...' });

      await expect(
        service.sendTransaction(
          { contractAddress, method, args, sourceSecretKey },
          { pollIntervalMs: 10, maxWaitMs: 5000 },
        ),
      ).rejects.toThrow('failed on-chain');
    });
  });

  describe('Timeout without resolution', () => {
    it('returns status: PENDING on timeout', async () => {
      mockRpc.sendTransaction.mockResolvedValue({
        status: 'PENDING',
        hash: 'tx789',
      });

      mockRpc.getTransaction.mockResolvedValue({ status: 'PENDING' });

      const result = await service.sendTransaction(
        { contractAddress, method, args, sourceSecretKey },
        { pollIntervalMs: 10, maxWaitMs: 50 }, // Short timeout
      );

      expect(result.successful).toBe(false);
      expect(result.status).toBe('PENDING');
      expect(result.transactionHash).toBe('tx789');
    });
  });

  describe('Immediate ERROR', () => {
    it('throws on ERROR status from sendTransaction', async () => {
      mockRpc.sendTransaction.mockResolvedValue({
        status: 'ERROR',
        errorResultXdr: 'bad tx',
      });

      await expect(
        service.sendTransaction(
          { contractAddress, method, args, sourceSecretKey },
        ),
      ).rejects.toThrow('submission failed');
    });
  });
});
```

### Integration Tests: bonds.service.ts

```typescript
describe('BondsService.subscribe confirmation', () => {
  describe('Confirmed subscription', () => {
    it('updates Redis only when transaction is confirmed', async () => {
      const mockResult = {
        result: xdr.ScVal.scvVoid(),
        transactionHash: 'tx123',
        successful: true,
        status: 'SUCCESS',
      };

      jest.spyOn(contractService, 'invokeContractMethod')
        .mockResolvedValue(mockResult);

      const subscribeSpy = jest.spyOn(redis, 'sAdd');

      await service.subscribe(42, {
        investorAddress: 'G...',
        amount: 1000,
      });

      expect(subscribeSpy).toHaveBeenCalledWith(
        'bond:42:holders',
        'G...',
      );
    });
  });

  describe('Pending subscription (timeout)', () => {
    it('throws ConflictException and does not update Redis', async () => {
      const mockResult = {
        result: xdr.ScVal.scvVoid(),
        transactionHash: 'tx456',
        successful: false,
        status: 'PENDING',
      };

      jest.spyOn(contractService, 'invokeContractMethod')
        .mockResolvedValue(mockResult);

      const subscribeSpy = jest.spyOn(redis, 'sAdd');

      await expect(
        service.subscribe(42, {
          investorAddress: 'G...',
          amount: 1000,
        }),
      ).rejects.toThrow(ConflictException);

      expect(subscribeSpy).not.toHaveBeenCalled();
    });
  });

  describe('Failed subscription', () => {
    it('throws BadRequestException and does not update Redis', async () => {
      jest.spyOn(contractService, 'invokeContractMethod')
        .mockRejectedValue(new Error('Contract error'));

      const subscribeSpy = jest.spyOn(redis, 'sAdd');

      await expect(
        service.subscribe(42, {
          investorAddress: 'G...',
          amount: 1000,
        }),
      ).rejects.toThrow();

      expect(subscribeSpy).not.toHaveBeenCalled();
    });
  });
});
```

---

## Error Handling Strategy

### New Exception Types

```typescript
// src/common/exceptions/transaction-pending.exception.ts
export class TransactionPendingException extends HttpException {
  constructor(transactionHash: string, retryAfterSeconds: number = 5) {
    super(
      {
        message: `Transaction pending on-chain (${transactionHash}). Retry in ${retryAfterSeconds}s.`,
        transactionHash,
        retryAfterSeconds,
      },
      HttpStatus.ACCEPTED,
    );
  }
}
```

### Call Site Error Handling

```typescript
// Controller
@Post(':id/subscribe')
async subscribe(@Param('id') id: string, @Body() dto: SubscribeDto) {
  try {
    return await this.bondsService.subscribe(+id, dto);
  } catch (error) {
    if (error instanceof TransactionPendingException) {
      // Client should retry
      throw error;
    }
    if (error instanceof BadRequestException) {
      // Transaction failed
      throw error;
    }
    throw new InternalServerErrorException('Unexpected error');
  }
}

// Frontend
async onSubscribe() {
  try {
    const result = await this.api.post('/bonds/42/subscribe', ...);
    // Success
  } catch (error) {
    if (error.status === 202) {  // ACCEPTED
      // Retry after delay
      setTimeout(() => this.onSubscribe(), error.retryAfterSeconds * 1000);
    } else {
      // Failed
      showError(error.message);
    }
  }
}
```

---

## Backward Compatibility

### Option A: Opt-in Confirmation (Default: enabled)

```typescript
// New parameter to disable confirmation (for testing/admin only)
await contractService.invokeContractMethod(
  ...,
  { skipConfirmation: true }  // Admin operations only
);
```

### Option B: Feature Flag

```typescript
// env var: ENABLE_TRANSACTION_CONFIRMATION=true (default)
const confirmationEnabled = process.env.ENABLE_TRANSACTION_CONFIRMATION !== 'false';
```

During rollout:
- Enable confirmation by default
- Admin can disable if needed for testing
- Monitor error rates and adjust timeouts if needed

---

## Configuration Tuning

### Default Values (Stellar Network Specific)

```typescript
// Testnet: Higher variability, 2 ledgers = ~6 seconds
POLL_INTERVAL_MS = 500
MAX_WAIT_MS = 30000

// Mainnet: More stable, 1 ledger = ~5 seconds
POLL_INTERVAL_MS = 1000
MAX_WAIT_MS = 60000

// Can override via env vars
SOROBAN_POLL_INTERVAL_MS
SOROBAN_MAX_WAIT_MS
```

---

## Deployment Checklist

- [ ] Implement polling in `sendTransaction()`
- [ ] Update result interface to include `status` field
- [ ] Update `bonds.service.ts` to check `successful && status === 'SUCCESS'` before Redis updates
- [ ] Update `dex.service.ts` to check confirmation status
- [ ] Add unit tests for PENDING → SUCCESS, PENDING → FAILED, timeout scenarios
- [ ] Add integration tests verifying Redis not updated on PENDING
- [ ] Create `TransactionPendingException` for 202 ACCEPTED responses
- [ ] Update frontend to handle 202 and retry
- [ ] Test on testnet with network delays
- [ ] Document retry behavior in API README
- [ ] Monitor production for timeout rates
- [ ] Adjust `maxWaitMs` and `pollIntervalMs` based on network stability

---

## Future Enhancements

1. **Exponential backoff** instead of fixed interval
2. **Webhook callbacks** instead of polling (when Soroban supports)
3. **Transaction status cache** to avoid redundant queries
4. **Idempotency keys** to enable safe retries without double-spending
5. **Batch confirmation** for multiple transactions

---

