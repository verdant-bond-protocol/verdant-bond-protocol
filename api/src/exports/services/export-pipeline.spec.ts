import { ExportStreamPipeline } from './export-stream.pipeline';
import {
  ExportRole,
  ExportType,
  ExportCaller,
  ExportableRecord,
} from '../interfaces/export.interface';
import { ForbiddenException } from '@nestjs/common';

describe('ExportStreamPipeline (#357 Bounded Memory & Cancellation)', () => {
  let pipeline: ExportStreamPipeline;

  beforeEach(() => {
    pipeline = new ExportStreamPipeline();
  });

  describe('Permission & Role Enforcement', () => {
    it('verifies allowed export types per role', () => {
      const investor: ExportCaller = { userId: 'u1', role: ExportRole.INVESTOR };
      const issuer: ExportCaller = { userId: 'u2', role: ExportRole.ISSUER };
      const auditor: ExportCaller = { userId: 'u3', role: ExportRole.AUDITOR };

      expect(pipeline.validatePermission(investor, ExportType.PORTFOLIO)).toBe(true);
      expect(pipeline.validatePermission(investor, ExportType.BONDS)).toBe(false);
      expect(pipeline.validatePermission(investor, ExportType.KYC_PII)).toBe(false);

      expect(pipeline.validatePermission(issuer, ExportType.BONDS)).toBe(true);
      expect(pipeline.validatePermission(issuer, ExportType.COUPONS)).toBe(true);
      expect(pipeline.validatePermission(issuer, ExportType.COMPLIANCE_AUDIT)).toBe(false);

      expect(pipeline.validatePermission(auditor, ExportType.COMPLIANCE_AUDIT)).toBe(true);
      expect(pipeline.validatePermission(auditor, ExportType.KYC_PII)).toBe(false);
    });

    it('rejects pipeline execution immediately if caller role lacks permission', async () => {
      const investor: ExportCaller = { userId: 'u1', role: ExportRole.INVESTOR };

      async function* emptySource() {
        yield [];
      }

      await expect(
        pipeline.streamExport('exp-unauth', ExportType.KYC_PII, emptySource(), {
          caller: investor,
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('Forbidden Field Stripping', () => {
    it('strips SSN, passport, internalRiskScore, and signing keys for INVESTOR', () => {
      const investor: ExportCaller = { userId: 'alice', role: ExportRole.INVESTOR };

      const rawRecord: ExportableRecord = {
        id: 'rec-1',
        type: 'portfolio',
        createdAt: new Date(),
        ownerUserId: 'alice',
        data: {
          bondId: 42,
          amount: '10000',
          ssn: '000-11-2222',
          nationalId: 'ID-SECRET',
          passportNumber: 'P-12345',
          internalRiskScore: 99,
          complianceNotes: 'High risk tier',
          signingKey: 'KEY_DO_NOT_LEAK',
          signingSeed: 'SEED_SECRET',
          publicMemo: 'Safe to see',
        },
      };

      const sanitized = pipeline.sanitizeRecordForCaller(rawRecord, investor);

      expect(sanitized.data.bondId).toBe(42);
      expect(sanitized.data.amount).toBe('10000');
      expect(sanitized.data.publicMemo).toBe('Safe to see');

      // Forbidden fields MUST be completely stripped
      expect(sanitized.data.ssn).toBeUndefined();
      expect(sanitized.data.nationalId).toBeUndefined();
      expect(sanitized.data.passportNumber).toBeUndefined();
      expect(sanitized.data.internalRiskScore).toBeUndefined();
      expect(sanitized.data.complianceNotes).toBeUndefined();
      expect(sanitized.data.signingKey).toBeUndefined();
      expect(sanitized.data.signingSeed).toBeUndefined();
    });

    it('strips signing seeds and private keys for AUDITOR while retaining audit notes', () => {
      const auditor: ExportCaller = { userId: 'auditor-1', role: ExportRole.AUDITOR };

      const rawRecord: ExportableRecord = {
        id: 'audit-rec-1',
        type: 'compliance_audit',
        createdAt: new Date(),
        data: {
          auditId: 'AUD-001',
          complianceStatus: 'VERIFIED',
          internalRiskScore: 40,
          signingSeed: 'SECRET_SEED',
          passwordHash: 'argon2id$hashed',
        },
      };

      const sanitized = pipeline.sanitizeRecordForCaller(rawRecord, auditor);
      expect(sanitized.data.auditId).toBe('AUD-001');
      expect(sanitized.data.complianceStatus).toBe('VERIFIED');
      expect(sanitized.data.internalRiskScore).toBe(40);
      expect(sanitized.data.signingSeed).toBeUndefined();
      expect(sanitized.data.passwordHash).toBeUndefined();
    });

    it('strips PII and signing keys for ISSUER while retaining bond-level fields', () => {
      const issuer: ExportCaller = { userId: 'issuer-1', role: ExportRole.ISSUER };

      const rawRecord: ExportableRecord = {
        id: 'bond-rec-1',
        type: 'bonds',
        createdAt: new Date(),
        data: {
          bondId: 'BND-007',
          couponRate: '5.5',
          ssn: 'SHOULD_BE_GONE',
          nationalId: 'SHOULD_BE_GONE',
          passportNumber: 'SHOULD_BE_GONE',
          taxId: 'SHOULD_BE_GONE',
          signingSeed: 'SHOULD_BE_GONE',
          privateKey: 'SHOULD_BE_GONE',
          rawKycDocument: 'SHOULD_BE_GONE',
        },
      };

      const sanitized = pipeline.sanitizeRecordForCaller(rawRecord, issuer);

      expect(sanitized.data.bondId).toBe('BND-007');
      expect(sanitized.data.couponRate).toBe('5.5');
      expect(sanitized.data.ssn).toBeUndefined();
      expect(sanitized.data.nationalId).toBeUndefined();
      expect(sanitized.data.passportNumber).toBeUndefined();
      expect(sanitized.data.taxId).toBeUndefined();
      expect(sanitized.data.signingSeed).toBeUndefined();
      expect(sanitized.data.privateKey).toBeUndefined();
      expect(sanitized.data.rawKycDocument).toBeUndefined();
    });

    it('strips only signingSeed and privateKey for ADMIN, retaining all other fields', () => {
      const admin: ExportCaller = { userId: 'admin-1', role: ExportRole.ADMIN };

      const rawRecord: ExportableRecord = {
        id: 'admin-rec-1',
        type: 'compliance_audit',
        createdAt: new Date(),
        data: {
          auditId: 'AUD-888',
          internalRiskScore: 72,
          complianceNotes: 'Visible to admin',
          ssn: 'VISIBLE_TO_ADMIN',
          signingSeed: 'MUST_BE_GONE',
          privateKey: 'MUST_BE_GONE',
        },
      };

      const sanitized = pipeline.sanitizeRecordForCaller(rawRecord, admin);

      expect(sanitized.data.auditId).toBe('AUD-888');
      expect(sanitized.data.internalRiskScore).toBe(72);
      expect(sanitized.data.complianceNotes).toBe('Visible to admin');
      expect(sanitized.data.ssn).toBe('VISIBLE_TO_ADMIN');
      expect(sanitized.data.signingSeed).toBeUndefined();
      expect(sanitized.data.privateKey).toBeUndefined();
    });

    it('throws ForbiddenException if investor attempts to export records of another user', () => {
      const investor: ExportCaller = { userId: 'alice', role: ExportRole.INVESTOR };

      const foreignRecord: ExportableRecord = {
        id: 'rec-bob',
        type: 'portfolio',
        createdAt: new Date(),
        ownerUserId: 'bob',
        data: { balance: '500000' },
      };

      expect(() => {
        pipeline.sanitizeRecordForCaller(foreignRecord, investor);
      }).toThrow(ForbiddenException);
    });
  });

  describe('Bounded Memory & Large Dataset Streaming', () => {
    it('streams 2,000 records across chunks with constant chunk size without accumulating entire dataset', async () => {
      const totalRecords = 2000;
      const chunkSize = 100;
      const caller: ExportCaller = { userId: 'investor-1', role: ExportRole.INVESTOR };

      async function* generateRecords() {
        for (let i = 0; i < totalRecords; i += chunkSize) {
          const chunk: ExportableRecord[] = Array.from({ length: chunkSize }, (_, idx) => ({
            id: `rec-${i + idx}`,
            type: 'portfolio',
            createdAt: new Date(),
            ownerUserId: 'investor-1',
            data: { index: i + idx, value: (i + idx) * 10 },
          }));
          yield chunk;
        }
      }

      let consumedChunks = 0;
      let totalRecordsConsumed = 0;

      const result = await pipeline.streamExport(
        'exp-large',
        ExportType.PORTFOLIO,
        generateRecords(),
        { caller, batchSize: chunkSize },
        async (chunk) => {
          consumedChunks++;
          totalRecordsConsumed += chunk.length;
          // Verify each chunk is bounded in size
          expect(chunk.length).toBeLessThanOrEqual(chunkSize);
        },
      );

      expect(result.status).toBe('completed');
      expect(result.totalRecordsProcessed).toBe(totalRecords);
      expect(result.totalChunks).toBe(totalRecords / chunkSize);
      expect(totalRecordsConsumed).toBe(totalRecords);
      expect(consumedChunks).toBe(20);
    });
  });

  describe('Cancellation Support', () => {
    it('aborts streaming midway when AbortSignal triggers', async () => {
      const caller: ExportCaller = { userId: 'investor-1', role: ExportRole.INVESTOR };
      const abortController = new AbortController();

      async function* infiniteSource() {
        for (let i = 0; i < 50; i++) {
          yield [
            {
              id: `rec-${i}`,
              type: 'portfolio',
              createdAt: new Date(),
              ownerUserId: 'investor-1',
              data: { i },
            },
          ];
        }
      }

      let chunkCount = 0;

      const result = await pipeline.streamExport(
        'exp-abort',
        ExportType.PORTFOLIO,
        infiniteSource(),
        { caller, abortSignal: abortController.signal },
        async () => {
          chunkCount++;
          if (chunkCount === 3) {
            abortController.abort();
          }
        },
      );

      expect(result.status).toBe('cancelled');
      expect(result.cancelledAt).toBeDefined();
      expect(chunkCount).toBe(3);
    });

    it('halts streaming immediately when external cancellation check returns true', async () => {
      const caller: ExportCaller = { userId: 'investor-1', role: ExportRole.INVESTOR };

      let cancellationRequested = false;

      async function* source() {
        for (let i = 0; i < 20; i++) {
          yield [
            {
              id: `rec-${i}`,
              type: 'portfolio',
              createdAt: new Date(),
              ownerUserId: 'investor-1',
              data: { i },
            },
          ];
        }
      }

      let chunks = 0;

      const result = await pipeline.streamExport(
        'exp-token-abort',
        ExportType.PORTFOLIO,
        source(),
        { caller },
        async () => {
          chunks++;
          if (chunks === 4) {
            cancellationRequested = true;
          }
        },
        async () => cancellationRequested,
      );

      expect(result.status).toBe('cancelled');
      expect(chunks).toBe(4);
    });
  });
});
