import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuditService } from '../../audit/audit.service';
import { AuditReceiptService } from '../../audit/audit-receipt.service';
import { generateAuditReceiptKeyPair, signAuditReceipt, verifyAuditReceipt } from '../../audit/audit.receipt';
import { ApiProblemException } from '../../common/errors/problem-exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { GovernanceReceiptService } from './governance-receipt.service';
import { ComplianceController } from '../controllers/compliance.controller';
import { ComplianceRulesEngine } from './compliance-rules.engine';
import { ComplianceAttestationService } from './compliance-attestation.service';
import { SanctionsService } from './sanctions.service';
import { ComplianceSnapshotService } from './compliance-snapshot.service';
import { KycCommitmentService } from './kyc-commitment.service';
import { KycStoreService } from '../../common/services/kyc-store.service';

/**
 * Signed receipts for compliance and governance actions (#632).
 */
describe('GovernanceReceiptService (#632)', () => {
  const ADMIN = 'GADMINWALLET';
  let audit: AuditService;
  let receipts: AuditReceiptService;
  let service: GovernanceReceiptService;

  beforeEach(() => {
    audit = new AuditService();
    receipts = new AuditReceiptService(audit);
    service = new GovernanceReceiptService(receipts, audit);
  });

  afterEach(() => {
    delete process.env.AUDIT_RECEIPT_PREVIOUS_PUBLIC_KEYS;
  });

  const request = (overrides: Partial<Parameters<GovernanceReceiptService['execute']>[0]> = {}) => ({
    action: 'governance.ruleset.update' as const,
    entityId: 'US',
    actor: ADMIN,
    actorRoles: ['admin'],
    idempotencyKey: 'key-1',
    request: { jurisdiction: 'US', updates: { maxInvestment: '100' } },
    before: { version: '2026.1', auditHash: 'old' },
    execute: jest.fn().mockResolvedValue({ version: '2026.2', auditHash: 'new' }),
    summarize: (r: any) => ({ version: r.version, auditHash: r.auditHash }),
    ...overrides,
  });

  describe('normal path', () => {
    it('executes once and returns a receipt that verifies against the audit chain', async () => {
      const req = request();
      const { result, signedReceipt, record } = await service.execute(req);

      expect(req.execute).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ version: '2026.2', auditHash: 'new' });
      expect(signedReceipt).toMatchObject({ idempotencyKey: 'key-1', replayed: false });
      expect(signedReceipt.receipt).toMatchObject({
        action: 'governance.ruleset.update',
        actor: ADMIN,
        entityType: 'compliance-ruleset',
        entityId: 'US',
        recordId: record.recordId,
      });
      expect(record.before).toEqual({ version: '2026.1', auditHash: 'old' });
      expect(record.after).toMatchObject({ version: '2026.2', auditHash: 'new', idempotencyKey: 'key-1' });
      expect(service.verify(signedReceipt.receipt)).toEqual({ ok: true });
      await expect(audit.verifyEntity('compliance-ruleset', 'US')).resolves.toMatchObject({ ok: true, failures: [] });
    });

    it('generates an idempotency key when the caller supplies none', async () => {
      const { signedReceipt } = await service.execute(request({ idempotencyKey: undefined }));
      expect(signedReceipt.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe('retry path', () => {
    it('replays a completed action without re-executing or writing a second audit entry', async () => {
      const req = request();
      const first = await service.execute(req);
      const second = await service.execute(req);

      expect(req.execute).toHaveBeenCalledTimes(1);
      expect(second.signedReceipt.replayed).toBe(true);
      expect(second.signedReceipt.receipt).toEqual(first.signedReceipt.receipt);
      expect(audit.getEntityHistory('compliance-ruleset', 'US')).toHaveLength(1);
    });

    it('rejects reuse of an idempotency key with a different payload (409)', async () => {
      await service.execute(request());
      await expect(
        service.execute(request({ request: { jurisdiction: 'US', updates: { maxInvestment: '999' } } })),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects a concurrent duplicate while the first execution is in flight (409)', async () => {
      let release!: () => void;
      const slow = request({
        execute: jest.fn().mockImplementation(
          () => new Promise((resolve) => { release = () => resolve({ version: 'v', auditHash: 'h' }); }),
        ),
      });
      const first = service.execute(slow);
      await Promise.resolve();
      await expect(service.execute(slow)).rejects.toThrow(/already in progress/);
      release();
      await expect(first).resolves.toBeDefined();
      expect(slow.execute).toHaveBeenCalledTimes(1);
    });

    it('scopes keys per actor: another admin with the same key is independent', async () => {
      await service.execute(request());
      const other = await service.execute(request({ actor: 'GOTHERADMIN' }));
      expect(other.signedReceipt.replayed).toBe(false);
    });
  });

  describe('failure and recovery paths', () => {
    it('issues no receipt when the action fails, and lets the same key be retried', async () => {
      const failing = request({ execute: jest.fn().mockRejectedValue(new Error('ruleset invalid')) });
      await expect(service.execute(failing)).rejects.toThrow('ruleset invalid');
      expect(audit.getEntityHistory('compliance-ruleset', 'US')).toHaveLength(0);

      const retry = await service.execute(request());
      expect(retry.signedReceipt.replayed).toBe(false);
      expect(audit.getEntityHistory('compliance-ruleset', 'US')).toHaveLength(1);
    });

    it('parks an applied action whose receipt failed, then completes it on retry without re-executing', async () => {
      const req = request();
      jest.spyOn(audit, 'record').mockResolvedValueOnce({ kind: 'rejected', rejectReason: 'store full', record: null });

      const attempt = service.execute(req);
      await expect(attempt).rejects.toBeInstanceOf(ApiProblemException);
      await expect(attempt).rejects.toMatchObject({
        code: ErrorCode.RECEIPT_PENDING,
        context: { idempotencyKey: 'key-1', actionApplied: true },
      });
      expect(req.execute).toHaveBeenCalledTimes(1);

      const recovered = await service.execute(req);
      expect(req.execute).toHaveBeenCalledTimes(1); // the mutation is never applied twice
      expect(recovered.signedReceipt.replayed).toBe(false);
      expect(service.verify(recovered.signedReceipt.receipt)).toEqual({ ok: true });
    });

    it('surfaces RECEIPT_PENDING as a retryable 503', () => {
      const problem = new ApiProblemException(ErrorCode.RECEIPT_PENDING, { status: 503 });
      expect(problem.getStatus()).toBe(503);
    });
  });

  describe('authorization path', () => {
    it.each([
      ['an investor', { actorRoles: ['investor'] }],
      ['an auditor (verify-only)', { actorRoles: ['auditor'] }],
      ['an anonymous actor', { actor: '' }],
      ['an unknown action', { action: 'governance.anything' as any }],
    ])('rejects %s before executing', async (_label, overrides) => {
      const req = request(overrides as any);
      await expect(service.execute(req)).rejects.toThrow(ForbiddenException);
      expect(req.execute).not.toHaveBeenCalled();
      expect(audit.getStats().totalEntries ?? 0).toBe(0);
    });
  });

  describe('verification', () => {
    it('rejects a tampered receipt', async () => {
      const { signedReceipt } = await service.execute(request());
      const tampered = { ...signedReceipt.receipt, actor: 'GATTACKER' };
      expect(service.verify(tampered)).toEqual({ ok: false, reason: 'record_mismatch' });
    });

    it('rejects an ordinary audit receipt presented as a governance receipt', async () => {
      const { receipt } = await receipts.recordPrivilegedAction({
        entityType: 'bond', entityId: '1', action: 'bond.update', actor: ADMIN, before: null, after: null,
      });
      expect(service.verify(receipt)).toEqual({ ok: false, reason: 'not_a_governance_receipt' });
    });

    it('rejects a governance receipt whose audit entry does not exist', async () => {
      const { signedReceipt } = await service.execute(request());
      expect(service.verify({ ...signedReceipt.receipt, recordId: 'missing' })).toEqual({
        ok: false,
        reason: 'record_not_found',
      });
    });

    it('rejects a receipt signed by an untrusted key', async () => {
      const { record } = await service.execute(request());
      const forged = signAuditReceipt(record, generateAuditReceiptKeyPair());
      expect(service.verify(forged)).toEqual({ ok: false, reason: 'untrusted_signer' });
    });

    it('accepts receipts from a rotated key listed in AUDIT_RECEIPT_PREVIOUS_PUBLIC_KEYS', async () => {
      const { record } = await service.execute(request());
      const oldKey = generateAuditReceiptKeyPair();
      const oldReceipt = signAuditReceipt(record, oldKey);
      expect(verifyAuditReceipt(record, oldReceipt).ok).toBe(true);

      expect(service.verify(oldReceipt).ok).toBe(false);
      process.env.AUDIT_RECEIPT_PREVIOUS_PUBLIC_KEYS = JSON.stringify([oldKey.publicKey]);
      expect(service.verify(oldReceipt)).toEqual({ ok: true });
    });

    it('ignores a malformed rotated-key list instead of trusting it', async () => {
      const { record } = await service.execute(request());
      process.env.AUDIT_RECEIPT_PREVIOUS_PUBLIC_KEYS = 'not json';
      expect(service.verify(signAuditReceipt(record, generateAuditReceiptKeyPair())).ok).toBe(false);
    });
  });
});

describe('ComplianceController governance receipts (#632 vertical slice)', () => {
  const ADMIN = 'GADMINWALLET';
  let controller: ComplianceController;
  let audit: AuditService;
  let sanctions: SanctionsService;

  beforeEach(async () => {
    sanctions = new SanctionsService();
    const rules = new ComplianceRulesEngine(sanctions);
    audit = new AuditService();
    const receipts = new AuditReceiptService(audit);
    const moduleRef = await Test.createTestingModule({
      controllers: [ComplianceController],
      providers: [
        { provide: ComplianceRulesEngine, useValue: rules },
        { provide: ComplianceAttestationService, useValue: {} },
        { provide: SanctionsService, useValue: sanctions },
        { provide: KycStoreService, useValue: { get: jest.fn() } },
        { provide: ComplianceSnapshotService, useValue: {} },
        { provide: KycCommitmentService, useValue: {} },
        { provide: GovernanceReceiptService, useValue: new GovernanceReceiptService(receipts, audit) },
      ],
    }).compile();
    controller = moduleRef.get(ComplianceController);
  });

  const adminReq = { user: { walletAddress: ADMIN } };

  it('ruleset update keeps its response shape and adds a verifiable signedReceipt', async () => {
    const res = await controller.updateJurisdictionRule(
      { jurisdiction: 'us', updates: { maxInvestorsPerOffering: 50 } as any },
      adminReq,
      'rule-1',
    );
    expect(res.version).toBeDefined();
    expect(res.auditHash).toBeDefined();
    expect(res.signedReceipt?.receipt).toMatchObject({ action: 'governance.ruleset.update', entityId: 'US', actor: ADMIN });
    expect(controller.verifyReceipt({ receipt: res.signedReceipt!.receipt })).toEqual({ ok: true });
  });

  it('sanctions refresh is receipted and replay-safe', async () => {
    const body = { additionalAddresses: ['GSANCTIONED1'] };
    const first = await controller.refreshSanctions(body, adminReq, 'sanc-1');
    const second = await controller.refreshSanctions(body, adminReq, 'sanc-1');
    expect(sanctions.isSanctioned('GSANCTIONED1')).toBe(true);
    expect(second.signedReceipt?.replayed).toBe(true);
    expect(audit.getEntityHistory('compliance-sanctions', 'sanctions-list')).toHaveLength(1);
    // The receipt binds a digest of the list, never the addresses themselves.
    expect(JSON.stringify(audit.getEntityHistory('compliance-sanctions', 'sanctions-list'))).not.toContain('GSANCTIONED1');
    expect(first.signedReceipt?.receipt.action).toBe('compliance.sanctions.refresh');
  });

  it('eligibility invalidation and flush are receipted', async () => {
    const inv = await controller.invalidateInvestorEligibility('GINVESTOR', { reason: 'kyc revoked' }, adminReq);
    const flush = await controller.flushEligibilityCache(adminReq);
    expect(inv.signedReceipt?.receipt.action).toBe('compliance.eligibility.invalidate');
    expect(flush.signedReceipt?.receipt.action).toBe('compliance.eligibility.flush');
  });

  it('refuses to act (and writes nothing) when no authenticated actor reaches the controller', async () => {
    await expect(controller.flushEligibilityCache({})).rejects.toThrow(ForbiddenException);
    expect(audit.getEntityHistory('compliance-eligibility', 'all')).toHaveLength(0);
  });

  it('publishes the receipt public key for offline verifiers', () => {
    expect(controller.getReceiptPublicKey().publicKey).toContain('BEGIN PUBLIC KEY');
  });
});
