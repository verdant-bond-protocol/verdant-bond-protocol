import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Keypair } from '@stellar/stellar-sdk';
import { createHash, randomUUID } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { stableStringify } from '../audit/audit.canonical';
import { AdminIntent } from '../common/services/intent.service';
import {
  INTENT_RECEIPT_SIGNING_DOMAIN,
  INTENT_RECEIPT_VERSION,
  IntentReceipt,
  IntentReceiptOutcome,
  IntentReceiptQuery,
  IntentReceiptReview,
  IntentReceiptSigner,
  IntentReceiptStatus,
  IntentReceiptVerification,
  IntentReceiptView,
  REVIEW_DISPOSITIONS,
  ReviewDisposition,
  TERMINAL_STATUSES,
} from './intent-receipt.types';

/** Request facts captured alongside an intent; never the raw body. */
export interface IntentRequestContext {
  actor: string;
  route: string;
  requestId?: string | null;
  body?: unknown;
}

export const AUDIT_ENTITY_TYPE = 'intent-receipt';
export const DEFAULT_STALE_MS = 15 * 60 * 1000;
export const MAX_RECEIPTS = 10_000;
export const MAX_LIST_LIMIT = 500;
const MAX_FIELD_LENGTH = 200;
const MAX_NOTE_LENGTH = 2_000;

/**
 * Issues, transitions, stores and verifies signed intent receipts.
 *
 * Lifecycle (see docs/maintainer-intent-receipts.md):
 *
 *   IntentGuard rejects        ->  rejected            (terminal)
 *   IntentGuard accepts        ->  authorized
 *   handler returns            ->  authorized -> succeeded (terminal)
 *   handler throws             ->  authorized -> failed    (terminal)
 *   process dies mid-action    ->  authorized forever: reported `stale`,
 *                                  reconciled by a reviewer
 *
 * Every transition re-signs the receipt with the receipt signing key and is
 * appended to the hash-chained audit trail under `intent-receipt/<id>`, so
 * the receipt itself and its history are both independently checkable.
 */
@Injectable()
export class IntentReceiptService {
  private readonly logger = new Logger(IntentReceiptService.name);
  private readonly receipts = new Map<string, IntentReceipt>();
  private readonly keypair: Keypair;
  private readonly signer: IntentReceiptSigner;
  private evicted = 0;
  private auditWriteFailures = 0;
  private lateOutcomes = 0;

  constructor(private readonly audit: AuditService) {
    const secret = process.env.INTENT_RECEIPT_SIGNING_SECRET;
    if (secret) {
      try {
        this.keypair = Keypair.fromSecret(secret);
      } catch {
        // Fail at boot: a misconfigured key must never silently fall back.
        throw new Error('INTENT_RECEIPT_SIGNING_SECRET is not a valid Stellar secret key');
      }
      this.signer = { algorithm: 'ed25519', publicKey: this.keypair.publicKey(), ephemeral: false };
    } else {
      this.keypair = Keypair.random();
      this.signer = { algorithm: 'ed25519', publicKey: this.keypair.publicKey(), ephemeral: true };
      this.logger.warn(
        'INTENT_RECEIPT_SIGNING_SECRET is not set; signing intent receipts with an ephemeral ' +
          'per-process key. Receipts will not verify after a restart. Configure a key for production.',
      );
    }
  }

  getSigner(): IntentReceiptSigner {
    return { ...this.signer };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Record an accepted intent before the action runs. */
  async authorize(intent: AdminIntent, ctx: IntentRequestContext): Promise<IntentReceipt> {
    const receipt: IntentReceipt = {
      ...this.baseReceipt(intent.action, intent.target, ctx),
      status: 'authorized',
      chain: intent.chain,
      nonce: intent.nonce,
      intentExpiry: intent.expiry,
      intentSignature: intent.signature,
      intentDigest: sha256(intentMessage(intent)),
      intentSigner: process.env.STELLAR_PUBLIC_KEY ?? null,
    };
    this.sign(receipt);
    this.store(receipt);
    await this.writeAudit(receipt, null, 'authorized');
    return receipt;
  }

  /**
   * Record a refused intent. The raw presented intent is untrusted, so only
   * bounded string fields are kept; the action and target recorded are the
   * ones the endpoint required, not the ones the caller claimed.
   */
  async reject(
    expectedAction: string,
    expectedTarget: string,
    rawIntent: unknown,
    error: unknown,
    ctx: IntentRequestContext,
  ): Promise<IntentReceipt> {
    const raw = (rawIntent && typeof rawIntent === 'object' ? rawIntent : {}) as Record<string, unknown>;
    const now = new Date().toISOString();
    const receipt: IntentReceipt = {
      ...this.baseReceipt(expectedAction, expectedTarget, ctx),
      status: 'rejected',
      chain: boundedString(raw.chain),
      nonce: boundedString(raw.nonce),
      intentExpiry: typeof raw.expiry === 'number' && Number.isFinite(raw.expiry) ? raw.expiry : null,
      completedAt: now,
      outcome: describeError(error),
      rejectionReason: describeError(error).errorMessage ?? 'intent rejected',
    };
    this.sign(receipt);
    this.store(receipt);
    await this.writeAudit(receipt, null, 'rejected');
    return receipt;
  }

  /** Mark an authorized action as finished. Idempotent for terminal receipts. */
  async complete(
    receiptId: string,
    result: { ok: true; httpStatus: number; body: unknown } | { ok: false; error: unknown },
  ): Promise<IntentReceipt> {
    const receipt = this.require(receiptId);
    const outcome: IntentReceiptOutcome = result.ok
      ? { httpStatus: result.httpStatus, resultDigest: sha256(stableStringify(result.body ?? null)) }
      : describeError(result.error);

    if (receipt.status !== 'authorized') {
      // A reviewer may have reconciled a stale receipt before the handler
      // eventually returned. The signed receipt is not rewritten; the late
      // outcome is recorded in the audit chain for the reviewer to see.
      this.lateOutcomes++;
      this.logger.warn(`late outcome for intent receipt ${receiptId} already in status ${receipt.status}`);
      await this.recordAudit(receipt, 'late_outcome', { status: receipt.status }, {
        observed: result.ok ? 'succeeded' : 'failed',
        outcome,
      });
      return receipt;
    }

    const previous = receipt.status;
    receipt.status = result.ok ? 'succeeded' : 'failed';
    receipt.completedAt = new Date().toISOString();
    receipt.outcome = outcome;
    this.sign(receipt);
    await this.writeAudit(receipt, previous, receipt.status);
    return receipt;
  }

  /**
   * Attach a reviewer attestation. `reconciled_*` dispositions resolve a
   * stale `authorized` receipt whose outcome was never observed; they are
   * refused while the action could still be in flight.
   */
  async review(
    receiptId: string,
    reviewer: string,
    disposition: ReviewDisposition,
    note: string,
  ): Promise<IntentReceiptView> {
    const receipt = this.require(receiptId);
    if (!REVIEW_DISPOSITIONS.includes(disposition)) {
      throw new BadRequestException(`disposition must be one of: ${REVIEW_DISPOSITIONS.join(', ')}`);
    }
    if (typeof note !== 'string' || !note.trim()) {
      throw new BadRequestException('A review note is required');
    }
    if (note.length > MAX_NOTE_LENGTH) {
      throw new BadRequestException(`Review note exceeds ${MAX_NOTE_LENGTH} characters`);
    }

    const reconciling = disposition === 'reconciled_succeeded' || disposition === 'reconciled_failed';
    if (reconciling) {
      if (receipt.status !== 'authorized') {
        throw new ConflictException(`Receipt is already ${receipt.status}; only stale authorized receipts can be reconciled`);
      }
      if (!this.isStale(receipt)) {
        throw new ConflictException('Receipt is still within its in-flight window; wait until it is stale before reconciling');
      }
    } else if (receipt.status === 'authorized' && !(disposition === 'disputed' && this.isStale(receipt))) {
      // Nothing to confirm while the outcome is unknown; a stale receipt may
      // still be disputed (e.g. "this should never have been approved").
      throw new ConflictException('Receipt outcome is not yet known; review after the action completes or reconcile it once stale');
    }

    const review: IntentReceiptReview = {
      reviewId: randomUUID(),
      reviewer,
      disposition,
      note: note.trim(),
      reviewedAt: new Date().toISOString(),
      receiptSignature: receipt.signature,
      signature: '',
    };
    review.signature = this.signBytes(reviewMessage(receipt.receiptId, review));
    receipt.reviews.push(review);

    const previous = receipt.status;
    if (reconciling) {
      receipt.status = disposition === 'reconciled_succeeded' ? 'succeeded' : 'failed';
      receipt.completedAt = review.reviewedAt;
      receipt.outcome = {
        httpStatus: 0,
        errorCode: disposition === 'reconciled_failed' ? 'RECONCILED_FAILED' : undefined,
        reconciledByReview: review.reviewId,
      };
      this.sign(receipt);
    }
    await this.recordAudit(receipt, `review:${disposition}`, { status: previous }, {
      status: receipt.status,
      reviewId: review.reviewId,
      reviewSignature: review.signature,
      receiptSignature: receipt.signature,
    }, reviewer);
    return this.view(receipt);
  }

  // ---------------------------------------------------------------------------
  // Review / query
  // ---------------------------------------------------------------------------

  get(receiptId: string): IntentReceiptView {
    return this.view(this.require(receiptId));
  }

  list(query: IntentReceiptQuery = {}): IntentReceiptView[] {
    const limit = Math.min(Math.max(1, Number(query.limit) || 100), MAX_LIST_LIMIT);
    const out: IntentReceiptView[] = [];
    // Newest first: Map preserves insertion order.
    const all = [...this.receipts.values()].reverse();
    for (const receipt of all) {
      if (query.status && receipt.status !== query.status) continue;
      if (query.action && receipt.action !== query.action) continue;
      if (query.target && receipt.target !== query.target) continue;
      if (query.actor && receipt.actor !== query.actor) continue;
      if (query.staleOnly && !this.isStale(receipt)) continue;
      out.push(this.view(receipt));
      if (out.length >= limit) break;
    }
    return out;
  }

  async verify(receiptId: string): Promise<IntentReceiptVerification> {
    const receipt = this.require(receiptId);
    return this.verifyReceipt(receipt);
  }

  /**
   * Verify any receipt (including one exported and handed back by a
   * reviewer). Checks the signature against the key named in the receipt and
   * requires that key to be this server's current key, so a forged receipt
   * signed with an attacker-chosen key is reported invalid.
   */
  async verifyReceipt(receipt: IntentReceipt): Promise<IntentReceiptVerification> {
    const problems: string[] = [];

    let receiptSignatureValid = false;
    try {
      receiptSignatureValid =
        receipt.signer?.publicKey === this.signer.publicKey &&
        Keypair.fromPublicKey(receipt.signer.publicKey).verify(
          receiptMessage(receipt),
          Buffer.from(receipt.signature ?? '', 'base64'),
        );
    } catch {
      receiptSignatureValid = false;
    }
    if (!receiptSignatureValid) {
      problems.push(
        receipt.signer?.publicKey !== this.signer.publicKey
          ? 'receipt signed by a key other than the current receipt signing key'
          : 'receipt signature does not match receipt body',
      );
    }

    let intentSignatureValid: boolean | null = null;
    if (receipt.intentSignature && receipt.intentSigner && receipt.nonce && receipt.chain && receipt.intentExpiry !== null) {
      try {
        const message = intentMessage({
          action: receipt.action,
          target: receipt.target,
          chain: receipt.chain,
          expiry: receipt.intentExpiry,
          nonce: receipt.nonce,
        });
        intentSignatureValid = Keypair.fromPublicKey(receipt.intentSigner).verify(
          Buffer.from(message, 'utf8'),
          Buffer.from(receipt.intentSignature, 'base64'),
        );
      } catch {
        intentSignatureValid = false;
      }
      if (!intentSignatureValid) problems.push('embedded admin intent signature is invalid');
    } else if (receipt.status !== 'rejected') {
      intentSignatureValid = false;
      problems.push('non-rejected receipt carries no admin intent signature');
    }

    let reviewSignaturesValid = true;
    for (const review of receipt.reviews ?? []) {
      let valid = false;
      try {
        valid = this.keypair.verify(
          reviewMessage(receipt.receiptId, review),
          Buffer.from(review.signature, 'base64'),
        );
      } catch {
        valid = false;
      }
      if (!valid) {
        reviewSignaturesValid = false;
        problems.push(`review ${review.reviewId} signature is invalid`);
      }
    }

    const chain = await this.audit.verifyEntity(AUDIT_ENTITY_TYPE, receipt.receiptId);
    const history = this.audit.getEntityHistory(AUDIT_ENTITY_TYPE, receipt.receiptId);
    let auditChainValid = chain.ok && history.length > 0;
    if (history.length === 0) {
      problems.push('no audit-chain history for this receipt');
    } else if (!chain.ok) {
      problems.push(`audit chain verification failed: ${chain.failures.map((f) => f.reason).join(', ')}`);
    } else if (!history.some((entry) => entry.after?.receiptSignature === receipt.signature)) {
      auditChainValid = false;
      problems.push('current receipt signature is not anchored in the audit chain');
    }

    return {
      receiptId: receipt.receiptId,
      receiptSignatureValid,
      intentSignatureValid,
      reviewSignaturesValid,
      auditChainValid,
      ok: problems.length === 0,
      problems,
    };
  }

  getStats() {
    const byStatus: Record<IntentReceiptStatus, number> = { authorized: 0, succeeded: 0, failed: 0, rejected: 0 };
    let stale = 0;
    for (const receipt of this.receipts.values()) {
      byStatus[receipt.status]++;
      if (this.isStale(receipt)) stale++;
    }
    return {
      total: this.receipts.size,
      byStatus,
      stale,
      evicted: this.evicted,
      auditWriteFailures: this.auditWriteFailures,
      lateOutcomes: this.lateOutcomes,
      maxReceipts: MAX_RECEIPTS,
      staleAfterMs: this.staleMs(),
      signer: this.getSigner(),
    };
  }

  /** Test seam. */
  clear(): void {
    this.receipts.clear();
    this.evicted = 0;
    this.auditWriteFailures = 0;
    this.lateOutcomes = 0;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private baseReceipt(action: string, target: string, ctx: IntentRequestContext): IntentReceipt {
    return {
      version: INTENT_RECEIPT_VERSION,
      receiptId: randomUUID(),
      status: 'authorized',
      action: boundedString(action) ?? 'unknown',
      target: boundedString(target) ?? 'unknown',
      chain: null,
      nonce: null,
      intentExpiry: null,
      intentSignature: null,
      intentDigest: null,
      intentSigner: null,
      actor: boundedString(ctx.actor) ?? 'anonymous',
      route: boundedString(ctx.route) ?? 'unknown',
      requestId: boundedString(ctx.requestId),
      requestDigest: sha256(stableStringify(stripIntent(ctx.body))),
      authorizedAt: new Date().toISOString(),
      completedAt: null,
      outcome: null,
      rejectionReason: null,
      auditHash: null,
      signer: this.getSigner(),
      signature: '',
      reviews: [],
    };
  }

  private view(receipt: IntentReceipt): IntentReceiptView {
    return {
      ...structuredClone(receipt),
      stale: this.isStale(receipt),
      reviewed: receipt.reviews.length > 0,
    };
  }

  private isStale(receipt: IntentReceipt): boolean {
    return receipt.status === 'authorized' && Date.now() - Date.parse(receipt.authorizedAt) > this.staleMs();
  }

  private staleMs(): number {
    const configured = Number(process.env.INTENT_RECEIPT_STALE_MS);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_STALE_MS;
  }

  private require(receiptId: string): IntentReceipt {
    const receipt = this.receipts.get(receiptId);
    if (!receipt) throw new NotFoundException(`Intent receipt ${receiptId} not found`);
    return receipt;
  }

  /**
   * Bounded store. At capacity the oldest *terminal* receipt is evicted (its
   * audit-chain entries remain); in-flight `authorized` receipts are never
   * evicted because their outcome still has to land somewhere.
   */
  private store(receipt: IntentReceipt): void {
    if (this.receipts.size >= MAX_RECEIPTS) {
      for (const [id, existing] of this.receipts) {
        if (TERMINAL_STATUSES.has(existing.status)) {
          this.receipts.delete(id);
          this.evicted++;
          break;
        }
      }
    }
    this.receipts.set(receipt.receiptId, receipt);
  }

  private sign(receipt: IntentReceipt): void {
    receipt.signature = this.signBytes(receiptMessage(receipt));
  }

  private signBytes(message: Buffer): string {
    try {
      return this.keypair.sign(message).toString('base64');
    } catch {
      throw new InternalServerErrorException('Unable to sign intent receipt');
    }
  }

  private async writeAudit(
    receipt: IntentReceipt,
    previous: IntentReceiptStatus | null,
    action: string,
  ): Promise<void> {
    await this.recordAudit(receipt, action, previous ? { status: previous } : null, {
      status: receipt.status,
      action: receipt.action,
      target: receipt.target,
      intentDigest: receipt.intentDigest,
      requestDigest: receipt.requestDigest,
      outcome: receipt.outcome,
      receiptSignature: receipt.signature,
    });
  }

  /**
   * Audit writes are best-effort: the audit chain has its own capacity limit
   * and must not become a reason to block a maintainer mid-incident. A failed
   * write leaves `auditHash` null, is counted in stats, and makes `verify`
   * report the receipt as unanchored.
   */
  private async recordAudit(
    receipt: IntentReceipt,
    action: string,
    before: Record<string, any> | null,
    after: Record<string, any>,
    actor = receipt.actor,
  ): Promise<void> {
    try {
      const result = await this.audit.record({
        entityType: AUDIT_ENTITY_TYPE,
        entityId: receipt.receiptId,
        action,
        actor,
        before,
        after,
      });
      if (result.kind === 'recorded' && result.record) {
        receipt.auditHash = result.record.hash;
      } else {
        this.auditWriteFailures++;
        this.logger.error(`intent receipt ${receipt.receiptId} audit write rejected: ${result.rejectReason}`);
      }
    } catch (error) {
      this.auditWriteFailures++;
      this.logger.error(`intent receipt ${receipt.receiptId} audit write failed: ${(error as Error)?.message}`);
    }
  }
}

// -----------------------------------------------------------------------------
// Pure helpers (exported for tests and offline verification tooling)
// -----------------------------------------------------------------------------

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Same canonical message IntentService verifies. */
export function intentMessage(intent: Pick<AdminIntent, 'action' | 'target' | 'chain' | 'expiry' | 'nonce'>): string {
  return `${intent.action}|${intent.target}|${intent.chain}|${intent.expiry}|${intent.nonce}`;
}

/** Signed bytes of a receipt: every field except the signature, reviews and audit link. */
export function receiptMessage(receipt: IntentReceipt): Buffer {
  const { signature: _signature, reviews: _reviews, auditHash: _auditHash, ...body } = receipt as IntentReceipt &
    Partial<Pick<IntentReceiptView, 'stale' | 'reviewed'>>;
  delete (body as any).stale;
  delete (body as any).reviewed;
  return Buffer.from(INTENT_RECEIPT_SIGNING_DOMAIN + stableStringify(body), 'utf8');
}

export function reviewMessage(receiptId: string, review: IntentReceiptReview): Buffer {
  const { signature: _signature, ...body } = review;
  return Buffer.from(`${INTENT_RECEIPT_SIGNING_DOMAIN}review\n${stableStringify({ receiptId, ...body })}`, 'utf8');
}

function stripIntent(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body ?? null;
  const { adminIntent: _adminIntent, ...rest } = body as Record<string, unknown>;
  return rest;
}

function boundedString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  return String(value).slice(0, MAX_FIELD_LENGTH);
}

/**
 * Client-safe error description. Only HttpException messages are kept (they
 * are already user-facing); anything else is reduced to its class name so
 * stack traces and internal details never end up in a long-lived receipt.
 */
export function describeError(error: unknown): IntentReceiptOutcome {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    const raw =
      typeof response === 'string'
        ? response
        : Array.isArray((response as any)?.message)
          ? (response as any).message.join('; ')
          : String((response as any)?.message ?? error.message);
    return {
      httpStatus: error.getStatus(),
      errorCode: error.constructor?.name ?? 'HttpException',
      errorMessage: raw.slice(0, MAX_FIELD_LENGTH),
    };
  }
  return {
    httpStatus: 500,
    errorCode: (error as Error)?.name ?? 'Error',
    errorMessage: 'Internal error',
  };
}
