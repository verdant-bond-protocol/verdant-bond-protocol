import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ExportStreamPipeline } from './export-stream.pipeline';
import {
  createRedactionManifest,
  partialMask,
  REDACTED_PLACEHOLDER,
  redactExportValue,
  strategyFor,
} from './export-field-redaction';
import { ExportCaller, ExportableRecord, ExportRole, ExportType } from '../interfaces/export.interface';

const investor: ExportCaller = { userId: 'alice', role: ExportRole.INVESTOR };
const issuer: ExportCaller = { userId: 'issuer-1', role: ExportRole.ISSUER };
const auditor: ExportCaller = { userId: 'aud-1', role: ExportRole.AUDITOR };

function holding(id: string, ownerUserId = 'alice'): ExportableRecord {
  return {
    id,
    type: 'holdings',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ownerUserId,
    data: {
      bondId: 7,
      balance: '1500',
      taxId: '123-45-6789',
      ssn: '6789',
      internalRiskScore: 82,
      complianceNotes: { flagged: true, reason: 'manual review' },
      privateKey: 'S-SECRET',
      wallet: { address: 'GABC', signingSeed: 'SEED', NONCE: 4 },
      beneficiaries: [{ name: 'Bob', passportNumber: 'X12345678' }],
    },
  };
}

async function* chunks(...batches: ExportableRecord[][]) {
  for (const batch of batches) yield batch;
}

async function collect(
  pipeline: ExportStreamPipeline,
  caller: ExportCaller,
  type: ExportType,
  batches: ExportableRecord[][],
  redaction?: 'strip' | 'mask',
) {
  const out: ExportableRecord[] = [];
  const result = await pipeline.streamExport('exp-1', type, chunks(...batches), { caller, redaction }, async (chunk) => {
    out.push(...chunk);
  });
  return { out, result };
}

describe('export field redaction (#506)', () => {
  let pipeline: ExportStreamPipeline;

  beforeEach(() => {
    pipeline = new ExportStreamPipeline();
  });

  describe('primitives', () => {
    it('always strips secrets, partially masks identifiers, masks the rest', () => {
      expect(strategyFor('privatekey', 'mask')).toBe('strip');
      expect(strategyFor('rawkycdocument', 'mask')).toBe('strip');
      expect(strategyFor('taxid', 'mask')).toBe('partial');
      expect(strategyFor('internalriskscore', 'mask')).toBe('mask');
      expect(strategyFor('taxid', 'strip')).toBe('strip');
    });

    it('reveals only the last 4 characters of long identifiers', () => {
      expect(partialMask('123-45-6789')).toBe('*******6789');
      expect(partialMask(12345678)).toBe('****5678');
    });

    it('fully masks short and non-scalar identifiers', () => {
      expect(partialMask('6789')).toBe(REDACTED_PLACEHOLDER);
      expect(partialMask({ nested: 'x' })).toBe(REDACTED_PLACEHOLDER);
      expect(partialMask(null)).toBe(REDACTED_PLACEHOLDER);
    });

    it('drops __proto__ in every mode', () => {
      const hostile = JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}');
      const cleaned = redactExportValue(hostile, new Set(), 'mask') as Record<string, unknown>;

      expect(Object.getPrototypeOf(cleaned)).toBe(Object.prototype);
      expect(cleaned).toEqual({ ok: 1 });
    });
  });

  describe('normal path: mask mode', () => {
    it('keeps the column set stable for investors while hiding values', async () => {
      const { out, result } = await collect(pipeline, investor, ExportType.HOLDINGS, [[holding('r1')]], 'mask');

      expect(result.status).toBe('completed');
      expect(out[0].data).toEqual({
        bondId: 7,
        balance: '1500',
        taxId: '*******6789',
        ssn: REDACTED_PLACEHOLDER,
        internalRiskScore: REDACTED_PLACEHOLDER,
        complianceNotes: REDACTED_PLACEHOLDER,
        wallet: { address: 'GABC' },
        beneficiaries: [{ name: 'Bob', passportNumber: '*****5678' }],
      });
      expect(JSON.stringify(out)).not.toMatch(/S-SECRET|SEED|manual review|123-45/);
    });

    it('applies each role’s own field list (issuers see risk score, not PII)', async () => {
      const { out } = await collect(pipeline, issuer, ExportType.HOLDINGS, [[holding('r1', 'someone-else')]], 'mask');

      expect(out[0].data.internalRiskScore).toBe(82);
      expect(out[0].data.taxId).toBe('*******6789');
      expect(out[0].data).not.toHaveProperty('privateKey');
    });

    it('returns a manifest of every redacted path with counts', async () => {
      const { result } = await collect(pipeline, investor, ExportType.HOLDINGS, [[holding('r1'), holding('r2')], [holding('r3')]], 'mask');

      expect(result.redaction).toMatchObject({ policyVersion: '1', mode: 'mask', role: ExportRole.INVESTOR });
      expect(result.redaction!.fields).toEqual({
        'data.taxId': { strategy: 'partial', count: 3 },
        'data.ssn': { strategy: 'partial', count: 3 },
        'data.internalRiskScore': { strategy: 'mask', count: 3 },
        'data.complianceNotes': { strategy: 'mask', count: 3 },
        'data.privateKey': { strategy: 'strip', count: 3 },
        'data.wallet.signingSeed': { strategy: 'strip', count: 3 },
        'data.wallet.NONCE': { strategy: 'strip', count: 3 },
        'data.beneficiaries[].passportNumber': { strategy: 'partial', count: 3 },
      });
      expect(result.redaction!.totalRedactions).toBe(24);
    });
  });

  describe('contract preservation: default strip mode', () => {
    it('produces exactly the pre-#506 output when no mode is given', async () => {
      const { out, result } = await collect(pipeline, investor, ExportType.HOLDINGS, [[holding('r1')]]);

      expect(out[0].data).toEqual({
        bondId: 7,
        balance: '1500',
        wallet: { address: 'GABC' },
        beneficiaries: [{ name: 'Bob' }],
      });
      expect(result.redaction?.mode).toBe('strip');
      expect(result.redaction?.fields['data.taxId']).toEqual({ strategy: 'strip', count: 1 });
    });

    it('keeps sanitizeRecordForCaller’s two-argument form stripping', () => {
      expect(pipeline.sanitizeRecordForCaller(holding('r1'), investor).data).not.toHaveProperty('taxId');
    });
  });

  describe('retry path', () => {
    it('is deterministic: a retried export yields identical records and manifest', async () => {
      const batches = () => [[holding('r1'), holding('r2')], [holding('r3')]];
      const first = await collect(pipeline, investor, ExportType.HOLDINGS, batches(), 'mask');
      const retry = await collect(pipeline, investor, ExportType.HOLDINGS, batches(), 'mask');

      expect(JSON.stringify(retry.out)).toBe(JSON.stringify(first.out));
      expect(retry.result.redaction).toEqual(first.result.redaction);
    });

    it('a sink failure mid-export fails the run; the retry reports only its own redactions', async () => {
      let calls = 0;
      const failing = await pipeline.streamExport(
        'exp-retry',
        ExportType.HOLDINGS,
        chunks([holding('r1')], [holding('r2')]),
        { caller: investor, redaction: 'mask' },
        async () => {
          if (++calls === 2) throw new Error('disk full');
        },
      );

      expect(failing.status).toBe('failed');
      expect(failing.error).toBe('disk full');
      expect(failing.redaction!.fields['data.taxId'].count).toBe(2);

      const retried = await collect(pipeline, investor, ExportType.HOLDINGS, [[holding('r1')], [holding('r2')]], 'mask');
      expect(retried.result.status).toBe('completed');
      expect(retried.result.redaction!.fields['data.taxId'].count).toBe(2);
    });
  });

  describe('failure and authorization paths', () => {
    it('rejects an unknown redaction mode before reading the source', async () => {
      const source = jest.fn();
      await expect(
        pipeline.streamExport('exp-x', ExportType.HOLDINGS, { [Symbol.asyncIterator]: source } as any, {
          caller: investor,
          redaction: 'blur' as any,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(source).not.toHaveBeenCalled();
    });

    it('still refuses export types the role may not access, in mask mode', async () => {
      await expect(
        collect(pipeline, investor, ExportType.KYC_PII, [[holding('r1')]], 'mask'),
      ).rejects.toThrow(ForbiddenException);
      await expect(collect(pipeline, auditor, ExportType.KYC_PII, [[holding('r1')]], 'mask')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('still enforces investor ownership in mask mode (masking is not a bypass)', async () => {
      const { result, out } = await collect(pipeline, investor, ExportType.HOLDINGS, [[holding('r1', 'mallory')]], 'mask');

      expect(result.status).toBe('failed');
      expect(result.error).toContain('ownership');
      expect(out).toEqual([]);
    });

    it('fails closed for a role with no redaction policy', () => {
      const rogue = { userId: 'x', role: 'SUPERUSER' as ExportRole };

      expect(() => pipeline.sanitizeRecordForCaller(holding('r1'), rogue, 'mask')).toThrow(ForbiddenException);
      expect(() => pipeline.sanitizeRecordForCaller(holding('r1'), rogue)).toThrow(ForbiddenException);
    });

    it('does not count redactions in a manifest it was not given', () => {
      const manifest = createRedactionManifest(ExportRole.INVESTOR, 'mask');
      pipeline.sanitizeRecordForCaller(holding('r1'), investor, 'mask');

      expect(manifest.totalRedactions).toBe(0);
    });
  });
});
