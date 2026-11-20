export interface PortfolioBond {
  id: number;
  balance: string;
  status: string;
  maturityStatus: string;
  maturityDate: number;
}

export interface PortfolioListing {
  id: number;
  bondId: number;
  amount: string;
  pricePerToken: string;
  quoteAsset: string;
  status: string;
  createdAt: string;
}

export interface PortfolioClaimableCredit {
  bondId: number;
  amount: string;
}

export interface PortfolioRetiredCredit {
  id: number;
  bondId: number;
  amount: string;
  creditType: string;
  retiredAt: number;
}

export type PortfolioPendingActionType = 'coupon_claim' | 'maturity' | 'open_listing';

export interface PortfolioPendingAction {
  type: PortfolioPendingActionType;
  bondId?: number;
  detail?: string;
}

export interface PortfolioResponse {
  address: string;
  bondsHeld: PortfolioBond[];
  openListings: PortfolioListing[];
  claimableCredits: PortfolioClaimableCredit[];
  retiredCredits: PortfolioRetiredCredit[];
  pendingActions: PortfolioPendingAction[];
  generatedAt: string;
}
