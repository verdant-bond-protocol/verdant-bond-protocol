import { Test } from '@nestjs/testing';
import { nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';
import { DexService } from './dex.service';
import { ContractService } from '../stellar/contract.service';
import { ContractException } from '../stellar/contract-errors';
import { StellarService } from '../stellar/stellar.service';
import { NonceService } from '../common/services/nonce.service';
import { RedisService } from '../common/services/redis.service';
import { SigningKeyProvider } from '../common/services/signing-key.provider';
import { ConfigService } from '../config/config.service';
import { OrderStatus } from './interfaces/marketplace.interface';

const configServiceStub = { getDexRouterAddress: () => 'CDEXROUTERADDRESSPLACEHOLDER' };

// Order-fixture `expires_at` must be in the future: DexService now derives an
// order's effective status from expiry (#91), so a fixture using a
// past/zero timestamp would be reclassified as Expired regardless of its
// status index, breaking any fixture that intends to represent an open order.
const FUTURE_EXPIRY = BigInt(Math.floor(Date.now() / 1000) + 3600);

// ---------------------------------------------------------------------------
// Minimal in-memory Redis stub used by cache-staleness tests.
// Implements only the methods DexService calls, plus delPattern.
// ---------------------------------------------------------------------------
class InMemoryRedis {
  private store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async setEx(key: string, _ttl: number, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async cacheSet(key: string, _ttl: number, value: string, _tags?: string[]): Promise<void> {
    this.store.set(key, value);
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  /** Emulates SCAN+DEL for prefix* patterns. */
  async delPattern(pattern: string): Promise<void> {
    const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  async sAdd(_key: string, _value: string): Promise<void> {}
  async sMembers(_key: string): Promise<string[]> {
    return [];
  }
  async invalidateTag(_tag: string): Promise<void> {}

  keys(): string[] {
    return [...this.store.keys()];
  }

  clear(): void {
    this.store.clear();
  }
}

// ---------------------------------------------------------------------------
// Suite 1 – existing unit tests (unchanged behaviour)
// ---------------------------------------------------------------------------
describe('DexService', () => {
  let service: DexService;
  let contractService: { simulateCall: jest.Mock; invokeContractMethod: jest.Mock };
  let redis: { get: jest.Mock; setEx: jest.Mock; del: jest.Mock; cacheSet: jest.Mock; invalidateTag: jest.Mock; delPattern: jest.Mock };

  const simulateCallMock = jest.fn();
  const invokeContractMethodMock = jest.fn();

  beforeAll(async () => {
    contractService = {
      simulateCall: simulateCallMock,
      invokeContractMethod: invokeContractMethodMock,
    };
    redis = {
      get: jest.fn().mockResolvedValue(null),
      setEx: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
      cacheSet: jest.fn().mockResolvedValue(undefined),
      invalidateTag: jest.fn().mockResolvedValue(undefined),
      delPattern: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        DexService,
        { provide: ContractService, useValue: contractService },
        {
          provide: StellarService,
          useValue: {
            getKeypairFromSecret: jest.fn().mockReturnValue({
              publicKey: () => 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
            }),
          },
        },
        {
          provide: NonceService,
          useValue: { next: jest.fn().mockResolvedValue(0) },
        },
        { provide: RedisService, useValue: redis },
        {
          provide: SigningKeyProvider,
          useValue: { adminSecret: jest.fn().mockReturnValue('SADMIN') },
        },
        { provide: ConfigService, useValue: configServiceStub },
      ],
    }).compile();

    service = moduleRef.get(DexService);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    redis.get.mockResolvedValue(null);
  });

  describe('listOrders', () => {
    const SELLER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
    const rawOrder = (id: number, bondId = 3) =>
      xdr.ScVal.scvVec([
        nativeToScVal(BigInt(id), { type: 'u64' }),
        nativeToScVal(SELLER, { type: 'address' }),
        nativeToScVal(BigInt(bondId), { type: 'u64' }),
        nativeToScVal(BigInt(1000), { type: 'i128' }),
        nativeToScVal(BigInt(25), { type: 'i128' }),
        nativeToScVal('USDC', { type: 'symbol' }),
        xdr.ScVal.scvU32(0),
        nativeToScVal(BigInt(1700000000), { type: 'u64' }),
        nativeToScVal(FUTURE_EXPIRY, { type: 'u64' }),
      ]);

    it('does not truncate listings when an intermediate order id is missing', async () => {
      simulateCallMock.mockImplementation(({ method, args }: { method: string; args: any[] }) => {
        if (method === 'order_count') {
          return Promise.resolve(nativeToScVal(BigInt(4), { type: 'u64' }));
        }
        const id = Number(scValToNative(args[0]));
        if (id === 3) {
          return Promise.reject(new Error('OrderNotFound'));
        }
        return Promise.resolve(rawOrder(id));
      });

      const result = await service.listOrders(undefined, undefined, 1, 10);

      expect(result.data.map((order) => order.id)).toEqual([1, 2, 4]);
      expect(result.meta.total).toBe(3);
      expect(simulateCallMock).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'order_count' }),
      );
    });

    it('filters orders by status explicitly', async () => {
      simulateCallMock.mockImplementation(({ method, args }: { method: string; args: any[] }) => {
        if (method === 'order_count') {
          return Promise.resolve(nativeToScVal(BigInt(4), { type: 'u64' }));
        }
        const id = Number(scValToNative(args[0]));
        // Make id 2 be Expired by setting expiresAt in the past
        const pastExpiry = BigInt(Math.floor(Date.now() / 1000) - 100);
        if (id === 2) {
          const raw = rawOrder(id);
          // Set expiry at index 8
          (raw.value() as xdr.ScVal[])[8] = nativeToScVal(pastExpiry, { type: 'u64' });
          return Promise.resolve(raw);
        }
        return Promise.resolve(rawOrder(id));
      });

      const result = await service.listOrders(undefined, 'Expired', 1, 10);

      expect(result.data.map((order) => order.id)).toEqual([2]);
      expect(result.meta.total).toBe(1);
    });
  });

  describe('decodeOrder', () => {
    const SELLER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

    it('maps the contract Order struct to an OrderResponse', () => {
      const raw = [
        BigInt(7),
        SELLER,
        BigInt(3),
        BigInt(1000),
        BigInt(25),
        'USDC',
         0,
        BigInt(1700000000),
        FUTURE_EXPIRY,
      ];

      expect((service as any).decodeOrder(raw)).toEqual({
        id: 7,
        seller: SELLER,
        bondId: 3,
        amount: '1000',
        pricePerToken: '25',
        quoteAsset: 'USDC',
        status: OrderStatus.Open,
        createdAt: new Date(1700000000 * 1000).toISOString(),
      });
    });

    it.each([
      [0, OrderStatus.Open],
      [1, OrderStatus.PartiallyFilled],
      [2, OrderStatus.Filled],
      [3, OrderStatus.Cancelled],
      [4, OrderStatus.Expired],
    ])('maps status index %i to %s', (index, expected) => {
      const raw = [
        BigInt(1),
        SELLER,
        BigInt(1),
        BigInt(1),
        BigInt(1),
        'XLM',
        index,
        BigInt(0),
        FUTURE_EXPIRY,
      ];

      expect((service as any).decodeOrder(raw).status).toBe(expected);
    });
  });

  describe('getQuoteBalance', () => {
    const address = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

    it('reads the escrowed balance for the requested asset', async () => {
      simulateCallMock.mockResolvedValue(nativeToScVal(BigInt(25_000), { type: 'i128' }));

      await expect(service.getQuoteBalance(address, 'USDC')).resolves.toEqual({
        address,
        asset: 'USDC',
        balance: '25000',
      });

      expect(simulateCallMock).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'get_quote_balance' }),
      );
    });
  });

  describe('depositQuote', () => {
    const address = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

    it('calls deposit_quote and returns a transaction response', async () => {
      invokeContractMethodMock.mockResolvedValue({
        transactionHash: 'abc123',
        successful: true,
      });

      await expect(
        service.depositQuote({ asset: 'USDC', amount: 1000 }, address),
      ).resolves.toEqual({
        address,
        asset: 'USDC',
        amount: 1000,
        transactionHash: 'abc123',
      });

      expect(invokeContractMethodMock).toHaveBeenCalledWith(
        expect.any(String),
        'deposit_quote',
        expect.any(String),
        expect.any(Array),
        address,
      );
    });
  });

  describe('withdrawQuote', () => {
    const address = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

    it('calls withdraw_quote and returns a transaction response', async () => {
      invokeContractMethodMock.mockResolvedValue({
        transactionHash: 'def456',
        successful: true,
      });

      await expect(
        service.withdrawQuote({ asset: 'XLM', amount: 500 }, address),
      ).resolves.toEqual({
        address,
        asset: 'XLM',
        amount: 500,
        transactionHash: 'def456',
      });

      expect(invokeContractMethodMock).toHaveBeenCalledWith(
        expect.any(String),
        'withdraw_quote',
        expect.any(String),
        expect.any(Array),
        address,
      );
    });
  });

  describe('cleanExpiredOrders', () => {
    it('invokes clean_expired_orders with start_id and limit and decodes the result', async () => {
      // Prefer array-shaped decode path used by scValToNative for contracttype structs
      invokeContractMethodMock.mockResolvedValue({
        transactionHash: 'clean1',
        successful: true,
        result: xdr.ScVal.scvVec([
          nativeToScVal(3, { type: 'u32' }),
          nativeToScVal(BigInt(51), { type: 'u64' }),
        ]),
      });

      await expect(service.cleanExpiredOrders(1, 50)).resolves.toEqual({
        cleaned: 3,
        nextStartId: 51,
      });

      expect(invokeContractMethodMock).toHaveBeenCalledWith(
        expect.any(String),
        'clean_expired_orders',
        'SADMIN',
        expect.any(Array),
        'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      );
      const args = invokeContractMethodMock.mock.calls[0][3];
      expect(Number(scValToNative(args[1]))).toBe(1);
      expect(Number(scValToNative(args[2]))).toBe(50);
    });
  });

  describe('cache invalidation — delPattern is called on mutations', () => {
    const SELLER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

    const rawOrderScVal = (id: number, statusIndex = 0) =>
      xdr.ScVal.scvVec([
        nativeToScVal(BigInt(id), { type: 'u64' }),
        nativeToScVal(SELLER, { type: 'address' }),
        nativeToScVal(BigInt(1), { type: 'u64' }),
        nativeToScVal(BigInt(100), { type: 'i128' }),
        nativeToScVal(BigInt(10), { type: 'i128' }),
        nativeToScVal('USDC', { type: 'symbol' }),
        xdr.ScVal.scvU32(statusIndex),
        nativeToScVal(BigInt(1700000000), { type: 'u64' }),
        nativeToScVal(FUTURE_EXPIRY, { type: 'u64' }),
      ]);

    it('listBondTokens calls delPattern("orders:*") and del("order:<id>")', async () => {
      invokeContractMethodMock.mockResolvedValue({
        result: nativeToScVal(BigInt(5), { type: 'u64' }),
        transactionHash: 'tx-list',
        successful: true,
      });
      simulateCallMock.mockImplementation(({ method, args }: { method: string; args: any[] }) => {
        if (method === 'get_order') return Promise.resolve(rawOrderScVal(Number(scValToNative(args[0]))));
        return Promise.reject(new Error(`unexpected: ${method}`));
      });

      await service.listBondTokens(
        { bondId: 1, amount: 100, pricePerToken: 10, quoteAsset: 'USDC' } as any,
        SELLER,
      );

      expect(redis.delPattern).toHaveBeenCalledWith('orders:*');
      expect(redis.del).toHaveBeenCalledWith('order:5');
    });

    it('buyBondTokens calls delPattern("orders:*") and del("order:<id>")', async () => {
      // statusIndex 0 (Open): the pre-flight reconciliation check (#91) now
      // rejects a buy against an order that isn't Open/PartiallyFilled, so
      // this fixture must represent a genuinely actionable order.
      simulateCallMock.mockImplementation(({ method, args }: { method: string; args: any[] }) => {
        if (method === 'get_order') return Promise.resolve(rawOrderScVal(Number(scValToNative(args[0])), 0));
        if (method === 'get_quote_balance') return Promise.resolve(nativeToScVal(BigInt(9_999_999), { type: 'i128' }));
        return Promise.reject(new Error(`unexpected: ${method}`));
      });
      invokeContractMethodMock.mockResolvedValue({ transactionHash: 'tx-buy', successful: true });

      const order = await service.buyBondTokens({ orderId: 3, amount: 10, maxPrice: 10 } as any, SELLER);

      expect(redis.delPattern).toHaveBeenCalledWith('orders:*');
      expect(redis.del).toHaveBeenCalledWith('order:3');
      expect(order.transactionHash).toBe('tx-buy');
    });

    it('cancelOrder calls delPattern("orders:*") and del("order:<id>")', async () => {
      // cancelOrder now also revalidates against a fresh ledger read (#91)
      // before invoking cancel_listing, so get_order must be mocked here too.
      simulateCallMock.mockImplementation(({ method, args }: { method: string; args: any[] }) => {
        if (method === 'get_order') return Promise.resolve(rawOrderScVal(Number(scValToNative(args[0])), 0));
        return Promise.reject(new Error(`unexpected: ${method}`));
      });
      invokeContractMethodMock.mockResolvedValue({ transactionHash: 'tx-cancel', successful: true });

      await service.cancelOrder(7, SELLER);

      expect(redis.delPattern).toHaveBeenCalledWith('orders:*');
      expect(redis.del).toHaveBeenCalledWith('order:7');
    });
  });

  // -------------------------------------------------------------------------
  // Order reconciliation (#91): buy/cancel must revalidate against the
  // order's true current state -- including expiry, which the contract's own
  // persisted `status` does not reflect until the hourly clean_expired_orders
  // sweep visits that order -- immediately before acting, and reject clearly
  // when it is no longer actionable.
  // -------------------------------------------------------------------------
  describe('order reconciliation (#91)', () => {
    const SELLER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
    const BUYER = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWMY';

    const buildOrderScVal = (opts: { id: number; statusIndex: number; expiresAt: bigint }) =>
      xdr.ScVal.scvVec([
        nativeToScVal(BigInt(opts.id), { type: 'u64' }),
        nativeToScVal(SELLER, { type: 'address' }),
        nativeToScVal(BigInt(1), { type: 'u64' }),
        nativeToScVal(BigInt(100), { type: 'i128' }),
        nativeToScVal(BigInt(10), { type: 'i128' }),
        nativeToScVal('USDC', { type: 'symbol' }),
        xdr.ScVal.scvU32(opts.statusIndex),
        nativeToScVal(BigInt(1700000000), { type: 'u64' }),
        nativeToScVal(opts.expiresAt, { type: 'u64' }),
      ]);

    it('rejects a buy when a fresh read shows the order is already Filled, even with a stale cached "Open" copy', async () => {
      // A stale cached copy says Open; the pre-flight fetch must bypass this
      // cache entirely (it never calls redis.get) and see the true Filled state.
      redis.get.mockImplementation((key: string) =>
        key === 'order:5'
          ? Promise.resolve(JSON.stringify({ status: OrderStatus.Open }))
          : Promise.resolve(null),
      );
      simulateCallMock.mockImplementation(({ method, args }: { method: string; args: any[] }) =>
        method === 'get_order'
          ? Promise.resolve(buildOrderScVal({ id: Number(scValToNative(args[0])), statusIndex: 2, expiresAt: FUTURE_EXPIRY }))
          : Promise.reject(new Error(`unexpected: ${method}`)),
      );

      await expect(
        service.buyBondTokens({ orderId: 5, amount: 10, maxPrice: 10 } as any, BUYER),
      ).rejects.toMatchObject({ status: 409 });

      expect(invokeContractMethodMock).not.toHaveBeenCalled();
    });

    it('rejects a buy when the order has passed its expiry, even though its persisted status is still Open', async () => {
      const pastExpiry = BigInt(Math.floor(Date.now() / 1000) - 60);
      simulateCallMock.mockImplementation(({ method, args }: { method: string; args: any[] }) =>
        method === 'get_order'
          ? Promise.resolve(buildOrderScVal({ id: Number(scValToNative(args[0])), statusIndex: 0, expiresAt: pastExpiry }))
          : Promise.reject(new Error(`unexpected: ${method}`)),
      );

      await expect(
        service.buyBondTokens({ orderId: 6, amount: 10, maxPrice: 10 } as any, BUYER),
      ).rejects.toMatchObject({ status: 409 });

      expect(invokeContractMethodMock).not.toHaveBeenCalled();
    });

    it('rejects a cancel when a fresh read shows the order is no longer Open/PartiallyFilled', async () => {
      simulateCallMock.mockImplementation(({ method, args }: { method: string; args: any[] }) =>
        method === 'get_order'
          ? Promise.resolve(buildOrderScVal({ id: Number(scValToNative(args[0])), statusIndex: 3, expiresAt: FUTURE_EXPIRY })) // Cancelled
          : Promise.reject(new Error(`unexpected: ${method}`)),
      );

      await expect(service.cancelOrder(8, SELLER)).rejects.toMatchObject({ status: 409 });
      expect(invokeContractMethodMock).not.toHaveBeenCalled();
    });

    it('maps a contract-level rejection during cancel to a clean Conflict instead of leaking the raw error', async () => {
      simulateCallMock.mockImplementation(({ method, args }: { method: string; args: any[] }) =>
        method === 'get_order'
          ? Promise.resolve(buildOrderScVal({ id: Number(scValToNative(args[0])), statusIndex: 0, expiresAt: FUTURE_EXPIRY }))
          : Promise.reject(new Error(`unexpected: ${method}`)),
      );
      invokeContractMethodMock.mockRejectedValue(new Error('HostError: Error(Contract, #5)'));

      await expect(service.cancelOrder(9, SELLER)).rejects.toMatchObject({ status: 409 });
    });

    it('rejects a stale price before invoking the purchase contract', async () => {
      simulateCallMock.mockImplementation(({ method, args }: { method: string; args: any[] }) =>
        method === 'get_order'
          ? Promise.resolve(buildOrderScVal({ id: Number(scValToNative(args[0])), statusIndex: 0, expiresAt: FUTURE_EXPIRY }))
          : Promise.reject(new Error(`unexpected: ${method}`)),
      );

      await expect(service.buyBondTokens({ orderId: 10, amount: 10, maxPrice: 9 } as any, BUYER))
        .rejects.toMatchObject({ status: 409 });
      expect(invokeContractMethodMock).not.toHaveBeenCalled();
    });

    it('rejects a partial-depth change before invoking the purchase contract', async () => {
      simulateCallMock.mockImplementation(({ method, args }: { method: string; args: any[] }) =>
        method === 'get_order'
          ? Promise.resolve(buildOrderScVal({ id: Number(scValToNative(args[0])), statusIndex: 1, expiresAt: FUTURE_EXPIRY }))
          : Promise.reject(new Error(`unexpected: ${method}`)),
      );

      await expect(service.buyBondTokens({ orderId: 11, amount: 101, maxPrice: 10 } as any, BUYER))
        .rejects.toMatchObject({ status: 409 });
      expect(invokeContractMethodMock).not.toHaveBeenCalled();
    });

    it('decodeOrder reports Expired once the wall clock passes expires_at, even though the raw status index is still Open', () => {
      const pastExpiry = BigInt(Math.floor(Date.now() / 1000) - 1);
      const raw = [BigInt(10), SELLER, BigInt(1), BigInt(100), BigInt(10), 'USDC', 0, BigInt(1700000000), pastExpiry];

      expect((service as any).decodeOrder(raw).status).toBe(OrderStatus.Expired);
    });

    it('decodeOrder leaves a terminal status (Filled/Cancelled) unchanged regardless of expiry', () => {
      const pastExpiry = BigInt(Math.floor(Date.now() / 1000) - 1);
      const raw = [BigInt(11), SELLER, BigInt(1), BigInt(100), BigInt(10), 'USDC', 2, BigInt(1700000000), pastExpiry];

      expect((service as any).decodeOrder(raw).status).toBe(OrderStatus.Filled);
    });
  });
});

describe('DexService — mapDexError (unit)', () => {
  it('maps InsufficientFunds contract error to PAYMENT_REQUIRED HttpException', () => {
    const svc = new DexService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    const err = new ContractException('DEX_INSUFFICIENT_FUNDS', 'insufficient', undefined, undefined, 10);
    const mapped = (svc as any).mapDexError(err);
    expect(mapped).toBeInstanceOf(Object);
    // ensure it's an HttpException with payment required
    const status = (mapped as any).getStatus ? (mapped as any).getStatus() : (mapped as any).status;
    expect(status).toBe(402);
  });

  it('falls back to BadRequestException for unknown contract codes', () => {
    const svc = new DexService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    const err = new ContractException('SOME_CODE', 'some detail', undefined, undefined, 999);
    const mapped = (svc as any).mapDexError(err);
    expect(mapped).toBeInstanceOf(Object);
  });
});

// ---------------------------------------------------------------------------
// Suite 2 – cache-staleness integration tests (InMemoryRedis)
//
// These tests prove that after a mutation the stale orders:* cache entries are
// actually gone so the *next* listOrders() call fetches fresh data from the
// contract rather than serving the pre-mutation snapshot.
// ---------------------------------------------------------------------------
describe('DexService — cache staleness (in-memory Redis)', () => {
  const SELLER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
  // Use the same valid checksum address; buyer identity doesn't affect the cache-invalidation assertions.
  const BUYER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

  let service: DexService;
  let inMemRedis: InMemoryRedis;
  let simulateCall: jest.Mock;
  let invokeContractMethod: jest.Mock;

  const rawOrderScVal = (id: number, statusIndex = 0) =>
    xdr.ScVal.scvVec([
      nativeToScVal(BigInt(id), { type: 'u64' }),
      nativeToScVal(SELLER, { type: 'address' }),
      nativeToScVal(BigInt(1), { type: 'u64' }),
      nativeToScVal(BigInt(100), { type: 'i128' }),
      nativeToScVal(BigInt(10), { type: 'i128' }),
      nativeToScVal('USDC', { type: 'symbol' }),
      xdr.ScVal.scvU32(statusIndex),
      nativeToScVal(BigInt(1700000000), { type: 'u64' }),
      nativeToScVal(FUTURE_EXPIRY, { type: 'u64' }),
    ]);

  beforeEach(async () => {
    inMemRedis = new InMemoryRedis();
    simulateCall = jest.fn();
    invokeContractMethod = jest.fn();

    const moduleRef = await Test.createTestingModule({
      providers: [
        DexService,
        { provide: ContractService, useValue: { simulateCall, invokeContractMethod } },
        { provide: StellarService, useValue: {} },
        { provide: NonceService, useValue: { next: jest.fn().mockResolvedValue(0) } },
        { provide: RedisService, useValue: inMemRedis },
        {
          provide: SigningKeyProvider,
          useValue: { adminSecret: jest.fn().mockReturnValue('SADMIN') },
        },
        { provide: ConfigService, useValue: configServiceStub },
      ],
    }).compile();

    service = moduleRef.get(DexService);
  });

  /**
   * Seeds a stale orders:* cache entry, runs the mutation, then asserts:
   * 1. All orders:* keys are gone after the mutation.
   * 2. A subsequent listOrders() call hits the contract (not cache) and
   *    returns fresh data (empty list, because we mock order_count → 0).
   */
  async function assertOrdersCacheInvalidated(
    triggerMutation: () => Promise<unknown>,
  ): Promise<void> {
    const staleResult = {
      data: [
        {
          id: 1,
          seller: SELLER,
          bondId: 1,
          amount: 100,
          pricePerToken: 10,
          quoteAsset: 'USDC',
          status: OrderStatus.Open,
          createdAt: new Date().toISOString(),
        },
      ],
      meta: { page: 1, limit: 20, total: 1, totalPages: 1 },
    };
    await inMemRedis.setEx('orders:all:all:1:20', 30, JSON.stringify(staleResult));

    // Sanity: stale key is present before mutation.
    expect(inMemRedis.keys().some((k) => k.startsWith('orders:'))).toBe(true);

    await triggerMutation();

    // All orders:* keys must be gone after the mutation.
    const remaining = inMemRedis.keys().filter((k) => k.startsWith('orders:'));
    expect(remaining).toHaveLength(0);

    // The next listOrders() must bypass cache and call the contract.
    simulateCall.mockImplementation(({ method }: { method: string }) => {
      if (method === 'order_count') {
        return Promise.resolve(nativeToScVal(BigInt(0), { type: 'u64' }));
      }
      return Promise.reject(new Error(`unexpected: ${method}`));
    });

    const fresh = await service.listOrders(undefined, undefined, 1, 20);
    expect(fresh.meta.total).toBe(0);
    expect(fresh.data).toHaveLength(0);
  }

  it('listBondTokens: stale orders:* cache is evicted so the next listOrders returns fresh data', async () => {
    invokeContractMethod.mockResolvedValue({
      result: nativeToScVal(BigInt(2), { type: 'u64' }),
      transactionHash: 'tx-list',
      successful: true,
    });
    simulateCall.mockImplementation(({ method, args }: { method: string; args: any[] }) => {
      if (method === 'get_order') {
        return Promise.resolve(rawOrderScVal(Number(scValToNative(args[0]))));
      }
      if (method === 'order_count') {
        return Promise.resolve(nativeToScVal(BigInt(0), { type: 'u64' }));
      }
      return Promise.reject(new Error(`unexpected: ${method}`));
    });

    await assertOrdersCacheInvalidated(() =>
      service.listBondTokens(
        { bondId: 1, amount: 100, pricePerToken: 10, quoteAsset: 'USDC' } as any,
        SELLER,
      ),
    );
  });

  it('buyBondTokens: stale orders:* cache is evicted so the next listOrders returns fresh data', async () => {
    // statusIndex 0 (Open): must be actionable for the pre-flight check (#91) to allow the buy.
    simulateCall.mockImplementation(({ method, args }: { method: string; args: any[] }) => {
      if (method === 'get_order') {
        return Promise.resolve(rawOrderScVal(Number(scValToNative(args[0])), 0));
      }
      if (method === 'get_quote_balance') {
        return Promise.resolve(nativeToScVal(BigInt(9_999_999), { type: 'i128' }));
      }
      if (method === 'order_count') {
        return Promise.resolve(nativeToScVal(BigInt(0), { type: 'u64' }));
      }
      return Promise.reject(new Error(`unexpected: ${method}`));
    });
    invokeContractMethod.mockResolvedValue({ transactionHash: 'tx-buy', successful: true });

    await assertOrdersCacheInvalidated(() =>
      service.buyBondTokens({ orderId: 1, amount: 10, maxPrice: 10 } as any, BUYER),
    );
  });

  it('cancelOrder: stale orders:* cache is evicted so the next listOrders returns fresh data', async () => {
    invokeContractMethod.mockResolvedValue({ transactionHash: 'tx-cancel', successful: true });
    // cancelOrder's pre-flight reconciliation check (#91) reads get_order before
    // cancel_listing, so it must be mocked here in addition to order_count.
    simulateCall.mockImplementation(({ method, args }: { method: string; args: any[] }) => {
      if (method === 'get_order') {
        return Promise.resolve(rawOrderScVal(Number(scValToNative(args[0])), 0));
      }
      if (method === 'order_count') {
        return Promise.resolve(nativeToScVal(BigInt(0), { type: 'u64' }));
      }
      return Promise.reject(new Error(`unexpected: ${method}`));
    });

    await assertOrdersCacheInvalidated(() => service.cancelOrder(1, SELLER));
  });

  it('buyBondTokens: individual order:N key is evicted so getOrder returns fresh data', async () => {
    const orderId = 1;
    await inMemRedis.setEx(
      `order:${orderId}`,
      60,
      JSON.stringify({ 
        id: orderId, 
        seller: SELLER,
        bondId: 1,
        amount: '100',
        pricePerToken: '10',
        quoteAsset: 'USDC',
        status: OrderStatus.Open,
        createdAt: '2023-01-01T00:00:00.000Z',
      }),
    );

    // The pre-flight reconciliation check (#91) reads get_order before the
    // purchase executes, then buyBondTokens's own post-mutation getOrder()
    // reads it again once the cache has been invalidated. Model that
    // sequence accurately: the order is genuinely Open going in (allowing
    // the buy to proceed) and Filled once read back afterwards.
    let getOrderCalls = 0;
    simulateCall.mockImplementation(({ method, args }: { method: string; args: any[] }) => {
      if (method === 'get_order') {
        getOrderCalls += 1;
        const statusIndex = getOrderCalls === 1 ? 0 : 2; // 1st call (pre-flight): Open; later calls: Filled
        return Promise.resolve(rawOrderScVal(Number(scValToNative(args[0])), statusIndex));
      }
      if (method === 'get_quote_balance') {
        return Promise.resolve(nativeToScVal(BigInt(9_999_999), { type: 'i128' }));
      }
      return Promise.reject(new Error(`unexpected: ${method}`));
    });
    invokeContractMethod.mockResolvedValue({ transactionHash: 'tx-buy', successful: true });

    await service.buyBondTokens({ orderId, amount: 10, maxPrice: 10 } as any, BUYER);

    // After buyBondTokens: the stale Open entry is gone and the fresh Filled
    // entry has been written back to cache by the internal getOrder() call.
    const cached = await inMemRedis.get(`order:${orderId}`);
    expect(cached).not.toBeNull();
    const cachedOrder = JSON.parse(cached!);
    expect(cachedOrder.status).toBe(OrderStatus.Filled);

    // After eviction, getOrder re-fetches and caches the Filled order.
    simulateCall.mockImplementation(({ method, args }: { method: string; args: any[] }) => {
      if (method === 'get_order') return Promise.resolve(rawOrderScVal(Number(scValToNative(args[0])), 2));
      return Promise.reject(new Error(`unexpected: ${method}`));
    });
    const freshOrder = await service.getOrder(orderId);
    expect(freshOrder.status).toBe(OrderStatus.Filled);
  });

  it('cancelOrder: individual order:N key is evicted', async () => {
    const orderId = 3;
    await inMemRedis.setEx(
      `order:${orderId}`,
      60,
      JSON.stringify({ id: orderId, status: OrderStatus.Open }),
    );

    // cancelOrder's pre-flight reconciliation check (#91) reads get_order first.
    simulateCall.mockImplementation(({ method, args }: { method: string; args: any[] }) => {
      if (method === 'get_order') {
        return Promise.resolve(rawOrderScVal(Number(scValToNative(args[0])), 0));
      }
      return Promise.reject(new Error(`unexpected: ${method}`));
    });
    invokeContractMethod.mockResolvedValue({ transactionHash: 'tx-cancel', successful: true });

    await service.cancelOrder(orderId, SELLER);

    expect(await inMemRedis.get(`order:${orderId}`)).toBeNull();
  });

  it('listBondTokens: individual order:N key for the new listing is not stale', async () => {
    const newOrderId = 9;
    // Pre-seed a stale cache entry for order 9 (e.g. from a previous failed creation).
    await inMemRedis.setEx(
      `order:${newOrderId}`,
      60,
      JSON.stringify({ id: newOrderId, status: OrderStatus.Cancelled }),
    );

    invokeContractMethod.mockResolvedValue({
      result: nativeToScVal(BigInt(newOrderId), { type: 'u64' }),
      transactionHash: 'tx-list',
      successful: true,
    });
    simulateCall.mockImplementation(({ method, args }: { method: string; args: any[] }) => {
      if (method === 'get_order') {
        return Promise.resolve(rawOrderScVal(Number(scValToNative(args[0])), 0)); // Open
      }
      return Promise.reject(new Error(`unexpected: ${method}`));
    });

    const result = await service.listBondTokens(
      { bondId: 1, amount: 100, pricePerToken: 10, quoteAsset: 'USDC' } as any,
      SELLER,
    );

    // The returned order must be the fresh Open one, not the stale Cancelled entry.
    expect(result.status).toBe(OrderStatus.Open);
  });
});
