import { ConflictException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { AuditReceiptService } from '../../audit/audit-receipt.service';
import { AuditService } from '../../audit/audit.service';
import { AuditRecord } from '../../audit/audit.interface';
import { stableStringify } from '../../audit/audit.canonical';
import { AuditReceiptVerification, SignedAuditReceipt } from '../../audit/audit.receipt';
import { ApiProblemException } from '../../common/errors/problem-exception';
import { ErrorCode } from '../../common/errors/error-codes';

/**
 * Compliance and governance actions that must leave a signed receipt (#632).
 * The catalog is closed: a receipt for any other action is never treated as
 * a governance receipt by `verify`, so an ordinary audit receipt cannot be
 * passed off as proof of a governance decision.
 */
export const GOVERNANCE_RECEIPT_ACTIONS = {
  'governance.ruleset.update': { domain: 'governance', entityType: 'compliance-ruleset' },
  'compliance.sanctions.refresh': { domain: 'compliance', entityType: 'compliance-sanctions' },
  'compliance.eligibility.flush': { domain: 'compliance', entityType: 'compliance-eligibility' },
  'compliance.eligibility.invalidate': { domain: 'compliance', entityType: 'compliance-eligibility' },
} as const;

export type GovernanceReceiptAction = keyof typeof GOVERNANCE_RECEIPT_ACTIONS;

/** Only admins may *perform* these actions; auditors may only verify. */
export const GOVERNANCE_ACTOR_ROLE = 'admin';

export interface GovernanceReceiptEnvelope {
  receipt: SignedAuditReceipt;
  /** Key under which retries of this action are de-duplicated. */
  idempotencyKey: string;
  /** True when this response replays an earlier successful execution. */
  replayed: boolean;
  recordedAt: string;
}

export interface GovernanceActionRequest<T> {
  action: GovernanceReceiptAction;
  entityId: string;
  actor: string;
  actorRoles: readonly string[];
  /** Client-supplied `Idempotency-Key`; one is generated when absent. */
  idempotencyKey?: string;
  /** The request payload; part of the idempotency fingerprint. */
  request: unknown;
  reason?: string;
  /** State before the mutation (non-sensitive summary). */
  before?: Record<string, unknown> | null;
  execute: () => Promise<T> | T;
  /** Non-sensitive summary of the result that the receipt is bound to. */
  summarize: (result: T) => Record<string, unknown>;
}

export interface GovernanceActionResult<T> {
  result: T;
  signedReceipt: GovernanceReceiptEnvelope;
  record: AuditRecord;
}

export type GovernanceReceiptVerification =
  | AuditReceiptVerification
  | { ok: false; reason: 'not_a_governance_receipt' | 'record_not_found' };

type LedgerEntry<T = unknown> =
  | { state: 'executing'; fingerprint: string; createdAt: number }
  | { state: 'pending_receipt'; fingerprint: string; createdAt: number; result: T; summary: Record<string, unknown> }
  | { state: 'complete'; fingerprint: string; createdAt: number; result: T; record: AuditRecord; receipt: SignedAuditReceipt };

const MAX_LEDGER_ENTRIES = 1_000;
const LEDGER_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Executes compliance/governance mutations and binds each successful one to
 * an Ed25519-signed audit receipt (#632), built on `AuditReceiptService`
 * (#260) without changing its wire format.
 *
 * Ordering guarantees (see docs/governance-action-receipts.md):
 * 1. Authorization is checked before anything runs.
 * 2. A failed mutation issues no receipt and releases the idempotency key,
 *    so the caller may retry.
 * 3. A mutation that succeeded but whose receipt could not be written is
 *    parked as `pending_receipt`: retrying with the same key issues the
 *    receipt *without re-running the mutation*.
 * 4. A retry after success replays the stored result and receipt; it never
 *    writes a second audit entry.
 */
@Injectable()
export class GovernanceReceiptService {
  private readonly logger = new Logger(GovernanceReceiptService.name);
  private readonly ledger = new Map<string, LedgerEntry>();

  constructor(
    private readonly receipts: AuditReceiptService,
    private readonly audit: AuditService,
  ) {}

  get publicKey(): string {
    return this.receipts.publicKey;
  }

  async execute<T>(req: GovernanceActionRequest<T>): Promise<GovernanceActionResult<T>> {
    const spec = GOVERNANCE_RECEIPT_ACTIONS[req.action];
    if (!spec) {
      throw new ForbiddenException(`Action ${String(req.action)} is not a receipted governance action`);
    }
    if (!req.actor) {
      throw new ForbiddenException('A governance action requires an authenticated actor');
    }
    if (!req.actorRoles.includes(GOVERNANCE_ACTOR_ROLE)) {
      throw new ForbiddenException(`${req.action} requires the ${GOVERNANCE_ACTOR_ROLE} role`);
    }

    this.evictExpired();
    const idempotencyKey = req.idempotencyKey?.trim() || randomUUID();
    // Keys are scoped per actor and action: one admin cannot replay or block another's request.
    const ledgerKey = `${req.action}:${req.actor}:${idempotencyKey}`;
    const fingerprint = createHash('sha256')
      .update(stableStringify({ action: req.action, entityId: req.entityId, request: req.request ?? null }))
      .digest('hex');

    const existing = this.ledger.get(ledgerKey) as LedgerEntry<T> | undefined;
    if (existing && existing.fingerprint !== fingerprint) {
      throw new ConflictException('Idempotency-Key was already used with a different request payload');
    }
    if (existing?.state === 'executing') {
      throw new ConflictException('An identical governance action is already in progress; retry shortly');
    }
    if (existing?.state === 'complete') {
      return {
        result: existing.result,
        record: existing.record,
        signedReceipt: {
          receipt: existing.receipt,
          idempotencyKey,
          replayed: true,
          recordedAt: existing.record.recordedAt,
        },
      };
    }

    let result: T;
    let summary: Record<string, unknown>;
    if (existing?.state === 'pending_receipt') {
      // Recovery path: the mutation already happened; only the receipt is missing.
      this.logger.warn(`Completing pending receipt for ${req.action} (${idempotencyKey}) without re-executing`);
      result = existing.result;
      summary = existing.summary;
    } else {
      this.ledger.set(ledgerKey, { state: 'executing', fingerprint, createdAt: Date.now() });
      try {
        result = await req.execute();
        summary = req.summarize(result);
      } catch (error) {
        // Nothing was applied (or the action itself rolled back): free the key.
        this.ledger.delete(ledgerKey);
        throw error;
      }
      this.ledger.set(ledgerKey, { state: 'pending_receipt', fingerprint, createdAt: Date.now(), result, summary });
    }

    let issued: { record: AuditRecord; receipt: SignedAuditReceipt };
    try {
      issued = await this.receipts.recordPrivilegedAction(
        {
          entityType: spec.entityType,
          entityId: req.entityId,
          action: req.action,
          actor: req.actor,
          reason: req.reason,
          before: (req.before ?? null) as Record<string, any> | null,
          after: { ...summary, idempotencyKey, requestFingerprint: fingerprint },
        },
        { actorRoles: req.actorRoles },
      );
    } catch (error) {
      this.logger.error(
        `${req.action} applied but its receipt could not be issued (key ${idempotencyKey}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new ApiProblemException(ErrorCode.RECEIPT_PENDING, {
        status: 503,
        detail: 'The action was applied but its signed receipt is not yet issued.',
        context: { action: req.action, idempotencyKey, actionApplied: true },
      });
    }

    this.ledger.set(ledgerKey, {
      state: 'complete',
      fingerprint,
      createdAt: Date.now(),
      result,
      record: issued.record,
      receipt: issued.receipt,
    });
    this.enforceCapacity();

    return {
      result,
      record: issued.record,
      signedReceipt: {
        receipt: issued.receipt,
        idempotencyKey,
        replayed: false,
        recordedAt: issued.record.recordedAt,
      },
    };
  }

  /**
   * Verifies a governance receipt against the audit entry it names. Accepts
   * the current signing key plus any rotated keys listed (as a JSON array of
   * SPKI PEMs) in `AUDIT_RECEIPT_PREVIOUS_PUBLIC_KEYS`.
   */
  verify(receipt: SignedAuditReceipt): GovernanceReceiptVerification {
    const spec = receipt && GOVERNANCE_RECEIPT_ACTIONS[receipt.action as GovernanceReceiptAction];
    if (!spec || spec.entityType !== receipt.entityType) {
      return { ok: false, reason: 'not_a_governance_receipt' };
    }
    const record = this.audit
      .getEntityHistory(receipt.entityType, receipt.entityId)
      .find((r) => r.recordId === receipt.recordId);
    if (!record) {
      return { ok: false, reason: 'record_not_found' };
    }
    return this.receipts.verify(record, receipt, [this.receipts.publicKey, ...this.previousPublicKeys()]);
  }

  private previousPublicKeys(): string[] {
    const raw = process.env.AUDIT_RECEIPT_PREVIOUS_PUBLIC_KEYS;
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
    } catch {
      this.logger.warn('AUDIT_RECEIPT_PREVIOUS_PUBLIC_KEYS is not a JSON array; ignoring rotated keys');
      return [];
    }
  }

  private evictExpired(): void {
    const cutoff = Date.now() - LEDGER_TTL_MS;
    for (const [key, entry] of this.ledger) {
      // Never evict a pending receipt: it is the only record that the
      // mutation happened without a receipt, so it is needed for recovery.
      if (entry.createdAt < cutoff && entry.state === 'complete') this.ledger.delete(key);
    }
  }

  private enforceCapacity(): void {
    if (this.ledger.size <= MAX_LEDGER_ENTRIES) return;
    for (const [key, entry] of this.ledger) {
      if (this.ledger.size <= MAX_LEDGER_ENTRIES) break;
      if (entry.state === 'complete') this.ledger.delete(key);
    }
  }
}
