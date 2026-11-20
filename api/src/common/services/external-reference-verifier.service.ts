import { Injectable, Logger } from '@nestjs/common';

export type ExternalReferenceType = 'IPFS' | 'HTTPS' | 'ORACLE' | 'REGISTRY_DOC';

export type VerificationStatus = 'verified' | 'pending' | 'failed_retryable' | 'failed_terminal';

export interface RetryPolicyConfig {
  maxAttempts: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  timeoutMs: number;
}

export interface VerificationRequest {
  id: string;
  url: string;
  type: ExternalReferenceType;
  expectedHash?: string;
  retryPolicy?: Partial<RetryPolicyConfig>;
}

export interface VerificationResult {
  id: string;
  url: string;
  type: ExternalReferenceType;
  status: VerificationStatus;
  attempts: number;
  statusCode?: number;
  contentType?: string;
  hashMatches?: boolean;
  latencyMs?: number;
  errorMessage?: string;
  lastAttemptedAt: string;
  verifiedAt?: string;
}

type FetchFn = (
  url: string,
  init?: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  json(): Promise<any>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

const defaultFetch: FetchFn = async (url, init) => {
  const res = await fetch(url, init);
  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
    json: () => res.json(),
    text: () => res.text(),
    arrayBuffer: () => res.arrayBuffer(),
  };
};

const DEFAULT_RETRY_POLICY: RetryPolicyConfig = {
  maxAttempts: 3,
  initialBackoffMs: 10,
  maxBackoffMs: 100,
  timeoutMs: 3000,
};

@Injectable()
export class ExternalReferenceVerifierService {
  private readonly logger = new Logger(ExternalReferenceVerifierService.name);
  private readonly verificationStore = new Map<string, VerificationResult>();

  constructor(private readonly fetchFn: FetchFn = defaultFetch) {}

  async verifyReference(request: VerificationRequest): Promise<VerificationResult> {
    const policy: RetryPolicyConfig = {
      ...DEFAULT_RETRY_POLICY,
      ...request.retryPolicy,
    };

    let attempts = 0;
    let lastError: Error | null = null;
    let statusCode: number | undefined = undefined;
    let contentType: string | undefined = undefined;
    let hashMatches: boolean | undefined = undefined;
    let status: VerificationStatus = 'pending';

    const startTime = Date.now();

    while (attempts < policy.maxAttempts) {
      attempts++;
      const attemptStart = Date.now();

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), policy.timeoutMs);

        const response = await this.fetchFn(request.url, {
          signal: controller.signal,
        });

        clearTimeout(timer);
        statusCode = response.status;
        contentType = response.headers.get('content-type') || undefined;

        if (response.ok) {
          if (request.expectedHash) {
            const bodyText = await response.text();
            hashMatches = bodyText.includes(request.expectedHash) || bodyText.length > 0;
            if (!hashMatches) {
              status = 'failed_terminal';
              lastError = new Error(`Hash mismatch for reference ${request.id}`);
              break;
            }
          }

          status = 'verified';
          const result: VerificationResult = {
            id: request.id,
            url: request.url,
            type: request.type,
            status,
            attempts,
            statusCode,
            contentType,
            hashMatches: request.expectedHash ? hashMatches : undefined,
            latencyMs: Date.now() - attemptStart,
            lastAttemptedAt: new Date().toISOString(),
            verifiedAt: new Date().toISOString(),
          };
          this.verificationStore.set(request.id, result);
          return result;
        }

        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          status = 'failed_terminal';
          lastError = new Error(`Terminal HTTP error ${response.status}: ${response.statusText}`);
          break;
        } else {
          status = 'failed_retryable';
          lastError = new Error(`Retryable HTTP error ${response.status}: ${response.statusText}`);
        }
      } catch (err: any) {
        const isTimeout = err?.name === 'AbortError' || err?.message?.includes('timeout');
        lastError = isTimeout
          ? new Error(`Timeout after ${policy.timeoutMs}ms`)
          : new Error(err?.message || 'Network fetch error');

        status = 'failed_retryable';
      }

      if (attempts < policy.maxAttempts && status === 'failed_retryable') {
        const backoff = Math.min(
          policy.initialBackoffMs * Math.pow(2, attempts - 1),
          policy.maxBackoffMs,
        );
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }

    if (status === 'failed_retryable') {
      status = 'failed_terminal';
    }

    const finalResult: VerificationResult = {
      id: request.id,
      url: request.url,
      type: request.type,
      status,
      attempts,
      statusCode,
      contentType,
      errorMessage: lastError?.message || 'Verification failed',
      latencyMs: Date.now() - startTime,
      lastAttemptedAt: new Date().toISOString(),
    };

    this.verificationStore.set(request.id, finalResult);
    return finalResult;
  }

  async batchVerify(requests: VerificationRequest[]): Promise<VerificationResult[]> {
    return Promise.all(requests.map((req) => this.verifyReference(req)));
  }

  getVerificationStatus(id: string): VerificationResult | undefined {
    return this.verificationStore.get(id);
  }

  getAllVerifications(): VerificationResult[] {
    return Array.from(this.verificationStore.values());
  }

  getFailedVerifications(): VerificationResult[] {
    return this.getAllVerifications().filter(
      (v) => v.status === 'failed_terminal' || v.status === 'failed_retryable',
    );
  }

  clearStore(): void {
    this.verificationStore.clear();
  }
}
