import { Test, TestingModule } from '@nestjs/testing';
import { PermissionDiffService } from './permission-diff.service';

describe('PermissionDiffService', () => {
  let service: PermissionDiffService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PermissionDiffService],
    }).compile();

    service = module.get<PermissionDiffService>(PermissionDiffService);
  });

  describe('computeRoleDiff', () => {
    it('should detect added permissions', () => {
      const before = { ISSUER: ['bond:create'] };
      const after = { ISSUER: ['bond:create', 'bond:distribute-coupon'] };

      const diffs = service.computeRoleDiff(before, after);

      expect(diffs).toHaveLength(1);
      expect(diffs[0].added).toContain('bond:distribute-coupon');
      expect(diffs[0].removed).toHaveLength(0);
    });

    it('should detect removed permissions', () => {
      const before = { ISSUER: ['bond:create', 'bond:mature'] };
      const after = { ISSUER: ['bond:create'] };

      const diffs = service.computeRoleDiff(before, after);

      expect(diffs).toHaveLength(1);
      expect(diffs[0].removed).toContain('bond:mature');
      expect(diffs[0].added).toHaveLength(0);
    });

    it('should handle new roles', () => {
      const before = { ISSUER: ['bond:create'] };
      const after = { ISSUER: ['bond:create'], CUSTOM: ['custom:perm'] };

      const diffs = service.computeRoleDiff(before, after);

      expect(diffs).toHaveLength(1);
      expect(diffs[0].role).toBe('CUSTOM');
    });

    it('should handle no changes', () => {
      const before = { ISSUER: ['bond:create'] };
      const after = { ISSUER: ['bond:create'] };

      const diffs = service.computeRoleDiff(before, after);

      expect(diffs).toHaveLength(0);
    });
  });

  describe('generateReport', () => {
    it('should generate correct summary', () => {
      const before = {
        ISSUER: ['bond:create'],
        INVESTOR: ['bond:subscribe'],
      };
      const after = {
        ISSUER: ['bond:create', 'bond:mature'],
        INVESTOR: ['bond:subscribe'],
      };

      const report = service.generateReport(before, after);

      expect(report.summary.rolesModified).toBe(1);
      expect(report.summary.permissionsAdded).toBe(1);
      expect(report.summary.permissionsRemoved).toBe(0);
      expect(report.timestamp).toBeDefined();
    });
  });

  describe('validateRoleChanges', () => {
    it('should validate known roles', () => {
      const roles = {
        MAINTAINER: ['*:*'],
        ISSUER: ['bond:create'],
      };

      const result = service.validateRoleChanges({}, roles);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject unknown roles', () => {
      const roles = { UNKNOWN_ROLE: ['perm:1'] };

      const result = service.validateRoleChanges({}, roles);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Unknown role: UNKNOWN_ROLE');
    });

    it('should reject roles with no permissions', () => {
      const roles = { ISSUER: [] };

      const result = service.validateRoleChanges({}, roles);

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('no permissions');
    });
  });
});
