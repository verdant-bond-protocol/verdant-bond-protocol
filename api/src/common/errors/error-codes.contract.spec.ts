import { ErrorCode, ErrorTaxonomy, problemTypeUri, remediationFor, PROBLEM_TYPE_BASE } from './error-codes';

/**
 * Contract drift guard for the public problem-details taxonomy (#376).
 *
 * These assertions fail if a code is added/removed/renamed, if retryability or
 * a safe message changes, or if a remediation hint goes missing — forcing the
 * change to be an explicit, reviewed edit of this file (and the docs).
 */
describe('Error taxonomy contract (#376)', () => {
  /**
   * Frozen snapshot of the machine codes clients are allowed to depend on.
   * Adding a code here is a public-contract change: update
   * docs/api-problem-details-taxonomy.md in the same commit.
   */
  const FROZEN_CODES = [
    'VALIDATION_FAILED',
    'UNAUTHORIZED',
    'FORBIDDEN',
    'NOT_FOUND',
    'INSUFFICIENT_BALANCE',
    'SETTLEMENT_FAILED',
    'RATE_LIMIT_EXCEEDED',
    'QUOTA_EXCEEDED',
    'QUEUE_BACKPRESSURE',
    'STEP_UP_REQUIRED',
    'RISK_REVIEW_REQUIRED',
    'INTERNAL_ERROR',
    'BOND_NOT_ACTIVE',
    'BOND_MATURED',
    'DUPLICATE_SUBSCRIPTION',
    'COUPON_ALREADY_CLAIMED',
    'OWNERSHIP_TRANSFER_PENDING',
    'OWNERSHIP_TRANSFER_EXPIRED',
    'PRICE_IMPACT_EXCEEDED',
    'RECEIPT_PENDING',
  ];

  /** Frozen retryability map — clients use this to decide whether to retry. */
  const FROZEN_RETRYABLE: Record<string, boolean> = {
    VALIDATION_FAILED: false,
    UNAUTHORIZED: false,
    FORBIDDEN: false,
    NOT_FOUND: false,
    INSUFFICIENT_BALANCE: false,
    SETTLEMENT_FAILED: true,
    RATE_LIMIT_EXCEEDED: true,
    QUOTA_EXCEEDED: false,
    QUEUE_BACKPRESSURE: true,
    STEP_UP_REQUIRED: true,
    RISK_REVIEW_REQUIRED: false,
    INTERNAL_ERROR: false,
    BOND_NOT_ACTIVE: false,
    BOND_MATURED: false,
    DUPLICATE_SUBSCRIPTION: false,
    COUPON_ALREADY_CLAIMED: false,
    OWNERSHIP_TRANSFER_PENDING: false,
    OWNERSHIP_TRANSFER_EXPIRED: false,
    PRICE_IMPACT_EXCEEDED: false,
    RECEIPT_PENDING: true,
  };

  /**
   * Exact public copy is frozen as well. Previously only code names and
   * retryability were pinned, so a wording change could reach clients without
   * any contract test failing. Update this map and the docs together.
   */
  const FROZEN_COPY: Record<string, { safeMessage: string; remediation: string; remediationHint: string }> = {
    VALIDATION_FAILED: {
      safeMessage: 'The provided data is invalid. Please check your input and try again.',
      remediation: 'Correct the flagged fields and resubmit. See `errors[].field` for the exact input.',
      remediationHint: 'Inspect the details field for the failing field path and constraint. No state mutation occurred.',
    },
    UNAUTHORIZED: {
      safeMessage: 'Authentication is required. Please log in.',
      remediation: 'Obtain a fresh access token and retry with an `Authorization: Bearer <token>` header.',
      remediationHint: 'Verify the bearer token is present and not expired. Re-issue if rotated.',
    },
    FORBIDDEN: {
      safeMessage: 'You do not have permission to perform this action.',
      remediation: 'Request the required role/permission, or complete KYC if the action is eligibility-gated.',
      remediationHint: 'Check role assignments in the auth service. Escalate to account admin if entitlement is correct.',
    },
    NOT_FOUND: {
      safeMessage: 'The requested resource could not be found.',
      remediation: 'Verify the identifier and that the resource was not archived or deleted.',
      remediationHint: 'Confirm the resource ID exists and is not soft-deleted. Check the correlation ID in Grafana.',
    },
    INSUFFICIENT_BALANCE: {
      safeMessage: 'Insufficient balance to complete the operation. Please add funds and try again.',
      remediation: 'Fund the wallet/escrow account for the required asset, then retry the operation.',
      remediationHint: 'No funds were moved. User must top-up before retrying. Verify on-chain balance via Horizon.',
    },
    SETTLEMENT_FAILED: {
      safeMessage: 'The settlement transaction failed on the network. You can safely retry.',
      remediation: 'Retry with an idempotency key. If it persists, inspect `contract.rawErrorCode` and the settlement runbook.',
      remediationHint: 'Check Horizon for tx_bad_seq or fee_bump failures. Idempotency key prevents double-settlement on retry.',
    },
    RATE_LIMIT_EXCEEDED: {
      safeMessage: 'Too many requests. Please wait a moment and try again.',
      remediation: 'Back off using the `Retry-After` header, then retry.',
      remediationHint: 'Retry after the Retry-After header interval. Sustained breach → review client call cadence.',
    },
    QUOTA_EXCEEDED: {
      safeMessage: 'You have exceeded your usage quota for this operation.',
      remediation: 'Wait for the quota window to reset, or request a quota increase from an administrator.',
      remediationHint: 'Quota is per-billing-period. Upgrade plan or wait for quota reset. No state mutation occurred.',
    },
    STEP_UP_REQUIRED: {
      safeMessage: 'Additional verification is required before this operation can proceed.',
      remediation: 'Complete step-up verification, then resubmit with the `x-risk-step-up-token` header.',
      remediationHint: 'Operation is deferred pending step-up verification; safe to retry once a fresh token is presented.',
    },
    RISK_REVIEW_REQUIRED: {
      safeMessage: 'This operation was flagged for review and will not be executed automatically.',
      remediation: 'Contact support/trust & safety with the correlation ID to have the review resolved.',
      remediationHint: 'Operation flagged by risk scoring; route to trust & safety. Do not auto-execute.',
    },
    QUEUE_BACKPRESSURE: {
      safeMessage: 'The system is busy processing earlier requests of this kind. Please try again shortly.',
      remediation: 'Retry shortly once the queue drains; poll `GET /api/v1/jobs/queue/status` to see when the saturated scope clears.',
      remediationHint: 'Background queue admission bound hit (#391). Check GET /api/v1/jobs/queue/status for the saturated scope; see docs/queue-backpressure.md.',
    },
    INTERNAL_ERROR: {
      safeMessage: 'An unexpected error occurred. Please contact support with your correlation ID.',
      remediation: 'Retry once; if it persists, contact support with the `correlationId` from this response.',
      remediationHint: 'Search Grafana/Sentry by correlation ID. If recurring, file an incident and check DB/RPC health.',
    },
    BOND_NOT_ACTIVE: {
      safeMessage: 'This bond is not currently active.',
      remediation: 'Check the bond status; subscribe or transfer only while the bond is Active.',
      remediationHint: 'Verify bond status via GET /bonds/:id. Subscriptions and transfers are only permitted in Active state.',
    },
    BOND_MATURED: {
      safeMessage: 'This bond has already matured. No further subscriptions or transfers are accepted.',
      remediation: 'Redeem any outstanding balance; no further subscriptions or transfers are accepted.',
      remediationHint: 'Bond lifecycle is terminal at Matured. Direct user to redeem outstanding balance via POST /bonds/:id/redeem.',
    },
    DUPLICATE_SUBSCRIPTION: {
      safeMessage: 'A subscription for this bond is already in progress.',
      remediation: 'Wait for the existing subscription to finish; avoid resubmitting the same request.',
      remediationHint: 'Idempotency key collision or double-click. Check the existing subscription status before creating a new one.',
    },
    COUPON_ALREADY_CLAIMED: {
      safeMessage: 'This coupon period has already been claimed.',
      remediation: 'This coupon was already claimed; no further action is needed.',
      remediationHint: 'The coupon cycle ledger shows the claim timestamp. No action needed — this is an idempotent duplicate.',
    },
    OWNERSHIP_TRANSFER_PENDING: {
      safeMessage: 'An ownership transfer is already pending for this contract. Cancel or complete it before initiating a new one.',
      remediation: 'Cancel or complete the pending ownership transfer before starting a new one.',
      remediationHint: 'Call propose_admin with the pending candidate address to replace, or cancel_admin_proposal to clear it.',
    },
    OWNERSHIP_TRANSFER_EXPIRED: {
      safeMessage: 'The ownership transfer proposal has expired. Please initiate a new transfer.',
      remediation: 'Initiate a new ownership transfer; the previous proposal has expired.',
      remediationHint: 'The acceptance window (TTL ledgers) elapsed. Issue a fresh propose_admin call to restart the process.',
    },
    PRICE_IMPACT_EXCEEDED: {
      safeMessage: 'This trade exceeds the price-impact or slippage limit for this market.',
      remediation: 'Reduce the amount to `context.suggestedMaxAmount`, choose the best-priced order (`context.bestOrderId`), or raise your own `maxPriceImpactBps`.',
      remediationHint: 'Thin-market guard (#638). No contract call or nonce was consumed. Inspect context.limitSource and the per-bond impact-limit config.',
    },
    RECEIPT_PENDING: {
      safeMessage: 'The action was applied but its signed receipt is not yet issued.',
      remediation: 'Retry with the same `Idempotency-Key` (see `context.idempotencyKey`); the action will not be applied twice.',
      remediationHint: 'Audit write was rejected after a governance mutation (#632). The mutation is parked as pending_receipt; check audit store capacity, then have the caller retry with the same Idempotency-Key.',
    },
  };

  it('exposes exactly the frozen set of codes', () => {
    expect(Object.values(ErrorCode).sort()).toEqual([...FROZEN_CODES].sort());
  });

  it('has a taxonomy entry for every code and no extras', () => {
    for (const code of Object.values(ErrorCode)) {
      expect(ErrorTaxonomy[code]).toBeDefined();
    }
    expect(Object.keys(ErrorTaxonomy).sort()).toEqual([...FROZEN_CODES].sort());
  });

  it('has a non-empty safe message and remediation hint for every code', () => {
    for (const code of Object.values(ErrorCode)) {
      expect(ErrorTaxonomy[code].safeMessage.trim().length).toBeGreaterThan(0);
      expect(ErrorTaxonomy[code].remediation.trim().length).toBeGreaterThan(0);
      expect(remediationFor(code)).toBe(ErrorTaxonomy[code].remediation);
    }
  });

  it('keeps retryability stable', () => {
    for (const code of Object.values(ErrorCode)) {
      expect(ErrorTaxonomy[code].retryable).toBe(FROZEN_RETRYABLE[code]);
    }
  });

  it('keeps safe messages, remediations and operator hints byte-identical', () => {
    for (const code of Object.values(ErrorCode)) {
      const frozen = FROZEN_COPY[code];
      expect(ErrorTaxonomy[code].safeMessage).toBe(frozen.safeMessage);
      expect(ErrorTaxonomy[code].remediation).toBe(frozen.remediation);
      expect(ErrorTaxonomy[code].remediationHint).toBe(frozen.remediationHint);
      expect(remediationFor(code)).toBe(frozen.remediation);
    }
  });

  it('keeps operator-only hints out of the client-safe copy', () => {
    // `remediationHint` names internal tooling (Grafana, Horizon, runbooks);
    // only `safeMessage` and `remediation` are serialized by the filter.
    const operatorMarkers = ['Grafana', 'Sentry', 'Horizon', 'runbook', 'docs/', 'propose_admin', 'tx_bad_seq'];
    for (const code of Object.values(ErrorCode)) {
      const hint = ErrorTaxonomy[code].remediationHint;
      const publicCopy = `${ErrorTaxonomy[code].safeMessage} ${ErrorTaxonomy[code].remediation}`;
      expect(publicCopy.includes(hint)).toBe(false);
      expect(remediationFor(code).includes(hint)).toBe(false);
      for (const marker of operatorMarkers) {
        if (hint.includes(marker)) {
          expect(ErrorTaxonomy[code].remediation.includes(marker)).toBe(false);
        }
      }
    }
  });

  it('never leaks internal-only detail in safe messages or remediations', () => {
    const forbidden = [/node_modules/i, /\.ts:\d+/, /stack/i, /\bsql\b/i, /postgres/i, /ECONNREFUSED/];
    for (const code of Object.values(ErrorCode)) {
      const text = `${ErrorTaxonomy[code].safeMessage} ${ErrorTaxonomy[code].remediation}`;
      for (const pattern of forbidden) {
        expect(pattern.test(text)).toBe(false);
      }
    }
  });

  it('builds stable type URIs', () => {
    expect(problemTypeUri(ErrorCode.VALIDATION_FAILED)).toBe(
      `${PROBLEM_TYPE_BASE}/VALIDATION_FAILED`,
    );
    expect(PROBLEM_TYPE_BASE).toBe('https://errors.verdant-bond-protocol.org');
  });
});
