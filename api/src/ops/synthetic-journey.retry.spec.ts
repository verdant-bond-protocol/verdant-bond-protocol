import { JourneyRuntime, SyntheticJourneyConfig, SyntheticJourneyMonitor } from './synthetic-journey.monitor';

/**
 * Bounded-retry behaviour of the critical-journey monitor (contributor slice).
 *
 * Retries exist only for transient faults. Authorization (401/403), other 4xx,
 * bad data and degraded readiness are permanent by design: re-probing them
 * would either leak credentials into a retry loop or mask a real incident.
 * The subscribe attempt reuses one idempotency key for the whole run.
 */

type Route = (call: number) => { status: number; body?: unknown } | Promise<never>;

const BASE = 'https://api.test';
const HASH = 'a'.repeat(64);

function healthyRoutes(): Record<string, Route> {
  return {
    'GET /api/health/ready': () => ({
      status: 200,
      body: { redis: 'up', contracts: { bondIssuer: { status: 'reachable' } } },
    }),
    'GET /api/bonds/3/detail': () => ({ status: 200, body: {} }),
    'GET /api/bonds/3/preview-subscribe?amount=1': () => ({ status: 200, body: { expected_failure: null } }),
    'POST /api/bonds/3/subscribe': () => ({ status: 200, body: { transactionHash: HASH } }),
    [`GET /api/stellar/transactions/${HASH}`]: () => ({ status: 200, body: { status: 'confirmed' } }),
  };
}

describe('SyntheticJourneyMonitor bounded retries (contributor slice)', () => {
  let clock: number;
  let routes: Record<string, Route>;
  let calls: Array<{ key: string; init?: RequestInit }>;
  let keyCounter: number;

  const runtime: JourneyRuntime = {
    fetch: (async (url: string, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${url.replace(BASE, '')}`;
      const call = calls.filter((c) => c.key === key).length + 1;
      calls.push({ key, init });
      clock += 10;
      const route = routes[key];
      if (!route) return new Response(JSON.stringify({ detail: 'no route' }), { status: 404 });
      const { status, body } = await route(call);
      return new Response(JSON.stringify(body ?? {}), { status });
    }) as unknown as typeof fetch,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    idempotencyKey: () => `synthetic-${++keyCounter}`,
  };

  const config = (overrides: Partial<SyntheticJourneyConfig> = {}): SyntheticJourneyConfig => ({
    baseUrl: BASE,
    amount: 1,
    bondId: 3,
    stepTimeoutMs: 5_000,
    confirmTimeoutMs: 60_000,
    confirmPollMs: 5_000,
    retryDelayMs: 25,
    ...overrides,
  });

  const run = (overrides: Partial<SyntheticJourneyConfig> = {}) =>
    new SyntheticJourneyMonitor(config(overrides), runtime).run();

  const write = { token: 'jwt', investorAddress: 'GINVESTOR' };

  beforeEach(() => {
    clock = 1_000_000;
    keyCounter = 0;
    routes = healthyRoutes();
    calls = [];
  });

  it('normal path: a healthy journey performs exactly one attempt per step', async () => {
    const report = await run({ maxAttempts: 5 });

    expect(report.ok).toBe(true);
    expect(report.steps.every((s) => s.attempts === 1)).toBe(true);
    expect(clock).toBe(1_000_030); // 3 read-only steps x 10ms, no retry sleeps
  });

  it('retry path: a transient 5xx is retried and the step still passes', async () => {
    routes['GET /api/bonds/3/detail'] = (call) =>
      call === 1 ? { status: 503, body: { detail: 'RPC busy' } } : { status: 200, body: {} };

    const report = await run({ maxAttempts: 3 });

    const detail = report.steps.find((s) => s.name === 'bond-detail')!;
    expect(detail.ok).toBe(true);
    expect(detail.attempts).toBe(2);
    expect(calls.filter((c) => c.key === 'GET /api/bonds/3/detail')).toHaveLength(2);
    expect(report.ok).toBe(true);
    expect(clock).toBe(1_000_065); // 4 calls + one 25ms retry delay
  });

  it('retry path: 408 and 429 are retried like 5xx', async () => {
    for (const status of [408, 429]) {
      calls = [];
      routes['GET /api/bonds/3/detail'] = (call) =>
        call === 1 ? { status, body: {} } : { status: 200, body: {} };
      const report = await run({ maxAttempts: 2 });
      expect(report.steps.find((s) => s.name === 'bond-detail')!.attempts).toBe(2);
      expect(report.ok).toBe(true);
    }
  });

  it('retry path: transient network errors are retried', async () => {
    let attempt = 0;
    routes['GET /api/bonds/3/detail'] = () => {
      attempt++;
      if (attempt === 1) return new Promise((_, reject) => reject(new Error('ECONNRESET')));
      return { status: 200, body: {} };
    };

    const report = await run({ maxAttempts: 2 });

    expect(report.ok).toBe(true);
    expect(report.steps.find((s) => s.name === 'bond-detail')!.attempts).toBe(2);
  });

  it('failure path: retries are bounded and the last failure keeps its blame', async () => {
    routes['GET /api/bonds/3/detail'] = () => ({ status: 503, body: { detail: 'RPC down' } });

    const report = await run({ maxAttempts: 3 });

    const detail = report.steps.find((s) => s.name === 'bond-detail')!;
    expect(detail.ok).toBe(false);
    expect(detail.attempts).toBe(3);
    expect(detail.httpStatus).toBe(503);
    expect(report.blame).toBe('soroban-rpc');
    expect(calls.filter((c) => c.key === 'GET /api/bonds/3/detail')).toHaveLength(3);
  });

  it('authorization path: 401/403 are never retried and are blamed on config', async () => {
    routes['POST /api/bonds/3/subscribe'] = () => ({ status: 403, body: { detail: 'KYC required' } });

    const report = await run({ maxAttempts: 5, write });

    const subscribe = report.steps.find((s) => s.name === 'subscribe')!;
    expect(subscribe.ok).toBe(false);
    expect(subscribe.attempts).toBe(1);
    expect(subscribe.httpStatus).toBe(403);
    expect(report.blame).toBe('config');
    expect(calls.filter((c) => c.key === 'POST /api/bonds/3/subscribe')).toHaveLength(1);
  });

  it('authorization path: degraded readiness is not retried', async () => {
    routes['GET /api/health/ready'] = () => ({ status: 200, body: { redis: 'degraded', contracts: {} } });

    const report = await run({ maxAttempts: 5 });

    expect(report.steps[0].attempts).toBe(1);
    expect(report.blame).toBe('redis');
    expect(calls.filter((c) => c.key === 'GET /api/health/ready')).toHaveLength(1);
  });

  it('recovery path: a retried subscribe reuses the same idempotency key', async () => {
    routes['POST /api/bonds/3/subscribe'] = (call) =>
      call === 1 ? { status: 503, body: {} } : { status: 200, body: { transactionHash: HASH } };

    const report = await run({ maxAttempts: 2, write });

    const posts = calls.filter((c) => c.key === 'POST /api/bonds/3/subscribe');
    expect(posts).toHaveLength(2);
    const keys = posts.map((p) => (p.init?.headers as Record<string, string>)['Idempotency-Key']);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toMatch(/^synthetic-/);
    expect(report.steps.find((s) => s.name === 'subscribe')!.attempts).toBe(2);
    expect(report.ok).toBe(true);
  });

  it('recovery path: exactly one idempotency key is generated per run', async () => {
    await run({ maxAttempts: 3, write });
    expect(keyCounter).toBe(1);
  });
});
