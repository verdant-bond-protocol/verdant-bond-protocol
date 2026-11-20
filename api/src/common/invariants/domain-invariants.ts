/**
 * Domain invariants for the Verdant Bond Protocol.
 *
 * Each invariant asserts a constraint that the domain model must never violate
 * through any API, UI, worker, or contract path. If any invariant is breached,
 * the system is in an impossible state and the violation must be investigated.
 *
 * See: https://github.com/verdant-bond-protocol/verdant-bond-protocol/issues/262
 */

export interface InvariantResult {
  name: string;
  passed: boolean;
  message: string;
  code: string;
}

export type InvariantCheck = () => InvariantResult | Promise<InvariantResult>;

/**
 * Bond lifecycle invariants.
 */
export const bondLifecycleInvariants = {
  /**
   * INV-001: A bond's totalSubscribed can never exceed its totalSupply.
   * The contract enforces this at the Soroban level, but this invariant
   * catches any drift between on-chain state and the API's cached view.
   */
  async subscribedDoesNotExceedSupply(
    totalSubscribed: string,
    totalSupply: string,
  ): Promise<InvariantResult> {
    const subscribed = BigInt(totalSubscribed);
    const supply = BigInt(totalSupply);
    const passed = subscribed <= supply;
    return {
      name: 'INV-001: subscribed <= totalSupply',
      passed,
      message: passed
        ? `totalSubscribed (${totalSubscribed}) does not exceed totalSupply (${totalSupply})`
        : `totalSubscribed (${totalSubscribed}) exceeds totalSupply (${totalSupply}): impossible state`,
      code: 'INV-001',
    };
  },

  /**
   * INV-002: A matured bond must have status Matured.
   * A bond whose maturity date has elapsed cannot remain Active.
   */
  async maturedBondHasMaturedStatus(
    status: string,
    maturityDate: number,
    maturityStatus: string,
  ): Promise<InvariantResult> {
    const now = Math.floor(Date.now() / 1000);
    const isPastMaturity = now >= maturityDate;
    const isMaturedOnChain = status === 'Matured';
    const expectedMaturityStatus = (isPastMaturity || isMaturedOnChain) ? 'Matured' : 'Active';
    const passed = maturityStatus === expectedMaturityStatus;
    return {
      name: 'INV-002: maturityStatus matches bond lifecycle',
      passed,
      message: passed
        ? `maturityStatus (${maturityStatus}) is consistent with bond lifecycle`
        : `maturityStatus (${maturityStatus}) is inconsistent: expected ${expectedMaturityStatus} for bond with maturityDate ${maturityDate} and status ${status}`,
      code: 'INV-002',
    };
  },

  /**
   * INV-003: A bond with status Defaulted must not have any active coupon distributions.
   * Defaulted bonds are ineligible for coupon distribution.
   */
  async defaultedBondHasNoActiveCoupons(
    status: string,
    hasActiveDistributions: boolean,
  ): Promise<InvariantResult> {
    const passed = !(status === 'Defaulted' && hasActiveDistributions);
    return {
      name: 'INV-003: defaulted bonds have no active distributions',
      passed,
      message: passed
        ? 'Defaulted bond has no active coupon distributions'
        : 'Defaulted bond has active coupon distributions: impossible state',
      code: 'INV-003',
    };
  },
};

/**
 * Ownership and balance invariants.
 */
export const ownershipInvariants = {
  /**
   * INV-004: No holder can have a zero or negative balance for a bond they
   * are listed as holding in the holder index.
   */
  async holderBalanceIsPositive(
    holderAddress: string,
    balance: string,
  ): Promise<InvariantResult> {
    const bal = BigInt(balance);
    const passed = bal > 0n;
    return {
      name: 'INV-004: holder balance must be positive',
      passed,
      message: passed
        ? `Holder ${holderAddress} has positive balance (${balance})`
        : `Holder ${holderAddress} has non-positive balance (${balance}) in holder index: impossible state`,
      code: 'INV-004',
    };
  },

  /**
   * INV-005: The sum of all individual holder balances for a bond must equal
   * the bond's totalSubscribed amount. This ensures no tokens are lost or
   * created outside the holder index.
   */
  async holderBalancesSumEqualsTotalSubscribed(
    holderBalances: Record<string, string>,
    totalSubscribed: string,
  ): Promise<InvariantResult> {
    const sum = Object.values(holderBalances).reduce(
      (acc, b) => acc + BigInt(b),
      0n,
    );
    const total = BigInt(totalSubscribed);
    const passed = sum === total;
    return {
      name: 'INV-005: sum of holder balances equals totalSubscribed',
      passed,
      message: passed
        ? `Sum of holder balances (${sum}) equals totalSubscribed (${totalSubscribed})`
        : `Sum of holder balances (${sum}) does not equal totalSubscribed (${totalSubscribed}): possible token loss/creation`,
      code: 'INV-005',
    };
  },

  /**
   * INV-006: A bond cannot be held by an address that is not a known,
   * validated Stellar address.
   */
  async holderAddressIsValid(address: string): Promise<InvariantResult> {
    const isValid = address.startsWith('G') && address.length === 56;
    return {
      name: 'INV-006: holder address is a valid Stellar address',
      passed: isValid,
      message: isValid
        ? `Holder address ${address} is a valid Stellar address`
        : `Holder address ${address} is not a valid Stellar address: impossible state`,
      code: 'INV-006',
    };
  },
};

/**
 * Access control invariants.
 */
export const accessControlInvariants = {
  /**
   * INV-007: Only an admin (matching STELLAR_PUBLIC_KEY) can mature a bond.
   * A non-admin attempt to mature must be rejected.
   */
  async onlyAdminCanMature(
    actorAddress: string,
    adminAddress: string,
  ): Promise<InvariantResult> {
    const passed = actorAddress === adminAddress;
    return {
      name: 'INV-007: only admin can mature bonds',
      passed,
      message: passed
        ? 'Only admin attempted to mature the bond'
        : `Non-admin address ${actorAddress} attempted to mature a bond: access violation`,
      code: 'INV-007',
    };
  },

  /**
   * INV-008: A KYC-verified investor is the only one eligible to subscribe
   * to a bond. Unverified addresses must be rejected.
   */
  async subscriberIsKycVerified(
    kycStatus: string,
  ): Promise<InvariantResult> {
    const eligibleStatuses = ['verified', 'accredited'];
    const passed = eligibleStatuses.includes(kycStatus);
    return {
      name: 'INV-008: only KYC-verified investors can subscribe',
      passed,
      message: passed
        ? `Subscriber KYC status (${kycStatus}) is eligible`
        : `Subscriber KYC status (${kycStatus}) is not eligible to subscribe: access violation`,
      code: 'INV-008',
    };
  },
};

/**
 * Data integrity invariants.
 */
export const dataIntegrityInvariants = {
  /**
   * INV-009: A bond's createdAt timestamp must be before its maturityDate.
   * A bond cannot be issued after it has already matured.
   */
  async createdAtBeforeMaturityDate(
    createdAt: string,
    maturityDate: number,
  ): Promise<InvariantResult> {
    const created = new Date(createdAt).getTime() / 1000;
    const passed = created < maturityDate;
    return {
      name: 'INV-009: createdAt is before maturityDate',
      passed,
      message: passed
        ? `Bond created at ${createdAt} is before maturity date ${maturityDate}`
        : `Bond created at ${createdAt} is on or after maturity date ${maturityDate}: impossible state`,
      code: 'INV-009',
    };
  },

  /**
   * INV-010: A coupon distribution period index must be within the valid
   * range of the bond's coupon schedule.
   */
  async couponPeriodIsWithinSchedule(
    periodIndex: number,
    couponScheduleLength: number,
  ): Promise<InvariantResult> {
    const passed = periodIndex >= 0 && periodIndex < couponScheduleLength;
    return {
      name: 'INV-010: coupon period index is within schedule bounds',
      passed,
      message: passed
        ? `Coupon period ${periodIndex} is within schedule length ${couponScheduleLength}`
        : `Coupon period ${periodIndex} is out of bounds for schedule length ${couponScheduleLength}`,
      code: 'INV-010',
    };
  },

  /**
   * INV-011: A bond ID must be a positive integer.
   */
  async bondIdIsPositive(bondId: number): Promise<InvariantResult> {
    const passed = bondId > 0;
    return {
      name: 'INV-011: bond ID is a positive integer',
      passed,
      message: passed
        ? `Bond ID ${bondId} is a positive integer`
        : `Bond ID ${bondId} is not a positive integer: impossible state`,
      code: 'INV-011',
    };
  },
};

/**
 * Run all domain invariants and return results.
 */
export async function runAllInvariants(
  checks: InvariantCheck[],
): Promise<InvariantResult[]> {
  const results: InvariantResult[] = [];
  for (const check of checks) {
    try {
      const result = await check();
      results.push(result);
    } catch (error) {
      results.push({
        name: 'Unknown',
        passed: false,
        message: `Invariant check threw an error: ${error instanceof Error ? error.message : String(error)}`,
        code: 'ERR',
      });
    }
  }
  return results;
}
