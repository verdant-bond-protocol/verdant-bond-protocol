import { RedisHealthController } from './redis-health.controller';
import { StrKey } from '@stellar/stellar-sdk';

const ADDRESS = StrKey.encodeContract(Buffer.alloc(32, 1));

describe('RedisHealthController readiness', () => {
  const config = {
    getBondIssuerAddress: () => ADDRESS,
    getCouponEngineAddress: () => ADDRESS,
    getDexRouterAddress: () => ADDRESS,
    getProjectRegistryAddress: () => ADDRESS,
    getOracleConsumerAddress: () => ADDRESS,
    getCreditRetirementAddress: () => ADDRESS,
  };

  it('reports every reachable contract', async () => {
    const controller = new RedisHealthController(
      { isHealthy: () => true } as any,
      { simulateCall: jest.fn().mockResolvedValue({}) } as any,
      config as any,
    );
    const result = await controller.readiness();
    expect(result.status).toBe('ready');
    expect(Object.values(result.contracts).every((item) => item.status === 'reachable')).toBe(true);
  });

  it('degrades for a wrong-network or unreachable contract', async () => {
    const controller = new RedisHealthController(
      { isHealthy: () => true } as any,
      { simulateCall: jest.fn().mockRejectedValue(new Error('contract not found')) } as any,
      config as any,
    );
    const result = await controller.readiness();
    expect(result.status).toBe('degraded');
    expect(result.contracts.bondIssuer.status).toBe('unreachable');
  });

  it('identifies malformed contract IDs as misconfigured without probing', async () => {
    const simulateCall = jest.fn();
    const controller = new RedisHealthController(
      { isHealthy: () => true } as any,
      { simulateCall } as any,
      { ...config, getBondIssuerAddress: () => 'not-a-contract' } as any,
    );
    const result = await controller.readiness();
    expect(result.status).toBe('degraded');
    expect(result.contracts.bondIssuer.status).toBe('misconfigured');
    expect(simulateCall).toHaveBeenCalledTimes(5);
  });
});
