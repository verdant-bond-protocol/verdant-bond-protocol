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
  quoteAsset: QuoteAsset;
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

export type LiquidityTier = 'LIQUID' | 'MODERATE' | 'ILLIQUID';

export type PriceImpactLimitSource = 'tier' | 'caller';

export interface PriceImpactConfig {
  illiquidThresholdAmount: string;
  moderateThresholdAmount: string;
  tierImpactLimitsBps: Record<LiquidityTier, number>;
  maxIlliquidDepthConsumptionBps: number;
}

export interface PriceImpactEvaluation {
  bondId: number;
  requestedAmount: string;
  quoteAsset: QuoteAsset;
  liquidityTier: LiquidityTier;
  availableDepth: string;
  bestPrice: string;
  marginalPrice: string;
  averageExecutionPrice: string;
  totalCost: string;
  priceImpactBps: number;
  /** Effective cap: the stricter of the tier cap and the caller's tolerance (#638). */
  maxAllowedImpactBps: number;
  /** The tier's configured cap before any caller tolerance is applied. */
  tierMaxImpactBps?: number;
  /** Caller-supplied slippage tolerance, when given. */
  callerMaxImpactBps?: number;
  /** Which limit produced `maxAllowedImpactBps`. */
  limitSource?: PriceImpactLimitSource;
  /** Premium of the targeted order's price over the best ask, in bps (targeted fills only). */
  fillPremiumBps?: number;
  /** Cheapest resting ask — the order to retry against when the premium is too high. */
  bestOrderId?: number;
  targetOrderId?: number;
  isAllowed: boolean;
  depthConsumptionRatioBps: number;
  maxDepthConsumptionBps: number;
  reason?: string;
  suggestedMaxAmount?: string;
}

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

