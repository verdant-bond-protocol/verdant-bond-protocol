import {
  TestnetSmokeSuite,
  TestnetSmokeConfig,
  TestnetSmokeRuntime,
  TestnetSmokeReport,
  SmokeStepFailure,
} from './testnet-smoke-suite';

type RouteHandler = (
  init?: RequestInit,
) => { status: number; body?: unknown } | Promise<{ status: number; body?: unknown }>;

const BASE = 'http://localhost:3000';
const ADMIN_WALLET = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const INVESTOR_WALLET = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const TX_HASH = 'e'.repeat(64);

function defaultHealthyRoutes(): Record<string, RouteHandler> {
  let bondStatus = 'Active';

  return {
    'GET /api/health/ready': () => ({
      status: 200,
      body: { status: 'ready', sorobanRpc: 'healthy' },
    }),

    // Issue Stage
    'POST /api/bonds': (init) => {
      const authHeader = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (!authHeader || authHeader.includes('mock-investor') || authHeader.includes('mock-unauth') || authHeader.includes('unauthorized')) {
        return { status: 403, body: { message: 'Forbidden: admin only' } };
      }

      const body = JSON.parse((init?.body as string) || '{}');
      if (body.faceValue <= 0 || body.totalSupply <= 0) {
        return { status: 400, body: { message: 'Validation failed: faceValue and totalSupply must be positive' } };
      }

      bondStatus = 'Active';
      return {
        status: 201,
        body: { id: 101, bondId: 101, status: 'Active', faceValue: body.faceValue, totalSupply: body.totalSupply },
      };
    },

    'GET /api/bonds/101': () => ({
      status: 200,
      body: { id: 101, status: bondStatus, faceValue: 100, totalSupply: 10000 },
    }),

    // Subscribe Stage
    'POST /api/bonds/101/subscribe': (init) => {
      const headers = (init?.headers as Record<string, string> | undefined) || {};
      if (!headers.Authorization) {
        return { status: 401, body: { message: 'Unauthorized' } };
      }

      const body = JSON.parse((init?.body as string) || '{}');
      if (body.amount > 10000) {
        return { status: 400, body: { message: 'Subscription amount exceeds total supply' } };
      }

      return {
        status: 200,
        body: { bondId: 101, investorAddress: body.investorAddress, amount: String(body.amount), transactionHash: TX_HASH },
      };
    },

    // Coupon Stage
    'POST /api/bonds/101/coupon': (init) => {
      const authHeader = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (!authHeader || authHeader.includes('mock-investor')) {
        return { status: 403, body: { message: 'Admin permissions required' } };
      }

      const body = JSON.parse((init?.body as string) || '{}');
      if (body.periodIndex < 0) {
        return { status: 400, body: { message: 'Period index cannot be negative' } };
      }

      return {
        status: 200,
        body: { bondId: 101, periodIndex: body.periodIndex, holderCount: 1 },
      };
    },

    'POST /api/bonds/101/claim': () => ({
      status: 200,
      body: { bondId: 101, credits: '50' },
    }),

    // Redeem Stage
    'POST /api/bonds/101/mature': (init) => {
      const authHeader = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (!authHeader || authHeader.includes('mock-investor')) {
        return { status: 403, body: { message: 'Admin permissions required' } };
      }

      bondStatus = 'Matured';
      return {
        status: 200,
        body: { bondId: 101, status: 'Matured' },
      };
    },

    'POST /api/bonds/101/redeem': (init) => {
      const body = JSON.parse((init?.body as string) || '{}');
      // If amount > 500, trigger balance exceeded validation error
      if (body.amount > 500) {
        return { status: 400, body: { message: 'Redemption amount exceeds held balance' } };
      }

      // Premature redemption check (before maturity)
      if (bondStatus !== 'Matured') {
        return { status: 400, body: { message: "Bond 101 is in status 'Active'; redemption requires status 'Matured'" } };
      }

      return {
        status: 200,
        body: { bondId: 101, investorAddress: body.investorAddress, amount: String(body.amount), transactionHash: TX_HASH, status: 'Redeemed' },
      };
    },

    'GET /api/bonds/101/holders': () => ({
      status: 200,
      body: {
        totalHolders: 1,
        holders: [{ address: INVESTOR_WALLET, balance: '0' }],
      },
    }),
  };
}

describe('TestnetSmokeSuite', () => {
  let clock: number;
  let routes: Record<string, RouteHandler>;
  let calls: Array<{ key: string; headers?: Record<string, string>; body?: string }>;

  const createRuntime = (): TestnetSmokeRuntime => ({
    fetch: (async (url: string, init?: RequestInit) => {
      const parsedUrl = new URL(url);
      const key = `${init?.method ?? 'GET'} ${parsedUrl.pathname}`;
      calls.push({
        key,
        headers: init?.headers as Record<string, string>,
        body: init?.body as string,
      });
      clock += 20;

      const handler = routes[key];
      if (!handler) {
        return new Response(JSON.stringify({ error: `Not found: ${key}` }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const result = await handler(init);
      return new Response(JSON.stringify(result.body ?? {}), {
        status: result.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    idempotencyKey: () => 'smoke-idempotency-key-test',
  });

  const defaultConfig: TestnetSmokeConfig = {
    baseUrl: BASE,
    network: 'testnet',
    adminToken: 'mock-admin-token',
    adminAddress: ADMIN_WALLET,
    investorToken: 'mock-investor-token',
    investorAddress: INVESTOR_WALLET,
    unauthorizedToken: 'mock-unauth-token',
    faceValue: 100,
    totalSupply: 10000,
    subscribeAmount: 500,
    stepTimeoutMs: 1000,
  };

  beforeEach(() => {
    clock = 1_700_000_000_000;
    routes = defaultHealthyRoutes();
    calls = [];
    delete process.env.STELLAR_NETWORK;
  });

  describe('Mainnet safety guard', () => {
    it('refuses execution if config.network is mainnet', () => {
      expect(() => {
        new TestnetSmokeSuite({ ...defaultConfig, network: 'mainnet' as any }, createRuntime());
      }).toThrow(/strictly prohibited on mainnet/);
    });

    it('refuses execution if STELLAR_NETWORK environment variable is mainnet', () => {
      process.env.STELLAR_NETWORK = 'mainnet';
      expect(() => {
        new TestnetSmokeSuite(defaultConfig, createRuntime());
      }).toThrow(/strictly prohibited on mainnet/);
    });
  });

  describe('Happy path & complete lifecycle execution', () => {
    it('executes issue, subscribe, coupon, and redeem across normal, failure, retry, and auth paths', async () => {
      const suite = new TestnetSmokeSuite(defaultConfig, createRuntime());
      const report: TestnetSmokeReport = await suite.run();

      expect(report.ok).toBe(true);
      expect(report.blame).toBeNull();
      expect(report.bondId).toBe(101);

      // Verify all 4 lifecycle stages are covered
      expect(report.stagesCovered).toEqual({
        issue: true,
        subscribe: true,
        coupon: true,
        redeem: true,
      });

      // Verify all 4 validation paths are covered
      expect(report.pathsCovered).toEqual({
        normal: true,
        failure: true,
        retry: true,
        authorization: true,
      });

      // Verify idempotency key was passed on subscribe retry
      const idempotentCalls = calls.filter(
        (c) => c.key === 'POST /api/bonds/101/subscribe' && c.headers?.['Idempotency-Key'],
      );
      expect(idempotentCalls.length).toBe(2);
      expect(idempotentCalls[0].headers?.['Idempotency-Key']).toBe('smoke-idempotency-key-test');
      expect(idempotentCalls[1].headers?.['Idempotency-Key']).toBe('smoke-idempotency-key-test');

      // Verify holders query retry confirmed balance burn
      const holdersCalls = calls.filter((c) => c.key === 'GET /api/bonds/101/holders');
      expect(holdersCalls.length).toBe(1);
    });
  });

  describe('Stage and path failure attribution (blame)', () => {
    it('attributes failure to soroban-rpc when readiness check fails', async () => {
      routes['GET /api/health/ready'] = () => ({
        status: 503,
        body: { status: 'degraded', sorobanRpc: 'unreachable' },
      });

      const suite = new TestnetSmokeSuite(defaultConfig, createRuntime());
      const report = await suite.run();

      expect(report.ok).toBe(false);
      expect(report.blame).toBe('soroban-rpc');
      const failedStep = report.steps.find((s) => !s.ok);
      expect(failedStep?.stage).toBe('health');
      expect(failedStep?.name).toBe('readiness-check');
    });

    it('attributes failure to auth when unauthorized issue is accepted', async () => {
      // Mock that unauthorized issue succeeds with 200 (violating auth requirement)
      routes['POST /api/bonds'] = () => ({
        status: 200,
        body: { id: 999, status: 'Active' },
      });

      const suite = new TestnetSmokeSuite(defaultConfig, createRuntime());
      const report = await suite.run();

      expect(report.ok).toBe(false);
      expect(report.blame).toBe('auth');
      const failedStep = report.steps.find((s) => !s.ok);
      expect(failedStep?.stage).toBe('issue');
      expect(failedStep?.name).toBe('issue-authorization-check');
      expect(failedStep?.error).toContain('Expected 401/403');
    });

    it('attributes failure to validation when invalid parameters are accepted on issue', async () => {
      // Allow unauthorized check to pass (reject with 403), but accept invalid body with 200
      routes['POST /api/bonds'] = (init) => {
        const auth = (init?.headers as Record<string, string>)?.Authorization;
        if (auth?.includes('mock-unauth')) return { status: 403 };
        return { status: 200, body: { id: 101 } }; // Doesn't validate negative face value!
      };

      const suite = new TestnetSmokeSuite(defaultConfig, createRuntime());
      const report = await suite.run();

      expect(report.ok).toBe(false);
      expect(report.blame).toBe('validation');
      const failedStep = report.steps.find((s) => !s.ok);
      expect(failedStep?.stage).toBe('issue');
      expect(failedStep?.name).toBe('issue-validation-failure');
      expect(failedStep?.error).toContain('Expected 400');
    });

    it('attributes failure to stellar-network when bond issuance transaction fails', async () => {
      routes['POST /api/bonds'] = (init) => {
        const auth = (init?.headers as Record<string, string>)?.Authorization;
        if (auth?.includes('mock-unauth')) return { status: 403 };
        const body = JSON.parse((init?.body as string) || '{}');
        if (body.faceValue <= 0) return { status: 400 };
        return { status: 502, body: { error: 'Horizon/Soroban submission failed' } };
      };

      const suite = new TestnetSmokeSuite(defaultConfig, createRuntime());
      const report = await suite.run();

      expect(report.ok).toBe(false);
      expect(report.blame).toBe('stellar-network');
      const failedStep = report.steps.find((s) => !s.ok);
      expect(failedStep?.stage).toBe('issue');
      expect(failedStep?.name).toBe('issue-bond-success');
    });

    it('attributes failure to validation when oversubscription is accepted', async () => {
      routes['POST /api/bonds/101/subscribe'] = (init) => {
        const headers = (init?.headers as Record<string, string>) || {};
        if (!headers.Authorization) return { status: 401 };
        // Accept oversubscription with 200 instead of 400
        return { status: 200, body: { amount: '100000' } };
      };

      const suite = new TestnetSmokeSuite(defaultConfig, createRuntime());
      const report = await suite.run();

      expect(report.ok).toBe(false);
      expect(report.blame).toBe('validation');
      const failedStep = report.steps.find((s) => !s.ok);
      expect(failedStep?.stage).toBe('subscribe');
      expect(failedStep?.name).toBe('subscribe-oversupply-failure');
    });

    it('attributes failure to auth when unauthorized coupon distribution is accepted', async () => {
      routes['POST /api/bonds/101/coupon'] = () => ({
        status: 200,
        body: { periodIndex: 0 },
      });

      const suite = new TestnetSmokeSuite(defaultConfig, createRuntime());
      const report = await suite.run();

      expect(report.ok).toBe(false);
      expect(report.blame).toBe('auth');
      const failedStep = report.steps.find((s) => !s.ok);
      expect(failedStep?.stage).toBe('coupon');
      expect(failedStep?.name).toBe('coupon-authorization-check');
    });

    it('attributes failure to validation when negative coupon period is accepted', async () => {
      routes['POST /api/bonds/101/coupon'] = (init) => {
        const auth = (init?.headers as Record<string, string>)?.Authorization;
        if (auth?.includes('mock-investor')) return { status: 403 };
        return { status: 200, body: { periodIndex: -1 } };
      };

      const suite = new TestnetSmokeSuite(defaultConfig, createRuntime());
      const report = await suite.run();

      expect(report.ok).toBe(false);
      expect(report.blame).toBe('validation');
      const failedStep = report.steps.find((s) => !s.ok);
      expect(failedStep?.stage).toBe('coupon');
      expect(failedStep?.name).toBe('coupon-invalid-period-failure');
    });

    it('attributes failure to validation when premature redemption before maturity is accepted', async () => {
      // Premature redemption returns 200 instead of 400
      routes['POST /api/bonds/101/redeem'] = () => ({
        status: 200,
        body: { status: 'Redeemed' },
      });

      const suite = new TestnetSmokeSuite(defaultConfig, createRuntime());
      const report = await suite.run();

      expect(report.ok).toBe(false);
      expect(report.blame).toBe('validation');
      const failedStep = report.steps.find((s) => !s.ok);
      expect(failedStep?.stage).toBe('redeem');
      expect(failedStep?.name).toBe('redeem-premature-rejection-failure');
    });

    it('attributes failure to auth when non-admin can mature bond', async () => {
      routes['POST /api/bonds/101/mature'] = () => ({
        status: 200,
        body: { status: 'Matured' },
      });

      const suite = new TestnetSmokeSuite(defaultConfig, createRuntime());
      const report = await suite.run();

      expect(report.ok).toBe(false);
      expect(report.blame).toBe('auth');
      const failedStep = report.steps.find((s) => !s.ok);
      expect(failedStep?.stage).toBe('redeem');
      expect(failedStep?.name).toBe('mature-authorization-check');
    });

    it('attributes failure to api when network connection is refused or timed out', async () => {
      const failingRuntime: TestnetSmokeRuntime = {
        fetch: async () => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:3000');
        },
        now: () => Date.now(),
        sleep: async () => {},
        idempotencyKey: () => 'key',
      };

      const suite = new TestnetSmokeSuite(defaultConfig, failingRuntime);
      const report = await suite.run();

      expect(report.ok).toBe(false);
      expect(report.blame).toBe('api');
      expect(report.steps[0].error).toContain('ECONNREFUSED');
    });
  });
});
