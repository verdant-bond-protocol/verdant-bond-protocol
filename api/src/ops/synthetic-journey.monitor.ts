/**
 * Synthetic journey monitor for the investor subscription workflow (#380).
 *
 * Drives the public API exactly as the investor UI does — readiness, bond
 * discovery, bond detail, subscription preview and, when explicitly enabled
 * on a non-production network, a real subscription confirmed on-chain — and
 * reports per-step latency, failures and the dependency to blame.
 *
 * Black-box by design: it needs only the API base URL, so it measures what a
 * user experiences (routing, guards, Redis, Soroban RPC, the network) rather
 * than any one service in isolation. It holds no state between runs.
 */

/** The dependency a failed step is attributed to. */
export type JourneyDependency =
  | 'api'             // the API process itself: unreachable, timed out, 5xx without a dependency signal, contract regression
  | 'redis'           // reported degraded by /health/ready
  | 'soroban-rpc'     // contract reads/simulation through Soroban RPC
  | 'stellar-network' // transaction submission, inclusion or execution on the ledger
  | 'config'          // misconfigured contract addresses or synthetic credentials
  | 'data';           // no bond the probe can subscribe to

export type JourneyStepName =
  | 'readiness'
  | 'list-bonds'
  | 'bond-detail'
  | 'preview-subscribe'
  | 'subscribe'
  | 'confirm-transaction';

export interface JourneyStepResult {
  name: JourneyStepName;
  ok: boolean;
  latencyMs: number;
  httpStatus?: number;
  /** Set on failure. */
  dependency?: JourneyDependency;
  error?: string;
}

export interface JourneyReport {
  journey: 'investor-subscription';
  ok: boolean;
  startedAt: string;
  totalLatencyMs: number;
  bondId?: number;
  transactionHash?: string;
  steps: JourneyStepResult[];
  /** The first failed step's dependency: the most likely root cause. */
  blame: JourneyDependency | null;
  /** Dependencies /health/ready reported as not healthy, for corroboration. */
  degradedDependencies: JourneyDependency[];
}

export interface SyntheticWriteConfig {
  /** Bearer token of a KYC-verified synthetic investor. */
  token: string;
  investorAddress: string;
}

export interface SyntheticJourneyConfig {
  /** API origin, e.g. https://api.example.org (the API serves under /api). */
  baseUrl: string;
  /** Probe a specific bond instead of the first subscribable one. */
  bondId?: number;
  /** Token amount used for the preview and the optional subscription. */
  amount: number;
  stepTimeoutMs: number;
  /** Present only when a real subscription should be submitted. */
  write?: SyntheticWriteConfig;
  /** How long to wait for the subscription transaction to settle. */
  confirmTimeoutMs: number;
  confirmPollMs: number;
}

export interface JourneyRuntime {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Unique key per run so a retried run never reuses another run's subscription. */
  idempotencyKey: () => string;
}

class StepFailure extends Error {
  constructor(
    readonly dependency: JourneyDependency,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
  }
}

interface BondSummary {
  id: number;
  status: string;
  totalSupply: string;
  totalSubscribed: string;
}

/** Steps that read contract state: a server error there is an RPC fault. */
const CHAIN_READ_DEPENDENCY: JourneyDependency = 'soroban-rpc';

export class SyntheticJourneyMonitor {
  constructor(
    private readonly config: SyntheticJourneyConfig,
    private readonly runtime: JourneyRuntime,
  ) {}

  /** One pass through the journey. Never throws; failures are in the report. O(steps). */
  async run(): Promise<JourneyReport> {
    const started = this.runtime.now();
    const report: JourneyReport = {
      journey: 'investor-subscription',
      ok: false,
      startedAt: new Date(started).toISOString(),
      totalLatencyMs: 0,
      steps: [],
      blame: null,
      degradedDependencies: [],
    };

    // Readiness is diagnostic: a degraded dependency is recorded, and the
    // journey continues so the report shows whether users are affected.
    await this.step(report, 'readiness', async () => {
      report.degradedDependencies = await this.readiness();
      if (report.degradedDependencies.length > 0) {
        throw new StepFailure(report.degradedDependencies[0], `Degraded: ${report.degradedDependencies.join(', ')}`);
      }
    });

    const completed =
      (await this.step(report, 'list-bonds', async () => {
        report.bondId = await this.pickBond();
      })) &&
      (await this.step(report, 'bond-detail', () => this.getJson(`/api/bonds/${report.bondId}/detail`, CHAIN_READ_DEPENDENCY))) &&
      (await this.step(report, 'preview-subscribe', () => this.preview(report.bondId!))) &&
      (!this.config.write ||
        ((await this.step(report, 'subscribe', async () => {
          report.transactionHash = await this.subscribe(report.bondId!, this.config.write!);
        })) &&
          (await this.step(report, 'confirm-transaction', () => this.confirm(report.transactionHash!)))));

    report.ok = Boolean(completed) && report.steps.every((s) => s.ok);
    report.blame = report.steps.find((s) => !s.ok)?.dependency ?? null;
    report.totalLatencyMs = this.runtime.now() - started;
    return report;
  }

  private async step(report: JourneyReport, name: JourneyStepName, body: () => Promise<unknown>): Promise<boolean> {
    const started = this.runtime.now();
    try {
      await body();
      report.steps.push({ name, ok: true, latencyMs: this.runtime.now() - started });
      return true;
    } catch (error) {
      const failure =
        error instanceof StepFailure ? error : new StepFailure('api', error instanceof Error ? error.message : String(error));
      report.steps.push({
        name,
        ok: false,
        latencyMs: this.runtime.now() - started,
        httpStatus: failure.httpStatus,
        dependency: failure.dependency,
        error: failure.message,
      });
      return false;
    }
  }

  /** Maps GET /api/health/ready to the dependencies it reports as not healthy. */
  private async readiness(): Promise<JourneyDependency[]> {
    const body = await this.getJson<{
      redis?: string;
      contracts?: Record<string, { status: string }>;
    }>('/api/health/ready', 'api');
    const contractStates = Object.values(body.contracts ?? {}).map((c) => c.status);
    const degraded: JourneyDependency[] = [];
    if (body.redis !== 'up') degraded.push('redis');
    if (contractStates.includes('misconfigured')) degraded.push('config');
    if (contractStates.includes('unreachable')) degraded.push('soroban-rpc');
    return degraded;
  }

  private async pickBond(): Promise<number> {
    if (this.config.bondId !== undefined) return this.config.bondId;
    const page = await this.getJson<{ data?: BondSummary[] }>('/api/bonds?page=1&limit=20', CHAIN_READ_DEPENDENCY);
    const amount = BigInt(this.config.amount);
    const bond = (page.data ?? []).find(
      (b) => b.status === 'Active' && BigInt(b.totalSupply) - BigInt(b.totalSubscribed) >= amount,
    );
    if (!bond) throw new StepFailure('data', `No active bond with ${this.config.amount} unsubscribed token(s) on page 1`);
    return bond.id;
  }

  private async preview(bondId: number): Promise<void> {
    const preview = await this.getJson<{ expected_failure: string | null }>(
      `/api/bonds/${bondId}/preview-subscribe?amount=${this.config.amount}`,
      CHAIN_READ_DEPENDENCY,
    );
    if (preview.expected_failure) {
      throw new StepFailure('data', `Contract would reject the subscription: ${preview.expected_failure}`);
    }
  }

  private async subscribe(bondId: number, write: SyntheticWriteConfig): Promise<string> {
    const response = await this.request(`/api/bonds/${bondId}/subscribe`, 'stellar-network', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${write.token}`,
        'Idempotency-Key': this.runtime.idempotencyKey(),
      },
      body: JSON.stringify({ amount: this.config.amount, investorAddress: write.investorAddress }),
    });
    const body = (await response.json()) as { transactionHash?: string };
    if (!body.transactionHash) throw new StepFailure('api', 'Subscription response carried no transactionHash');
    return body.transactionHash;
  }

  /** Polls GET /api/stellar/transactions/:hash until the ledger settles the transaction. */
  private async confirm(hash: string): Promise<void> {
    const deadline = this.runtime.now() + this.config.confirmTimeoutMs;
    for (;;) {
      const { status } = await this.getJson<{ status: 'pending' | 'confirmed' | 'failed' }>(
        `/api/stellar/transactions/${hash}`,
        CHAIN_READ_DEPENDENCY,
      );
      if (status === 'confirmed') return;
      if (status === 'failed') throw new StepFailure('stellar-network', `Transaction ${hash} failed on-chain`);
      if (this.runtime.now() >= deadline) {
        throw new StepFailure('stellar-network', `Transaction ${hash} not confirmed within ${this.config.confirmTimeoutMs}ms`);
      }
      await this.runtime.sleep(this.config.confirmPollMs);
    }
  }

  private async getJson<T>(path: string, serverErrorDependency: JourneyDependency): Promise<T> {
    const response = await this.request(path, serverErrorDependency);
    return (await response.json()) as T;
  }

  /**
   * One HTTP call with a timeout. Attribution: no answer → `api`; 401/403 →
   * `config` (synthetic credentials); other 4xx → `api` (contract regression);
   * 5xx → the step's own dependency.
   */
  private async request(path: string, serverErrorDependency: JourneyDependency, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.stepTimeoutMs);
    let response: Response;
    try {
      response = await this.runtime.fetch(`${this.config.baseUrl}${path}`, { ...init, signal: controller.signal });
    } catch (error) {
      const timedOut = (error as Error)?.name === 'AbortError';
      throw new StepFailure(
        'api',
        timedOut ? `No response from the API within ${this.config.stepTimeoutMs}ms` : `API unreachable: ${(error as Error)?.message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.ok) return response;
    const detail = await response
      .json()
      .then((b: { detail?: string; message?: string }) => b?.detail ?? b?.message)
      .catch(() => undefined);
    const dependency: JourneyDependency =
      response.status === 401 || response.status === 403 ? 'config' : response.status >= 500 ? serverErrorDependency : 'api';
    throw new StepFailure(dependency, `${init.method ?? 'GET'} ${path} → ${response.status}${detail ? `: ${detail}` : ''}`, response.status);
  }
}
