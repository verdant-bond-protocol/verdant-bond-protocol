// Issue #464: Create fallback behavior for unavailable IPFS certification evidence
// Implements retry logic, fallback gateways, and caching for IPFS evidence retrieval

import { HttpClient, createAxiosHttpClient } from '../oracle/http';
import { checkEvidenceRetrievable } from './evidence';

/**
 * Configuration for IPFS fallback behavior
 */
export interface IpfsFallbackConfig {
  /** Primary IPFS gateway URL */
  primaryGateway: string;
  /** List of fallback gateway URLs to try in order */
  fallbackGateways: string[];
  /** Maximum number of retry attempts per gateway */
  maxRetries: number;
  /** Timeout in milliseconds for each gateway request */
  timeoutMs: number;
  /** Enable local caching of successful retrievals */
  enableCache: boolean;
  /** Cache TTL in milliseconds */
  cacheTtlMs: number;
}

/**
 * Result of IPFS evidence retrieval with fallback
 */
export interface IpfsRetrievalResult {
  /** Whether the evidence was successfully retrieved */
  success: boolean;
  /** The gateway that successfully served the content (if any) */
  gatewayUsed?: string;
  /** Number of attempts made before success or exhaustion */
  attemptsCount: number;
  /** Whether the result came from cache */
  fromCache: boolean;
  /** Error message if retrieval failed */
  error?: string;
  /** Evidence content if successfully retrieved */
  content?: unknown;
}

/**
 * Cache entry for IPFS evidence
 */
interface CacheEntry {
  content: unknown;
  timestamp: number;
  gateway: string;
}

/**
 * In-memory cache for IPFS evidence content
 */
class EvidenceCache {
  private cache: Map<string, CacheEntry> = new Map();

  set(cid: string, content: unknown, gateway: string): void {
    this.cache.set(cid, {
      content,
      timestamp: Date.now(),
      gateway,
    });
  }

  get(cid: string, ttlMs: number): CacheEntry | null {
    const entry = this.cache.get(cid);
    if (!entry) return null;

    const age = Date.now() - entry.timestamp;
    if (age > ttlMs) {
      this.cache.delete(cid);
      return null;
    }

    return entry;
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

// Global cache instance
const evidenceCache = new EvidenceCache();

/**
 * Default fallback configuration
 */
export const DEFAULT_FALLBACK_CONFIG: IpfsFallbackConfig = {
  primaryGateway: process.env.IPFS_GATEWAY || 'https://gateway.pinata.cloud/ipfs/',
  fallbackGateways: [
    'https://ipfs.io/ipfs/',
    'https://cloudflare-ipfs.com/ipfs/',
    'https://dweb.link/ipfs/',
    'https://gateway.ipfs.io/ipfs/',
  ],
  maxRetries: 3,
  timeoutMs: 5000,
  enableCache: true,
  cacheTtlMs: 5 * 60 * 1000, // 5 minutes
};

/**
 * Retrieve IPFS evidence with fallback behavior
 * 
 * Implements a multi-tier fallback strategy:
 * 1. Check local cache (if enabled)
 * 2. Try primary gateway with retries
 * 3. Try each fallback gateway in order with retries
 * 4. Return failure if all attempts exhausted
 * 
 * @param cid - The IPFS CID to retrieve
 * @param config - Fallback configuration (uses defaults if not provided)
 * @param http - HTTP client for making requests (injectable for testing)
 * @returns Retrieval result with success status and metadata
 */
export async function retrieveEvidenceWithFallback(
  cid: string,
  config: Partial<IpfsFallbackConfig> = {},
  http: HttpClient = createAxiosHttpClient(),
): Promise<IpfsRetrievalResult> {
  const fullConfig = { ...DEFAULT_FALLBACK_CONFIG, ...config };
  let attemptsCount = 0;

  // Check cache first
  if (fullConfig.enableCache) {
    const cached = evidenceCache.get(cid, fullConfig.cacheTtlMs);
    if (cached) {
      return {
        success: true,
        gatewayUsed: cached.gateway,
        attemptsCount: 0,
        fromCache: true,
        content: cached.content,
      };
    }
  }

  // Try primary gateway
  const primaryResult = await tryGatewayWithRetries(
    cid,
    fullConfig.primaryGateway,
    fullConfig.maxRetries,
    fullConfig.timeoutMs,
    http,
  );
  attemptsCount += primaryResult.attempts;

  if (primaryResult.success && primaryResult.content) {
    if (fullConfig.enableCache) {
      evidenceCache.set(cid, primaryResult.content, fullConfig.primaryGateway);
    }
    return {
      success: true,
      gatewayUsed: fullConfig.primaryGateway,
      attemptsCount,
      fromCache: false,
      content: primaryResult.content,
    };
  }

  // Try fallback gateways
  for (const gateway of fullConfig.fallbackGateways) {
    const result = await tryGatewayWithRetries(
      cid,
      gateway,
      fullConfig.maxRetries,
      fullConfig.timeoutMs,
      http,
    );
    attemptsCount += result.attempts;

    if (result.success && result.content) {
      if (fullConfig.enableCache) {
        evidenceCache.set(cid, result.content, gateway);
      }
      return {
        success: true,
        gatewayUsed: gateway,
        attemptsCount,
        fromCache: false,
        content: result.content,
      };
    }
  }

  // All gateways exhausted
  return {
    success: false,
    attemptsCount,
    fromCache: false,
    error: `Failed to retrieve evidence ${cid} from all available gateways after ${attemptsCount} attempts`,
  };
}

/**
 * Try to retrieve content from a specific gateway with retries
 */
async function tryGatewayWithRetries(
  cid: string,
  gateway: string,
  maxRetries: number,
  timeoutMs: number,
  http: HttpClient,
): Promise<{ success: boolean; attempts: number; content?: unknown }> {
  let attempts = 0;

  for (let i = 0; i < maxRetries; i++) {
    attempts++;
    try {
      const response = await http.get(`${gateway}${cid}`, { timeoutMs });
      if (response.status >= 200 && response.status < 300) {
        return {
          success: true,
          attempts,
          content: response.data,
        };
      }
    } catch (error) {
      // Continue to next retry
      if (i < maxRetries - 1) {
        // Exponential backoff: 1s, 2s, 4s
        await sleep(Math.pow(2, i) * 1000);
      }
    }
  }

  return { success: false, attempts };
}

/**
 * Check if evidence is retrievable from any gateway (lightweight health check)
 * 
 * @param cid - The IPFS CID to check
 * @param config - Fallback configuration
 * @returns true if retrievable from at least one gateway
 */
export async function isEvidenceAvailable(
  cid: string,
  config: Partial<IpfsFallbackConfig> = {},
): Promise<boolean> {
  const fullConfig = { ...DEFAULT_FALLBACK_CONFIG, ...config };

  // Check cache first
  if (fullConfig.enableCache) {
    const cached = evidenceCache.get(cid, fullConfig.cacheTtlMs);
    if (cached) return true;
  }

  // Check primary gateway
  const primaryAvailable = await checkEvidenceRetrievable(
    cid,
    fullConfig.primaryGateway,
    fullConfig.timeoutMs,
  );
  if (primaryAvailable) return true;

  // Check fallback gateways
  for (const gateway of fullConfig.fallbackGateways) {
    const available = await checkEvidenceRetrievable(cid, gateway, fullConfig.timeoutMs);
    if (available) return true;
  }

  return false;
}

/**
 * Clear the evidence cache (useful for testing and manual cache invalidation)
 */
export function clearEvidenceCache(): void {
  evidenceCache.clear();
}

/**
 * Get cache statistics
 */
export function getCacheStats(): { size: number } {
  return { size: evidenceCache.size() };
}

/**
 * Sleep helper for retry backoff
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Batch check availability of multiple CIDs
 * 
 * @param cids - Array of CIDs to check
 * @param config - Fallback configuration
 * @returns Map of CID to availability status
 */
export async function batchCheckAvailability(
  cids: string[],
  config: Partial<IpfsFallbackConfig> = {},
): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();
  
  // Check in parallel but with reasonable concurrency
  const chunks = chunkArray(cids, 5); // 5 concurrent checks at a time
  
  for (const chunk of chunks) {
    const promises = chunk.map(async (cid) => {
      const available = await isEvidenceAvailable(cid, config);
      return { cid, available };
    });
    
    const chunkResults = await Promise.all(promises);
    chunkResults.forEach(({ cid, available }) => {
      results.set(cid, available);
    });
  }
  
  return results;
}

/**
 * Chunk array into smaller arrays
 */
function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}
