import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import { Keypair } from '@stellar/stellar-sdk';
import { RedisService } from './redis.service';

export interface AdminIntent {
  action: string;
  target: string;
  chain: string;
  expiry: number;
  nonce: string;
  signature: string;
}

/**
 * Verifies signed admin "step-up" intents (#115).
 *
 * High-risk admin actions (issuance, coupon distribution, maturity, provider
 * registration, slashing, governance) must be accompanied by a fresh signed
 * intent proving the admin deliberately authorised this exact action against
 * this exact target. The intent is signed with the admin's Stellar ed25519
 * key over a canonical message, carries an expiry, and a single-use nonce for
 * replay protection.
 */
@Injectable()
export class IntentService {
  constructor(private readonly redis: RedisService) {}

  /** Canonical, stable message that the admin signs. */
  canonical(intent: Pick<AdminIntent, 'action' | 'target' | 'chain' | 'expiry' | 'nonce'>): Buffer {
    return Buffer.from(
      `${intent.action}|${intent.target}|${intent.chain}|${intent.expiry}|${intent.nonce}`,
      'utf8',
    );
  }

  /**
   * Validate an intent against the expected action/target. Throws on any
   * failure: missing, malformed, expired, wrong-action, wrong-target,
   * invalid-signature, or replayed nonce.
   */
  async verify(
    raw: any,
    expectedAction: string,
    expectedTarget: string,
  ): Promise<AdminIntent> {
    if (!raw || typeof raw !== 'object') {
      throw new UnauthorizedException('Admin intent required');
    }
    const { action, target, chain, expiry, nonce, signature } = raw as Partial<AdminIntent>;

    if (!action || target === undefined || target === null || !chain || expiry === undefined || !nonce || !signature) {
      throw new UnauthorizedException('Admin intent is incomplete (action, target, chain, expiry, nonce, signature required)');
    }
    if (action !== expectedAction) {
      throw new UnauthorizedException(`Admin intent action mismatch: expected "${expectedAction}"`);
    }
    if (String(target) !== String(expectedTarget)) {
      throw new UnauthorizedException(`Admin intent target mismatch: expected "${expectedTarget}"`);
    }
    if (typeof expiry !== 'number' || expiry < Date.now()) {
      throw new UnauthorizedException('Admin intent expired');
    }

    const adminPublicKey = process.env.STELLAR_PUBLIC_KEY;
    if (!adminPublicKey) {
      throw new UnauthorizedException('Admin key not configured');
    }

    const message = this.canonical({ action, target: String(target), chain, expiry, nonce });
    let valid = false;
    try {
      const keypair = Keypair.fromPublicKey(adminPublicKey);
      valid = keypair.verify(message, Buffer.from(signature, 'base64'));
    } catch {
      valid = false;
    }
    if (!valid) {
      throw new UnauthorizedException('Invalid admin intent signature');
    }

    // Replay protection: a nonce may be used exactly once.
    const ttl = Math.max(60, Math.ceil((expiry - Date.now()) / 1000) + 300);
    const reserved = await this.redis.setNx(`admin-intent:${nonce}`, ttl);
    if (!reserved) {
      throw new ConflictException('Admin intent nonce already used (replay rejected)');
    }

    return { action, target: String(target), chain, expiry, nonce, signature };
  }
}
