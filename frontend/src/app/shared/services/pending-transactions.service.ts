import { Injectable, inject, signal, computed } from '@angular/core';
import { Observable, Subscription, catchError, map, of, retry, timer, switchMap, takeWhile } from 'rxjs';
import { ApiService } from './api.service';
import { TransactionStatus } from '../interfaces/bond.interface';

/**
 * A value the UI shows before the transaction that produces it is confirmed
 * (#209). `expected` is what the user sees optimistically; `actual` is the
 * on-chain value read after confirmation. Both are integer strings in the
 * unit of the value they describe (bond tokens, credit minor units).
 */
export interface OptimisticEffect {
  kind: OptimisticKind;
  bondId: number;
  address: string;
  expected: string;
  actual?: string;
}

/** On-chain reads an optimistic value can be reconciled against. */
export type OptimisticKind = 'holder-balance' | 'claimable-credits';

/**
 * - `awaiting`    — submitted, optimistic value shown.
 * - `delayed`     — still unconfirmed past DELAYED_AFTER_MS; surfaced to the user.
 * - `matched`     — confirmed and the on-chain value equals the optimistic one.
 * - `diverged`    — confirmed, but another transaction changed the value first.
 * - `rolled_back` — failed, or never confirmed within its validity window; the
 *                   optimistic value is withdrawn and the user is told.
 */
export type Reconciliation = 'awaiting' | 'delayed' | 'matched' | 'diverged' | 'rolled_back';

export interface PendingTx {
  hash: string;
  operation: string;
  status: TransactionStatus;
  submittedAt: number;
  effect?: OptimisticEffect;
  reconciliation?: Reconciliation;
  /** Why an optimistic value was rolled back. */
  rollbackReason?: 'failed' | 'expired';
  /** The user has read the outcome notice. */
  acknowledged?: boolean;
}

const STORAGE_KEY = 'nbs_pending_txs';
const POLL_INTERVAL_MS = 4000;

/**
 * The API builds every transaction with a 30-second validity window
 * (`TransactionBuilder.setTimeout(30)` in api/src/stellar/contract.service.ts);
 * after it, the network rejects the transaction as too late. Past one minute
 * the user is told the confirmation is taking longer than expected. Past five
 * minutes — ten times the window, allowing for clock skew and RPC ingestion lag,
 * and far inside Stellar RPC's ~7-day getTransaction retention — a transaction
 * RPC still cannot find was not applied.
 */
export const DELAYED_AFTER_MS = 60_000;
export const EXPIRED_AFTER_MS = 5 * 60_000;

function loadFromStorage(): PendingTx[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/**
 * Tracks submitted Soroban transactions across pending/confirmed/failed
 * states, persisted to localStorage (mirrors AuthService.token's
 * seed-from-localStorage pattern) so a page refresh doesn't lose visibility
 * into a still-pending transaction. Polls api/src/stellar's
 * GET /stellar/transactions/:hash via ApiService.getTransactionStatus.
 *
 * Optimistic updates (#209) ride on the same entries: the effect is persisted
 * with its transaction hash BEFORE any view renders it (views read it from this
 * service), so an in-flight optimistic value survives a reload and is
 * reconciled against the chain when the transaction settles. Every entry
 * operation is O(n) in the number of tracked transactions.
 */
@Injectable({ providedIn: 'root' })
export class PendingTransactionsService {
  private readonly apiService = inject(ApiService);

  readonly entries = signal<PendingTx[]>(loadFromStorage());
  readonly pendingCount = computed(() => this.entries().filter((e) => e.status === 'pending').length);

  private readonly polls = new Map<string, Subscription>();

  constructor() {
    // Resume anything unfinished from a previous session/refresh: polling for
    // pending transactions, reconciliation for confirmed-but-unchecked ones.
    for (const entry of this.entries()) {
      if (entry.status === 'pending') this.poll(entry.hash);
      else if (entry.status === 'confirmed' && entry.reconciliation === 'awaiting') this.reconcile(entry.hash);
    }
  }

  register(hash: string | undefined, operation: string, effect?: OptimisticEffect): void {
    if (!hash) return;
    const entry: PendingTx = {
      hash,
      operation,
      status: 'pending',
      submittedAt: Date.now(),
      ...(effect ? { effect, reconciliation: 'awaiting' as const } : {}),
    };
    this.entries.update((entries) => [entry, ...entries.filter((e) => e.hash !== hash)]);
    this.persist();
    this.poll(hash);
  }

  /**
   * The value to display for `kind` on this bond and wallet while a transaction
   * that changes it is unconfirmed, or null to display the on-chain value.
   */
  optimisticValue(kind: OptimisticKind, bondId: number, address: string | null): string | null {
    if (!address) return null;
    const entry = this.entries().find(
      (e) =>
        e.status === 'pending' &&
        e.effect?.kind === kind &&
        e.effect.bondId === bondId &&
        e.effect.address === address,
    );
    return entry?.effect?.expected ?? null;
  }

  /** Outcomes the user still has to be told about for one bond. */
  notices(bondId: number): PendingTx[] {
    return this.entries().filter(
      (e) =>
        e.effect?.bondId === bondId &&
        !e.acknowledged &&
        (e.reconciliation === 'delayed' || e.reconciliation === 'diverged' || e.reconciliation === 'rolled_back'),
    );
  }

  acknowledge(hash: string): void {
    this.patch(hash, { acknowledged: true });
  }

  private poll(hash: string): void {
    this.polls.get(hash)?.unsubscribe();
    const sub = timer(0, POLL_INTERVAL_MS)
      .pipe(
        // A failed status request says nothing about the transaction itself;
        // keep treating it as pending and let the expiry rule end the wait.
        switchMap(() =>
          this.apiService.getTransactionStatus(hash).pipe(catchError(() => of({ hash, status: 'pending' as const }))),
        ),
        takeWhile((res) => res.status === 'pending' && !this.expire(hash), true),
      )
      .subscribe((res) => this.updateStatus(hash, res.status));
    this.polls.set(hash, sub);
  }

  /** Applies the age rules to a still-pending entry; true once it has expired. */
  private expire(hash: string): boolean {
    const entry = this.find(hash);
    if (!entry) return true;
    const age = Date.now() - entry.submittedAt;

    if (age >= EXPIRED_AFTER_MS) {
      this.patch(hash, {
        status: 'failed',
        ...(entry.effect ? { reconciliation: 'rolled_back' as const, rollbackReason: 'expired' as const, acknowledged: false } : {}),
      });
      return true;
    }
    if (age >= DELAYED_AFTER_MS && entry.reconciliation === 'awaiting') {
      this.patch(hash, { reconciliation: 'delayed', acknowledged: false });
    }
    return false;
  }

  private updateStatus(hash: string, status: TransactionStatus): void {
    const entry = this.find(hash);
    if (!entry || entry.status !== 'pending') return;

    if (status === 'failed' && entry.effect) {
      this.patch(hash, { status, reconciliation: 'rolled_back', rollbackReason: 'failed', acknowledged: false });
    } else if (status === 'confirmed' && entry.effect) {
      this.patch(hash, { status, reconciliation: 'awaiting' });
      this.reconcile(hash);
    } else {
      this.patch(hash, { status });
    }
    if (status !== 'pending') this.polls.get(hash)?.unsubscribe();
  }

  /** Compares a confirmed transaction's optimistic value with the chain. */
  private reconcile(hash: string): void {
    const effect = this.find(hash)?.effect;
    if (!effect) return;

    this.readActual(effect)
      .pipe(retry({ count: 3, delay: POLL_INTERVAL_MS }))
      .subscribe({
        next: (actual) =>
          this.patch(hash, {
            effect: { ...effect, actual },
            reconciliation: actual === effect.expected ? 'matched' : 'diverged',
            acknowledged: actual === effect.expected,
          }),
        // Stays `awaiting`; the constructor retries on the next load. The view
        // already shows on-chain values once the transaction is confirmed.
        error: () => undefined,
      });
  }

  private readActual(effect: OptimisticEffect): Observable<string> {
    switch (effect.kind) {
      case 'holder-balance':
        return this.apiService
          .getBondDetail(effect.bondId, { bustCache: true })
          .pipe(map((detail) => detail.holders.find((h) => h.address === effect.address)?.balance ?? '0'));
      case 'claimable-credits':
        return this.apiService
          .getClaimableCredits(effect.bondId, effect.address)
          .pipe(map((claimable) => claimable.total));
    }
  }

  private find(hash: string): PendingTx | undefined {
    return this.entries().find((e) => e.hash === hash);
  }

  private patch(hash: string, changes: Partial<PendingTx>): void {
    this.entries.update((entries) => entries.map((e) => (e.hash === hash ? { ...e, ...changes } : e)));
    this.persist();
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.entries()));
    } catch {
      // localStorage may be unavailable (private browsing, quota) — visibility
      // just won't survive a refresh in that case.
    }
  }
}
