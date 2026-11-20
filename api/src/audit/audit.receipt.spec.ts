import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditReceiptService } from './audit-receipt.service';
import { AuditRecord } from './audit.interface';
import { AuditWrite } from './classes/audit.classes';
import {
  AUDIT_RECEIPT_VERSION,
  auditReceiptPublicKey,
  generateAuditReceiptKeyPair,
  signAuditReceipt,
  verifyAuditReceipt,
} from './audit.receipt';

const write = (overrides: Partial<AuditWrite> = {}): AuditWrite => ({
  entityType: 'admin-config/policy',
  entityId: 'policy-1',
  action: 'policy_update',
  actor: 'GADMIN...',
  reason: 'privileged config change',
  before: { threshold: 1 },
  after: { threshold: 2 },
  ...overrides,
});

const record = (overrides: Partial<AuditRecord> = {}): AuditRecord => ({
  sequence: 1,
  recordId: 'rec-1',
  entityType: 'admin-config/policy',
  entityId: 'policy-1',
  action: 'policy_update',
  actor: 'GADMIN...',
  reason: 'privileged config change',
  before: { threshold: 1 },
  after: { threshold: 2 },
  recordedAt: '2026-01-01T00:00:00.000Z',
  previousHash: null,
  hash: 'content-hash',
  ...overrides,
});

describe('Signed audit receipts for privileged actions', () => {
  const savedKey = process.env.AUDIT_RECEIPT_SIGNING_KEY;

  beforeEach(() => {
    delete process.env.AUDIT_RECEIPT_SIGNING_KEY;
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.AUDIT_RECEIPT_SIGNING_KEY;
    else process.env.AUDIT_RECEIPT_SIGNING_KEY = savedKey;
  });

  describe('normal path', () => {
    it('issues a receipt bound to the audit entry and verifies it', async () => {
      const audit = new AuditService();
      const service = new AuditReceiptService(audit);

      const { record: entry, receipt } = await service.recordPrivilegedAction(write(), {
        actorRoles: ['admin'],
      });

      expect(receipt.version).toBe(AUDIT_RECEIPT_VERSION);
      expect(receipt).toMatchObject({
        recordId: entry.recordId,
        hash: entry.hash,
        action: entry.action,
        actor: entry.actor,
        entityType: entry.entityType,
        entityId: entry.entityId,
        signerPublicKey: service.publicKey,
      });
      expect(service.verify(entry, receipt)).toEqual({ ok: true });
      // The underlying hash chain is unchanged by receipt issuance.
      expect((await audit.verifyEntity(entry.entityType, entry.entityId)).ok).toBe(true);
    });

    it('works with an explicitly configured signing key', () => {
      const keys = generateAuditReceiptKeyPair();
      process.env.AUDIT_RECEIPT_SIGNING_KEY = keys.privateKey;
      const service = new AuditReceiptService(new AuditService());
      const entry = record();

      const receipt = service.issue(entry);

      expect(service.publicKey).toBe(auditReceiptPublicKey(keys.privateKey));
      expect(service.verify(entry, receipt)).toEqual({ ok: true });
    });
  });

  describe('failure path', () => {
    it('detects a tampered audit entry (record mismatch)', () => {
      const keys = generateAuditReceiptKeyPair();
      const entry = record();
      const receipt = signAuditReceipt(entry, keys);

      // A changed payload is covered by the signature, so verification fails.
      expect(verifyAuditReceipt(record({ after: { threshold: 999 } }), receipt)).toEqual({
        ok: false,
        reason: 'signature_mismatch',
      });
      // A changed binding field is rejected before signature verification.
      expect(verifyAuditReceipt(record({ actor: 'GATTACKER' }), receipt)).toEqual({
        ok: false,
        reason: 'record_mismatch',
      });
    });

    it('detects a forged signature', () => {
      const keys = generateAuditReceiptKeyPair();
      const attacker = generateAuditReceiptKeyPair();
      const entry = record();
      const receipt = signAuditReceipt(entry, keys);
      const forged = signAuditReceipt(entry, attacker);

      expect(verifyAuditReceipt(entry, { ...receipt, signature: forged.signature })).toEqual({
        ok: false,
        reason: 'signature_mismatch',
      });
    });

    it('rejects unsupported versions and malformed signatures', () => {
      const keys = generateAuditReceiptKeyPair();
      const entry = record();
      const receipt = signAuditReceipt(entry, keys);

      expect(verifyAuditReceipt(entry, { ...receipt, version: 99 })).toEqual({
        ok: false,
        reason: 'unsupported_version',
      });
      expect(verifyAuditReceipt(entry, { ...receipt, signature: 'not-base64!' })).toEqual({
        ok: false,
        reason: 'malformed_receipt',
      });
    });

    it('refuses to issue a receipt when the audit write is rejected', async () => {
      const service = new AuditReceiptService(new AuditService());

      await expect(service.recordPrivilegedAction(write({ actor: '' }))).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('fails closed when a configured signing key is invalid', () => {
      process.env.AUDIT_RECEIPT_SIGNING_KEY = 'not a pem';
      expect(() => new AuditReceiptService(new AuditService())).toThrow(/AUDIT_RECEIPT_SIGNING_KEY/);
    });
  });

  describe('retry / replay path', () => {
    it('is idempotent: re-signing the same entry yields the same signature', () => {
      const keys = generateAuditReceiptKeyPair();
      const entry = record();
      const first = signAuditReceipt(entry, keys);
      const second = signAuditReceipt(entry, keys);

      expect(second.signature).toBe(first.signature);
      expect(verifyAuditReceipt(entry, first)).toEqual({ ok: true });
      expect(verifyAuditReceipt(entry, first)).toEqual({ ok: true });
    });

    it('cannot replay a receipt for a different audit entry', () => {
      const keys = generateAuditReceiptKeyPair();
      const original = record();
      const receipt = signAuditReceipt(original, keys);
      const other = record({ recordId: 'rec-2', sequence: 2 });

      expect(verifyAuditReceipt(other, receipt)).toEqual({ ok: false, reason: 'record_mismatch' });
    });

    it('supports key rotation: old receipts verify only when the old key is trusted', async () => {
      const oldKeys = generateAuditReceiptKeyPair();
      const entry = record();
      const oldReceipt = signAuditReceipt(entry, oldKeys);

      expect(verifyAuditReceipt(entry, oldReceipt, { trustedPublicKeys: [oldKeys.publicKey] })).toEqual({ ok: true });
      expect(verifyAuditReceipt(entry, oldReceipt, { trustedPublicKeys: ['other-key'] })).toEqual({
        ok: false,
        reason: 'untrusted_signer',
      });

      // Recovery: reissue the same entry under the new key.
      const newKeys = generateAuditReceiptKeyPair();
      const newReceipt = signAuditReceipt(entry, newKeys);
      expect(verifyAuditReceipt(entry, newReceipt, { trustedPublicKeys: [newKeys.publicKey] })).toEqual({ ok: true });
    });
  });

  describe('authorization boundary', () => {
    it('requires a privileged actor role when roles are supplied', async () => {
      const service = new AuditReceiptService(new AuditService());

      await expect(
        service.recordPrivilegedAction(write(), { actorRoles: ['investor'] }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('accepts admin and auditor roles', async () => {
      const service = new AuditReceiptService(new AuditService());
      for (const role of ['admin', 'auditor']) {
        const { record: entry, receipt } = await service.recordPrivilegedAction(write(), {
          actorRoles: [role],
        });
        expect(service.verify(entry, receipt)).toEqual({ ok: true });
      }
    });

    it('does not trust a receipt signed by an unconfigured key', () => {
      const service = new AuditReceiptService(new AuditService());
      const attacker = generateAuditReceiptKeyPair();
      const entry = record();
      const forged = signAuditReceipt(entry, attacker);

      expect(service.verify(entry, forged)).toEqual({ ok: false, reason: 'untrusted_signer' });
    });
  });
});

