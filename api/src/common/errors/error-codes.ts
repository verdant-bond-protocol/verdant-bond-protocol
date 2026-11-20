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
  STEP_UP_REQUIRED = 'STEP_UP_REQUIRED',
  RISK_REVIEW_REQUIRED = 'RISK_REVIEW_REQUIRED',
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
  /** Stable, user-safe description. Never contains internal details. */
  safeMessage: string;
  /**
   * Short, operator-facing hint for the support runbook. Never shown to
   * end-users. Describes the canonical remediation action for this error
   * class so on-call engineers don't need to grep the codebase.
   */
  remediationHint: string;
  /**
   * Actionable, client-safe next step exposed on the problem-details response
   * as `remediation` (#376). Unlike `remediationHint`, this is safe to render
   * to an end-user or SDK and contains no internal tooling or identifiers.
   */
  remediation: string;
}

/**
 * The problem-details contract for the public API (#376).
 *
 * Every machine-readable `code` returned in an RFC 7807 response MUST have an
 * entry here. The client-safe `remediation` field is exposed to clients so a
 * caller can present a next step instead of a dead end; `remediationHint` is
 * the operator-facing counterpart and is never surfaced to end-users. This
 * object is guarded by `error-codes.spec.ts` and `error-codes.contract.spec.ts`;
 * adding/removing/renaming a code or changing its retryability is a deliberate,
 * reviewable change.
 */
export const ErrorTaxonomy: Record<ErrorCode, Omit<ErrorMetadata, 'code'>> = {
  // ── Generic ───────────────────────────────────────────────────────────────
  [ErrorCode.VALIDATION_FAILED]: {
    retryable: false,
    safeMessage: 'The provided data is invalid. Please check your input and try again.',
    remediationHint: 'Inspect the details field for the failing field path and constraint. No state mutation occurred.',
    remediation: 'Correct the flagged fields and resubmit. See `errors[].field` for the exact input.',
  },
  [ErrorCode.UNAUTHORIZED]: {
    retryable: false,
    safeMessage: 'Authentication is required. Please log in.',
    remediationHint: 'Verify the bearer token is present and not expired. Re-issue if rotated.',
    remediation: 'Obtain a fresh access token and retry with an `Authorization: Bearer <token>` header.',
  },
  [ErrorCode.FORBIDDEN]: {
    retryable: false,
    safeMessage: 'You do not have permission to perform this action.',
    remediationHint: 'Check role assignments in the auth service. Escalate to account admin if entitlement is correct.',
    remediation: 'Request the required role/permission, or complete KYC if the action is eligibility-gated.',
  },
  [ErrorCode.NOT_FOUND]: {
    retryable: false,
    safeMessage: 'The requested resource could not be found.',
    remediationHint: 'Confirm the resource ID exists and is not soft-deleted. Check the correlation ID in Grafana.',
    remediation: 'Verify the identifier and that the resource was not archived or deleted.',
  },
  [ErrorCode.INSUFFICIENT_BALANCE]: {
    retryable: false,
    safeMessage: 'Insufficient balance to complete the operation. Please add funds and try again.',
    remediationHint: 'No funds were moved. User must top-up before retrying. Verify on-chain balance via Horizon.',
    remediation: 'Fund the wallet/escrow account for the required asset, then retry the operation.',
  },
  [ErrorCode.SETTLEMENT_FAILED]: {
    retryable: true,
    safeMessage: 'The settlement transaction failed on the network. You can safely retry.',
    remediationHint: 'Check Horizon for tx_bad_seq or fee_bump failures. Idempotency key prevents double-settlement on retry.',
    remediation: 'Retry with an idempotency key. If it persists, inspect `contract.rawErrorCode` and the settlement runbook.',
  },
  [ErrorCode.RATE_LIMIT_EXCEEDED]: {
    retryable: true,
    safeMessage: 'Too many requests. Please wait a moment and try again.',
    remediationHint: 'Retry after the Retry-After header interval. Sustained breach → review client call cadence.',
    remediation: 'Back off using the `Retry-After` header, then retry.',
  },
  [ErrorCode.QUOTA_EXCEEDED]: {
    retryable: false,
    safeMessage: 'You have exceeded your usage quota for this operation.',
    remediationHint: 'Quota is per-billing-period. Upgrade plan or wait for quota reset. No state mutation occurred.',
    remediation: 'Wait for the quota window to reset, or request a quota increase from an administrator.',
  },
  [ErrorCode.STEP_UP_REQUIRED]: {
    retryable: true,
    safeMessage: 'Additional verification is required before this operation can proceed.',
    remediationHint: 'Operation is deferred pending step-up verification; safe to retry once a fresh token is presented.',
    remediation: 'Complete step-up verification, then resubmit with the `x-risk-step-up-token` header.',
  },
  [ErrorCode.RISK_REVIEW_REQUIRED]: {
    retryable: false,
    safeMessage: 'This operation was flagged for review and will not be executed automatically.',
    remediationHint: 'Operation flagged by risk scoring; route to trust & safety. Do not auto-execute.',
    remediation: 'Contact support/trust & safety with the correlation ID to have the review resolved.',
  },
  [ErrorCode.QUEUE_BACKPRESSURE]: {
    retryable: true,
    safeMessage: 'The system is busy processing earlier requests of this kind. Please try again shortly.',
    remediationHint: 'Background queue admission bound hit (#391). Check GET /api/v1/jobs/queue/status for the saturated scope; see docs/queue-backpressure.md.',
    remediation: 'Retry shortly once the queue drains; poll `GET /api/v1/jobs/queue/status` to see when the saturated scope clears.',
  },
  [ErrorCode.INTERNAL_ERROR]: {
    retryable: false,
    safeMessage: 'An unexpected error occurred. Please contact support with your correlation ID.',
    remediationHint: 'Search Grafana/Sentry by correlation ID. If recurring, file an incident and check DB/RPC health.',
    remediation: 'Retry once; if it persists, contact support with the `correlationId` from this response.',
  },

  // ── Bond lifecycle ─────────────────────────────────────────────────────────
  [ErrorCode.BOND_NOT_ACTIVE]: {
    retryable: false,
    safeMessage: 'This bond is not currently active.',
    remediationHint: 'Verify bond status via GET /bonds/:id. Subscriptions and transfers are only permitted in Active state.',
    remediation: 'Check the bond status; subscribe or transfer only while the bond is Active.',
  },
  [ErrorCode.BOND_MATURED]: {
    retryable: false,
    safeMessage: 'This bond has already matured. No further subscriptions or transfers are accepted.',
    remediationHint: 'Bond lifecycle is terminal at Matured. Direct user to redeem outstanding balance via POST /bonds/:id/redeem.',
    remediation: 'Redeem any outstanding balance; no further subscriptions or transfers are accepted.',
  },
  [ErrorCode.DUPLICATE_SUBSCRIPTION]: {
    retryable: false,
    safeMessage: 'A subscription for this bond is already in progress.',
    remediationHint: 'Idempotency key collision or double-click. Check the existing subscription status before creating a new one.',
    remediation: 'Wait for the existing subscription to finish; avoid resubmitting the same request.',
  },
  [ErrorCode.COUPON_ALREADY_CLAIMED]: {
    retryable: false,
    safeMessage: 'This coupon period has already been claimed.',
    remediationHint: 'The coupon cycle ledger shows the claim timestamp. No action needed — this is an idempotent duplicate.',
    remediation: 'This coupon was already claimed; no further action is needed.',
  },

  // ── Ownership transfer ──────────────────────────────────────────────────────
  [ErrorCode.OWNERSHIP_TRANSFER_PENDING]: {
    retryable: false,
    safeMessage: 'An ownership transfer is already pending for this contract. Cancel or complete it before initiating a new one.',
    remediationHint: 'Call propose_admin with the pending candidate address to replace, or cancel_admin_proposal to clear it.',
    remediation: 'Cancel or complete the pending ownership transfer before starting a new one.',
  },
  [ErrorCode.OWNERSHIP_TRANSFER_EXPIRED]: {
    retryable: false,
    safeMessage: 'The ownership transfer proposal has expired. Please initiate a new transfer.',
    remediationHint: 'The acceptance window (TTL ledgers) elapsed. Issue a fresh propose_admin call to restart the process.',
    remediation: 'Initiate a new ownership transfer; the previous proposal has expired.',
  },
};

/** Base URI for RFC 7807 `type` links. Kept stable for client matching. */
export const PROBLEM_TYPE_BASE = 'https://errors.verdant-bond-protocol.org';

/** Stable, machine-followable type URI for a code. */
export function problemTypeUri(code: ErrorCode): string {
  return `${PROBLEM_TYPE_BASE}/${code}`;
}

/** Client-safe remediation hint for a code, defaulting to the internal-error hint. */
export function remediationFor(code: ErrorCode): string {
  return ErrorTaxonomy[code]?.remediation ?? ErrorTaxonomy[ErrorCode.INTERNAL_ERROR].remediation;
}

export class DomainException extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly details?: any,
  ) {
    super(ErrorTaxonomy[code].safeMessage);
  }

  get remediation(): string {
    return ErrorTaxonomy[this.code].remediation;
  }

  get remediationHint(): string {
    return ErrorTaxonomy[this.code].remediationHint;
  }

  get retryable(): boolean {
    return ErrorTaxonomy[this.code].retryable;
  }
}
