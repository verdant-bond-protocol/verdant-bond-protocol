import { InvariantCheck } from './domain-invariants';

/**
 * Invariant monitoring for balances and ownership (issue #562).
 *
 * `domain-invariants.ts` defines the checks; this module runs them as a
 * monitor and tells operators when one starts or stops failing.
 *
 * - Each check is registered under a stable id, so a check that throws is still
 *   attributed to it (the plain runner reports those as "Unknown").
 * - A check has three outcomes: it passes, it reports a **violation** (the
 *   data is wrong), or it **errors** (it could not run: it threw or timed
 *   out). The two are never mixed up, and only the second is retried.
 * - An alert fires once when a check goes bad and once when it recovers, not on
 *   every run, so a persistent violation does not page every interval.
 *   `alertThreshold` delays the first alert until that many consecutive bad runs.
 * - A broken alert sink is counted, never allowed to stop the monitor.
 * - Runs never overlap: a call made while a run is in flight shares its result.
 * - Running the monitor and reading its status are admin-only.
 */

export type InvariantHealth = 'unknown' | 'healthy' | 'violated' | 'errored';

export interface MonitoredInvariant {
  /** Stable id, e.g. `holder-balances-sum`. */
  id: string;
  check: InvariantCheck;
}

export interface InvariantStatus {
  id: string;
  health: InvariantHealth;
  /** Consecutive runs that were not healthy. */
  consecutiveFailures: number;
  message?: string;
  code?: string;
  lastCheckedAt?: string;
  lastPassedAt?: string;
  lastViolatedAt?: string;
}

export interface InvariantAlert {
  type: 'violation' | 'check_error' | 'recovered';
  id: string;
  message: string;
  consecutiveFailures: number;
  at: string;
}

export interface MonitorReport {
  /** True only when every check passed. */
  ok: boolean;
  checked: number;
  healthy: number;
  violated: number;
  errored: number;
  alerts: InvariantAlert[];
  /** Alerts the sink failed to accept. */
  alertErrors: number;
  statuses: InvariantStatus[];
}

export interface InvariantMonitorOptions {
  /** Per-attempt limit for one check. Default 5000. */
  timeoutMs?: number;
  /** Attempts for a check that throws or times out. Default 2. */
  maxAttempts?: number;
  /** Consecutive bad runs before the first alert. Default 1. */
  alertThreshold?: number;
  onAlert?: (alert: InvariantAlert) => void | Promise<void>;
}

export interface MonitorActor {
  id: string;
  isAdmin?: boolean;
}

export class InvariantMonitorError extends Error {
  constructor(
    public readonly code: 'forbidden' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'InvariantMonitorError';
  }
}

type Outcome =
  | { kind: 'pass'; message: string; code: string }
  | { kind: 'violation'; message: string; code: string }
  | { kind: 'error'; message: string; code: string };

interface TrackedState extends InvariantStatus {
  alertedAs?: 'violation' | 'check_error';
}

const withTimeout = <T>(work: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

const assertAdmin = (actor: MonitorActor | undefined): void => {
  if (!actor?.isAdmin) throw new InvariantMonitorError('forbidden', 'Invariant monitoring requires an admin actor');
};

export class InvariantMonitor {
  private readonly state = new Map<string, TrackedState>();
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly alertThreshold: number;
  private inFlight?: Promise<MonitorReport>;

  constructor(
    private readonly invariants: readonly MonitoredInvariant[],
    private readonly options: InvariantMonitorOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.maxAttempts = options.maxAttempts ?? 2;
    this.alertThreshold = options.alertThreshold ?? 1;
    for (const [name, value] of [
      ['timeoutMs', this.timeoutMs],
      ['maxAttempts', this.maxAttempts],
      ['alertThreshold', this.alertThreshold],
    ] as const) {
      if (!Number.isInteger(value) || value < 1) {
        throw new InvariantMonitorError('invalid', `${name} must be a positive integer`);
      }
    }
    for (const { id } of invariants) {
      if (!id) throw new InvariantMonitorError('invalid', 'Every invariant needs an id');
      if (this.state.has(id)) throw new InvariantMonitorError('invalid', `Duplicate invariant id ${id}`);
      this.state.set(id, { id, health: 'unknown', consecutiveFailures: 0 });
    }
  }

  /** Runs every check once. A call during a run shares that run's report. */
  run(actor: MonitorActor, now: number = Date.now()): Promise<MonitorReport> {
    assertAdmin(actor);
    if (!this.inFlight) {
      this.inFlight = this.execute(now).finally(() => {
        this.inFlight = undefined;
      });
    }
    return this.inFlight;
  }

  /** Last known status of every check, without running anything. */
  status(actor: MonitorActor): InvariantStatus[] {
    assertAdmin(actor);
    return this.snapshot();
  }

  private snapshot(): InvariantStatus[] {
    return this.invariants.map(({ id }) => {
      const tracked = this.state.get(id) as TrackedState;
      return {
        id: tracked.id,
        health: tracked.health,
        consecutiveFailures: tracked.consecutiveFailures,
        message: tracked.message,
        code: tracked.code,
        lastCheckedAt: tracked.lastCheckedAt,
        lastPassedAt: tracked.lastPassedAt,
        lastViolatedAt: tracked.lastViolatedAt,
      };
    });
  }

  private async execute(now: number): Promise<MonitorReport> {
    const at = new Date(now).toISOString();
    const alerts: InvariantAlert[] = [];

    for (const { id, check } of this.invariants) {
      const outcome = await this.evaluate(check);
      const tracked = this.state.get(id) as TrackedState;
      tracked.lastCheckedAt = at;
      tracked.message = outcome.message;
      tracked.code = outcome.code;

      if (outcome.kind === 'pass') {
        if (tracked.alertedAs) {
          alerts.push({ type: 'recovered', id, message: outcome.message, consecutiveFailures: 0, at });
        }
        tracked.health = 'healthy';
        tracked.consecutiveFailures = 0;
        tracked.lastPassedAt = at;
        tracked.alertedAs = undefined;
        continue;
      }

      tracked.consecutiveFailures++;
      tracked.health = outcome.kind === 'violation' ? 'violated' : 'errored';
      if (outcome.kind === 'violation') tracked.lastViolatedAt = at;

      const alertType = outcome.kind === 'violation' ? 'violation' : 'check_error';
      if (tracked.consecutiveFailures >= this.alertThreshold && tracked.alertedAs !== alertType) {
        tracked.alertedAs = alertType;
        alerts.push({
          type: alertType,
          id,
          message: outcome.message,
          consecutiveFailures: tracked.consecutiveFailures,
          at,
        });
      }
    }

    let alertErrors = 0;
    if (this.options.onAlert) {
      for (const alert of alerts) {
        try {
          await this.options.onAlert(alert);
        } catch {
          alertErrors++;
        }
      }
    }

    const statuses = this.snapshot();
    const count = (health: InvariantHealth) => statuses.filter((s) => s.health === health).length;
    return {
      ok: statuses.every((s) => s.health === 'healthy'),
      checked: statuses.length,
      healthy: count('healthy'),
      violated: count('violated'),
      errored: count('errored'),
      alerts,
      alertErrors,
      statuses,
    };
  }

  /** A violation is a result, not a failure to run, so it is never retried. */
  private async evaluate(check: InvariantCheck): Promise<Outcome> {
    let lastError = '';
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const result = await withTimeout(
          Promise.resolve().then(() => check()),
          this.timeoutMs,
        );
        return {
          kind: result.passed ? 'pass' : 'violation',
          message: result.message,
          code: result.code,
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    return {
      kind: 'error',
      message: `Check could not run after ${this.maxAttempts} attempt(s): ${lastError}`,
      code: 'ERR',
    };
  }
}
