import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RedisService } from '../common/services/redis.service';
import { IpfsDocumentCacheService } from './ipfs-document-cache.service';
import {
  DocumentAvailabilityStatus,
  DocumentHealthRecord,
} from './interfaces/ipfs-document.interface';

@Injectable()
export class IpfsAvailabilityService {
  private readonly logger = new Logger(IpfsAvailabilityService.name);

  readonly gateways: string[] = [
    process.env.IPFS_GATEWAY || 'https://gateway.pinata.cloud/ipfs/',
    'https://ipfs.io/ipfs/',
    'https://cloudflare-ipfs.com/ipfs/',
    'https://dweb.link/ipfs/',
  ];

  constructor(
    private readonly redis: RedisService,
    private readonly cacheService: IpfsDocumentCacheService,
  ) {}

  /**
   * Ping an IPFS gateway with a timeout.
   */
  async probeGateway(gatewayBaseUrl: string, hash: string, timeoutMs = 4000): Promise<boolean> {
    const url = `${gatewayBaseUrl.endsWith('/') ? gatewayBaseUrl : gatewayBaseUrl + '/'}${hash}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return response.ok;
    } catch {
      clearTimeout(timeout);
      return false;
    }
  }

  /**
   * Check availability across all gateways for a specific hash and update health status.
   */
  async checkDocumentAvailability(
    hash: string,
    isAuditRelevant = false,
  ): Promise<DocumentHealthRecord> {
    const primaryGateway = this.gateways[0];
    const fallbackGateways = this.gateways.slice(1);

    const primaryOk = await this.probeGateway(primaryGateway, hash);
    let fallbackOk = false;

    if (!primaryOk) {
      for (const fallback of fallbackGateways) {
        if (await this.probeGateway(fallback, hash)) {
          fallbackOk = true;
          break;
        }
      }
    }

    const cached = await this.cacheService.getCachedDocument(hash);
    const hasCache = Boolean(cached);

    let status: DocumentAvailabilityStatus;
    if (primaryOk) {
      status = 'available';
    } else if (fallbackOk) {
      status = 'degraded';
    } else if (hasCache) {
      status = 'cached_fallback';
    } else {
      status = 'unavailable';
    }

    // Previous health record to track failure counts
    const prevRaw = await this.redis.get(`ipfs:health:${hash}`);
    const prev: DocumentHealthRecord | null = prevRaw ? JSON.parse(prevRaw) : null;
    const failureCount =
      status === 'unavailable' || status === 'degraded'
        ? (prev?.failureCount || 0) + 1
        : 0;

    const health: DocumentHealthRecord = {
      hash,
      status,
      lastChecked: new Date().toISOString(),
      primaryGatewayOk: primaryOk,
      fallbackGatewayOk: fallbackOk,
      servedByCache: hasCache,
      failureCount,
      lastError:
        status === 'unavailable'
          ? 'All IPFS gateways failed to respond'
          : undefined,
    };

    // Store health in Redis (TTL: 24 hours)
    await this.redis.setEx(`ipfs:health:${hash}`, 86400, JSON.stringify(health));

    // If degraded but available on fallback and not yet cached, warm cache now proactively
    if (fallbackOk && !hasCache && isAuditRelevant) {
      this.logger.warn(
        `Proactive warm-up: Audit document ${hash} is degraded on primary gateway. Warming fallback cache...`,
      );
      // Initiate background warm-up
      this.warmCacheFromGateway(hash, isAuditRelevant).catch((err) =>
        this.logger.error(`Failed proactive cache warm-up for ${hash}: ${err.message}`),
      );
    }

    return health;
  }

  /**
   * Retrieve cached health record or execute a fresh availability check.
   */
  async getDocumentHealth(hash: string): Promise<DocumentHealthRecord> {
    const raw = await this.redis.get(`ipfs:health:${hash}`);
    if (raw) {
      return JSON.parse(raw);
    }
    const isAudit = await this.cacheService.isAuditRelevant(hash);
    return this.checkDocumentAvailability(hash, isAudit);
  }

  /**
   * Warm the local cache by attempting to fetch from working gateways.
   */
  async warmCacheFromGateway(hash: string, isAuditRelevant = true): Promise<boolean> {
    for (const gateway of this.gateways) {
      const url = `${gateway.endsWith('/') ? gateway : gateway + '/'}${hash}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);

      try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        if (response.ok) {
          const contentType = response.headers.get('content-type') || 'application/octet-stream';
          const buffer = Buffer.from(await response.arrayBuffer());
          await this.cacheService.cacheDocument(hash, buffer, {
            mimetype: contentType,
            isAuditRelevant,
          });
          this.logger.log(`Successfully warmed cache for document ${hash} from gateway ${gateway}`);
          return true;
        }
      } catch {
        clearTimeout(timeout);
      }
    }
    return false;
  }

  /**
   * Scheduled proactive health check running every 6 hours.
   */
  @Cron(CronExpression.EVERY_6_HOURS)
  async runScheduledAvailabilityAudit(): Promise<void> {
    this.logger.log('Starting scheduled IPFS document availability audit...');
    try {
      // Check all registered audit-relevant hashes first
      const auditHashes = await this.redis.sMembers('ipfs:cache:audit_relevant_hashes');
      for (const hash of auditHashes) {
        await this.checkDocumentAvailability(hash, true);
      }
      this.logger.log(`Completed scheduled audit check for ${auditHashes.length} audit-relevant documents.`);
    } catch (err: any) {
      this.logger.error(`Scheduled availability check failed: ${err.message}`);
    }
  }
}
