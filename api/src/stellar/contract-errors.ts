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
  BOND_PERFORMANCE_FLAGGED = 'BOND_PERFORMANCE_FLAGGED',
  BOND_INSUFFICIENT_ATTESTATIONS = 'BOND_INSUFFICIENT_ATTESTATIONS',
  BOND_MIGRATION_IN_PROGRESS = 'BOND_MIGRATION_IN_PROGRESS',
  BOND_ORACLE_STALE = 'BOND_ORACLE_STALE',
  BOND_PROJECT_DISPUTED = 'BOND_PROJECT_DISPUTED',
  BOND_INVALID_WATERFALL = 'BOND_INVALID_WATERFALL',
  BOND_WATERFALL_ALREADY_CLAIMED = 'BOND_WATERFALL_ALREADY_CLAIMED',
  BOND_INVALID_BALANCE_SNAPSHOT = 'BOND_INVALID_BALANCE_SNAPSHOT',
  BOND_REDEMPTION_QUEUE_REQUIRED = 'BOND_REDEMPTION_QUEUE_REQUIRED',
  BOND_DUPLICATE_REDEMPTION_REQUEST = 'BOND_DUPLICATE_REDEMPTION_REQUEST',
  BOND_INVALID_REDEMPTION_BUDGET = 'BOND_INVALID_REDEMPTION_BUDGET',
  BOND_AUCTION_REQUIRED = 'BOND_AUCTION_REQUIRED',
  BOND_INVALID_AUCTION = 'BOND_INVALID_AUCTION',
  BOND_AUCTION_CLOSED = 'BOND_AUCTION_CLOSED',
  BOND_SUBSCRIPTION_INELIGIBLE = 'BOND_SUBSCRIPTION_INELIGIBLE',
  BOND_IDENTITY_CAP_EXCEEDED = 'BOND_IDENTITY_CAP_EXCEEDED',
  BOND_INVALID_COVENANT = 'BOND_INVALID_COVENANT',
  BOND_INVALID_EQUIVALENCE = 'BOND_INVALID_EQUIVALENCE',
  BOND_UNKNOWN_EQUIVALENCE = 'BOND_UNKNOWN_EQUIVALENCE',
  BOND_ADMIN_TRANSFER_PENDING = 'BOND_ADMIN_TRANSFER_PENDING',
  BOND_ADMIN_TRANSFER_EXPIRED = 'BOND_ADMIN_TRANSFER_EXPIRED',
  BOND_NO_ADMIN_TRANSFER_PENDING = 'BOND_NO_ADMIN_TRANSFER_PENDING',

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
  ORACLE_INSUFFICIENT_QUORUM = 'ORACLE_INSUFFICIENT_QUORUM',
  ORACLE_STALE = 'ORACLE_STALE',
  ORACLE_DISPUTE_BOND_INSUFFICIENT = 'ORACLE_DISPUTE_BOND_INSUFFICIENT',
  ORACLE_PROJECT_DISPUTED = 'ORACLE_PROJECT_DISPUTED',

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
  DEX_NO_PRICE_DATA = 'DEX_NO_PRICE_DATA',
  DEX_INVALID_MARKET_CONFIG = 'DEX_INVALID_MARKET_CONFIG',
  DEX_MARKET_NOT_CONFIGURED = 'DEX_MARKET_NOT_CONFIGURED',
  DEX_INVALID_ORACLE_PRICE = 'DEX_INVALID_ORACLE_PRICE',
  DEX_ORACLE_ZERO_VOLUME = 'DEX_ORACLE_ZERO_VOLUME',
  DEX_ORACLE_LOW_VOLUME = 'DEX_ORACLE_LOW_VOLUME',
  DEX_ORACLE_STALE = 'DEX_ORACLE_STALE',
  DEX_ORACLE_PAUSED = 'DEX_ORACLE_PAUSED',
  DEX_PRICE_DEVIATION_EXCEEDED = 'DEX_PRICE_DEVIATION_EXCEEDED',
  DEX_LEDGER_VOLUME_EXCEEDED = 'DEX_LEDGER_VOLUME_EXCEEDED',
  DEX_INVALID_COMMITMENT = 'DEX_INVALID_COMMITMENT',
  DEX_REVEAL_TOO_EARLY = 'DEX_REVEAL_TOO_EARLY',
  DEX_REVEAL_WINDOW_CLOSED = 'DEX_REVEAL_WINDOW_CLOSED',
  DEX_TRANSFER_PRECONDITION_FAILED = 'DEX_TRANSFER_PRECONDITION_FAILED',

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
  GOV_INVALID_TRACK = 'GOV_INVALID_TRACK',
  GOV_INSUFFICIENT_VOTING_POWER = 'GOV_INSUFFICIENT_VOTING_POWER',
  GOV_QUORUM_NOT_REACHED = 'GOV_QUORUM_NOT_REACHED',

  // Fallback
  UNKNOWN_CONTRACT_ERROR = 'UNKNOWN_CONTRACT_ERROR',
}

/**
 * What kind of failure a contract error represents, from the point of view of
 * an API consumer deciding what to do next (#641).
 */
export type ContractErrorClass =
  | 'authorization'      // caller lacks the right; retrying as the same caller never helps
  | 'not_found'          // referenced entity does not exist
  | 'conflict'           // already done / already exists; the request is a duplicate
  | 'validation'         // the request itself is malformed for this contract
  | 'state'              // the entity is not in a state that permits the call (yet)
  | 'insufficient_funds' // a balance, pool, or stake is too small
  | 'stale_nonce'        // replay-protection nonce was stale; resync and resubmit
  | 'unavailable'        // contract is temporarily paused (e.g. migration)
  | 'configuration'      // contract not initialised; operator action required
  | 'submission'         // network rejected the transaction without a contract code
  | 'unknown';           // a raw code the API has no mapping for

/**
 * How a consumer should retry:
 * - `none`: do not retry the same request.
 * - `resync_nonce`: safe to retry immediately; the API re-reads the on-chain
 *   nonce on every attempt.
 * - `backoff`: safe to retry the same request with exponential backoff.
 * - `after_state_change`: retrying the identical request is pointless until
 *   something else changes (report verified, pool funded, timelock elapsed).
 */
export type ContractRetryStrategy = 'none' | 'resync_nonce' | 'backoff' | 'after_state_change';

export type ContractErrorCategory = 'BOND' | 'ORACLE' | 'DEX' | 'REGISTRY' | 'CREDIT' | 'GOVERNANCE' | 'UNKNOWN';

export interface ContractErrorDescriptor {
  code: StableErrorCode;
  category: ContractErrorCategory;
  errorClass: ContractErrorClass;
  retryStrategy: ContractRetryStrategy;
  /** True only when retrying the identical request automatically is safe and useful. */
  retryable: boolean;
}

const C = StableErrorCode;

/**
 * Exhaustive consumer-facing classification of every stable contract error.
 * Typed as `Record<StableErrorCode, …>` so adding a code without classifying
 * it fails to compile. Guarded by `contract-error-mapping.spec.ts`.
 */
export const CONTRACT_ERROR_CLASSIFICATION: Record<StableErrorCode, [ContractErrorClass, ContractRetryStrategy]> = {
  [C.BOND_NOT_INITIALIZED]: ['configuration', 'none'],
  [C.BOND_UNAUTHORIZED]: ['authorization', 'none'],
  [C.BOND_INVALID_NONCE]: ['stale_nonce', 'resync_nonce'],
  [C.BOND_NOT_FOUND]: ['not_found', 'none'],
  [C.BOND_ALREADY_MATURED]: ['state', 'none'],
  [C.BOND_INSUFFICIENT_SUPPLY]: ['state', 'none'],
  [C.BOND_ZERO_AMOUNT]: ['validation', 'none'],
  [C.BOND_PROJECT_NOT_APPROVED]: ['state', 'after_state_change'],
  [C.BOND_OVERFLOW]: ['validation', 'none'],
  [C.BOND_REPORT_NOT_VERIFIED]: ['state', 'after_state_change'],
  [C.BOND_INVALID_REPORT]: ['validation', 'none'],
  [C.BOND_INVALID_SUPPLY]: ['validation', 'none'],
  [C.BOND_REDEMPTION_UNDERFUNDED]: ['insufficient_funds', 'after_state_change'],
  [C.BOND_INCOMPATIBLE_METHODOLOGY_CREDIT_TYPE]: ['validation', 'none'],
  [C.BOND_PERFORMANCE_FLAGGED]: ['state', 'after_state_change'],
  [C.BOND_INSUFFICIENT_ATTESTATIONS]: ['state', 'after_state_change'],
  [C.BOND_MIGRATION_IN_PROGRESS]: ['unavailable', 'backoff'],
  [C.BOND_ORACLE_STALE]: ['state', 'after_state_change'],
  [C.BOND_PROJECT_DISPUTED]: ['state', 'after_state_change'],
  [C.BOND_INVALID_WATERFALL]: ['validation', 'none'],
  [C.BOND_WATERFALL_ALREADY_CLAIMED]: ['conflict', 'none'],
  [C.BOND_INVALID_BALANCE_SNAPSHOT]: ['state', 'after_state_change'],
  [C.BOND_REDEMPTION_QUEUE_REQUIRED]: ['state', 'none'],
  [C.BOND_DUPLICATE_REDEMPTION_REQUEST]: ['conflict', 'none'],
  [C.BOND_INVALID_REDEMPTION_BUDGET]: ['validation', 'none'],
  [C.BOND_AUCTION_REQUIRED]: ['state', 'none'],
  [C.BOND_INVALID_AUCTION]: ['validation', 'none'],
  [C.BOND_AUCTION_CLOSED]: ['state', 'none'],
  [C.BOND_SUBSCRIPTION_INELIGIBLE]: ['authorization', 'none'],
  [C.BOND_IDENTITY_CAP_EXCEEDED]: ['validation', 'none'],
  [C.BOND_INVALID_COVENANT]: ['validation', 'none'],
  [C.BOND_INVALID_EQUIVALENCE]: ['validation', 'none'],
  [C.BOND_UNKNOWN_EQUIVALENCE]: ['not_found', 'none'],
  [C.BOND_ADMIN_TRANSFER_PENDING]: ['conflict', 'none'],
  [C.BOND_ADMIN_TRANSFER_EXPIRED]: ['state', 'none'],
  [C.BOND_NO_ADMIN_TRANSFER_PENDING]: ['state', 'none'],

  [C.ORACLE_NOT_INITIALIZED]: ['configuration', 'none'],
  [C.ORACLE_UNAUTHORIZED]: ['authorization', 'none'],
  [C.ORACLE_INVALID_NONCE]: ['stale_nonce', 'resync_nonce'],
  [C.ORACLE_PROVIDER_NOT_FOUND]: ['not_found', 'none'],
  [C.ORACLE_PROVIDER_ALREADY_EXISTS]: ['conflict', 'none'],
  [C.ORACLE_REPORT_NOT_FOUND]: ['not_found', 'none'],
  [C.ORACLE_REPORT_ALREADY_VERIFIED]: ['conflict', 'none'],
  [C.ORACLE_CHALLENGE_WINDOW_EXPIRED]: ['state', 'none'],
  [C.ORACLE_INSUFFICIENT_STAKE]: ['insufficient_funds', 'after_state_change'],
  [C.ORACLE_INVALID_SIGNATURE]: ['authorization', 'none'],
  [C.ORACLE_INVALID_RESOLUTION]: ['validation', 'none'],
  [C.ORACLE_OVERLAPPING_REPORT_PERIOD]: ['conflict', 'none'],
  [C.ORACLE_INSUFFICIENT_QUORUM]: ['state', 'after_state_change'],
  [C.ORACLE_STALE]: ['state', 'after_state_change'],
  [C.ORACLE_DISPUTE_BOND_INSUFFICIENT]: ['insufficient_funds', 'none'],
  [C.ORACLE_PROJECT_DISPUTED]: ['state', 'after_state_change'],

  [C.DEX_NOT_INITIALIZED]: ['configuration', 'none'],
  [C.DEX_UNAUTHORIZED]: ['authorization', 'none'],
  [C.DEX_INVALID_NONCE]: ['stale_nonce', 'resync_nonce'],
  [C.DEX_ORDER_NOT_FOUND]: ['not_found', 'none'],
  [C.DEX_ORDER_ALREADY_FILLED]: ['conflict', 'none'],
  [C.DEX_INSUFFICIENT_BALANCE]: ['insufficient_funds', 'none'],
  [C.DEX_SELF_BUY_NOT_ALLOWED]: ['validation', 'none'],
  [C.DEX_ORDER_EXPIRED]: ['state', 'none'],
  [C.DEX_ZERO_AMOUNT]: ['validation', 'none'],
  [C.DEX_INSUFFICIENT_FUNDS]: ['insufficient_funds', 'after_state_change'],
  [C.DEX_OVERFLOW]: ['validation', 'none'],
  [C.DEX_NO_PRICE_DATA]: ['state', 'after_state_change'],
  [C.DEX_INVALID_MARKET_CONFIG]: ['validation', 'none'],
  [C.DEX_MARKET_NOT_CONFIGURED]: ['configuration', 'none'],
  [C.DEX_INVALID_ORACLE_PRICE]: ['state', 'after_state_change'],
  [C.DEX_ORACLE_ZERO_VOLUME]: ['state', 'after_state_change'],
  [C.DEX_ORACLE_LOW_VOLUME]: ['state', 'after_state_change'],
  [C.DEX_ORACLE_STALE]: ['state', 'after_state_change'],
  [C.DEX_ORACLE_PAUSED]: ['unavailable', 'backoff'],
  [C.DEX_PRICE_DEVIATION_EXCEEDED]: ['validation', 'none'],
  [C.DEX_LEDGER_VOLUME_EXCEEDED]: ['unavailable', 'backoff'],
  [C.DEX_INVALID_COMMITMENT]: ['validation', 'none'],
  [C.DEX_REVEAL_TOO_EARLY]: ['state', 'after_state_change'],
  [C.DEX_REVEAL_WINDOW_CLOSED]: ['state', 'none'],
  [C.DEX_TRANSFER_PRECONDITION_FAILED]: ['state', 'none'],

  [C.REGISTRY_NOT_INITIALIZED]: ['configuration', 'none'],
  [C.REGISTRY_UNAUTHORIZED]: ['authorization', 'none'],
  [C.REGISTRY_PROJECT_NOT_FOUND]: ['not_found', 'none'],
  [C.REGISTRY_PROJECT_ALREADY_EXISTS]: ['conflict', 'none'],
  [C.REGISTRY_INVALID_STATUS_TRANSITION]: ['state', 'none'],
  [C.REGISTRY_INVALID_NONCE]: ['stale_nonce', 'resync_nonce'],
  [C.REGISTRY_INVALID_ARGUMENT]: ['validation', 'none'],

  [C.CREDIT_NOT_INITIALIZED]: ['configuration', 'none'],
  [C.CREDIT_UNAUTHORIZED]: ['authorization', 'none'],
  [C.CREDIT_INSUFFICIENT_CREDITS]: ['insufficient_funds', 'none'],
  [C.CREDIT_ALREADY_RETIRED]: ['conflict', 'none'],
  [C.CREDIT_INVALID_NONCE]: ['stale_nonce', 'resync_nonce'],
  [C.CREDIT_NOT_A_HOLDER]: ['authorization', 'none'],
  [C.CREDIT_INVALID_CERTIFICATE]: ['validation', 'none'],
  [C.CREDIT_INVALID_CREDIT_TYPE]: ['validation', 'none'],

  [C.GOV_NOT_INITIALIZED]: ['configuration', 'none'],
  [C.GOV_UNAUTHORIZED]: ['authorization', 'none'],
  [C.GOV_INVALID_NONCE]: ['stale_nonce', 'resync_nonce'],
  [C.GOV_NOT_SIGNER]: ['authorization', 'none'],
  [C.GOV_PROPOSAL_NOT_FOUND]: ['not_found', 'none'],
  [C.GOV_ALREADY_VOTED]: ['conflict', 'none'],
  [C.GOV_NOT_PENDING]: ['state', 'none'],
  [C.GOV_TIMELOCK_NOT_ELAPSED]: ['state', 'after_state_change'],
  [C.GOV_NOT_QUEUED]: ['state', 'none'],
  [C.GOV_ALREADY_EXECUTED]: ['conflict', 'none'],
  [C.GOV_INVALID_TRACK]: ['validation', 'none'],
  [C.GOV_INSUFFICIENT_VOTING_POWER]: ['authorization', 'none'],
  [C.GOV_QUORUM_NOT_REACHED]: ['state', 'after_state_change'],

  [C.UNKNOWN_CONTRACT_ERROR]: ['unknown', 'none'],
};

const CATEGORY_PREFIXES: Array<[string, ContractErrorCategory]> = [
  ['BOND_', 'BOND'],
  ['ORACLE_', 'ORACLE'],
  ['DEX_', 'DEX'],
  ['REGISTRY_', 'REGISTRY'],
  ['CREDIT_', 'CREDIT'],
  ['GOV_', 'GOVERNANCE'],
];

function isStableErrorCode(code: string): code is StableErrorCode {
  return Object.prototype.hasOwnProperty.call(CONTRACT_ERROR_CLASSIFICATION, code);
}

/**
 * Resolves the consumer-facing descriptor for a contract error.
 *
 * Edge cases:
 * - A code outside `StableErrorCode` is treated as `UNKNOWN_CONTRACT_ERROR`.
 * - `UNKNOWN_CONTRACT_ERROR` *without* a raw contract code means the network
 *   rejected the submission before any contract ran (e.g. `tx_bad_seq`);
 *   that is a transport failure and keeps the legacy retryable behaviour.
 * - `UNKNOWN_CONTRACT_ERROR` *with* a raw code means the contract returned a
 *   discriminant the API does not know (enum drift); retrying will not help.
 */
export function describeContractError(code: string, rawErrorCode?: number): ContractErrorDescriptor {
  const stable: StableErrorCode = isStableErrorCode(code) ? code : StableErrorCode.UNKNOWN_CONTRACT_ERROR;
  const category = CATEGORY_PREFIXES.find(([prefix]) => stable.startsWith(prefix))?.[1] ?? 'UNKNOWN';

  if (stable === StableErrorCode.UNKNOWN_CONTRACT_ERROR && rawErrorCode === undefined) {
    return { code: stable, category, errorClass: 'submission', retryStrategy: 'backoff', retryable: true };
  }

  const [errorClass, retryStrategy] = CONTRACT_ERROR_CLASSIFICATION[stable];
  return {
    code: stable,
    category,
    errorClass,
    retryStrategy,
    retryable: retryStrategy === 'resync_nonce' || retryStrategy === 'backoff',
  };
}

/** Curated, client-safe message for a stable code, or undefined for unknown codes. */
export function stableContractMessage(code: string): string | undefined {
  for (const category of Object.values(ERROR_MAPPINGS)) {
    for (const entry of Object.values(category)) {
      if (entry.code === code) return entry.message;
    }
  }
  return undefined;
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

  /** Consumer-facing classification of this error (#641). */
  get descriptor(): ContractErrorDescriptor {
    return describeContractError(this.code, this.rawErrorCode);
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
    15: { code: StableErrorCode.BOND_PERFORMANCE_FLAGGED, message: 'Coupon distribution is paused: performance change is outside the allowed bounds' },
    16: { code: StableErrorCode.BOND_INSUFFICIENT_ATTESTATIONS, message: 'Oracle report has too few independent attestations' },
    17: { code: StableErrorCode.BOND_MIGRATION_IN_PROGRESS, message: 'Coupon operations are paused during a migration' },
    18: { code: StableErrorCode.BOND_ORACLE_STALE, message: 'Oracle data is too stale; manual intervention is required before distribution' },
    19: { code: StableErrorCode.BOND_PROJECT_DISPUTED, message: 'Project is disputed; coupon distribution is frozen' },
    20: { code: StableErrorCode.BOND_INVALID_WATERFALL, message: 'Default waterfall priorities or balances are invalid' },
    21: { code: StableErrorCode.BOND_WATERFALL_ALREADY_CLAIMED, message: 'Holder already claimed this waterfall priority' },
    22: { code: StableErrorCode.BOND_INVALID_BALANCE_SNAPSHOT, message: 'Requested balance checkpoint is newer than the stored snapshot' },
    23: { code: StableErrorCode.BOND_REDEMPTION_QUEUE_REQUIRED, message: 'Redemption must go through the redemption queue' },
    24: { code: StableErrorCode.BOND_DUPLICATE_REDEMPTION_REQUEST, message: 'A redemption request for this holder is already queued' },
    25: { code: StableErrorCode.BOND_INVALID_REDEMPTION_BUDGET, message: 'Invalid redemption budget' },
    26: { code: StableErrorCode.BOND_AUCTION_REQUIRED, message: 'Subscription must go through the primary auction' },
    27: { code: StableErrorCode.BOND_INVALID_AUCTION, message: 'Invalid auction parameters' },
    28: { code: StableErrorCode.BOND_AUCTION_CLOSED, message: 'Primary subscription auction is closed' },
    29: { code: StableErrorCode.BOND_SUBSCRIPTION_INELIGIBLE, message: 'Investor is not eligible to subscribe' },
    30: { code: StableErrorCode.BOND_IDENTITY_CAP_EXCEEDED, message: 'Subscription exceeds the per-identity cap' },
    31: { code: StableErrorCode.BOND_INVALID_COVENANT, message: 'Invalid tranche covenant' },
    32: { code: StableErrorCode.BOND_INVALID_EQUIVALENCE, message: 'Invalid credit equivalence definition' },
    33: { code: StableErrorCode.BOND_UNKNOWN_EQUIVALENCE, message: 'Credit equivalence is not registered' },
    34: { code: StableErrorCode.BOND_ADMIN_TRANSFER_PENDING, message: 'An admin ownership transfer is already pending' },
    35: { code: StableErrorCode.BOND_ADMIN_TRANSFER_EXPIRED, message: 'Admin ownership transfer acceptance window has elapsed' },
    36: { code: StableErrorCode.BOND_NO_ADMIN_TRANSFER_PENDING, message: 'No admin ownership transfer is pending' },
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
    13: { code: StableErrorCode.ORACLE_INSUFFICIENT_QUORUM, message: 'Not enough oracle sources to reach quorum' },
    14: { code: StableErrorCode.ORACLE_STALE, message: 'Oracle data is stale' },
    15: { code: StableErrorCode.ORACLE_DISPUTE_BOND_INSUFFICIENT, message: 'Dispute bond is below the required amount' },
    16: { code: StableErrorCode.ORACLE_PROJECT_DISPUTED, message: 'Project is under dispute' },
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
    12: { code: StableErrorCode.DEX_NO_PRICE_DATA, message: 'No price data is available for this market' },
    13: { code: StableErrorCode.DEX_INVALID_MARKET_CONFIG, message: 'Invalid market configuration' },
    14: { code: StableErrorCode.DEX_MARKET_NOT_CONFIGURED, message: 'Market is not configured' },
    15: { code: StableErrorCode.DEX_INVALID_ORACLE_PRICE, message: 'Oracle price is invalid' },
    16: { code: StableErrorCode.DEX_ORACLE_ZERO_VOLUME, message: 'Oracle reported zero volume' },
    17: { code: StableErrorCode.DEX_ORACLE_LOW_VOLUME, message: 'Oracle volume is below the trading minimum' },
    18: { code: StableErrorCode.DEX_ORACLE_STALE, message: 'Oracle price is stale' },
    19: { code: StableErrorCode.DEX_ORACLE_PAUSED, message: 'Oracle price feed is paused' },
    20: { code: StableErrorCode.DEX_PRICE_DEVIATION_EXCEEDED, message: 'Trade price deviates too far from the reference price' },
    21: { code: StableErrorCode.DEX_LEDGER_VOLUME_EXCEEDED, message: 'Per-ledger trading volume limit reached' },
    22: { code: StableErrorCode.DEX_INVALID_COMMITMENT, message: 'Invalid order commitment' },
    23: { code: StableErrorCode.DEX_REVEAL_TOO_EARLY, message: 'Commitment reveal window has not opened' },
    24: { code: StableErrorCode.DEX_REVEAL_WINDOW_CLOSED, message: 'Commitment reveal window has closed' },
    40: { code: StableErrorCode.DEX_TRANSFER_PRECONDITION_FAILED, message: 'Bond transfer precondition failed' },
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
    11: { code: StableErrorCode.GOV_INVALID_TRACK, message: 'Invalid governance track' },
    12: { code: StableErrorCode.GOV_INSUFFICIENT_VOTING_POWER, message: 'Signer has insufficient voting power' },
    13: { code: StableErrorCode.GOV_QUORUM_NOT_REACHED, message: 'Governance quorum has not been reached' },
  },
};
