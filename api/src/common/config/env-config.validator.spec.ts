/**
 * Secure secrets and environment configuration validation tests.
 *
 * Tests cover missing, malformed, and unsafe config combinations.
 *
 * See: https://github.com/verdant-bond-protocol/verdant-bond-protocol/issues/278
 */

import { EnvConfigValidator, EnvConfig, WEAK_SECRET_PATTERNS } from './env-config.validator';
import { ConfigService } from '../../config/config.service';

/** Valid Soroban contract IDs (checksummed C… strkeys). */
const CONTRACT = {
  BOND: 'CBBE6TSEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABHW4',
  COUPON: 'CBBU6VKQJ5HAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAHJ',
  REG: 'CBJEKRYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABJ2Z',
  ORACLE: 'CBHVEQKDJRCQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA7QA',
  DEX: 'CBCEKWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAV4',
  CREDIT: 'CBBVERKEJFKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWVM',
  GOV: 'CBDU6VQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATIU',
};

const MOCK_CONFIG = {
  getBondIssuerAddress: jest.fn().mockReturnValue(CONTRACT.BOND),
  getCouponEngineAddress: jest.fn().mockReturnValue(CONTRACT.COUPON),
  getCreditRetirementAddress: jest.fn().mockReturnValue(CONTRACT.CREDIT),
  getDexRouterAddress: jest.fn().mockReturnValue(CONTRACT.DEX),
  getProjectRegistryAddress: jest.fn().mockReturnValue(CONTRACT.REG),
  getOracleConsumerAddress: jest.fn().mockReturnValue(CONTRACT.ORACLE),
  getJwtSecret: jest.fn().mockReturnValue('test-jwt-secret-must-be-long-enough-32chars-min'),
  getJwtRefreshSecret: jest.fn().mockReturnValue('test-jwt-refresh-secret-min-32characters'),
  getJwtExpiry: jest.fn().mockReturnValue('15m'),
  getJwtRefreshExpiry: jest.fn().mockReturnValue('7d'),
};

function setEnv(overrides: Record<string, string> = {}): void {
  process.env.STELLAR_NETWORK = 'testnet';
  process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
  process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
  process.env.BOND_ISSUER_ADDRESS = CONTRACT.BOND;
  process.env.COUPON_ENGINE_ADDRESS = CONTRACT.COUPON;
  process.env.PROJECT_REGISTRY_ADDRESS = CONTRACT.REG;
  process.env.ORACLE_CONSUMER_ADDRESS = CONTRACT.ORACLE;
  process.env.DEX_ROUTER_ADDRESS = CONTRACT.DEX;
  process.env.CREDIT_RETIREMENT_ADDRESS = CONTRACT.CREDIT;
  process.env.GOVERNANCE_ADDRESS = CONTRACT.GOV;
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/test';
  process.env.JWT_SECRET = 'Zq7vN2kLp9xRw4tYh8mB3cF6gJ1sD5aE0uWiKoQe';
  process.env.JWT_REFRESH_SECRET = 'Hn4bV8cX2zM6lK9jG3fD7sA1qW5eR0tYuIoPkLmN';
  process.env.ADMIN_SECRET_KEY = 'Pw3oE7iR1uT5yQ9aS2dF6gH0jK4lZ8xCvBnMqWeR';
  process.env.INVESTOR_SECRET_KEY = 'Lk8jH2gF6dS0aQ4wE9rT3yU7iO1pZ5xCvBnMmQwE';
  process.env.USER_SECRET_KEY = 'Mn5bV9cX3zL7kJ1hG6fD0sA4qW8eR2tYuIoPaSdF';
  process.env.IPFS_API_URL = 'https://api.pinata.cloud';
  process.env.IPFS_API_KEY = 'pinata-key';
  process.env.IPFS_SECRET_KEY = 'Rt6yU0iO4pA8sD2fG7hJ1kL5zX9cV3bNmPzXcVbN';
  process.env.ORACLE_PROVIDER_WHITELIST = 'GPROV';
  process.env.PORT = '3000';
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'debug';
  process.env.APP_URL = 'http://localhost:3000';
  Object.keys(overrides).forEach((key) => {
    if (overrides[key] === undefined || overrides[key] === null) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  });
}

function clearEnv(): void {
  Object.keys(process.env).forEach((key) => {
    if (key.startsWith('STELLAR_') || key.startsWith('BOND_') || key.startsWith('COUPON_') ||
        key.startsWith('PROJECT_') || key.startsWith('ORACLE_') || key.startsWith('DEX_') ||
        key.startsWith('CREDIT_') || key.startsWith('GOVERNANCE_') || key.startsWith('REDIS_') ||
        key.startsWith('DATABASE_') || key.startsWith('JWT_') || key.startsWith('ADMIN_') ||
        key.startsWith('INVESTOR_') || key.startsWith('USER_') || key.startsWith('IPFS_') ||
        key.startsWith('ORACLE_PROVIDER') || key.startsWith('PORT') || key.startsWith('NODE_ENV') ||
        key.startsWith('LOG_LEVEL') || key.startsWith('APP_URL') || key.startsWith('SIGNING_') ||
        key.startsWith('DEFAULT_') || key.startsWith('VERRA_') || key.startsWith('SATELLITE_') ||
        key.startsWith('IOT_') || key.startsWith('KYC_') || key.startsWith('STELLAR_AUTH') ||
        key.startsWith('HOME_DOMAIN') || key.startsWith('BASE_URL')) {
      delete process.env[key];
    }
  });
}

describe('EnvConfigValidator (#278)', () => {
  let validator: EnvConfigValidator;
  let moduleRef: any;

  beforeEach(() => {
    setEnv();
  });

  afterEach(() => {
    clearEnv();
  });

  describe('validateAll', () => {
    it('passes validation with all required env vars set', () => {
      const configService = MOCK_CONFIG;
      validator = new EnvConfigValidator(configService as any);
      const result = validator.validateAll();
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('fails when required contract addresses are missing', () => {
      setEnv({ BOND_ISSUER_ADDRESS: undefined as any });
      const configService = MOCK_CONFIG;
      validator = new EnvConfigValidator(configService as any);
      const result = validator.validateAll();
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'BOND_ISSUER_ADDRESS')).toBe(true);
    });

    it('fails when JWT_SECRET is missing', () => {
      setEnv({ JWT_SECRET: undefined as any });
      const configService = MOCK_CONFIG;
      validator = new EnvConfigValidator(configService as any);
      const result = validator.validateAll();
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'JWT_SECRET')).toBe(true);
    });

    it('fails when ADMIN_SECRET_KEY is missing', () => {
      setEnv({ ADMIN_SECRET_KEY: undefined as any });
      const configService = MOCK_CONFIG;
      validator = new EnvConfigValidator(configService as any);
      const result = validator.validateAll();
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'ADMIN_SECRET_KEY')).toBe(true);
    });

    it('fails when INVESTOR_SECRET_KEY is missing', () => {
      setEnv({ INVESTOR_SECRET_KEY: undefined as any });
      const configService = MOCK_CONFIG;
      validator = new EnvConfigValidator(configService as any);
      const result = validator.validateAll();
      expect(result.valid).toBe(false);
    });

    it('fails when DATABASE_URL is missing', () => {
      setEnv({ DATABASE_URL: undefined as any });
      const configService = MOCK_CONFIG;
      validator = new EnvConfigValidator(configService as any);
      const result = validator.validateAll();
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'DATABASE_URL')).toBe(true);
    });

    it('fails when REDIS_URL is missing', () => {
      setEnv({ REDIS_URL: undefined as any });
      const configService = MOCK_CONFIG;
      validator = new EnvConfigValidator(configService as any);
      const result = validator.validateAll();
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'REDIS_URL')).toBe(true);
    });

    it('fails when IPFS_API_KEY is missing', () => {
      setEnv({ IPFS_API_KEY: undefined as any });
      const configService = MOCK_CONFIG;
      validator = new EnvConfigValidator(configService as any);
      const result = validator.validateAll();
      expect(result.valid).toBe(false);
    });
  });

  describe('invalid URLs', () => {
    it('fails when STELLAR_HORIZON_URL is malformed', () => {
      setEnv({ STELLAR_HORIZON_URL: 'not-a-url' });
      const configService = MOCK_CONFIG;
      validator = new EnvConfigValidator(configService as any);
      const result = validator.validateAll();
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'STELLAR_HORIZON_URL' && e.code === 'INVALID_URL')).toBe(true);
    });

    it('fails when SOROBAN_RPC_URL is malformed', () => {
      setEnv({ SOROBAN_RPC_URL: 'not-a-url' });
      const configService = MOCK_CONFIG;
      validator = new EnvConfigValidator(configService as any);
      const result = validator.validateAll();
      expect(result.valid).toBe(false);
    });
  });

  describe('invalid network', () => {
    it('fails when STELLAR_NETWORK is invalid', () => {
      setEnv({ STELLAR_NETWORK: 'unknown-network' });
      const configService = MOCK_CONFIG;
      validator = new EnvConfigValidator(configService as any);
      const result = validator.validateAll();
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'STELLAR_NETWORK')).toBe(true);
    });
  });

  describe('secret validation', () => {
    it('fails when JWT_SECRET is too short', () => {
      setEnv({ JWT_SECRET: 'short' });
      const configService = MOCK_CONFIG;
      validator = new EnvConfigValidator(configService as any);
      const result = validator.validateAll();
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === 'SECRET_TOO_SHORT')).toBe(true);
    });

    it('fails when JWT_SECRET contains weak pattern', () => {
      setEnv({ JWT_SECRET: 'dev-secret-padded-to-over-32-characters-long-now' });
      const configService = MOCK_CONFIG;
      validator = new EnvConfigValidator(configService as any);
      const result = validator.validateAll();
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === 'WEAK_SECRET')).toBe(true);
    });

    it('fails when ADMIN_SECRET_KEY is too short', () => {
      setEnv({ ADMIN_SECRET_KEY: 'short' });
      const configService = MOCK_CONFIG;
      validator = new EnvConfigValidator(configService as any);
      const result = validator.validateAll();
      expect(result.valid).toBe(false);
    });

    it('fails when INVESTOR_SECRET_KEY contains weak pattern', () => {
      setEnv({ INVESTOR_SECRET_KEY: 'password-padded-to-over-32-characters-long-yes' });
      const configService = MOCK_CONFIG;
      validator = new EnvConfigValidator(configService as any);
      const result = validator.validateAll();
      expect(result.valid).toBe(false);
    });

    it('passes when all secrets are strong', () => {
      setEnv({
        JWT_SECRET: 'Zq7vN2kLp9xRw4tYh8mB3cF6gJ1sD5aE0uWiKoQe',
        JWT_REFRESH_SECRET: 'Hn4bV8cX2zM6lK9jG3fD7sA1qW5eR0tYuIoPkLmN',
        ADMIN_SECRET_KEY: 'Pw3oE7iR1uT5yQ9aS2dF6gH0jK4lZ8xCvBnMqWeR',
        INVESTOR_SECRET_KEY: 'Lk8jH2gF6dS0aQ4wE9rT3yU7iO1pZ5xCvBnMmQwE',
        USER_SECRET_KEY: 'Mn5bV9cX3zL7kJ1hG6fD0sA4qW8eR2tYuIoPaSdF',
      });
      const configService = MOCK_CONFIG;
      validator = new EnvConfigValidator(configService as any);
      const result = validator.validateAll();
      expect(result.valid).toBe(true);
    });
  });

  describe('production-like secrets in local mode', () => {
    it('warns when production-like secret is used in non-production mode', () => {
      setEnv({ JWT_SECRET: 'prod-jwt-secret-value-padded-to-over-32-chars', NODE_ENV: 'development' });
      const configService = MOCK_CONFIG;
      validator = new EnvConfigValidator(configService as any);
      const result = validator.validateAll();
      expect(result.warnings.some((w) => w.code === 'PRODUCTION_SECRET_IN_LOCAL_MODE')).toBe(true);
    });
  });

  describe('invalid contract addresses', () => {
    it('fails when contract address is not a valid Stellar address', () => {
      setEnv({ BOND_ISSUER_ADDRESS: 'not-a-stellar-address' });
      const configService = MOCK_CONFIG;
      validator = new EnvConfigValidator(configService as any);
      const result = validator.validateAll();
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === 'INVALID_CONTRACT_ADDRESS')).toBe(true);
    });
  });

  describe('getConfig', () => {
    it('returns typed configuration', () => {
      const configService = MOCK_CONFIG;
      validator = new EnvConfigValidator(configService as any);
      const config = validator.getConfig();
      expect(config.stellarNetwork).toBe('testnet');
      expect(config.bondIssuerAddress).toBe(CONTRACT.BOND);
      expect(config.port).toBe(3000);
      expect(config.nodeEnv).toBe('test');
    });

    it('returns default values when env vars are not set', () => {
      clearEnv();
      const configService = MOCK_CONFIG;
      validator = new EnvConfigValidator(configService as any);
      const config = validator.getConfig();
      expect(config.stellarNetwork).toBe('testnet');
    });
  });

  describe('maskSecret', () => {
    it('masks a secret with visible characters at ends', () => {
      const secret = 'Zq7vN2kLp9xRw4tYh8mB3cF6gJ1sD5aE0uWiKoQe';
      const masked = validator.maskSecret(secret);
      expect(masked).not.toEqual(secret);
      expect(masked.length).toBe(secret.length);
      // Four characters stay visible at each end.
      expect(masked.startsWith('Zq7v')).toBe(true);
      expect(masked.endsWith('KoQe')).toBe(true);
    });

    it('masks short secrets completely', () => {
      const masked = validator.maskSecret('short');
      expect(masked).toBe('*****');
    });
  });

  describe('unsafe config combinations', () => {
    it('fails when all contract addresses are missing', () => {
      setEnv({
        BOND_ISSUER_ADDRESS: undefined as any,
        COUPON_ENGINE_ADDRESS: undefined as any,
        PROJECT_REGISTRY_ADDRESS: undefined as any,
        ORACLE_CONSUMER_ADDRESS: undefined as any,
        DEX_ROUTER_ADDRESS: undefined as any,
        CREDIT_RETIREMENT_ADDRESS: undefined as any,
      });
      const configService = MOCK_CONFIG;
      validator = new EnvConfigValidator(configService as any);
      const result = validator.validateAll();
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(5);
    });

    it('fails when all secrets are missing', () => {
      setEnv({
        JWT_SECRET: undefined as any,
        JWT_REFRESH_SECRET: undefined as any,
        ADMIN_SECRET_KEY: undefined as any,
        INVESTOR_SECRET_KEY: undefined as any,
        USER_SECRET_KEY: undefined as any,
      });
      const configService = MOCK_CONFIG;
      validator = new EnvConfigValidator(configService as any);
      const result = validator.validateAll();
      expect(result.valid).toBe(false);
    });

    it('fails when network and all contract addresses are missing', () => {
      setEnv({ STELLAR_NETWORK: undefined as any });
      const configService = MOCK_CONFIG;
      validator = new EnvConfigValidator(configService as any);
      const result = validator.validateAll();
      expect(result.valid).toBe(false);
    });
  });
});
