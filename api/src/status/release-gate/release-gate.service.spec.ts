import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ReleaseGateService } from './release-gate.service';
import { ConfigService } from '../../config/config.service';
import { ContractService } from '../../stellar/contract.service';
import { nativeToScVal } from '@stellar/stellar-sdk';
import { ReleaseGateStatus, SUPPORTED_CONTRACT_SCHEMA_VERSION } from './release-gate.interface';

describe('ReleaseGateService (#473)', () => {
  let service: ReleaseGateService;
  let mockContractService: { simulateCall: jest.Mock };
  let mockConfigService: {
    getBondIssuerAddress: jest.Mock;
    getCouponEngineAddress: jest.Mock;
    getDexRouterAddress: jest.Mock;
    getOracleConsumerAddress: jest.Mock;
    getCreditRetirementAddress: jest.Mock;
    getProjectRegistryAddress: jest.Mock;
  };

  const MOCK_ADDR = {
    BOND: 'CAAAABONDISSUERADDRESS1234567890',
    COUPON: 'CAACOUPONENGINEADDRESS1234567890',
    DEX: 'CAADEXROUTERADDRESS1234567890',
    ORACLE: 'CAAORACLECONSUMERADDRESS1234567890',
    CREDIT: 'CAACREDITRETIREMENTADDRESS1234567890',
    REGISTRY: 'CAAPROJECTREGISTRYADDRESS1234567890',
  };

  beforeEach(async () => {
    mockConfigService = {
      getBondIssuerAddress: jest.fn().mockReturnValue(MOCK_ADDR.BOND),
      getCouponEngineAddress: jest.fn().mockReturnValue(MOCK_ADDR.COUPON),
      getDexRouterAddress: jest.fn().mockReturnValue(MOCK_ADDR.DEX),
      getOracleConsumerAddress: jest.fn().mockReturnValue(MOCK_ADDR.ORACLE),
      getCreditRetirementAddress: jest.fn().mockReturnValue(MOCK_ADDR.CREDIT),
      getProjectRegistryAddress: jest.fn().mockReturnValue(MOCK_ADDR.REGISTRY),
    };

    mockContractService = {
      simulateCall: jest.fn().mockImplementation(async ({ contractAddress, method }) => {
        if (method === 'schema_version') {
          return nativeToScVal(SUPPORTED_CONTRACT_SCHEMA_VERSION, { type: 'u32' });
        }
        if (method === 'get_migration_window') {
          return nativeToScVal({ is_active: false });
        }
        return nativeToScVal(true);
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReleaseGateService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: ContractService, useValue: mockContractService },
      ],
    }).compile();

    service = module.get<ReleaseGateService>(ReleaseGateService);
  });

  describe('Normal Path: Schema & Interface Compatibility', () => {
    it('evaluates release gate as COMPATIBLE when all contracts match expected schema', async () => {
      const evaluation = await service.evaluateReleaseGate(true);

      expect(evaluation.gateStatus).toBe(ReleaseGateStatus.COMPATIBLE);
      expect(evaluation.overallCompatible).toBe(true);
      expect(evaluation.violations).toHaveLength(0);
      expect(evaluation.activeMigrations).toHaveLength(0);
      expect(evaluation.storageValidation.verified).toBe(true);

      expect(evaluation.contracts['bond-issuer'].isVersionCompatible).toBe(true);
      expect(evaluation.contracts['bond-issuer'].deployedSchemaVersion).toBe(1);
      expect(evaluation.contracts['coupon-engine'].status).toBe('COMPATIBLE');
    });

    it('caches evaluation and returns cached result until force refresh', async () => {
      const first = await service.evaluateReleaseGate(false);
      const callCount = mockContractService.simulateCall.mock.calls.length;

      const second = await service.evaluateReleaseGate(false);
      expect(second).toBe(first);
      expect(mockContractService.simulateCall.mock.calls.length).toBe(callCount);

      const refreshed = await service.evaluateReleaseGate(true);
      expect(mockContractService.simulateCall.mock.calls.length).toBeGreaterThan(callCount);
    });
  });

  describe('Failure Path: Version Mismatch and Missing Callable Guard', () => {
    it('detects contract schema version mismatch and marks gate INCOMPATIBLE', async () => {
      mockContractService.simulateCall.mockImplementation(async ({ contractAddress, method }) => {
        if (contractAddress === MOCK_ADDR.BOND && method === 'schema_version') {
          // Deployed version 2 while API expects 1
          return nativeToScVal(2, { type: 'u32' });
        }
        return nativeToScVal(SUPPORTED_CONTRACT_SCHEMA_VERSION, { type: 'u32' });
      });

      const evaluation = await service.evaluateReleaseGate(true);

      expect(evaluation.gateStatus).toBe(ReleaseGateStatus.INCOMPATIBLE);
      expect(evaluation.overallCompatible).toBe(false);
      expect(evaluation.violations.some((v) => v.includes('bond-issuer'))).toBe(true);
      expect(evaluation.rollbackRecommendations.length).toBeGreaterThan(0);
      expect(evaluation.rollbackRecommendations[0]).toContain('Revert wasm to previous release');
    });

    it('flags failure when contract call fails with RPC error', async () => {
      mockContractService.simulateCall.mockImplementation(async ({ contractAddress, method }) => {
        if (contractAddress === MOCK_ADDR.DEX && method === 'schema_version') {
          throw new Error('Connection refused to RPC');
        }
        return nativeToScVal(SUPPORTED_CONTRACT_SCHEMA_VERSION, { type: 'u32' });
      });

      const evaluation = await service.evaluateReleaseGate(true);

      expect(evaluation.gateStatus).toBe(ReleaseGateStatus.INCOMPATIBLE);
      expect(evaluation.overallCompatible).toBe(false);
      expect(evaluation.violations.some((v) => v.includes('Failed to query schema_version on contract [dex-router]'))).toBe(true);
    });

    it('flags unconfigured contract address as INCOMPATIBLE', async () => {
      mockConfigService.getOracleConsumerAddress.mockReturnValue('');

      const evaluation = await service.evaluateReleaseGate(true);

      expect(evaluation.gateStatus).toBe(ReleaseGateStatus.INCOMPATIBLE);
      expect(evaluation.violations.some((v) => v.includes('address for contract [oracle-consumer] is not defined'))).toBe(true);
    });
  });

  describe('Migration Window Path', () => {
    it('marks gate as MIGRATION_ACTIVE when in-flight migration window is open', async () => {
      mockContractService.simulateCall.mockImplementation(async ({ contractAddress, method }) => {
        if (contractAddress === MOCK_ADDR.COUPON && method === 'get_migration_window') {
          return nativeToScVal({ is_active: true });
        }
        return nativeToScVal(SUPPORTED_CONTRACT_SCHEMA_VERSION, { type: 'u32' });
      });

      const evaluation = await service.evaluateReleaseGate(true);

      expect(evaluation.gateStatus).toBe(ReleaseGateStatus.MIGRATION_ACTIVE);
      expect(evaluation.overallCompatible).toBe(false);
      expect(evaluation.activeMigrations).toContain('coupon-engine');
      expect(evaluation.contracts['coupon-engine'].status).toBe('MIGRATION_REQUIRED');
    });
  });

  describe('Retry & Bypass Path: Emergency and Controlled Override', () => {
    it('rejects bypass without sufficient justification or attribution', () => {
      expect(() => {
        service.setBypass(true, 'short', 'GOPERATOR');
      }).toThrow(BadRequestException);

      expect(() => {
        service.setBypass(true, 'Long valid reason text here', '');
      }).toThrow(BadRequestException);
    });

    it('allows authorized bypass to override INCOMPATIBLE status with audit trail', async () => {
      // Cause a failure
      mockContractService.simulateCall.mockImplementation(async ({ contractAddress, method }) => {
        if (contractAddress === MOCK_ADDR.BOND && method === 'schema_version') {
          return nativeToScVal(99, { type: 'u32' });
        }
        return nativeToScVal(SUPPORTED_CONTRACT_SCHEMA_VERSION, { type: 'u32' });
      });

      // Confirm incompatible first
      const failedEval = await service.evaluateReleaseGate(true);
      expect(failedEval.gateStatus).toBe(ReleaseGateStatus.INCOMPATIBLE);

      // Authorize bypass
      const bypass = service.setBypass(
        true,
        'Canary stage testing with pre-release bond contract v99',
        'GADMINOPERATOR123',
      );
      expect(bypass.bypassed).toBe(true);

      // Evaluate again
      const bypassedEval = await service.evaluateReleaseGate(true);
      expect(bypassedEval.gateStatus).toBe(ReleaseGateStatus.BYPASSED);
      expect(bypassedEval.overallCompatible).toBe(true);
      expect(bypassedEval.bypass?.bypassed).toBe(true);
      expect(bypassedEval.bypass?.bypassedBy).toBe('GADMINOPERATOR123');
      expect(bypassedEval.bypass?.overriddenViolations?.length).toBeGreaterThan(0);

      // Revoke bypass
      service.setBypass(false, '', 'GADMINOPERATOR123');
      const revokedEval = await service.evaluateReleaseGate(true);
      expect(revokedEval.gateStatus).toBe(ReleaseGateStatus.INCOMPATIBLE);
    });
  });
});
