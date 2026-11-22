import { GatewayTimeoutException, ServiceUnavailableException } from '@nestjs/common';
import { Keypair, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';
import { BondsService } from '../bonds/bonds.service';
import { ContractCallOptions, ContractCallResult, ContractService } from '../stellar/contract.service';
import { ContractException, StableErrorCode } from '../stellar/contract-errors';
import { NonceService } from '../common/services/nonce.service';
import { Rfc7807ExceptionFilter } from '../common/filters/rfc7807-exception.filter';
import { PartialFailureService } from './partial-failure.service';
import { PayoutRedemptionFailureInjectionService } from './payout-redemption-failure-injection.service';
import { ContractFaultInjector, failureInjectionAllowed } from './contract-fault-injector';
import { FailureMode } from './failure-injection.interface';

/**
 * End-to-end failure injection for payouts and redemptions (#644).
 *
 * The real BondsService → ContractService.invokeContractMethod → NonceService
 * → (fault injector) → sendTransaction path runs unchanged. Only the Soroban
 * RPC boundary is replaced, by an in-memory ledger that enforces the same
 * guards as the contracts (nonces, auth, pool solvency, one distribution per
 * period) and reverts failed calls atomically. Financial invariants are
 * checked after every scenario.
 */

const ISSUER = 'C_BOND_ISSUER';
const COUPON = 'C_COUPON_ENGINE';
const BOND_ID = 1;
const FACE_VALUE = 100n;

const admin = Keypair.random();
const alice = Keypair.random();
const bob = Keypair.random();

class InMemoryRedis {
  private readonly store = new Map<string, string>();
  async getOrThrow(key: string) { return this.store.get(key) ?? null; }
  async setOrThrow(key: string, value: string) { this.store.set(key, value); }
  async incrOrThrow(key: string) {
    const next = Number(this.store.get(key) ?? '0') + 1;
    this.store.set(key, String(next));
    return next;
  }
  async acquireLockOrThrow(key: string, token: string) {
    if (this.store.has(key)) return false;
    this.store.set(key, token);
    return true;
  }
  async releaseLockOrThrow(key: string, token: string) {
    if (this.store.get(key) === token) this.store.delete(key);
  }
  async del(key: string) { this.store.delete(key); }
}

/** Minimal model of BondIssuer + CouponEngine state. */
class Ledger {
  supply = 0n;
  balances = new Map<string, bigint>();
  pool = 0n;
  principalPaid = 0n;
  readonly initialPool: bigint;
  totalCredits = 0n;
  undistributed = 0n;
  accrued = new Map<string, bigint>();
  claimed = 0n;
  distributedPeriods = new Set<number>();
  nonces = new Map<string, number>();
  applied: string[] = [];
  nonceReadsFail = false;
  /** Simulates the RPC becoming unreadable right after a call lands. */
  failNonceReadsAfterNextApply = false;

  constructor(init: { holders: Record<string, bigint>; pool: bigint; credits: bigint }) {
    for (const [holder, amount] of Object.entries(init.holders)) {
      this.balances.set(holder, amount);
      this.supply += amount;
    }
    this.pool = init.pool;
    this.initialPool = init.pool;
    this.totalCredits = init.credits;
    this.undistributed = init.credits;
  }

  nonce(contract: string, address: string): number {
    return this.nonces.get(`${contract}:${address}`) ?? 0;
  }

  /** Throws a raw contract error code exactly as the host would (#N). */
  apply(contract: string, method: string, args: unknown[]): unknown {
    const fail = (code: number): never => { throw Object.assign(new Error(`Error(Contract, #${code})`), { contractCode: code }); };
    const caller = args[0] as string;
    const nonce = Number(args[args.length - 1]);
    if (nonce !== this.nonce(contract, caller)) fail(3); // InvalidNonce

    let result: unknown;
    if (contract === ISSUER && method === 'redeem') {
      const amount = BigInt(args[2] as bigint);
      const balance = this.balances.get(caller) ?? 0n;
      if (amount <= 0n) fail(7);
      if (amount > balance) fail(6); // InsufficientSupply
      const payout = amount * FACE_VALUE;
      if (this.pool < payout) fail(13); // RedemptionUnderfunded
      this.balances.set(caller, balance - amount);
      this.supply -= amount;
      this.pool -= payout;
      this.principalPaid += payout;
      result = payout;
    } else if (contract === COUPON && method === 'distribute_coupon') {
      if (caller !== admin.publicKey()) fail(2); // Unauthorized
      const period = Number(args[2]);
      if (this.distributedPeriods.has(period)) fail(9); // already distributed → Overflow
      const holders = args[3] as string[];
      const perPeriod = 1_000n;
      if (this.undistributed < perPeriod) fail(9);
      const held = holders.reduce((sum, h) => sum + (this.balances.get(h) ?? 0n), 0n);
      let paid = 0n;
      holders.forEach((h, i) => {
        const share = i === holders.length - 1 ? perPeriod - paid : (perPeriod * (this.balances.get(h) ?? 0n)) / held;
        paid += share;
        this.accrued.set(h, (this.accrued.get(h) ?? 0n) + share);
      });
      this.undistributed -= perPeriod;
      this.distributedPeriods.add(period);
      result = [BigInt(BOND_ID), BigInt(period), perPeriod, BigInt(holders.length)];
    } else if (contract === COUPON && method === 'claim_credits') {
      const credits = this.accrued.get(caller) ?? 0n;
      this.accrued.set(caller, 0n);
      this.claimed += credits;
      result = credits;
    } else {
      throw new Error(`ledger: unsupported ${contract}.${method}`);
    }

    this.nonces.set(`${contract}:${caller}`, nonce + 1);
    this.applied.push(`${method}:${caller}`);
    if (this.failNonceReadsAfterNextApply) this.nonceReadsFail = true;
    return result;
  }

  assertInvariants(): void {
    const held = [...this.balances.values()].reduce((a, b) => a + b, 0n);
    const accrued = [...this.accrued.values()].reduce((a, b) => a + b, 0n);
    expect({ supplyConserved: held === this.supply }).toEqual({ supplyConserved: true });
    expect({ poolNonNegative: this.pool >= 0n }).toEqual({ poolNonNegative: true });
    expect({ principalConserved: this.pool + this.principalPaid === this.initialPool }).toEqual({ principalConserved: true });
    expect({ creditsConserved: this.undistributed + accrued + this.claimed === this.totalCredits }).toEqual({ creditsConserved: true });
  }
}

/** ContractService whose RPC boundary is the ledger; everything above it is real. */
class LedgerContractService extends ContractService {
  constructor(private readonly ledger: Ledger, nonceService: NonceService) {
    super(
      { getNetworkPassphrase: () => 'test' } as any,
      nonceService,
      {
        getBondIssuerAddress: () => ISSUER,
        getCouponEngineAddress: () => COUPON,
        getOracleConsumerAddress: () => 'C_ORACLE',
        getDexRouterAddress: () => 'C_DEX',
        getProjectRegistryAddress: () => 'C_REGISTRY',
        getCreditRetirementAddress: () => 'C_CREDIT',
      } as any,
    );
  }

  async simulateCall(options: ContractCallOptions): Promise<xdr.ScVal> {
    if (options.method !== 'get_nonce') throw new Error(`unsupported read ${options.method}`);
    if (this.ledger.nonceReadsFail) throw new Error('rpc unavailable');
    const holder = scValToNative(options.args[0]) as string;
    return nativeToScVal(BigInt(this.ledger.nonce(options.contractAddress, holder)), { type: 'u64' });
  }

  async sendTransaction(options: ContractCallOptions): Promise<ContractCallResult> {
    const args = options.args.map((a) => scValToNative(a));
    try {
      const value = this.ledger.apply(options.contractAddress, options.method, args);
      return { result: nativeToScVal(value), transactionHash: `tx_${this.ledger.applied.length}`, successful: true };
    } catch (error) {
      const code = (error as { contractCode?: number }).contractCode;
      if (code === undefined) throw error;
      // Real category resolution + stable-code mapping (#641).
      (this as any).throwMappedContractError(options.contractAddress, options.method, (error as Error).message, code);
      throw error;
    }
  }
}

function problemFor(exception: unknown) {
  const json = jest.fn();
  const host: any = {
    switchToHttp: () => ({
      getResponse: () => ({ status: () => ({ json }), setHeader: jest.fn() }),
      getRequest: () => ({ url: '/e2e' }),
    }),
  };
  new Rfc7807ExceptionFilter().catch(exception, host);
  return json.mock.calls[0][0];
}

function buildHarness(ledgerInit?: Partial<ConstructorParameters<typeof Ledger>[0]>) {
  const ledger = new Ledger({
    holders: { [alice.publicKey()]: 600n, [bob.publicKey()]: 400n },
    pool: 100_000n,
    credits: 10_000n,
    ...ledgerInit,
  });
  const redis = new InMemoryRedis();
  const nonceService = new NonceService(redis as any);
  const contract = new LedgerContractService(ledger, nonceService);
  const partialFailures = new PartialFailureService();
  const rules = new PayoutRedemptionFailureInjectionService(partialFailures);
  const detach = new ContractFaultInjector(rules, partialFailures).attach(contract, {
    FAILURE_INJECTION_ENABLED: 'true',
    NODE_ENV: 'test',
  });
  const bonds = new BondsService(
    contract,
    { getKeypairFromSecret: () => ({ publicKey: () => admin.publicKey() }) } as any,
    nonceService,
    redis as any,
    { adminSecret: () => admin.secret(), investorSecret: () => alice.secret() } as any,
    { getCouponEngineAddress: () => COUPON, getBondIssuerAddress: () => ISSUER } as any,
    { getHoldersForCoupon: async () => [alice.publicKey(), bob.publicKey()] } as any,
  );
  const inject = (flowType: 'PAYOUT' | 'REDEMPTION', failureMode: FailureMode, extra: Record<string, unknown> = {}) =>
    rules.registerRule({ flowType, failureMode, description: `e2e ${failureMode}`, ...extra } as any, admin.publicKey());
  return { ledger, bonds, rules, partialFailures, inject, detach, contract };
}

const redeem = (bonds: BondsService, amount: number, holder = alice) =>
  bonds.redeem(BOND_ID, { investorAddress: holder.publicKey(), amount } as any);
const distribute = (bonds: BondsService, periodIndex = 0) =>
  bonds.distributeCoupon(BOND_ID, { periodIndex, reportId: 1 } as any);
const claim = (bonds: BondsService, holder = alice) =>
  bonds.claimCredits(BOND_ID, { investorAddress: holder.publicKey() } as any);

describe('Payout & redemption end-to-end failure injection (#644)', () => {
  describe('normal path', () => {
    it('distributes, claims and redeems with every invariant preserved', async () => {
      const { ledger, bonds } = buildHarness();

      const dist = await distribute(bonds);
      expect(dist).toMatchObject({ totalCredits: '1000', holderCount: 2 });
      const claimed = await claim(bonds);
      expect(claimed.credits).toBe('600');
      const redeemed = await redeem(bonds, 100);
      expect(redeemed).toMatchObject({ status: 'Redeemed', amount: '100' });
      expect(redeemed.reconciled).toBeUndefined();

      expect(ledger.balances.get(alice.publicKey())).toBe(500n);
      expect(ledger.pool).toBe(90_000n);
      ledger.assertInvariants();
    });
  });

  describe('failure path (no state mutation)', () => {
    it('an injected underfunded pool surfaces BOND_REDEMPTION_UNDERFUNDED and moves nothing', async () => {
      const { ledger, bonds, inject } = buildHarness();
      inject('REDEMPTION', FailureMode.UNDERFUNDED_REDEMPTION_POOL);

      const error = await redeem(bonds, 100).catch((e) => e);
      expect(error).toBeInstanceOf(ContractException);
      expect(error.code).toBe(StableErrorCode.BOND_REDEMPTION_UNDERFUNDED);
      expect(problemFor(error)).toMatchObject({
        retryable: false,
        contract: { code: 'BOND_REDEMPTION_UNDERFUNDED', retryStrategy: 'after_state_change' },
      });
      expect(ledger.applied).toEqual([]);
      expect(ledger.nonce(ISSUER, alice.publicKey())).toBe(0);
      ledger.assertInvariants();
    });

    it('a genuinely underfunded pool produces the identical consumer outcome', async () => {
      const { ledger, bonds } = buildHarness({ pool: 50n });
      const error = await redeem(bonds, 1).catch((e) => e);
      expect(error.code).toBe(StableErrorCode.BOND_REDEMPTION_UNDERFUNDED);
      expect(ledger.applied).toEqual([]);
      ledger.assertInvariants();
    });

    it('an over-sized redemption is rejected by the ledger without partial debit', async () => {
      const { ledger, bonds } = buildHarness();
      const error = await redeem(bonds, 10_000).catch((e) => e);
      expect(error.code).toBe(StableErrorCode.BOND_INSUFFICIENT_SUPPLY);
      expect(ledger.balances.get(alice.publicKey())).toBe(600n);
      ledger.assertInvariants();
    });
  });

  describe('authorization path', () => {
    it('an injected unauthorized caller stops a payout before any credit moves', async () => {
      const { ledger, bonds, inject } = buildHarness();
      inject('PAYOUT', FailureMode.UNAUTHORIZED_CALLER);

      const error = await distribute(bonds).catch((e) => e);
      expect(error.code).toBe(StableErrorCode.BOND_UNAUTHORIZED);
      expect(problemFor(error)).toMatchObject({ retryable: false, contract: { errorClass: 'authorization' } });
      expect(ledger.undistributed).toBe(10_000n);
      ledger.assertInvariants();
    });

    it('scopes rules to their target: a rule for bob never fires for alice', async () => {
      const { ledger, bonds, inject, rules } = buildHarness();
      inject('REDEMPTION', FailureMode.UNDERFUNDED_REDEMPTION_POOL, { targetAddress: bob.publicKey() });

      await expect(redeem(bonds, 10, alice)).resolves.toMatchObject({ status: 'Redeemed' });
      expect(rules.listRules('REDEMPTION')[0].isActive).toBe(true); // still armed for bob
      ledger.assertInvariants();
    });

    it('refuses to attach in production or without the explicit flag', () => {
      const { contract, rules } = buildHarness();
      const injector = new ContractFaultInjector(rules);
      expect(failureInjectionAllowed({ FAILURE_INJECTION_ENABLED: 'true', NODE_ENV: 'production' })).toBe(false);
      expect(() => injector.attach(contract, { FAILURE_INJECTION_ENABLED: 'true', NODE_ENV: 'production' })).toThrow();
      expect(() => injector.attach(contract, { NODE_ENV: 'test' })).toThrow();
    });
  });

  describe('retry path', () => {
    it('pre-commit reset: nothing applied, a 503 is returned, and the retry applies exactly once', async () => {
      const { ledger, bonds, inject } = buildHarness();
      inject('REDEMPTION', FailureMode.PRE_COMMIT_NETWORK_RESET);

      await expect(redeem(bonds, 100)).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(ledger.applied).toEqual([]);

      await expect(redeem(bonds, 100)).resolves.toMatchObject({ status: 'Redeemed' });
      expect(ledger.applied).toEqual([`redeem:${alice.publicKey()}`]);
      expect(ledger.balances.get(alice.publicKey())).toBe(500n);
      ledger.assertInvariants();
    });

    it('stale nonce: classified retryable (resync), the NonceService resyncs, and the retry claims once', async () => {
      const { ledger, bonds, inject } = buildHarness();
      await distribute(bonds);
      inject('PAYOUT', FailureMode.CORRUPTED_NONCE, { targetAddress: alice.publicKey() });

      const error = await claim(bonds).catch((e) => e);
      expect(error.code).toBe(StableErrorCode.BOND_INVALID_NONCE);
      expect(problemFor(error)).toMatchObject({ retryable: true, contract: { retryStrategy: 'resync_nonce' } });

      const retried = await claim(bonds);
      expect(retried.credits).toBe('600');
      expect(ledger.claimed).toBe(600n);
      ledger.assertInvariants();
    });

    it('a rule with count=2 faults twice, then the flow recovers', async () => {
      const { ledger, bonds, inject } = buildHarness();
      inject('REDEMPTION', FailureMode.PRE_COMMIT_NETWORK_RESET, { count: 2 });
      await expect(redeem(bonds, 10)).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(redeem(bonds, 10)).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(redeem(bonds, 10)).resolves.toMatchObject({ status: 'Redeemed' });
      expect(ledger.applied).toHaveLength(1);
      ledger.assertInvariants();
    });
  });

  describe('in-doubt recovery (timeout after the ledger applied the call)', () => {
    it('redemption: reconciles via the contract nonce and reports success instead of inviting a double redeem', async () => {
      const { ledger, bonds, inject, partialFailures } = buildHarness();
      inject('REDEMPTION', FailureMode.TRANSIENT_RPC_TIMEOUT);

      const result = await redeem(bonds, 100);
      expect(result).toMatchObject({ status: 'Redeemed', reconciled: true });
      expect(ledger.applied).toEqual([`redeem:${alice.publicKey()}`]);
      expect(ledger.balances.get(alice.publicKey())).toBe(500n);
      expect(partialFailures.list({ operationType: 'redemption.settlement' } as any).length ?? 0).toBeGreaterThanOrEqual(1);
      ledger.assertInvariants();
    });

    it('redemption: a timeout that never reached the ledger becomes a safe-to-retry 503', async () => {
      const { ledger, bonds, contract } = buildHarness();
      const original = contract.sendTransaction.bind(contract);
      contract.sendTransaction = jest.fn().mockRejectedValueOnce(new GatewayTimeoutException('lost before apply'));

      const error = await redeem(bonds, 100).catch((e) => e);
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(error.message).toMatch(/safe to retry/);
      expect(ledger.applied).toEqual([]);

      contract.sendTransaction = original;
      await expect(redeem(bonds, 100)).resolves.toMatchObject({ status: 'Redeemed' });
      expect(ledger.applied).toHaveLength(1);
      ledger.assertInvariants();
    });

    it('redemption: keeps the 504 when the outcome cannot be proven, so the caller reconciles first', async () => {
      const { ledger, bonds, inject } = buildHarness();
      inject('REDEMPTION', FailureMode.TRANSIENT_RPC_TIMEOUT);
      ledger.failNonceReadsAfterNextApply = true;

      const error = await redeem(bonds, 100).catch((e) => e);
      expect(error).toBeInstanceOf(GatewayTimeoutException);
      expect(problemFor(error)).toMatchObject({ status: 504 });
      expect(ledger.applied).toHaveLength(1); // it *was* applied — which is why a blind retry is unsafe
      ledger.assertInvariants();
    });

    it('payout: a retried distribution after an in-doubt timeout is rejected by the period guard, never paid twice', async () => {
      const { ledger, bonds, inject } = buildHarness();
      inject('PAYOUT', FailureMode.TRANSIENT_RPC_TIMEOUT);

      await expect(distribute(bonds)).rejects.toBeInstanceOf(GatewayTimeoutException);
      expect(ledger.undistributed).toBe(9_000n);

      const retry = await distribute(bonds).catch((e) => e);
      expect(retry.code).toBe(StableErrorCode.BOND_OVERFLOW);
      expect(problemFor(retry).retryable).toBe(false);
      expect(ledger.undistributed).toBe(9_000n);
      ledger.assertInvariants();
    });

    it('payout: re-claiming after an in-doubt claim pays zero (escrow drained), never double', async () => {
      const { ledger, bonds, inject } = buildHarness();
      await distribute(bonds);
      inject('PAYOUT', FailureMode.TRANSIENT_RPC_TIMEOUT, { targetAddress: alice.publicKey() });

      await expect(claim(bonds)).rejects.toBeInstanceOf(GatewayTimeoutException);
      const retry = await claim(bonds);
      expect(retry.credits).toBe('0');
      expect(ledger.claimed).toBe(600n);
      ledger.assertInvariants();
    });
  });

  it('detaching restores the original transport (rollback)', async () => {
    const { ledger, bonds, inject, detach } = buildHarness();
    inject('REDEMPTION', FailureMode.PRE_COMMIT_NETWORK_RESET);
    detach();
    await expect(redeem(bonds, 10)).resolves.toMatchObject({ status: 'Redeemed' });
    ledger.assertInvariants();
  });
});
