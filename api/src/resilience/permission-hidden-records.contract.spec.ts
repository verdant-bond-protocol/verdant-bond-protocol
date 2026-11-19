/**
 * Contract tests for permission changes and hidden records.
 *
 * These pin the *public* shape of two contracts that other teams consume:
 * the role-diff report emitted on permission changes, and the visibility
 * rules that decide whether a record is searchable. A change to either is a
 * breaking change and must be accompanied by a version bump / migration note
 * in docs/RESILIENCE_SLICE.md.
 */

import { PermissionDiffService, RoleDiffReport } from '../auth/permission-diff.service';
import {
  EntityType,
  IndexEntry,
  SearchIndexService,
  VisibilityLevel,
  defaultPermissionChecker,
} from '../common/search/search-index.service';
import { RedisService } from '../common/services/redis.service';
import { ConfigService } from '../config/config.service';
import { StatusService } from '../status/status.service';
import {
  ArchiveState,
  activeLifecycle,
  archiveRecord,
  assertNotArchived,
  isArchived,
  restoreRecord,
  visibleOnly,
} from '../common/lifecycle/record-lifecycle';

const OWNER = 'GOWNER00000000000000000000000000000000000000000000000';
const VIEWER = 'GVIEWER00000000000000000000000000000000000000000000000';
const ADMIN = 'GADMIN000000000000000000000000000000000000000000000000';

function inMemoryRedis(): RedisService {
  const values = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  return {
    get: jest.fn(async (key: string) => values.get(key) ?? null),
    setEx: jest.fn(async (key: string, _seconds: number, value: string) => {
      values.set(key, value);
      return 'OK';
    }),
    del: jest.fn(async (key: string) => {
      values.delete(key);
      return 1;
    }),
    sAdd: jest.fn(async (key: string, member: string) => {
      const set = sets.get(key) ?? new Set<string>();
      set.add(member);
      sets.set(key, set);
      return 1;
    }),
    sMembers: jest.fn(async (key: string) => [...(sets.get(key) ?? [])]),
  } as unknown as RedisService;
}

function entry(overrides: Partial<IndexEntry> = {}): IndexEntry {
  return {
    id: 'entry-1',
    recordId: 'bond-1',
    entityType: EntityType.BOND,
    visibility: VisibilityLevel.PUBLIC,
    indexedAt: 0,
    updatedAt: 0,
    permissions: [],
    searchableFields: { name: 'Forest bond' },
    ownerAddress: OWNER,
    ...overrides,
  };
}

describe('permission-change report contract', () => {
  const service = new PermissionDiffService();

  it('emits a stable, complete report shape for added and removed permissions', () => {
    const before = { ISSUER: ['bond:create', 'bond:mature'] };
    const after = { ISSUER: ['bond:create', 'bond:distribute-coupon'] };
    const report: RoleDiffReport = service.generateReport(before, after);

    expect(Object.keys(report).sort()).toEqual(['diffs', 'summary', 'timestamp']);
    expect(Number.isNaN(Date.parse(report.timestamp))).toBe(false);
    expect(report.diffs).toEqual([
      {
        role: 'ISSUER',
        added: ['bond:distribute-coupon'],
        removed: ['bond:mature'],
        modified: {},
      },
    ]);
    expect(report.summary).toEqual({
      rolesModified: 1,
      permissionsAdded: 1,
      permissionsRemoved: 1,
    });
  });

  it('reports a newly introduced role and a removed role symmetrically', () => {
    const diffs = service.computeRoleDiff(
      { ISSUER: ['bond:create'] },
      { CUSTOM: ['custom:perm'] },
    );

    expect(diffs.map((d) => d.role).sort()).toEqual(['CUSTOM', 'ISSUER']);
    expect(diffs.find((d) => d.role === 'ISSUER')?.removed).toEqual(['bond:create']);
    expect(diffs.find((d) => d.role === 'CUSTOM')?.added).toEqual(['custom:perm']);
  });

  it('is order-insensitive: reordering permissions is not a change', () => {
    expect(
      service.computeRoleDiff(
        { INVESTOR: ['bond:subscribe', 'credit:claim'] },
        { INVESTOR: ['credit:claim', 'bond:subscribe'] },
      ),
    ).toEqual([]);
  });

  it('rejects empty roles and unknown roles but accepts a permissioned CUSTOM role', () => {
    expect(service.validateRoleChanges({}, { ISSUER: [] }).valid).toBe(false);
    expect(service.validateRoleChanges({}, { UNKNOWN: ['p'] }).errors).toContain(
      'Unknown role: UNKNOWN',
    );
    expect(service.validateRoleChanges({}, { CUSTOM: ['p'] }).valid).toBe(true);
  });
});

describe('hidden-record visibility contract', () => {
  it('maps every visibility level to the documented viewer rule', () => {
    const restricted = entry({
      visibility: VisibilityLevel.RESTRICTED,
      permissions: [VIEWER],
    });

    expect(defaultPermissionChecker(VIEWER, entry({ visibility: VisibilityLevel.PUBLIC }))).toBe(true);
    expect(defaultPermissionChecker(VIEWER, restricted)).toBe(true);
    expect(defaultPermissionChecker(OWNER, entry({ visibility: VisibilityLevel.RESTRICTED, ownerAddress: OWNER }))).toBe(true);
    expect(defaultPermissionChecker(VIEWER, entry({ visibility: VisibilityLevel.PRIVATE, ownerAddress: OWNER }))).toBe(false);
    expect(defaultPermissionChecker(OWNER, entry({ visibility: VisibilityLevel.PRIVATE, ownerAddress: OWNER }))).toBe(true);

    for (const level of [VisibilityLevel.HIDDEN, VisibilityLevel.REVOKED, VisibilityLevel.DELETED]) {
      const record = entry({ visibility: level, permissions: [VIEWER] });
      expect(defaultPermissionChecker(VIEWER, record)).toBe(false);
      // Even the owner cannot recover a hidden/revoked/deleted record via search.
      expect(defaultPermissionChecker(OWNER, record)).toBe(false);
    }
  });

  it('hide/unhide and revoke/restore are reversible through the index, delete is not', async () => {
    const index = new SearchIndexService(
      inMemoryRedis(),
      { getBondIssuerAddress: () => 'CISSUER' } as unknown as ConfigService,
    );
    await index.upsert(entry());
    const hooks = [jest.fn(async () => undefined)];

    await index.handleVisibilityChange(EntityType.BOND, 'bond-1', 'hide', ADMIN, hooks);
    expect((await index.getVisibility(EntityType.BOND, 'bond-1'))).toBe(VisibilityLevel.HIDDEN);
    expect((await index.search(EntityType.BOND, '', VIEWER)).total).toBe(0);
    expect(hooks[0]).toHaveBeenCalledWith(EntityType.BOND, 'bond-1', 'hide', ADMIN);

    await index.handleVisibilityChange(EntityType.BOND, 'bond-1', 'unhide', ADMIN);
    expect((await index.search(EntityType.BOND, '', VIEWER)).total).toBe(1);

    await index.handleVisibilityChange(EntityType.BOND, 'bond-1', 'revoke', ADMIN);
    expect((await index.search(EntityType.BOND, '', OWNER)).total).toBe(0);
    await index.handleVisibilityChange(EntityType.BOND, 'bond-1', 'restore', ADMIN);
    expect((await index.getVisibility(EntityType.BOND, 'bond-1'))).toBe(VisibilityLevel.RESTRICTED);

    await index.handleVisibilityChange(EntityType.BOND, 'bond-1', 'delete', ADMIN);
    expect(await index.getEntry(EntityType.BOND, 'bond-1')).toBeNull();
  });

  it('archived lifecycle records are hidden from public reads, restore republishes them', () => {
    const a = { id: 'a', lifecycle: activeLifecycle() };
    const b = { id: 'b', lifecycle: activeLifecycle() };

    archiveRecord(a.lifecycle, { actor: ADMIN, reason: 'superseded', now: 1 });
    expect(a.lifecycle.state).toBe(ArchiveState.Archived);
    expect(visibleOnly([a, b]).map((r) => r.id)).toEqual(['b']);
    expect(() => assertNotArchived(a, 'mutate')).toThrow(/archived/);

    restoreRecord(a.lifecycle, { actor: ADMIN, now: 2 });
    expect(isArchived(a)).toBe(false);
    expect(visibleOnly([a, b]).map((r) => r.id)).toEqual(['a', 'b']);
    expect(a.lifecycle.history.map((e) => e.action)).toEqual(['archive', 'restore']);
  });

  it('the public status feed never exposes archived maintenance windows', async () => {
    const status = new StatusService(
      { isHealthy: () => true } as any,
      { findMany: jest.fn(async () => ({ data: [], meta: {} })) } as any,
    );
    const now = Date.parse('2026-06-01T00:00:00.000Z');
    const window = status.scheduleMaintenance(
      'Withdrawn work',
      new Date(now).toISOString(),
      new Date(now + 60_000).toISOString(),
      ADMIN,
      now,
    );
    status.archiveMaintenance(window.id, ADMIN, 'superseded', now + 1);

    const publicReport = await status.getPublicStatus(now + 1);
    expect(publicReport.maintenanceWindows).toEqual([]);
    expect(status.listMaintenance({ includeArchived: true, now: now + 1 })).toHaveLength(1);
  });
});
