import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { RedisService } from '../common/services/redis.service';
import {
  CachedDocumentRecord,
  DocumentRetentionTier,
} from './interfaces/ipfs-document.interface';

export const ROUTINE_RETENTION_SECONDS = 30 * 24 * 3600; // 30 days
export const AUDIT_RETENTION_SECONDS = 10 * 365 * 24 * 3600; // 10 years (long-retention)

@Injectable()
export class IpfsDocumentCacheService {
  private readonly logger = new Logger(IpfsDocumentCacheService.name);
  private readonly encryptionKey: Buffer;
  private readonly encryptionEnabled: boolean;

  constructor(private readonly redis: RedisService) {
    this.encryptionEnabled = process.env.DOCUMENT_CACHE_ENCRYPTION !== 'false';
    const rawSecret =
      process.env.DOCUMENT_CACHE_SECRET || process.env.JWT_SECRET;

    if (this.encryptionEnabled) {
      if (!rawSecret || rawSecret.trim().length === 0) {
        throw new Error(
          'DOCUMENT_CACHE_SECRET (or JWT_SECRET) is required when IPFS document cache encryption is enabled. Failing closed on startup to prevent insecure audit document caching.',
        );
      }
      this.encryptionKey = crypto
        .createHash('sha256')
        .update(rawSecret)
        .digest();
    } else {
      this.encryptionKey = Buffer.alloc(0);
    }
  }

  /**
   * Determine retention TTL based on audit/dispute relevance.
   */
  getRetentionSeconds(isAuditRelevant: boolean): number {
    return isAuditRelevant
      ? AUDIT_RETENTION_SECONDS
      : ROUTINE_RETENTION_SECONDS;
  }

  /**
   * Cache a document payload with the designated retention tier.
   */
  async cacheDocument(
    hash: string,
    content: string | Buffer | Record<string, unknown>,
    options?: {
      filename?: string;
      mimetype?: string;
      isAuditRelevant?: boolean;
      disputeId?: string;
      projectId?: number;
    },
  ): Promise<CachedDocumentRecord> {
    const isAuditRelevant = Boolean(
      options?.isAuditRelevant || options?.disputeId,
    );
    const tier: DocumentRetentionTier = isAuditRelevant
      ? 'audit_relevant'
      : 'routine';
    const ttlSeconds = this.getRetentionSeconds(isAuditRelevant);

    let rawString: string;
    if (Buffer.isBuffer(content)) {
      rawString = content.toString('base64');
    } else if (typeof content === 'string') {
      rawString = content;
    } else {
      rawString = JSON.stringify(content);
    }

    const checksum = crypto
      .createHash('sha256')
      .update(rawString)
      .digest('hex');

    let storedContent = rawString;
    let ivHex: string | undefined;
    let authTagHex: string | undefined;
    let isEncrypted = false;

    if (this.encryptionEnabled) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv(
        'aes-256-gcm',
        this.encryptionKey,
        iv,
      );
      const enc1 = cipher.update(rawString, 'utf8', 'base64');
      const enc2 = cipher.final('base64');
      storedContent = enc1 + enc2;
      authTagHex = cipher.getAuthTag().toString('hex');
      ivHex = iv.toString('hex');
      isEncrypted = true;
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();

    const record: CachedDocumentRecord = {
      hash,
      content: storedContent,
      filename: options?.filename || `${hash}.bin`,
      mimetype: options?.mimetype || 'application/octet-stream',
      size: rawString.length,
      checksum,
      tier,
      cachedAt: now.toISOString(),
      expiresAt,
      isAuditRelevant,
      disputeId: options?.disputeId,
      projectId: options?.projectId,
      encrypted: isEncrypted,
      iv: ivHex,
      authTag: authTagHex,
    };

    const cacheKey = `ipfs:cache:doc:${hash}`;
    await this.redis.setEx(cacheKey, ttlSeconds, JSON.stringify(record));

    // Index audit relevant hashes for fast auditing discovery
    if (isAuditRelevant) {
      await this.redis.sAdd('ipfs:cache:audit_relevant_hashes', hash);
    }

    this.logger.log(
      `Cached document ${hash} in tier '${tier}' (TTL: ${ttlSeconds}s, audit-relevant: ${isAuditRelevant})`,
    );

    return record;
  }

  /**
   * Retrieve and decrypt a cached document by its IPFS hash.
   */
  async getCachedDocument(
    hash: string,
  ): Promise<{ record: CachedDocumentRecord; content: string } | null> {
    const cacheKey = `ipfs:cache:doc:${hash}`;
    const raw = await this.redis.get(cacheKey);
    if (!raw) {
      return null;
    }

    try {
      const record: CachedDocumentRecord = JSON.parse(raw);
      let decrypted = record.content;

      if (record.encrypted && record.iv && record.authTag) {
        const decipher = crypto.createDecipheriv(
          'aes-256-gcm',
          this.encryptionKey,
          Buffer.from(record.iv, 'hex'),
        );
        decipher.setAuthTag(Buffer.from(record.authTag, 'hex'));
        const dec1 = decipher.update(record.content, 'base64', 'utf8');
        const dec2 = decipher.final('utf8');
        decrypted = dec1 + dec2;
      }

      // Verify cryptographic checksum
      const computedChecksum = crypto
        .createHash('sha256')
        .update(decrypted)
        .digest('hex');

      if (computedChecksum !== record.checksum) {
        this.logger.error(
          `Integrity checksum mismatch on cached doc ${hash}! Expected ${record.checksum}, got ${computedChecksum}`,
        );
        return null;
      }

      return { record, content: decrypted };
    } catch (err: any) {
      this.logger.error(`Error reading cached document ${hash}: ${err.message}`);
      return null;
    }
  }

  /**
   * Promote a routine document to the long-term audit/dispute retention tier.
   */
  async flagAsAuditRelevant(
    hash: string,
    disputeId?: string,
  ): Promise<CachedDocumentRecord | null> {
    const existing = await this.getCachedDocument(hash);
    if (!existing) {
      // Record the flag so when fetched it automatically enters the audit tier
      await this.redis.sAdd('ipfs:cache:audit_relevant_hashes', hash);
      return null;
    }

    const { record, content } = existing;
    return this.cacheDocument(hash, content, {
      filename: record.filename,
      mimetype: record.mimetype,
      isAuditRelevant: true,
      disputeId: disputeId || record.disputeId,
      projectId: record.projectId,
    });
  }

  /**
   * Check if a given hash is flagged as audit or dispute relevant.
   */
  async isAuditRelevant(hash: string): Promise<boolean> {
    const auditMembers = await this.redis.sMembers(
      'ipfs:cache:audit_relevant_hashes',
    );
    if (auditMembers.includes(hash)) {
      return true;
    }
    const cached = await this.getCachedDocument(hash);
    return cached?.record.isAuditRelevant ?? false;
  }

  /**
   * Get the retention tier of a cached document.
   */
  async getRetentionTier(hash: string): Promise<DocumentRetentionTier> {
    const isAudit = await this.isAuditRelevant(hash);
    return isAudit ? 'audit_relevant' : 'routine';
  }
}
