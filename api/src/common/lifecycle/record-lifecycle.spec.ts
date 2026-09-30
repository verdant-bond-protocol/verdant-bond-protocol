import {
  activeLifecycle,
  archiveRecord,
  assertNotArchived,
  includeArchived,
  isArchived,
  LifecycleError,
  restoreRecord,
  systemActor,
  visibleOnly,
} from './record-lifecycle';

const NOW = Date.parse('2026-06-02T00:00:00.000Z');
const LATER = NOW + 60_000;

describe('RecordLifecycle', () => {
  describe('archive', () => {
    it('records who archived, when, and why', () => {
      const lifecycle = activeLifecycle();

      archiveRecord(lifecycle, { actor: 'GADMIN', reason: 'duplicate of tx_abc124', now: NOW });

      expect(lifecycle.state).toBe('archived');
      expect(lifecycle.archivedAt).toBe(new Date(NOW).toISOString());
      expect(lifecycle.archivedBy).toBe('GADMIN');
      expect(lifecycle.archiveReason).toBe('duplicate of tx_abc124');
      expect(lifecycle.history).toEqual([
        { at: new Date(NOW).toISOString(), action: 'archive', actor: 'GADMIN', reason: 'duplicate of tx_abc124' },
      ]);
    });

    it('refuses without a reason, and without an actor', () => {
      const noReason = activeLifecycle();
      expect(() => archiveRecord(noReason, { actor: 'GADMIN', reason: '   ', now: NOW })).toThrow(
        expect.objectContaining({ code: 'missing_reason' }),
      );
      expect(isArchived({ lifecycle: noReason })).toBe(false);

      expect(() => archiveRecord(activeLifecycle(), { actor: '', reason: 'x', now: NOW })).toThrow(
        expect.objectContaining({ code: 'missing_actor' }),
      );
    });

    it('refuses to archive twice rather than overwriting the original attribution', () => {
      const lifecycle = activeLifecycle();
      archiveRecord(lifecycle, { actor: 'GADMIN', reason: 'first', now: NOW });

      expect(() => archiveRecord(lifecycle, { actor: 'GOTHER', reason: 'second', now: LATER })).toThrow(
        expect.objectContaining({ code: 'already_archived' }),
      );

      expect(lifecycle.archivedBy).toBe('GADMIN');
      expect(lifecycle.archiveReason).toBe('first');
      expect(lifecycle.history).toHaveLength(1);
    });
  });

  describe('restore', () => {
    it('clears the archive state and appends to history without erasing the archive', () => {
      const lifecycle = activeLifecycle();
      archiveRecord(lifecycle, { actor: 'GADMIN', reason: 'first', now: NOW });

      restoreRecord(lifecycle, { actor: 'GADMIN2', now: LATER });

      expect(lifecycle.state).toBe('active');
      expect(isArchived({ lifecycle })).toBe(false);
      expect(lifecycle.restoredAt).toBe(new Date(LATER).toISOString());
      expect(lifecycle.restoredBy).toBe('GADMIN2');
      expect(lifecycle.history.map((e) => e.action)).toEqual(['archive', 'restore']);
      // The last archive's attribution is still readable.
      expect(lifecycle.archivedBy).toBe('GADMIN');
      expect(lifecycle.archiveReason).toBe('first');
    });

    it('refuses to restore a record that was never archived', () => {
      const lifecycle = activeLifecycle();
      expect(() => restoreRecord(lifecycle, { actor: 'GADMIN', now: NOW })).toThrow(
        expect.objectContaining({ code: 'not_archived' }),
      );
    });

    it('re-archiving after a restore starts a new archive rather than resuming the old one', () => {
      const lifecycle = activeLifecycle();
      archiveRecord(lifecycle, { actor: 'GADMIN', reason: 'first', now: NOW });
      restoreRecord(lifecycle, { actor: 'GADMIN', now: LATER });

      archiveRecord(lifecycle, { actor: 'GADMIN', reason: 'second', now: LATER + 1 });

      expect(lifecycle.archiveReason).toBe('second');
      expect(lifecycle.restoredAt).toBeNull();
      expect(lifecycle.history.map((e) => e.action)).toEqual(['archive', 'restore', 'archive']);
    });
  });

  describe('visibility', () => {
    const withLifecycle = (id: string, archived = false) => {
      const lifecycle = activeLifecycle();
      if (archived) archiveRecord(lifecycle, { actor: 'GADMIN', reason: 'r', now: NOW });
      return { id, lifecycle };
    };

    it('omits archived records by default and includes them only on request', () => {
      const records = [withLifecycle('a'), withLifecycle('b', true), withLifecycle('c')];

      expect(visibleOnly(records).map((r) => r.id)).toEqual(['a', 'c']);
      expect(includeArchived(records, false).map((r) => r.id)).toEqual(['a', 'c']);
      expect(includeArchived(records, true).map((r) => r.id)).toEqual(['a', 'b', 'c']);
    });
  });

  it('builds an attributed principal for service-initiated transitions', () => {
    expect(systemActor('reaper')).toBe('system:reaper');
    expect(systemActor('  ')).toBe('system:unknown');
  });

  it('throws a typed error so callers can map a refused transition to a 4xx', () => {
    expect(() => archiveRecord(activeLifecycle(), { actor: 'G', reason: 'x', now: NOW })).not.toThrow(LifecycleError);
    try {
      restoreRecord(activeLifecycle(), { actor: 'G', now: NOW });
      fail('expected a LifecycleError');
    } catch (error) {
      expect(error).toBeInstanceOf(LifecycleError);
      expect((error as LifecycleError).name).toBe('LifecycleError');
    }
  });

  it('refuses a work action on an archived record, naming the record', () => {
    const lifecycle = activeLifecycle();
    archiveRecord(lifecycle, { actor: 'GADMIN', reason: 'r', now: NOW });
    const record = { id: 'pf_123', lifecycle };

    expect(() => assertNotArchived(record, 'resolving pf_123')).toThrow(
      expect.objectContaining({ code: 'archived' }),
    );
    expect(() => assertNotArchived(record, 'resolving pf_123')).toThrow(/pf_123 is archived/);
    expect(() => assertNotArchived({ id: 'pf_456', lifecycle: activeLifecycle() }, 'resolving')).not.toThrow();
  });
});
