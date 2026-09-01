import { QuoteAssetSymbol } from '../quote-assets';

export enum OrderStatus {
  Open = 'Open',
  PartiallyFilled = 'PartiallyFilled',
  Filled = 'Filled',
  Cancelled = 'Cancelled',
  Expired = 'Expired',
}

/**
 * Kept as an alias of the canonical registry's symbol type (see
 * ../quote-assets.ts) rather than its own literal union, so this and the
 * DTOs can never drift out of sync (issue #92).
 */
export type QuoteAsset = QuoteAssetSymbol;

export interface OrderResponse {
  id: number;
  seller: string;
  bondId: number;
  amount: string;
  pricePerToken: string;
  quoteAsset: QuoteAsset;
  status: OrderStatus;
  createdAt: string;
  expiresAt: string;
  transactionHash?: string;
}

export interface QuoteBalanceResponse {
  address: string;
  asset: QuoteAsset;
  balance: string;
}

export interface QuoteTransactionResponse {
  address: string;
  asset: QuoteAsset;
  amount: number;
  transactionHash?: string;
}

export interface PriceFeedResponse {
  bondId: number;
  bestPrice: string;
  averagePrice: string;
  totalOrders: number;
  totalVolume: string;
}

export interface PriceLevel {
  price: string;
  amount: string;
  total: string;
}

export type FillabilityStatus = 'fully_fillable' | 'partially_fillable' | 'unfillable';

export interface SlippageResponse {
  bondId: number;
  requestedAmount: string;
  fillableAmount: string;
  unfilledAmount: string;
  averagePrice: string;
  estimatedTotal: string;
  slippagePercent: number;
  fillabilityStatus: FillabilityStatus;
}
