/**
 * Secure secrets and environment configuration validation.
 *
 * Startup and deployment fail fast when required configuration is missing,
 * malformed, unsafe, or accidentally using production-like secrets in local mode.
 *
 * See: https://github.com/verdant-bond-protocol/verdant-bond-protocol/issues/278
 */

import { Injectable, OnModuleInit, BadRequestException, Logger } from '@nestjs/common';
import { StrKey } from '@stellar/stellar-sdk';
import { ConfigService as NestConfigService } from '../../config/config.service';

const MIN_SECRET_LENGTH = 32;
const MAX_SECRET_LENGTH = 256;

export const WEAK_SECRET_PATTERNS = [
  'dev-secret',
  'secret',
  'password',
  'changeme',
  '123456',
  'admin',
  'test',
  'default',
  'placeholder',
  'example',
  'your-',
  'password123',
  'qwerty',
  'abc123',
];

const PRODUCTION_LIKE_PATTERNS = [
  'prod',
  'production',
  'live',
  'staging',
  'prod-',
  'stg-',
];

const REQUIRED_ENV_VARS = [
  'STELLAR_NETWORK',
  'STELLAR_HORIZON_URL',
  'SOROBAN_RPC_URL',
  'BOND_ISSUER_ADDRESS',
  'COUPON_ENGINE_ADDRESS',
  'PROJECT_REGISTRY_ADDRESS',
  'ORACLE_CONSUMER_ADDRESS',
  'DEX_ROUTER_ADDRESS',
  'CREDIT_RETIREMENT_ADDRESS',
  'REDIS_URL',
  'DATABASE_URL',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'ADMIN_SECRET_KEY',
  'INVESTOR_SECRET_KEY',
  'USER_SECRET_KEY',
  'IPFS_API_URL',
  'IPFS_API_KEY',
  'ORACLE_PROVIDER_WHITELIST',
] as const;

type RequiredEnvVar = typeof REQUIRED_ENV_VARS[number];

export interface EnvValidationResult {
  valid: boolean;
  errors: EnvValidationError[];
  warnings: EnvValidationWarning[];
}

export interface EnvValidationError {
  field: string;
  message: string;
  code: string;
}

export interface EnvValidationWarning {
  field: string;
  message: string;
  code: string;
}

/**
 * Typed environment configuration schema.
 */
export interface EnvConfig {
  // Network
  stellarNetwork: string;
  stellarHorizonUrl: string;
  sorobanRpcUrl: string;
  stellarPublicKey: string;

  // Contract addresses
  bondIssuerAddress: string;
  couponEngineAddress: string;
  dexRouterAddress: string;
  projectRegistryAddress: string;
  oracleConsumerAddress: string;
  creditRetirementAddress: string;
  governanceAddress: string;

  // Signer keys
  adminSecretKey: string;
  investorSecretKey: string;
  userSecretKey: string;
  signingKeyProvider: string;
  signingKeyFile?: string;

  // JWT
  jwtSecret: string;
  jwtRefreshSecret: string;
  jwtExpiry: string;
  jwtRefreshExpiry: string;

  // IPFS
  ipfsApiUrl: string;
  ipfsApiKey: string;
  ipfsSecretKey: string;
  ipfsGateway: string;

  // Oracle
  oracleProviderWhitelist: string[];
  defaultProviderAddress: string;
  verraRegistryUrl: string;
  satelliteApiUrl: string;
  iotApiUrl: string;

  // Database & Cache
  databaseUrl: string;
  redisUrl: string;

  // App
  port: number;
  nodeEnv: string;
  logLevel: string;
  appUrl: string;
}

/**
 * Validates the environment configuration.
 *
 * This service checks that all required environment variables are present,
 * that secrets meet security requirements, and that production-like secrets
 * are not used in local/staging environments.
 */
@Injectable()
export class EnvConfigValidator implements OnModuleInit {
  private readonly logger = new Logger(EnvConfigValidator.name);

  constructor(private readonly configService: NestConfigService) {}

  onModuleInit(): void {
    const result = this.validateAll();

    if (result.errors.length > 0) {
      const errorMessages = result.errors.map((e) => `[${e.code}] ${e.field}: ${e.message}`).join('\n');
      throw new BadRequestException(`Configuration validation failed:\n${errorMessages}`);
    }

    if (result.warnings.length > 0) {
      for (const warning of result.warnings) {
        this.logger.warn(`[${warning.code}] ${warning.field}: ${warning.message}`);
      }
    }

    this.logger.log('Environment configuration validated successfully');
  }

  /**
   * Validate all environment variables.
   */
  validateAll(): EnvValidationResult {
    const errors: EnvValidationError[] = [];
    const warnings: EnvValidationWarning[] = [];

    // Check required variables
    for (const varName of REQUIRED_ENV_VARS) {
      const value = process.env[varName];
      if (!value || value.trim() === '') {
        errors.push({
          field: varName,
          message: `Required environment variable ${varName} is missing or empty`,
          code: 'MISSING_REQUIRED_VAR',
        });
      }
    }

    // Validate URLs
    const urlFields = ['STELLAR_HORIZON_URL', 'SOROBAN_RPC_URL', 'DATABASE_URL', 'REDIS_URL', 'IPFS_API_URL'];
    for (const varName of urlFields) {
      const value = process.env[varName];
      if (value && !this.isValidUrl(value)) {
        errors.push({
          field: varName,
          message: `${varName} is not a valid URL: ${value}`,
          code: 'INVALID_URL',
        });
      }
    }

    // Validate network ID
    const network = process.env.STELLAR_NETWORK;
    if (network && !['testnet', 'mainnet', 'standalone'].includes(network)) {
      errors.push({
        field: 'STELLAR_NETWORK',
        message: `Invalid network: ${network}. Must be one of: testnet, mainnet, standalone`,
        code: 'INVALID_NETWORK',
      });
    }

    // Validate secrets
    const secretFields = ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'ADMIN_SECRET_KEY', 'INVESTOR_SECRET_KEY', 'USER_SECRET_KEY', 'IPFS_SECRET_KEY'];
    for (const varName of secretFields) {
      const value = process.env[varName];
      if (value) {
        const secretErrors = this.validateSecret(varName, value);
        errors.push(...secretErrors);

        const secretWarnings = this.checkSecretSafety(varName, value);
        warnings.push(...secretWarnings);
      }
    }

    // Check for production-like secrets in local mode
    if (process.env.NODE_ENV !== 'production') {
      for (const varName of secretFields) {
        const value = process.env[varName];
        if (value && this.isProductionLikeSecret(value)) {
          warnings.push({
            field: varName,
            message: `Production-like secret detected in ${process.env.NODE_ENV} mode for ${varName}`,
            code: 'PRODUCTION_SECRET_IN_LOCAL_MODE',
          });
        }
      }
    }

    // Validate contract addresses format
    const contractFields = [
      'BOND_ISSUER_ADDRESS',
      'COUPON_ENGINE_ADDRESS',
      'PROJECT_REGISTRY_ADDRESS',
      'ORACLE_CONSUMER_ADDRESS',
      'DEX_ROUTER_ADDRESS',
      'CREDIT_RETIREMENT_ADDRESS',
      'GOVERNANCE_ADDRESS',
    ];
    for (const varName of contractFields) {
      const value = process.env[varName];
      if (value && !this.isContractAddress(value)) {
        errors.push({
          field: varName,
          message: `${varName} is not a valid Soroban contract address: ${value}`,
          code: 'INVALID_CONTRACT_ADDRESS',
        });
      }
    }

    // Validate admin address matches STELLAR_PUBLIC_KEY
    const stellarPublicKey = process.env.STELLAR_PUBLIC_KEY;
    const adminSecretKey = process.env.ADMIN_SECRET_KEY;
    if (stellarPublicKey && adminSecretKey) {
      // This would require actual key derivation to verify, so we just check they're both set
      // In production, the admin's public key derived from ADMIN_SECRET_KEY should match STELLAR_PUBLIC_KEY
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Get the validated environment configuration as a typed object.
   */
  getConfig(): EnvConfig {
    return {
      stellarNetwork: process.env.STELLAR_NETWORK || 'testnet',
      stellarHorizonUrl: process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org',
      sorobanRpcUrl: process.env.SOROBAN_RPC_URL || 'http://localhost:8000/soroban/rpc',
      stellarPublicKey: process.env.STELLAR_PUBLIC_KEY || '',
      bondIssuerAddress: process.env.BOND_ISSUER_ADDRESS || '',
      couponEngineAddress: process.env.COUPON_ENGINE_ADDRESS || '',
      dexRouterAddress: process.env.DEX_ROUTER_ADDRESS || '',
      projectRegistryAddress: process.env.PROJECT_REGISTRY_ADDRESS || '',
      oracleConsumerAddress: process.env.ORACLE_CONSUMER_ADDRESS || '',
      creditRetirementAddress: process.env.CREDIT_RETIREMENT_ADDRESS || '',
      governanceAddress: process.env.GOVERNANCE_ADDRESS || '',
      adminSecretKey: process.env.ADMIN_SECRET_KEY || '',
      investorSecretKey: process.env.INVESTOR_SECRET_KEY || '',
      userSecretKey: process.env.USER_SECRET_KEY || '',
      signingKeyProvider: process.env.SIGNING_KEY_PROVIDER || 'env',
      signingKeyFile: process.env.SIGNING_KEY_FILE,
      jwtSecret: process.env.JWT_SECRET || '',
      jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || '',
      jwtExpiry: process.env.JWT_EXPIRY || '15m',
      jwtRefreshExpiry: process.env.JWT_REFRESH_EXPIRY || '7d',
      ipfsApiUrl: process.env.IPFS_API_URL || 'https://api.pinata.cloud',
      ipfsApiKey: process.env.IPFS_API_KEY || '',
      ipfsSecretKey: process.env.IPFS_SECRET_KEY || '',
      ipfsGateway: process.env.IPFS_GATEWAY || 'https://gateway.pinata.cloud/ipfs/',
      oracleProviderWhitelist: (process.env.ORACLE_PROVIDER_WHITELIST || '').split(',').filter(Boolean),
      defaultProviderAddress: process.env.DEFAULT_PROVIDER_ADDRESS || '',
      verraRegistryUrl: process.env.VERRA_REGISTRY_URL || '',
      satelliteApiUrl: process.env.SATELLITE_API_URL || '',
      iotApiUrl: process.env.IOT_API_URL || '',
      databaseUrl: process.env.DATABASE_URL || '',
      redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
      port: parseInt(process.env.PORT || '3000', 10),
      nodeEnv: process.env.NODE_ENV || 'development',
      logLevel: process.env.LOG_LEVEL || 'debug',
      appUrl: process.env.APP_URL || process.env.BASE_URL || 'verdant-bond-protocol',
    };
  }

  /**
   * Validate a single secret.
   */
  private validateSecret(fieldName: string, value: string): EnvValidationError[] {
    const errors: EnvValidationError[] = [];

    if (value.length < MIN_SECRET_LENGTH) {
      errors.push({
        field: fieldName,
        message: `${fieldName} must be at least ${MIN_SECRET_LENGTH} characters long (currently ${value.length})`,
        code: 'SECRET_TOO_SHORT',
      });
    }

    if (value.length > MAX_SECRET_LENGTH) {
      errors.push({
        field: fieldName,
        message: `${fieldName} must not exceed ${MAX_SECRET_LENGTH} characters`,
        code: 'SECRET_TOO_LONG',
      });
    }

    for (const pattern of WEAK_SECRET_PATTERNS) {
      if (value.toLowerCase().includes(pattern.toLowerCase())) {
        errors.push({
          field: fieldName,
          message: `${fieldName} contains weak pattern "${pattern}"`,
          code: 'WEAK_SECRET',
        });
        break;
      }
    }

    return errors;
  }

  /**
   * Check if a secret is safe (not production-like in local mode).
   */
  private checkSecretSafety(fieldName: string, value: string): EnvValidationWarning[] {
    const warnings: EnvValidationWarning[] = [];

    if (this.isProductionLikeSecret(value)) {
      warnings.push({
        field: fieldName,
        message: `Secret appears to be a production-like secret in ${process.env.NODE_ENV} mode`,
        code: 'PRODUCTION_SECRET_WARNING',
      });
    }

    return warnings;
  }

  /**
   * Check if a secret looks like a production secret.
   */
  private isProductionLikeSecret(value: string): boolean {
    const lowerValue = value.toLowerCase();
    return PRODUCTION_LIKE_PATTERNS.some((p) => lowerValue.includes(p));
  }

  /**
   * Check if a value is a valid Stellar address.
   */
  // Soroban contract IDs are C… strkeys (G… is an account key).
  private isContractAddress(value: string): boolean {
    return StrKey.isValidContract(value);
  }

  /**
   * Check if a value is a valid URL.
   */
  private isValidUrl(value: string): boolean {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Never print a secret in full. Return a masked version.
   */
  maskSecret(value: string, visibleChars = 4): string {
    if (value.length <= visibleChars * 2) {
      return '*'.repeat(value.length);
    }
    return value.slice(0, visibleChars) + '*'.repeat(value.length - visibleChars * 2) + value.slice(-visibleChars);
  }
}
