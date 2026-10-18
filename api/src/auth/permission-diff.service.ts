import { Injectable } from '@nestjs/common';

export interface PermissionDiff {
  role: string;
  added: string[];
  removed: string[];
  modified: Record<string, { before: string; after: string }>;
}

export interface RoleDiffReport {
  timestamp: string;
  diffs: PermissionDiff[];
  summary: {
    rolesModified: number;
    permissionsAdded: number;
    permissionsRemoved: number;
  };
}

export const DEFAULT_ROLES = {
  MAINTAINER: ['*:*'],
  ISSUER: [
    'bond:create',
    'bond:distribute-coupon',
    'bond:mature',
    'bond:export',
    'project:approve',
    'project:reject',
  ],
  INVESTOR: ['bond:subscribe', 'credit:claim', 'bond:transfer'],
  SETTLEMENT_MANAGER: [
    'holder:reconcile',
    'holder:reindex',
    'fund:sweep',
    'oracle:register-provider',
    'oracle:manage-incident',
  ],
};

@Injectable()
export class PermissionDiffService {
  computeRoleDiff(
    before: Record<string, string[]>,
    after: Record<string, string[]>,
  ): PermissionDiff[] {
    const diffs: PermissionDiff[] = [];
    const allRoles = new Set([
      ...Object.keys(before),
      ...Object.keys(after),
    ]);

    for (const role of allRoles) {
      const beforePerms = new Set(before[role] || []);
      const afterPerms = new Set(after[role] || []);

      const added = Array.from(afterPerms).filter((p) => !beforePerms.has(p));
      const removed = Array.from(beforePerms).filter((p) => !afterPerms.has(p));

      if (added.length > 0 || removed.length > 0) {
        diffs.push({
          role,
          added,
          removed,
          modified: {},
        });
      }
    }

    return diffs;
  }

  generateReport(
    before: Record<string, string[]>,
    after: Record<string, string[]>,
  ): RoleDiffReport {
    const diffs = this.computeRoleDiff(before, after);

    const summary = {
      rolesModified: diffs.length,
      permissionsAdded: diffs.reduce((sum, d) => sum + d.added.length, 0),
      permissionsRemoved: diffs.reduce((sum, d) => sum + d.removed.length, 0),
    };

    return {
      timestamp: new Date().toISOString(),
      diffs,
      summary,
    };
  }

  validateRoleChanges(
    before: Record<string, string[]>,
    after: Record<string, string[]>,
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    for (const role of Object.keys(after)) {
      if (!DEFAULT_ROLES[role] && role !== 'CUSTOM') {
        errors.push(`Unknown role: ${role}`);
      }

      const perms = new Set(after[role]);
      if (perms.size === 0) {
        errors.push(`Role ${role} has no permissions`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
