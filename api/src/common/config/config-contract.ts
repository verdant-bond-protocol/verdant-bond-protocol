/**
 * Cross-environment configuration contract (#352).
 *
 * EnvConfigValidator checks each variable on its own at boot. This contract
 * checks what only makes sense across variables and across environments:
 * the network, its endpoints and the deployment target agree; contract ids
 * and signer keys are distinct; the admin key matches the published admin
 * address; production never shares secrets or contract ids with staging.
 *
 * Pure functions over an env map, so CI can check rendered .env files before
 * a deploy (scripts/config-contract.ts) without booting the app. Not wired into
 * startup: see docs/config-contract.md for the rollout plan.
 */
import { Keypair, StrKey } from '@stellar/stellar-sdk';

export type DeployTarget = 'development' | 'staging' | 'production';
export type EnvMap = Record<string, string | undefined>;

export interface ContractViolation {
  field: string;
  code: string;
  message: string;
}

export const CONTRACT_ID_VARS = [
  'BOND_ISSUER_ADDRESS',
  'COUPON_ENGINE_ADDRESS',
  'DEX_ROUTER_ADDRESS',
  'PROJECT_REGISTRY_ADDRESS',
  'ORACLE_CONSUMER_ADDRESS',
  'CREDIT_RETIREMENT_ADDRESS',
  'GOVERNANCE_ADDRESS',
] as const;

const SIGNER_SECRET_VARS = ['ADMIN_SECRET_KEY', 'INVESTOR_SECRET_KEY', 'USER_SECRET_KEY'] as const;

/** Values that must never be shared between two environments. */
export const ENV_UNIQUE_VARS = [
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  ...SIGNER_SECRET_VARS,
  'IPFS_SECRET_KEY',
  'KYC_API_KEY',
  'AUDIT_EVIDENCE_PEPPER',
  'INTENT_RECEIPT_SIGNING_SECRET',
  'DATABASE_URL',
  ...CONTRACT_ID_VARS,
] as const;

const BASE_REQUIRED = [
  'NODE_ENV',
  'STELLAR_NETWORK',
  'STELLAR_HORIZON_URL',
  'SOROBAN_RPC_URL',
  ...CONTRACT_ID_VARS.filter((v) => v !== 'GOVERNANCE_ADDRESS'),
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  ...SIGNER_SECRET_VARS,
  'IPFS_API_URL',
  'IPFS_API_KEY',
  'ORACLE_PROVIDER_WHITELIST',
];

const REQUIRED: Record<DeployTarget, string[]> = {
  development: BASE_REQUIRED,
  staging: [...BASE_REQUIRED, 'STELLAR_PUBLIC_KEY', 'GOVERNANCE_ADDRESS', 'DEFAULT_PROVIDER_ADDRESS'],
  production: [
    ...BASE_REQUIRED,
    'STELLAR_PUBLIC_KEY',
    'GOVERNANCE_ADDRESS',
    'DEFAULT_PROVIDER_ADDRESS',
    'KYC_PROVIDER_URL',
    'KYC_API_KEY',
    'AUDIT_EVIDENCE_PEPPER',
    'APP_URL',
  ],
};

/** Outbound endpoints: TLS and non-loopback outside development. */
const EXTERNAL_URL_VARS = [
  'STELLAR_HORIZON_URL',
  'SOROBAN_RPC_URL',
  'IPFS_API_URL',
  'IPFS_GATEWAY',
  'KYC_PROVIDER_URL',
  'VERRA_REGISTRY_URL',
  'SATELLITE_API_URL',
  'IOT_API_URL',
  'APP_URL',
];
const INTERNAL_URL_VARS = ['DATABASE_URL', 'REDIS_URL'];

const EXPECTED_NETWORK: Record<DeployTarget, string[]> = {
  development: ['testnet', 'standalone'],
  staging: ['testnet'],
  production: ['mainnet'],
};

const EXPECTED_NODE_ENV: Record<DeployTarget, string[]> = {
  development: ['development', 'test'],
  staging: ['staging', 'production'],
  production: ['production'],
};

const SDF_MAINNET_HOSTS = ['horizon.stellar.org', 'mainnet.sorobanrpc.com'];
const NON_MAINNET_HOST = /(testnet|futurenet|localhost|127\.0\.0\.1|\[::1\])/i;
const LOOPBACK_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i;

const present = (v: string | undefined): v is string => typeof v === 'string' && v.trim() !== '';

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function checkConfigContract(env: EnvMap, target: DeployTarget): ContractViolation[] {
  const out: ContractViolation[] = [];
  const fail = (field: string, code: string, message: string) => out.push({ field, code, message });

  for (const name of REQUIRED[target]) {
    if (!present(env[name])) fail(name, 'MISSING', `${name} is required for ${target}`);
  }

  // Deployment target, runtime mode and network must agree.
  if (present(env.NODE_ENV) && !EXPECTED_NODE_ENV[target].includes(env.NODE_ENV)) {
    fail('NODE_ENV', 'NODE_ENV_MISMATCH', `NODE_ENV=${env.NODE_ENV} is not valid for ${target}`);
  }
  const network = env.STELLAR_NETWORK;
  if (present(network) && !EXPECTED_NETWORK[target].includes(network)) {
    fail('STELLAR_NETWORK', 'NETWORK_MISMATCH', `${target} must use ${EXPECTED_NETWORK[target].join('/')}, got ${network}`);
  }

  // Endpoints must point at the configured network.
  for (const name of ['STELLAR_HORIZON_URL', 'SOROBAN_RPC_URL']) {
    const url = present(env[name]) ? parseUrl(env[name]!) : null;
    if (!url || !present(network)) continue;
    if (network === 'mainnet' && NON_MAINNET_HOST.test(url.host)) {
      fail(name, 'ENDPOINT_NETWORK_MISMATCH', `${name} (${url.host}) is not a mainnet endpoint`);
    }
    if (network !== 'mainnet' && SDF_MAINNET_HOSTS.includes(url.hostname)) {
      fail(name, 'ENDPOINT_NETWORK_MISMATCH', `${name} points at mainnet while STELLAR_NETWORK=${network}`);
    }
  }

  // URLs: well-formed everywhere; TLS and non-loopback outside development.
  for (const name of [...EXTERNAL_URL_VARS, ...INTERNAL_URL_VARS]) {
    if (!present(env[name])) continue;
    const url = parseUrl(env[name]!);
    if (!url) {
      fail(name, 'INVALID_URL', `${name} is not a valid URL`);
      continue;
    }
    if (target === 'development') continue;
    if (LOOPBACK_HOST.test(url.hostname)) fail(name, 'LOOPBACK_URL', `${name} points at a loopback host in ${target}`);
    if (EXTERNAL_URL_VARS.includes(name) && url.protocol !== 'https:') {
      fail(name, 'INSECURE_URL', `${name} must use https in ${target}`);
    }
  }

  // Contract ids: valid and pairwise distinct (a copy-paste reuses one id for two roles).
  const seenContracts = new Map<string, string>();
  for (const name of CONTRACT_ID_VARS) {
    const value = env[name];
    if (!present(value)) continue;
    if (!StrKey.isValidContract(value)) {
      fail(name, 'INVALID_CONTRACT_ID', `${name} is not a Soroban contract id (C…)`);
      continue;
    }
    const other = seenContracts.get(value);
    if (other) fail(name, 'DUPLICATE_CONTRACT_ID', `${name} reuses the contract id of ${other}`);
    else seenContracts.set(value, name);
  }

  // Signer keys: valid seeds, one identity per role, admin matches the published address.
  const seenSigners = new Map<string, string>();
  for (const name of SIGNER_SECRET_VARS) {
    const value = env[name];
    if (!present(value)) continue;
    if (!StrKey.isValidEd25519SecretSeed(value)) {
      fail(name, 'INVALID_SECRET_SEED', `${name} is not a Stellar secret seed (S…)`);
      continue;
    }
    const other = seenSigners.get(value);
    if (other && target !== 'development') fail(name, 'SHARED_SIGNER', `${name} reuses the key of ${other}`);
    else seenSigners.set(value, name);
  }
  // Intent receipt signer (optional; ephemeral key when unset): a distinct
  // identity, so a receipt can never be mistaken for an operator signature.
  const receiptSecret = env.INTENT_RECEIPT_SIGNING_SECRET;
  if (present(receiptSecret)) {
    if (!StrKey.isValidEd25519SecretSeed(receiptSecret)) {
      fail('INTENT_RECEIPT_SIGNING_SECRET', 'INVALID_SECRET_SEED', 'INTENT_RECEIPT_SIGNING_SECRET is not a Stellar secret seed (S…)');
    } else if (seenSigners.has(receiptSecret) && target !== 'development') {
      fail(
        'INTENT_RECEIPT_SIGNING_SECRET',
        'SHARED_SIGNER',
        `INTENT_RECEIPT_SIGNING_SECRET reuses the key of ${seenSigners.get(receiptSecret)}`,
      );
    }
  }
  if (present(env.STELLAR_PUBLIC_KEY) && present(env.ADMIN_SECRET_KEY) && StrKey.isValidEd25519SecretSeed(env.ADMIN_SECRET_KEY)) {
    if (Keypair.fromSecret(env.ADMIN_SECRET_KEY).publicKey() !== env.STELLAR_PUBLIC_KEY) {
      fail('STELLAR_PUBLIC_KEY', 'ADMIN_KEY_MISMATCH', 'STELLAR_PUBLIC_KEY is not the public key of ADMIN_SECRET_KEY');
    }
  }
  if (target === 'production' && env.SIGNING_KEY_PROVIDER === 'file') {
    fail('SIGNING_KEY_PROVIDER', 'FILE_SIGNER_IN_PRODUCTION', 'file-based signing keys are dev/test only');
  }

  // Secrets that must be independent of each other.
  if (present(env.JWT_SECRET) && env.JWT_SECRET === env.JWT_REFRESH_SECRET) {
    fail('JWT_REFRESH_SECRET', 'SHARED_SECRET', 'JWT_REFRESH_SECRET must differ from JWT_SECRET');
  }

  // Oracle trust root: valid accounts, and the scheduler's default is trusted.
  const whitelist = (env.ORACLE_PROVIDER_WHITELIST ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const provider of whitelist) {
    if (!StrKey.isValidEd25519PublicKey(provider)) {
      fail('ORACLE_PROVIDER_WHITELIST', 'INVALID_PROVIDER', `"${provider}" is not a Stellar account (G…)`);
    }
  }
  if (present(env.DEFAULT_PROVIDER_ADDRESS) && whitelist.length && !whitelist.includes(env.DEFAULT_PROVIDER_ADDRESS)) {
    fail('DEFAULT_PROVIDER_ADDRESS', 'PROVIDER_NOT_WHITELISTED', 'DEFAULT_PROVIDER_ADDRESS is not in ORACLE_PROVIDER_WHITELIST');
  }

  return out;
}

/**
 * Compare two environments: secrets, databases and contract ids must not be
 * shared (a staging leak must not be a production compromise).
 */
export function compareEnvironments(a: EnvMap, aName: string, b: EnvMap, bName: string): ContractViolation[] {
  return ENV_UNIQUE_VARS.filter((name) => present(a[name]) && a[name] === b[name]).map((name) => ({
    field: name,
    code: 'SHARED_ACROSS_ENVIRONMENTS',
    message: `${name} is identical in ${aName} and ${bName}`,
  }));
}
