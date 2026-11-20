import { Injectable, OnModuleInit } from '@nestjs/common';

const REQUIRED_CONTRACT_ADDRESSES = [
  'BOND_ISSUER_ADDRESS',
  'COUPON_ENGINE_ADDRESS',
  'DEX_ROUTER_ADDRESS',
  'PROJECT_REGISTRY_ADDRESS',
  'ORACLE_CONSUMER_ADDRESS',
  'CREDIT_RETIREMENT_ADDRESS',
] as const;

type RequiredContractAddress = typeof REQUIRED_CONTRACT_ADDRESSES[number];

const TEST_SECRET = 'test-jwt-secret-must-be-long-enough-32chars-min';
const TEST_REFRESH_SECRET = 'test-jwt-refresh-secret-min-32characters';
const MIN_SECRET_LENGTH = 32;

const isTestEnv = (): boolean => process.env.NODE_ENV === 'test';

const isWeakSecret = (secret: string): boolean => {
  if (secret.length < MIN_SECRET_LENGTH) return true;
  const commonWeak = ['dev-secret', 'secret', 'password', 'changeme', '123456'];
  return commonWeak.some((w) => secret.toLowerCase().includes(w));
};

@Injectable()
export class ConfigService implements OnModuleInit {
  private readonly jwtSecret: string;
  private readonly jwtRefreshSecret: string;
  private readonly jwtExpiry: string;
  private readonly jwtRefreshExpiry: string;

  constructor() {
    if (isTestEnv()) {
      this.jwtSecret = process.env.JWT_SECRET || TEST_SECRET;
      this.jwtRefreshSecret = process.env.JWT_REFRESH_SECRET || TEST_REFRESH_SECRET;
    } else {
      this.jwtSecret = process.env.JWT_SECRET || '';
      this.jwtRefreshSecret = process.env.JWT_REFRESH_SECRET || `${this.jwtSecret}:refresh`;
    }
    this.jwtExpiry = process.env.JWT_EXPIRY || '15m';
    this.jwtRefreshExpiry = process.env.JWT_REFRESH_EXPIRY || '7d';
  }

  onModuleInit(): void {
    const missingContracts = REQUIRED_CONTRACT_ADDRESSES.filter(
      (key) => !process.env[key] || process.env[key].trim() === '',
    );

    if (missingContracts.length > 0) {
      throw new Error(
        `Missing required contract environment variables: ${missingContracts.join(', ')}. ` +
        'Set these in your .env file before starting the application.',
      );
    }

    if (!isTestEnv()) {
      if (!this.jwtSecret || this.jwtSecret.trim() === '') {
        throw new Error(
          'JWT_SECRET environment variable is required in non-test environments. ' +
          'Generate a secure random secret (at least 32 chars) and set it before starting the application. ' +
          'Example: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"',
        );
      }
      if (isWeakSecret(this.jwtSecret)) {
        throw new Error(
          `JWT_SECRET is too weak. It must be at least ${MIN_SECRET_LENGTH} characters long ` +
          'and not contain common weak phrases like "dev-secret", "secret", "password", etc. ' +
          'Generate a secure random secret using: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"',
        );
      }
      if (process.env.JWT_REFRESH_SECRET && isWeakSecret(process.env.JWT_REFRESH_SECRET)) {
        throw new Error(
          `JWT_REFRESH_SECRET is too weak. It must be at least ${MIN_SECRET_LENGTH} characters long ` +
          'and not contain common weak phrases. Generate a secure random secret.',
        );
      }
    }
  }

  getBondIssuerAddress(): string {
    return process.env.BOND_ISSUER_ADDRESS!;
  }

  getCouponEngineAddress(): string {
    return process.env.COUPON_ENGINE_ADDRESS!;
  }

  getDexRouterAddress(): string {
    return process.env.DEX_ROUTER_ADDRESS!;
  }

  getProjectRegistryAddress(): string {
    return process.env.PROJECT_REGISTRY_ADDRESS!;
  }

  getOracleConsumerAddress(): string {
    return process.env.ORACLE_CONSUMER_ADDRESS!;
  }

  getCreditRetirementAddress(): string {
    return process.env.CREDIT_RETIREMENT_ADDRESS!;
  }

  getJwtSecret(): string {
    return this.jwtSecret;
  }

  getJwtRefreshSecret(): string {
    return this.jwtRefreshSecret;
  }

  getJwtExpiry(): string {
    return this.jwtExpiry;
  }

  getJwtRefreshExpiry(): string {
    return this.jwtRefreshExpiry;
  }
}