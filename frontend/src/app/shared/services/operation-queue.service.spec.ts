import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { ApiService, ApiProblemError, BondDetailResponse } from './api.service';
import { PendingTransactionsService } from './pending-transactions.service';
import { WalletService } from '../../auth/wallet.service';
import { AuthService } from '../../auth/auth.service';
import {
  OperationQueueService,
  QUEUE_STORAGE_KEY,
  IDEMPOTENCY_WINDOW_MS,
  isTransientFailure,
} from './operation-queue.service';

const INVESTOR = 'GINVESTOR';

function detail(overrides: {
  bondId?: number;
  status?: 'Active' | 'Matured' | 'Defaulted';
  totalSupply?: string;
  totalSubscribed?: string;
  balance?: string;
  reached?: boolean;
} = {}): BondDetailResponse {
  return {
    bond: {
      id: overrides.bondId ?? 1,
      projectId: 'p1',
      faceValue: '1000',
      couponSchedule: [],
      creditType: 'Carbon',
      maturityDate: 0,
      maturityStatus: 'Active',
      totalSupply: overrides.totalSupply ?? '1000',
      totalSubscribed: overrides.totalSubscribed ?? '100',
      status: overrides.status ?? 'Active',
      createdAt: '2026-01-01T00:00:00Z',
    },
    holders: [{ address: INVESTOR, balance: overrides.balance ?? '50' }],
    coupon: { undistributedTotal: '0' },
    maturity: { reached: overrides.reached ?? false, date: 0, secondsUntil: 1 },
    loadedAt: '2026-01-01T00:00:00Z',
  };
}

describe('OperationQueueService (#381)', () => {
  let api: jasmine.SpyObj<ApiService>;
  let pendingTx: jasmine.SpyObj<PendingTransactionsService>;
  let address: ReturnType<typeof signal<string | null>>;
  let online: boolean;
  let keySeq: number;
  let created: OperationQueueService[];

  function createService(): OperationQueueService {
    const service = TestBed.runInInjectionContext(() => new OperationQueueService());
    created.push(service);
    return service;
  }

  /** Queue while offline; nothing is sent until `goOnlineAndDrain`. */
  function queueOffline(
    service: OperationQueueService,
    input: { kind?: 'subscribe' | 'transfer'; bondId?: number; amount?: number; toAddress?: string; owner?: string },
    basisBalance = '50',
  ) {
    online = false;
    const op = service.enqueue(
      {
        kind: input.kind ?? 'subscribe',
        bondId: input.bondId ?? 1,
        address: input.owner ?? INVESTOR,
        amount: input.amount ?? 10,
        toAddress: input.toAddress,
      },
      basisBalance,
    );
    return op;
  }

  function goOnlineAndDrain(service: OperationQueueService): Promise<void> {
    online = true;
    return service.drain();
  }

  beforeEach(() => {
    localStorage.removeItem(QUEUE_STORAGE_KEY);
    online = true;
    keySeq = 0;
    created = [];
    spyOnProperty(navigator, 'onLine').and.callFake(() => online);

    api = jasmine.createSpyObj<ApiService>('ApiService', [
      'getBondDetail',
      'subscribeToBond',
      'transferBond',
      'generateIdempotencyKey',
    ]);
    api.generateIdempotencyKey.and.callFake((prefix: string) => `${prefix}-${++keySeq}`);
    api.getBondDetail.and.returnValue(of(detail()));
    api.subscribeToBond.and.callFake((id: number) =>
      of({ bondId: id, subscriber: INVESTOR, amount: '10', transactionHash: `tx-sub-${id}` }),
    );
    api.transferBond.and.callFake((id: number, to: string) =>
      of({ bondId: id, fromAddress: INVESTOR, toAddress: to, amount: '5', transactionHash: `tx-xfer-${id}` }),
    );
    pendingTx = jasmine.createSpyObj<PendingTransactionsService>('PendingTransactionsService', ['register']);
    address = signal<string | null>(INVESTOR);

    TestBed.configureTestingModule({
      providers: [
        { provide: ApiService, useValue: api },
        { provide: PendingTransactionsService, useValue: pendingTx },
        { provide: WalletService, useValue: { address } },
        { provide: AuthService, useValue: { sessionReady: signal(true) } },
      ],
    });
  });

  // Let every run a test started finish inside that test, offline, so none
  // leaks into the next test's storage.
  afterEach(async () => {
    online = false;
    await Promise.all(created.map((service) => service.drain()));
    localStorage.removeItem(QUEUE_STORAGE_KEY);
  });

  it('keeps queued work across a refresh (a new service instance reads it back)', () => {
    const op = queueOffline(createService(), { amount: 10 });

    const afterRefresh = createService();
    expect(afterRefresh.entries().map((e) => e.id)).toEqual([op.id]);
    expect(afterRefresh.entries()[0]).toEqual(jasmine.objectContaining({ status: 'queued', basisBalance: '50' }));
  });

  it('sends in queue order, reusing each operation id as its Idempotency-Key', async () => {
    const service = createService();
    const first = queueOffline(service, { kind: 'subscribe', amount: 10 });
    const second = queueOffline(service, { kind: 'transfer', amount: 5, toAddress: 'GRECIPIENT' });
    const sent: string[] = [];
    api.subscribeToBond.and.callFake((id: number) => {
      sent.push('subscribe');
      return of({ bondId: id, subscriber: INVESTOR, amount: '10', transactionHash: `tx-sub-${id}` });
    });
    api.transferBond.and.callFake((id: number, to: string) => {
      sent.push('transfer');
      return of({ bondId: id, fromAddress: INVESTOR, toAddress: to, amount: '5', transactionHash: `tx-xfer-${id}` });
    });

    await goOnlineAndDrain(service);

    expect(api.subscribeToBond).toHaveBeenCalledOnceWith(1, 10, first.id);
    expect(api.transferBond).toHaveBeenCalledOnceWith(1, 'GRECIPIENT', 5, second.id);
    expect(sent).toEqual(['subscribe', 'transfer']);
    expect(service.entries()).toEqual([]);
    expect(pendingTx.register).toHaveBeenCalledWith('tx-sub-1', 'subscribe', {
      kind: 'holder-balance',
      bondId: 1,
      address: INVESTOR,
      expected: '60',
    });
  });

  it('stops on a stale basis and blocks later operations on the same bond until the user decides', async () => {
    const service = createService();
    const stale = queueOffline(service, { bondId: 1 }, '50');
    queueOffline(service, { bondId: 1, kind: 'transfer', amount: 5, toAddress: 'GR' }, '50');
    queueOffline(service, { bondId: 2 }, '50');
    api.getBondDetail.and.callFake((id: number) => of(detail({ bondId: id, balance: id === 1 ? '60' : '50' })));

    await goOnlineAndDrain(service);

    expect(service.entries().find((e) => e.id === stale.id)).toEqual(
      jasmine.objectContaining({ status: 'conflict', reason: jasmine.stringMatching(/changed from 50 to 60/) }),
    );
    expect(api.transferBond).not.toHaveBeenCalled();
    expect(api.subscribeToBond).toHaveBeenCalledOnceWith(2, 10, jasmine.any(String));
  });

  it('retry accepts the current state and resends with the same Idempotency-Key', async () => {
    const service = createService();
    const op = queueOffline(service, {}, '50');
    api.getBondDetail.and.returnValue(of(detail({ balance: '60' })));
    await goOnlineAndDrain(service);
    expect(api.subscribeToBond).not.toHaveBeenCalled();

    service.retry(op.id);
    await goOnlineAndDrain(service);

    expect(api.subscribeToBond).toHaveBeenCalledOnceWith(1, 10, op.id);
    expect(service.entries()).toEqual([]);
  });

  it('discard removes the operation and unblocks the next one', async () => {
    const service = createService();
    const stale = queueOffline(service, {}, '40');
    const next = queueOffline(service, { kind: 'transfer', amount: 5, toAddress: 'GR' }, '50');
    await goOnlineAndDrain(service);
    expect(api.transferBond).not.toHaveBeenCalled();

    service.discard(stale.id);
    await goOnlineAndDrain(service);

    expect(api.subscribeToBond).not.toHaveBeenCalled();
    expect(api.transferBond).toHaveBeenCalledOnceWith(1, 'GR', 5, next.id);
  });

  it('never sends an operation that can no longer succeed, even after retry', async () => {
    const service = createService();
    const op = queueOffline(service, {});
    api.getBondDetail.and.returnValue(of(detail({ reached: true })));

    await goOnlineAndDrain(service);
    service.retry(op.id);
    await goOnlineAndDrain(service);

    expect(api.subscribeToBond).not.toHaveBeenCalled();
    expect(service.entries()[0]).toEqual(
      jasmine.objectContaining({ status: 'conflict', reason: jasmine.stringMatching(/no longer open \(matured\)/) }),
    );
  });

  it('flags a subscription larger than the remaining supply and a transfer above the balance', async () => {
    const service = createService();
    queueOffline(service, { bondId: 1, amount: 950 });
    queueOffline(service, { bondId: 2, kind: 'transfer', amount: 80, toAddress: 'GR' });
    api.getBondDetail.and.callFake((id: number) => of(detail({ bondId: id })));

    await goOnlineAndDrain(service);

    expect(service.entries().map((e) => e.reason)).toEqual([
      'Only 900 tokens remain unsubscribed.',
      'Your balance is 50, below the 80 tokens to transfer.',
    ]);
  });

  it('keeps an operation queued on a transient failure and stops the drain there', async () => {
    jasmine.clock().install();
    try {
      const service = createService();
      queueOffline(service, { bondId: 1 });
      queueOffline(service, { bondId: 2 });
      api.subscribeToBond.and.returnValue(throwError(() => new HttpErrorResponse({ status: 503 })));

      await goOnlineAndDrain(service);

      expect(api.subscribeToBond.calls.allArgs().every(([bondId]) => bondId === 1)).toBeTrue();
      expect(service.entries().map((e) => e.status)).toEqual(['queued', 'queued']);
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('marks an operation failed when the API rejects it', async () => {
    const service = createService();
    queueOffline(service, {});
    api.subscribeToBond.and.returnValue(
      throwError(
        () =>
          new ApiProblemError({ type: 'about:blank', title: 'Forbidden', status: 403, detail: 'KYC required', code: 'KYC' }),
      ),
    );

    await goOnlineAndDrain(service);

    expect(service.entries()[0]).toEqual(jasmine.objectContaining({ status: 'failed', reason: 'KYC required' }));
  });

  it('asks the user before replaying past the idempotency window', async () => {
    const service = createService();
    const op = queueOffline(service, {});
    const stored = JSON.parse(localStorage.getItem(QUEUE_STORAGE_KEY)!);
    stored.ops[0].enqueuedAt = Date.now() - IDEMPOTENCY_WINDOW_MS - 1;
    localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(stored));

    await goOnlineAndDrain(service);

    expect(api.subscribeToBond).not.toHaveBeenCalled();
    expect(service.entries()[0]).toEqual(jasmine.objectContaining({ id: op.id, status: 'conflict' }));
  });

  it("only sends the connected wallet's operations", async () => {
    const service = createService();
    queueOffline(service, { owner: 'GOTHER' }, '0');
    api.getBondDetail.and.returnValue(of({ ...detail(), holders: [] }));

    await goOnlineAndDrain(service);
    expect(api.subscribeToBond).not.toHaveBeenCalled();

    address.set('GOTHER');
    await goOnlineAndDrain(service);
    expect(api.subscribeToBond).toHaveBeenCalledTimes(1);
  });

  it('does nothing while offline', async () => {
    const service = createService();
    queueOffline(service, {});

    await service.drain();

    expect(api.getBondDetail).not.toHaveBeenCalled();
  });

  it('picks up a change written by another tab', () => {
    const service = createService();
    const other = createService();
    const op = queueOffline(other, {});

    window.dispatchEvent(new StorageEvent('storage', { key: QUEUE_STORAGE_KEY }));

    expect(service.entries().map((e) => e.id)).toEqual([op.id]);
  });

  it('shares one run between concurrent drains, so nothing is sent twice', async () => {
    const service = createService();
    queueOffline(service, {});

    online = true;
    await Promise.all([service.drain(), service.drain(), createService().drain()]);

    expect(api.subscribeToBond).toHaveBeenCalledTimes(1);
  });

  describe('isTransientFailure', () => {
    // The body api/src/common/filters/rfc7807-exception.filter.ts sends for a
    // ConflictException: the original message is replaced by a generic detail.
    const apiProblem = (status: number, title: string) =>
      new ApiProblemError({
        type: 'https://errors.verdant-bond-protocol.org/INTERNAL_ERROR',
        title,
        status,
        detail: 'An unexpected error occurred. Please contact support with your correlation ID.',
        code: 'INTERNAL_ERROR',
      });

    it('treats unanswered and in-flight requests as transient', () => {
      expect(isTransientFailure(new HttpErrorResponse({ status: 0 }))).toBeTrue();
      expect(isTransientFailure(new HttpErrorResponse({ status: 504 }))).toBeTrue();
      expect(isTransientFailure(apiProblem(409, 'Conflict'))).toBeTrue();
    });

    it('treats definitive rejections as terminal', () => {
      expect(isTransientFailure(new HttpErrorResponse({ status: 400 }))).toBeFalse();
      expect(isTransientFailure(apiProblem(403, 'Forbidden'))).toBeFalse();
    });
  });

  it('keeps an operation queued while the API reports its key as in progress (409)', async () => {
    jasmine.clock().install();
    try {
      const service = createService();
      queueOffline(service, {});
      api.subscribeToBond.and.returnValue(
        throwError(
          () =>
            new ApiProblemError({
              type: 'https://errors.verdant-bond-protocol.org/INTERNAL_ERROR',
              title: 'Conflict',
              status: 409,
              detail: 'An unexpected error occurred. Please contact support with your correlation ID.',
              code: 'INTERNAL_ERROR',
            }),
        ),
      );

      await goOnlineAndDrain(service);

      expect(service.entries()[0].status).toBe('queued');
    } finally {
      jasmine.clock().uninstall();
    }
  });
});
