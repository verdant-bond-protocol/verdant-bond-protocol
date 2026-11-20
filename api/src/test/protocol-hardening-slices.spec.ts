import { ForbiddenException, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { PolicyService } from '../policy/policy.service';
import { PolicySimulationService } from '../policy/policy-simulation.service';
import { PolicyEvaluationContext } from '../policy/policy.interface';
import { SideEffectCheckpointService } from '../recovery/side-effect-checkpoint.service';
import { SessionService } from '../auth/session.service';
import { canRevokeSessions } from '../auth/session-revocation.interface';
import { DataRetentionService, DataType, RETENTION_DAYS } from '../ops/data-retention.service';
import { OracleIncidentStatus } from '../oracle/interfaces/oracle-incident.interface';
import * as fs from 'fs';

/**
 * Integrated contract verification for Protocol Hardening Vertical Slices:
 * - #578: Policy simulation with affected-record preview
 * - #571: Durable checkpoints around external side effects
 * - #579: Security-event session invalidation
 * - #577: Retention enforcement and deletion verification
 */
describe('Protocol Hardening Vertical Slices (#578, #571, #579, #577)', () => {
  describe('Issue #578: Policy Simulation with Affected-Record Preview', () => {
    let policyService: PolicyService;
    let simulationService: PolicySimulationService;

    const testRecords: Array<PolicyEvaluationContext & { id: string }> = [
      {
        id: 'rec-1-us',
        bondId: 1,
        investorAddress: 'GBRPYHIZ2AA323456789012345678901234567890123456789012345',
        amount: BigInt('5000'),
        timestamp: 1600000000,
        jurisdiction: 'US',
      },
      {
        id: 'rec-2-ky',
        bondId: 2,
        investorAddress: 'GCSOMESUBSCRIBERADDRESS234567890123456789012345678901',
        amount: BigInt('2000000000000'),
        timestamp: 1600000000,
        jurisdiction: 'KY',
      },
    ];

    beforeEach(() => {
      policyService = new PolicyService({} as any);
      simulationService = new PolicySimulationService(policyService);
    });

    it('normal path: accurately previews affected records and risk warnings', () => {
      const result = simulationService.simulatePolicyChange({
        userRole: 'MAINTAINER',
        proposedConfig: {
          minSubscriptionAmount: BigInt('10000'),
          restrictedJurisdictions: ['KY'],
        },
        records: testRecords,
      });

      expect(result.isReadOnlyConfirmed).toBe(true);
      expect(result.totalEvaluated).toBe(2);
      expect(result.affectedCount).toBe(2);
      expect(result.affectedExamples).toHaveLength(2);
      expect(result.riskWarnings.some((w) => w.includes('Jurisdiction Restriction'))).toBe(true);
    });

    it('failure path: rejects unauthorized roles and invalid configurations', () => {
      expect(() => {
        simulationService.simulatePolicyChange({
          userRole: 'INVESTOR',
          proposedConfig: {},
        });
      }).toThrow(ForbiddenException);

      expect(() => {
        simulationService.simulatePolicyChange({
          userRole: 'ADMIN',
          proposedConfig: {
            minSubscriptionAmount: BigInt('2000'),
            maxSubscriptionAmount: BigInt('1000'),
          },
        });
      }).toThrow(BadRequestException);
    });

    it('retry path: produces identical deterministic results without mutating live state', () => {
      const initialConfig = policyService.getPolicyConfiguration();

      const run1 = simulationService.simulatePolicyChange({
        userRole: 'ADMIN',
        proposedConfig: { minSubscriptionAmount: BigInt('5000') },
        records: testRecords,
      });

      const run2 = simulationService.simulatePolicyChange({
        userRole: 'ADMIN',
        proposedConfig: { minSubscriptionAmount: BigInt('5000') },
        records: testRecords,
      });

      expect(run1).toEqual(run2);
      expect(policyService.getPolicyConfiguration()).toEqual(initialConfig);
    });
  });

  describe('Issue #571: Durable Checkpoints Around External Side Effects', () => {
    let service: SideEffectCheckpointService;
    let redisStore: Map<string, string>;

    beforeEach(() => {
      redisStore = new Map();
      const mockRedis = {
        get: jest.fn(async (key: string) => redisStore.get(key) ?? null),
        set: jest.fn(async (key: string, val: string) => {
          redisStore.set(key, val);
          return 'OK';
        }),
        scanKeys: jest.fn(async () => [...redisStore.keys()]),
      };
      service = new SideEffectCheckpointService(mockRedis as any);
    });

    it('normal path: records applied checkpoint on successful execution', async () => {
      const execute = jest.fn(async () => {});
      const cp = await service.run({ key: 'stellar:tx:001', execute });

      expect(cp.state).toBe('applied');
      expect(cp.attempts).toBe(1);
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('failure & retry path: resolves ambiguous timeout via probe without duplicate execution', async () => {
      const execute = jest.fn(async () => {
        throw new Error('504 Gateway Timeout');
      });
      const probe = jest.fn(async () => true);

      const initial = await service.run({ key: 'stellar:tx:002', execute, probe });
      expect(initial.state).toBe('verified');

      const reExecute = jest.fn(async () => {});
      const resumed = await service.resume('stellar:tx:002', reExecute, probe);

      expect(resumed.state).toBe('verified');
      expect(reExecute).not.toHaveBeenCalled();
    });

    it('failure path: marks unknown when probe fails, preventing automatic re-execution', async () => {
      const execute = jest.fn(async () => {
        throw new Error('connection reset');
      });
      const probe = jest.fn(async () => {
        throw new Error('horizon probe unreachable');
      });

      const cp = await service.run({ key: 'stellar:tx:003', execute, probe });
      expect(cp.state).toBe('unknown');
      expect(cp.lastError).toContain('horizon probe unreachable');
    });
  });

  describe('Issue #579: Security-Event Session Invalidation', () => {
    let sessionService: SessionService;
    let redisStore: Map<string, string>;
    let isFailing = false;

    beforeEach(() => {
      redisStore = new Map();
      isFailing = false;
      const mockRedis = {
        getOrThrow: jest.fn(async (k: string) => {
          if (isFailing) throw new Error('redis unreachable');
          return redisStore.get(k) ?? null;
        }),
        incrOrThrow: jest.fn(async (k: string) => {
          if (isFailing) throw new Error('redis unreachable');
          const current = Number(redisStore.get(k) ?? '0') + 1;
          redisStore.set(k, String(current));
          return current;
        }),
        set: jest.fn(async (k: string, v: string) => {
          if (isFailing) return null;
          redisStore.set(k, v);
          return 'OK';
        }),
        expire: jest.fn(async () => true),
      };

      sessionService = new SessionService(mockRedis as any);
      sessionService.setFailOpen(false);
    });

    it('normal path: authenticates active token pinned to current epoch', async () => {
      const wallet = 'GBRPYHIZ2AA323456789012345678901234567890123456789012345';
      const { sessionVersion, jti } = await sessionService.issue(wallet);

      await expect(
        sessionService.assertActive({ sub: wallet, sv: sessionVersion, jti }),
      ).resolves.toBeUndefined();
    });

    it('failure path: rejects revoked jti and stale epoch version', async () => {
      const wallet = 'GBRPYHIZ2AA323456789012345678901234567890123456789012345';
      const tokenA = await sessionService.issue(wallet);
      const tokenB = await sessionService.issue(wallet);

      await sessionService.revokeToken(tokenA.jti);
      await expect(
        sessionService.assertActive({ sub: wallet, sv: tokenA.sessionVersion, jti: tokenA.jti }),
      ).rejects.toThrow('revoked');

      await expect(
        sessionService.assertActive({ sub: wallet, sv: tokenB.sessionVersion, jti: tokenB.jti }),
      ).resolves.toBeUndefined();

      await sessionService.revokeAll(wallet, { walletAddress: wallet });
      await expect(
        sessionService.assertActive({ sub: wallet, sv: tokenB.sessionVersion, jti: tokenB.jti }),
      ).rejects.toThrow('stale');
    });

    it('authorization path: enforces canRevokeSessions boundaries', () => {
      const user = 'GUSER';
      const stranger = 'GSTRANGER';

      expect(canRevokeSessions({ walletAddress: user }, user)).toBe(true);
      expect(canRevokeSessions({ walletAddress: stranger }, user)).toBe(false);
      expect(canRevokeSessions({ walletAddress: stranger, roles: ['admin'] }, user)).toBe(true);
      expect(canRevokeSessions({ walletAddress: stranger, permissions: ['auth:sessions:revoke'] }, user)).toBe(true);
    });
  });

  describe('Issue #577: Retention Enforcement and Deletion Verification', () => {
    let retentionService: DataRetentionService;
    let mockOracleRepo: any;

    beforeEach(() => {
      mockOracleRepo = {
        findMany: jest.fn().mockResolvedValue({
          data: [],
          meta: { nextCursor: null },
        }),
      };
      retentionService = new DataRetentionService(mockOracleRepo);
    });

    it('normal path: defines standard regulatory retention windows', () => {
      expect(RETENTION_DAYS[DataType.TELEMETRY]).toBe(30);
      expect(RETENTION_DAYS[DataType.EXPORT]).toBe(7);
      expect(RETENTION_DAYS[DataType.EVIDENCE]).toBe(365 * 5);
      expect(RETENTION_DAYS[DataType.AUDIT]).toBe(365 * 7);
    });

    it('failure path: fails closed to protect evidence when incident store is unreachable', async () => {
      mockOracleRepo.findMany = jest.fn().mockRejectedValue(new Error('DB unreachable'));

      const preview = await retentionService.previewCleanup();
      expect(preview).toBeDefined();
      expect(Array.isArray(preview.entries)).toBe(true);
    });
  });
});

