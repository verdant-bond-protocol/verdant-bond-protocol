import { DomainException, ErrorCode, ErrorTaxonomy } from './error-codes';

describe('ErrorTaxonomy', () => {
  it('covers every ErrorCode variant', () => {
    const defined = Object.keys(ErrorTaxonomy) as ErrorCode[];
    const all = Object.values(ErrorCode) as ErrorCode[];
    expect(defined.sort()).toEqual(all.sort());
  });

  it('every entry has a non-empty safe message, operator hint and client remediation', () => {
    for (const [code, meta] of Object.entries(ErrorTaxonomy)) {
      expect(meta.remediationHint.length).toBeGreaterThan(0);
      expect(meta.remediation.length).toBeGreaterThan(0);
      expect(meta.safeMessage.length).toBeGreaterThan(0);
      void code;
    }
  });

  it('retryable codes are the expected set', () => {
    const retryable = (Object.keys(ErrorTaxonomy) as ErrorCode[]).filter(
      (c) => ErrorTaxonomy[c].retryable,
    );
    expect(retryable.sort()).toEqual(
      [
        ErrorCode.SETTLEMENT_FAILED,
        ErrorCode.RATE_LIMIT_EXCEEDED,
        ErrorCode.QUEUE_BACKPRESSURE,
        ErrorCode.STEP_UP_REQUIRED,
      ].sort(),
    );
  });
});

describe('DomainException', () => {
  it('message equals safeMessage from taxonomy', () => {
    const ex = new DomainException(ErrorCode.NOT_FOUND);
    expect(ex.message).toBe(ErrorTaxonomy[ErrorCode.NOT_FOUND].safeMessage);
  });

  it('exposes remediationHint', () => {
    const ex = new DomainException(ErrorCode.BOND_MATURED);
    expect(ex.remediationHint).toBe(ErrorTaxonomy[ErrorCode.BOND_MATURED].remediationHint);
  });

  it('exposes retryable flag', () => {
    expect(new DomainException(ErrorCode.SETTLEMENT_FAILED).retryable).toBe(true);
    expect(new DomainException(ErrorCode.BOND_MATURED).retryable).toBe(false);
  });

  it('preserves optional details', () => {
    const details = { field: 'amount', value: -1 };
    const ex = new DomainException(ErrorCode.VALIDATION_FAILED, details);
    expect(ex.details).toEqual(details);
  });

  it('ownership transfer codes have correct retryable=false', () => {
    expect(new DomainException(ErrorCode.OWNERSHIP_TRANSFER_PENDING).retryable).toBe(false);
    expect(new DomainException(ErrorCode.OWNERSHIP_TRANSFER_EXPIRED).retryable).toBe(false);
  });
});
