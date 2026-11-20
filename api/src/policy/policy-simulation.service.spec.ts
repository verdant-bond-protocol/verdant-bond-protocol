import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { PolicyService } from './policy.service';
import { PolicySimulationService } from './policy-simulation.service';
import { PolicyEvaluationContext } from './policy.interface';

describe('PolicySimulationService', () => {
  let policyService: PolicyService;
  let simulationService: PolicySimulationService;

  beforeEach(() => {
    policyService = new PolicyService({} as any);
    simulationService = new PolicySimulationService(policyService);
  });

  const sampleRecords: Array<PolicyEvaluationContext & { id: string }> = [
    {
      id: 'inv_1',
      bondId: 101,
      investorAddress: 'GADDR1',
      amount: BigInt('5000'),
      timestamp: 1600000000,
      jurisdiction: 'US',
    },
    {
      id: 'inv_2',
      bondId: 101,
      investorAddress: 'GADDR2',
      amount: BigInt('500'), // Below 1000 if min is raised
      timestamp: 1600000000,
      jurisdiction: 'CA',
    },
    {
      id: 'inv_3',
      bondId: 102,
      investorAddress: 'GADDR3',
      amount: BigInt('1500000000000'), // Above default max (1,000,000,000,000)
      timestamp: 1600000000,
      jurisdiction: 'KY',
    },
  ];

  it('should deny simulation for non-maintainers (permission-denied)', () => {
    expect(() => {
      simulationService.simulatePolicyChange({
        userRole: 'INVESTOR',
        proposedConfig: { minSubscriptionAmount: BigInt('5000') },
      });
    }).toThrow(ForbiddenException);
  });

  it('should reject invalid policy configurations', () => {
    expect(() => {
      simulationService.simulatePolicyChange({
        userRole: 'MAINTAINER',
        proposedConfig: {
          minSubscriptionAmount: BigInt('100000'),
          maxSubscriptionAmount: BigInt('1000'), // Invalid min > max
        },
      });
    }).toThrow(BadRequestException);
  });

  it('should handle no-impact policy changes and verify production state remains unmutated', () => {
    const originalConfig = policyService.getPolicyConfiguration();

    const result = simulationService.simulatePolicyChange({
      userRole: 'MAINTAINER',
      proposedConfig: {}, // No changes proposed
      records: sampleRecords,
    });

    expect(result.isReadOnlyConfirmed).toBe(true);
    expect(result.affectedCount).toBe(0);
    expect(result.unaffectedCount).toBe(sampleRecords.length);
    expect(result.affectedExamples).toHaveLength(0);
    expect(result.riskWarnings).toHaveLength(0);

    // Verify production policy configuration is 100% untouched
    expect(policyService.getPolicyConfiguration()).toEqual(originalConfig);
  });

  it('should handle broad-impact policy changes and accurately describe affected records', () => {
    const originalConfig = policyService.getPolicyConfiguration();

    const result = simulationService.simulatePolicyChange({
      userRole: 'MAINTAINER',
      proposedConfig: {
        minSubscriptionAmount: BigInt('10000'), // Will affect inv_1 (5000) and inv_2 (500)
        restrictedJurisdictions: ['US', 'KY'], // Will affect inv_1 (US) and inv_3 (KY)
      },
      records: sampleRecords,
    });

    expect(result.isReadOnlyConfirmed).toBe(true);
    expect(result.totalEvaluated).toBe(3);
    expect(result.affectedCount).toBeGreaterThan(0);
    expect(result.affectedExamples.length).toBe(result.affectedCount);

    // Verify risk warnings are generated for high impact / restricted jurisdictions
    expect(result.riskWarnings.some((w) => w.includes('Jurisdiction Restriction'))).toBe(true);

    // Verify production policy configuration remained unchanged
    expect(policyService.getPolicyConfiguration()).toEqual(originalConfig);
  });

  it('should detail specific outcome changes for affected records', () => {
    const result = simulationService.simulatePolicyChange({
      userRole: 'ADMIN',
      proposedConfig: {
        restrictedJurisdictions: ['CA'],
      },
      records: sampleRecords,
    });

    expect(result.affectedCount).toBe(1);
    const example = result.affectedExamples[0];
    expect(example.recordId).toBe('inv_2');
    expect(example.previousOutcome.allowed).toBe(false); // inv_2 was already disallowed for amount 500 < 1000 min
    expect(example.changes.some((c) => c.includes('jurisdiction_restricted'))).toBe(true);
  });
});
