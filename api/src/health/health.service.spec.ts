import { HealthService } from './health.service';
import { HealthIndicator, DependencyHealth } from './health.interface';

function stubIndicator(
  name: string,
  result: DependencyHealth | Error,
  critical = false,
): HealthIndicator {
  return {
    name,
    critical,
    check: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

function makeService(
  indicators: Array<{ name: string; critical?: boolean; check: () => Promise<DependencyHealth> }>,
): HealthService {
  const service = new HealthService(
    { name: 'redis', critical: true, check: async () => ({ name: 'redis', state: 'operational' }) } as any,
    { name: 'version', critical: false, check: async () => ({ name: 'version', state: 'operational' }) } as any,
  );
  for (const ind of indicators) service.registerIndicator(ind, ind.critical);
  return service;
}

describe('HealthService.getReport', () => {
  it('healthy: all operational dependencies reports healthy with an entry each', async () => {
    const service = makeService([
      stubIndicator('db', { name: 'db', state: 'operational' }, true) as any,
      stubIndicator('cache', { name: 'cache', state: 'operational' }, false) as any,
    ]);
    const report = await service.getReport();

    expect(report.status).toBe('healthy');
    expect(report.dependencies.map((d) => d.name).sort()).toEqual(['cache', 'db']);
    expect(report.timestamp).toBeTruthy();
    expect(typeof report.uptimeMs).toBe('number');
  });

  it('down: a critical dependency being down reports overall down', async () => {
    const service = makeService([
      stubIndicator('db', { name: 'db', state: 'down', message: 'connection refused' }, true) as any,
      stubIndicator('cache', { name: 'cache', state: 'operational' }, false) as any,
    ]);
    const report = await service.getReport();

    expect(report.status).toBe('down');
    expect(report.dependencies.find((d) => d.name === 'db')?.state).toBe('down');
  });

  it('degraded: a non-critical dependency being down degrades but does not take the service down', async () => {
    const service = makeService([
      stubIndicator('db', { name: 'db', state: 'operational' }, true) as any,
      stubIndicator('search', { name: 'search', state: 'down' }, false) as any,
    ]);
    const report = await service.getReport();

    expect(report.status).toBe('degraded');
  });

  it('failure path: an indicator that throws is surfaced as down rather than crashing the report', async () => {
    const service = makeService([
      stubIndicator('flaky', new Error('boom'), true) as any,
    ]);
    const report = await service.getReport();

    expect(report.status).toBe('down');
    expect(report.dependencies[0]).toMatchObject({
      name: 'flaky',
      state: 'down',
      message: 'boom',
    });
  });

  it('regression: report is produced even when every indicator throws', async () => {
    const service = makeService([
      stubIndicator('a', new Error('x'), true) as any,
      stubIndicator('b', new Error('y'), false) as any,
    ]);
    const report = await service.getReport();

    expect(report.dependencies).toHaveLength(2);
    expect(report.status).toBe('down');
  });
});

describe('HealthService indicator registration', () => {
  it('registerIndicator wires the critical flag through to the report', async () => {
    const service = makeService([
      { name: 'x', critical: false, check: async () => ({ name: 'x', state: 'down' }) } as any,
    ]);
    // registered without the critical flag -> non-critical -> degraded
    const report = await service.getReport();
    expect(report.status).toBe('degraded');

    const service2 = makeService([]);
    service2.registerIndicator(
      { name: 'y', check: async () => ({ name: 'y', state: 'down' }) } as any,
      true,
    );
    expect((await service2.getReport()).status).toBe('down');
  });

  it('onModuleInit registers the built-in redis and version indicators', () => {
    const service = new HealthService(
      { name: 'redis', critical: true, check: async () => ({ name: 'redis', state: 'operational' }) } as any,
      { name: 'version', critical: false, check: async () => ({ name: 'version', state: 'operational' }) } as any,
    );
    service.onModuleInit();
    // redis + version
    expect((service as any).indicators).toHaveLength(2);
    expect((service as any).indicators[0].name).toBe('redis');
  });
});
