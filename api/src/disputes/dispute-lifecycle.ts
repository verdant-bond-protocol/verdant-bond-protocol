import { createHash } from 'crypto';

/**
 * Dispute lifecycle with evidence, deadlines, and resolution (issue #625).
 *
 * A holder (claimant) disputes an amount owed by a counterparty (respondent)
 * on a bond. Opening a dispute places a hold on the disputed amount; every way
 * a dispute ends releases that hold exactly once, split between the parties.
 *
 *   open ──(evidence deadline)──▶ under_review ──(arbiter ruling)──▶ resolved
 *     │                               │
 *     │                               └──(resolution deadline)──▶ expired
 *     └──(claimant withdraws, any time before a final state)──▶ withdrawn
 *
 * - Evidence is accepted from either party until the evidence deadline. The
 *   same party resubmitting the same content hash is a no-op (safe retry).
 * - An arbiter who is not a party rules after the evidence deadline and before
 *   the resolution deadline. A dispute nobody rules on in time expires, and the
 *   held amount goes back to the respondent (the status quo).
 * - Money conservation: every settlement pays `toClaimant + toRespondent ===
 *   amount`, both non-negative, and is checked before anything is written.
 * - Settlement is two-phase. The intended split is first recorded on the
 *   dispute (`pendingSettlement`) with a version check, then the ledger is
 *   called, then the final state is written. A ledger failure leaves the
 *   intent in place; a retry or `sweep` finishes that same split, and no other
 *   split can be started meanwhile. Two racing finalizations cannot both pay.
 * - Opening is idempotent per (claimant, idempotency key). A failed hold
 *   stores nothing; a failed write after a successful hold releases the hold.
 */

export type DisputeStatus = 'open' | 'under_review' | 'resolved' | 'withdrawn' | 'expired';
export type DisputeOutcome = 'upheld' | 'rejected' | 'split';
export type PartyRole = 'claimant' | 'respondent';
export type ActorRole = 'arbiter' | 'admin';

export const FINAL_STATUSES: readonly DisputeStatus[] = ['resolved', 'withdrawn', 'expired'];

export interface DisputeActor {
  id: string;
  roles?: ActorRole[];
}

export interface Evidence {
  id: string;
  submittedBy: string;
  role: PartyRole;
  /** sha256 hex digest or IPFS CID of the evidence document. */
  contentHash: string;
  description: string;
  submittedAt: number;
}

export interface Resolution {
  outcome: DisputeOutcome;
  /** Stroops as a decimal string. */
  toClaimant: string;
  toRespondent: string;
  rationale: string;
  resolvedBy: string;
  resolvedAt: number;
}

export interface PendingSettlement {
  status: 'resolved' | 'withdrawn' | 'expired';
  toClaimant: string;
  toRespondent: string;
  resolution?: Resolution;
  actor: string;
}

export interface DisputeEvent {
  type: 'opened' | 'evidence_submitted' | 'review_started' | 'settlement_started' | 'resolved' | 'withdrawn' | 'expired';
  actor: string;
  at: number;
  detail?: string;
}

export interface Dispute {
  id: string;
  subjectId: string;
  claimantId: string;
  respondentId: string;
  /** Held amount in stroops as a decimal string. */
  amount: string;
  reason: string;
  status: DisputeStatus;
  openedAt: number;
  evidenceDeadline: number;
  resolutionDeadline: number;
  evidence: Evidence[];
  resolution?: Resolution;
  pendingSettlement?: PendingSettlement;
  /** Incremented on every write; used for compare-and-set. */
  version: number;
  history: DisputeEvent[];
}

export interface OpenDisputeInput {
  idempotencyKey: string;
  subjectId: string;
  respondentId: string;
  amount: string;
  reason: string;
}

export interface EvidenceInput {
  contentHash: string;
  description: string;
}

export interface RulingInput {
  outcome: DisputeOutcome;
  /** Required for `split`; ignored otherwise. */
  toClaimant?: string;
  rationale: string;
}

/** Holds and pays out disputed funds. Every method must be idempotent per disputeId. */
export interface SettlementPort {
  hold(disputeId: string, amount: bigint): void | Promise<void>;
  /** Undo a hold for a dispute that was never recorded (compensation only). */
  release(disputeId: string): void | Promise<void>;
  /** Pay out the held amount. Called with the same split on every retry. */
  settle(disputeId: string, toClaimant: bigint, toRespondent: bigint): void | Promise<void>;
}

export interface DisputeStore {
  get(id: string): Dispute | undefined | Promise<Dispute | undefined>;
  list(): Dispute[] | Promise<Dispute[]>;
  /**
   * Write `dispute` only if the stored version equals `expectedVersion`
   * (0 = must not exist yet). Throws DisputeError('conflict') otherwise.
   */
  save(dispute: Dispute, expectedVersion: number): void | Promise<void>;
}

export type DisputeErrorCode =
  | 'forbidden'
  | 'invalid'
  | 'not_found'
  | 'conflict'
  | 'invalid_state'
  | 'deadline_passed'
  | 'hold_failed'
  | 'settlement_failed';

export class DisputeError extends Error {
  constructor(
    public readonly code: DisputeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DisputeError';
  }

  /** True when the same call may succeed if repeated unchanged. */
  get retryable(): boolean {
    return this.code === 'conflict' || this.code === 'hold_failed' || this.code === 'settlement_failed';
  }
}

export interface DisputeLifecycleOptions {
  evidenceWindowMs?: number;
  reviewWindowMs?: number;
  maxEvidencePerParty?: number;
  /** Upper bound for a disputed amount, in stroops. */
  maxAmount?: bigint;
  clock?: () => number;
}

export interface SweepReport {
  reviewStarted: string[];
  expired: string[];
  completed: string[];
  failed: { id: string; code: DisputeErrorCode | 'error'; message: string }[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/;
const AMOUNT = /^[1-9][0-9]*$/;
const MAX_TEXT = 2000;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const isFinal = (s: DisputeStatus) => FINAL_STATUSES.includes(s);

export class InMemoryDisputeStore implements DisputeStore {
  private readonly rows = new Map<string, Dispute>();

  get(id: string): Dispute | undefined {
    const row = this.rows.get(id);
    return row ? clone(row) : undefined;
  }

  list(): Dispute[] {
    return [...this.rows.values()].map(clone);
  }

  save(dispute: Dispute, expectedVersion: number): void {
    const current = this.rows.get(dispute.id)?.version ?? 0;
    if (current !== expectedVersion) {
      throw new DisputeError('conflict', `dispute ${dispute.id} changed (version ${current}, expected ${expectedVersion})`);
    }
    this.rows.set(dispute.id, clone(dispute));
  }
}

export class DisputeLifecycle {
  private readonly evidenceWindowMs: number;
  private readonly reviewWindowMs: number;
  private readonly maxEvidencePerParty: number;
  private readonly maxAmount: bigint;
  private readonly clock: () => number;

  constructor(
    private readonly store: DisputeStore,
    private readonly settlement: SettlementPort,
    options: DisputeLifecycleOptions = {},
  ) {
    this.evidenceWindowMs = options.evidenceWindowMs ?? 7 * DAY_MS;
    this.reviewWindowMs = options.reviewWindowMs ?? 14 * DAY_MS;
    this.maxEvidencePerParty = options.maxEvidencePerParty ?? 20;
    this.maxAmount = options.maxAmount ?? 10n ** 18n;
    this.clock = options.clock ?? Date.now;
    if (!(this.evidenceWindowMs > 0) || !(this.reviewWindowMs > 0) || !(this.maxEvidencePerParty > 0)) {
      throw new DisputeError('invalid', 'windows and evidence limit must be positive');
    }
  }

  /** Deterministic id so a retried open maps to the same dispute. */
  static disputeId(claimantId: string, idempotencyKey: string): string {
    return `dsp_${sha(`${claimantId}\u0000${idempotencyKey}`).slice(0, 24)}`;
  }

  async open(actor: DisputeActor, input: OpenDisputeInput): Promise<Dispute> {
    this.requireActor(actor);
    const key = this.text(input.idempotencyKey, 'idempotencyKey', 128);
    const subjectId = this.text(input.subjectId, 'subjectId', 128);
    const respondentId = this.text(input.respondentId, 'respondentId', 128);
    const reason = this.text(input.reason, 'reason', MAX_TEXT);
    const amount = this.amount(input.amount);
    if (respondentId === actor.id) {
      throw new DisputeError('invalid', 'a party cannot dispute against itself');
    }

    const id = DisputeLifecycle.disputeId(actor.id, key);
    const existing = await this.store.get(id);
    if (existing) {
      const same =
        existing.subjectId === subjectId &&
        existing.respondentId === respondentId &&
        existing.amount === amount.toString() &&
        existing.reason === reason;
      if (!same) throw new DisputeError('conflict', 'idempotency key reused with a different request');
      return existing;
    }

    const active = (await this.store.list()).find(
      (d) => d.subjectId === subjectId && d.claimantId === actor.id && !isFinal(d.status),
    );
    if (active) {
      throw new DisputeError('conflict', `an active dispute (${active.id}) already exists for this subject`);
    }

    const now = this.clock();
    const dispute: Dispute = {
      id,
      subjectId,
      claimantId: actor.id,
      respondentId,
      amount: amount.toString(),
      reason,
      status: 'open',
      openedAt: now,
      evidenceDeadline: now + this.evidenceWindowMs,
      resolutionDeadline: now + this.evidenceWindowMs + this.reviewWindowMs,
      evidence: [],
      version: 1,
      history: [{ type: 'opened', actor: actor.id, at: now }],
    };

    try {
      await this.settlement.hold(id, amount);
    } catch (err) {
      throw new DisputeError('hold_failed', `could not hold disputed funds: ${(err as Error).message}`);
    }

    try {
      await this.store.save(dispute, 0);
    } catch (err) {
      const raced = await Promise.resolve()
        .then(() => this.store.get(id))
        .catch(() => undefined);
      if (raced) {
        // A concurrent retry with the same key won; its hold is the same hold.
        if (raced.amount === dispute.amount && raced.subjectId === subjectId && raced.respondentId === respondentId) {
          return raced;
        }
        throw new DisputeError('conflict', 'idempotency key reused with a different request');
      }
      try {
        await this.settlement.release(id);
      } catch (releaseErr) {
        throw new DisputeError(
          'hold_failed',
          `dispute not recorded and hold release failed (reconcile hold ${id}): ${(releaseErr as Error).message}`,
        );
      }
      throw err;
    }
    return clone(dispute);
  }

  async get(actor: DisputeActor, id: string): Promise<Dispute> {
    this.requireActor(actor);
    const d = await this.load(id);
    if (!this.isParty(actor, d) && !this.hasRole(actor, 'arbiter') && !this.hasRole(actor, 'admin')) {
      throw new DisputeError('forbidden', 'not a party to this dispute');
    }
    return d;
  }

  async submitEvidence(actor: DisputeActor, id: string, input: EvidenceInput): Promise<Evidence> {
    this.requireActor(actor);
    const d = await this.load(id);
    const role = this.partyRole(actor, d);
    if (!role) throw new DisputeError('forbidden', 'only the claimant or respondent may submit evidence');

    const contentHash = this.text(input.contentHash, 'contentHash', 128);
    if (!SHA256_HEX.test(contentHash) && !CID.test(contentHash)) {
      throw new DisputeError('invalid', 'contentHash must be a sha256 hex digest or an IPFS CID');
    }
    const description = this.text(input.description, 'description', MAX_TEXT);

    const duplicate = d.evidence.find((e) => e.role === role && e.contentHash === contentHash);
    if (duplicate) return duplicate;

    if (isFinal(d.status) || d.pendingSettlement) {
      throw new DisputeError('invalid_state', `dispute is ${d.pendingSettlement ? 'settling' : d.status}`);
    }
    const now = this.clock();
    if (now >= d.evidenceDeadline) throw new DisputeError('deadline_passed', 'evidence window has closed');
    if (d.evidence.filter((e) => e.role === role).length >= this.maxEvidencePerParty) {
      throw new DisputeError('invalid', `evidence limit of ${this.maxEvidencePerParty} reached`);
    }

    const evidence: Evidence = {
      id: `evd_${sha(`${d.id}\u0000${role}\u0000${contentHash}`).slice(0, 16)}`,
      submittedBy: actor.id,
      role,
      contentHash,
      description,
      submittedAt: now,
    };
    const expected = d.version;
    d.evidence.push(evidence);
    d.history.push({ type: 'evidence_submitted', actor: actor.id, at: now, detail: evidence.id });
    d.version += 1;
    await this.store.save(d, expected);
    return evidence;
  }

  async resolve(actor: DisputeActor, id: string, ruling: RulingInput): Promise<Dispute> {
    this.requireActor(actor);
    if (!this.hasRole(actor, 'arbiter')) throw new DisputeError('forbidden', 'only an arbiter may resolve disputes');
    const d = await this.load(id);
    if (this.isParty(actor, d)) throw new DisputeError('forbidden', 'an arbiter cannot rule on their own dispute');

    const rationale = this.text(ruling.rationale, 'rationale', MAX_TEXT);
    const amount = BigInt(d.amount);
    let toClaimant: bigint;
    if (ruling.outcome === 'upheld') toClaimant = amount;
    else if (ruling.outcome === 'rejected') toClaimant = 0n;
    else if (ruling.outcome === 'split') {
      if (typeof ruling.toClaimant !== 'string' || !/^(0|[1-9][0-9]*)$/.test(ruling.toClaimant)) {
        throw new DisputeError('invalid', 'split requires toClaimant as a non-negative integer string');
      }
      toClaimant = BigInt(ruling.toClaimant);
    } else {
      throw new DisputeError('invalid', 'outcome must be upheld, rejected, or split');
    }
    const toRespondent = amount - toClaimant;
    assertConserved(amount, toClaimant, toRespondent);

    // Retry of an already-applied ruling returns the result unchanged.
    if (d.status === 'resolved' && d.resolution) {
      if (d.resolution.outcome === ruling.outcome && d.resolution.toClaimant === toClaimant.toString()) return d;
      throw new DisputeError('conflict', 'dispute was already resolved differently');
    }
    if (d.pendingSettlement) {
      const p = d.pendingSettlement;
      if (p.status === 'resolved' && p.resolution?.outcome === ruling.outcome && p.toClaimant === toClaimant.toString()) {
        return this.completeSettlement(d);
      }
      throw new DisputeError('conflict', `a ${p.status} settlement is already in progress`);
    }
    if (isFinal(d.status)) throw new DisputeError('invalid_state', `dispute is ${d.status}`);

    const now = this.clock();
    if (now < d.evidenceDeadline) throw new DisputeError('invalid_state', 'evidence window is still open');
    if (now >= d.resolutionDeadline) throw new DisputeError('deadline_passed', 'resolution deadline has passed');

    const resolution: Resolution = {
      outcome: ruling.outcome,
      toClaimant: toClaimant.toString(),
      toRespondent: toRespondent.toString(),
      rationale,
      resolvedBy: actor.id,
      resolvedAt: now,
    };
    return this.finalize(d, {
      status: 'resolved',
      toClaimant: resolution.toClaimant,
      toRespondent: resolution.toRespondent,
      resolution,
      actor: actor.id,
    });
  }

  async withdraw(actor: DisputeActor, id: string): Promise<Dispute> {
    this.requireActor(actor);
    const d = await this.load(id);
    if (actor.id !== d.claimantId) throw new DisputeError('forbidden', 'only the claimant may withdraw');
    if (d.status === 'withdrawn') return d;
    if (d.pendingSettlement) {
      if (d.pendingSettlement.status === 'withdrawn') return this.completeSettlement(d);
      throw new DisputeError('conflict', `a ${d.pendingSettlement.status} settlement is already in progress`);
    }
    if (isFinal(d.status)) throw new DisputeError('invalid_state', `dispute is ${d.status}`);
    return this.finalize(d, { status: 'withdrawn', toClaimant: '0', toRespondent: d.amount, actor: actor.id });
  }

  /**
   * Apply deadlines and finish interrupted settlements. Safe to run often and
   * concurrently with other calls; one failing dispute never stops the rest.
   */
  async sweep(actor: DisputeActor): Promise<SweepReport> {
    this.requireActor(actor);
    if (!this.hasRole(actor, 'admin')) throw new DisputeError('forbidden', 'sweep is admin-only');
    const report: SweepReport = { reviewStarted: [], expired: [], completed: [], failed: [] };

    for (const d of await this.store.list()) {
      if (isFinal(d.status)) continue;
      try {
        if (d.pendingSettlement) {
          await this.completeSettlement(d);
          report.completed.push(d.id);
          continue;
        }
        const now = this.clock();
        if (now >= d.resolutionDeadline) {
          await this.finalize(d, { status: 'expired', toClaimant: '0', toRespondent: d.amount, actor: actor.id });
          report.expired.push(d.id);
        } else if (d.status === 'open' && now >= d.evidenceDeadline) {
          const expected = d.version;
          d.status = 'under_review';
          d.history.push({ type: 'review_started', actor: actor.id, at: now });
          d.version += 1;
          await this.store.save(d, expected);
          report.reviewStarted.push(d.id);
        }
      } catch (err) {
        report.failed.push({
          id: d.id,
          code: err instanceof DisputeError ? err.code : 'error',
          message: (err as Error).message,
        });
      }
    }
    return report;
  }

  /** Phase 1: record the intended split (CAS). Phase 2: pay it and close. */
  private async finalize(d: Dispute, pending: PendingSettlement): Promise<Dispute> {
    assertConserved(BigInt(d.amount), BigInt(pending.toClaimant), BigInt(pending.toRespondent));
    const expected = d.version;
    d.pendingSettlement = pending;
    d.history.push({ type: 'settlement_started', actor: pending.actor, at: this.clock(), detail: pending.status });
    d.version += 1;
    await this.store.save(d, expected);
    return this.completeSettlement(d);
  }

  private async completeSettlement(d: Dispute): Promise<Dispute> {
    const p = d.pendingSettlement;
    if (!p) throw new DisputeError('invalid_state', 'no settlement in progress');
    const toClaimant = BigInt(p.toClaimant);
    const toRespondent = BigInt(p.toRespondent);
    assertConserved(BigInt(d.amount), toClaimant, toRespondent);

    try {
      await this.settlement.settle(d.id, toClaimant, toRespondent);
    } catch (err) {
      throw new DisputeError('settlement_failed', `settlement failed, retry to finish: ${(err as Error).message}`);
    }

    const expected = d.version;
    d.status = p.status;
    if (p.resolution) d.resolution = p.resolution;
    delete d.pendingSettlement;
    d.history.push({ type: p.status, actor: p.actor, at: this.clock() });
    d.version += 1;
    await this.store.save(d, expected);
    return clone(d);
  }

  private async load(id: string): Promise<Dispute> {
    const d = typeof id === 'string' && id ? await this.store.get(id) : undefined;
    if (!d) throw new DisputeError('not_found', `dispute ${id} not found`);
    return d;
  }

  private requireActor(actor: DisputeActor): void {
    if (!actor || typeof actor.id !== 'string' || actor.id.trim() === '') {
      throw new DisputeError('forbidden', 'authentication required');
    }
  }

  private hasRole(actor: DisputeActor, role: ActorRole): boolean {
    return actor.roles?.includes(role) ?? false;
  }

  private isParty(actor: DisputeActor, d: Dispute): boolean {
    return this.partyRole(actor, d) !== undefined;
  }

  private partyRole(actor: DisputeActor, d: Dispute): PartyRole | undefined {
    if (actor.id === d.claimantId) return 'claimant';
    if (actor.id === d.respondentId) return 'respondent';
    return undefined;
  }

  private text(value: unknown, field: string, max: number): string {
    if (typeof value !== 'string' || value.trim() === '') throw new DisputeError('invalid', `${field} is required`);
    const v = value.trim();
    if (v.length > max) throw new DisputeError('invalid', `${field} exceeds ${max} characters`);
    return v;
  }

  private amount(value: unknown): bigint {
    if (typeof value !== 'string' || !AMOUNT.test(value)) {
      throw new DisputeError('invalid', 'amount must be a positive integer string (stroops)');
    }
    const n = BigInt(value);
    if (n > this.maxAmount) throw new DisputeError('invalid', 'amount exceeds the maximum disputable amount');
    return n;
  }
}

/** Money conservation: payouts are non-negative and sum to the held amount. */
export function assertConserved(amount: bigint, toClaimant: bigint, toRespondent: bigint): void {
  if (toClaimant < 0n || toRespondent < 0n || toClaimant + toRespondent !== amount) {
    throw new DisputeError(
      'invalid',
      `settlement ${toClaimant} + ${toRespondent} does not conserve held amount ${amount}`,
    );
  }
}
