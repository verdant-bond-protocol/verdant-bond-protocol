import { ConfigService } from './config.service';

const STRONG_SECRET = 'a-very-strong-token-that-is-definitely-over-32-characters-long';
const STRONG_REFRESH_SECRET = 'a-very-strong-refresh-token-over-32-characters-abc123';

const setContractEnvs = () => {
  process.env.BOND_ISSUER_ADDRESS = 'CBOND';
  process.env.COUPON_ENGINE_ADDRESS = 'CCOUPON';
  process.env.DEX_ROUTER_ADDRESS = 'CDEX';
  process.env.PROJECT_REGISTRY_ADDRESS = 'CREGISTRY';
  process.env.ORACLE_CONSUMER_ADDRESS = 'CORACLE';
  process.env.CREDIT_RETIREMENT_ADDRESS = 'CRETIRE';
};

const clearJwtEnvs = () => {
  delete process.env.JWT_SECRET;
  delete process.env.JWT_REFRESH_SECRET;
  delete process.env.JWT_EXPIRY;
  delete process.env.JWT_REFRESH_EXPIRY;
};

describe('ConfigService', () => {
  beforeEach(() => {
    clearJwtEnvs();
    setContractEnvs();
  });

  afterEach(() => {
    clearJwtEnvs();
    delete process.env.NODE_ENV;
    delete process.env.BOND_ISSUER_ADDRESS;
    delete process.env.COUPON_ENGINE_ADDRESS;
    delete process.env.DEX_ROUTER_ADDRESS;
    delete process.env.PROJECT_REGISTRY_ADDRESS;
    delete process.env.ORACLE_CONSUMER_ADDRESS;
    delete process.env.CREDIT_RETIREMENT_ADDRESS;
  });

  describe('test environment (NODE_ENV=test)', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'test';
    });

    it('uses built-in test secret when JWT_SECRET is not set', () => {
      const config = new ConfigService();
      expect(config.getJwtSecret()).toMatch(/test-jwt-secret/);
      expect(config.getJwtSecret().length).toBeGreaterThanOrEqual(32);
    });

    it('uses built-in test refresh secret when JWT_REFRESH_SECRET is not set', () => {
      const config = new ConfigService();
      expect(config.getJwtRefreshSecret()).toMatch(/test-jwt-refresh/);
      expect(config.getJwtRefreshSecret().length).toBeGreaterThanOrEqual(32);
    });

    it('uses provided JWT_SECRET in test env if explicitly set', () => {
      process.env.JWT_SECRET = STRONG_SECRET;
      const config = new ConfigService();
      expect(config.getJwtSecret()).toBe(STRONG_SECRET);
    });

    it('uses default expiry values when not configured', () => {
      const config = new ConfigService();
      expect(config.getJwtExpiry()).toBe('15m');
      expect(config.getJwtRefreshExpiry()).toBe('7d');
    });

    it('allows custom expiry values', () => {
      process.env.JWT_EXPIRY = '5m';
      process.env.JWT_REFRESH_EXPIRY = '1d';
      const config = new ConfigService();
      expect(config.getJwtExpiry()).toBe('5m');
      expect(config.getJwtRefreshExpiry()).toBe('1d');
    });

    it('onModuleInit does not throw in test env without JWT_SECRET', () => {
      const config = new ConfigService();
      expect(() => config.onModuleInit()).not.toThrow();
    });
  });

  describe('non-test environments', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    it('onModuleInit throws when JWT_SECRET is missing', () => {
      const config = new ConfigService();
      expect(() => config.onModuleInit()).toThrow(/JWT_SECRET environment variable is required/);
    });

    it('onModuleInit throws when JWT_SECRET is shorter than 32 characters', () => {
      process.env.JWT_SECRET = 'short-secret';
      const config = new ConfigService();
      expect(() => config.onModuleInit()).toThrow(/too weak/);
    });

    it('onModuleInit throws when JWT_SECRET contains "dev-secret"', () => {
      process.env.JWT_SECRET = 'dev-secret-change-in-production-padded-to-32-chars-extra';
      const config = new ConfigService();
      expect(() => config.onModuleInit()).toThrow(/too weak/);
    });

    it('onModuleInit throws when JWT_SECRET contains common weak phrase "password"', () => {
      process.env.JWT_SECRET = 'password-padded-to-over-32-characters-long-yes';
      const config = new ConfigService();
      expect(() => config.onModuleInit()).toThrow(/too weak/);
    });

    it('onModuleInit throws when JWT_SECRET contains common weak phrase "secret"', () => {
      process.env.JWT_SECRET = 'my-secret-key-padded-to-over-32-characters-long';
      const config = new ConfigService();
      expect(() => config.onModuleInit()).toThrow(/too weak/);
    });

    it('onModuleInit throws when JWT_REFRESH_SECRET is weak', () => {
      process.env.JWT_SECRET = STRONG_SECRET;
      process.env.JWT_REFRESH_SECRET = 'weak-refresh';
      const config = new ConfigService();
      expect(() => config.onModuleInit()).toThrow(/JWT_REFRESH_SECRET is too weak/);
    });

    it('onModuleInit passes when strong secrets are provided', () => {
      process.env.JWT_SECRET = STRONG_SECRET;
      process.env.JWT_REFRESH_SECRET = STRONG_REFRESH_SECRET;
      const config = new ConfigService();
      expect(() => config.onModuleInit()).not.toThrow();
    });

    it('derives refresh secret from access secret when JWT_REFRESH_SECRET is not set', () => {
      process.env.JWT_SECRET = STRONG_SECRET;
      const config = new ConfigService();
      expect(config.getJwtRefreshSecret()).toBe(`${STRONG_SECRET}:refresh`);
    });

    it('uses explicit JWT_REFRESH_SECRET when provided', () => {
      process.env.JWT_SECRET = STRONG_SECRET;
      process.env.JWT_REFRESH_SECRET = STRONG_REFRESH_SECRET;
      const config = new ConfigService();
      expect(config.getJwtRefreshSecret()).toBe(STRONG_REFRESH_SECRET);
    });

    it('onModuleInit throws when JWT_SECRET is empty string', () => {
      process.env.JWT_SECRET = '';
      const config = new ConfigService();
      expect(() => config.onModuleInit()).toThrow(/JWT_SECRET environment variable is required/);
    });

    it('onModuleInit throws when JWT_SECRET is only whitespace', () => {
      process.env.JWT_SECRET = '   ';
      const config = new ConfigService();
      expect(() => config.onModuleInit()).toThrow(/JWT_SECRET environment variable is required/);
    });
  });

  describe('contract address validation', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = STRONG_SECRET;
    });

    it('onModuleInit throws when required contract address is missing', () => {
      delete process.env.BOND_ISSUER_ADDRESS;
      const config = new ConfigService();
      expect(() => config.onModuleInit()).toThrow(/Missing required contract environment variables/);
    });
  });
});
