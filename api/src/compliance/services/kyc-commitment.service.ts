import { Injectable, Logger, UnauthorizedException, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { KycStatus } from '../../common/interfaces/authenticated-request.interface';

export enum EligibilityTier {
  TIER_0_UNVERIFIED = 'TIER_0_UNVERIFIED',
  TIER_1_RETAIL_STANDARD = 'TIER_1_RETAIL_STANDARD',
  TIER_2_ACCREDITED = 'TIER_2_ACCREDITED',
  TIER_3_INSTITUTIONAL = 'TIER_3_INSTITUTIONAL',
}

export interface OnChainKycCommitment {
  commitmentHash: string; // SHA-256(investorAddress + tier + jurisdiction + salt + decisionTimestamp)
  eligibilityTier: EligibilityTier;
  expirationTimestamp: number;
  issuedAt: number;
}

export interface SignedKycReceipt {
  commitmentHash: string;
  eligibilityTier: EligibilityTier;
  issuedAt: number;
  expirationTimestamp: number;
  signature: string; // Ed25519 signature over the commitment
  signerPublicKey: string;
  decisionReason?: string;
}

export interface RegulatorDisclosureRequest {
  regulatorId: string;
  authorizationToken: string;
  commitmentHash: string;
}

export interface RegulatorDisclosurePackage {
  commitmentHash: string;
  eligibilityTier: EligibilityTier;
  investorAddress: string;
  jurisdiction: string;
  kycStatus: KycStatus;
  providerReference: string;
  verifiedAt: string;
  salt: string;
  proofValid: boolean;
  disclosureMetadata: {
    disclosedTo: string;
    disclosedAt: string;
    accessReason: string;
  };
}

/**
 * KYC data minimization service: non-PII on-chain commitments and selective disclosure (#469).
 *
 * Generates and verifies KYC eligibility commitments without exposing PII on-chain.
 * Supports signed audit receipts for compliance audits and regulator disclosure.
 */
@Injectable()
export class KycCommitmentService {
  private readonly logger = new Logger(KycCommitmentService.name);
  private readonly secretSalt: string;
  private readonly commitmentsStore = new Map<string, { commitment: OnChainKycCommitment; offChainAudit: any; receipt?: SignedKycReceipt }>();
  private readonly authorizedRegulators = new Set<string>(['REGULATOR_SEC', 'REGULATOR_FINMA', 'REGULATOR_MAS']);
  private readonly complianceSigningKey: crypto.KeyObject;

  constructor() {
    this.secretSalt = process.env.KYC_COMMITMENT_SALT || 'verdant_bond_protocol_kyc_salt_2026';

    // Load or generate compliance signing key for audit receipts
    const keySecret = process.env.KYC_RECEIPT_SIGNING_KEY;
    if (keySecret) {
      try {
        this.complianceSigningKey = crypto.createPrivateKey({
          key: Buffer.from(keySecret, 'base64'),
          format: 'der',
          type: 'pkcs8',
        });
      } catch {
        this.complianceSigningKey = crypto.generateKeyPairSync('ed25519').privateKey;
      }
    } else {
      this.complianceSigningKey = crypto.generateKeyPairSync('ed25519').privateKey;
    }
  }

  /**
   * Maps off-chain KYC record to a non-identifying eligibility tier.
   */
  mapToEligibilityTier(kycStatus: KycStatus, tranche?: string): EligibilityTier {
    if (kycStatus === KycStatus.NONE || kycStatus === KycStatus.PENDING || kycStatus === KycStatus.REJECTED) {
      return EligibilityTier.TIER_0_UNVERIFIED;
    }
    if (kycStatus === KycStatus.ACCREDITED) {
      return tranche === 'GREEN_INSTITUTIONAL'
        ? EligibilityTier.TIER_3_INSTITUTIONAL
        : EligibilityTier.TIER_2_ACCREDITED;
    }
    return EligibilityTier.TIER_1_RETAIL_STANDARD;
  }

  /**
   * Generates a cryptographic on-chain commitment hash without leaking any PII.
   * Commitment Formula: SHA-256(investorAddress + eligibilityTier + jurisdiction + salt + timestamp)
   */
  generateOnChainCommitment(input: {
    investorAddress: string;
    kycStatus: KycStatus;
    jurisdiction: string;
    expiresAt?: number | null;
    tranche?: string;
    providerReference?: string;
  }): OnChainKycCommitment {
    const tier = this.mapToEligibilityTier(input.kycStatus, input.tranche);
    const issuedAt = Math.floor(Date.now() / 1000);
    const expirationTimestamp = input.expiresAt
      ? Math.floor(input.expiresAt / 1000)
      : issuedAt + 365 * 86400;

    // Salt per investor commitment
    const userSalt = crypto
      .createHmac('sha256', this.secretSalt)
      .update(`${input.investorAddress}:${issuedAt}`)
      .digest('hex');

    const canonicalData = `${input.investorAddress}:${tier}:${input.jurisdiction.toUpperCase()}:${userSalt}:${issuedAt}`;
    const commitmentHash = crypto.createHash('sha256').update(canonicalData, 'utf8').digest('hex');

    const commitment: OnChainKycCommitment = {
      commitmentHash,
      eligibilityTier: tier,
      expirationTimestamp,
      issuedAt,
    };

    // Keep off-chain audit record mapping commitment to PII / verification proof in secure access-controlled store
    this.commitmentsStore.set(commitmentHash, {
      commitment,
      offChainAudit: {
        investorAddress: input.investorAddress,
        jurisdiction: input.jurisdiction,
        kycStatus: input.kycStatus,
        providerReference: input.providerReference || 'KYC_VERIFIED_OFFCHAIN_REF',
        verifiedAt: new Date(issuedAt * 1000).toISOString(),
        salt: userSalt,
      },
    });

    this.logger.debug(`Generated on-chain KYC commitment hash ${commitmentHash.slice(0, 16)}... for tier ${tier}`);
    return commitment;
  }

  /**
   * Issue a signed audit receipt for a KYC commitment (for compliance records).
   * Receipt includes commitment hash, tier, timestamps, and Ed25519 signature.
   */
  issueSignedReceipt(commitmentHash: string, decisionReason?: string): SignedKycReceipt {
    const record = this.commitmentsStore.get(commitmentHash);
    if (!record) {
      throw new NotFoundException(`No KYC commitment found for hash ${commitmentHash}`);
    }

    const { commitment } = record;
    const receiptData = JSON.stringify({
      commitmentHash: commitment.commitmentHash,
      eligibilityTier: commitment.eligibilityTier,
      issuedAt: commitment.issuedAt,
      expirationTimestamp: commitment.expirationTimestamp,
      decisionReason: decisionReason || 'Standard KYC verification',
    });

    const signature = crypto.sign('sha256', Buffer.from(receiptData), {
      key: this.complianceSigningKey,
      format: 'der',
      type: 'pkcs8',
    });

    const publicKey = crypto.createPublicKey({ key: this.complianceSigningKey }).export({ format: 'pem', type: 'spki' });

    const receipt: SignedKycReceipt = {
      commitmentHash: commitment.commitmentHash,
      eligibilityTier: commitment.eligibilityTier,
      issuedAt: commitment.issuedAt,
      expirationTimestamp: commitment.expirationTimestamp,
      signature: signature.toString('base64'),
      signerPublicKey: publicKey,
      decisionReason,
    };

    // Store receipt with commitment for audit trail
    const recordWithReceipt = this.commitmentsStore.get(commitmentHash)!;
    recordWithReceipt.receipt = receipt;

    this.logger.log(`Issued signed KYC receipt for commitment ${commitmentHash.slice(0, 16)}...`);
    return receipt;
  }

  /**
   * Verify a signed KYC receipt (for audits and compliance checks).
   */
  verifySignedReceipt(receipt: SignedKycReceipt): boolean {
    const receiptData = JSON.stringify({
      commitmentHash: receipt.commitmentHash,
      eligibilityTier: receipt.eligibilityTier,
      issuedAt: receipt.issuedAt,
      expirationTimestamp: receipt.expirationTimestamp,
      decisionReason: receipt.decisionReason || 'Standard KYC verification',
    });

    try {
      return crypto.verify('sha256', Buffer.from(receiptData), receipt.signerPublicKey, Buffer.from(receipt.signature, 'base64'));
    } catch {
      return false;
    }
  }

  /**
   * Evaluates on-chain purchase eligibility strictly using only the on-chain commitment
   * and non-identifying eligibility tier, without exposing any underlying PII.
   */
  verifyOnChainEligibilityFromCommitment(
    commitment: OnChainKycCommitment,
    requiredTier: EligibilityTier,
    currentTime: number = Math.floor(Date.now() / 1000),
  ): { eligible: boolean; reason?: string } {
    if (!commitment || !commitment.commitmentHash) {
      return { eligible: false, reason: 'Invalid or missing on-chain KYC commitment' };
    }

    if (currentTime > commitment.expirationTimestamp) {
      return { eligible: false, reason: 'On-chain KYC commitment has expired' };
    }

    const tierHierarchy = {
      [EligibilityTier.TIER_0_UNVERIFIED]: 0,
      [EligibilityTier.TIER_1_RETAIL_STANDARD]: 1,
      [EligibilityTier.TIER_2_ACCREDITED]: 2,
      [EligibilityTier.TIER_3_INSTITUTIONAL]: 3,
    };

    const currentTierLevel = tierHierarchy[commitment.eligibilityTier] ?? 0;
    const requiredTierLevel = tierHierarchy[requiredTier] ?? 0;

    if (currentTierLevel < requiredTierLevel) {
      return {
        eligible: false,
        reason: `On-chain tier ${commitment.eligibilityTier} insufficient for required purchase tier ${requiredTier}`,
      };
    }

    return { eligible: true };
  }

  /**
   * Documented, access-controlled selective disclosure process for authorized regulators.
   * Regulators present an authorized token to reveal the audit trail linking the on-chain commitment hash to the off-chain KYC decision.
   */
  generateRegulatorDisclosurePackage(
    request: RegulatorDisclosureRequest,
    accessReason: string = 'REGULATORY_AUDIT',
  ): RegulatorDisclosurePackage {
    if (!this.authorizedRegulators.has(request.regulatorId.toUpperCase())) {
      throw new UnauthorizedException(`Regulator ID ${request.regulatorId} is not authorized for selective disclosure`);
    }

    if (!request.authorizationToken || request.authorizationToken !== `AUTH_TOKEN_${request.regulatorId.toUpperCase()}`) {
      throw new UnauthorizedException('Invalid regulator authorization credentials');
    }

    const record = this.commitmentsStore.get(request.commitmentHash);
    if (!record) {
      throw new NotFoundException(`No off-chain KYC record found matching commitment hash ${request.commitmentHash}`);
    }

    const { commitment, offChainAudit } = record;

    // Verify cryptographic proof matches
    const canonicalData = `${offChainAudit.investorAddress}:${commitment.eligibilityTier}:${offChainAudit.jurisdiction.toUpperCase()}:${offChainAudit.salt}:${commitment.issuedAt}`;
    const recomputedHash = crypto.createHash('sha256').update(canonicalData, 'utf8').digest('hex');
    const proofValid = recomputedHash === commitment.commitmentHash;

    this.logger.log(
      `Selective disclosure granted to regulator ${request.regulatorId} for commitment hash ${request.commitmentHash.slice(0, 16)}...`,
    );

    return {
      commitmentHash: commitment.commitmentHash,
      eligibilityTier: commitment.eligibilityTier,
      investorAddress: offChainAudit.investorAddress,
      jurisdiction: offChainAudit.jurisdiction,
      kycStatus: offChainAudit.kycStatus,
      providerReference: offChainAudit.providerReference,
      verifiedAt: offChainAudit.verifiedAt,
      salt: offChainAudit.salt,
      proofValid,
      disclosureMetadata: {
        disclosedTo: request.regulatorId,
        disclosedAt: new Date().toISOString(),
        accessReason,
      },
    };
  }
}
