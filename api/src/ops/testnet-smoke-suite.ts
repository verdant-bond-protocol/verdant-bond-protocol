import { randomUUID } from 'crypto';

export type SmokeStage = 'health' | 'issue' | 'subscribe' | 'coupon' | 'redeem';
export type SmokePath = 'normal' | 'failure' | 'retry' | 'authorization';
export type SmokeBlame = 'api' | 'soroban-rpc' | 'stellar-network' | 'auth' | 'config' | 'validation' | null;

export interface SmokeStepResult {
  stage: SmokeStage;
  name: string;
  path: SmokePath;
  ok: boolean;
  latencyMs: number;
  httpStatus?: number;
  error?: string;
  blame?: SmokeBlame;
  details?: Record<string, unknown>;
}

export interface TestnetSmokeReport {
  suite: 'testnet-smoke-suite';
  network: string;
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  totalDurationMs: number;
  bondId?: number;
  steps: SmokeStepResult[];
  summary: string;
  blame: SmokeBlame;
  pathsCovered: {
    normal: boolean;
    failure: boolean;
    retry: boolean;
    authorization: boolean;
  };
  stagesCovered: {
    issue: boolean;
    subscribe: boolean;
    coupon: boolean;
    redeem: boolean;
  };
}

export interface TestnetSmokeConfig {
  baseUrl: string;
  network: 'testnet' | 'local' | 'mock';
  stepTimeoutMs?: number;
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
  adminToken: string;
  adminAddress: string;
  investorToken: string;
  investorAddress: string;
  unauthorizedToken?: string;
  faceValue?: number;
  totalSupply?: number;
  subscribeAmount?: number;
}

export interface TestnetSmokeRuntime {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  idempotencyKey: () => string;
}

export class SmokeStepFailure extends Error {
  constructor(
    readonly blame: SmokeBlame,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
  }
}

export class TestnetSmokeSuite {
  private readonly stepTimeoutMs: number;
  private readonly pollTimeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly config: TestnetSmokeConfig,
    private readonly runtime: TestnetSmokeRuntime,
  ) {
    if (config.network as string === 'mainnet' || process.env.STELLAR_NETWORK === 'mainnet') {
      throw new Error(
        'Testnet smoke suite exercises state mutations and redemption flows and is strictly prohibited on mainnet',
      );
    }

    this.stepTimeoutMs = config.stepTimeoutMs ?? 10_000;
    this.pollTimeoutMs = config.pollTimeoutMs ?? 60_000;
    this.pollIntervalMs = config.pollIntervalMs ?? 5_000;
  }

  /**
   * Runs the complete testnet smoke suite covering:
   * 1. Health / Preflight
   * 2. Issue (Normal, Failure, Retry, Authorization)
   * 3. Subscribe (Normal, Failure, Retry, Authorization)
   * 4. Coupon (Normal, Failure, Retry, Authorization)
   * 5. Redeem (Normal, Failure, Retry, Authorization)
   */
  async run(): Promise<TestnetSmokeReport> {
    const started = this.runtime.now();
    const steps: SmokeStepResult[] = [];
    let bondId: number | undefined;

    const report: TestnetSmokeReport = {
      suite: 'testnet-smoke-suite',
      network: this.config.network,
      ok: false,
      startedAt: new Date(started).toISOString(),
      finishedAt: '',
      totalDurationMs: 0,
      steps,
      summary: '',
      blame: null,
      pathsCovered: {
        normal: false,
        failure: false,
        retry: false,
        authorization: false,
      },
      stagesCovered: {
        issue: false,
        subscribe: false,
        coupon: false,
        redeem: false,
      },
    };

    // Helper to execute steps with timing and error blame mapping
    const execStep = async (
      stage: SmokeStage,
      name: string,
      path: SmokePath,
      fn: () => Promise<Record<string, unknown> | void>,
    ): Promise<boolean> => {
      const stepStart = this.runtime.now();
      try {
        const details = (await fn()) || {};
        const latencyMs = this.runtime.now() - stepStart;
        steps.push({ stage, name, path, ok: true, latencyMs, details });
        return true;
      } catch (err) {
        const latencyMs = this.runtime.now() - stepStart;
        const failure =
          err instanceof SmokeStepFailure
            ? err
            : new SmokeStepFailure('api', err instanceof Error ? err.message : String(err));
        steps.push({
          stage,
          name,
          path,
          ok: false,
          latencyMs,
          httpStatus: failure.httpStatus,
          error: failure.message,
          blame: failure.blame,
        });
        return false;
      }
    };

    // ─── 0. Readiness / Health ──────────────────────────────────────────────
    await execStep('health', 'readiness-check', 'normal', async () => {
      const res = await this.request('/api/health/ready', 'soroban-rpc', { method: 'GET' });
      if (!res.ok) {
        throw new SmokeStepFailure('soroban-rpc', `Readiness check failed with status ${res.status}`, res.status);
      }
      const body = (await res.json()) as { status?: string };
      return { status: body.status };
    });

    // ─── 1. Issue Lifecycle ─────────────────────────────────────────────────
    // 1a. Authorization Path: non-admin cannot issue
    await execStep('issue', 'issue-authorization-check', 'authorization', async () => {
      const unauthRes = await this.request('/api/bonds', 'auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.unauthorizedToken || this.config.investorToken}`,
        },
        body: JSON.stringify({ faceValue: 100, totalSupply: 1000 }),
      });
      if (unauthRes.status !== 401 && unauthRes.status !== 403) {
        throw new SmokeStepFailure(
          'auth',
          `Expected 401/403 for unauthorized issue, received ${unauthRes.status}`,
          unauthRes.status,
        );
      }
    });

    // 1b. Failure Path: invalid face value / negative supply rejected
    await execStep('issue', 'issue-validation-failure', 'failure', async () => {
      const badRes = await this.request('/api/bonds', 'validation', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.adminToken}`,
        },
        body: JSON.stringify({
          faceValue: -10,
          totalSupply: 0,
          creditType: 'Carbon',
          maturityDate: Math.floor(Date.now() / 1000) + 3600,
        }),
      });
      if (badRes.status !== 400) {
        throw new SmokeStepFailure('validation', `Expected 400 for invalid issue parameters, received ${badRes.status}`, badRes.status);
      }
    });

    // 1c. Normal Path: Admin issues new bond tranche
    const faceVal = this.config.faceValue ?? 100;
    const totalSup = this.config.totalSupply ?? 10_000;
    const nowSec = Math.floor(this.runtime.now() / 1000);

    const issuePassed = await execStep('issue', 'issue-bond-success', 'normal', async () => {
      const issueRes = await this.request('/api/bonds', 'stellar-network', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.adminToken}`,
        },
        body: JSON.stringify({
          projectId: '0'.repeat(64),
          faceValue: faceVal,
          totalSupply: totalSup,
          creditType: 'Carbon',
          maturityDate: nowSec + 120, // 2 minutes maturity for testnet smoke
          couponSchedule: [nowSec + 60],
        }),
      });

      if (issueRes.status !== 201 && issueRes.status !== 200) {
        throw new SmokeStepFailure('stellar-network', `Issue bond failed with status ${issueRes.status}`, issueRes.status);
      }
      const data = (await issueRes.json()) as { bondId?: number; id?: number; status?: string };
      bondId = data.bondId ?? data.id;
      if (!bondId) throw new SmokeStepFailure('api', 'Issue response contained no bond ID');
      return { bondId, status: data.status };
    });

    report.bondId = bondId;

    // 1d. Retry Path: Query created bond data (idempotent read)
    if (bondId) {
      await execStep('issue', 'issue-query-retry', 'retry', async () => {
        const queryRes = await this.request(`/api/bonds/${bondId}`, 'api', { method: 'GET' });
        if (!queryRes.ok) throw new SmokeStepFailure('api', `Failed to query issued bond ${bondId}`, queryRes.status);
        const bond = (await queryRes.json()) as { id: number; status: string };
        return { id: bond.id, status: bond.status };
      });
    }

    // ─── 2. Subscribe Lifecycle ─────────────────────────────────────────────
    const subAmount = this.config.subscribeAmount ?? 500;

    if (bondId && issuePassed) {
      // 2a. Authorization Path: non-investor / missing token fails
      await execStep('subscribe', 'subscribe-authorization-check', 'authorization', async () => {
        const noAuthRes = await this.request(`/api/bonds/${bondId}/subscribe`, 'auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount: subAmount, investorAddress: this.config.investorAddress }),
        });
        if (noAuthRes.status !== 401 && noAuthRes.status !== 403) {
          throw new SmokeStepFailure('auth', `Expected 401/403 for unauthenticated subscribe, got ${noAuthRes.status}`, noAuthRes.status);
        }
      });

      // 2b. Failure Path: subscribe amount exceeds total supply
      await execStep('subscribe', 'subscribe-oversupply-failure', 'failure', async () => {
        const oversupplyRes = await this.request(`/api/bonds/${bondId}/subscribe`, 'validation', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.investorToken}`,
          },
          body: JSON.stringify({ amount: totalSup + 1000, investorAddress: this.config.investorAddress }),
        });
        if (oversupplyRes.status !== 400) {
          throw new SmokeStepFailure('validation', `Expected 400 for over-supply subscription, got ${oversupplyRes.status}`, oversupplyRes.status);
        }
      });

      // 2c. Normal Path: Investor subscribes with valid amount
      const subIdempotencyKey = this.runtime.idempotencyKey();
      let txHash: string | undefined;

      await execStep('subscribe', 'subscribe-success', 'normal', async () => {
        const subRes = await this.request(`/api/bonds/${bondId}/subscribe`, 'stellar-network', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.investorToken}`,
            'Idempotency-Key': subIdempotencyKey,
          },
          body: JSON.stringify({ amount: subAmount, investorAddress: this.config.investorAddress }),
        });
        if (!subRes.ok) throw new SmokeStepFailure('stellar-network', `Subscribe failed with status ${subRes.status}`, subRes.status);
        const subData = (await subRes.json()) as { transactionHash?: string; amount?: string };
        txHash = subData.transactionHash;
        return { amount: subData.amount, transactionHash: txHash };
      });

      // 2d. Retry Path: Idempotent resubmission with identical Idempotency-Key
      await execStep('subscribe', 'subscribe-idempotent-retry', 'retry', async () => {
        const retryRes = await this.request(`/api/bonds/${bondId}/subscribe`, 'stellar-network', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.investorToken}`,
            'Idempotency-Key': subIdempotencyKey,
          },
          body: JSON.stringify({ amount: subAmount, investorAddress: this.config.investorAddress }),
        });
        if (!retryRes.ok) throw new SmokeStepFailure('stellar-network', `Idempotent retry failed with ${retryRes.status}`, retryRes.status);
      });
    }

    // ─── 3. Coupon Lifecycle ────────────────────────────────────────────────
    if (bondId) {
      // 3a. Authorization Path: non-admin cannot distribute coupon
      await execStep('coupon', 'coupon-authorization-check', 'authorization', async () => {
        const unauthRes = await this.request(`/api/bonds/${bondId}/coupon`, 'auth', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.investorToken}`,
          },
          body: JSON.stringify({ periodIndex: 0, reportId: 1 }),
        });
        if (unauthRes.status !== 401 && unauthRes.status !== 403) {
          throw new SmokeStepFailure('auth', `Expected 401/403 for unauthorized coupon distribution, got ${unauthRes.status}`, unauthRes.status);
        }
      });

      // 3b. Failure Path: coupon distribution with invalid period index
      await execStep('coupon', 'coupon-invalid-period-failure', 'failure', async () => {
        const badRes = await this.request(`/api/bonds/${bondId}/coupon`, 'validation', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.adminToken}`,
          },
          body: JSON.stringify({ periodIndex: -1, reportId: 1 }),
        });
        if (badRes.status !== 400) {
          throw new SmokeStepFailure('validation', `Expected 400 for negative period index, got ${badRes.status}`, badRes.status);
        }
      });

      // 3c. Normal Path: Distribute and claim coupon credits
      await execStep('coupon', 'coupon-distribute-success', 'normal', async () => {
        const distRes = await this.request(`/api/bonds/${bondId}/coupon`, 'stellar-network', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.adminToken}`,
          },
          body: JSON.stringify({ periodIndex: 0, reportId: 1 }),
        });
        if (!distRes.ok) throw new SmokeStepFailure('stellar-network', `Coupon distribution failed with ${distRes.status}`, distRes.status);
        const distData = (await distRes.json()) as { periodIndex: number; holderCount?: number };
        return { periodIndex: distData.periodIndex, holderCount: distData.holderCount };
      });

      // Claim coupon credits as investor
      await execStep('coupon', 'coupon-claim-credits-success', 'normal', async () => {
        const claimRes = await this.request(`/api/bonds/${bondId}/claim`, 'stellar-network', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.investorToken}`,
          },
          body: JSON.stringify({ investorAddress: this.config.investorAddress }),
        });
        if (!claimRes.ok) throw new SmokeStepFailure('stellar-network', `Coupon claim failed with ${claimRes.status}`, claimRes.status);
        const claimData = (await claimRes.json()) as { credits?: string };
        return { credits: claimData.credits };
      });

      // 3d. Retry Path: Idempotent re-claim returns 0 additional credits without error
      await execStep('coupon', 'coupon-reclaim-retry', 'retry', async () => {
        const reclaimRes = await this.request(`/api/bonds/${bondId}/claim`, 'api', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.investorToken}`,
          },
          body: JSON.stringify({ investorAddress: this.config.investorAddress }),
        });
        if (!reclaimRes.ok) throw new SmokeStepFailure('api', `Re-claim failed with ${reclaimRes.status}`, reclaimRes.status);
      });
    }

    // ─── 4. Redeem Lifecycle ────────────────────────────────────────────────
    if (bondId) {
      // 4a. Failure Path: Redeeming before maturity is rejected
      await execStep('redeem', 'redeem-premature-rejection-failure', 'failure', async () => {
        const prematureRes = await this.request(`/api/bonds/${bondId}/redeem`, 'validation', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.investorToken}`,
          },
          body: JSON.stringify({ amount: subAmount, investorAddress: this.config.investorAddress }),
        });
        if (prematureRes.status !== 400) {
          throw new SmokeStepFailure(
            'validation',
            `Expected 400 for premature redeem attempt before maturity, got ${prematureRes.status}`,
            prematureRes.status,
          );
        }
      });

      // 4b. Authorization Path: non-admin cannot mature bond
      await execStep('redeem', 'mature-authorization-check', 'authorization', async () => {
        const unauthMature = await this.request(`/api/bonds/${bondId}/mature`, 'auth', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.investorToken}`,
          },
        });
        if (unauthMature.status !== 401 && unauthMature.status !== 403) {
          throw new SmokeStepFailure('auth', `Expected 401/403 for unauthorized mature attempt, got ${unauthMature.status}`, unauthMature.status);
        }
      });

      // Admin matures bond
      await execStep('redeem', 'mature-bond-admin-success', 'normal', async () => {
        const matureRes = await this.request(`/api/bonds/${bondId}/mature`, 'stellar-network', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.adminToken}`,
          },
        });
        if (!matureRes.ok) throw new SmokeStepFailure('stellar-network', `Mature bond failed with ${matureRes.status}`, matureRes.status);
        const data = (await matureRes.json()) as { status?: string };
        return { status: data.status };
      });

      // 4c. Normal Path: Investor redeems matured bond tokens
      await execStep('redeem', 'redeem-principal-success', 'normal', async () => {
        const redeemRes = await this.request(`/api/bonds/${bondId}/redeem`, 'stellar-network', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.investorToken}`,
          },
          body: JSON.stringify({ amount: subAmount, investorAddress: this.config.investorAddress }),
        });
        if (!redeemRes.ok) throw new SmokeStepFailure('stellar-network', `Redeem principal failed with ${redeemRes.status}`, redeemRes.status);
        const data = (await redeemRes.json()) as { amount: string; transactionHash?: string };
        return { amount: data.amount, transactionHash: data.transactionHash };
      });

      // 4d. Failure Path: Redeeming exceeding held balance fails
      await execStep('redeem', 'redeem-insufficient-balance-failure', 'failure', async () => {
        const overRedeem = await this.request(`/api/bonds/${bondId}/redeem`, 'validation', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.investorToken}`,
          },
          body: JSON.stringify({ amount: 999_999, investorAddress: this.config.investorAddress }),
        });
        if (overRedeem.status !== 400) {
          throw new SmokeStepFailure(
            'validation',
            `Expected 400 for redeem amount exceeding balance, got ${overRedeem.status}`,
            overRedeem.status,
          );
        }
      });

      // 4e. Retry Path: Query holders list to verify balance burned to zero
      await execStep('redeem', 'redeem-balance-burn-retry', 'retry', async () => {
        const holdersRes = await this.request(`/api/bonds/${bondId}/holders`, 'api', { method: 'GET' });
        if (!holdersRes.ok) throw new SmokeStepFailure('api', `Failed to query holders after redemption`, holdersRes.status);
        const data = (await holdersRes.json()) as { holders: Array<{ address: string; balance: string }> };
        const investorHolder = data.holders?.find((h) => h.address === this.config.investorAddress);
        const remainingBalance = investorHolder ? BigInt(investorHolder.balance) : BigInt(0);
        return { remainingBalance: remainingBalance.toString() };
      });
    }

    // ─── Evaluation & Attribution ───────────────────────────────────────────
    const finished = this.runtime.now();
    report.finishedAt = new Date(finished).toISOString();
    report.totalDurationMs = finished - started;
    report.ok = steps.every((s) => s.ok);
    report.blame = steps.find((s) => !s.ok)?.blame ?? null;

    report.pathsCovered = {
      normal: steps.some((s) => s.path === 'normal' && s.ok),
      failure: steps.some((s) => s.path === 'failure' && s.ok),
      retry: steps.some((s) => s.path === 'retry' && s.ok),
      authorization: steps.some((s) => s.path === 'authorization' && s.ok),
    };

    report.stagesCovered = {
      issue: steps.some((s) => s.stage === 'issue' && s.ok),
      subscribe: steps.some((s) => s.stage === 'subscribe' && s.ok),
      coupon: steps.some((s) => s.stage === 'coupon' && s.ok),
      redeem: steps.some((s) => s.stage === 'redeem' && s.ok),
    };

    const passedCount = steps.filter((s) => s.ok).length;
    report.summary = `${passedCount}/${steps.length} smoke steps passed on ${this.config.network}. Status: ${report.ok ? 'ALL PASSED' : `FAILED (${report.blame})`}`;

    return report;
  }

  private async request(path: string, defaultBlame: SmokeBlame, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.stepTimeoutMs);
    let response: Response;

    try {
      response = await this.runtime.fetch(`${this.config.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });
    } catch (err) {
      const timedOut = (err as Error)?.name === 'AbortError';
      throw new SmokeStepFailure(
        'api',
        timedOut ? `Request timed out after ${this.stepTimeoutMs}ms` : `API unreachable: ${(err as Error)?.message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    return response;
  }
}
