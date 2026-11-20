import { Keypair, StrKey } from '@stellar/stellar-sdk';
import {
  checkConfigContract,
  compareEnvironments,
  CONTRACT_ID_VARS,
  DeployTarget,
  EnvMap,
} from './config-contract';

const key = (n: number) => Keypair.fromRawEd25519Seed(Buffer.alloc(32, n));
const contract = (n: number) => StrKey.encodeContract(Buffer.alloc(32, n));
const secret = (tag: string) => `${tag}-${'x9'.repeat(24)}`;

/** A complete, contract-satisfying profile; `salt` keeps environments distinct. */
function profile(target: DeployTarget, salt: number): EnvMap {
  const admin = key(salt + 1);
  const provider = key(salt + 4);
  const mainnet = target === 'production';
  const env: EnvMap = {
    NODE_ENV: target === 'development' ? 'development' : 'production',
    STELLAR_NETWORK: mainnet ? 'mainnet' : 'testnet',
    STELLAR_HORIZON_URL: mainnet ? 'https://horizon.stellar.org' : 'https://horizon-testnet.stellar.org',
    SOROBAN_RPC_URL: mainnet ? 'https://rpc.verdant.example' : 'https://soroban-testnet.stellar.org',
    STELLAR_PUBLIC_KEY: admin.publicKey(),
    ADMIN_SECRET_KEY: admin.secret(),
    INVESTOR_SECRET_KEY: key(salt + 2).secret(),
    USER_SECRET_KEY: key(salt + 3).secret(),
    DATABASE_URL: `postgresql://app@db-${target}.internal:5432/verdant`,
    REDIS_URL: `redis://cache-${target}.internal:6379`,
    JWT_SECRET: secret(`jwt-${salt}`),
    JWT_REFRESH_SECRET: secret(`refresh-${salt}`),
    IPFS_API_URL: 'https://api.pinata.cloud',
    IPFS_API_KEY: `ipfs-${salt}`,
    IPFS_GATEWAY: 'https://gateway.pinata.cloud/ipfs/',
    ORACLE_PROVIDER_WHITELIST: `${provider.publicKey()},${key(salt + 5).publicKey()}`,
    DEFAULT_PROVIDER_ADDRESS: provider.publicKey(),
    KYC_PROVIDER_URL: 'https://kyc.verdant.example',
    KYC_API_KEY: `kyc-${salt}`,
    AUDIT_EVIDENCE_PEPPER: secret(`pepper-${salt}`),
    APP_URL: `https://${target}.verdant.example`,
  };
  CONTRACT_ID_VARS.forEach((name, i) => (env[name] = contract(salt + 10 + i)));
  return env;
}

const codes = (env: EnvMap, target: DeployTarget) => checkConfigContract(env, target).map((v) => `${v.field}:${v.code}`);

describe('configuration contract (#352)', () => {
  it.each<DeployTarget>(['development', 'staging', 'production'])('accepts a complete %s profile', (target) => {
    expect(checkConfigContract(profile(target, 0), target)).toEqual([]);
  });

  it('accepts the repository .env.example shape for development once placeholders are filled', () => {
    const dev = profile('development', 0);
    dev.REDIS_URL = 'redis://localhost:6379';
    dev.DATABASE_URL = 'postgresql://user@localhost:5432/verdant_bond';
    dev.SOROBAN_RPC_URL = 'http://localhost:8000/soroban/rpc';
    dev.STELLAR_NETWORK = 'standalone';
    expect(checkConfigContract(dev, 'development')).toEqual([]);
  });

  describe('required settings', () => {
    it.each([
      ['production', 'AUDIT_EVIDENCE_PEPPER'],
      ['production', 'KYC_API_KEY'],
      ['production', 'GOVERNANCE_ADDRESS'],
      ['staging', 'STELLAR_PUBLIC_KEY'],
      ['development', 'BOND_ISSUER_ADDRESS'],
      ['development', 'ORACLE_PROVIDER_WHITELIST'],
    ] as [DeployTarget, string][])('%s fails without %s', (target, name) => {
      const env = profile(target, 0);
      delete env[name];
      expect(codes(env, target)).toContain(`${name}:MISSING`);
      env[name] = '   ';
      expect(codes(env, target)).toContain(`${name}:MISSING`);
    });

    it('does not demand production-only settings in development', () => {
      const env = profile('development', 0);
      delete env.AUDIT_EVIDENCE_PEPPER;
      delete env.KYC_API_KEY;
      expect(checkConfigContract(env, 'development')).toEqual([]);
    });
  });

  describe('network consistency', () => {
    it('rejects production on testnet and staging on mainnet', () => {
      const prod = { ...profile('production', 0), STELLAR_NETWORK: 'testnet' };
      expect(codes(prod, 'production')).toContain('STELLAR_NETWORK:NETWORK_MISMATCH');
      const stg = { ...profile('staging', 0), STELLAR_NETWORK: 'mainnet' };
      expect(codes(stg, 'staging')).toContain('STELLAR_NETWORK:NETWORK_MISMATCH');
    });

    it('rejects a mainnet deployment pointed at testnet endpoints', () => {
      const env = { ...profile('production', 0), SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org' };
      expect(codes(env, 'production')).toContain('SOROBAN_RPC_URL:ENDPOINT_NETWORK_MISMATCH');
    });

    it('rejects a testnet deployment pointed at mainnet Horizon', () => {
      const env = { ...profile('staging', 0), STELLAR_HORIZON_URL: 'https://horizon.stellar.org' };
      expect(codes(env, 'staging')).toContain('STELLAR_HORIZON_URL:ENDPOINT_NETWORK_MISMATCH');
    });

    it('rejects NODE_ENV=development in production', () => {
      expect(codes({ ...profile('production', 0), NODE_ENV: 'development' }, 'production')).toContain(
        'NODE_ENV:NODE_ENV_MISMATCH',
      );
    });
  });

  describe('urls', () => {
    it.each(['KYC_PROVIDER_URL', 'IPFS_API_URL', 'APP_URL'])('requires https for %s outside development', (name) => {
      const env = profile('production', 0);
      env[name] = env[name]!.replace('https:', 'http:');
      expect(codes(env, 'production')).toContain(`${name}:INSECURE_URL`);
      expect(codes({ ...profile('development', 0), [name]: env[name] }, 'development')).toEqual([]);
    });

    it('rejects loopback databases and caches in production', () => {
      const env = { ...profile('production', 0), REDIS_URL: 'redis://127.0.0.1:6379' };
      expect(codes(env, 'production')).toContain('REDIS_URL:LOOPBACK_URL');
    });

    it('rejects malformed URLs everywhere', () => {
      expect(codes({ ...profile('development', 0), IPFS_GATEWAY: 'gateway.pinata' }, 'development')).toContain(
        'IPFS_GATEWAY:INVALID_URL',
      );
    });
  });

  describe('contract ids', () => {
    it('rejects an account key where a contract id belongs', () => {
      const env = { ...profile('staging', 0), DEX_ROUTER_ADDRESS: key(99).publicKey() };
      expect(codes(env, 'staging')).toContain('DEX_ROUTER_ADDRESS:INVALID_CONTRACT_ID');
    });

    it('rejects one contract id reused for two roles', () => {
      const env = profile('production', 0);
      env.COUPON_ENGINE_ADDRESS = env.BOND_ISSUER_ADDRESS;
      expect(codes(env, 'production')).toContain('COUPON_ENGINE_ADDRESS:DUPLICATE_CONTRACT_ID');
    });
  });

  describe('signers and secrets', () => {
    it('rejects an admin key that does not match the published admin address', () => {
      const env = { ...profile('production', 0), STELLAR_PUBLIC_KEY: key(77).publicKey() };
      expect(codes(env, 'production')).toContain('STELLAR_PUBLIC_KEY:ADMIN_KEY_MISMATCH');
    });

    it('rejects the admin key doubling as the investor key outside development', () => {
      const env = profile('staging', 0);
      env.INVESTOR_SECRET_KEY = env.ADMIN_SECRET_KEY;
      expect(codes(env, 'staging')).toContain('INVESTOR_SECRET_KEY:SHARED_SIGNER');
    });

    it('accepts a distinct intent receipt signing key and treats it as optional', () => {
      const env = profile('production', 0);
      expect(codes(env, 'production')).toEqual([]);
      env.INTENT_RECEIPT_SIGNING_SECRET = key(90).secret();
      expect(codes(env, 'production')).toEqual([]);
    });

    it('rejects an intent receipt signing key that is malformed or reuses an operator key', () => {
      const env = profile('production', 0);
      env.INTENT_RECEIPT_SIGNING_SECRET = 'not-a-seed';
      expect(codes(env, 'production')).toContain('INTENT_RECEIPT_SIGNING_SECRET:INVALID_SECRET_SEED');
      env.INTENT_RECEIPT_SIGNING_SECRET = env.ADMIN_SECRET_KEY;
      expect(codes(env, 'production')).toContain('INTENT_RECEIPT_SIGNING_SECRET:SHARED_SIGNER');
    });

    it('rejects malformed secret seeds', () => {
      expect(codes({ ...profile('development', 0), USER_SECRET_KEY: 'S...' }, 'development')).toContain(
        'USER_SECRET_KEY:INVALID_SECRET_SEED',
      );
    });

    it('rejects JWT refresh secret equal to the access secret', () => {
      const env = profile('production', 0);
      env.JWT_REFRESH_SECRET = env.JWT_SECRET;
      expect(codes(env, 'production')).toContain('JWT_REFRESH_SECRET:SHARED_SECRET');
    });

    it('rejects file-based signing keys in production only', () => {
      expect(codes({ ...profile('production', 0), SIGNING_KEY_PROVIDER: 'file' }, 'production')).toContain(
        'SIGNING_KEY_PROVIDER:FILE_SIGNER_IN_PRODUCTION',
      );
      expect(codes({ ...profile('staging', 0), SIGNING_KEY_PROVIDER: 'file' }, 'staging')).toEqual([]);
    });

    it('never echoes secret values in violation messages', () => {
      const env = profile('production', 0);
      env.JWT_REFRESH_SECRET = env.JWT_SECRET;
      env.INVESTOR_SECRET_KEY = env.ADMIN_SECRET_KEY;
      const text = JSON.stringify(checkConfigContract(env, 'production'));
      expect(text).not.toContain(env.JWT_SECRET);
      expect(text).not.toContain(env.ADMIN_SECRET_KEY);
    });
  });

  describe('oracle trust root', () => {
    it('rejects a default provider outside the whitelist', () => {
      const env = { ...profile('production', 0), DEFAULT_PROVIDER_ADDRESS: key(55).publicKey() };
      expect(codes(env, 'production')).toContain('DEFAULT_PROVIDER_ADDRESS:PROVIDER_NOT_WHITELISTED');
    });

    it('rejects a malformed whitelist entry', () => {
      const env = { ...profile('staging', 0) };
      env.ORACLE_PROVIDER_WHITELIST += ',G...';
      expect(codes(env, 'staging')).toContain('ORACLE_PROVIDER_WHITELIST:INVALID_PROVIDER');
    });
  });

  describe('cross-environment', () => {
    it('accepts independent staging and production', () => {
      expect(compareEnvironments(profile('staging', 0), 'staging', profile('production', 100), 'production')).toEqual([]);
    });

    it.each(['JWT_SECRET', 'ADMIN_SECRET_KEY', 'AUDIT_EVIDENCE_PEPPER', 'DATABASE_URL', 'BOND_ISSUER_ADDRESS'])(
      'fails when %s is shared between staging and production',
      (name) => {
        const stg = profile('staging', 0);
        const prod = { ...profile('production', 100), [name]: stg[name] };
        const result = compareEnvironments(stg, 'staging', prod, 'production');
        expect(result.map((v) => `${v.field}:${v.code}`)).toEqual([`${name}:SHARED_ACROSS_ENVIRONMENTS`]);
        expect(JSON.stringify(result)).not.toContain(stg[name]!);
      },
    );
  });
});
