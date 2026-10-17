export enum CreditTypeEnum {
  Carbon = 'Carbon',
  Biodiversity = 'Biodiversity',
  Basket = 'Basket',
  BlueCarbon = 'BlueCarbon',
}

export enum BondStatusEnum {
  Active = 'Active',
  Matured = 'Matured',
  Defaulted = 'Defaulted',
}

export enum BondMaturityStatusEnum {
  Active = 'Active',
  Matured = 'Matured',
}

export interface BondResponse {
  id: number;
  projectId: string;
  faceValue: string;
  couponSchedule: string[];
  creditType: CreditTypeEnum;
  maturityDate: number;
  maturityStatus: BondMaturityStatusEnum;
  totalSupply: string;
  totalSubscribed: string;
  status: BondStatusEnum;
  createdAt: string;
  /** Only present on the response to a just-submitted issuance (see
   *  BondsService.create); absent on reads. */
  transactionHash?: string;
}

export interface HeldBondResponse extends BondResponse {
  balance: string;
}

export interface SubscriptionResponse {
  bondId: number;
  investorAddress: string;
  amount: string;
  transactionHash: string;
}

export interface HolderResponse {
  address: string;
  balance: string;
}

export interface HolderListResponse {
  bondId: number;
  holders: HolderResponse[];
  total: number;
}

export interface HolderResponse {
  address: string;
  balance: string;
}

export interface CouponDistributionResponse {
  bondId: number;
  periodIndex: number;
  totalCredits: string;
  holderCount: number;
}

export interface ClaimCreditsResponse {
  bondId: number;
  investorAddress: string;
  credits: string;
  transactionHash: string;
}

export interface TransferResponse {
  bondId: number;
  fromAddress: string;
  toAddress: string;
  amount: string;
  transactionHash: string;
}

export interface UndistributedTotalResponse {
  bondId: number;
  undistributedTotal: string;
}

/**
 * One itemized claimable-credit line (issue #156). Mirrors the coupon-engine
 * `ClaimableCreditDetail` struct: a single period/report/credit-type accrual
 * for a holder. `amount` is in credit minor units (6 decimals, #157).
 */
export interface ClaimableCreditDetail {
  periodIndex: number;
  reportId: number;
  startTime: number;
  endTime: number;
  creditType: string;
  amount: string;
}

export interface ClaimableCreditsResponse {
  bondId: number;
  address: string;
  total: string;
  details: ClaimableCreditDetail[];
}

export interface SweepUndistributedResponse {
  bondId: number;
  swept: string;
  transactionHash: string;
}

export interface CouponBatchStatusResponse {
  bondId: number;
  periodIndex: number;
  cursor: number;
  totalHolders: number;
  distributed: boolean;
  totalCreditsEarned: string;
  undistributed: string;
  remainingHolders: number;
}

export interface CouponBatchDistributionResponse {
  bondId: number;
  periodIndex: number;
  offset: number;
  limit: number;
  processedCount: number;
  cursor: number;
  batchComplete: boolean;
  totalCredits: string;
  transactionHash: string;
}


/**
 * Consolidated, atomically-fetched bond detail (issue #4). A single call returns
 * the bond summary, holders, coupon undistributed total, and maturity status so
 * the frontend can refresh every panel together and never render a mix of
 * pre- and post-mutation data. `loadedAt` is the server timestamp used by the
 * client refresh model to detect staleness.
 */
export interface BondDetailResponse {
  bond: BondResponse;
  holders: HolderResponse[];
  coupon: { undistributedTotal: string };
  maturity: { reached: boolean; date: number; secondsUntil: number };
  loadedAt: string;
}
