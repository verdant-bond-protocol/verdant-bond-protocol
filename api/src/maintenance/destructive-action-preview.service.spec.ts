import {
  DestructiveActionError,
  DestructiveActionPreviewService,
  MaintainerActor,
} from './destructive-action-preview.service';

describe('DestructiveActionPreviewService (#529)', () => {
  let clock: number;
  let records: Map<string, { id: string; archived: boolean }>;
  let executed: string[][];
  let failNext: boolean;
  let service: DestructiveActionPreviewService;

  const admin: MaintainerActor = { id: 'admin-1', permissions: ['ARCHIVE_RECORDS'] };
  const otherAdmin: MaintainerActor = { id: 'admin-2', permissions: ['ARCHIVE_RECORDS'] };
  const viewer: MaintainerActor = { id: 'viewer', permissions: [] };

  const expectCode = async (promise: Promise<unknown>, code: string) => {
    await expect(promise).rejects.toBeInstanceOf(DestructiveActionError);
    await expect(promise).rejects.toMatchObject({ code });
  };

  beforeEach(() => {
    clock = Date.parse('2026-11-19T10:00:00Z');
    records = new Map(['a', 'b', 'c'].map((id) => [id, { id, archived: false }]));
    executed = [];
    failNext = false;
    service = new DestructiveActionPreviewService({ ttlMs: 60_000, sampleSize: 2, now: () => clock });
    service.register<{ prefix: string }, number>({
      action: 'archive_records',
      permission: 'ARCHIVE_RECORDS',
      maxAffected: 2,
      plan: ({ prefix }) => ({
        affected: [...records.values()]
          .filter((r) => !r.archived && r.id.startsWith(prefix))
          .map((r) => ({ kind: 'record', id: r.id, change: 'archive' as const })),
        reversible: true,
        rollback: 'POST /records/:id/restore for each archived id',
      }),
      execute: (_params, plan) => {
        if (failNext) {
          failNext = false;
          throw new Error('storage unavailable');
        }
        const ids = plan.affected.map((r) => r.id);
        ids.forEach((id) => (records.get(id)!.archived = true));
        executed.push(ids);
        return ids.length;
      },
    });
  });

  it('previews without mutating anything', async () => {
    const preview = await service.preview('archive_records', { prefix: '' }, admin);

    expect(preview.affectedCount).toBe(3);
    expect(preview.sample).toHaveLength(2);
    expect(preview.reversible).toBe(true);
    expect(preview.requiresBlastRadiusAck).toBe(true);
    expect(preview.risk).toBe('high');
    expect(preview.planDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(executed).toEqual([]);
    expect([...records.values()].every((r) => !r.archived)).toBe(true);
  });

  it('flags a no-op plan', async () => {
    const preview = await service.preview('archive_records', { prefix: 'zzz' }, admin);
    expect(preview.risk).toBe('none');
    expect(preview.warnings.join(' ')).toMatch(/no-op/);
  });

  it('executes a confirmed preview exactly once', async () => {
    const preview = await service.preview('archive_records', { prefix: 'a' }, admin);
    const result = await service.execute(preview.previewId, 'archive_records', { prefix: 'a' }, admin, {
      confirmPlanDigest: preview.planDigest,
    });

    expect(result).toMatchObject({ affectedCount: 1, attempts: 1, result: 1 });
    expect(executed).toEqual([['a']]);
    await expectCode(
      service.execute(preview.previewId, 'archive_records', { prefix: 'a' }, admin, {
        confirmPlanDigest: preview.planDigest,
      }),
      'PREVIEW_CONSUMED',
    );
  });

  it('requires the blast radius to be acknowledged above the cap', async () => {
    const preview = await service.preview('archive_records', { prefix: '' }, admin);
    const run = (ack?: boolean) =>
      service.execute(preview.previewId, 'archive_records', { prefix: '' }, admin, {
        confirmPlanDigest: preview.planDigest,
        acknowledgeBlastRadius: ack,
      });

    await expectCode(run(), 'BLAST_RADIUS_NOT_ACKNOWLEDGED');
    await expect(run(true)).resolves.toMatchObject({ affectedCount: 3 });
  });

  describe('failure paths', () => {
    it('refuses an unconfirmed or mismatched execution', async () => {
      const preview = await service.preview('archive_records', { prefix: 'a' }, admin);

      await expectCode(
        service.execute(preview.previewId, 'archive_records', { prefix: 'a' }, admin, { confirmPlanDigest: 'x' }),
        'PREVIEW_NOT_CONFIRMED',
      );
      await expectCode(
        service.execute(preview.previewId, 'archive_records', { prefix: 'b' }, admin, {
          confirmPlanDigest: preview.planDigest,
        }),
        'PREVIEW_PARAMS_MISMATCH',
      );
      await expectCode(
        service.execute('missing', 'archive_records', { prefix: 'a' }, admin, { confirmPlanDigest: preview.planDigest }),
        'PREVIEW_NOT_FOUND',
      );
      await expectCode(service.preview('drop_everything', {}, admin), 'UNKNOWN_ACTION');
      expect(executed).toEqual([]);
    });

    it('refuses an expired preview', async () => {
      const preview = await service.preview('archive_records', { prefix: 'a' }, admin);
      clock += 60_001;
      await expectCode(
        service.execute(preview.previewId, 'archive_records', { prefix: 'a' }, admin, {
          confirmPlanDigest: preview.planDigest,
        }),
        'PREVIEW_EXPIRED',
      );
      expect(executed).toEqual([]);
    });

    it('refuses a preview whose underlying state changed', async () => {
      const preview = await service.preview('archive_records', { prefix: '' }, admin);
      records.set('d', { id: 'd', archived: false });

      await expectCode(
        service.execute(preview.previewId, 'archive_records', { prefix: '' }, admin, {
          confirmPlanDigest: preview.planDigest,
          acknowledgeBlastRadius: true,
        }),
        'PREVIEW_STALE',
      );
      expect(executed).toEqual([]);
      expect(service.getPreview(preview.previewId)).toBeUndefined();
    });
  });

  describe('retry path', () => {
    it('keeps the preview executable after a failed execution', async () => {
      const preview = await service.preview('archive_records', { prefix: 'b' }, admin);
      const run = () =>
        service.execute(preview.previewId, 'archive_records', { prefix: 'b' }, admin, {
          confirmPlanDigest: preview.planDigest,
        });

      failNext = true;
      await expect(run()).rejects.toThrow('storage unavailable');
      await expect(run()).resolves.toMatchObject({ attempts: 2, result: 1 });
      expect(executed).toEqual([['b']]);
    });

    it('rejects a concurrent execution of the same preview', async () => {
      let release!: () => void;
      service.register<Record<string, never>, string>({
        action: 'slow_reset',
        permission: 'ARCHIVE_RECORDS',
        plan: () => ({ affected: [{ kind: 'cache', id: 'all', change: 'reset' }], reversible: false, rollback: 'none' }),
        execute: () => new Promise<string>((resolve) => (release = () => resolve('done'))),
      });
      const preview = await service.preview('slow_reset', {}, admin);
      const opts = { confirmPlanDigest: preview.planDigest };

      const first = service.execute(preview.previewId, 'slow_reset', {}, admin, opts);
      await new Promise((resolve) => setImmediate(resolve));
      await expectCode(service.execute(preview.previewId, 'slow_reset', {}, admin, opts), 'EXECUTION_IN_PROGRESS');
      release();
      await expect(first).resolves.toMatchObject({ result: 'done' });
    });
  });

  describe('authorization path', () => {
    it('refuses a preview without the permission', async () => {
      await expectCode(service.preview('archive_records', { prefix: '' }, viewer), 'FORBIDDEN');
    });

    it('only lets the previewing maintainer execute', async () => {
      const preview = await service.preview('archive_records', { prefix: 'a' }, admin);
      await expectCode(
        service.execute(preview.previewId, 'archive_records', { prefix: 'a' }, otherAdmin, {
          confirmPlanDigest: preview.planDigest,
        }),
        'PREVIEW_ACTOR_MISMATCH',
      );
    });

    it('re-checks the permission at execution time', async () => {
      const preview = await service.preview('archive_records', { prefix: 'a' }, admin);
      const revoked: MaintainerActor = { id: admin.id, permissions: [] };
      await expectCode(
        service.execute(preview.previewId, 'archive_records', { prefix: 'a' }, revoked, {
          confirmPlanDigest: preview.planDigest,
        }),
        'FORBIDDEN',
      );
      expect(executed).toEqual([]);
    });
  });
});
