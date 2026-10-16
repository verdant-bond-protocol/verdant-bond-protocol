import { JourneyRuntime, SyntheticJourneyConfig, SyntheticJourneyMonitor } from './synthetic-journey.monitor';

type Route = (init?: RequestInit) => { status: number; body?: unknown } | Promise<never>;

const BASE = 'https://api.test';
const HASH = 'f'.repeat(64);

const ready = () => ({
  status: 200,
  body: {
    status: 'ready',
    redis: 'up',
    contracts: { bondIssuer: { status: 'reachable' }, couponEngine: { status: 'reachable' } },
  },
});

function healthyRoutes(): Record<string, Route> {
  return {
    'GET /api/health/ready': ready,
    'GET /api/bonds?page=1&limit=20': () => ({
      status: 200,
      body: {
        data: [
          { id: 1, status: 'Matured', totalSupply: '100', totalSubscribed: '0' },
          { id: 2, status: 'Active', totalSupply: '100', totalSubscribed: '100' },
          { id: 3, status: 'Active', totalSupply: '100', totalSubscribed: '40' },
        ],
      },
    }),
    'GET /api/bonds/3/detail': () => ({ status: 200, body: { bond: { id: 3 } } }),
    'GET /api/bonds/3/preview-subscribe?amount=1': () => ({ status: 200, body: { expected_failure: null } }),
    'POST /api/bonds/3/subscribe': () => ({ status: 200, body: { transactionHash: HASH } }),
    [`GET /api/stellar/transactions/${HASH}`]: () => ({ status: 200, body: { hash: HASH, status: 'confirmed' } }),
  };
}

describe('SyntheticJourneyMonitor (#380)', () => {
  let clock: number;
  let routes: Record<string, Route>;
  let calls: Array<{ key: string; init?: RequestInit }>;

  const runtime: JourneyRuntime = {
    fetch: (async (url: string, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${url.replace(BASE, '')}`;
      calls.push({ key, init });
      clock += 25; // every call costs 25ms of simulated latency
      const route = routes[key];
      if (!route) return new Response(JSON.stringify({ detail: 'no route' }), { status: 404 });
      const { status, body } = await route(init);
      return new Response(JSON.stringify(body ?? {}), { status });
    }) as unknown as typeof fetch,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    idempotencyKey: () => 'synthetic-key-1',
  };

  const config = (overrides: Partial<SyntheticJourneyConfig> = {}): SyntheticJourneyConfig => ({
    baseUrl: BASE,
    amount: 1,
    stepTimeoutMs: 5_000,
    confirmTimeoutMs: 60_000,
    confirmPollMs: 5_000,
    ...overrides,
  });

  const run = (overrides?: Partial<SyntheticJourneyConfig>) => new SyntheticJourneyMonitor(config(overrides), runtime).run();

  beforeEach(() => {
    clock = 1_000_000;
    routes = healthyRoutes();
    calls = [];
  });

  it('passes the read-only happy path and times every step', async () => {
    const report = await run();

    expect(report.ok).toBe(true);
    expect(report.blame).toBeNull();
    expect(report.bondId).toBe(3); // first Active bond with room for the probe amount
    expect(report.steps.map((s) => [s.name, s.ok, s.latencyMs])).toEqual([
      ['readiness', true, 25],
      ['list-bonds', true, 25],
      ['bond-detail', true, 25],
      ['preview-subscribe', true, 25],
    ]);
    expect(report.totalLatencyMs).toBe(100);
    expect(calls.some((c) => c.key.startsWith('POST'))).toBe(false);
  });

  it('submits and confirms a subscription only when writes are enabled', async () => {
    let polls = 0;
    routes[`GET /api/stellar/transactions/${HASH}`] = () => ({
      status: 200,
      body: { hash: HASH, status: ++polls < 3 ? 'pending' : 'confirmed' },
    });

    const report = await run({ write: { token: 'jwt', investorAddress: 'GINVESTOR' } });

    expect(report.ok).toBe(true);
    expect(report.transactionHash).toBe(HASH);
    expect(report.steps.map((s) => s.name)).toEqual([
      'readiness', 'list-bonds', 'bond-detail', 'preview-subscribe', 'subscribe', 'confirm-transaction',
    ]);
    expect(report.steps[5].latencyMs).toBe(3 * 25 + 2 * 5_000);

    const subscribe = calls.find((c) => c.key === 'POST /api/bonds/3/subscribe')!;
    expect(subscribe.init?.headers).toEqual(
      expect.objectContaining({ Authorization: 'Bearer jwt', 'Idempotency-Key': 'synthetic-key-1' }),
    );
    expect(JSON.parse(String(subscribe.init?.body))).toEqual({ amount: 1, investorAddress: 'GINVESTOR' });
  });

  it('blames Soroban RPC when a contract read fails server-side, corroborated by readiness', async () => {
    routes['GET /api/health/ready'] = () => ({
      status: 200,
      body: { status: 'degraded', redis: 'up', contracts: { bondIssuer: { status: 'unreachable' } } },
    });
    // What the API's RFC 7807 filter sends for a GatewayTimeoutException.
    routes['GET /api/bonds/3/detail'] = () => ({
      status: 504,
      body: { title: 'Gateway Timeout', status: 504, code: 'INTERNAL_ERROR', detail: 'An unexpected error occurred. Please contact support with your correlation ID.' },
    });

    const report = await run();

    expect(report.ok).toBe(false);
    expect(report.blame).toBe('soroban-rpc');
    expect(report.degradedDependencies).toEqual(['soroban-rpc']);
    const detail = report.steps.find((s) => s.name === 'bond-detail')!;
    expect(detail).toEqual(
      expect.objectContaining({ ok: false, httpStatus: 504, dependency: 'soroban-rpc', error: expect.stringMatching(/→ 504: An unexpected error occurred/) }),
    );
    // Later steps depend on the failed one and are not attempted.
    expect(report.steps.map((s) => s.name)).toEqual(['readiness', 'list-bonds', 'bond-detail']);
  });

  it('reports a degraded Redis without failing the user-facing steps', async () => {
    routes['GET /api/health/ready'] = () => ({ status: 200, body: { status: 'degraded', redis: 'degraded', contracts: {} } });

    const report = await run();

    expect(report.ok).toBe(false);
    expect(report.blame).toBe('redis');
    expect(report.steps.slice(1).every((s) => s.ok)).toBe(true);
  });

  it('blames the API when it does not answer in time', async () => {
    routes['GET /api/bonds?page=1&limit=20'] = (init) =>
      new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));

    const report = await run({ stepTimeoutMs: 20 });

    expect(report.blame).toBe('api');
    expect(report.steps[1].error).toBe('No response from the API within 20ms');
  });

  it('blames data when no bond can take the probe amount', async () => {
    const report = await run({ amount: 61 });

    expect(report.blame).toBe('data');
    expect(report.steps[1].error).toMatch(/No active bond with 61 unsubscribed/);
  });

  it('blames data when the contract preview predicts a rejection', async () => {
    routes['GET /api/bonds/3/preview-subscribe?amount=1'] = () => ({ status: 200, body: { expected_failure: 'Insufficient supply' } });

    expect((await run()).blame).toBe('data');
  });

  it('blames config when the synthetic investor credentials are rejected', async () => {
    routes['POST /api/bonds/3/subscribe'] = () => ({ status: 403, body: { detail: 'KYC required' } });

    const report = await run({ write: { token: 'stale', investorAddress: 'GINVESTOR' } });

    expect(report.blame).toBe('config');
    expect(report.steps.at(-1)).toEqual(expect.objectContaining({ name: 'subscribe', httpStatus: 403 }));
  });

  it('blames the network when the transaction fails or never settles', async () => {
    routes[`GET /api/stellar/transactions/${HASH}`] = () => ({ status: 200, body: { status: 'failed' } });
    const failed = await run({ write: { token: 'jwt', investorAddress: 'GINVESTOR' } });
    expect(failed.blame).toBe('stellar-network');
    expect(failed.steps.at(-1)!.error).toMatch(/failed on-chain/);

    routes[`GET /api/stellar/transactions/${HASH}`] = () => ({ status: 200, body: { status: 'pending' } });
    const stuck = await run({ write: { token: 'jwt', investorAddress: 'GINVESTOR' }, confirmTimeoutMs: 12_000 });
    expect(stuck.blame).toBe('stellar-network');
    expect(stuck.steps.at(-1)!.error).toMatch(/not confirmed within 12000ms/);
  });

  it('probes a configured bond without listing bonds', async () => {
    routes['GET /api/bonds/7/detail'] = () => ({ status: 200, body: {} });
    routes['GET /api/bonds/7/preview-subscribe?amount=1'] = () => ({ status: 200, body: { expected_failure: null } });

    const report = await run({ bondId: 7 });

    expect(report.ok).toBe(true);
    expect(calls.some((c) => c.key.startsWith('GET /api/bonds?'))).toBe(false);
  });
});
