import { TestBed, fakeAsync, tick, discardPeriodicTasks } from '@angular/core/testing';
import { Observable, of, throwError } from 'rxjs';
import { ApiService, BondDetailResponse } from './api.service';
import {
  DELAYED_AFTER_MS,
  EXPIRED_AFTER_MS,
  OptimisticEffect,
  PendingTransactionsService,
} from './pending-transactions.service';
import { TransactionStatus } from '../interfaces/bond.interface';

const STORAGE_KEY = 'nbs_pending_txs';
const ADDRESS = 'GINVESTOR';

const holderEffect = (expected: string): OptimisticEffect => ({ kind: 'holder-balance', bondId: 7, address: ADDRESS, expected });

describe('PendingTransactionsService optimistic reconciliation (#209)', () => {
  let status: TransactionStatus;
  let onChainBalance: string;
  let api: jasmine.SpyObj<ApiService>;

  const createService = () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: api }] });
    return TestBed.inject(PendingTransactionsService);
  };

  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    status = 'pending';
    onChainBalance = '0';
    api = jasmine.createSpyObj('ApiService', ['getTransactionStatus', 'getBondDetail', 'getClaimableCredits']);
    api.getTransactionStatus.and.callFake((hash: string) => of({ hash, status }));
    api.getBondDetail.and.callFake(() =>
      of({ holders: [{ address: ADDRESS, balance: onChainBalance }] } as unknown as BondDetailResponse),
    );
    api.getClaimableCredits.and.returnValue(of({ bondId: 7, address: ADDRESS, total: '0', details: [] }));
  });

  afterEach(() => localStorage.removeItem(STORAGE_KEY));

  it('persists the effect under its hash before any view can render it', fakeAsync(() => {
    const service = createService();
    service.register('0xsub', 'subscribe', holderEffect('150'));

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored[0]).toEqual(jasmine.objectContaining({ hash: '0xsub', effect: holderEffect('150'), reconciliation: 'awaiting' }));
    expect(service.optimisticValue('holder-balance', 7, ADDRESS)).toBe('150');
    discardPeriodicTasks();
  }));

  it('success as expected: confirmed value matches, overlay ends silently', fakeAsync(() => {
    const service = createService();
    service.register('0xsub', 'subscribe', holderEffect('150'));
    tick(0);

    status = 'confirmed';
    onChainBalance = '150';
    tick(4000);

    const [entry] = service.entries();
    expect(entry.reconciliation).toBe('matched');
    expect(entry.effect!.actual).toBe('150');
    expect(service.optimisticValue('holder-balance', 7, ADDRESS)).toBeNull();
    expect(service.notices(7)).toEqual([]);
    discardPeriodicTasks();
  }));

  it('success with different values: a racing transaction is reported, not hidden', fakeAsync(() => {
    const service = createService();
    service.register('0xsub', 'subscribe', holderEffect('150'));
    tick(0);

    status = 'confirmed';
    onChainBalance = '120';
    tick(4000);

    const [entry] = service.entries();
    expect(entry.reconciliation).toBe('diverged');
    expect(entry.effect!.actual).toBe('120');
    expect(service.optimisticValue('holder-balance', 7, ADDRESS)).toBeNull();
    expect(service.notices(7).map((n) => n.hash)).toEqual(['0xsub']);

    service.acknowledge('0xsub');
    expect(service.notices(7)).toEqual([]);
    discardPeriodicTasks();
  }));

  it('failure requiring rollback: the optimistic value is withdrawn with a notice', fakeAsync(() => {
    const service = createService();
    service.register('0xclaim', 'claim', { kind: 'claimable-credits', bondId: 7, address: ADDRESS, expected: '0' });
    tick(0);
    expect(service.optimisticValue('claimable-credits', 7, ADDRESS)).toBe('0');

    status = 'failed';
    tick(4000);

    const [entry] = service.entries();
    expect(entry).toEqual(jasmine.objectContaining({ status: 'failed', reconciliation: 'rolled_back', rollbackReason: 'failed' }));
    expect(service.optimisticValue('claimable-credits', 7, ADDRESS)).toBeNull();
    expect(service.notices(7).length).toBe(1);
    discardPeriodicTasks();
  }));

  it('surfaces a long-pending transaction, then rolls it back once its window has passed', fakeAsync(() => {
    const service = createService();
    service.register('0xslow', 'subscribe', holderEffect('150'));

    tick(DELAYED_AFTER_MS);
    expect(service.entries()[0].reconciliation).toBe('delayed');
    expect(service.notices(7).length).toBe(1);
    expect(service.optimisticValue('holder-balance', 7, ADDRESS)).toBe('150');

    tick(EXPIRED_AFTER_MS - DELAYED_AFTER_MS);
    expect(service.entries()[0]).toEqual(
      jasmine.objectContaining({ status: 'failed', reconciliation: 'rolled_back', rollbackReason: 'expired' }),
    );
    expect(service.optimisticValue('holder-balance', 7, ADDRESS)).toBeNull();
    discardPeriodicTasks();
  }));

  it('survives a reload: a new instance resumes polling and reconciles', fakeAsync(() => {
    createService().register('0xsub', 'subscribe', holderEffect('150'));
    tick(0);

    // Simulated page reload: a fresh service reads the persisted entry.
    const reloaded = createService();
    expect(reloaded.optimisticValue('holder-balance', 7, ADDRESS)).toBe('150');

    status = 'confirmed';
    onChainBalance = '150';
    tick(4000);
    expect(reloaded.entries()[0].reconciliation).toBe('matched');
    discardPeriodicTasks();
  }));

  it('retries reconciliation of a confirmed transaction after a reload if the read had failed', fakeAsync(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([
      { hash: '0xsub', operation: 'subscribe', status: 'confirmed', submittedAt: Date.now(), effect: holderEffect('150'), reconciliation: 'awaiting' },
    ]));
    onChainBalance = '150';

    const service = createService();
    tick(0);
    expect(service.entries()[0].reconciliation).toBe('matched');
  }));

  it('leaves entries without an effect on the original status-only behaviour', fakeAsync(() => {
    const service = createService();
    service.register('0xlist', 'list');
    status = 'confirmed';
    tick(0);

    expect(service.entries()[0]).toEqual(jasmine.objectContaining({ status: 'confirmed' }));
    expect(service.entries()[0].reconciliation).toBeUndefined();
    discardPeriodicTasks();
  }));

  it('keeps waiting through a failed status request instead of rolling back', fakeAsync(() => {
    let calls = 0;
    api.getTransactionStatus.and.callFake((hash: string) =>
      ++calls === 1 ? (throwError(() => new Error('network')) as Observable<never>) : of({ hash, status: 'confirmed' as const }),
    );
    onChainBalance = '150';
    const service = createService();
    service.register('0xsub', 'subscribe', holderEffect('150'));

    tick(0);
    expect(service.entries()[0]).toEqual(jasmine.objectContaining({ status: 'pending', reconciliation: 'awaiting' }));

    tick(4000);
    expect(service.entries()[0].reconciliation).toBe('matched');
    discardPeriodicTasks();
  }));
});
