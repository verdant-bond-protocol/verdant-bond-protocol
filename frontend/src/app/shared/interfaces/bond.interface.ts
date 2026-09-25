export interface Bond {
  id: number;
  projectId: string;
  faceValue: string;
  couponSchedule: string[];
  creditType: 'Carbon' | 'Biodiversity' | 'Basket' | 'BlueCarbon';
  maturityDate: number;
  maturityStatus: 'Active' | 'Matured';
  totalSupply: string;
  totalSubscribed: string;
  status: 'Active' | 'Matured' | 'Defaulted';
  createdAt: string;
  /** Only present on the response to a just-submitted issuance; absent on reads. */
  transactionHash?: string;
}

export interface CreateBondDto {
  projectId: string;
  faceValue: number;
  couponSchedule: number[];
  creditType: Bond['creditType'];
  maturityDate: number;
  totalSupply: number;
}

export interface HeldBond extends Bond {
  balance: string;
}

/** A single bond holder and their token balance (issue #4 detail refresh). */
export interface HolderResponse {
  address: string;
  balance: string;
}

export type BondResponse = Bond;

export interface HolderListResponse {
  bondId: number;
  holders: HolderResponse[];
  total: number;
}

export interface CouponDistributionResponse {
  bondId: number;
  periodIndex: number;
  totalCredits: string;
  holderCount: number;
}

/**
 * A single period/report/credit-type accrual of claimable credits for a holder
 * (#156). `amount` is in credit minor units (6 decimals, #157).
 */
export interface ClaimableCreditDetail {
  periodIndex: number;
  reportId: number;
  startTime: number;
  endTime: number;
  creditType: 'Carbon' | 'Biodiversity' | 'Basket' | 'BlueCarbon';
  amount: string;
}

export interface ClaimableCreditsResponse {
  bondId: number;
  address: string;
  total: string;
  details: ClaimableCreditDetail[];
}

export interface Project {
  id: number;
  name: string;
  status: 'Pending' | 'Approved' | 'Rejected' | 'Inactive';
  methodology: string;
  country: string;
  metadataIpfsHash: string;
  ownerAddress: string;
  totalAreaHa: number;
  carbonSequestrationEstimate: number;
  createdAt: string;
  /** Only present on the response to a just-submitted registration; absent on reads. */
  transactionHash?: string;
}

export interface ProjectProvenanceEvent {
  type: 'registration' | 'review' | 'report' | 'bond' | 'document';
  occurredAt: string | null;
  title: string;
  status: 'complete' | 'pending' | 'stale';
  reference?: string;
  evidenceUrl?: string;
}

export interface ProjectProvenance {
  projectId: number;
  events: ProjectProvenanceEvent[];
}

export type QuoteAsset = 'USDC' | 'XLM';

export interface Order {
  id: number;
  seller: string;
  bondId: number;
  amount: string;
  pricePerToken: string;
  quoteAsset: QuoteAsset;
  status: 'Open' | 'PartiallyFilled' | 'Filled' | 'Cancelled' | 'Expired';
  createdAt: string;
  expiresAt: string;
  transactionHash?: string;
}

export interface OrderQueryParams {
  bondId?: number;
  status?: Order['status'];
  page?: number;
  limit?: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

export interface SubscriptionResponse {
  bondId: number;
  subscriber: string;
  amount: string;
  transactionHash: string;
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

export interface SweepUndistributedResponse {
  bondId: number;
  swept: string;
  transactionHash: string;
}

export interface CreateProjectDto {
  name: string;
  methodology: string;
  country: string;
  totalAreaHa: number;
  carbonSequestrationEstimate: number;
  blueCarbon?: boolean;
  biodiversityCorridor?: boolean;
  metadataIpfsHash?: string;
  nonce?: number;
}

export interface ListBondDto {
  bondId: number;
  amount: number;
  pricePerToken: number;
  quoteAsset: 'USDC' | 'XLM';
  nonce?: number;
}

export interface BuyBondDto {
  orderId: number;
  amount: number;
  maxPrice: number;
  nonce?: number;
}

export interface QuoteBalanceResponse {
  address: string;
  asset: QuoteAsset;
  balance: string;
}

export interface QuoteTransactionResponse {
  address: string;
  asset: QuoteAsset;
  amount: string;
  transactionHash?: string;
}

export interface DepositQuoteDto {
  asset: QuoteAsset;
  amount: number;
  nonce?: number;
}

export interface WithdrawQuoteDto {
  asset: QuoteAsset;
  amount: number;
  nonce?: number;
}

// Mirrors api/src/stellar/contract.service.ts's TransactionStatus/TransactionStatusResult.
export type TransactionStatus = 'pending' | 'confirmed' | 'failed';

export interface TransactionStatusResponse {
  hash: string;
  status: TransactionStatus;
}
