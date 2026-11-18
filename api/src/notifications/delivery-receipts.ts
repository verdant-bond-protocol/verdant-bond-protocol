/**
 * Notification deduplication with delivery receipts (issue #539).
 *
 * Complements the decision-level dedupe in {@link NotificationsService} (#410)
 * at the *delivery* layer: one (user, event, channel) produces at most one
 * successful delivery, and every attempt leaves a receipt.
 *
 * - `begin()` claims the dedupe key. A duplicate while pending or delivered is
 *   suppressed (returns `duplicate: true`) so producer retries never send twice.
 * - A failed delivery may be retried up to `maxAttempts`; then it is
 *   `dead_lettered` and further attempts are refused.
 * - `confirm()` with the provider's receipt id is idempotent; a second confirm
 *   with a *different* receipt id is rejected as a conflict.
 * - Pending claims older than `pendingTimeoutMs` are treated as failed (the
 *   worker crashed) so the event is not stuck forever.
 * - Only the recipient or an admin may read receipts.
 */

export type DeliveryChannel = 'in_app' | 'email' | 'webhook';
export type DeliveryStatus = 'pending' | 'delivered' | 'failed' | 'dead_lettered';

export interface DeliveryAttempt {
  attempt: number;
  startedAt: string;
  finishedAt?: string;
  outcome?: 'delivered' | 'failed';
  error?: string;
}

export interface DeliveryReceipt {
  key: string;
  userId: string;
  eventId: string;
  channel: DeliveryChannel;
  status: DeliveryStatus;
  providerReceiptId?: string;
  deliveredAt?: string;
  attempts: DeliveryAttempt[];
}

export interface BeginResult {
  duplicate: boolean;
  receipt: DeliveryReceipt;
}

export class DeliveryReceiptError extends Error {
  constructor(
    public readonly code: 'not_found' | 'conflict' | 'dead_lettered' | 'forbidden' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'DeliveryReceiptError';
  }
}

export interface DeliveryLedgerOptions {
  maxAttempts?: number;
  pendingTimeoutMs?: number;
}

export const deliveryKey = (userId: string, eventId: string, channel: DeliveryChannel): string =>
  `${userId}\u0000${eventId}\u0000${channel}`;

export class DeliveryReceiptLedger {
  private readonly receipts = new Map<string, DeliveryReceipt>();
  private readonly maxAttempts: number;
  private readonly pendingTimeoutMs: number;

  constructor(opts: DeliveryLedgerOptions = {}) {
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.pendingTimeoutMs = opts.pendingTimeoutMs ?? 5 * 60 * 1000;
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new DeliveryReceiptError('invalid', 'maxAttempts must be a positive integer');
    }
  }

  begin(userId: string, eventId: string, channel: DeliveryChannel, now: number = Date.now()): BeginResult {
    if (!userId || !eventId) throw new DeliveryReceiptError('invalid', 'userId and eventId are required');
    const key = deliveryKey(userId, eventId, channel);
    const existing = this.receipts.get(key);

    if (existing) {
      if (existing.status === 'pending') {
        const last = existing.attempts[existing.attempts.length - 1];
        if (now - Date.parse(last.startedAt) < this.pendingTimeoutMs) return { duplicate: true, receipt: existing };
        this.finish(existing, 'failed', now, 'pending timeout');
      }
      if (existing.status === 'delivered') return { duplicate: true, receipt: existing };
      if (existing.status === 'dead_lettered') {
        throw new DeliveryReceiptError('dead_lettered', `delivery ${eventId} exhausted retries`);
      }
      existing.status = 'pending';
      existing.attempts.push({ attempt: existing.attempts.length + 1, startedAt: new Date(now).toISOString() });
      return { duplicate: false, receipt: existing };
    }

    const receipt: DeliveryReceipt = {
      key,
      userId,
      eventId,
      channel,
      status: 'pending',
      attempts: [{ attempt: 1, startedAt: new Date(now).toISOString() }],
    };
    this.receipts.set(key, receipt);
    return { duplicate: false, receipt };
  }

  confirm(key: string, providerReceiptId: string, now: number = Date.now()): DeliveryReceipt {
    const receipt = this.require(key);
    if (!providerReceiptId) throw new DeliveryReceiptError('invalid', 'providerReceiptId is required');
    if (receipt.status === 'delivered') {
      if (receipt.providerReceiptId === providerReceiptId) return receipt;
      throw new DeliveryReceiptError('conflict', `delivery ${receipt.eventId} already confirmed with another receipt`);
    }
    if (receipt.status !== 'pending') {
      throw new DeliveryReceiptError('conflict', `delivery ${receipt.eventId} is ${receipt.status}`);
    }
    this.finish(receipt, 'delivered', now);
    receipt.providerReceiptId = providerReceiptId;
    receipt.deliveredAt = new Date(now).toISOString();
    return receipt;
  }

  fail(key: string, error: string, now: number = Date.now()): DeliveryReceipt {
    const receipt = this.require(key);
    if (receipt.status !== 'pending') {
      throw new DeliveryReceiptError('conflict', `delivery ${receipt.eventId} is ${receipt.status}`);
    }
    this.finish(receipt, 'failed', now, error);
    return receipt;
  }

  /** Receipts for a user; callable only by that user or an admin. */
  list(userId: string, actor: { id: string; isAdmin?: boolean }): DeliveryReceipt[] {
    if (actor.id !== userId && !actor.isAdmin) {
      throw new DeliveryReceiptError('forbidden', 'cannot read another user\'s delivery receipts');
    }
    return [...this.receipts.values()]
      .filter((receipt) => receipt.userId === userId)
      .map((receipt) => ({ ...receipt, attempts: receipt.attempts.map((attempt) => ({ ...attempt })) }));
  }

  get(key: string): DeliveryReceipt | undefined {
    return this.receipts.get(key);
  }

  private require(key: string): DeliveryReceipt {
    const receipt = this.receipts.get(key);
    if (!receipt) throw new DeliveryReceiptError('not_found', 'unknown delivery');
    return receipt;
  }

  private finish(receipt: DeliveryReceipt, outcome: 'delivered' | 'failed', now: number, error?: string): void {
    const attempt = receipt.attempts[receipt.attempts.length - 1];
    attempt.finishedAt = new Date(now).toISOString();
    attempt.outcome = outcome;
    if (error) attempt.error = error;
    if (outcome === 'delivered') {
      receipt.status = 'delivered';
    } else {
      receipt.status = receipt.attempts.length >= this.maxAttempts ? 'dead_lettered' : 'failed';
    }
  }
}
