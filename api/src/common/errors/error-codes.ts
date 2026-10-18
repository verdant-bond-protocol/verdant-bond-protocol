export enum ErrorCode {
  // ── Generic ──────────────────────────────────────────────────────────────
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',
  SETTLEMENT_FAILED = 'SETTLEMENT_FAILED',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
  QUEUE_BACKPRESSURE = 'QUEUE_BACKPRESSURE',
  INTERNAL_ERROR = 'INTERNAL_ERROR',

  // ── Bond lifecycle ────────────────────────────────────────────────────────
  BOND_NOT_ACTIVE = 'BOND_NOT_ACTIVE',
  BOND_MATURED = 'BOND_MATURED',
  DUPLICATE_SUBSCRIPTION = 'DUPLICATE_SUBSCRIPTION',
  COUPON_ALREADY_CLAIMED = 'COUPON_ALREADY_CLAIMED',

  // ── Ownership transfer ────────────────────────────────────────────────────
  OWNERSHIP_TRANSFER_PENDING = 'OWNERSHIP_TRANSFER_PENDING',
  OWNERSHIP_TRANSFER_EXPIRED = 'OWNERSHIP_TRANSFER_EXPIRED',
}

export interface ErrorMetadata {
  code: ErrorCode;
  retryable: boolean;
  safeMessage: string;
  /**
   * Short, operator-facing hint for the support runbook.  Never shown to
   * end-users.  Describes the canonical remediation action for this error
   * class so on-call engineers don't need to grep the codebase.
   */
  remediationHint: string;
}

export const ErrorTaxonomy: Record<ErrorCode, Omit<ErrorMetadata, 'code'>> = {
  // ── Generic ───────────────────────────────────────────────────────────────
  [ErrorCode.VALIDATION_FAILED]: {
    retryable: false,
    safeMessage: 'The provided data is invalid. Please check your input and try again.',
    remediationHint: 'Inspect the details field for the failing field path and constraint. No state mutation occurred.',
  },
  [ErrorCode.UNAUTHORIZED]: {
    retryable: false,
    safeMessage: 'Authentication is required. Please log in.',
    remediationHint: 'Verify the bearer token is present and not expired. Re-issue if rotated.',
  },
  [ErrorCode.FORBIDDEN]: {
    retryable: false,
    safeMessage: 'You do not have permission to perform this action.',
    remediationHint: 'Check role assignments in the auth service. Escalate to account admin if entitlement is correct.',
  },
  [ErrorCode.NOT_FOUND]: {
    retryable: false,
    safeMessage: 'The requested resource could not be found.',
    remediationHint: 'Confirm the resource ID exists and is not soft-deleted. Check the correlation ID in Grafana.',
  },
  [ErrorCode.INSUFFICIENT_BALANCE]: {
    retryable: false,
    safeMessage: 'Insufficient balance to complete the operation. Please add funds and try again.',
    remediationHint: 'No funds were moved. User must top-up before retrying. Verify on-chain balance via Horizon.',
  },
  [ErrorCode.SETTLEMENT_FAILED]: {
    retryable: true,
    safeMessage: 'The settlement transaction failed on the network. You can safely retry.',
    remediationHint: 'Check Horizon for tx_bad_seq or fee_bump failures. Idempotency key prevents double-settlement on retry.',
  },
  [ErrorCode.RATE_LIMIT_EXCEEDED]: {
    retryable: true,
    safeMessage: 'Too many requests. Please wait a moment and try again.',
    remediationHint: 'Retry after the Retry-After header interval. Sustained breach → review client call cadence.',
  },
  [ErrorCode.QUOTA_EXCEEDED]: {
    retryable: false,
    safeMessage: 'You have exceeded your usage quota for this operation.',
    remediationHint: 'Quota is per-billing-period. Upgrade plan or wait for quota reset. No state mutation occurred.',
  },
  [ErrorCode.QUEUE_BACKPRESSURE]: {
    retryable: true,
    safeMessage: 'The system is busy processing earlier requests of this kind. Please try again shortly.',
    remediationHint: 'Background queue admission bound hit (#391). Check GET /api/v1/jobs/queue/status for the saturated scope; see docs/queue-backpressure.md.',
  },
  [ErrorCode.INTERNAL_ERROR]: {
    retryable: false,
    safeMessage: 'An unexpected error occurred. Please contact support with your correlation ID.',
    remediationHint: 'Search Grafana/Sentry by correlation ID. If recurring, file an incident and check DB/RPC health.',
  },

  // ── Bond lifecycle ─────────────────────────────────────────────────────────
  [ErrorCode.BOND_NOT_ACTIVE]: {
    retryable: false,
    safeMessage: 'This bond is not currently active.',
    remediationHint: 'Verify bond status via GET /bonds/:id. Subscriptions and transfers are only permitted in Active state.',
  },
  [ErrorCode.BOND_MATURED]: {
    retryable: false,
    safeMessage: 'This bond has already matured. No further subscriptions or transfers are accepted.',
    remediationHint: 'Bond lifecycle is terminal at Matured. Direct user to redeem outstanding balance via POST /bonds/:id/redeem.',
  },
  [ErrorCode.DUPLICATE_SUBSCRIPTION]: {
    retryable: false,
    safeMessage: 'A subscription for this bond is already in progress.',
    remediationHint: 'Idempotency key collision or double-click. Check the existing subscription status before creating a new one.',
  },
  [ErrorCode.COUPON_ALREADY_CLAIMED]: {
    retryable: false,
    safeMessage: 'This coupon period has already been claimed.',
    remediationHint: 'The coupon cycle ledger shows the claim timestamp. No action needed — this is an idempotent duplicate.',
  },

  // ── Ownership transfer ──────────────────────────────────────────────────────
  [ErrorCode.OWNERSHIP_TRANSFER_PENDING]: {
    retryable: false,
    safeMessage: 'An ownership transfer is already pending for this contract. Cancel or complete it before initiating a new one.',
    remediationHint: 'Call propose_admin with the pending candidate address to replace, or cancel_admin_proposal to clear it.',
  },
  [ErrorCode.OWNERSHIP_TRANSFER_EXPIRED]: {
    retryable: false,
    safeMessage: 'The ownership transfer proposal has expired. Please initiate a new transfer.',
    remediationHint: 'The acceptance window (TTL ledgers) elapsed. Issue a fresh propose_admin call to restart the process.',
  },
};

export class DomainException extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly details?: any,
  ) {
    super(ErrorTaxonomy[code].safeMessage);
  }

  get remediationHint(): string {
    return ErrorTaxonomy[this.code].remediationHint;
  }

  get retryable(): boolean {
    return ErrorTaxonomy[this.code].retryable;
  }
}
