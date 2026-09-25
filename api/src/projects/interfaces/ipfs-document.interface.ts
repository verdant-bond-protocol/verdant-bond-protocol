export type DocumentRetentionTier = 'routine' | 'audit_relevant';

export type DocumentAvailabilityStatus =
  | 'available'
  | 'degraded'
  | 'unavailable'
  | 'cached_fallback';

export interface CachedDocumentRecord {
  hash: string;
  content: string; // base64 payload or JSON string
  filename: string;
  mimetype: string;
  size: number;
  checksum: string; // SHA-256 integrity hash
  tier: DocumentRetentionTier;
  cachedAt: string;
  expiresAt: string | null;
  isAuditRelevant: boolean;
  disputeId?: string;
  projectId?: number;
  encrypted: boolean;
  iv?: string;
  authTag?: string;
}

export interface DocumentHealthRecord {
  hash: string;
  status: DocumentAvailabilityStatus;
  lastChecked: string;
  primaryGatewayOk: boolean;
  fallbackGatewayOk: boolean;
  servedByCache: boolean;
  failureCount: number;
  lastError?: string;
}

export interface DocumentRetrievalResponse {
  hash: string;
  status: 'available' | 'temporarily_unavailable';
  servedFrom: 'ipfs' | 'cache' | 'none';
  content?: string | Record<string, unknown>;
  metadata?: {
    filename?: string;
    mimetype?: string;
    size?: number;
    checksum?: string;
    tier?: DocumentRetentionTier;
    isAuditRelevant?: boolean;
    cachedAt?: string;
  };
  retryAfterSeconds?: number;
  escalationPath?: string;
  message?: string;
}

export class IpfsUnavailableException extends Error {
  constructor(
    public readonly hash: string,
    public readonly retryAfterSeconds: number = 30,
    public readonly escalationPath?: string,
    message = `Document with hash ${hash} is temporarily unavailable across IPFS gateways. A cached recovery or escalation has been initiated.`,
  ) {
    super(message);
    this.name = 'IpfsUnavailableException';
  }
}

