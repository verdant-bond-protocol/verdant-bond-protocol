import { Injectable, Logger } from '@nestjs/common';
import { IpfsUploadPolicy } from './ipfs-upload.policy';
import { IpfsDocumentCacheService } from './ipfs-document-cache.service';
import { IpfsUnavailableException } from './interfaces/ipfs-document.interface';

interface IpfsUploadResult {
  hash: string;
  gatewayUrl: string;
  pinSize: number;
  timestamp: string;
}

@Injectable()
export class IpfsService {
  private readonly logger = new Logger(IpfsService.name);

  private config = {
    apiUrl: process.env.IPFS_API_URL || 'https://api.pinata.cloud',
    apiKey: process.env.IPFS_API_KEY || '',
    secretKey: process.env.IPFS_SECRET_KEY || '',
    gateway: process.env.IPFS_GATEWAY || 'https://gateway.pinata.cloud/ipfs/',
  };

  readonly fallbackGateways: string[] = [
    this.config.gateway,
    'https://ipfs.io/ipfs/',
    'https://cloudflare-ipfs.com/ipfs/',
    'https://dweb.link/ipfs/',
  ];

  constructor(
    private readonly uploadPolicy: IpfsUploadPolicy,
    private readonly cacheService: IpfsDocumentCacheService,
  ) {}

  async uploadJson(
    data: Record<string, unknown>,
    options?: { isAuditRelevant?: boolean; disputeId?: string; projectId?: number },
  ): Promise<IpfsUploadResult> {
    const response = await fetch(
      `${this.config.apiUrl}/pinning/pinJSONToIPFS`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          pinata_api_key: this.config.apiKey,
          pinata_secret_api_key: this.config.secretKey,
        },
        body: JSON.stringify({
          pinataContent: data,
          pinataMetadata: { name: `nbs-${Date.now()}` },
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`IPFS upload failed: ${response.statusText}`);
    }

    const result = await response.json();
    const hash = result.IpfsHash;

    // Cache immediately with designated retention tier
    await this.cacheService.cacheDocument(hash, data, {
      filename: `doc-${hash}.json`,
      mimetype: 'application/json',
      isAuditRelevant: options?.isAuditRelevant,
      disputeId: options?.disputeId,
      projectId: options?.projectId,
    });

    return {
      hash,
      gatewayUrl: `${this.config.gateway}${hash}`,
      pinSize: result.PinSize,
      timestamp: new Date().toISOString(),
    };
  }

  async uploadFile(
    buffer: Buffer,
    filename: string,
    mimetype?: string,
    options?: { isAuditRelevant?: boolean; disputeId?: string; projectId?: number },
  ): Promise<IpfsUploadResult> {
    await this.uploadPolicy.validate({
      buffer,
      filename,
      mimetype: mimetype ?? '',
    });

    const payload = {
      filename,
      content: buffer.toString('base64'),
      size: buffer.length,
      mimetype: mimetype ?? 'application/octet-stream',
    };

    const uploadResult = await this.uploadJson(payload, options);

    // Cache original raw buffer with correct mimetype
    await this.cacheService.cacheDocument(uploadResult.hash, buffer, {
      filename,
      mimetype: mimetype ?? 'application/octet-stream',
      isAuditRelevant: options?.isAuditRelevant,
      disputeId: options?.disputeId,
      projectId: options?.projectId,
    });

    return uploadResult;
  }

  /**
   * Fetch JSON content from IPFS with multi-gateway failover and local cache fallback.
   */
  async getContent(hash: string): Promise<Record<string, unknown>> {
    // 1. Attempt retrieval across IPFS gateways
    for (const gw of this.fallbackGateways) {
      const url = `${gw.endsWith('/') ? gw : gw + '/'}${hash}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);

      try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        if (response.ok) {
          const json = await response.json();
          // Opportunistically cache the retrieved content
          const isAudit = await this.cacheService.isAuditRelevant(hash);
          await this.cacheService.cacheDocument(hash, json, {
            isAuditRelevant: isAudit,
          });
          return json;
        }
      } catch {
        clearTimeout(timeout);
      }
    }

    // 2. IPFS gateways failed — check fallback document cache
    this.logger.warn(`All IPFS gateways failed for hash ${hash}. Checking fallback cache...`);
    const cached = await this.cacheService.getCachedDocument(hash);
    if (cached) {
      this.logger.log(`Serving document ${hash} from fallback cache (tier: ${cached.record.tier})`);
      try {
        const parsed = JSON.parse(cached.content);
        return {
          ...parsed,
          _servedFromCache: true,
          _cacheTier: cached.record.tier,
          _cachedAt: cached.record.cachedAt,
        };
      } catch {
        return {
          content: cached.content,
          _servedFromCache: true,
          _cacheTier: cached.record.tier,
        };
      }
    }

    // 3. Both IPFS and cache failed — throw structured unavailability exception
    throw new IpfsUnavailableException(
      hash,
      30,
      `/projects/documents/${hash}/escalate`,
    );
  }

  /**
   * Retrieve any document (binary or JSON) with metadata and cache fallback.
   */
  async retrieveDocument(
    hash: string,
    options?: { isAuditRelevant?: boolean },
  ): Promise<{
    content: string;
    mimetype: string;
    filename: string;
    servedFrom: 'ipfs' | 'cache';
    tier?: string;
  }> {
    // 1. Try IPFS Gateways
    for (const gw of this.fallbackGateways) {
      const url = `${gw.endsWith('/') ? gw : gw + '/'}${hash}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);

      try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        if (response.ok) {
          const mimetype = response.headers.get('content-type') || 'application/octet-stream';
          const buffer = Buffer.from(await response.arrayBuffer());
          const isAudit =
            options?.isAuditRelevant ?? (await this.cacheService.isAuditRelevant(hash));

          await this.cacheService.cacheDocument(hash, buffer, {
            mimetype,
            isAuditRelevant: isAudit,
          });

          return {
            content: buffer.toString('base64'),
            mimetype,
            filename: `${hash}.bin`,
            servedFrom: 'ipfs',
          };
        }
      } catch {
        clearTimeout(timeout);
      }
    }

    // 2. Gateway failure: Fallback to local cache
    const cached = await this.cacheService.getCachedDocument(hash);
    if (cached) {
      return {
        content: cached.content,
        mimetype: cached.record.mimetype,
        filename: cached.record.filename,
        servedFrom: 'cache',
        tier: cached.record.tier,
      };
    }

    throw new IpfsUnavailableException(
      hash,
      30,
      `/projects/documents/${hash}/escalate`,
    );
  }

  async pin(hash: string): Promise<void> {
    const response = await fetch(`${this.config.apiUrl}/pinning/pinByHash`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        pinata_api_key: this.config.apiKey,
        pinata_secret_api_key: this.config.secretKey,
      },
      body: JSON.stringify({ hashToPin: hash }),
    });

    if (!response.ok) {
      throw new Error(`Failed to pin hash: ${response.statusText}`);
    }
  }
}
