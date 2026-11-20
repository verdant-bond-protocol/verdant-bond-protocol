import { Injectable, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Observable, firstValueFrom } from 'rxjs';
import { ApiService, ApiProblemError, BondDetailResponse } from './api.service';
import { PendingTransactionsService } from './pending-transactions.service';
import { WalletService } from '../../auth/wallet.service';
import { AuthService } from '../../auth/auth.service';

/** Bond mutations that can wait for connectivity (#381). */
export type QueuedOperationKind = 'subscribe' | 'transfer';

/**
 * - `queued`   — waiting to be sent.
 * - `conflict` — the bond changed since the user queued it; waits for a choice.
 * - `failed`   — the API rejected it; waits for a choice.
 */
export type QueuedOperationStatus = 'queued' | 'conflict' | 'failed';

export interface QueuedOperationInput {
  kind: QueuedOperationKind;
  bondId: number;
  /** Wallet that queued the operation; only that wallet's session sends it. */
  address: string;
  amount: number;
  /** Recipient, for `transfer`. */
  toAddress?: string;
}

export interface QueuedOperation extends QueuedOperationInput {
  /** Also the `Idempotency-Key` of every send, so a replay never executes twice. */
  id: string;
  /** Total order of the queue; ties (two tabs enqueueing at once) break on `id`. */
  seq: number;
  enqueuedAt: number;
  /** The caller's holder balance the user saw when queuing. */
  basisBalance: string;
  status: QueuedOperationStatus;
  /** Why the operation stopped, shown next to the retry/discard choice. */
  reason?: string;
  /** Set by `retry()`: the next send accepts the bond's state at that moment. */
  rebase?: boolean;
}

interface QueueState {
  nextSeq: number;
  ops: QueuedOperation[];
}

export const QUEUE_STORAGE_KEY = 'nbs_operation_queue';
const DRAIN_LOCK = 'nbs_operation_queue_drain';
/** Delay before re-draining after a transient failure while online. */
export const TRANSIENT_RETRY_MS = 15_000;
/**
 * The API deduplicates an `Idempotency-Key` for IDEMPOTENCY_TTL_SECONDS
 * (default 24h, docs/idempotency.md). Past that, a replay is executed as a new
 * request, so an operation older than this needs the user's explicit choice.
 * One hour of margin covers clock skew and a slow send.
 */
export const IDEMPOTENCY_WINDOW_MS = 23 * 60 * 60 * 1000;

const EMPTY_STATE: QueueState = { nextSeq: 1, ops: [] };

const bySeq = (a: QueuedOperation, b: QueuedOperation): number =>
  a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function parseState(raw: string | null): QueueState {
  try {
    const parsed = raw ? (JSON.parse(raw) as QueueState) : null;
    return parsed && Array.isArray(parsed.ops) && Number.isInteger(parsed.nextSeq) ? parsed : EMPTY_STATE;
  } catch {
    return EMPTY_STATE;
  }
}

/** True when the request never got a definitive answer, so sending again is safe. */
export function isTransientFailure(error: unknown): boolean {
  const status =
    error instanceof ApiProblemError ? error.problem.status : error instanceof HttpErrorResponse ? error.status : -1;
  // 409: on the subscribe/transfer routes only the API's idempotency layer
  // answers 409 — "already in progress" or "state unavailable", both resolved
  // by resending — or "reused with a different payload", which a replay cannot
  // trigger because it resends the same key with the same body. The RFC 7807
  // filter replaces the message with a generic `detail`, so the status is all
  // the client can rely on. A key stuck in progress is bounded by the
  // IDEMPOTENCY_WINDOW_MS check, which then hands the choice to the user.
  return [0, 408, 409, 429, 502, 503, 504].includes(status);
}

/**
 * Conflict-aware queue for bond mutations made while offline or interrupted
 * (#381).
 *
 * - Durable: state lives in localStorage, so queued work survives a refresh,
 *   a closed tab or a disconnect.
 * - Multi-tab: every tab sees the same queue (`storage` events), and an
 *   exclusive Web Lock serialises sending across tabs. Where Web Locks are missing, the
 *   per-operation `Idempotency-Key` still stops a double send server-side.
 * - Conflict-aware: before sending, the bond is re-read; an operation whose
 *   basis has changed, or that can no longer succeed, stops in `conflict`.
 * - Deterministic: operations are sent strictly in `seq` order, and one that
 *   stops blocks later operations on the same bond and wallet until the user
 *   picks `retry()` or `discard()`.
 *
 * Every queue mutation is O(n) in the number of queued operations; a drain
 * makes at most two requests per operation.
 */
@Injectable({ providedIn: 'root' })
export class OperationQueueService {
  private readonly api = inject(ApiService);
  private readonly pendingTx = inject(PendingTransactionsService);
  private readonly wallet = inject(WalletService);
  private readonly auth = inject(AuthService);

  /** Used instead of storage once storage refuses a write (private mode, quota). */
  private memory: QueueState | null = null;
  readonly entries = signal<QueuedOperation[]>([...this.readState().ops].sort(bySeq));

  private draining: Promise<void> | null = null;
  private drainRequested = false;
  private retryTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    window.addEventListener('storage', (event) => {
      if (event.key === QUEUE_STORAGE_KEY) this.entries.set([...this.readState().ops].sort(bySeq));
    });
    window.addEventListener('online', () => void this.drain());
    void this.drain();
  }

  forBond(bondId: number): QueuedOperation[] {
    return this.entries().filter((op) => op.bondId === bondId);
  }

  /**
   * Queue an operation, then try to send it if the browser is online. Pass the
   * `Idempotency-Key` of an attempt that may already have reached the API, so
   * the queued send is deduplicated against it.
   */
  enqueue(
    input: QueuedOperationInput,
    basisBalance: string,
    id = this.api.generateIdempotencyKey(input.kind),
  ): QueuedOperation {
    let created!: QueuedOperation;
    this.update((state) => {
      created = {
        ...input,
        id,
        seq: state.nextSeq,
        enqueuedAt: Date.now(),
        basisBalance,
        status: 'queued',
      };
      return { nextSeq: state.nextSeq + 1, ops: [...state.ops, created] };
    });
    void this.drain();
    return created;
  }

  /** Send again, accepting the bond's state at that moment as the new basis. */
  retry(id: string): void {
    this.patch(id, { status: 'queued', reason: undefined, rebase: true });
    void this.drain();
  }

  discard(id: string): void {
    this.update((state) => ({ ...state, ops: state.ops.filter((op) => op.id !== id) }));
  }

  /**
   * Send every sendable operation in order. A call made while a run is in
   * progress does not start a second, concurrent run; it makes the current
   * run go round once more, so work queued meanwhile is never skipped.
   */
  drain(): Promise<void> {
    this.drainRequested = true;
    this.draining ??= this.runRequestedDrains().finally(() => (this.draining = null));
    return this.draining;
  }

  private async runRequestedDrains(): Promise<void> {
    while (this.drainRequested) {
      this.drainRequested = false;
      await this.withDrainLock(() => this.drainInOrder());
    }
  }

  private async withDrainLock(run: () => Promise<void>): Promise<void> {
    const locks = navigator.locks as LockManager | undefined;
    if (!locks) return run();
    // Wait for the lock rather than skip: the holder may have listed the
    // queue before this tab added to it. Each run re-reads storage, so work
    // the holder already sent is not sent again.
    await locks.request(DRAIN_LOCK, run);
  }

  private async drainInOrder(): Promise<void> {
    const address = this.wallet.address();
    if (!navigator.onLine || !address || !this.auth.sessionReady()) return;

    const stopped = new Set<string>();
    // Re-read before each operation: another tab may have sent or discarded it.
    for (const { id } of this.readState().ops.slice().sort(bySeq)) {
      const op = this.readState().ops.find((o) => o.id === id);
      if (!op || op.address !== address) continue;

      const lane = `${op.bondId}:${op.address}`;
      if (op.status !== 'queued' || stopped.has(lane)) {
        stopped.add(lane);
        continue;
      }
      if (!(await this.send(op))) {
        stopped.add(lane);
        if (this.readState().ops.find((o) => o.id === id)?.status === 'queued') return; // transient: try later
      }
    }
  }

  /** Returns true when the operation was sent and removed from the queue. */
  private async send(op: QueuedOperation): Promise<boolean> {
    let detail: BondDetailResponse;
    try {
      detail = await firstValueFrom(this.api.getBondDetail(op.bondId, { bustCache: true }));
    } catch (error) {
      return this.onSendError(op, error);
    }

    const balance = detail.holders.find((h) => h.address === op.address)?.balance ?? '0';
    const conflict = this.conflictReason(op, detail, balance);
    if (conflict) {
      this.patch(op.id, { status: 'conflict', reason: conflict, rebase: false });
      return false;
    }

    try {
      const request$: Observable<{ transactionHash: string }> =
        op.kind === 'subscribe'
          ? this.api.subscribeToBond(op.bondId, op.amount, op.id)
          : this.api.transferBond(op.bondId, op.toAddress ?? '', op.amount, op.id);
      const response = await firstValueFrom(request$);
      this.discard(op.id);
      this.pendingTx.register(
        response.transactionHash,
        op.kind,
        op.kind === 'subscribe'
          ? {
              kind: 'holder-balance',
              bondId: op.bondId,
              address: op.address,
              expected: (BigInt(balance) + BigInt(op.amount)).toString(),
            }
          : undefined,
      );
      return true;
    } catch (error) {
      return this.onSendError(op, error);
    }
  }

  private onSendError(op: QueuedOperation, error: unknown): false {
    if (isTransientFailure(error)) {
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => void this.drain(), TRANSIENT_RETRY_MS);
    } else {
      const message = error instanceof Error && error.message ? error.message : 'The request was rejected';
      this.patch(op.id, { status: 'failed', reason: message, rebase: false });
    }
    return false;
  }

  /**
   * Why `op` must not be sent against the bond as it is now, or null.
   * Conditions that make the call fail on-chain always stop it; a changed
   * balance or an expired idempotency window stop it unless the user chose
   * `retry()` after seeing that state.
   */
  private conflictReason(op: QueuedOperation, detail: BondDetailResponse, balance: string): string | null {
    const { bond } = detail;
    if (bond.status !== 'Active' || detail.maturity.reached) {
      return `Bond #${bond.id} is no longer open (${detail.maturity.reached ? 'matured' : bond.status}).`;
    }
    if (op.kind === 'subscribe') {
      const remaining = BigInt(bond.totalSupply) - BigInt(bond.totalSubscribed);
      if (remaining < BigInt(op.amount)) return `Only ${remaining} tokens remain unsubscribed.`;
    } else if (BigInt(balance) < BigInt(op.amount)) {
      return `Your balance is ${balance}, below the ${op.amount} tokens to transfer.`;
    }

    if (op.rebase) return null;
    if (Date.now() - op.enqueuedAt > IDEMPOTENCY_WINDOW_MS) {
      return 'Queued over 23 hours ago; the API no longer guarantees it is sent only once.';
    }
    if (balance !== op.basisBalance) {
      return `Your balance changed from ${op.basisBalance} to ${balance} since this was queued; it may already have been applied.`;
    }
    return null;
  }

  private patch(id: string, changes: Partial<QueuedOperation>): void {
    this.update((state) => ({
      ...state,
      ops: state.ops.map((op) =>
        op.id === id
          ? { ...op, ...changes, ...(changes.rebase ? { enqueuedAt: Date.now() } : {}) }
          : op,
      ),
    }));
  }

  private readState(): QueueState {
    if (this.memory) return this.memory;
    try {
      return parseState(localStorage.getItem(QUEUE_STORAGE_KEY));
    } catch {
      return EMPTY_STATE;
    }
  }

  /** Read-modify-write against storage, so a change from another tab is never overwritten. */
  private update(change: (state: QueueState) => QueueState): void {
    const next = change(this.readState());
    if (!this.memory) {
      try {
        localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Storage refused the write: the queue keeps working for this tab's
        // lifetime but no longer survives a refresh or reaches other tabs.
        this.memory = next;
      }
    } else {
      this.memory = next;
    }
    this.entries.set([...next.ops].sort(bySeq));
  }
}
