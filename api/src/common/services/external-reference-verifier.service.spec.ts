import { ExternalReferenceVerifierService, VerificationRequest } from './external-reference-verifier.service';

describe('ExternalReferenceVerifierService', () => {
  let service: ExternalReferenceVerifierService;

  beforeEach(() => {
    service = new ExternalReferenceVerifierService();
  });

  afterEach(() => {
    service.clearStore();
  });

  it('should verify valid external reference successfully', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => 'application/json' },
      json: async () => ({ status: 'active' }),
      text: async () => '{"status":"active"}',
      arrayBuffer: async () => Buffer.from('{"status":"active"}'),
    });

    const verifier = new ExternalReferenceVerifierService(mockFetch as any);
    const request: VerificationRequest = {
      id: 'ref_1',
      url: 'https://registry.verra.org/v1/project/101',
      type: 'REGISTRY_DOC',
    };

    const result = await verifier.verifyReference(request);

    expect(result.status).toBe('verified');
    expect(result.attempts).toBe(1);
    expect(result.statusCode).toBe(200);
    expect(result.contentType).toBe('application/json');
    expect(result.verifiedAt).toBeDefined();

    const stored = verifier.getVerificationStatus('ref_1');
    expect(stored).toEqual(result);
  });

  it('should classify 404 / 400 responses as terminal failure without retrying', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: { get: () => null },
    });

    const verifier = new ExternalReferenceVerifierService(mockFetch as any);
    const request: VerificationRequest = {
      id: 'ref_404',
      url: 'https://gateway.pinata.cloud/ipfs/QmNonExistent',
      type: 'IPFS',
      retryPolicy: { maxAttempts: 3 },
    };

    const result = await verifier.verifyReference(request);

    expect(result.status).toBe('failed_terminal');
    expect(result.attempts).toBe(1); // Terminal errors break immediately
    expect(result.statusCode).toBe(404);
    expect(result.errorMessage).toContain('Terminal HTTP error 404');

    const failed = verifier.getFailedVerifications();
    expect(failed).toHaveLength(1);
  });

  it('should retry on transient 503 errors and succeed on retry', async () => {
    const mockFetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        headers: { get: () => null },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => 'text/html' },
        text: async () => 'Success content',
      });

    const verifier = new ExternalReferenceVerifierService(mockFetch as any);
    const request: VerificationRequest = {
      id: 'ref_retry_ok',
      url: 'https://oracle.verdant.io/readings',
      type: 'ORACLE',
      retryPolicy: { maxAttempts: 3, initialBackoffMs: 5 },
    };

    const result = await verifier.verifyReference(request);

    expect(result.status).toBe('verified');
    expect(result.attempts).toBe(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should mark status as failed_terminal upon retry exhaustion', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      headers: { get: () => null },
    });

    const verifier = new ExternalReferenceVerifierService(mockFetch as any);
    const request: VerificationRequest = {
      id: 'ref_exhausted',
      url: 'https://failing-server.com/api',
      type: 'HTTPS',
      retryPolicy: { maxAttempts: 3, initialBackoffMs: 5 },
    };

    const result = await verifier.verifyReference(request);

    expect(result.status).toBe('failed_terminal');
    expect(result.attempts).toBe(3);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(result.errorMessage).toContain('Retryable HTTP error 500');
  });

  it('should handle timeout errors gracefully and mark as failed_terminal after exhaustion', async () => {
    const mockFetch = jest.fn().mockImplementation(() => {
      const err: any = new Error('AbortError');
      err.name = 'AbortError';
      return Promise.reject(err);
    });

    const verifier = new ExternalReferenceVerifierService(mockFetch as any);
    const request: VerificationRequest = {
      id: 'ref_timeout',
      url: 'https://slow-endpoint.com/data',
      type: 'HTTPS',
      retryPolicy: { maxAttempts: 2, timeoutMs: 10, initialBackoffMs: 5 },
    };

    const result = await verifier.verifyReference(request);

    expect(result.status).toBe('failed_terminal');
    expect(result.attempts).toBe(2);
    expect(result.errorMessage).toContain('Timeout after 10ms');
  });

  it('should batch verify multiple references', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => 'text/plain' },
      text: async () => 'data',
    });

    const verifier = new ExternalReferenceVerifierService(mockFetch as any);
    const requests: VerificationRequest[] = [
      { id: 'b1', url: 'https://ipfs.io/ipfs/b1', type: 'IPFS' },
      { id: 'b2', url: 'https://ipfs.io/ipfs/b2', type: 'IPFS' },
    ];

    const results = await verifier.batchVerify(requests);

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === 'verified')).toBe(true);
    expect(verifier.getAllVerifications()).toHaveLength(2);
  });
});
