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
