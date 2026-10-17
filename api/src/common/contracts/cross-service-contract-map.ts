/**
 * Cross-Service Contract Map for Domain Events and Integration Boundaries.
 *
 * Formalizes producer-consumer topologies, required payload schemas,
 * semver evolution rules, and allowed failure behaviors across Soroban contracts,
 * off-chain oracle feeds, API event ledger, and client consumers.
 *
 * Resolves Issue #368.
 */

export type ServiceEntity =
  | 'contract:BondIssuer'
  | 'contract:CouponEngine'
  | 'contract:OracleConsumer'
  | 'contract:DEXRouter'
  | 'contract:ProjectRegistry'
  | 'oracle:DataFeeder'
  | 'oracle:Sentinel'
  | 'api:EventLedger'
  | 'api:SettlementService'
  | 'api:ComplianceService'
  | 'api:NotificationDispatcher'
  | 'client:InvestorPortal'
  | 'client:PublicStatusFeed';

export type AllowedFailureBehavior =
  | 'fail-closed'          // Atomic revert; aborts transaction and locks state to prevent loss of funds.
  | 'dead-letter-retry'    // Asynchronous DLQ; retries up to 5 times with exponential backoff before alert.
  | 'circuit-breaker-pause'; // Trips breaker; switches subsystem to degraded/paused state.

export type SemverEvolutionRule =
  | 'additive-only'       // New fields must be optional; old fields never removed or renamed without major bump.
  | 'immutable-strict'    // Zero schema mutation allowed (e.g. cryptographic hashes, signature payloads).
  | 'deprecate-with-fallback'; // Deprecated fields must resolve to canonical replacements for 2 minor versions.

export interface FieldDefinition {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'address' | 'bytes32';
  required: boolean;
  description: string;
  pattern?: string;
}

export interface ServiceContract {
  eventName: string;
  producer: ServiceEntity;
  consumers: Array<{
    consumer: ServiceEntity;
    channel: 'stellar-event-stream' | 'redis-pubsub' | 'ledger-append' | 'websocket-push' | 'rest-webhook';
    mode: 'synchronous' | 'asynchronous';
  }>;
  payloadSchema: FieldDefinition[];
  schemaVersion: string;
  semverRule: SemverEvolutionRule;
  allowedFailureBehavior: AllowedFailureBehavior;
  description: string;
}

export interface CrossServiceDomainEvent {
  eventName: string;
  schemaVersion: string;
  producer: ServiceEntity;
  timestamp: string;
  correlationId?: string;
  payload: Record<string, any>;
}

export interface ContractValidationResult {
  valid: boolean;
  contract?: ServiceContract;
  errors: string[];
}

/**
 * Authoritative Cross-Service Contract Map.
 * Maps every domain event across the protocol boundaries.
 */
export const CROSS_SERVICE_CONTRACT_MAP: Record<string, ServiceContract> = {
  // ── 1. Bond Lifecycle Contracts ───────────────────────────────────────────
  'bond.issued': {
    eventName: 'bond.issued',
    producer: 'contract:BondIssuer',
    consumers: [
      { consumer: 'api:EventLedger', channel: 'stellar-event-stream', mode: 'asynchronous' },
      { consumer: 'contract:CouponEngine', channel: 'stellar-event-stream', mode: 'synchronous' },
      { consumer: 'client:InvestorPortal', channel: 'websocket-push', mode: 'asynchronous' },
    ],
    payloadSchema: [
      { name: 'bondId', type: 'number', required: true, description: 'Unique integer identifier of the bond' },
      { name: 'projectId', type: 'bytes32', required: true, description: '32-byte hex hash of the registered green project' },
      { name: 'issuer', type: 'address', required: true, description: 'Stellar account address of the bond issuer' },
      { name: 'faceValue', type: 'string', required: true, description: 'Total face value in integer Stroops/cents' },
      { name: 'maturityTimestamp', type: 'number', required: true, description: 'Unix epoch seconds of bond maturity' },
    ],
    schemaVersion: '1.0.0',
    semverRule: 'additive-only',
    allowedFailureBehavior: 'fail-closed',
    description: 'Emitted when a new green bond is minted and opened for primary subscription.',
  },

  'subscription.allocated': {
    eventName: 'subscription.allocated',
    producer: 'contract:BondIssuer',
    consumers: [
      { consumer: 'api:EventLedger', channel: 'stellar-event-stream', mode: 'asynchronous' },
      { consumer: 'client:InvestorPortal', channel: 'websocket-push', mode: 'asynchronous' },
    ],
    payloadSchema: [
      { name: 'bondId', type: 'number', required: true, description: 'Bond identifier' },
      { name: 'investor', type: 'address', required: true, description: 'Investor wallet address' },
      { name: 'amount', type: 'string', required: true, description: 'Number of bond tokens allocated' },
      { name: 'paymentAmount', type: 'string', required: true, description: 'USDC/XLM payment transferred' },
    ],
    schemaVersion: '1.0.0',
    semverRule: 'additive-only',
    allowedFailureBehavior: 'fail-closed',
    description: 'Emitted when an investor subscription is filled in the primary issuance auction.',
  },

  // ── 2. Coupon & Carbon Credit Contracts ────────────────────────────────────
  'coupon.distributed': {
    eventName: 'coupon.distributed',
    producer: 'contract:CouponEngine',
    consumers: [
      { consumer: 'api:EventLedger', channel: 'stellar-event-stream', mode: 'asynchronous' },
      { consumer: 'api:NotificationDispatcher', channel: 'redis-pubsub', mode: 'asynchronous' },
      { consumer: 'client:InvestorPortal', channel: 'websocket-push', mode: 'asynchronous' },
    ],
    payloadSchema: [
      { name: 'bondId', type: 'number', required: true, description: 'Bond identifier' },
      { name: 'periodIndex', type: 'number', required: true, description: 'Index of coupon distribution cycle' },
      { name: 'totalHolderCredits', type: 'string', required: true, description: 'Total carbon credits distributed' },
      { name: 'holderCount', type: 'number', required: true, description: 'Number of active eligible holders' },
    ],
    schemaVersion: '1.0.0',
    semverRule: 'additive-only',
    allowedFailureBehavior: 'dead-letter-retry',
    description: 'Emitted when coupon engine disburses verified carbon credit yields to token holders.',
  },

  // ── 3. Oracle Data & Governance Boundaries ────────────────────────────────
  'oracle.report_submitted': {
    eventName: 'oracle.report_submitted',
    producer: 'oracle:DataFeeder',
    consumers: [
      { consumer: 'contract:OracleConsumer', channel: 'stellar-event-stream', mode: 'synchronous' },
      { consumer: 'api:EventLedger', channel: 'redis-pubsub', mode: 'asynchronous' },
      { consumer: 'client:PublicStatusFeed', channel: 'rest-webhook', mode: 'asynchronous' },
    ],
    payloadSchema: [
      { name: 'reportId', type: 'number', required: true, description: 'Unique report identifier' },
      { name: 'provider', type: 'address', required: true, description: 'Stellar address of oracle provider' },
      { name: 'projectId', type: 'bytes32', required: true, description: 'Associated green project hash' },
      { name: 'satelliteDataHash', type: 'string', required: true, description: 'IPFS CID or SHA-256 telemetry hash' },
      { name: 'carbonTonsCalculated', type: 'number', required: true, description: 'Derived metric of carbon sequestration' },
    ],
    schemaVersion: '1.1.0',
    semverRule: 'additive-only',
    allowedFailureBehavior: 'circuit-breaker-pause',
    description: 'Emitted when off-chain telemetry feeder registers environmental sensor measurements.',
  },

  'oracle.provider_slashed': {
    eventName: 'oracle.provider_slashed',
    producer: 'contract:OracleConsumer',
    consumers: [
      { consumer: 'api:EventLedger', channel: 'stellar-event-stream', mode: 'asynchronous' },
      { consumer: 'client:PublicStatusFeed', channel: 'rest-webhook', mode: 'asynchronous' },
    ],
    payloadSchema: [
      { name: 'provider', type: 'address', required: true, description: 'Slashed provider address' },
      { name: 'penaltyAmount', type: 'string', required: true, description: 'Stake slashed in Stroops' },
      { name: 'remainingStake', type: 'string', required: true, description: 'Remaining stake held in contract' },
      { name: 'isActive', type: 'boolean', required: true, description: 'Whether provider remains in active set' },
    ],
    schemaVersion: '1.0.0',
    semverRule: 'immutable-strict',
    allowedFailureBehavior: 'fail-closed',
    description: 'Emitted when governance resolves a challenge against an oracle report and slashes stake.',
  },

  // ── 4. Secondary Market DEX Settlement ────────────────────────────────────
  'order.filled': {
    eventName: 'order.filled',
    producer: 'contract:DEXRouter',
    consumers: [
      { consumer: 'api:EventLedger', channel: 'stellar-event-stream', mode: 'asynchronous' },
      { consumer: 'api:SettlementService', channel: 'redis-pubsub', mode: 'asynchronous' },
      { consumer: 'client:InvestorPortal', channel: 'websocket-push', mode: 'asynchronous' },
    ],
    payloadSchema: [
      { name: 'orderId', type: 'number', required: true, description: 'Order book listing ID' },
      { name: 'buyer', type: 'address', required: true, description: 'Buyer address' },
      { name: 'seller', type: 'address', required: true, description: 'Seller address' },
      { name: 'filledAmount', type: 'string', required: true, description: 'Bond token units transferred' },
      { name: 'totalCost', type: 'string', required: true, description: 'Settlement cost paid in quote asset' },
    ],
    schemaVersion: '1.0.0',
    semverRule: 'immutable-strict',
    allowedFailureBehavior: 'fail-closed',
    description: 'Emitted upon atomic fulfillment of a secondary market bond order.',
  },

  // ── 5. Compliance & Privileged Ledger Events ──────────────────────────────
  'kyc.override': {
    eventName: 'kyc.override',
    producer: 'api:ComplianceService',
    consumers: [
      { consumer: 'api:EventLedger', channel: 'ledger-append', mode: 'synchronous' },
      { consumer: 'client:InvestorPortal', channel: 'rest-webhook', mode: 'asynchronous' },
    ],
    payloadSchema: [
      { name: 'operatorAddress', type: 'address', required: true, description: 'Compliance officer initiating action' },
      { name: 'subjectWallet', type: 'address', required: true, description: 'Target user wallet address' },
      { name: 'previousTier', type: 'string', required: true, description: 'Previous KYC tier' },
      { name: 'newTier', type: 'string', required: true, description: 'Newly approved KYC tier' },
      { name: 'jurisdiction', type: 'string', required: true, description: 'ISO 3166-1 alpha-2 jurisdiction code' },
      { name: 'reason', type: 'string', required: true, description: 'Compliance audit justification' },
    ],
    schemaVersion: '1.0.0',
    semverRule: 'additive-only',
    allowedFailureBehavior: 'fail-closed',
    description: 'Privileged compliance event adjusting user accredited investor tier.',
  },
};

/**
 * Validates a domain event payload against its authoritative contract definition.
 */
export function validateCrossServiceEvent(
  event: CrossServiceDomainEvent,
): ContractValidationResult {
  const contract = CROSS_SERVICE_CONTRACT_MAP[event.eventName];
  if (!contract) {
    return {
      valid: false,
      errors: [`Unregistered domain event name: "${event.eventName}"`],
    };
  }

  const errors: string[] = [];

  // Verify Producer
  if (event.producer !== contract.producer) {
    errors.push(
      `Producer mismatch: expected "${contract.producer}", got "${event.producer}" for event "${event.eventName}"`,
    );
  }

  // Verify SemVer Compatibility (Major version must match)
  const eventMajor = event.schemaVersion.split('.')[0];
  const contractMajor = contract.schemaVersion.split('.')[0];
  if (eventMajor !== contractMajor) {
    errors.push(
      `Incompatible schema version: contract requires major version ${contractMajor}.x, event supplied ${event.schemaVersion}`,
    );
  }

  // Validate Required Fields and Types
  for (const field of contract.payloadSchema) {
    const value = event.payload?.[field.name];
    if (field.required && (value === undefined || value === null)) {
      errors.push(`Missing required field "${field.name}" in event "${event.eventName}" payload`);
      continue;
    }

    if (value !== undefined && value !== null) {
      if (field.type === 'address') {
        if (typeof value !== 'string' || !/^G[A-Z0-9]{55}$/.test(value)) {
          errors.push(`Field "${field.name}" must be a valid Stellar public address (G...), got: ${value}`);
        }
      } else if (field.type === 'bytes32') {
        if (typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value)) {
          errors.push(`Field "${field.name}" must be a 64-character hex string, got: ${value}`);
        }
      } else if (field.type === 'number') {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          errors.push(`Field "${field.name}" must be a finite number, got: ${typeof value}`);
        }
      } else if (field.type === 'string') {
        if (typeof value !== 'string') {
          errors.push(`Field "${field.name}" must be a string, got: ${typeof value}`);
        }
      } else if (field.type === 'boolean') {
        if (typeof value !== 'boolean') {
          errors.push(`Field "${field.name}" must be a boolean, got: ${typeof value}`);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    contract,
    errors,
  };
}

/**
 * Queries all contracts produced by a given service.
 */
export function getContractsByProducer(producer: ServiceEntity): ServiceContract[] {
  return Object.values(CROSS_SERVICE_CONTRACT_MAP).filter((c) => c.producer === producer);
}

/**
 * Queries all contracts consumed by a given service.
 */
export function getContractsByConsumer(consumer: ServiceEntity): ServiceContract[] {
  return Object.values(CROSS_SERVICE_CONTRACT_MAP).filter((c) =>
    c.consumers.some((sub) => sub.consumer === consumer),
  );
}
