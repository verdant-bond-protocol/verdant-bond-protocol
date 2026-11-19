import { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of, throwError } from 'rxjs';
import { TelemetryInterceptor } from './telemetry.interceptor';
import { TelemetryService, type TelemetryFields } from '../services/telemetry.service';

/** HTTP telemetry safeguards: bounded labels, redaction and retry retention. */

const contextFor = (request: Record<string, any>): ExecutionContext =>
  ({ switchToHttp: () => ({ getRequest: () => request }) }) as ExecutionContext;

const handlerFor = (result: unknown): CallHandler =>
  ({ handle: () => of(result) }) as CallHandler;

const failingHandler = (error: Error): CallHandler =>
  ({ handle: () => throwError(() => error) }) as CallHandler;

describe('TelemetryInterceptor bounded labels (contributor slice)', () => {
  let service: TelemetryService;
  let interceptor: TelemetryInterceptor;
  let logSpy: jest.SpyInstance;
  let emitted: TelemetryFields[];

  const requestFor = (overrides: Record<string, any> = {}) => ({
    method: 'GET',
    path: '/api/bonds/42/detail',
    originalUrl: '/api/bonds/42/detail?refresh=true',
    correlationId: 'corr-http-1',
    ...overrides,
  });

  beforeEach(() => {
    service = new TelemetryService({ samplingRandom: () => 0.5 });
    logSpy = jest.spyOn(service['logger'], 'log').mockImplementation((line: any) => {
      emitted.push(JSON.parse(line) as TelemetryFields);
    });
    emitted = [];
    interceptor = new TelemetryInterceptor(service);
  });

  afterEach(() => logSpy.mockRestore());

  const payload = () => emitted[0];

  it('normal path: attaches bounded method/route/actor labels', async () => {
    await firstValueFrom(
      interceptor.intercept(contextFor(requestFor()), handlerFor({ bond: 42 })),
    );

    expect(payload().labels).toEqual({
      http_method: 'GET',
      http_route: '/api/bonds/:id/detail',
      actor_type: 'system',
    });
    expect(payload().correlationId).toBe('corr-http-1');
    expect(payload().operation).toBe('GET /api/bonds/42/detail');
  });

  it('prefers the router pattern when Nest exposes one', async () => {
    const request = requestFor({ baseUrl: '/api', route: { path: '/bonds/:id/detail' } });
    await firstValueFrom(interceptor.intercept(contextFor(request), handlerFor({})));

    expect(payload().labels?.http_route).toBe('/api/bonds/:id/detail');
  });

  it('authorization path: classifies the actor and never logs credentials', async () => {
    const request = requestFor({
      user: { sub: 'investor-1', role: 'admin' },
      headers: { authorization: 'Bearer secret.jwt.token' },
      body: { password: 'hunter2' },
    });
    await firstValueFrom(interceptor.intercept(contextFor(request), handlerFor({})));

    expect(payload().actorType).toBe('admin');
    expect(payload().labels?.actor_type).toBe('admin');
    expect(payload().userId).toBe('investor-1');
    expect(JSON.stringify(emitted)).not.toContain('Bearer');
    expect(JSON.stringify(emitted)).not.toContain('hunter2');
  });

  it('failure path: records a redacted error and rethrows it', async () => {
    const secret = 'S' + 'A'.repeat(55);
    const error = Object.assign(new Error(`submit failed for ${secret}`), { code: 'CHAIN_ERROR' });

    await expect(
      firstValueFrom(interceptor.intercept(contextFor(requestFor()), failingHandler(error))),
    ).rejects.toThrow('submit failed');

    expect(payload().result).toBe('failure');
    expect(payload().error).toBe('submit failed for [REDACTED_STELLAR_SECRET]');
    expect(payload().errorCode).toBe('CHAIN_ERROR');
    expect(payload().labels?.http_route).toBe('/api/bonds/:id/detail');
  });

  it('retry path: every transient failure is retained even at a 0% success rate', async () => {
    service.setSampleRate(0);
    const error = new Error('gateway timeout');
    for (let i = 0; i < 4; i++) {
      await expect(
        firstValueFrom(interceptor.intercept(contextFor(requestFor()), failingHandler(error))),
      ).rejects.toThrow('gateway timeout');
    }
    await firstValueFrom(interceptor.intercept(contextFor(requestFor()), handlerFor({})));

    expect(emitted).toHaveLength(4);
    expect(emitted.every((e) => e.result === 'failure')).toBe(true);
    expect(service.getStats().totalSampledOut).toBe(1);
  });

  it('cardinality path: distinct ids collapse to one route series', async () => {
    for (let id = 1; id <= 20; id++) {
      await firstValueFrom(
        interceptor.intercept(
          contextFor(requestFor({ path: `/api/bonds/${id}/detail`, originalUrl: `/api/bonds/${id}/detail` })),
          handlerFor({}),
        ),
      );
    }

    const routes = new Set(emitted.map((e) => e.labels?.http_route));
    expect(routes).toEqual(new Set(['/api/bonds/:id/detail']));
    expect(service.getStats().cardinalityClampedCount).toBe(0);
  });
});
