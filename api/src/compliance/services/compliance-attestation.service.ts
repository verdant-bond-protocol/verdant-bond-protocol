import { Injectable, Logger, BadRequestException, ForbiddenException, Optional } from '@nestjs/common';
import { Keypair } from '@stellar/stellar-sdk';
import * as crypto from 'crypto';
import {
  AttestationVerificationResult,
  EligibilityAttestationPayload,
  SignedEligibilityAttestation,
  TrancheType,
} from '../interfaces/compliance.interface';
import { ComplianceRulesEngine } from './compliance-rules.engine';
import { KycStoreService } from '../../common/services/kyc-store.service';
import { SigningKeyProvider } from '../../common/services/signing-key.provider';

@Injectable()
export class ComplianceAttestationService {
  private readonly logger = new Logger(ComplianceAttestationService.name);
  private complianceKeypair: Keypair;
  private readonly attestationTtlSeconds = 3600; // 1 hour validity

  constructor(
    private readonly rulesEngine: ComplianceRulesEngine,
    private readonly kycStore: KycStoreService,
    @Optional() private readonly signingKeys?: SigningKeyProvider,
  ) {
    // Initialize or load compliance signing keypair
    const secret = process.env.COMPLIANCE_SIGNING_KEY;
    if (secret && secret.startsWith('S')) {
      try {
        this.complianceKeypair = Keypair.fromSecret(secret);
      } catch {
        this.complianceKeypair = Keypair.random();
      }
    } else {
      // Deterministic fallback for dev / testing
      this.complianceKeypair = Keypair.random();
    }
  }

  getSignerPublicKey(): string {
    return this.complianceKeypair.publicKey();
  }

  /**
   * Evaluates eligibility and generates a cryptographically signed attestation
   * for an investor purchasing a specific bond / tranche.
   */
  async issueAttestation(input: {
    investorAddress: string;
    bondId: number;
    tranche?: TrancheType;
    jurisdiction?: string;
    purchaseAmount?: string;
  }): Promise<SignedEligibilityAttestation> {
    const tranche = input.tranche || TrancheType.STANDARD;
    const jurisdiction = (input.jurisdiction || 'US').toUpperCase();

    // 1. Fetch current KYC record
    const kycRecord = await this.kycStore.get(input.investorAddress);
    if (!kycRecord) {
      throw new ForbiddenException(`No KYC record found for address: ${input.investorAddress}`);
    }

    // 2. Evaluate ruleset eligibility
    const decision = this.rulesEngine.evaluateEligibility({
      investorAddress: input.investorAddress,
      bondId: input.bondId,
      tranche,
      jurisdiction,
      purchaseAmount: input.purchaseAmount,
      kycRecord: {
        status: kycRecord.status,
        expiresAt: kycRecord.expiresAt,
      },
    });

    if (!decision.eligible) {
      throw new ForbiddenException(
        `Investor eligibility evaluation failed: [${decision.code}] ${decision.reason}`,
      );
    }

    // 3. Construct attestation payload
    const now = Math.floor(Date.now() / 1000);
    const payload: EligibilityAttestationPayload = {
      investorAddress: input.investorAddress,
      bondId: input.bondId,
      tranche,
      jurisdiction,
      kycStatus: kycRecord.status,
      rulesetVersion: decision.rulesetVersion,
      issuedAt: now,
      expiresAt: now + this.attestationTtlSeconds,
      nonce: crypto.randomBytes(16).toString('hex'),
    };

    // 4. Sign payload canonically with Ed25519 compliance key
    const canonicalMessage = this.serializePayload(payload);
    const signature = this.complianceKeypair
      .sign(Buffer.from(canonicalMessage, 'utf8'))
      .toString('hex');

    this.logger.log(
      `Issued eligibility attestation for ${input.investorAddress} on bond ${input.bondId} (tranche: ${tranche}, ruleset: ${decision.rulesetVersion})`,
    );

    return {
      payload,
      signature,
      signerPublicKey: this.complianceKeypair.publicKey(),
    };
  }

  /**
   * Verifies a signed eligibility attestation independently.
   * Can be called by any backend service, smart contract wrapper, or auditing tool.
   */
  verifyAttestation(
    attestation: SignedEligibilityAttestation,
    context: {
      expectedInvestor: string;
      expectedBondId: number;
      expectedTranche?: TrancheType;
      maxAgeSeconds?: number;
    },
  ): AttestationVerificationResult {
    if (!attestation || !attestation.payload || !attestation.signature) {
      return { valid: false, reason: 'Attestation payload or signature is missing' };
    }

    const { payload, signature, signerPublicKey } = attestation;

    // 1. Investor matching
    if (payload.investorAddress !== context.expectedInvestor) {
      return {
        valid: false,
        reason: `Attestation investor ${payload.investorAddress} does not match expected investor ${context.expectedInvestor}`,
      };
    }

    // 2. Bond ID matching
    if (Number(payload.bondId) !== Number(context.expectedBondId)) {
      return {
        valid: false,
        reason: `Attestation bondId ${payload.bondId} does not match expected bondId ${context.expectedBondId}`,
      };
    }

    // 3. Tranche matching (if specified)
    if (context.expectedTranche && payload.tranche !== context.expectedTranche) {
      return {
        valid: false,
        reason: `Attestation tranche ${payload.tranche} does not match requested tranche ${context.expectedTranche}`,
      };
    }

    // 4. Expiration check
    const now = Math.floor(Date.now() / 1000);
    if (now >= payload.expiresAt) {
      return {
        valid: false,
        reason: `Attestation expired at ${new Date(payload.expiresAt * 1000).toISOString()}`,
      };
    }

    // 5. Signature cryptographic verification
    try {
      const canonicalMessage = this.serializePayload(payload);
      const keypair = Keypair.fromPublicKey(signerPublicKey || this.complianceKeypair.publicKey());
      const isValid = keypair.verify(
        Buffer.from(canonicalMessage, 'utf8'),
        Buffer.from(signature, 'hex'),
      );

      if (!isValid) {
        return { valid: false, reason: 'Cryptographic signature verification failed' };
      }
    } catch (err: any) {
      return { valid: false, reason: `Signature verification error: ${err.message}` };
    }

    return { valid: true, payload };
  }

  /**
   * Deterministic canonical serialization of attestation payload
   */
  serializePayload(payload: EligibilityAttestationPayload): string {
    return JSON.stringify({
      bondId: payload.bondId,
      expiresAt: payload.expiresAt,
      investorAddress: payload.investorAddress,
      issuedAt: payload.issuedAt,
      jurisdiction: payload.jurisdiction,
      kycStatus: payload.kycStatus,
      nonce: payload.nonce,
      rulesetVersion: payload.rulesetVersion,
      tranche: payload.tranche,
    });
  }
}
