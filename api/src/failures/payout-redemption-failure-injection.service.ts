import { Injectable, Logger, BadRequestException, ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PartialFailureService } from './partial-failure.service';
import {
  CreateInjectionRuleDto,
  FailureMode,
  FinancialInvariants,
  FlowType,
  InjectionRule,
  SimulationResult,
} from './failure-injection.interface';

@Injectable()
export class PayoutRedemptionFailureInjectionService {
  private readonly logger = new Logger(PayoutRedemptionFailureInjectionService.name);
  private rules = new Map<string, InjectionRule>();

  // In-memory mock state for simulation and invariant verification
  private mockState = {
    totalCreditsIssued: 1_000_000n,
    claimedCredits: 200_000n,
    undistributedCredits: 800_000n,
    redemptionPoolBalance: 5_000_000n,
    tokenSupply: 10_000n,
    faceValue: 500n,
    holderBalances: new Map<string, bigint>([
      ['GAINVESTOR1', 4_000n],
      ['GAINVESTOR2', 6_000n],
    ]),
    processedIdempotencyKeys: new Map<string, { txHash: string; amount: bigint; timestamp: number }>(),
  };

  constructor(private readonly partialFailureService: PartialFailureService) {}

  /** Register an active failure injection rule */
  registerRule(dto: CreateInjectionRuleDto, operatorAddress: string): InjectionRule {
    if (!operatorAddress) {
      throw new BadRequestException('Operator attribution address is required');
    }
    if (!dto.description || dto.description.trim().length < 5) {
      throw new BadRequestException('Description must be at least 5 characters');
    }

    const rule: InjectionRule = {
      id: randomUUID(),
      flowType: dto.flowType,
      failureMode: dto.failureMode,
      bondId: dto.bondId,
      targetAddress: dto.targetAddress,
      remainingInjections: dto.count && dto.count > 0 ? dto.count : 1,
      isActive: true,
      createdAt: new Date().toISOString(),
      createdBy: operatorAddress,
      description: dto.description.trim(),
    };

    this.rules.set(rule.id, rule);
    this.logger.warn(
      `Registered failure injection rule [${rule.id}] for ${rule.flowType} (${rule.failureMode}) by ${operatorAddress}`,
    );
    return rule;
  }

  listRules(flowType?: FlowType): InjectionRule[] {
    const all = Array.from(this.rules.values());
    if (flowType) {
      return all.filter((r) => r.flowType === flowType);
    }
    return all;
  }

  removeRule(id: string): boolean {
    return this.rules.delete(id);
  }

  clearRules(): void {
    this.rules.clear();
  }

  /**
   * Find and consume an applicable injection rule for a given flow and target.
   */
  private matchAndConsumeRule(flowType: FlowType, bondId?: number, targetAddress?: string): InjectionRule | null {
    for (const rule of this.rules.values()) {
      if (!rule.isActive || rule.remainingInjections <= 0) continue;
      if (rule.flowType !== flowType) continue;
      if (rule.bondId !== undefined && bondId !== undefined && rule.bondId !== bondId) continue;
      if (rule.targetAddress && targetAddress && rule.targetAddress !== targetAddress) continue;

      rule.remainingInjections -= 1;
      if (rule.remainingInjections <= 0) {
        rule.isActive = false;
      }
      return rule;
    }
    return null;
  }

  /** Snapshot current protocol invariants */
  getFinancialInvariants(): FinancialInvariants {
    let heldSum = 0n;
    for (const b of this.mockState.holderBalances.values()) {
      heldSum += b;
    }

    const totalCredits = this.mockState.totalCreditsIssued;
    const partsSum = this.mockState.claimedCredits + this.mockState.undistributedCredits;
    const creditConserved = totalCredits === partsSum;

    const tokenConserved = this.mockState.tokenSupply === heldSum;
    const poolNonNegative = this.mockState.redemptionPoolBalance >= 0n;

    const isConserved = creditConserved && tokenConserved && poolNonNegative;

    return {
      totalCreditsIssued: totalCredits.toString(),
      claimedCredits: this.mockState.claimedCredits.toString(),
      undistributedCredits: this.mockState.undistributedCredits.toString(),
      redemptionPoolBalance: this.mockState.redemptionPoolBalance.toString(),
      tokenSupply: this.mockState.tokenSupply.toString(),
      heldBalancesSum: heldSum.toString(),
      isConserved,
      details: isConserved
        ? 'Invariants verified: credits conserved, supply conserved, pool balance valid'
        : `Invariant breach: creditConserved=${creditConserved}, tokenConserved=${tokenConserved}, poolNonNegative=${poolNonNegative}`,
    };
  }

  /**
   * Simulate a payout flow with end-to-end failure injection, retry, and invariant verification.
   */
  async simulatePayoutFlow(params: {
    bondId: number;
    amount: bigint;
    recipientAddress: string;
    callerRole: string;
    idempotencyKey: string;
    maxRetries?: number;
  }): Promise<SimulationResult> {
    const executionLog: string[] = [];
    const simulationId = randomUUID();
    const preInvariants = this.getFinancialInvariants();
    const maxRetries = params.maxRetries ?? 3;

    executionLog.push(`[${simulationId}] Starting payout simulation: bondId=${params.bondId}, amount=${params.amount}`);

    // Authorization check
    if (params.callerRole !== 'maintainer' && params.callerRole !== 'issuer') {
      executionLog.push(`[AUTH_REJECT] Caller with role ${params.callerRole} unauthorized for coupon payout`);
      throw new ForbiddenException(`Unauthorized caller role: ${params.callerRole}`);
    }

    // Check idempotency replay
    if (this.mockState.processedIdempotencyKeys.has(params.idempotencyKey)) {
      const cached = this.mockState.processedIdempotencyKeys.get(params.idempotencyKey)!;
      executionLog.push(`[IDEMPOTENT_REPLAY] Idempotency key ${params.idempotencyKey} already executed with tx ${cached.txHash}`);
      const postInvariants = this.getFinancialInvariants();
      return {
        simulationId,
        flowType: 'PAYOUT',
        failureMode: FailureMode.CONCURRENT_IDEMPOTENCY_REPLAY,
        injected: false,
        attempts: 1,
        recovered: true,
        recoveryMethod: 'IDEMPOTENT_CACHE_HIT',
        transactionHash: cached.txHash,
        preInvariants,
        postInvariants,
        invariantsPreserved: true,
        executionLog,
      };
    }

    // Match injection rule
    const rule = this.matchAndConsumeRule('PAYOUT', params.bondId, params.recipientAddress);
    let attempts = 0;
    let recovered = false;
    let recoveryMethod: string | undefined;
    let transactionHash: string | undefined;
    let partialFailureId: string | undefined;

    if (rule) {
      executionLog.push(`[INJECTION] Injecting failure mode: ${rule.failureMode}`);

      if (rule.failureMode === FailureMode.UNAUTHORIZED_CALLER) {
        executionLog.push('[FAILURE_SIMULATED] Injected authorization fault: recipient blocked under active screening');
        throw new ForbiddenException('Recipient blocked under active compliance rules');
      }

      if (rule.failureMode === FailureMode.PRE_COMMIT_NETWORK_RESET) {
        attempts++;
        executionLog.push(`[ATTEMPT 1] Injected PRE_COMMIT_NETWORK_RESET. Connection reset by peer before tx commit.`);
        // Retry logic:
        executionLog.push(`[RETRY 1] Retrying payout after pre-commit reset with backoff...`);
        attempts++;
        transactionHash = `tx_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
        this.applyPayoutSuccess(params.amount, params.idempotencyKey, transactionHash);
        recovered = true;
        recoveryMethod = 'EXPONENTIAL_BACKOFF_RETRY';
        executionLog.push(`[RECOVERED] Payout successfully committed on attempt 2: ${transactionHash}`);
      } else if (rule.failureMode === FailureMode.TRANSIENT_RPC_TIMEOUT) {
        attempts++;
        executionLog.push(`[ATTEMPT 1] Injected TRANSIENT_RPC_TIMEOUT. 504 Gateway Timeout on submission.`);
        
        // Log partial failure for maintainer investigation
        const pf = this.partialFailureService.record({
          operationType: 'payout.distribution',
          externalRef: `pending_${simulationId}`,
          message: 'RPC timeout during payout submission; status in-doubt',
          severity: 'warning',
          retryable: true,
          metadata: { bondId: params.bondId, recipient: params.recipientAddress, amount: params.amount.toString() },
        });
        partialFailureId = pf.id;
        executionLog.push(`[DASHBOARD_RECORDED] Registered partial failure record ${pf.id} for reconciliation`);

        // Reconciliation & query recovery
        executionLog.push(`[RECONCILE] Querying Soroban ledger state for in-doubt transaction status...`);
        const isTxApplied = false; // Simulate unapplied tx
        if (!isTxApplied && attempts < maxRetries) {
          executionLog.push(`[RETRY] Re-submitting payout with fresh nonce...`);
          attempts++;
          transactionHash = `tx_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
          this.applyPayoutSuccess(params.amount, params.idempotencyKey, transactionHash);
          this.partialFailureService.resolve(pf.id, 'Recovered via automated retry and ledger reconciliation');
          recovered = true;
          recoveryMethod = 'LEDGER_STATUS_POLL_AND_RETRY';
          executionLog.push(`[RECOVERED] Payout resolved and partial failure ${pf.id} closed with tx ${transactionHash}`);
        }
      } else if (rule.failureMode === FailureMode.CORRUPTED_NONCE) {
        attempts++;
        executionLog.push(`[ATTEMPT 1] Nonce sequence mismatch. InvalidNonce error.`);
        executionLog.push(`[RETRY] Fetching fresh sequence number and retrying...`);
        attempts++;
        transactionHash = `tx_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
        this.applyPayoutSuccess(params.amount, params.idempotencyKey, transactionHash);
        recovered = true;
        recoveryMethod = 'NONCE_RESYNC_RETRY';
        executionLog.push(`[RECOVERED] Payout succeeded with refreshed sequence: ${transactionHash}`);
      }
    } else {
      // Normal path
      attempts = 1;
      transactionHash = `tx_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      this.applyPayoutSuccess(params.amount, params.idempotencyKey, transactionHash);
      recovered = true;
      recoveryMethod = 'NORMAL_EXECUTION';
      executionLog.push(`[NORMAL_EXECUTION] Payout succeeded on first attempt: ${transactionHash}`);
    }

    const postInvariants = this.getFinancialInvariants();
    const invariantsPreserved = postInvariants.isConserved;

    return {
      simulationId,
      flowType: 'PAYOUT',
      failureMode: rule?.failureMode,
      injected: !!rule,
      attempts,
      recovered,
      recoveryMethod,
      transactionHash,
      partialFailureId,
      preInvariants,
      postInvariants,
      invariantsPreserved,
      executionLog,
    };
  }

  /**
   * Simulate a redemption flow with end-to-end failure injection, retry, and invariant verification.
   */
  async simulateRedemptionFlow(params: {
    bondId: number;
    amount: bigint;
    holderAddress: string;
    idempotencyKey: string;
  }): Promise<SimulationResult> {
    const executionLog: string[] = [];
    const simulationId = randomUUID();
    const preInvariants = this.getFinancialInvariants();

    executionLog.push(`[${simulationId}] Starting redemption simulation: bondId=${params.bondId}, tokens=${params.amount}`);

    const holderBalance = this.mockState.holderBalances.get(params.holderAddress) ?? 0n;
    if (params.amount > holderBalance) {
      executionLog.push(`[REJECT] Insufficient holder token balance: requested=${params.amount}, balance=${holderBalance}`);
      throw new BadRequestException('Insufficient token balance for redemption');
    }

    // Check idempotency replay
    if (this.mockState.processedIdempotencyKeys.has(params.idempotencyKey)) {
      const cached = this.mockState.processedIdempotencyKeys.get(params.idempotencyKey)!;
      executionLog.push(`[IDEMPOTENT_REPLAY] Idempotency key ${params.idempotencyKey} already executed with tx ${cached.txHash}`);
      const postInvariants = this.getFinancialInvariants();
      return {
        simulationId,
        flowType: 'REDEMPTION',
        failureMode: FailureMode.CONCURRENT_IDEMPOTENCY_REPLAY,
        injected: false,
        attempts: 1,
        recovered: true,
        recoveryMethod: 'IDEMPOTENT_CACHE_HIT',
        transactionHash: cached.txHash,
        preInvariants,
        postInvariants,
        invariantsPreserved: true,
        executionLog,
      };
    }

    const rule = this.matchAndConsumeRule('REDEMPTION', params.bondId, params.holderAddress);
    let attempts = 0;
    let recovered = false;
    let recoveryMethod: string | undefined;
    let transactionHash: string | undefined;
    let partialFailureId: string | undefined;

    const requiredPayout = params.amount * this.mockState.faceValue;

    if (rule) {
      executionLog.push(`[INJECTION] Injecting redemption failure mode: ${rule.failureMode}`);

      if (rule.failureMode === FailureMode.UNDERFUNDED_REDEMPTION_POOL) {
        attempts = 1;
        executionLog.push(
          `[FAILURE_SIMULATED] Redemption pool underfunded: required=${requiredPayout}, pool=${this.mockState.redemptionPoolBalance}`,
        );
        // Do NOT debit holder balance or mutate pool
        const pf = this.partialFailureService.record({
          operationType: 'redemption.settlement',
          externalRef: `redemption_underfunded_${simulationId}`,
          message: 'Redemption halted: pool liquid balance insufficient to cover principal payout',
          severity: 'critical',
          retryable: false,
          metadata: { bondId: params.bondId, holder: params.holderAddress, amount: params.amount.toString(), requiredPayout: requiredPayout.toString() },
        });
        partialFailureId = pf.id;
        recovered = false;
        recoveryMethod = 'REJECTED_ZERO_STATE_MUTATION';
        executionLog.push(`[SAFEGUARD] Financial invariant preserved: zero holder tokens debited, pool untouched.`);
      } else if (rule.failureMode === FailureMode.TRANSIENT_RPC_TIMEOUT) {
        attempts++;
        executionLog.push(`[ATTEMPT 1] Injected TRANSIENT_RPC_TIMEOUT during redemption.`);
        const pf = this.partialFailureService.record({
          operationType: 'redemption.settlement',
          externalRef: `pending_redemption_${simulationId}`,
          message: 'RPC timeout during redemption submission',
          severity: 'warning',
          retryable: true,
          metadata: { bondId: params.bondId, holder: params.holderAddress },
        });
        partialFailureId = pf.id;

        // Retry and reconciliation
        attempts++;
        executionLog.push(`[RETRY 1] Retrying redemption with ledger reconciliation...`);
        transactionHash = `tx_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
        this.applyRedemptionSuccess(params.holderAddress, params.amount, requiredPayout, params.idempotencyKey, transactionHash);
        this.partialFailureService.resolve(pf.id, 'Resolved via automated retry');
        recovered = true;
        recoveryMethod = 'LEDGER_STATUS_POLL_AND_RETRY';
        executionLog.push(`[RECOVERED] Redemption successfully executed on retry: ${transactionHash}`);
      } else if (rule.failureMode === FailureMode.UNAUTHORIZED_CALLER) {
        executionLog.push(`[FAILURE_SIMULATED] Holder address not permitted to redeem.`);
        throw new ForbiddenException('Holder unauthorized for redemption');
      }
    } else {
      // Normal path
      attempts = 1;
      transactionHash = `tx_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      this.applyRedemptionSuccess(params.holderAddress, params.amount, requiredPayout, params.idempotencyKey, transactionHash);
      recovered = true;
      recoveryMethod = 'NORMAL_EXECUTION';
      executionLog.push(`[NORMAL_EXECUTION] Redemption successfully completed: ${transactionHash}`);
    }

    const postInvariants = this.getFinancialInvariants();
    const invariantsPreserved = postInvariants.isConserved;

    return {
      simulationId,
      flowType: 'REDEMPTION',
      failureMode: rule?.failureMode,
      injected: !!rule,
      attempts,
      recovered,
      recoveryMethod,
      transactionHash,
      partialFailureId,
      preInvariants,
      postInvariants,
      invariantsPreserved,
      executionLog,
    };
  }

  private applyPayoutSuccess(amount: bigint, idempotencyKey: string, txHash: string): void {
    if (this.mockState.undistributedCredits >= amount) {
      this.mockState.undistributedCredits -= amount;
      this.mockState.claimedCredits += amount;
    }
    this.mockState.processedIdempotencyKeys.set(idempotencyKey, {
      txHash,
      amount,
      timestamp: Date.now(),
    });
  }

  private applyRedemptionSuccess(
    holder: string,
    tokens: bigint,
    payout: bigint,
    idempotencyKey: string,
    txHash: string,
  ): void {
    const curBalance = this.mockState.holderBalances.get(holder) ?? 0n;
    this.mockState.holderBalances.set(holder, curBalance - tokens);
    this.mockState.tokenSupply -= tokens;
    this.mockState.redemptionPoolBalance -= payout;

    this.mockState.processedIdempotencyKeys.set(idempotencyKey, {
      txHash,
      amount: tokens,
      timestamp: Date.now(),
    });
  }

  /** Reset mock state to default for clean testing */
  resetMockState(): void {
    this.mockState = {
      totalCreditsIssued: 1_000_000n,
      claimedCredits: 200_000n,
      undistributedCredits: 800_000n,
      redemptionPoolBalance: 5_000_000n,
      tokenSupply: 10_000n,
      faceValue: 500n,
      holderBalances: new Map<string, bigint>([
        ['GAINVESTOR1', 4_000n],
        ['GAINVESTOR2', 6_000n],
      ]),
      processedIdempotencyKeys: new Map(),
    };
    this.rules.clear();
  }
}
