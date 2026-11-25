import { InvariantResult, bondLifecycleInvariants } from './domain-invariants';
import { InvariantAlert, InvariantMonitor, InvariantMonitorError, MonitoredInvariant } from './invariant-monitor';

const ADMIN = { id: 'ops', isAdmin: true };
const USER = { id: 'someone' };
const T0 = Date.parse('2026-01-01T00:00:00.000Z');

const pass = (name = 'ok'): InvariantResult => ({ name, passed: true, message: `${name} holds`, code: 'OK' });
const fail = (name = 'bad'): InvariantResult => ({ name, passed: false, message: `${name} violated`, code: 'INV' });

/** A check whose result can be changed between runs. */
const switchable = (initial: () => InvariantResult | Promise<InvariantResult>) => {
  let current = initial;
  return {
    check: () => current(),
    set: (next: () => InvariantResult | Promise<InvariantResult>) => {
      current = next;
    },
  };
};

describe('InvariantMonitor (#562)', () => {
  describe('normal path', () => {
    it('reports ok when every invariant holds', async () => {
      const monitor = new InvariantMonitor([
        { id: 'a', check: () => pass('a') },
        { id: 'b', check: async () => pass('b') },
      ]);

      const report = await monitor.run(ADMIN, T0);

      expect(report).toMatchObject({ ok: true, checked: 2, healthy: 2, violated: 0, errored: 0, alerts: [] });
      expect(report.statuses[0]).toMatchObject({
        id: 'a',
        health: 'healthy',
        lastPassedAt: '2026-01-01T00:00:00.000Z',
      });
    });

    it('starts as unknown until the first run', () => {
      const monitor = new InvariantMonitor([{ id: 'a', check: () => pass() }]);
      expect(monitor.status(ADMIN)[0]).toMatchObject({ id: 'a', health: 'unknown', consecutiveFailures: 0 });
    });

    it('runs the real balance and ownership invariants', async () => {
      const monitor = new InvariantMonitor([
        { id: 'subscribed-within-supply', check: () => bondLifecycleInvariants.subscribedDoesNotExceedSupply('10', '100') },
        { id: 'oversubscribed', check: () => bondLifecycleInvariants.subscribedDoesNotExceedSupply('200', '100') },
      ]);

      const report = await monitor.run(ADMIN, T0);

      expect(report.ok).toBe(false);
      expect(report.statuses.map((s) => [s.id, s.health])).toEqual([
        ['subscribed-within-supply', 'healthy'],
        ['oversubscribed', 'violated'],
      ]);
      expect(report.statuses[1].code).toBe('INV-001');
    });
  });

  describe('violations', () => {
    it('reports a violation, alerts once, and does not repeat the alert on later runs', async () => {
      const alerts: InvariantAlert[] = [];
      const monitor = new InvariantMonitor([{ id: 'sum', check: () => fail('sum') }], {
        onAlert: (alert) => {
          alerts.push(alert);
        },
      });

      const first = await monitor.run(ADMIN, T0);
      const second = await monitor.run(ADMIN, T0 + 60_000);

      expect(first.ok).toBe(false);
      expect(first.violated).toBe(1);
      expect(first.alerts).toEqual([
        expect.objectContaining({ type: 'violation', id: 'sum', consecutiveFailures: 1, message: 'sum violated' }),
      ]);
      expect(second.alerts).toEqual([]);
      expect(second.statuses[0].consecutiveFailures).toBe(2);
      expect(alerts).toHaveLength(1);
    });

    it('does not retry a violation: it is a result, not a failure to run', async () => {
      const check = jest.fn(() => fail());
      const monitor = new InvariantMonitor([{ id: 'x', check }], { maxAttempts: 3 });

      await monitor.run(ADMIN, T0);

      expect(check).toHaveBeenCalledTimes(1);
    });

    it('waits for alertThreshold consecutive bad runs before alerting', async () => {
      const monitor = new InvariantMonitor([{ id: 'x', check: () => fail() }], { alertThreshold: 3 });

      const reports = [await monitor.run(ADMIN, T0), await monitor.run(ADMIN, T0 + 1), await monitor.run(ADMIN, T0 + 2)];

      expect(reports.map((r) => r.alerts.length)).toEqual([0, 0, 1]);
      expect(reports[2].alerts[0].consecutiveFailures).toBe(3);
    });

    it('alerts a recovery once and resets the failure count', async () => {
      const sw = switchable(() => fail());
      const monitor = new InvariantMonitor([{ id: 'x', check: sw.check }]);
      await monitor.run(ADMIN, T0);

      sw.set(() => pass('x'));
      const recovered = await monitor.run(ADMIN, T0 + 1000);
      const after = await monitor.run(ADMIN, T0 + 2000);

      expect(recovered.alerts).toEqual([expect.objectContaining({ type: 'recovered', id: 'x', consecutiveFailures: 0 })]);
      expect(recovered.statuses[0]).toMatchObject({ health: 'healthy', consecutiveFailures: 0 });
      expect(recovered.statuses[0].lastViolatedAt).toBe(new Date(T0).toISOString());
      expect(after.alerts).toEqual([]);
    });

    it('does not announce a recovery for a failure that never alerted', async () => {
      const sw = switchable(() => fail());
      const monitor = new InvariantMonitor([{ id: 'x', check: sw.check }], { alertThreshold: 2 });
      await monitor.run(ADMIN, T0);

      sw.set(() => pass());

      expect((await monitor.run(ADMIN, T0 + 1)).alerts).toEqual([]);
    });
  });

  describe('checks that cannot run', () => {
    it('retries a check that throws and treats a later success as healthy', async () => {
      let calls = 0;
      const monitor = new InvariantMonitor([
        {
          id: 'flaky',
          check: () => {
            if (++calls === 1) throw new Error('db busy');
            return pass();
          },
        },
      ]);

      const report = await monitor.run(ADMIN, T0);

      expect(calls).toBe(2);
      expect(report.ok).toBe(true);
    });

    it('reports an error, attributed to the check id, when it keeps throwing', async () => {
      const monitor = new InvariantMonitor([
        {
          id: 'broken',
          check: () => {
            throw new Error('connection refused');
          },
        },
        { id: 'fine', check: () => pass() },
      ]);

      const report = await monitor.run(ADMIN, T0);

      expect(report).toMatchObject({ ok: false, errored: 1, violated: 0, healthy: 1 });
      expect(report.statuses[0]).toMatchObject({ id: 'broken', health: 'errored' });
      expect(report.statuses[0].message).toMatch(/after 2 attempt\(s\): connection refused/);
      expect(report.alerts).toEqual([expect.objectContaining({ type: 'check_error', id: 'broken' })]);
    });

    it('times out a hung check without blocking the others', async () => {
      const monitor = new InvariantMonitor(
        [
          { id: 'hung', check: () => new Promise<InvariantResult>(() => undefined) },
          { id: 'fine', check: () => pass() },
        ],
        { timeoutMs: 15, maxAttempts: 1 },
      );

      const report = await monitor.run(ADMIN, T0);

      expect(report.statuses[0]).toMatchObject({ id: 'hung', health: 'errored' });
      expect(report.statuses[0].message).toMatch(/timed out after 15ms/);
      expect(report.statuses[1].health).toBe('healthy');
    });

    it('alerts again when a check moves from violated to errored', async () => {
      const sw = switchable(() => fail());
      const monitor = new InvariantMonitor([{ id: 'x', check: sw.check }], { maxAttempts: 1 });
      await monitor.run(ADMIN, T0);

      sw.set(() => {
        throw new Error('rpc down');
      });
      const report = await monitor.run(ADMIN, T0 + 1);

      expect(report.alerts).toEqual([expect.objectContaining({ type: 'check_error', id: 'x' })]);
    });
  });

  describe('alert sink and overlap', () => {
    it('counts a failing alert sink instead of stopping the monitor', async () => {
      const monitor = new InvariantMonitor(
        [
          { id: 'a', check: () => fail() },
          { id: 'b', check: () => fail() },
        ],
        {
          onAlert: () => {
            throw new Error('pager down');
          },
        },
      );

      const report = await monitor.run(ADMIN, T0);

      expect(report.alerts).toHaveLength(2);
      expect(report.alertErrors).toBe(2);
      expect(report.violated).toBe(2);
    });

    it('shares one run between overlapping calls and allows a new run afterwards', async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const check = jest.fn(async () => {
        await gate;
        return pass();
      });
      const monitor = new InvariantMonitor([{ id: 'slow', check }]);

      const first = monitor.run(ADMIN, T0);
      const second = monitor.run(ADMIN, T0);
      release();
      const [a, b] = await Promise.all([first, second]);

      expect(a).toBe(b);
      expect(check).toHaveBeenCalledTimes(1);

      await monitor.run(ADMIN, T0 + 1);
      expect(check).toHaveBeenCalledTimes(2);
    });
  });

  describe('authorization and configuration', () => {
    it('refuses run and status for non-admin and missing actors', async () => {
      const check = jest.fn(() => pass());
      const monitor = new InvariantMonitor([{ id: 'a', check }]);

      expect(() => monitor.run(USER)).toThrow('Invariant monitoring requires an admin actor');
      expect(() => monitor.status(USER)).toThrow(InvariantMonitorError);
      expect(() => monitor.run(undefined as never)).toThrow(InvariantMonitorError);
      expect(check).not.toHaveBeenCalled();
    });

    it('rejects duplicate ids, blank ids and bad options', () => {
      const a: MonitoredInvariant = { id: 'a', check: () => pass() };
      expect(() => new InvariantMonitor([a, a])).toThrow(/Duplicate invariant id a/);
      expect(() => new InvariantMonitor([{ id: '', check: () => pass() }])).toThrow(InvariantMonitorError);
      expect(() => new InvariantMonitor([a], { maxAttempts: 0 })).toThrow(/maxAttempts/);
      expect(() => new InvariantMonitor([a], { timeoutMs: -1 })).toThrow(/timeoutMs/);
      expect(() => new InvariantMonitor([a], { alertThreshold: 1.5 })).toThrow(/alertThreshold/);
    });

    it('returns status copies that cannot alter the monitor', async () => {
      const monitor = new InvariantMonitor([{ id: 'a', check: () => pass() }]);
      await monitor.run(ADMIN, T0);

      monitor.status(ADMIN)[0].health = 'violated';

      expect(monitor.status(ADMIN)[0].health).toBe('healthy');
    });
  });
});
