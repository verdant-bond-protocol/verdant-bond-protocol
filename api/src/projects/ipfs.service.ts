import { Inject, Injectable, Optional } from '@nestjs/common';
import { createHash } from 'crypto';
import { IpfsUploadPolicy } from './ipfs-upload.policy';
import { IpfsDocumentCacheService } from './ipfs-document-cache.service';
import { IpfsUnavailableException } from './interfaces/ipfs-document.interface';

interface IpfsUploadResult {
  hash: string;
  gatewayUrl: string;
  pinSize: number;
  timestamp: string;
}

export interface PinProviderConfig {
  name: string;
  apiUrl: string;
  apiKey: string;
  secretKey: string;
  gateway: string;
}

export interface RedundantPinResult {
  hash: string;
  providers: { name: string; ok: boolean; error?: string }[];
}

export interface PinVerification {
  provider: string;
  retrievable: boolean;
  hashMatches: boolean | null;
}

type FetchFn = (
  url: string,
  init?: RequestInit,
) => Promise<{ ok: boolean; status: number; statusText: string; json(): Promise<any>; arrayBuffer(): Promise<ArrayBuffer> }>;

/** Optional override for the HTTP client (tests); production uses global fetch. */
export const IPFS_FETCH = Symbol('IPFS_FETCH');

const defaultFetch: FetchFn = (url, init) =>
  fetch(url, init) as unknown as Promise<{
    ok: boolean;
    status: number;
    statusText: string;
    json(): Promise<any>;
    arrayBuffer(): Promise<ArrayBuffer>;
  }>;

@Injectable()
export class IpfsService {
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
    @Optional() private readonly cacheService?: IpfsDocumentCacheService,
    @Optional() @Inject(IPFS_FETCH) private readonly fetchFn: FetchFn = defaultFetch,
  ) {
    if (typeof cacheService === 'function') {
      this.fetchFn = cacheService as unknown as FetchFn;
      this.cacheService = undefined;
    }
  }

  /** Primary + secondary pinning providers (issue #211). Secondary is
   * configured via `IPFS_SECONDARY_*`; when unset only the primary is used
   * and redundancy is reported as degraded rather than failing. */
  getPinProviders(): PinProviderConfig[] {
    const providers: PinProviderConfig[] = [
      {
        name: 'primary',
        apiUrl: this.config.apiUrl,
        apiKey: this.config.apiKey,
        secretKey: this.config.secretKey,
        gateway: this.config.gateway,
      },
    ];
    if (process.env.IPFS_SECONDARY_API_URL) {
      providers.push({
        name: 'secondary',
        apiUrl: process.env.IPFS_SECONDARY_API_URL,
        apiKey: process.env.IPFS_SECONDARY_API_KEY || '',
        secretKey: process.env.IPFS_SECONDARY_SECRET_KEY || '',
        gateway:
          process.env.IPFS_SECONDARY_GATEWAY || 'https://ipfs.io/ipfs/',
      });
    }
    return providers;
  }

  async uploadJson(
    data: Record<string, unknown>,
    options?: { isAuditRelevant?: boolean; disputeId?: string; projectId?: number },
  ): Promise<IpfsUploadResult> {
    const response = await this.fetchFn(
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

    if (this.cacheService) {
      await this.cacheService.cacheDocument(hash, data, {
        filename: `doc-${hash}.json`,
        mimetype: 'application/json',
        isAuditRelevant: options?.isAuditRelevant,
        disputeId: options?.disputeId,
        projectId: options?.projectId,
      });
    }

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

    const result = await this.uploadJson(
      {
        filename,
        content: buffer.toString('base64'),
        size: buffer.length,
        mimetype: mimetype ?? 'application/octet-stream',
      },
      options,
    );

    if (this.cacheService) {
      await this.cacheService.cacheDocument(result.hash, buffer, {
        filename,
        mimetype: mimetype ?? 'application/octet-stream',
        isAuditRelevant: options?.isAuditRelevant,
        disputeId: options?.disputeId,
        projectId: options?.projectId,
      });
    }

    return result;
  }

  /**
   * Fetch JSON content from IPFS with multi-gateway failover and local cache fallback.
   */
  async getContent(hash: string): Promise<Record<string, unknown>> {
    const gateways = [this.config.gateway, ...this.fallbackGateways.filter((g) => g !== this.config.gateway)];

    for (const gw of gateways) {
      const url = `${gw.endsWith('/') ? gw : gw + '/'}${hash}`;
      try {
        const response = await this.fetchFn(url);
        if (response.ok) {
          const json = await response.json();
          if (this.cacheService) {
            const isAudit = await this.cacheService.isAuditRelevant(hash);
            await this.cacheService.cacheDocument(hash, json, {
              isAuditRelevant: isAudit,
            });
          }
          return json;
        }
      } catch {}
    }

    if (this.cacheService) {
      const cached = await this.cacheService.getCachedDocument(hash);
      if (cached) {
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
    }

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
    const gateways = [this.config.gateway, ...this.fallbackGateways.filter((g) => g !== this.config.gateway)];

    for (const gw of gateways) {
      const url = `${gw.endsWith('/') ? gw : gw + '/'}${hash}`;
      try {
        const response = await this.fetchFn(url);
        if (response.ok) {
          const buffer = Buffer.from(await response.arrayBuffer());
          const isAudit =
            options?.isAuditRelevant ?? (await this.cacheService?.isAuditRelevant(hash)) ?? false;

          if (this.cacheService) {
            await this.cacheService.cacheDocument(hash, buffer, {
              mimetype: 'application/octet-stream',
              isAuditRelevant: isAudit,
            });
          }

          return {
            content: buffer.toString('base64'),
            mimetype: 'application/octet-stream',
            filename: `${hash}.bin`,
            servedFrom: 'ipfs',
          };
        }
      } catch {}
    }

    if (this.cacheService) {
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
    }

    throw new IpfsUnavailableException(
      hash,
      30,
      `/projects/documents/${hash}/escalate`,
    );
  }

  async pin(hash: string): Promise<void> {
    const response = await this.fetchFn(
      `${this.config.apiUrl}/pinning/pinByHash`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          pinata_api_key: this.config.apiKey,
          pinata_secret_api_key: this.config.secretKey,
        },
        body: JSON.stringify({ hashToPin: hash }),
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to pin hash: ${response.statusText}`);
    }
  }

  /**
   * Pin `hash` redundantly across all configured providers (issue #211).
   * Succeeds when at least one provider accepts the pin; per-provider
   * outcomes are returned so callers can alert on partial failure. Throws
   * only when every provider fails (content would be unavailable).
   */
  async pinRedundant(hash: string): Promise<RedundantPinResult> {
    const providers = this.getPinProviders();
    const results = await Promise.all(
      providers.map(async (p) => {
        try {
          const response = await this.fetchFn(
            `${p.apiUrl}/pinning/pinByHash`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                pinata_api_key: p.apiKey,
                pinata_secret_api_key: p.secretKey,
              },
              body: JSON.stringify({ hashToPin: hash }),
            },
          );
          if (!response.ok) {
            return { name: p.name, ok: false, error: response.statusText };
          }
          return { name: p.name, ok: true };
        } catch (err: any) {
          return { name: p.name, ok: false, error: err?.message || 'fetch failed' };
        }
      }),
    );
    if (!results.some((r) => r.ok)) {
      throw new Error(
        `Redundant pin failed on all providers: ${results.map((r) => `${r.name} (${r.error})`).join(', ')}`,
      );
    }
    return { hash, providers: results };
  }

  /**
   * Verify pinned content is actually retrievable and hash-matches
   * (issue #211). Fetches raw bytes from each provider gateway; `hashMatches`
   * is `null` when no expected digest is supplied or the fetch failed.
   * Never throws — callers decide how to escalate a failing provider.
   */
  async verifyPin(hash: string, expectedSha256Hex?: string): Promise<PinVerification[]> {
    const providers = this.getPinProviders();
    return Promise.all(
      providers.map(async (p) => {
        try {
          const response = await this.fetchFn(`${p.gateway}${hash}`);
          if (!response.ok) {
            return { provider: p.name, retrievable: false, hashMatches: null };
          }
          if (!expectedSha256Hex) {
            return { provider: p.name, retrievable: true, hashMatches: null };
          }
          const bytes = Buffer.from(await response.arrayBuffer());
          const digest = createHash('sha256').update(bytes).digest('hex');
          return {
            provider: p.name,
            retrievable: true,
            hashMatches: digest === expectedSha256Hex.toLowerCase(),
          };
        } catch {
          return { provider: p.name, retrievable: false, hashMatches: null };
        }
      }),
    );
  }
}
