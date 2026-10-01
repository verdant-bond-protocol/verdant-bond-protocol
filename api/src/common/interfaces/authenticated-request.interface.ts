import { Request } from 'express';

export enum KycStatus {
  NONE = 'none',
  PENDING = 'pending',
  VERIFIED = 'verified',
  ACCREDITED = 'accredited',
  EXPIRED = 'expired',
  REJECTED = 'rejected',
}

export type KycStatusSource = 'provider' | 'admin' | 'system' | 'import';

export interface KycAuditEntry {
  id: string;
  address: string;
  fromStatus: KycStatus | null;
  toStatus: KycStatus;
  source: KycStatusSource;
  actor: string | null;
  reason: string | null;
  providerReference: string | null;
  expiresAt: number | null;
  timestamp: number;
}

export interface KycRecord {
  address: string;
  status: KycStatus;
  source: KycStatusSource;
  actor: string | null;
  reason: string | null;
  providerReference: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
}

export interface AuthenticatedUser {
  walletAddress: string;
  kycStatus: KycStatus;
  roles?: string[];
  permissions?: string[];
}

export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
  requestId: string;
}
