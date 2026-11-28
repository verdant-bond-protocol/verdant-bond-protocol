import {
  GatewayTimeoutException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { scValToNative, xdr } from '@stellar/stellar-sdk';
import { ContractCallOptions, ContractCallResult, ContractService } from '../stellar/contract.service';
import { ContractException, StableErrorCode, stableContractMessage } from '../stellar/contract-errors';
import { PayoutRedemptionFailureInjectionService } from './payout-redemption-failure-injection.service';
import { PartialFailureService } from './partial-failure.service';
import { FailureMode, FlowType, InjectionRule } from './failure-injection.interface';

/** Contract methods that move coupon credits (payouts) or principal (redemptions). */
export const FLOW_BY_METHOD: Record<string, FlowType> = {
  distribute_coupon: 'PAYOUT',
  distribute_coupon_batch: 'PAYOUT',
  claim_credits: 'PAYOUT',
  redeem: 'REDEMPTION',
};

/** Raw BondError discriminants the injector emits (shared by BondIssuer and CouponEngine). */
const BOND_ERROR = { Unauthorized: 2, InvalidNonce: 3, RedemptionUnderfunded: 13 } as const;

export function failureInjectionAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FAILURE_INJECTION_ENABLED === 'true' && env.NODE_ENV !== 'production';
}

/** Best-effort decode of `(address, bond_id, …)` call arguments for rule matching. */
function callTarget(args: xdr.ScVal[]): { address?: string; bondId?: number } {
  const decode = (v: xdr.ScVal | undefined): unknown => {
    try {
      return v ? scValToNative(v) : undefined;
    } catch {
      return undefined;
    }
  };
  const address = decode(args[0]);
  const bondId = decode(args[1]);
  return {
    address: typeof address === 'string' ? address : undefined,
    bondId: typeof bondId === 'bigint' || typeof bondId === 'number' ? Number(bondId) : undefined,
  };
}

/**
 * End-to-end failure injection for payouts and redemptions (#644).
 *
 * Wraps `ContractService.sendTransaction` — the single choke point every
 * state-changing contract call passes through — so a fault surfaces through
 * the *real* NonceService, BondsService error mapping and RFC 7807 filter,
 * exactly as a production fault would. Each mode reproduces a real failure
 * with its real on-chain consequence:
 *
 * | Mode                         | Sent?  | Ledger applied? | Surfaces as                    |
 * |------------------------------|--------|-----------------|--------------------------------|
 * | PRE_COMMIT_NETWORK_RESET     | no     | no              | 503 (safe to retry)            |
 * | TRANSIENT_RPC_TIMEOUT        | yes    | **yes**         | 504 in-doubt (reconcile first) |
 * | CORRUPTED_NONCE              | no     | no              | BOND_INVALID_NONCE (resync)    |
 * | UNAUTHORIZED_CALLER          | no     | no              | BOND_UNAUTHORIZED              |
 * | UNDERFUNDED_REDEMPTION_POOL  | no     | no              | BOND_REDEMPTION_UNDERFUNDED    |
 * | CONCURRENT_IDEMPOTENCY_REPLAY| yes    | yes             | passthrough (API-level mode)   |
 *
 * Never active in production: `attach` refuses unless
 * `FAILURE_INJECTION_ENABLED=true` and `NODE_ENV !== 'production'`.
 */
export class ContractFaultInjector {
  private readonly logger = new Logger(ContractFaultInjector.name);

  constructor(
    private readonly rules: PayoutRedemptionFailureInjectionService,
    private readonly partialFailures?: PartialFailureService,
  ) {}

  /**
   * Patches `contract.sendTransaction` in place and returns a detach function
   * that restores the original. Idempotent per instance.
   */
  attach(contract: ContractService, env: NodeJS.ProcessEnv = process.env): () => void {
    if (!failureInjectionAllowed(env)) {
      throw new Error('Contract fault injection requires FAILURE_INJECTION_ENABLED=true outside production');
    }
    const target = contract as ContractService & { __faultInjectorAttached?: boolean };
    if (target.__faultInjectorAttached) {
      return () => undefined;
    }
    const original = contract.sendTransaction.bind(contract);
    target.sendTransaction = (options: ContractCallOptions) => this.intercept(options, original);
    target.__faultInjectorAttached = true;
    this.logger.warn('Contract fault injection ATTACHED to ContractService.sendTransaction');
    return () => {
      target.sendTransaction = original;
      target.__faultInjectorAttached = false;
      this.logger.warn('Contract fault injection detached');
    };
  }

  async intercept(
    options: ContractCallOptions,
    send: (options: ContractCallOptions) => Promise<ContractCallResult>,
  ): Promise<ContractCallResult> {
    const flow = FLOW_BY_METHOD[options.method];
    if (!flow) return send(options);

    const { address, bondId } = callTarget(options.args);
    const rule = this.rules.consumeRule(flow, bondId, address);
    if (!rule) return send(options);

    this.logger.warn(`Injecting ${rule.failureMode} into ${options.method} (rule ${rule.id})`);
    const contractError = (code: StableErrorCode, raw: number) =>
      new ContractException(code, stableContractMessage(code) ?? code, options.contractAddress, options.method, raw);

    switch (rule.failureMode) {
      case FailureMode.PRE_COMMIT_NETWORK_RESET:
        throw new ServiceUnavailableException(
          `Injected fault (rule ${rule.id}): connection reset before ${options.method} was submitted`,
        );
      case FailureMode.CORRUPTED_NONCE:
        throw contractError(StableErrorCode.BOND_INVALID_NONCE, BOND_ERROR.InvalidNonce);
      case FailureMode.UNAUTHORIZED_CALLER:
        throw contractError(StableErrorCode.BOND_UNAUTHORIZED, BOND_ERROR.Unauthorized);
      case FailureMode.UNDERFUNDED_REDEMPTION_POOL:
        throw contractError(StableErrorCode.BOND_REDEMPTION_UNDERFUNDED, BOND_ERROR.RedemptionUnderfunded);
      case FailureMode.TRANSIENT_RPC_TIMEOUT: {
        // The worst real case: the ledger applies the transaction but the
        // client never learns the outcome.
        const result = await send(options);
        this.recordInDoubt(rule, flow, options, result, bondId, address);
        throw new GatewayTimeoutException(
          `Injected fault (rule ${rule.id}): timed out waiting for ${options.method} transaction ${result.transactionHash ?? ''}`,
        );
      }
      default:
        return send(options);
    }
  }

  private recordInDoubt(
    rule: InjectionRule,
    flow: FlowType,
    options: ContractCallOptions,
    result: ContractCallResult,
    bondId?: number,
    address?: string,
  ): void {
    this.partialFailures?.record({
      operationType: flow === 'PAYOUT' ? 'payout.distribution' : 'redemption.settlement',
      externalRef: result.transactionHash ?? `in_doubt_${rule.id}`,
      message: `In-doubt ${options.method}: submitted, outcome not observed (injected by rule ${rule.id})`,
      severity: 'warning',
      // Retrying blindly could double-apply; recovery is reconcile-then-retry.
      retryable: false,
      metadata: { method: options.method, bondId, address, transactionHash: result.transactionHash, ruleId: rule.id },
    });
  }
}

/**
 * Attaches the injector at boot when explicitly enabled (staging / chaos
 * runs). In every other environment this is a no-op.
 */
@Injectable()
export class ContractFaultInjectionBootstrap implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ContractFaultInjectionBootstrap.name);
  private detach?: () => void;

  constructor(
    private readonly rules: PayoutRedemptionFailureInjectionService,
    private readonly partialFailures: PartialFailureService,
    @Optional() private readonly contract?: ContractService,
  ) {}

  onModuleInit(): void {
    if (!failureInjectionAllowed() || !this.contract) return;
    this.detach = new ContractFaultInjector(this.rules, this.partialFailures).attach(this.contract);
    this.logger.warn('FAILURE_INJECTION_ENABLED=true: payout/redemption contract calls honour injection rules');
  }

  onModuleDestroy(): void {
    this.detach?.();
  }
}
