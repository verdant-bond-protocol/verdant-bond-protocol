import { ForbiddenException, BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PolicyService } from './policy.service';
import { PolicyConfiguration, PolicyEvaluationContext, PolicyEvaluationResult } from './policy.interface';

export interface PolicySimulationInput {
  proposedConfig: Partial<PolicyConfiguration>;
  userRole: string;
  records?: Array<PolicyEvaluationContext & { id?: string }>;
}

export interface AffectedRecordExample {
  recordId: string;
  previousOutcome: PolicyEvaluationResult;
  simulatedOutcome: PolicyEvaluationResult;
  changes: string[];
}

export interface PolicySimulationResult {
  isReadOnlyConfirmed: boolean;
  totalEvaluated: number;
  affectedCount: number;
  unaffectedCount: number;
  affectedExamples: AffectedRecordExample[];
  riskWarnings: string[];
}

@Injectable()
export class PolicySimulationService {
  private readonly logger = new Logger(PolicySimulationService.name);

  constructor(private readonly policyService: PolicyService) {}

  simulatePolicyChange(input: PolicySimulationInput): PolicySimulationResult {
    // 1. Permission check
    if (input.userRole !== 'MAINTAINER' && input.userRole !== 'ADMIN') {
      throw new ForbiddenException('Only maintainers or admins can run policy simulations');
    }

    // 2. Validate proposed configuration integrity
    this.validateProposedConfig(input.proposedConfig);

    // 3. Snapshot current policy config
    const currentConfig = this.policyService.getPolicyConfiguration();

    // 4. Construct temporary simulated policy config
    const simulatedConfig: PolicyConfiguration = {
      ...currentConfig,
      ...input.proposedConfig,
    };

    const targetRecords = input.records ?? this.getDefaultSimulationDataset();

    const affectedExamples: AffectedRecordExample[] = [];
    let affectedCount = 0;
    let unaffectedCount = 0;
    const riskWarnings: string[] = [];

    // 5. Run read-only evaluation against each record
    for (const record of targetRecords) {
      const recordId = record.id || `bond_${record.bondId}_${record.investorAddress}`;

      // Evaluate against current policy
      const previousOutcome = this.policyService.evaluateSubscriptionEligibility(record);

      // Evaluate against simulated policy temporary instance
      const simulatedOutcome = this.evaluateWithConfig(simulatedConfig, record);

      const hasChanged = previousOutcome.allowed !== simulatedOutcome.allowed ||
        previousOutcome.violations.length !== simulatedOutcome.violations.length;

      if (hasChanged) {
        affectedCount++;
        const changes: string[] = [];

        if (previousOutcome.allowed && !simulatedOutcome.allowed) {
          changes.push(`Status changed from APPROVED to DISAPPROVED`);
        } else if (!previousOutcome.allowed && simulatedOutcome.allowed) {
          changes.push(`Status changed from DISAPPROVED to APPROVED`);
        }

        const newRules = simulatedOutcome.violations.map((v) => v.rule);
        const oldRules = previousOutcome.violations.map((v) => v.rule);
        const addedRules = newRules.filter((r) => !oldRules.includes(r));

        if (addedRules.length > 0) {
          changes.push(`Triggered new violation rules: ${addedRules.join(', ')}`);
        }

        affectedExamples.push({
          recordId,
          previousOutcome,
          simulatedOutcome,
          changes,
        });
      } else {
        unaffectedCount++;
      }
    }

    // 6. Generate risk warnings
    if (affectedCount > 0) {
      const percentage = Math.round((affectedCount / targetRecords.length) * 100);
      if (percentage >= 20) {
        riskWarnings.push(`High Impact Warning: ${percentage}% of evaluated records will be affected by this policy change.`);
      }
    }

    if (input.proposedConfig.restrictedJurisdictions && input.proposedConfig.restrictedJurisdictions.length > 0) {
      riskWarnings.push(`Jurisdiction Restriction: Adding ${input.proposedConfig.restrictedJurisdictions.join(', ')} will block investors in those regions.`);
    }

    // 7. Verify read-only invariant (current policy config remained unchanged)
    const postSimulationConfig = this.policyService.getPolicyConfiguration();
    const bigIntReplacer = (_key: string, value: any) =>
      typeof value === 'bigint' ? value.toString() : value;
    if (
      JSON.stringify(currentConfig, bigIntReplacer) !==
      JSON.stringify(postSimulationConfig, bigIntReplacer)
    ) {
      this.logger.error('CRITICAL: Production policy state was mutated during simulation!');
      throw new Error('Simulation state mutation detected');
    }

    return {
      isReadOnlyConfirmed: true,
      totalEvaluated: targetRecords.length,
      affectedCount,
      unaffectedCount,
      affectedExamples,
      riskWarnings,
    };
  }

  private validateProposedConfig(config: Partial<PolicyConfiguration>): void {
    if (
      config.minSubscriptionAmount !== undefined &&
      config.maxSubscriptionAmount !== undefined &&
      BigInt(config.minSubscriptionAmount) > BigInt(config.maxSubscriptionAmount)
    ) {
      throw new BadRequestException(
        'Invalid policy configuration: minSubscriptionAmount cannot exceed maxSubscriptionAmount',
      );
    }
  }

  private evaluateWithConfig(
    config: PolicyConfiguration,
    context: PolicyEvaluationContext,
  ): PolicyEvaluationResult {
    const tempService = new PolicyService({} as any);
    tempService.updatePolicyConfiguration(config);
    return tempService.evaluateSubscriptionEligibility(context);
  }

  private getDefaultSimulationDataset(): Array<PolicyEvaluationContext & { id?: string }> {
    return [
      {
        id: 'rec_US_1000',
        bondId: 1,
        investorAddress: 'GBRPYHIZ2AA323456789012345678901234567890123456789012345',
        amount: BigInt('10000'),
        timestamp: Date.now(),
        jurisdiction: 'US',
      },
      {
        id: 'rec_EU_500',
        bondId: 1,
        investorAddress: 'GCSOMESUBSCRIBERADDRESS234567890123456789012345678901',
        amount: BigInt('500'),
        timestamp: Date.now(),
        jurisdiction: 'EU',
      },
      {
        id: 'rec_KY_2000000000000',
        bondId: 2,
        investorAddress: 'GCLARGEINVESTORADDRESS2345678901234567890123456789012',
        amount: BigInt('2000000000000'),
        timestamp: Date.now(),
        jurisdiction: 'KY',
      },
    ];
  }
}
