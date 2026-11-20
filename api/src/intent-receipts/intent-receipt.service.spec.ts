import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Keypair } from '@stellar/stellar-sdk';
import { AuditService } from '../audit/audit.service';
import { AdminIntent } from '../common/services/intent.service';
import {
  AUDIT_ENTITY_TYPE,
  DEFAULT_STALE_MS,
  IntentReceiptService,
  describeError,
  intentMessage,
} from './intent-receipt.service';

function signedIntent(kp: Keypair, action = 'distribute_coupon', target = '7', nonce = 'n-1'): AdminIntent {
  const base = { action, target, chain: 'testnet', expiry: Date.now() + 60_000, nonce };
  return { ...base, signature: kp.sign(Buffer.from(intentMessage(base), 'utf8')).toString('base64') };
}

const ctx = { actor: 'GADMIN', route: 'POST /bonds/:id/coupon', requestId: 'req-1', body: { amount: '10', adminIntent: { x: 1 } } };

describe('IntentReceiptService', () => {
  let admin: Keypair;
  let audit: AuditService;
  let service: IntentReceiptService;
  const env = { ...process.env };

  beforeEach(() => {
    admin = Keypair.random();
    process.env.STELLAR_PUBLIC_KEY = admin.publicKey();
    process.env.INTENT_RECEIPT_SIGNING_SECRET = Keypair.random().secret();
    delete process.env.INTENT_RECEIPT_STALE_MS;
    audit = new AuditService();
    service = new IntentReceiptService(audit);
  });

  afterEach(() => {
    process.env = { ...env };
    jest.useRealTimers();
  });

  describe('signing key', () => {
    it('uses the configured key', () => {
      const secret = Keypair.random();
      process.env.INTENT_RECEIPT_SIGNING_SECRET = secret.secret();
      expect(new IntentReceiptService(audit).getSigner()).toEqual({
        algorithm: 'ed25519',
        publicKey: secret.publicKey(),
        ephemeral: false,
      });
    });

    it('falls back to an ephemeral key when none is configured', () => {
      delete process.env.INTENT_RECEIPT_SIGNING_SECRET;
      expect(new IntentReceiptService(audit).getSigner().ephemeral).toBe(true);
    });

    it('refuses to boot with a malformed key rather than silently falling back', () => {
      process.env.INTENT_RECEIPT_SIGNING_SECRET = 'not-a-key';
      expect(() => new IntentReceiptService(audit)).toThrow(/INTENT_RECEIPT_SIGNING_SECRET/);
    });
  });

  describe('lifecycle', () => {
    it('issues a signed authorized receipt that never stores the raw body', async () => {
      const receipt = await service.authorize(signedIntent(admin), ctx);
      expect(receipt.status).toBe('authorized');
      expect(receipt.action).toBe('distribute_coupon');
      expect(receipt.target).toBe('7');
      expect(receipt.intentSigner).toBe(admin.publicKey());
      expect(receipt.requestDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(receipt)).not.toContain('"amount"');
      expect(receipt.auditHash).toMatch(/^[0-9a-f]{64}$/);
      expect((await service.verify(receipt.receiptId)).ok).toBe(true);
    });

    it('request digest ignores the admin intent so it identifies the business payload', async () => {
      const a = await service.authorize(signedIntent(admin, 'x', '1', 'a'), { ...ctx, body: { amount: '10', adminIntent: { n: 1 } } });
      const b = await service.authorize(signedIntent(admin, 'x', '1', 'b'), { ...ctx, body: { amount: '10' } });
      expect(a.requestDigest).toBe(b.requestDigest);
    });

    it('transitions to succeeded with a result digest and re-signs', async () => {
      const receipt = await service.authorize(signedIntent(admin), ctx);
      const firstSignature = receipt.signature;
      const done = await service.complete(receipt.receiptId, { ok: true, httpStatus: 201, body: { txHash: 'abc' } });
      expect(done.status).toBe('succeeded');
      expect(done.outcome).toEqual({ httpStatus: 201, resultDigest: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(done.signature).not.toBe(firstSignature);
      expect((await service.verify(receipt.receiptId)).ok).toBe(true);
      expect(audit.getEntityHistory(AUDIT_ENTITY_TYPE, receipt.receiptId).map((e) => e.action)).toEqual([
        'authorized',
        'succeeded',
      ]);
    });

    it('transitions to failed with a client-safe error', async () => {
      const receipt = await service.authorize(signedIntent(admin), ctx);
      const done = await service.complete(receipt.receiptId, {
        ok: false,
        error: new Error('db password=hunter2 at /srv/app'),
      });
      expect(done.status).toBe('failed');
      expect(done.outcome).toEqual({ httpStatus: 500, errorCode: 'Error', errorMessage: 'Internal error' });
      expect(JSON.stringify(done)).not.toContain('hunter2');
      expect((await service.verify(receipt.receiptId)).ok).toBe(true);
    });

    it('keeps HttpException messages, which are already client-facing', () => {
      expect(describeError(new BadRequestException('Bond is matured'))).toEqual({
        httpStatus: 400,
        errorCode: 'BadRequestException',
        errorMessage: 'Bond is matured',
      });
    });

    it('records rejections with the endpoint-required action/target, bounding untrusted fields', async () => {
      const receipt = await service.reject(
        'mature_bond',
        '3',
        { action: 'something_else', nonce: 'x'.repeat(5000), chain: { evil: true }, expiry: 'soon' },
        new ConflictException('Admin intent nonce already used (replay rejected)'),
        ctx,
      );
      expect(receipt.status).toBe('rejected');
      expect(receipt.action).toBe('mature_bond');
      expect(receipt.target).toBe('3');
      expect(receipt.nonce).toHaveLength(200);
      expect(receipt.chain).toBeNull();
      expect(receipt.intentExpiry).toBeNull();
      expect(receipt.rejectionReason).toMatch(/replay/);
      expect(receipt.outcome?.httpStatus).toBe(409);
      expect((await service.verify(receipt.receiptId)).ok).toBe(true);
    });

    it('does not rewrite a terminal receipt on a second completion, but audits the late outcome', async () => {
      const receipt = await service.authorize(signedIntent(admin), ctx);
      await service.complete(receipt.receiptId, { ok: true, httpStatus: 200, body: {} });
      const signature = service.get(receipt.receiptId).signature;
      await service.complete(receipt.receiptId, { ok: false, error: new Error('boom') });
      expect(service.get(receipt.receiptId).status).toBe('succeeded');
      expect(service.get(receipt.receiptId).signature).toBe(signature);
      expect(audit.getEntityHistory(AUDIT_ENTITY_TYPE, receipt.receiptId).pop()?.action).toBe('late_outcome');
      expect(service.getStats().lateOutcomes).toBe(1);
    });

    it('404s for unknown receipts', async () => {
      expect(() => service.get('nope')).toThrow(NotFoundException);
      await expect(service.complete('nope', { ok: true, httpStatus: 200, body: null })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('tamper detection', () => {
    it('detects an edited receipt body', async () => {
      const receipt = await service.authorize(signedIntent(admin), ctx);
      const exported = { ...service.get(receipt.receiptId), target: '8' };
      const result = await service.verifyReceipt(exported);
      expect(result.receiptSignatureValid).toBe(false);
      expect(result.ok).toBe(false);
    });

    it('detects a receipt re-signed with a different key', async () => {
      process.env.INTENT_RECEIPT_SIGNING_SECRET = Keypair.random().secret();
      const forger = new IntentReceiptService(audit);
      const forged = await forger.authorize(signedIntent(admin), ctx);
      const result = await service.verifyReceipt(forged);
      expect(result.receiptSignatureValid).toBe(false);
      expect(result.problems.join()).toMatch(/other than the current/);
    });

    it('detects an embedded admin intent signature that does not match', async () => {
      const intent = signedIntent(Keypair.random());
      const receipt = await service.authorize(intent, ctx);
      const result = await service.verify(receipt.receiptId);
      expect(result.receiptSignatureValid).toBe(true);
      expect(result.intentSignatureValid).toBe(false);
      expect(result.ok).toBe(false);
    });

    it('detects a receipt state that was never anchored in the audit chain', async () => {
      const receipt = await service.authorize(signedIntent(admin), ctx);
      audit.clear();
      const result = await service.verify(receipt.receiptId);
      expect(result.auditChainValid).toBe(false);
      expect(result.problems.join()).toMatch(/no audit-chain history/);
    });

    it('still issues receipts when the audit chain rejects writes, and reports them unanchored', async () => {
      jest.spyOn(audit, 'record').mockResolvedValue({ kind: 'rejected', rejectReason: 'audit chain at capacity', record: null });
      const receipt = await service.authorize(signedIntent(admin), ctx);
      expect(receipt.auditHash).toBeNull();
      expect(service.getStats().auditWriteFailures).toBe(1);
      expect((await service.verify(receipt.receiptId)).auditChainValid).toBe(false);
    });
  });

  describe('review', () => {
    it('attaches a signed review bound to the receipt state', async () => {
      const receipt = await service.authorize(signedIntent(admin), ctx);
      await service.complete(receipt.receiptId, { ok: true, httpStatus: 200, body: {} });
      const reviewed = await service.review(receipt.receiptId, 'GREVIEWER', 'confirmed', 'matches on-chain tx');
      expect(reviewed.reviewed).toBe(true);
      expect(reviewed.reviews[0]).toMatchObject({ reviewer: 'GREVIEWER', disposition: 'confirmed', receiptSignature: reviewed.signature });
      expect((await service.verify(receipt.receiptId)).ok).toBe(true);
    });

    it('detects a tampered review note', async () => {
      const receipt = await service.reject('x', 'global', undefined, new BadRequestException('nope'), ctx);
      await service.review(receipt.receiptId, 'GREVIEWER', 'confirmed', 'expected rejection');
      const exported = service.get(receipt.receiptId);
      exported.reviews[0].note = 'something else';
      expect((await service.verifyReceipt(exported)).reviewSignaturesValid).toBe(false);
    });

    it('requires a note and a known disposition', async () => {
      const receipt = await service.reject('x', 'global', undefined, new BadRequestException('nope'), ctx);
      await expect(service.review(receipt.receiptId, 'G', 'confirmed', '  ')).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.review(receipt.receiptId, 'G', 'approved' as any, 'n')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses to review an in-flight action', async () => {
      const receipt = await service.authorize(signedIntent(admin), ctx);
      await expect(service.review(receipt.receiptId, 'G', 'confirmed', 'n')).rejects.toBeInstanceOf(ConflictException);
      await expect(service.review(receipt.receiptId, 'G', 'reconciled_succeeded', 'n')).rejects.toThrow(/in-flight/);
    });

    it('marks old authorized receipts stale and lets a reviewer reconcile them', async () => {
      jest.useFakeTimers({ now: Date.now() });
      const receipt = await service.authorize(signedIntent(admin), ctx);
      expect(service.list({ staleOnly: true })).toHaveLength(0);

      jest.setSystemTime(Date.now() + DEFAULT_STALE_MS + 1);
      expect(service.list({ staleOnly: true }).map((r) => r.receiptId)).toEqual([receipt.receiptId]);
      expect(service.getStats().stale).toBe(1);

      const reconciled = await service.review(receipt.receiptId, 'GREVIEWER', 'reconciled_failed', 'no tx on chain for nonce');
      expect(reconciled.status).toBe('failed');
      expect(reconciled.stale).toBe(false);
      expect(reconciled.outcome).toMatchObject({ errorCode: 'RECONCILED_FAILED', reconciledByReview: reconciled.reviews[0].reviewId });
      expect((await service.verify(receipt.receiptId)).ok).toBe(true);

      // The handler finally returning must not overwrite the reviewer's decision.
      await service.complete(receipt.receiptId, { ok: true, httpStatus: 200, body: {} });
      expect(service.get(receipt.receiptId).status).toBe('failed');
      expect(service.getStats().lateOutcomes).toBe(1);
    });

    it('honours INTENT_RECEIPT_STALE_MS', async () => {
      process.env.INTENT_RECEIPT_STALE_MS = '1000';
      jest.useFakeTimers({ now: Date.now() });
      await service.authorize(signedIntent(admin), ctx);
      jest.setSystemTime(Date.now() + 1001);
      expect(service.list({ staleOnly: true })).toHaveLength(1);
    });

    it('refuses to reconcile a receipt that already has an outcome', async () => {
      const receipt = await service.reject('x', 'global', undefined, new BadRequestException('nope'), ctx);
      await expect(service.review(receipt.receiptId, 'G', 'reconciled_succeeded', 'n')).rejects.toThrow(/already rejected/);
    });
  });

  describe('query', () => {
    it('filters and returns newest first', async () => {
      const a = await service.authorize(signedIntent(admin, 'mature_bond', '1', 'a'), ctx);
      const b = await service.reject('mature_bond', '2', undefined, new BadRequestException('x'), ctx);
      const c = await service.authorize(signedIntent(admin, 'approve_project', '1', 'c'), ctx);
      expect(service.list().map((r) => r.receiptId)).toEqual([c.receiptId, b.receiptId, a.receiptId]);
      expect(service.list({ action: 'mature_bond' })).toHaveLength(2);
      expect(service.list({ status: 'rejected' }).map((r) => r.receiptId)).toEqual([b.receiptId]);
      expect(service.list({ target: '1', action: 'approve_project' }).map((r) => r.receiptId)).toEqual([c.receiptId]);
      expect(service.list({ limit: 1 })).toHaveLength(1);
    });

    it('returns copies so callers cannot mutate stored receipts', async () => {
      const receipt = await service.authorize(signedIntent(admin), ctx);
      service.get(receipt.receiptId).target = 'mutated';
      expect(service.get(receipt.receiptId).target).toBe('7');
    });
  });
});
