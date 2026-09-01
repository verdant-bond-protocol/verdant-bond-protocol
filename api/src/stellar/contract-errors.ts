import { BadRequestException } from '@nestjs/common';

export enum StableErrorCode {
  // Bond Errors
  BOND_NOT_INITIALIZED = 'BOND_NOT_INITIALIZED',
  BOND_UNAUTHORIZED = 'BOND_UNAUTHORIZED',
  BOND_INVALID_NONCE = 'BOND_INVALID_NONCE',
  BOND_NOT_FOUND = 'BOND_NOT_FOUND',
  BOND_ALREADY_MATURED = 'BOND_ALREADY_MATURED',
  BOND_INSUFFICIENT_SUPPLY = 'BOND_INSUFFICIENT_SUPPLY',
  BOND_ZERO_AMOUNT = 'BOND_ZERO_AMOUNT',
  BOND_PROJECT_NOT_APPROVED = 'BOND_PROJECT_NOT_APPROVED',
  BOND_OVERFLOW = 'BOND_OVERFLOW',
  BOND_REPORT_NOT_VERIFIED = 'BOND_REPORT_NOT_VERIFIED',
  BOND_INVALID_REPORT = 'BOND_INVALID_REPORT',
  BOND_INVALID_SUPPLY = 'BOND_INVALID_SUPPLY',
  BOND_REDEMPTION_UNDERFUNDED = 'BOND_REDEMPTION_UNDERFUNDED',
  BOND_INCOMPATIBLE_METHODOLOGY_CREDIT_TYPE = 'BOND_INCOMPATIBLE_METHODOLOGY_CREDIT_TYPE',

  // Oracle Errors
  ORACLE_NOT_INITIALIZED = 'ORACLE_NOT_INITIALIZED',
  ORACLE_UNAUTHORIZED = 'ORACLE_UNAUTHORIZED',
  ORACLE_INVALID_NONCE = 'ORACLE_INVALID_NONCE',
  ORACLE_PROVIDER_NOT_FOUND = 'ORACLE_PROVIDER_NOT_FOUND',
  ORACLE_PROVIDER_ALREADY_EXISTS = 'ORACLE_PROVIDER_ALREADY_EXISTS',
  ORACLE_REPORT_NOT_FOUND = 'ORACLE_REPORT_NOT_FOUND',
  ORACLE_REPORT_ALREADY_VERIFIED = 'ORACLE_REPORT_ALREADY_VERIFIED',
  ORACLE_CHALLENGE_WINDOW_EXPIRED = 'ORACLE_CHALLENGE_WINDOW_EXPIRED',
  ORACLE_INSUFFICIENT_STAKE = 'ORACLE_INSUFFICIENT_STAKE',
  ORACLE_INVALID_SIGNATURE = 'ORACLE_INVALID_SIGNATURE',
  ORACLE_INVALID_RESOLUTION = 'ORACLE_INVALID_RESOLUTION',
  ORACLE_OVERLAPPING_REPORT_PERIOD = 'ORACLE_OVERLAPPING_REPORT_PERIOD',

  // DEX Errors
  DEX_NOT_INITIALIZED = 'DEX_NOT_INITIALIZED',
  DEX_UNAUTHORIZED = 'DEX_UNAUTHORIZED',
  DEX_INVALID_NONCE = 'DEX_INVALID_NONCE',
  DEX_ORDER_NOT_FOUND = 'DEX_ORDER_NOT_FOUND',
  DEX_ORDER_ALREADY_FILLED = 'DEX_ORDER_ALREADY_FILLED',
  DEX_INSUFFICIENT_BALANCE = 'DEX_INSUFFICIENT_BALANCE',
  DEX_SELF_BUY_NOT_ALLOWED = 'DEX_SELF_BUY_NOT_ALLOWED',
  DEX_ORDER_EXPIRED = 'DEX_ORDER_EXPIRED',
  DEX_ZERO_AMOUNT = 'DEX_ZERO_AMOUNT',
  DEX_INSUFFICIENT_FUNDS = 'DEX_INSUFFICIENT_FUNDS',
  DEX_OVERFLOW = 'DEX_OVERFLOW',

  // Registry Errors
  REGISTRY_NOT_INITIALIZED = 'REGISTRY_NOT_INITIALIZED',
  REGISTRY_UNAUTHORIZED = 'REGISTRY_UNAUTHORIZED',
  REGISTRY_PROJECT_NOT_FOUND = 'REGISTRY_PROJECT_NOT_FOUND',
  REGISTRY_PROJECT_ALREADY_EXISTS = 'REGISTRY_PROJECT_ALREADY_EXISTS',
  REGISTRY_INVALID_STATUS_TRANSITION = 'REGISTRY_INVALID_STATUS_TRANSITION',
  REGISTRY_INVALID_NONCE = 'REGISTRY_INVALID_NONCE',
  REGISTRY_INVALID_ARGUMENT = 'REGISTRY_INVALID_ARGUMENT',

  // Credit Errors
  CREDIT_NOT_INITIALIZED = 'CREDIT_NOT_INITIALIZED',
  CREDIT_UNAUTHORIZED = 'CREDIT_UNAUTHORIZED',
  CREDIT_INSUFFICIENT_CREDITS = 'CREDIT_INSUFFICIENT_CREDITS',
  CREDIT_ALREADY_RETIRED = 'CREDIT_ALREADY_RETIRED',
  CREDIT_INVALID_NONCE = 'CREDIT_INVALID_NONCE',
  CREDIT_NOT_A_HOLDER = 'CREDIT_NOT_A_HOLDER',
  CREDIT_INVALID_CERTIFICATE = 'CREDIT_INVALID_CERTIFICATE',
  CREDIT_INVALID_CREDIT_TYPE = 'CREDIT_INVALID_CREDIT_TYPE',

  // Governance Errors
  GOV_NOT_INITIALIZED = 'GOV_NOT_INITIALIZED',
  GOV_UNAUTHORIZED = 'GOV_UNAUTHORIZED',
  GOV_INVALID_NONCE = 'GOV_INVALID_NONCE',
  GOV_NOT_SIGNER = 'GOV_NOT_SIGNER',
  GOV_PROPOSAL_NOT_FOUND = 'GOV_PROPOSAL_NOT_FOUND',
  GOV_ALREADY_VOTED = 'GOV_ALREADY_VOTED',
  GOV_NOT_PENDING = 'GOV_NOT_PENDING',
  GOV_TIMELOCK_NOT_ELAPSED = 'GOV_TIMELOCK_NOT_ELAPSED',
  GOV_NOT_QUEUED = 'GOV_NOT_QUEUED',
  GOV_ALREADY_EXECUTED = 'GOV_ALREADY_EXECUTED',

  // Fallback
  UNKNOWN_CONTRACT_ERROR = 'UNKNOWN_CONTRACT_ERROR',
}

export class ContractException extends BadRequestException {
  constructor(
    public readonly code: string,
    public readonly detail: string,
    public readonly contractAddress?: string,
    public readonly method?: string,
    public readonly rawErrorCode?: number,
  ) {
    super({
      message: detail,
      code,
      detail,
    });
  }
}

export const ERROR_MAPPINGS: Record<string, Record<number, { code: StableErrorCode; message: string }>> = {
  BOND: {
    1: { code: StableErrorCode.BOND_NOT_INITIALIZED, message: 'Bond issuer contract is not initialized' },
    2: { code: StableErrorCode.BOND_UNAUTHORIZED, message: 'Unauthorized issuer operation' },
    3: { code: StableErrorCode.BOND_INVALID_NONCE, message: 'Invalid signature nonce for issuer' },
    4: { code: StableErrorCode.BOND_NOT_FOUND, message: 'Bond not found' },
    5: { code: StableErrorCode.BOND_ALREADY_MATURED, message: 'Bond is already matured' },
    6: { code: StableErrorCode.BOND_INSUFFICIENT_SUPPLY, message: 'Insufficient bond token supply' },
    7: { code: StableErrorCode.BOND_ZERO_AMOUNT, message: 'Amount must be greater than zero' },
    8: { code: StableErrorCode.BOND_PROJECT_NOT_APPROVED, message: 'Associated project is not approved' },
    9: { code: StableErrorCode.BOND_OVERFLOW, message: 'Arithmetic overflow or operation before schedule' },
    10: { code: StableErrorCode.BOND_REPORT_NOT_VERIFIED, message: 'Oracle report is not verified' },
    11: { code: StableErrorCode.BOND_INVALID_REPORT, message: 'Invalid oracle report' },
    12: { code: StableErrorCode.BOND_INVALID_SUPPLY, message: 'Invalid supply bounds' },
    13: { code: StableErrorCode.BOND_REDEMPTION_UNDERFUNDED, message: 'Bond redemption pool is underfunded' },
    14: { code: StableErrorCode.BOND_INCOMPATIBLE_METHODOLOGY_CREDIT_TYPE, message: 'Incompatible methodology for credit type' },
  },
  ORACLE: {
    1: { code: StableErrorCode.ORACLE_NOT_INITIALIZED, message: 'Oracle contract is not initialized' },
    2: { code: StableErrorCode.ORACLE_UNAUTHORIZED, message: 'Unauthorized oracle operation' },
    3: { code: StableErrorCode.ORACLE_INVALID_NONCE, message: 'Invalid signature nonce for oracle' },
    4: { code: StableErrorCode.ORACLE_PROVIDER_NOT_FOUND, message: 'Oracle provider not found' },
    5: { code: StableErrorCode.ORACLE_PROVIDER_ALREADY_EXISTS, message: 'Oracle provider already registered' },
    6: { code: StableErrorCode.ORACLE_REPORT_NOT_FOUND, message: 'Oracle report not found' },
    7: { code: StableErrorCode.ORACLE_REPORT_ALREADY_VERIFIED, message: 'Oracle report is already verified' },
    8: { code: StableErrorCode.ORACLE_CHALLENGE_WINDOW_EXPIRED, message: 'Oracle report challenge window has expired' },
    9: { code: StableErrorCode.ORACLE_INSUFFICIENT_STAKE, message: 'Oracle provider stake is insufficient' },
    10: { code: StableErrorCode.ORACLE_INVALID_SIGNATURE, message: 'Invalid signature for oracle verification' },
    11: { code: StableErrorCode.ORACLE_INVALID_RESOLUTION, message: 'Invalid resolution state for challenge' },
    12: { code: StableErrorCode.ORACLE_OVERLAPPING_REPORT_PERIOD, message: 'Oracle report period overlaps an existing report' },
  },
  DEX: {
    1: { code: StableErrorCode.DEX_NOT_INITIALIZED, message: 'DEX contract is not initialized' },
    2: { code: StableErrorCode.DEX_UNAUTHORIZED, message: 'Unauthorized DEX operation' },
    3: { code: StableErrorCode.DEX_INVALID_NONCE, message: 'Invalid signature nonce for DEX' },
    4: { code: StableErrorCode.DEX_ORDER_NOT_FOUND, message: 'Marketplace order not found' },
    5: { code: StableErrorCode.DEX_ORDER_ALREADY_FILLED, message: 'Marketplace order is already filled' },
    6: { code: StableErrorCode.DEX_INSUFFICIENT_BALANCE, message: 'Insufficient bond token balance in escrow' },
    7: { code: StableErrorCode.DEX_SELF_BUY_NOT_ALLOWED, message: 'Buyer cannot buy their own listing' },
    8: { code: StableErrorCode.DEX_ORDER_EXPIRED, message: 'Marketplace order has expired' },
    9: { code: StableErrorCode.DEX_ZERO_AMOUNT, message: 'Trade amount must be greater than zero' },
    10: { code: StableErrorCode.DEX_INSUFFICIENT_FUNDS, message: 'Insufficient quote asset balance' },
    11: { code: StableErrorCode.DEX_OVERFLOW, message: 'Arithmetic overflow in marketplace math' },
  },
  REGISTRY: {
    1: { code: StableErrorCode.REGISTRY_NOT_INITIALIZED, message: 'Project registry contract is not initialized' },
    2: { code: StableErrorCode.REGISTRY_UNAUTHORIZED, message: 'Unauthorized project registry operation' },
    3: { code: StableErrorCode.REGISTRY_PROJECT_NOT_FOUND, message: 'Project not found in registry' },
    4: { code: StableErrorCode.REGISTRY_PROJECT_ALREADY_EXISTS, message: 'Project ID is already registered' },
    5: { code: StableErrorCode.REGISTRY_INVALID_STATUS_TRANSITION, message: 'Invalid project status transition' },
    6: { code: StableErrorCode.REGISTRY_INVALID_NONCE, message: 'Invalid signature nonce for registry' },
    7: { code: StableErrorCode.REGISTRY_INVALID_ARGUMENT, message: 'Invalid project registration details' },
  },
  CREDIT: {
    1: { code: StableErrorCode.CREDIT_NOT_INITIALIZED, message: 'Credit retirement contract is not initialized' },
    2: { code: StableErrorCode.CREDIT_UNAUTHORIZED, message: 'Unauthorized credit operation' },
    3: { code: StableErrorCode.CREDIT_INSUFFICIENT_CREDITS, message: 'Insufficient credit balance for retirement' },
    4: { code: StableErrorCode.CREDIT_ALREADY_RETIRED, message: 'Credit is already retired' },
    5: { code: StableErrorCode.CREDIT_INVALID_NONCE, message: 'Invalid signature nonce for credit retirement' },
    6: { code: StableErrorCode.CREDIT_NOT_A_HOLDER, message: 'Address is not a registered credit holder' },
    7: { code: StableErrorCode.CREDIT_INVALID_CERTIFICATE, message: 'Invalid credit certificate details' },
    8: { code: StableErrorCode.CREDIT_INVALID_CREDIT_TYPE, message: 'Invalid credit type category' },
  },
  GOVERNANCE: {
    1: { code: StableErrorCode.GOV_NOT_INITIALIZED, message: 'Governance contract is not initialized' },
    2: { code: StableErrorCode.GOV_UNAUTHORIZED, message: 'Unauthorized governance operation' },
    3: { code: StableErrorCode.GOV_INVALID_NONCE, message: 'Invalid signature nonce for governance' },
    4: { code: StableErrorCode.GOV_NOT_SIGNER, message: 'Address is not an authorized governance signer' },
    5: { code: StableErrorCode.GOV_PROPOSAL_NOT_FOUND, message: 'Governance proposal not found' },
    6: { code: StableErrorCode.GOV_ALREADY_VOTED, message: 'Signer has already voted on this proposal' },
    7: { code: StableErrorCode.GOV_NOT_PENDING, message: 'Proposal is not in a pending vote state' },
    8: { code: StableErrorCode.GOV_TIMELOCK_NOT_ELAPSED, message: 'Governance timelock has not yet elapsed' },
    9: { code: StableErrorCode.GOV_NOT_QUEUED, message: 'Proposal is not in the execution queue' },
    10: { code: StableErrorCode.GOV_ALREADY_EXECUTED, message: 'Proposal has already been executed' },
  },
};
