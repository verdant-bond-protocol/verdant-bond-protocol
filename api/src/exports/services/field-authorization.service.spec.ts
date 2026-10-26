import { ForbiddenException } from '@nestjs/common';
import {
  FieldAuthorizationService,
  FieldAuthorizationPolicy,
} from './field-authorization.service';
import {
  ExportRole,
  ExportType,
  ExportCaller,
  ExportableRecord,
} from '../interfaces/export.interface';

describe('FieldAuthorizationService (#424 Privacy-safe Export)', () => {
  let service: FieldAuthorizationService;

  beforeEach(() => {
    service = new FieldAuthorizationService();
  });

  const investor: ExportCaller = { userId: 'alice', role: ExportRole.INVESTOR };
  const issuer: ExportCaller = { userId: 'issuer-1', role: ExportRole.ISSUER };
  const auditor: ExportCaller = { userId: 'auditor-1', role: ExportRole.AUDITOR };
  const admin: ExportCaller = { userId: 'admin-1', role: ExportRole.ADMIN };

  function record(id: string, data: Record<string, any>, owner?: string): ExportableRecord {
    return { id, type: 'portfolio', createdAt: new Date(), data, ownerUserId: owner };
  }

  describe('Normal path: empty policy allows everything', () => {
    it('passes all fields through when no policies are registered', () => {
      const input = record('r1', { balance: 5000, memo: 'safe' }, 'alice');
      const { record: out, audit } = service.sanitizeRecord(input, investor, ExportType.PORTFOLIO);

      expect(out.data.balance).toBe(5000);
      expect(out.data.memo).toBe('safe');
      expect(audit.fieldsAllowed).toContain('balance');
      expect(audit.fieldsAllowed).toContain('memo');
      expect(audit.fieldsStripped).toHaveLength(0);
      expect(audit.fieldsRedacted).toHaveLength(0);
    });
  });

  describe('Strip path: forbidden fields are completely removed', () => {
    it('strips fields matching a STRIP policy', () => {
      service.registerPolicy({
        role: ExportRole.INVESTOR,
        action: 'STRIP',
        fields: ['ssn', 'privateKey'],
      });

      const input = record('r2', { bondId: 42, ssn: '123-45-6789', privateKey: 'KEY' }, 'alice');
      const { record: out, audit } = service.sanitizeRecord(input, investor, ExportType.PORTFOLIO);

      expect(out.data.bondId).toBe(42);
      expect(out.data.ssn).toBeUndefined();
      expect(out.data.privateKey).toBeUndefined();
      expect(audit.fieldsStripped).toEqual(expect.arrayContaining(['ssn', 'privateKey']));
    });
  });

  describe('Redact path: sensitive fields are masked', () => {
    it('masks SSN-formatted values with partial reveal', () => {
      service.registerPolicy({
        role: ExportRole.ISSUER,
        action: 'REDACT',
        fields: ['ssn'],
      });

      const input = record('r3', { ssn: '123-45-6789', name: 'visible' });
      const { record: out } = service.sanitizeRecord(input, issuer, ExportType.BONDS);

      expect(out.data.ssn).toBe('***-**-6789');
      expect(out.data.name).toBe('visible');
    });

    it('uses generic [REDACTED] for non-SSN values', () => {
      service.registerPolicy({
        role: ExportRole.ISSUER,
        action: 'REDACT',
        fields: ['taxId'],
      });

      const input = record('r4', { taxId: 'EIN-9876' });
      const { record: out } = service.sanitizeRecord(input, issuer, ExportType.BONDS);

      expect(out.data.taxId).toBe('[REDACTED]');
    });
  });

  describe('Export-type-specific policies', () => {
    it('strips a field for PORTFOLIO but allows it for COMPLIANCE_AUDIT', () => {
      service.registerPolicy({
        role: ExportRole.AUDITOR,
        exportType: ExportType.PORTFOLIO,
        action: 'STRIP',
        fields: ['internalRiskScore'],
      });
      service.registerPolicy({
        role: ExportRole.AUDITOR,
        exportType: ExportType.COMPLIANCE_AUDIT,
        action: 'ALLOW',
        fields: ['internalRiskScore'],
      });

      const data = { internalRiskScore: 72, status: 'ok' };

      const portfolio = service.sanitizeRecord(record('r5', data), auditor, ExportType.PORTFOLIO);
      expect(portfolio.record.data.internalRiskScore).toBeUndefined();

      const audit = service.sanitizeRecord(record('r6', data), auditor, ExportType.COMPLIANCE_AUDIT);
      expect(audit.record.data.internalRiskScore).toBe(72);
    });
  });

  describe('Organization override: org-specific policy wins over global', () => {
    it('applies stricter org-level policy over global role policy', () => {
      const orgCaller: ExportCaller = { userId: 'bob', role: ExportRole.ISSUER, organizationId: 'ORG-A' };

      service.registerPolicy({
        role: ExportRole.ISSUER,
        action: 'ALLOW',
        fields: ['complianceNotes'],
      });
      service.registerPolicy({
        role: ExportRole.ISSUER,
        action: 'STRIP',
        fields: ['complianceNotes'],
        organizationId: 'ORG-A',
      });

      const input = record('r7', { complianceNotes: 'sensitive org data' });
      const { record: out } = service.sanitizeRecord(input, orgCaller, ExportType.BONDS);

      expect(out.data.complianceNotes).toBeUndefined();
    });
  });

  describe('Resolution order: most specific rule wins', () => {
    it('org+type > org > type > role', () => {
      const orgCaller: ExportCaller = { userId: 'u1', role: ExportRole.AUDITOR, organizationId: 'ORG-X' };

      // Role-wide: ALLOW
      service.registerPolicy({ role: ExportRole.AUDITOR, action: 'ALLOW', fields: ['secret'] });
      // Type-specific: REDACT
      service.registerPolicy({ role: ExportRole.AUDITOR, exportType: ExportType.COMPLIANCE_AUDIT, action: 'REDACT', fields: ['secret'] });
      // Org-wide: STRIP
      service.registerPolicy({ role: ExportRole.AUDITOR, action: 'STRIP', fields: ['secret'], organizationId: 'ORG-X' });
      // Org+type: REDACT
      service.registerPolicy({ role: ExportRole.AUDITOR, exportType: ExportType.COMPLIANCE_AUDIT, action: 'REDACT', fields: ['secret'], organizationId: 'ORG-X' });

      // org+type (specificity 3) should win → REDACT
      const result = service.evaluateField('secret', orgCaller, ExportType.COMPLIANCE_AUDIT, 'val');
      expect(result.action).toBe('REDACT');

      // With a different exportType, org-wide (specificity 2) should win → STRIP
      const result2 = service.evaluateField('secret', orgCaller, ExportType.PORTFOLIO);
      expect(result2.action).toBe('STRIP');

      // Caller without org falls to type-specific → REDACT
      const noOrgCaller: ExportCaller = { userId: 'u2', role: ExportRole.AUDITOR };
      const result3 = service.evaluateField('secret', noOrgCaller, ExportType.COMPLIANCE_AUDIT, 'v');
      expect(result3.action).toBe('REDACT');

      // No org, different type → role-wide → ALLOW
      const result4 = service.evaluateField('secret', noOrgCaller, ExportType.PORTFOLIO);
      expect(result4.action).toBe('ALLOW');
    });
  });

  describe('Audit logging', () => {
    it('records every sanitize call with stripped, redacted, and allowed fields', () => {
      service.registerPolicy({ role: ExportRole.INVESTOR, action: 'STRIP', fields: ['ssn'] });
      service.registerPolicy({ role: ExportRole.INVESTOR, action: 'REDACT', fields: ['taxId'] });

      const input = record('audit-1', { balance: 100, ssn: '111-22-3333', taxId: 'TX-99' }, 'alice');
      service.sanitizeRecord(input, investor, ExportType.PORTFOLIO);

      const log = service.getAuditLog();
      expect(log).toHaveLength(1);
      expect(log[0].recordId).toBe('audit-1');
      expect(log[0].callerUserId).toBe('alice');
      expect(log[0].callerRole).toBe(ExportRole.INVESTOR);
      expect(log[0].fieldsStripped).toContain('ssn');
      expect(log[0].fieldsRedacted).toContain('taxId');
      expect(log[0].fieldsAllowed).toContain('balance');
    });

    it('caps audit log at configured max, evicting oldest entries', () => {
      const tinyService = new FieldAuthorizationService(3);

      for (let i = 0; i < 5; i++) {
        const input = record(`cap-${i}`, { val: i }, 'alice');
        tinyService.sanitizeRecord(input, investor, ExportType.PORTFOLIO);
      }

      const log = tinyService.getAuditLog();
      expect(log).toHaveLength(3);
      expect(log[0].recordId).toBe('cap-2');
      expect(log[2].recordId).toBe('cap-4');
    });
  });

  describe('Nested fields: recursive stripping and redaction', () => {
    it('strips and redacts fields at any nesting depth', () => {
      service.registerPolicy({ role: ExportRole.INVESTOR, action: 'STRIP', fields: ['privateKey'] });
      service.registerPolicy({ role: ExportRole.INVESTOR, action: 'REDACT', fields: ['ssn'] });

      const input = record('nested-1', {
        holder: {
          name: 'Alice',
          ssn: '999-88-7777',
          wallet: { privateKey: 'SECRET', address: 'GABC' },
        },
        items: [{ privateKey: 'ALSO_SECRET', amount: 10 }],
      }, 'alice');

      const { record: out, audit } = service.sanitizeRecord(input, investor, ExportType.PORTFOLIO);

      expect(out.data.holder.name).toBe('Alice');
      expect(out.data.holder.ssn).toBe('***-**-7777');
      expect(out.data.holder.wallet.privateKey).toBeUndefined();
      expect(out.data.holder.wallet.address).toBe('GABC');
      expect(out.data.items[0].privateKey).toBeUndefined();
      expect(out.data.items[0].amount).toBe(10);
      expect(audit.fieldsStripped).toEqual(expect.arrayContaining(['privateKey']));
      expect(audit.fieldsRedacted).toEqual(expect.arrayContaining(['ssn']));
    });
  });

  describe('__proto__ protection', () => {
    it('always strips __proto__ keys regardless of policy', () => {
      const data = JSON.parse('{"__proto__": {"polluted": true}, "safe": 1}');
      const input: ExportableRecord = { id: 'proto-1', type: 'portfolio', createdAt: new Date(), data, ownerUserId: 'alice' };

      const { record: out, audit } = service.sanitizeRecord(input, investor, ExportType.PORTFOLIO);

      expect(out.data.safe).toBe(1);
      expect(Object.prototype.hasOwnProperty.call(out.data, '__proto__')).toBe(false);
      expect(out.data.polluted).toBeUndefined();
      expect(audit.fieldsStripped).toContain('__proto__');
    });
  });

  describe('Case insensitivity', () => {
    it('matches SSN, ssn, and Ssn against a single policy', () => {
      service.registerPolicy({ role: ExportRole.INVESTOR, action: 'STRIP', fields: ['ssn'] });

      const input = record('case-1', { SSN: 'a', ssn: 'b', Ssn: 'c', safe: 'd' }, 'alice');
      const { record: out } = service.sanitizeRecord(input, investor, ExportType.PORTFOLIO);

      expect(out.data.SSN).toBeUndefined();
      expect(out.data.ssn).toBeUndefined();
      expect(out.data.Ssn).toBeUndefined();
      expect(out.data.safe).toBe('d');
    });
  });

  describe('Idempotency: same record sanitized twice produces same output', () => {
    it('is idempotent', () => {
      service.registerPolicy({ role: ExportRole.INVESTOR, action: 'STRIP', fields: ['secret'] });
      service.registerPolicy({ role: ExportRole.INVESTOR, action: 'REDACT', fields: ['taxId'] });

      const input = record('idem-1', { secret: 'x', taxId: '123-45-6789', val: 1 }, 'alice');
      const first = service.sanitizeRecord(input, investor, ExportType.PORTFOLIO);
      const second = service.sanitizeRecord(input, investor, ExportType.PORTFOLIO);

      expect(first.record.data).toEqual(second.record.data);
    });
  });

  describe('Authorization failure: investor cross-user access', () => {
    it('throws ForbiddenException when investor tries to export another user record', () => {
      const foreignRecord = record('foreign-1', { balance: 99 }, 'bob');

      expect(() => {
        service.sanitizeRecord(foreignRecord, investor, ExportType.PORTFOLIO);
      }).toThrow(ForbiddenException);
    });
  });
});
