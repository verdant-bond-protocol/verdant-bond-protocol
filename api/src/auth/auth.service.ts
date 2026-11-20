import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  Account,
  FeeBumpTransaction,
  Keypair,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import * as crypto from 'crypto';
import { RedisService } from '../common/services/redis.service';
import { StellarService } from '../stellar/stellar.service';
import { KycService } from './kyc.service';
import { VerifySignatureDto } from './dto/verify-signature.dto';
import { ChallengeResponse, AuthTokenResponse, UserProfileResponse } from './interfaces/auth.interface';
import { ConfigService } from '../config/config.service';
import { RbacService } from './rbac.service';
import { SessionService } from './session.service';

const CHALLENGE_TTL_SECONDS = 300;

interface StoredChallenge {
  challenge: string;
  nonce: string;
  address: string;
  timestamp: number;
  audience: string;
}

const AUDIENCE =
  process.env.APP_URL || process.env.BASE_URL || 'verdant-bond-protocol';

@Injectable()
export class AuthService {
  private readonly accessTokenExpiry: string;
  private readonly refreshTokenExpiry: string;
  private readonly refreshTokenSecret: string;

  constructor(
    private readonly jwtService: JwtService,
    private readonly kycService: KycService,
    private readonly stellarService: StellarService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly rbacService: RbacService,
    private readonly sessions: SessionService,
  ) {
    this.accessTokenExpiry = this.config.getJwtExpiry();
    this.refreshTokenExpiry = this.config.getJwtRefreshExpiry();
    this.refreshTokenSecret = this.config.getJwtRefreshSecret();
  }

  async generateChallenge(address: string): Promise<ChallengeResponse> {
    if (!this.stellarService.isValidPublicKey(address)) {
      throw new BadRequestException('Invalid Stellar address');
    }

    const nonce = crypto.randomBytes(32).toString('hex');
    const serverSecretKey = process.env.STELLAR_AUTH_SECRET_KEY || process.env.ADMIN_SECRET_KEY;
    if (!serverSecretKey) {
      throw new InternalServerErrorException('Missing Stellar authentication signing key');
    }

    let serverKeypair: Keypair;
    try {
      serverKeypair = Keypair.fromSecret(serverSecretKey);
    } catch {
      throw new InternalServerErrorException('Invalid Stellar authentication signing key');
    }

    const homeDomain = process.env.STELLAR_HOME_DOMAIN || 'localhost:3000';
    const challengeTransaction = new TransactionBuilder(
      new Account(serverKeypair.publicKey(), '0'),
      {
        fee: '100',
        networkPassphrase: this.stellarService.getNetworkPassphrase(),
      },
    )
      .addOperation(Operation.manageData({
        name: `${homeDomain} auth`,
        value: Buffer.from(nonce, 'hex'),
        source: address,
      }))
      .setTimeout(300)
      .build();
    challengeTransaction.sign(serverKeypair);
    const challenge = challengeTransaction.toXDR();

    const timestamp = Date.now();

    const stored: StoredChallenge = {
      challenge,
      nonce,
      address,
      timestamp,
      audience: AUDIENCE,
    };

    await this.redis.set(
      `challenge:${address}`,
      JSON.stringify(stored),
      { EX: CHALLENGE_TTL_SECONDS },
    );

    return { challenge, nonce };
  }

  async verifySignature(dto: VerifySignatureDto): Promise<AuthTokenResponse> {
    const raw = await this.redis.getDel(`challenge:${dto.address}`);
    if (!raw) {
      throw new UnauthorizedException(
        'Challenge not found, expired, or already consumed. Please request a fresh challenge.',
      );
    }

    let stored: StoredChallenge;
    try {
      stored = JSON.parse(raw) as StoredChallenge;
    } catch {
      throw new UnauthorizedException(
        'Challenge record is malformed. Please request a fresh challenge.',
      );
    }

    if (stored.address !== dto.address) {
      throw new UnauthorizedException(
        'Challenge was not issued for this address. Please request a fresh challenge.',
      );
    }

    if (stored.challenge !== dto.originalChallenge) {
      throw new UnauthorizedException(
        'Challenge content does not match issued challenge. Please request a fresh challenge.',
      );
    }

    if (
      stored.timestamp <
      Date.now() - CHALLENGE_TTL_SECONDS * 1000
    ) {
      throw new UnauthorizedException(
        'Challenge has expired. Please request a fresh challenge.',
      );
    }

    const serverSecretKey = process.env.STELLAR_AUTH_SECRET_KEY || process.env.ADMIN_SECRET_KEY;
    if (!serverSecretKey) {
      throw new InternalServerErrorException('Missing Stellar authentication signing key');
    }

    try {
      const serverKeypair = Keypair.fromSecret(serverSecretKey);
      const originalTransaction = TransactionBuilder.fromXDR(
        dto.originalChallenge,
        this.stellarService.getNetworkPassphrase(),
      );
      const signedTransaction = TransactionBuilder.fromXDR(
        dto.signedChallenge,
        this.stellarService.getNetworkPassphrase(),
      );
      if (signedTransaction instanceof FeeBumpTransaction) {
        throw new Error('Fee bump transactions are not valid auth challenges');
      }
      const transactionHash = signedTransaction.hash();
      const hasSignature = (keypair: Keypair): boolean =>
        signedTransaction.signatures.some((signature) =>
          keypair.verify(transactionHash, signature.signature()),
        );

      if (
        originalTransaction.hash().toString('hex') !== transactionHash.toString('hex') ||
        signedTransaction.source !== serverKeypair.publicKey() ||
        signedTransaction.operations.length !== 1 ||
        signedTransaction.operations[0].source !== dto.address ||
        !hasSignature(serverKeypair) ||
        !hasSignature(Keypair.fromPublicKey(dto.address))
      ) {
        throw new Error('Invalid challenge transaction');
      }
    } catch {
      throw new UnauthorizedException('Invalid signature');
    }

    const kycStatus = await this.kycService.getStatus(dto.address);
    const roles = this.rbacService.getUserRoles(dto.address);
    const permissions = this.rbacService.getUserPermissions(dto.address);

    // One session id per login, shared by the access/refresh pair so a single
    // `revokeToken(jti)` revokes both. `sv` pins the token to the wallet epoch.
    const { sessionVersion, jti } = await this.sessions.issue(dto.address);
    const payload = { sub: dto.address, kycStatus, roles, permissions, sv: sessionVersion, jti };
    const accessToken = this.jwtService.sign(payload);
    const refreshToken = this.jwtService.sign(
      { ...payload, tokenType: 'refresh' },
      { secret: this.refreshTokenSecret, expiresIn: this.refreshTokenExpiry },
    );

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.accessTokenExpiry,
      refreshExpiresIn: this.refreshTokenExpiry,
    };
  }

  async refreshToken(token: string): Promise<AuthTokenResponse> {
    try {
      const payload = this.jwtService.verify(token, {
        secret: this.refreshTokenSecret,
      }) as {
        sub: string; kycStatus: string; tokenType: string;
        roles?: string[]; permissions?: string[]; sv?: number; jti?: string;
      };
      if (payload.tokenType !== 'refresh') {
        throw new UnauthorizedException('Invalid refresh token');
      }
      // A stale/revoked refresh token must not mint a fresh access token.
      await this.sessions.assertActive({
        sub: payload.sub,
        sv: payload.sv,
        jti: payload.jti,
      });

      // Recalculate roles just in case they changed
      const roles = this.rbacService.getUserRoles(payload.sub);
      const permissions = this.rbacService.getUserPermissions(payload.sub);
      const sessionVersion = await this.sessions.currentVersion(payload.sub);

      const newPayload = {
        sub: payload.sub, kycStatus: payload.kycStatus, roles, permissions,
        sv: sessionVersion, jti: payload.jti,
      };
      const accessToken = this.jwtService.sign(newPayload);
      return { accessToken, tokenType: 'Bearer', expiresIn: this.accessTokenExpiry };
    } catch (error) {
      // Don't turn an outage into a bogus "bad credentials" answer.
      if (error instanceof ServiceUnavailableException) throw error;
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  async getProfile(userId: string): Promise<UserProfileResponse> {
    const kycStatus = await this.kycService.getStatus(userId);
    const roles = this.rbacService.getUserRoles(userId);
    const permissions = this.rbacService.getUserPermissions(userId);
    return {
      walletAddress: userId,
      kycStatus,
      roles,
      permissions,
      createdAt: new Date().toISOString(),
    };
  }
}
